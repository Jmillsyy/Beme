/**
 * WorkspaceView3D — Tier 1 mass-model 3D view of the project.
 *
 * Lazy-loaded behind the workspace's 2D ↔ 3D toggle so users who never open
 * 3D pay zero bundle cost. The 2D Konva workspace stays the source of truth
 * for editing; this view is read-only — orbit camera, no interaction with
 * walls.
 *
 * Coordinate system:
 *   Plan-view (mm)      → 3D (m, Y-up)
 *   wall.startX/.startY → X / Z (Z negated so "up in plan" = "back in 3D")
 *   wall height (mm)    → Y
 *
 * Per-wall rendering:
 *   Block walls are decomposed into **bands** via convertMakeupToBands —
 *   a stack of {blockCode, count} horizontal stripes that match the
 *   composition shown in the 2D wall preview. Each band becomes a
 *   horizontal slab in 3D, tinted by the band's block code using the
 *   same distinct-colour palette as the wall preview's legend. So a
 *   user looking at the 3D view sees the SAME colour for the SAME block
 *   as in the wall-type editor — "the green one is 20.45".
 *
 *   Brick walls render as a single solid extrusion in the brick type's
 *   palette colour. Per-course brick banding is a v2 follow-up.
 *
 * Openings (windows + doors) cut by splitting each band into
 * left-of-opening / right-of-opening / below-sill / above-head sub-boxes
 * instead of CSG. Keeps the GPU cost low and lets InstancedMesh come
 * later without rework.
 *
 * Curved walls sample the arc into N straight segments and run each
 * through the band builder. No openings on curved walls in v1.
 *
 * Battery-friendly defaults:
 *   - frameloop="demand" — frames only render on camera interaction.
 *   - Pixel ratio capped at 1.5 — no Retina-density rendering.
 *   - One directional light, no shadows. Fine for a mass model.
 */
import { Suspense, useMemo } from 'react'
import { Canvas } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import * as THREE from 'three'
import type { Wall, Opening, WallMakeup, BrickMakeup } from '../types/walls'
import type { ProjectArea } from '../lib/projectStorage'
import type { Block } from '../types/blocks'
import { arcFromThreePoints, sampleArc, isCurvedWall } from '../lib/curveGeom'
import { convertMakeupToBands, moduleHeightForBand } from '../lib/makeups'
import { buildBlockColorMap } from '../lib/blockColors'

// ---------- Constants ----------

/** Default wall height (mm) when neither the wall override nor the makeup
 *  resolves a height — should basically never trigger but keeps the box
 *  from collapsing to zero. */
const FALLBACK_HEIGHT_MM = 2400

/** Default colour used for brick walls + any wall whose makeup resolves
 *  to no bands. Warm neutral, same as the spike v1. */
const DEFAULT_WALL_COLOR = '#cdb697'

/** Ground plane colour — slate grey so wall colour pops. */
const GROUND_COLOR = '#3a3f48'

/** How many straight segments to sample a curved wall into. 24 reads as a
 *  smooth curve at typical project radii without exploding triangle count. */
const CURVE_SAMPLES = 24

// ---------- Props ----------

export interface WorkspaceView3DProps {
  /** Walls visible on the current page (already area-filtered by the parent). */
  walls: Wall[]
  /** Openings on those walls. */
  openings: Opening[]
  /** Block + brick makeups for height + band resolution. */
  makeupsById: Record<string, WallMakeup>
  brickMakeupsById: Record<string, BrickMakeup>
  /** Plan-view thickness per wall (already computed by the workspace). */
  wallThicknessByWallId: Record<string, number>
  /** Project areas — kept for v1's neutral colouring fallback. */
  areas: ProjectArea[]
  /** Block library keyed by code — used to look up each band block's
   *  modular course height. Passed in (not imported) so a future
   *  per-project library override works without code changes here. */
  library: Record<string, Block>
}

// ---------- Helpers ----------

/** Resolve a wall's actual height in mm: per-wall override > makeup height. */
function resolveWallHeightMm(
  wall: Wall,
  makeupsById: Record<string, WallMakeup>,
  brickMakeupsById: Record<string, BrickMakeup>
): number {
  if (typeof wall.heightMmOverride === 'number') return wall.heightMmOverride
  if (wall.trade === 'brick') {
    return brickMakeupsById[wall.makeupId]?.heightMm ?? FALLBACK_HEIGHT_MM
  }
  return makeupsById[wall.makeupId]?.heightMm ?? FALLBACK_HEIGHT_MM
}

/**
 * Resolve the band stack for a block wall, scaled to the wall's actual
 * height (which can differ from the makeup's heightMm via
 * heightMmOverride). We pass a clone of the makeup with the override
 * applied so convertMakeupToBands sizes the band counts to the actual
 * wall height — otherwise a 2400mm override would still draw a
 * 3100mm-band-count of stripes.
 *
 * Returns { y, height, color } per band — bottom-up. Heights in METRES.
 */
interface ResolvedBand {
  y0: number
  y1: number
  blockCode: string
}

function resolveWallBands(
  wall: Wall,
  makeupsById: Record<string, WallMakeup>,
  library: Record<string, Block>,
  fallbackColor: string
): { bands: ResolvedBand[]; totalHeightM: number; defaultColor: string } {
  const makeup = makeupsById[wall.makeupId]
  const heightMm =
    typeof wall.heightMmOverride === 'number'
      ? wall.heightMmOverride
      : makeup?.heightMm ?? FALLBACK_HEIGHT_MM
  const totalHeightM = heightMm / 1000

  if (!makeup) {
    return { bands: [], totalHeightM, defaultColor: fallbackColor }
  }
  // Use the makeup's own coursePattern if set; otherwise derive bands
  // from the makeup defaults. Pass the height override via a clone so
  // convertMakeupToBands sizes the band counts to the actual wall.
  const scopedMakeup: WallMakeup =
    typeof wall.heightMmOverride === 'number'
      ? { ...makeup, heightMm: wall.heightMmOverride }
      : makeup
  const { bands: courseBands } = convertMakeupToBands(scopedMakeup, undefined, {
    skipHeightMakeup: true,
  })

  const bands: ResolvedBand[] = []
  let y = 0
  for (const cb of courseBands) {
    if (cb.count <= 0) continue
    const moduleMm = moduleHeightForBand(cb.blockCode, library)
    const bandHeightM = (moduleMm * cb.count) / 1000
    bands.push({ y0: y, y1: y + bandHeightM, blockCode: cb.blockCode })
    y += bandHeightM
  }
  // If bands fell short of the wall (e.g. courses don't tile evenly),
  // pad the top with the topmost band's code so the wall still reaches
  // its target height visually.
  if (y < totalHeightM - 0.001 && bands.length > 0) {
    bands[bands.length - 1].y1 = totalHeightM
  } else if (bands.length === 0) {
    // No usable bands — return a single solid band covering the whole
    // wall, coloured with the makeup's body code if any.
    bands.push({
      y0: 0,
      y1: totalHeightM,
      blockCode: makeup.bodyBlockCode ?? '',
    })
  }
  return { bands, totalHeightM, defaultColor: fallbackColor }
}

/**
 * One axis-aligned-by-rotation wall sub-box descriptor — ready to render
 * as a Three.js <mesh>. Coordinates already in metres, Y-up.
 */
interface WallSegmentBox {
  /** Centre of the box in world space. */
  cx: number
  cy: number
  cz: number
  /** Size along local X / Y / Z (length × height × thickness). */
  length: number
  heightM: number
  thickness: number
  /** Rotation around Y axis (radians) — aligns local X with the wall's
   *  start-to-end direction. */
  yRotation: number
  /** Tint. */
  color: string
}

/**
 * Compute the sub-boxes for a single straight wall. Walks the wall both
 * vertically (by band) and horizontally (by opening cutouts) and emits
 * one box per (band × solid-span) cell. Result: a 3D stack of coloured
 * bricks-of-bands with window/door holes cut out.
 */
function segmentsForStraightWall(
  wall: Wall,
  openings: Opening[],
  thicknessMm: number,
  bands: ResolvedBand[],
  totalHeightM: number,
  colorMap: Map<string, string>,
  defaultColor: string
): WallSegmentBox[] {
  // Plan → 3D conversion. Negate Z so positive-Y in plan view (down on
  // screen) reads as "back" in the 3D scene.
  const sx = wall.startX / 1000
  const sz = -wall.startY / 1000
  const ex = wall.endX / 1000
  const ez = -wall.endY / 1000
  const dx = ex - sx
  const dz = ez - sz
  const length = Math.hypot(dx, dz)
  if (length === 0) return []
  const yRotation = Math.atan2(-dz, dx)
  const thickness = thicknessMm / 1000
  const dirX = dx / length
  const dirZ = dz / length

  // For each band, figure out the horizontal solid spans (the cells of
  // the band not covered by an opening). Then emit one box per solid
  // span × this band.
  const wallOpenings = openings
    .filter((o) => o.wallId === wall.id)
    .map((o) => ({
      start: Math.max(0, o.startAlongWallMm / 1000),
      end: Math.min(length, (o.startAlongWallMm + o.widthMm) / 1000),
      sill: Math.max(0, o.sillHeightMm / 1000),
      head: Math.min(totalHeightM, (o.sillHeightMm + o.heightMm) / 1000),
    }))
    .filter((o) => o.end > o.start && o.head > o.sill)
    .sort((a, b) => a.start - b.start)

  const boxes: WallSegmentBox[] = []

  // Build a box from a local (s0..s1) span × (y0..y1) vertical band.
  const buildBox = (
    s0: number,
    s1: number,
    y0: number,
    y1: number,
    color: string
  ): WallSegmentBox => {
    const localCx = (s0 + s1) / 2
    const segLength = s1 - s0
    const segHeight = y1 - y0
    return {
      cx: sx + dirX * localCx,
      cy: (y0 + y1) / 2,
      cz: sz + dirZ * localCx,
      length: segLength,
      heightM: segHeight,
      thickness,
      yRotation,
      color,
    }
  }

  for (const band of bands) {
    const bandColor = colorMap.get(band.blockCode) ?? defaultColor
    // Which openings overlap this band's y-range? An opening occupies
    // this band only where its (sill, head) vertical span intersects
    // (band.y0, band.y1).
    const bandOpenings = wallOpenings
      .map((o) => ({
        start: o.start,
        end: o.end,
        coversBand: o.sill <= band.y0 && o.head >= band.y1,
      }))
      .filter((o) => o.coversBand) // only openings that fully cross this band

    if (bandOpenings.length === 0) {
      // Solid band — single box across full wall length.
      boxes.push(buildBox(0, length, band.y0, band.y1, bandColor))
      continue
    }

    // Walk left-to-right emitting solid panels between openings, at this
    // band's vertical span. Openings that only partially intersect the
    // band's y-range are treated as the full-cross case (small visual
    // overlap on the sill/head boundary, acceptable for a mass model).
    let cursor = 0
    for (const op of bandOpenings) {
      if (op.start > cursor) {
        boxes.push(buildBox(cursor, op.start, band.y0, band.y1, bandColor))
      }
      cursor = Math.max(cursor, op.end)
    }
    if (cursor < length) {
      boxes.push(buildBox(cursor, length, band.y0, band.y1, bandColor))
    }
  }

  // Also emit sill / head fills for openings that don't fully cross a
  // band — i.e. a window that starts above the floor (sill > 0) and
  // ends below the wall top (head < total). The above-head and
  // below-sill spans get a band-coloured fill that matches the band
  // they sit in. We do this per-band by adding two extra passes.
  for (const op of wallOpenings) {
    // Below-sill (from 0 to op.sill): emit per-band slices using the
    // colour of the band the slice sits in.
    if (op.sill > 0) {
      for (const band of bands) {
        const y0 = Math.max(band.y0, 0)
        const y1 = Math.min(band.y1, op.sill)
        if (y1 > y0) {
          const color = colorMap.get(band.blockCode) ?? defaultColor
          boxes.push(buildBox(op.start, op.end, y0, y1, color))
        }
      }
    }
    // Above-head (from op.head to totalHeight): same pattern.
    if (op.head < totalHeightM) {
      for (const band of bands) {
        const y0 = Math.max(band.y0, op.head)
        const y1 = Math.min(band.y1, totalHeightM)
        if (y1 > y0) {
          const color = colorMap.get(band.blockCode) ?? defaultColor
          boxes.push(buildBox(op.start, op.end, y0, y1, color))
        }
      }
    }
  }
  return boxes
}

/**
 * Curved-wall variant. Samples the arc into N straight segments and
 * runs each through the straight-wall builder with no openings (v1
 * doesn't render openings on curved walls).
 */
function segmentsForCurvedWall(
  wall: Wall,
  thicknessMm: number,
  bands: ResolvedBand[],
  totalHeightM: number,
  colorMap: Map<string, string>,
  defaultColor: string
): WallSegmentBox[] {
  if (wall.midX === undefined || wall.midY === undefined) return []
  const geom = arcFromThreePoints(
    { x: wall.startX, y: wall.startY },
    { x: wall.midX, y: wall.midY },
    { x: wall.endX, y: wall.endY }
  )
  if (!geom) {
    return segmentsForStraightWall(
      wall,
      [],
      thicknessMm,
      bands,
      totalHeightM,
      colorMap,
      defaultColor
    )
  }
  const samples = sampleArc(geom, CURVE_SAMPLES + 1)
  const boxes: WallSegmentBox[] = []
  for (let i = 0; i < samples.length - 1; i++) {
    const a = samples[i]
    const b = samples[i + 1]
    const fakeWall: Wall = {
      ...wall,
      startX: a.x,
      startY: a.y,
      endX: b.x,
      endY: b.y,
    }
    boxes.push(
      ...segmentsForStraightWall(
        fakeWall,
        [],
        thicknessMm,
        bands,
        totalHeightM,
        colorMap,
        defaultColor
      )
    )
  }
  return boxes
}

// ---------- Scene ----------

function Scene({
  walls,
  openings,
  makeupsById,
  brickMakeupsById,
  wallThicknessByWallId,
  library,
}: Omit<WorkspaceView3DProps, 'areas'>) {
  // Per-wall band stacks — memoised together so the colour map and the
  // segment builder both see the same data.
  const { segments, segmentBounds } = useMemo(() => {
    // First pass: resolve each wall's bands so we know every block code
    // that'll appear in the 3D view. Pass that complete set to
    // buildBlockColorMap so every code lands on a distinct palette slot.
    const wallBands = walls.map((wall) => {
      if (wall.trade === 'brick') {
        // Brick walls don't go through the band path in v1 — they get
        // one solid box. resolveWallBands isn't called for them.
        return null
      }
      return resolveWallBands(wall, makeupsById, library, DEFAULT_WALL_COLOR)
    })
    const allCodes: string[] = []
    for (const wb of wallBands) {
      if (!wb) continue
      for (const b of wb.bands) allCodes.push(b.blockCode)
    }
    const colorMap = buildBlockColorMap(allCodes)

    // Second pass: build segments per wall using the colour map.
    const out: WallSegmentBox[] = []
    walls.forEach((wall, i) => {
      const thicknessMm = wallThicknessByWallId[wall.id] ?? 190
      if (wall.trade === 'brick') {
        // Brick: single solid box, default colour.
        const heightMm = resolveWallHeightMm(wall, makeupsById, brickMakeupsById)
        const totalHeightM = heightMm / 1000
        const singleBand: ResolvedBand[] = [
          { y0: 0, y1: totalHeightM, blockCode: '__brick__' },
        ]
        const brickColorMap = new Map([['__brick__', DEFAULT_WALL_COLOR]])
        out.push(
          ...segmentsForStraightWall(
            wall,
            openings,
            thicknessMm,
            singleBand,
            totalHeightM,
            brickColorMap,
            DEFAULT_WALL_COLOR
          )
        )
        return
      }
      const wb = wallBands[i]
      if (!wb) return
      if (isCurvedWall(wall)) {
        out.push(
          ...segmentsForCurvedWall(
            wall,
            thicknessMm,
            wb.bands,
            wb.totalHeightM,
            colorMap,
            wb.defaultColor
          )
        )
      } else {
        out.push(
          ...segmentsForStraightWall(
            wall,
            openings,
            thicknessMm,
            wb.bands,
            wb.totalHeightM,
            colorMap,
            wb.defaultColor
          )
        )
      }
    })

    // Bounds for the ground plane + orbit target.
    let bounds: { centerX: number; centerZ: number; sizeMax: number } = {
      centerX: 0,
      centerZ: 0,
      sizeMax: 20,
    }
    if (out.length > 0) {
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity
      for (const s of out) {
        const r = Math.max(s.length, s.thickness) / 2
        minX = Math.min(minX, s.cx - r)
        maxX = Math.max(maxX, s.cx + r)
        minZ = Math.min(minZ, s.cz - r)
        maxZ = Math.max(maxZ, s.cz + r)
      }
      bounds = {
        centerX: (minX + maxX) / 2,
        centerZ: (minZ + maxZ) / 2,
        sizeMax: Math.max(maxX - minX, maxZ - minZ, 4),
      }
    }
    return { segments: out, segmentBounds: bounds }
  }, [walls, openings, makeupsById, brickMakeupsById, wallThicknessByWallId, library])

  return (
    <>
      <ambientLight intensity={0.6} />
      <directionalLight position={[10, 20, 10]} intensity={0.8} />

      {/* Ground plane — flat slate rectangle sized 4× the project bounds. */}
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[segmentBounds.centerX, -0.001, segmentBounds.centerZ]}
        receiveShadow={false}
      >
        <planeGeometry args={[segmentBounds.sizeMax * 4, segmentBounds.sizeMax * 4]} />
        <meshStandardMaterial color={GROUND_COLOR} />
      </mesh>

      {/* Walls — one mesh per band × solid-span sub-box. Cheap enough for
          Tier 1 even with ~30 walls × ~5 bands × ~3 sub-spans ≈ 450 meshes.
          InstancedMesh by colour can collapse this to ~16 draw calls
          (one per palette slot) if a busier project warrants it. */}
      {segments.map((s, i) => (
        <mesh key={i} position={[s.cx, s.cy, s.cz]} rotation={[0, s.yRotation, 0]}>
          <boxGeometry args={[s.length, s.heightM, s.thickness]} />
          <meshStandardMaterial color={s.color} />
        </mesh>
      ))}

      <OrbitControls
        target={[segmentBounds.centerX, 1, segmentBounds.centerZ]}
        enableDamping
        dampingFactor={0.1}
        makeDefault
      />
    </>
  )
}

// ---------- Top-level export ----------

export default function WorkspaceView3D(props: WorkspaceView3DProps) {
  const { walls } = props

  // Initial camera position derived from the project's bounding box so a
  // 30m building isn't tiny and a 4m wall isn't off-screen. Picks an
  // angle up-and-back at ~30° from the ground.
  const initialCamera = useMemo<[number, number, number]>(() => {
    if (walls.length === 0) return [10, 12, 10]
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity
    for (const w of walls) {
      const sx = w.startX / 1000, sz = -w.startY / 1000
      const ex = w.endX / 1000, ez = -w.endY / 1000
      minX = Math.min(minX, sx, ex)
      maxX = Math.max(maxX, sx, ex)
      minZ = Math.min(minZ, sz, ez)
      maxZ = Math.max(maxZ, sz, ez)
    }
    const cx = (minX + maxX) / 2
    const cz = (minZ + maxZ) / 2
    const sizeMax = Math.max(maxX - minX, maxZ - minZ, 4)
    const dist = sizeMax * 0.9 + 6
    return [cx + dist * 0.7, dist * 0.8, cz + dist * 0.7]
  }, [walls])

  if (walls.length === 0) {
    return (
      <div className="w-full h-full flex items-center justify-center text-ink-400 text-sm">
        Draw a wall on the 2D view to see it here.
      </div>
    )
  }

  return (
    <div className="w-full h-full">
      <Canvas
        frameloop="demand"
        dpr={[1, 1.5]}
        camera={{ position: initialCamera, fov: 45, near: 0.1, far: 5000 }}
        shadows={false}
        gl={{ antialias: true, powerPreference: 'high-performance' }}
        onCreated={({ gl }) => {
          gl.setClearColor(new THREE.Color('#1a1d24'))
        }}
      >
        <Suspense fallback={null}>
          <Scene {...props} />
        </Suspense>
      </Canvas>
    </div>
  )
}
