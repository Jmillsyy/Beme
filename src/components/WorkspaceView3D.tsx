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
 * Per-wall rendering (block walls):
 *   Each wall is decomposed into bands (convertMakeupToBands) and each
 *   band is rendered course-by-course. For every course we emit three
 *   regions: a left end-cap, a body slab in the middle, and a right
 *   end-cap. The end-cap code alternates per course in stretcher bond
 *   (corner block on odd courses, half block on even) and is uniform in
 *   stack bond (corner block every course). All three regions are tinted
 *   by their own block code's colour using the same distinct-colour
 *   palette as the 2D wall-type preview — so "the green one is 20.45"
 *   in the legend maps to the same green stripes in 3D, and corner
 *   blocks (e.g. 20.01) read as a different colour at the ends.
 *
 *   Brick walls render as a single solid extrusion — per-course brick
 *   banding is a v2 follow-up.
 *
 * Openings (windows + doors) cut by splitting each course's BODY slab
 * into left-of-opening / right-of-opening sub-spans. End-caps are not
 * cut — openings within a corner-block-width of a wall end are rare
 * (typical layouts leave structural space at corners). Sill / head
 * fills behind partially-crossing openings use the body colour at the
 * course's y-position.
 *
 * Curved walls sample the arc into N straight segments and run each
 * through the per-course renderer. No openings on curved walls in v1.
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
import type { Block, BlockCode } from '../types/blocks'
import { arcFromThreePoints, sampleArc, isCurvedWall } from '../lib/curveGeom'
import {
  convertMakeupToBands,
  moduleHeightForBand,
  resolveCourseBlocks,
} from '../lib/makeups'
import { buildBlockColorMap } from '../lib/blockColors'

// ---------- Constants ----------

const FALLBACK_HEIGHT_MM = 2400
const DEFAULT_WALL_COLOR = '#cdb697'
const GROUND_COLOR = '#3a3f48'
const CURVE_SAMPLES = 24

/** Fallback widths (mm) when the library doesn't carry the block. AU
 *  defaults — full end 20.01 ≈ 390mm, half end 20.03 ≈ 190mm. */
const FALLBACK_CORNER_WIDTH_MM = 390
const FALLBACK_HALF_WIDTH_MM = 190

// ---------- Props ----------

export interface WorkspaceView3DProps {
  walls: Wall[]
  openings: Opening[]
  makeupsById: Record<string, WallMakeup>
  brickMakeupsById: Record<string, BrickMakeup>
  wallThicknessByWallId: Record<string, number>
  areas: ProjectArea[]
  library: Record<string, Block>
}

// ---------- Helpers ----------

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

/** Look up a block's face width (mm), falling back to the AU default. */
function widthOf(code: BlockCode | undefined, library: Record<string, Block>, fallback: number): number {
  if (!code) return fallback
  return library[code]?.dimensions.widthMm ?? fallback
}

/**
 * One course of the wall — body + corner + half codes already resolved
 * against the makeup's series ranges. y0/y1 are the course's world-space
 * vertical band (in metres).
 */
interface ResolvedCourse {
  /** 1-indexed from the base of the wall. */
  courseNumber: number
  /** World-space y range in metres. */
  y0: number
  y1: number
  /** Resolved per-course codes (body, corner, half). */
  bodyCode: BlockCode
  cornerCode: BlockCode
  halfCode: BlockCode
}

/**
 * Resolve a wall's course-by-course composition.
 *
 * Walks the makeup's band stack (via convertMakeupToBands) bottom-up and
 * expands each band into its individual courses, then runs each course
 * through resolveCourseBlocks so series-range overrides take effect
 * (e.g. courses 1-5 use 300-series corners). Heights in metres.
 */
function resolveWallCourses(
  wall: Wall,
  makeupsById: Record<string, WallMakeup>,
  library: Record<string, Block>
): { courses: ResolvedCourse[]; totalHeightM: number; makeup: WallMakeup | undefined } {
  const makeup = makeupsById[wall.makeupId]
  const heightMm =
    typeof wall.heightMmOverride === 'number'
      ? wall.heightMmOverride
      : makeup?.heightMm ?? FALLBACK_HEIGHT_MM
  const totalHeightM = heightMm / 1000

  if (!makeup) {
    return { courses: [], totalHeightM, makeup: undefined }
  }
  // Clone with override so band counts size to the wall's actual height.
  const scopedMakeup: WallMakeup =
    typeof wall.heightMmOverride === 'number'
      ? { ...makeup, heightMm: wall.heightMmOverride }
      : makeup
  const { bands } = convertMakeupToBands(scopedMakeup, undefined, {
    skipHeightMakeup: true,
  })

  const courses: ResolvedCourse[] = []
  let y = 0
  let courseNum = 1
  for (const band of bands) {
    if (band.count <= 0) continue
    const courseHeightM = moduleHeightForBand(band.blockCode, library) / 1000
    for (let i = 0; i < band.count; i++) {
      const resolved = resolveCourseBlocks(scopedMakeup, courseNum)
      courses.push({
        courseNumber: courseNum,
        y0: y,
        y1: y + courseHeightM,
        // Series-range body overlays the band's body code. Bands come
        // from the makeup's coursePattern (or defaults), but series
        // ranges can replace it for specific course ranges.
        bodyCode: resolved.bodyBlockCode || band.blockCode,
        cornerCode: resolved.cornerBlockCode,
        halfCode: resolved.halfBlockCode,
      })
      y += courseHeightM
      courseNum++
    }
  }
  // Pad shortfall (rare — happens when course heights don't tile evenly
  // to the wall height) so the wall still reaches its target height.
  if (y < totalHeightM - 0.001 && courses.length > 0) {
    courses[courses.length - 1].y1 = totalHeightM
  } else if (courses.length === 0) {
    courses.push({
      courseNumber: 1,
      y0: 0,
      y1: totalHeightM,
      bodyCode: makeup.bodyBlockCode,
      cornerCode: makeup.cornerBlockCode,
      halfCode: makeup.halfBlockCode ?? '20.03',
    })
  }
  return { courses, totalHeightM, makeup }
}

/** One Three.js-ready sub-box descriptor. Coordinates in metres, Y-up. */
interface WallSegmentBox {
  cx: number
  cy: number
  cz: number
  length: number
  heightM: number
  thickness: number
  yRotation: number
  color: string
}

/**
 * Emit sub-boxes for a single straight wall.
 *
 * Per course:
 *   1. Decide which block ends each course (corner on odd / stretcher
 *      stack-bond, half on even / stretcher) and pick its colour + width.
 *   2. Emit left end-cap.
 *   3. Emit the body in the middle (inset by end-cap width from each
 *      end), split by any openings that overlap this course's y-range.
 *      Body uses the course's resolved body code colour.
 *   4. Emit right end-cap.
 *
 * Opening sill / head bands are filled with the body code colour at the
 * relevant course — so the visual reads as "the wall behind the
 * window is still that course's body block".
 */
function segmentsForStraightWall(
  wall: Wall,
  openings: Opening[],
  thicknessMm: number,
  courses: ResolvedCourse[],
  totalHeightM: number,
  bondType: 'stretcher' | 'stack',
  colorMap: Map<string, string>,
  library: Record<string, Block>
): WallSegmentBox[] {
  const sx = wall.startX / 1000
  const sz = -wall.startY / 1000
  const ex = wall.endX / 1000
  const ez = -wall.endY / 1000
  const dx = ex - sx
  const dz = ez - sz
  const length = Math.hypot(dx, dz)
  if (length === 0 || courses.length === 0) return []
  const yRotation = Math.atan2(-dz, dx)
  const thickness = thicknessMm / 1000
  const dirX = dx / length
  const dirZ = dz / length

  // Pre-process openings on this wall — local s0..s1 in metres + sill/head.
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

  const colorOf = (code: BlockCode) => colorMap.get(code) ?? DEFAULT_WALL_COLOR
  const boxes: WallSegmentBox[] = []

  /** Build a centred box from a span along local X (s0..s1, metres from
   *  wall start) and a vertical band (y0..y1, metres from base). */
  const buildBox = (
    s0: number,
    s1: number,
    y0: number,
    y1: number,
    color: string
  ): WallSegmentBox => {
    const localCx = (s0 + s1) / 2
    return {
      cx: sx + dirX * localCx,
      cy: (y0 + y1) / 2,
      cz: sz + dirZ * localCx,
      length: s1 - s0,
      heightM: y1 - y0,
      thickness,
      yRotation,
      color,
    }
  }

  for (const course of courses) {
    const { y0, y1, bodyCode, cornerCode, halfCode } = course
    // End-cap pattern: stack bond = corner every course; stretcher =
    // corner on odd courses, half on even. Matches what the 2D preview
    // renders, so the colour distribution reads the same in 3D.
    const useHalf = bondType === 'stretcher' && course.courseNumber % 2 === 0
    const endCode = useHalf ? halfCode : cornerCode
    const endColor = colorOf(endCode)
    const bodyColor = colorOf(bodyCode)
    const endWidthMm = useHalf
      ? widthOf(halfCode, library, FALLBACK_HALF_WIDTH_MM)
      : widthOf(cornerCode, library, FALLBACK_CORNER_WIDTH_MM)
    const endWidth = endWidthMm / 1000

    // Tiny wall (≤ 2 end-caps wide): render the whole course as a
    // single end-coloured box. Avoids negative-width body slabs.
    if (length <= endWidth * 2) {
      boxes.push(buildBox(0, length, y0, y1, endColor))
      continue
    }

    // Left end-cap.
    boxes.push(buildBox(0, endWidth, y0, y1, endColor))
    // Right end-cap.
    boxes.push(buildBox(length - endWidth, length, y0, y1, endColor))

    // Body region: bound by [endWidth, length - endWidth], cut by any
    // openings whose y-range fully covers this course's y-range.
    const bodyStart = endWidth
    const bodyEnd = length - endWidth
    const courseOpenings = wallOpenings
      .filter((o) => o.sill <= y0 && o.head >= y1) // opening covers this course
      .map((o) => ({
        s0: Math.max(bodyStart, o.start),
        s1: Math.min(bodyEnd, o.end),
      }))
      .filter((o) => o.s1 > o.s0)
      .sort((a, b) => a.s0 - b.s0)

    if (courseOpenings.length === 0) {
      boxes.push(buildBox(bodyStart, bodyEnd, y0, y1, bodyColor))
    } else {
      let cursor = bodyStart
      for (const op of courseOpenings) {
        if (op.s0 > cursor) {
          boxes.push(buildBox(cursor, op.s0, y0, y1, bodyColor))
        }
        cursor = Math.max(cursor, op.s1)
      }
      if (cursor < bodyEnd) {
        boxes.push(buildBox(cursor, bodyEnd, y0, y1, bodyColor))
      }
    }

    // Sill + head fills for partially-crossing openings at this course.
    // Body colour fills the portion of the opening's span that falls
    // ABOVE the opening's head OR BELOW its sill, at this course's
    // y-range. So a 1200mm-high window leaves the courses below the
    // sill + above the head solid behind it.
    for (const op of wallOpenings) {
      // Slice of this course that lies BELOW op.sill: course is below
      // the opening.
      if (op.sill > y0 && op.sill < y1) {
        // Course straddles the sill — render solid up to the sill line.
        const fillTop = Math.min(y1, op.sill)
        if (fillTop > y0) {
          boxes.push(buildBox(op.start, op.end, y0, fillTop, bodyColor))
        }
      } else if (op.sill >= y1) {
        // Course is fully below the sill — fill the opening span solid.
        boxes.push(buildBox(op.start, op.end, y0, y1, bodyColor))
      }
      // Slice of this course that lies ABOVE op.head.
      if (op.head > y0 && op.head < y1) {
        const fillBottom = Math.max(y0, op.head)
        if (fillBottom < y1) {
          boxes.push(buildBox(op.start, op.end, fillBottom, y1, bodyColor))
        }
      } else if (op.head <= y0) {
        // Course is fully above the head — fill the opening span solid.
        boxes.push(buildBox(op.start, op.end, y0, y1, bodyColor))
      }
    }
  }

  return boxes
}

/**
 * Curved-wall variant. Samples the arc into N straight segments and
 * runs each through the straight-wall builder with no openings.
 */
function segmentsForCurvedWall(
  wall: Wall,
  thicknessMm: number,
  courses: ResolvedCourse[],
  totalHeightM: number,
  bondType: 'stretcher' | 'stack',
  colorMap: Map<string, string>,
  library: Record<string, Block>
): WallSegmentBox[] {
  if (wall.midX === undefined || wall.midY === undefined) return []
  const geom = arcFromThreePoints(
    { x: wall.startX, y: wall.startY },
    { x: wall.midX, y: wall.midY },
    { x: wall.endX, y: wall.endY }
  )
  if (!geom) {
    return segmentsForStraightWall(
      wall, [], thicknessMm, courses, totalHeightM, bondType, colorMap, library
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
        fakeWall, [], thicknessMm, courses, totalHeightM, bondType, colorMap, library
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
  const { segments, segmentBounds } = useMemo(() => {
    // First pass: resolve each wall's per-course composition so we know
    // every block code (body + corner + half) that'll appear in the 3D
    // view. Pass the complete set to buildBlockColorMap so every code
    // lands on a distinct palette slot — same logic as the 2D preview.
    const wallResolutions = walls.map((wall) => {
      if (wall.trade === 'brick') return null
      return resolveWallCourses(wall, makeupsById, library)
    })
    const allCodes: string[] = []
    for (const wr of wallResolutions) {
      if (!wr) continue
      for (const c of wr.courses) {
        allCodes.push(c.bodyCode, c.cornerCode, c.halfCode)
      }
    }
    const colorMap = buildBlockColorMap(allCodes)

    const out: WallSegmentBox[] = []
    walls.forEach((wall, i) => {
      const thicknessMm = wallThicknessByWallId[wall.id] ?? 190

      if (wall.trade === 'brick') {
        // Brick walls render as one solid extrusion for v1. Per-course
        // banding (BrickMakeup.courseRanges) is a follow-up.
        const heightMm = resolveWallHeightMm(wall, makeupsById, brickMakeupsById)
        const totalHeightM = heightMm / 1000
        const solidCourse: ResolvedCourse[] = [
          {
            courseNumber: 1,
            y0: 0,
            y1: totalHeightM,
            bodyCode: '__brick__',
            cornerCode: '__brick__',
            halfCode: '__brick__',
          },
        ]
        const brickColorMap = new Map([['__brick__', DEFAULT_WALL_COLOR]])
        out.push(
          ...segmentsForStraightWall(
            wall, openings, thicknessMm, solidCourse, totalHeightM,
            'stack', brickColorMap, library
          )
        )
        return
      }

      const wr = wallResolutions[i]
      if (!wr || !wr.makeup) return
      const bondType = wr.makeup.bondType
      if (isCurvedWall(wall)) {
        out.push(
          ...segmentsForCurvedWall(
            wall, thicknessMm, wr.courses, wr.totalHeightM,
            bondType, colorMap, library
          )
        )
      } else {
        out.push(
          ...segmentsForStraightWall(
            wall, openings, thicknessMm, wr.courses, wr.totalHeightM,
            bondType, colorMap, library
          )
        )
      }
    })

    // Bounds for ground plane + orbit target.
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

      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[segmentBounds.centerX, -0.001, segmentBounds.centerZ]}
      >
        <planeGeometry args={[segmentBounds.sizeMax * 4, segmentBounds.sizeMax * 4]} />
        <meshStandardMaterial color={GROUND_COLOR} />
      </mesh>

      {/* One mesh per wall sub-box. Per-course rendering means ~5x more
          meshes than band rendering, but with ~30 walls × 13 courses ×
          ~3 cells = ~1200 meshes the cost is still fine on integrated
          GPUs. InstancedMesh by colour collapses this to ~16 draw calls
          if a busier project warrants. */}
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
      <div className="absolute inset-0 flex items-center justify-center text-ink-400 text-sm">
        Draw a wall on the 2D view to see it here.
      </div>
    )
  }

  return (
    // Absolute-positioned so we fill the relatively-positioned parent
    // exactly. h-full / w-full on a flex-1 child sometimes fails to
    // resolve (parent's height comes from flex layout, not an explicit
    // value — child `height: 100%` has nothing to compute against), so
    // we sidestep that with absolute inset:0.
    <div className="absolute inset-0">
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
