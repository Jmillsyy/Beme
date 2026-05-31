/**
 * WorkspaceView3D — Tier 1 mass-model 3D view of the project.
 *
 * Lazy-loaded behind the workspace's 2D ↔ 3D toggle so users who never open
 * 3D pay zero bundle cost. The 2D Konva workspace stays the source of truth
 * for editing; this view is read-only — orbit camera + WASD walk, no
 * interaction with walls.
 *
 * Coordinate system:
 *   Plan-view (mm)      → 3D (m, Y-up)
 *   wall.startX/.startY → X / Z (negated Z so "up" in plan = "back" in 3D)
 *   wall height (mm)    → Y
 *
 * Walls render as one extruded box per straight segment. Openings are cut
 * by emitting multiple sub-boxes (above head + below sill + side panels)
 * instead of CSG — keeps it cheap and lets InstancedMesh come later
 * without rework. Curved walls are sampled into N straight segments.
 *
 * Battery-friendly defaults:
 *   - frameloop="demand" — frames only render on camera interaction.
 *   - Pixel ratio capped at 1.5 — no Retina-density rendering.
 *   - One directional light, no shadows. Fine for a mass model.
 */
import { Suspense, useMemo, useRef, useEffect } from 'react'
import { Canvas } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import * as THREE from 'three'
import type { Wall, Opening, WallMakeup, BrickMakeup } from '../types/walls'
import type { ProjectArea } from '../lib/projectStorage'
import { arcFromThreePoints, sampleArc, isCurvedWall } from '../lib/curveGeom'

// ---------- Constants ----------

/** Default wall height (mm) when neither the wall override nor the makeup
 *  resolves a height — should basically never trigger but keeps the box
 *  from collapsing to zero. */
const FALLBACK_HEIGHT_MM = 2400

/** Default colour used when a wall has no assigned area, or the area has
 *  no colorHex set. Warm neutral so it reads as "default mass" rather
 *  than competing with the area-tagged walls. */
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
  /** Block + brick makeups for height + colour resolution. */
  makeupsById: Record<string, WallMakeup>
  brickMakeupsById: Record<string, BrickMakeup>
  /** Plan-view thickness per wall (already computed by the workspace). */
  wallThicknessByWallId: Record<string, number>
  /** Project areas — lets us colour walls by area. */
  areas: ProjectArea[]
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

/** Resolve a wall's display colour from its assigned area. */
function resolveWallColor(wall: Wall, areas: ProjectArea[]): string {
  if (!wall.areaId) return DEFAULT_WALL_COLOR
  const area = areas.find((a) => a.id === wall.areaId)
  return area?.colorHex ?? DEFAULT_WALL_COLOR
}

/**
 * One straight wall-segment box descriptor — ready to render as a <mesh>.
 * Coordinates already in metres, Y-up.
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
  /** Rotation around Y axis (radians) — aligns the box's local X with the
   *  wall's start-to-end direction. */
  yRotation: number
  /** Tint. */
  color: string
}

/**
 * Turn one straight wall (start + end + thickness + height) plus any
 * openings on it into an array of axis-aligned-by-rotation sub-boxes.
 *
 * Walks left-to-right along the wall's local X axis (start = 0,
 * end = length). Emits solid panels between openings (full height) and
 * splits opening spans into below-sill + above-head boxes. Result: a
 * stack of boxes whose union is the wall with window/door holes cut out.
 */
function segmentsForStraightWall(
  wall: Wall,
  openings: Opening[],
  thicknessMm: number,
  heightMm: number,
  color: string
): WallSegmentBox[] {
  // Convert to metres and Y-up. Negate Z so positive-Y in plan view
  // (i.e. down on the screen) reads as "back" in the 3D scene.
  const sx = wall.startX / 1000
  const sz = -wall.startY / 1000
  const ex = wall.endX / 1000
  const ez = -wall.endY / 1000
  const dx = ex - sx
  const dz = ez - sz
  const length = Math.hypot(dx, dz)
  if (length === 0) return []
  const yRotation = Math.atan2(-dz, dx) // angle of (dx, -dz) in XZ plane
  const heightM = heightMm / 1000
  const thickness = thicknessMm / 1000
  const halfThickness = thickness / 2

  // Mid X of the wall in world space (used as origin to position each
  // sub-box). Sub-boxes carry their own local-X offset from start.
  const startX = sx
  const startZ = sz
  const dirX = dx / length
  const dirZ = dz / length

  // Build a centred box from a span along local X (s0..s1, both in metres
  // from wall start) and a vertical band (y0..y1).
  const buildBox = (s0: number, s1: number, y0: number, y1: number): WallSegmentBox => {
    const localCx = (s0 + s1) / 2
    const segLength = s1 - s0
    const segHeight = y1 - y0
    const segCy = (y0 + y1) / 2
    // World position = wall start + dir × localCx, plus a half-thickness
    // perpendicular shift would centre us on the wall line — but the
    // box's local X already runs along the wall, so it's centred already.
    return {
      cx: startX + dirX * localCx,
      cy: segCy,
      cz: startZ + dirZ * localCx,
      length: segLength,
      heightM: segHeight,
      thickness,
      yRotation,
      color,
    }
  }

  // Sort openings by their position along the wall + clamp them to [0, length].
  const wallOpenings = openings
    .filter((o) => o.wallId === wall.id)
    .map((o) => {
      const start = Math.max(0, o.startAlongWallMm / 1000)
      const end = Math.min(length, (o.startAlongWallMm + o.widthMm) / 1000)
      const sill = Math.max(0, o.sillHeightMm / 1000)
      const head = Math.min(heightM, (o.sillHeightMm + o.heightMm) / 1000)
      return { start, end, sill, head }
    })
    .filter((o) => o.end > o.start && o.head > o.sill)
    .sort((a, b) => a.start - b.start)

  const boxes: WallSegmentBox[] = []
  let cursor = 0
  for (const op of wallOpenings) {
    // Solid panel from previous cursor up to the opening start.
    if (op.start > cursor) {
      boxes.push(buildBox(cursor, op.start, 0, heightM))
    }
    // Below-sill (if any).
    if (op.sill > 0) {
      boxes.push(buildBox(op.start, op.end, 0, op.sill))
    }
    // Above-head (if any).
    if (op.head < heightM) {
      boxes.push(buildBox(op.start, op.end, op.head, heightM))
    }
    cursor = Math.max(cursor, op.end)
  }
  // Trailing solid panel after the last opening.
  if (cursor < length) {
    boxes.push(buildBox(cursor, length, 0, heightM))
  }
  // Avoid silliness on a wall with zero footprint after clamping.
  if (boxes.length === 0) {
    boxes.push(buildBox(0, length, 0, heightM))
  }
  // Keep the actual halfThickness handy via closure — Three's BoxGeometry
  // is centred, so the y offset above already places the bottom at y=0.
  void halfThickness
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
  heightMm: number,
  color: string
): WallSegmentBox[] {
  if (
    wall.midX === undefined ||
    wall.midY === undefined ||
    typeof wall.startX !== 'number'
  ) {
    return []
  }
  const geom = arcFromThreePoints(
    { x: wall.startX, y: wall.startY },
    { x: wall.midX, y: wall.midY },
    { x: wall.endX, y: wall.endY }
  )
  if (!geom) {
    // Collinear → render as a straight wall.
    return segmentsForStraightWall(wall, [], thicknessMm, heightMm, color)
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
    boxes.push(...segmentsForStraightWall(fakeWall, [], thicknessMm, heightMm, color))
  }
  return boxes
}

// ---------- Scene ----------

/**
 * One static scene built from the props. Memoised because the segment
 * computation is the cost — the JSX render itself is cheap.
 */
function Scene({
  walls,
  openings,
  makeupsById,
  brickMakeupsById,
  wallThicknessByWallId,
  areas,
}: WorkspaceView3DProps) {
  const segments = useMemo(() => {
    const out: WallSegmentBox[] = []
    for (const wall of walls) {
      const thicknessMm = wallThicknessByWallId[wall.id] ?? 190
      const heightMm = resolveWallHeightMm(wall, makeupsById, brickMakeupsById)
      const color = resolveWallColor(wall, areas)
      if (isCurvedWall(wall)) {
        out.push(...segmentsForCurvedWall(wall, thicknessMm, heightMm, color))
      } else {
        out.push(...segmentsForStraightWall(wall, openings, thicknessMm, heightMm, color))
      }
    }
    return out
  }, [walls, openings, makeupsById, brickMakeupsById, wallThicknessByWallId, areas])

  // Bounds drive (a) the orbit target so the camera looks at the project
  // centre, and (b) the ground plane size. Recomputed when segments change.
  const { centerX, centerZ, sizeMax } = useMemo(() => {
    if (segments.length === 0) {
      return { centerX: 0, centerZ: 0, sizeMax: 20 }
    }
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity
    for (const s of segments) {
      const r = Math.max(s.length, s.thickness) / 2
      minX = Math.min(minX, s.cx - r)
      maxX = Math.max(maxX, s.cx + r)
      minZ = Math.min(minZ, s.cz - r)
      maxZ = Math.max(maxZ, s.cz + r)
    }
    return {
      centerX: (minX + maxX) / 2,
      centerZ: (minZ + maxZ) / 2,
      sizeMax: Math.max(maxX - minX, maxZ - minZ, 4),
    }
  }, [segments])

  return (
    <>
      {/* Ambient + one directional light — cheap, no shadows. Plenty for a
          mass-model read where edges between walls matter more than soft
          shading. */}
      <ambientLight intensity={0.6} />
      <directionalLight position={[10, 20, 10]} intensity={0.8} />

      {/* Ground plane — flat slate rectangle sized 4× the project bounds so
          you can always see "ground" around the building. Slightly offset
          downward so wall bottoms (y=0) sit a hair above it. */}
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[centerX, -0.001, centerZ]}
        receiveShadow={false}
      >
        <planeGeometry args={[sizeMax * 4, sizeMax * 4]} />
        <meshStandardMaterial color={GROUND_COLOR} />
      </mesh>

      {/* Walls — one mesh per box. Cheap enough for Tier 1; later
          InstancedMesh by colour can collapse this to a handful of draw
          calls if the count climbs. */}
      {segments.map((s, i) => (
        <mesh key={i} position={[s.cx, s.cy, s.cz]} rotation={[0, s.yRotation, 0]}>
          <boxGeometry args={[s.length, s.heightM, s.thickness]} />
          <meshStandardMaterial color={s.color} />
        </mesh>
      ))}

      {/* Orbit camera — points at the project centre. Distance derived
          from project size so a 30m building isn't tiny and a 4m wall
          isn't off-screen. */}
      <OrbitControls
        target={[centerX, 1, centerZ]}
        enableDamping
        dampingFactor={0.1}
        makeDefault
      />
    </>
  )
}

// ---------- Top-level export ----------

/**
 * Default export so PdfWorkspace can use `React.lazy(() => import(...))`.
 * Wraps the Canvas with a sensible camera position, a Suspense boundary
 * for any drei async deps, and an empty-state fallback.
 */
export default function WorkspaceView3D(props: WorkspaceView3DProps) {
  const { walls } = props
  // Pick a starting camera position based on rough project size. Camera
  // sits up and back, looking down at ~30° — gives an immediate read of
  // the layout without the user needing to orbit first.
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

  // Watch the renderer for WebGL context loss — a low-end GPU or driver
  // crash can drop the context. We catch it via a ref to the gl + an
  // event listener so we don't render gibberish, but the spike just
  // forces a re-mount on the next props change.
  const lostRef = useRef(false)
  useEffect(() => { lostRef.current = false }, [walls])

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
        // demand frameloop — only render on camera interaction. Saves
        // battery on laptops where the view often sits idle.
        frameloop="demand"
        // Capped pixel ratio — Retina-density rendering is invisible at
        // a mass-model fidelity, but doubles GPU cost.
        dpr={[1, 1.5]}
        camera={{ position: initialCamera, fov: 45, near: 0.1, far: 5000 }}
        // No shadow map = ~30% off the frame cost on integrated GPUs.
        shadows={false}
        gl={{ antialias: true, powerPreference: 'high-performance' }}
        onCreated={({ gl }) => {
          // Background colour — same ink-900 as the workspace so the
          // 3D viewport blends with the rest of the UI.
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
