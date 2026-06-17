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
 * Curved walls reuse the straight-wall layout — laid out flat on a
 * virtual straight wall whose length equals the OUTER arc length —
 * then each block is bent into a trapezoidal wedge along the arc
 * (front face full block width, rear face cut), matching how a
 * bricklayer cuts the back of each unit to follow a real curve.
 * No openings on curved walls in v1.
 *
 * Battery-friendly defaults:
 *   - frameloop="demand" — frames only render on camera interaction.
 *   - Pixel ratio capped at 1.5 — no Retina-density rendering.
 *   - One directional light, no shadows. Fine for a mass model.
 */
import { Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { Canvas, useThree } from '@react-three/fiber'
import { Grid } from '@react-three/drei'
import * as THREE from 'three'
import type {
  Wall,
  Opening,
  WallMakeup,
  BrickMakeup,
  Pier,
  PierMakeup,
} from '../types/walls'
import type { ProjectArea } from '../lib/projectStorage'
import type { Block, BlockCode } from '../types/blocks'
import { arcFromThreePoints, isCurvedWall } from '../lib/curveGeom'
import { convertMakeupToBands, getMakeupHeightMm } from '../lib/makeups'
import { DEFAULT_MORTAR_JOINT_MM } from '../types/blocks'
import { bandColor, PALETTE_LABELS, type PaletteName } from '../lib/blockColors'
import { selectBlockLintel } from '../lib/lintels'
import { rasterisePdfPage } from '../lib/pdfRaster'
import { useTheme, type Theme } from '../lib/theme'
import { BRICK_LIBRARY } from '../data/brickLibrary'
import type { BrickType } from '../types/bricks'
import {
  planWall,
  planWallLayout,
  verifyLayoutMatchesTally,
  cornerOwnershipFor,
  outerEdgeEndpoints,
  buildCourses,
  calculateCourseStack,
  type WallLayout,
} from '../lib/blockCalc'
import {
  FALLBACK_HEIGHT_MM,
  DEFAULT_WALL_COLOR,
  MORTAR_GAP_M,
  MORTAR_COLOR,
  MORTAR_THICKNESS_FRAC,
  resolveWallCourses,
  isHighlightedBlock,
  segmentsForStraightWall,
  adjustOpeningForRender,
  type ResolvedCourse,
  type WallSegmentBox,
} from '../lib/wallSegments'

// ---------- Constants ----------

// Scene background pair — flips with the app theme. Dark mode is the
// original "Studio Black" slate (#1a1d24); light mode is the warm
// off-white that the rest of the app uses for the page surface
// (--color-ink-900 in :root.light). Ground plane / fog / canvas
// clearColor / PDF page-bg-erase all read from the same pair so the
// horizon stays seamless in either theme.
// Scene bg matches the page bg EXACTLY in each theme — read straight
// off the ink-900 CSS variable values used by the rest of the app
// (see :root / :root.light in index.css). Without this match, the 3D
// canvas leaves a visible navy rectangle in dark mode and a cream
// rectangle in light mode that breaks the page's two-tone surface.
const SCENE_BG_DARK = '#18181c'   // matches dark-mode --color-ink-900
const SCENE_BG_LIGHT = '#f6f4ee'  // matches light-mode --color-ink-900
function sceneBgFor(theme: Theme): string {
  return theme === 'light' ? SCENE_BG_LIGHT : SCENE_BG_DARK
}
function sceneBgRgbFor(theme: Theme): [number, number, number] {
  // Must match sceneBgFor — the PDF threshold pass writes this rgb on
  // every "page background" pixel so the page sheet visually disappears
  // into the scene clearColor. Keep in sync if SCENE_BG_* changes.
  return theme === 'light' ? [246, 244, 238] : [24, 24, 28]
}
// Plan-line ink — drawn lines on the rasterised PDF after the threshold
// pass. Dark theme: pure white over near-black. Light theme: near-black
// over the clean light-gray page bg. Stays inverted between themes so
// the plan reads as a blueprint either way.
function planLineRgbFor(theme: Theme): [number, number, number] {
  return theme === 'light' ? [9, 9, 11] : [255, 255, 255]
}
const GROUND_COLOR_DARK = SCENE_BG_DARK
const GROUND_COLOR_LIGHT = SCENE_BG_LIGHT
function groundColorFor(theme: Theme): string {
  return theme === 'light' ? GROUND_COLOR_LIGHT : GROUND_COLOR_DARK
}

// ---------- Props ----------

export interface WorkspaceView3DProps {
  walls: Wall[]
  openings: Opening[]
  makeupsById: Record<string, WallMakeup>
  brickMakeupsById: Record<string, BrickMakeup>
  wallThicknessByWallId: Record<string, number>
  areas: ProjectArea[]
  library: Record<string, Block>
  /**
   * Piers placed on the active page — both tied (on a wall) and
   * freestanding. Stacked as columns of boxes per coursePattern,
   * coloured per pierColorByPierId. Default-empty so callers that
   * predate pier rendering still work.
   */
  piers?: Pier[]
  pierMakeupsById?: Record<string, PierMakeup>
  /**
   * Pre-resolved fill colour per pier id — set upstream from the
   * shared wall+pier palette (masonryTypeColor). Missing → falls
   * back to the brand orange so legacy callers still render.
   */
  pierColorByPierId?: Record<string, string>
  /**
   * Optional plan-as-floor texture inputs. When all four are present, the
   * 3D scene replaces its dark ground plane with the current PDF page
   * rendered as a black-and-white floor sized to its real-world footprint
   * (pageWidthMm × pageScaleRatio), so every wall sits directly on its
   * 2D-drawn position. Missing any one → fall back to the dark ground
   * plane (no behaviour change for callers that don't pass these).
   */
  pdfFile?: File | null
  currentPageNumber?: number
  pageWidthMm?: number
  pageHeightMm?: number
  pageScaleRatio?: number
  /**
   * The id of the currently-open project. Used to namespace the 3D
   * snapshot queue in localStorage so captures from one project don't
   * leak into another. When null/undefined the snapshots fall under a
   * "no-project" bucket (legacy / draft mode).
   */
  projectId?: string | null
  /**
   * The currently-active trade ('block' vs 'brick'). The walls array
   * passed in is already filtered to this trade by PdfWorkspace, but
   * the 3D view uses this to tag captured snapshots and to namespace
   * the snapshot queue per trade — so a block-mode capture doesn't
   * appear in the brick-mode queue and vice versa. Undefined falls
   * back to a shared bucket for legacy compatibility.
   */
  mode?: 'block' | 'brick'
  /**
   * Snapshot queue — lifted to PdfWorkspace so captures persist on
   * the SavedProject and can't leak across projects. The 3D view
   * becomes a controlled component for snapshots: it READS this
   * list to render the right-side queue panel and CALLS
   * onSnapshotsChange to push captures + deletions back up.
   */
  snapshots?: Array<{
    id: string
    dataUrl: string
    createdAt: number
    pageNumber?: number
    trade?: 'block' | 'brick'
    legend?: Array<{ code: string; label: string; color: string }>
  }>
  onSnapshotsChange?: (
    next: Array<{
      id: string
      dataUrl: string
      createdAt: number
      pageNumber?: number
      trade?: 'block' | 'brick'
      legend?: Array<{ code: string; label: string; color: string }>
    }>
  ) => void
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



/**
 * Trapezoidal prism — the shape of a single masonry unit cut to follow
 * a curved wall. In real-world curved masonry, the bricklayer cuts the
 * REAR of each block on an angle so its front face stays full block
 * width and the two side faces meet the neighbouring blocks along
 * radial lines. The result is a block that's wider on the convex
 * (outer) face than on the concave (inner / rear) face.
 *
 * The four ground-plane corners are stored explicitly so the renderer
 * can build a custom BufferGeometry with the exact trapezoid footprint
 * extruded up by (y1 − y0). Corners are listed in the order:
 *   outerStart → outerEnd → innerEnd → innerStart
 * — i.e. CCW when viewed from above, with `outer*` on the convex side
 * of the arc (away from the arc centre) and `inner*` on the concave
 * side (the "cut at the rear" side).
 */
interface WallSegmentWedge {
  outerStart: { x: number; z: number }
  outerEnd: { x: number; z: number }
  innerEnd: { x: number; z: number }
  innerStart: { x: number; z: number }
  y0: number
  y1: number
  color: string
  highlight: boolean
}


/**
 * Convert a tally-aligned `WallLayout` (from `lib/blockCalc`) into 3D
 * sub-boxes. Each PositionedBlock becomes exactly one box, sized at
 * the block's library face width × course face height, positioned in
 * wall-local s/y coordinates and transformed to world space.
 *
 * This path GUARANTEES the user sees exactly what the export tally
 * counts — same code paths produce the layout for both renderer and
 * tally aggregation. Used for non-curved walls without openings;
 * curves and openings fall back to the legacy `segmentsForStraightWall`
 * until `planWallLayout` learns to emit jambs / lintels / curve
 * samples.
 */
function segmentsFromWallLayout(
  wall: Wall,
  layout: WallLayout,
  thicknessMm: number,
  colorMap: Map<string, string>,
  library: Record<string, Block>,
  wallsById: Record<string, Wall>,
  wallThicknessByWallId: Record<string, number>,
  /**
   * Optional makeup — used to surface the cap tile (if any). The
   * planWallLayout path doesn't carry caps in its block list (caps are
   * additive on top of the structural courses), so we emit the cap
   * strip here instead. Omitted on legacy call sites that pre-date
   * caps; pass the makeup when you want caps rendered.
   */
  makeup?: WallMakeup,
  /**
   * Optional per-wall resolved courses map. When provided, end-face
   * positioning at corners is computed per-course from the partner
   * wall's actual block depth at this course's Y — supporting mixed-
   * series partners where upper courses are narrower than the base.
   * Without this map, falls back to wall-level (max) thickness so the
   * end face sits at the partner's wall-level outer face.
   */
  wallCoursesById?: Record<string, ResolvedCourse[]>
): WallSegmentBox[] {
  // The data endpoints `wall.startX/Y, wall.endX/Y` represent CENTRELINE
  // positions and at corners they sit halfThickness inside the outer
  // building corner (the drawing layer snaps new walls' endpoints to
  // the centre of the existing wall's last block). The layout's
  // block positions go from 0 to `wallLengthMm`, which is the
  // OUTER-EDGE length — so the 3D wall must also span the outer
  // edge to fit those positions. Otherwise blocks at s > centreline-
  // length would render past the wall's data endpoint into thin air
  // (and two walls at a corner would not visually meet at the
  // outer corner — the 95mm offset the user reported).
  //
  // `outerEdgeEndpoints` runs the same overlap math as wallLengthMm
  // but returns adjusted start/end positions instead of a scalar.
  const ext = outerEdgeEndpoints(wall, wallThicknessByWallId, wallsById)
  const sx = -ext.startX / 1000
  const sz = -ext.startY / 1000
  const ex = -ext.endX / 1000
  const ez = -ext.endY / 1000
  const dx = ex - sx
  const dz = ez - sz
  const wallLenM = Math.hypot(dx, dz)
  if (wallLenM === 0 || layout.blocks.length === 0) return []
  const yRotation = Math.atan2(-dz, dx)
  const thickness = thicknessMm / 1000
  const dirX = dx / wallLenM
  const dirZ = dz / wallLenM

  // Note: outerEdgeEndpoints (above) already shifted the wall's
  // start/end to the outer-corner positions. wallLenM is the chord
  // between those adjusted endpoints, matching what wallLengthMm
  // returns. No further per-junction adjustment is needed here —
  // doing so would double-count the extension and the corner blocks
  // would protrude past the corner cube by halfThickness.

  // Mortar joint visualisation: each box is inset slightly on edges
  // that face a neighbour, so adjacent blocks read as discrete units.
  // Outer wall edges and the wall base / top are flush (no inset)
  // for clean corners.
  const halfGap = MORTAR_GAP_M / 2
  const totalHeightM = layout.heightMm / 1000

  // Control-joint sealant gap — when this wall has a 'control-joint'
  // junction at either end, pull the rendered geometry back from
  // that end by SEALANT_GAP_M so the two halves of a split show a
  // visible vertical seam between them. Tally is unchanged; only
  // the visible box shrinks. ~6mm each side gives a ~12mm visible
  // gap between the two halves, matching real-world sealant joints.
  const SEALANT_GAP_M = 0.02
  const startSealantInset =
    wall.startJunction.type === 'control-joint' ? SEALANT_GAP_M : 0
  const endSealantInset =
    wall.endJunction.type === 'control-joint' ? SEALANT_GAP_M : 0
  const effectiveStartM = startSealantInset
  const effectiveEndM = wallLenM - endSealantInset

  const boxes: WallSegmentBox[] = []
  const colorOf = (code: BlockCode) =>
    colorMap.get(code) ?? DEFAULT_WALL_COLOR

  // ── Per-course outer-face shifts at corner ends ──
  // `wallLenM` was extended via outerEdgeEndpoints using the partner
  // wall's WALL-LEVEL (max) thickness so the chord reaches the outer
  // building corner of the widest partner course. For a mixed-series
  // partner the actual outer face on any thinner course is closer in
  // by (partnerWallLevelHalf − partnerActualHalfAtY); clamp the per-
  // course render extent to land each course's end on the partner's
  // real face at that Y. For uniform partners both shifts are 0.
  const leftCornerNeighbor =
    wall.startJunction.type === 'corner'
      ? wall.startJunction.connectedWallIds?.[0]
      : undefined
  const rightCornerNeighbor =
    wall.endJunction.type === 'corner'
      ? wall.endJunction.connectedWallIds?.[0]
      : undefined
  const partnerHalfAtYM = (
    partnerId: string | undefined,
    yMidM: number
  ): number => {
    if (partnerId === undefined) return 0
    const partnerCourses = wallCoursesById?.[partnerId]
    if (partnerCourses) {
      for (const pc of partnerCourses) {
        if (yMidM >= pc.y0 - 0.001 && yMidM <= pc.y1 + 0.001) {
          const d = library[pc.bodyCode]?.dimensions.depthMm
          if (typeof d === 'number') return d / 2 / 1000
          break
        }
      }
    }
    return (
      (wallThicknessByWallId[partnerId] ?? thicknessMm) / 2 / 1000
    )
  }
  const leftWallLevelHalfM =
    leftCornerNeighbor !== undefined
      ? (wallThicknessByWallId[leftCornerNeighbor] ?? thicknessMm) /
        2 /
        1000
      : 0
  const rightWallLevelHalfM =
    rightCornerNeighbor !== undefined
      ? (wallThicknessByWallId[rightCornerNeighbor] ?? thicknessMm) /
        2 /
        1000
      : 0
  const courseShiftCache = new Map<number, { left: number; right: number }>()
  const shiftsForCourse = (
    yBottomM: number,
    yTopM: number
  ): { left: number; right: number } => {
    const yMid = (yBottomM + yTopM) / 2
    const key = Math.round(yMid * 1000)
    const cached = courseShiftCache.get(key)
    if (cached) return cached
    const left =
      leftCornerNeighbor !== undefined
        ? Math.max(
            0,
            leftWallLevelHalfM - partnerHalfAtYM(leftCornerNeighbor, yMid)
          )
        : 0
    const right =
      rightCornerNeighbor !== undefined
        ? Math.max(
            0,
            rightWallLevelHalfM - partnerHalfAtYM(rightCornerNeighbor, yMid)
          )
        : 0
    const result = { left, right }
    courseShiftCache.set(key, result)
    return result
  }
  // Per-course translate-and-trim. Group blocks by course, then per
  // course: translate any block whose outer edge touches the wall start
  // (s=0) inward by `leftCornerShift`, and any whose outer edge touches
  // the wall end (s=wallLenM) inward by `rightCornerShift`. After
  // translation the body block adjacent to a shifted end overlaps the
  // shifted end's new position — resolve by trimming the body block's
  // start to meet the shifted end. This preserves the corner block's
  // natural width (e.g. 200-series corner stays at 390mm) while
  // landing its outer face on the partner's actual face at this Y.
  // For courses with uniform-thickness partners both shifts are 0 and
  // the per-course pass is a no-op.
  interface WorkBlock {
    block: typeof layout.blocks[number]
    s0: number
    s1: number
  }
  const blocksByCourse: Map<number, WorkBlock[]> = new Map()
  for (const block of layout.blocks) {
    if (block.role === 'paired-tile') continue
    const work: WorkBlock = {
      block,
      s0: block.s0Mm / 1000,
      s1: (block.s0Mm + block.widthMm) / 1000,
    }
    const list = blocksByCourse.get(block.courseIdx)
    if (list) list.push(work)
    else blocksByCourse.set(block.courseIdx, [work])
  }

  const MORTAR_M = DEFAULT_MORTAR_JOINT_MM / 1000
  for (const [courseIdx, courseBlocks] of blocksByCourse) {
    const course = layout.courses[courseIdx]
    if (!course) continue
    const y0 = course.yBottomMm / 1000
    const y1 = (course.yBottomMm + course.heightMm) / 1000
    const courseShifts = shiftsForCourse(y0, y1)

    courseBlocks.sort((a, b) => a.s0 - b.s0)

    // Determine whether this course needs a per-course refit. Refit is
    // required when EITHER (a) a corner shift applies on this course
    // (partner is thinner than wall-level at this Y) OR (b) the START
    // / END is a non-owning cube whose width was sized to wall-level
    // partner thickness but the partner is actually thinner here.
    const yMid = (y0 + y1) / 2
    const startBlock = courseBlocks[0]
    const endBlock = courseBlocks[courseBlocks.length - 1]
    const startTouchesStart =
      startBlock !== undefined && startBlock.s0 < 0.001
    const endTouchesEnd =
      endBlock !== undefined && endBlock.s1 > wallLenM - 0.001
    const startIsRenderOnly =
      startTouchesStart && startBlock.block.renderOnly === true
    const endIsRenderOnly =
      endTouchesEnd && endBlock.block.renderOnly === true

    // Per-course actual partner depth at this Y (full block depth, m).
    const partnerStartActualM =
      leftCornerNeighbor !== undefined
        ? partnerHalfAtYM(leftCornerNeighbor, yMid) * 2
        : 0
    const partnerEndActualM =
      rightCornerNeighbor !== undefined
        ? partnerHalfAtYM(rightCornerNeighbor, yMid) * 2
        : 0
    // Wall-level partner depth used by planWallLayout for cube width.
    const wallLevelStartCubeM =
      leftCornerNeighbor !== undefined
        ? (wallThicknessByWallId[leftCornerNeighbor] ?? thicknessMm) / 1000
        : 0
    const wallLevelEndCubeM =
      rightCornerNeighbor !== undefined
        ? (wallThicknessByWallId[rightCornerNeighbor] ?? thicknessMm) / 1000
        : 0
    // Whether the cube on each side needs a per-course resize.
    const needStartCubeResize =
      startIsRenderOnly &&
      Math.abs(partnerStartActualM - wallLevelStartCubeM) > 0.001
    const needEndCubeResize =
      endIsRenderOnly &&
      Math.abs(partnerEndActualM - wallLevelEndCubeM) > 0.001
    const needsRefit =
      courseShifts.left > 0.001 ||
      courseShifts.right > 0.001 ||
      needStartCubeResize ||
      needEndCubeResize

    if (needsRefit && startTouchesStart && endTouchesEnd) {
      // ── Per-course rebuild ───────────────────────────────────────
      // Compute the new start and end block widths based on what the
      // partner actually is at this Y (rather than wall-level max).
      // Owning corner blocks keep their natural width — only render-only
      // cube fillers get resized. Then position the start at leftShift,
      // the end so its outer face lands at (wallLenM − rightShift), and
      // refit the body cells between them. This is the only way to keep
      // the stretcher bond stagger at the correct 200 mm: planWallLayout
      // anchors the body grid off wall-level cube depth, so any course
      // where the actual cube is thinner ends up one half-block out of
      // phase with the owning courses below / above.
      const startWidthOriginalM = startBlock.s1 - startBlock.s0
      const endWidthOriginalM = endBlock.s1 - endBlock.s0
      const startWidthNewM = needStartCubeResize
        ? partnerStartActualM
        : startWidthOriginalM
      const endWidthNewM = needEndCubeResize
        ? partnerEndActualM
        : endWidthOriginalM

      // New positions for the start and end blocks (preserving the
      // block's natural width when owning; resizing to per-course
      // cube when non-owning).
      const startS0 = courseShifts.left
      const startS1 = startS0 + startWidthNewM
      const endS1 = wallLenM - courseShifts.right
      const endS0 = endS1 - endWidthNewM

      startBlock.s0 = startS0
      startBlock.s1 = startS1
      endBlock.s0 = endS0
      endBlock.s1 = endS1

      // Refit body / fraction / lead-in blocks into the new body
      // region. The body region is (startS1 + mortar, endS0 − mortar).
      // Each non-edge block keeps its original library width but its
      // position is recomputed so the grid runs contiguously from the
      // start cube/corner's inner face. This preserves block widths
      // (so the tally still reads correctly) but shifts the grid into
      // the correct stretcher phase for this course.
      const bodyRegionStart = startS1 + MORTAR_M
      const bodyRegionEnd = endS0 - MORTAR_M

      // Pass 1 — sum natural widths to know how much body region the
      // unmodified layout would consume. The DIFFERENCE between
      // bodyRegionEnd − bodyRegionStart and (sumNatural + mortar
      // joints) is the gap that the per-course refit needs to absorb.
      // On mixed-series corners (cube resized from wall-level 290 to
      // per-course 190) this gap is typically ~100mm per resized end —
      // up to ~200mm when both ends are non-owning corners.
      let sumNatural = 0
      let bodyCount = 0
      for (let i = 1; i < courseBlocks.length - 1; i++) {
        sumNatural += courseBlocks[i].block.widthMm / 1000
        bodyCount++
      }
      const expectedSpan =
        bodyCount > 0 ? sumNatural + (bodyCount - 1) * MORTAR_M : 0
      const actualSpan = Math.max(0, bodyRegionEnd - bodyRegionStart)
      const gap = actualSpan - expectedSpan

      // Pass 2 — lay blocks contiguously. Each body block widens by
      // `gap / bodyCount` so the gap is absorbed uniformly across the
      // grid. Real masons cut blocks here too — but cutting many small
      // pieces vs one big stretch reads as cleaner and keeps no single
      // block ballooning to 500-600 mm.
      //
      // For negative gap (per-course region SMALLER than natural, e.g.
      // shift INWARD without a cube resize), per-block delta is
      // negative — each body block trims slightly. Same uniform-spread
      // logic applies.
      const perBlockDelta = bodyCount > 0 ? gap / bodyCount : 0
      let cursor = bodyRegionStart
      let lastPlacedIdx = -1
      for (let i = 1; i < courseBlocks.length - 1; i++) {
        const w = courseBlocks[i]
        const naturalWidthM = w.block.widthMm / 1000
        const adjustedWidthM = Math.max(0, naturalWidthM + perBlockDelta)
        const room = bodyRegionEnd - cursor
        if (room < 0.02) {
          w.s0 = bodyRegionEnd
          w.s1 = bodyRegionEnd
          continue
        }
        const w_M = Math.min(adjustedWidthM, room)
        w.s0 = cursor
        w.s1 = cursor + w_M
        cursor += w_M + MORTAR_M
        lastPlacedIdx = i
      }
      // Belt-and-braces: if rounding error leaves a sub-mortar gap
      // between the last body and the end block, nudge the last
      // block's s1 out to close it. Always a few mm, never the 100+mm
      // balloon the previous rule produced.
      if (lastPlacedIdx >= 0) {
        const last = courseBlocks[lastPlacedIdx]
        if (bodyRegionEnd - last.s1 > 0.02 && bodyRegionEnd - last.s1 < 0.05) {
          last.s1 = bodyRegionEnd
        }
      }
    } else if (courseShifts.left > 0.001 || courseShifts.right > 0.001) {
      // Single-side shift with no cube resize needed (uniform partner
      // thickness). Translate edge-touching blocks preserving width
      // and trim adjacent overlaps — original behaviour.
      if (courseShifts.left > 0.001) {
        for (const w of courseBlocks) {
          if (w.s0 < 0.001) {
            w.s0 += courseShifts.left
            w.s1 += courseShifts.left
          }
        }
      }
      if (courseShifts.right > 0.001) {
        for (const w of courseBlocks) {
          if (w.s1 > wallLenM - 0.001) {
            w.s0 -= courseShifts.right
            w.s1 -= courseShifts.right
          }
        }
      }
      courseBlocks.sort((a, b) => a.s0 - b.s0)
      for (let i = 0; i < courseBlocks.length - 1; i++) {
        if (courseBlocks[i].s1 > courseBlocks[i + 1].s0 + 0.001) {
          courseBlocks[i + 1].s0 = courseBlocks[i].s1
        }
      }
    }

    // Emit each block in this course.
    for (const w of courseBlocks) {
      const s0 = w.s0
      const s1 = w.s1
      // Clamp to wall envelope (control-joint sealant gap). Per-course
      // corner shifts are already baked into s0/s1 above.
      const cs0 = Math.max(effectiveStartM, Math.min(effectiveEndM, s0))
      const cs1 = Math.max(effectiveStartM, Math.min(effectiveEndM, s1))
      if (cs1 - cs0 < 0.02) continue

      // Mortar-style inset on edges that face a neighbour. Edges
      // touching the wall envelope (true outer edges OR a control-
      // joint sealant boundary) stay flush — at those edges, the
      // existing wall-end gap / sealant gap IS the visible joint.
      // 0.5mm inset on envelope edges so no face is ever exactly
      // coplanar with a neighbouring wall's geometry (see buildBox in
      // wallSegments.ts for the rationale).
      const COPLANAR_EPS_M = 0.0005
      const leftInset =
        cs0 < effectiveStartM + 0.001 ? COPLANAR_EPS_M : halfGap
      const rightInset =
        cs1 > effectiveEndM - 0.001 ? COPLANAR_EPS_M : halfGap
      const bottomInset = y0 < 0.001 ? 0 : halfGap
      const topInset = y1 > totalHeightM - 0.001 ? COPLANAR_EPS_M : halfGap

      const aS0 = cs0 + leftInset
      const aS1 = cs1 - rightInset
      const aY0 = y0 + bottomInset
      const aY1 = y1 - topInset
      if (aS1 - aS0 < 0.001 || aY1 - aY0 < 0.001) continue

      const localCx = (aS0 + aS1) / 2
      // Per-block thickness — each block renders at its own library
      // depth, centered on the wall centerline (cx/cz unchanged). A
      // 200-series course on top of a 300-series base shows the
      // expected 50mm step on each face at the boundary.
      const perBlockDepthMm = library[w.block.code]?.dimensions.depthMm
      const perBlockThickness =
        (perBlockDepthMm !== undefined ? perBlockDepthMm / 1000 : thickness) -
        COPLANAR_EPS_M * 2
      // Render-only cube fillers occupy the SAME volume as the owning
      // perpendicular wall's corner block. With identical colours that
      // coincidence is invisible, but where the codes differ (jogs,
      // mixed makeups) the coplanar faces z-fight as a shimmer. Recess
      // the filler a touch so the owner's block always wins cleanly.
      const RENDER_ONLY_RECESS_M = 0.003
      const recess = w.block.renderOnly === true ? RENDER_ONLY_RECESS_M : 0
      boxes.push({
        cx: sx + dirX * localCx,
        cy: (aY0 + aY1) / 2 - (recess > 0 && aY1 > totalHeightM - 0.001 ? recess / 2 : 0),
        cz: sz + dirZ * localCx,
        length: Math.max(0.01, aS1 - aS0 - recess * 2),
        heightM: Math.max(0.01, aY1 - aY0 - (aY1 > totalHeightM - 0.001 ? recess : 0)),
        thickness: Math.max(0.01, perBlockThickness - recess * 2),
        yRotation,
        color: colorOf(w.block.code),
        highlight: isHighlightedBlock(w.block.code, library),
      })
    }
  }

  // Optional cap strip — one segment running the full wall length at
  // the cap block's modular height, sitting on TOP of the wall's
  // structural courses. Mirrors the cap course resolveWallCourses adds
  // for the legacy renderer; planWallLayout's block list doesn't
  // carry caps (the cap is an additive top layer, not part of the
  // structural fit), so we emit it explicitly here.
  if (makeup?.capBlockCode) {
    const capCode = makeup.capBlockCode
    const capBlock = library[capCode]
    const capModuleMm = capBlock
      ? capBlock.dimensions.heightMm + DEFAULT_MORTAR_JOINT_MM
      : 50 // 40mm tile + 10mm joint fallback
    const capHeightM = capModuleMm / 1000
    // Corner de-overlap: both walls' cap strips used to span the full
    // outer-edge length, double-covering the shared corner volume and
    // z-fighting there. Exactly ONE wall's cap now covers each corner:
    // the id-sorted lead keeps its full span, the other pulls back by
    // the partner's thickness. T-junction/free ends are untouched.
    let capStart = 0
    let capEnd = wallLenM
    for (const end of ['start', 'end'] as const) {
      const junction = end === 'start' ? wall.startJunction : wall.endJunction
      if (junction.type !== 'corner') continue
      const partnerId = junction.connectedWallIds?.[0]
      if (partnerId === undefined || wall.id < partnerId) continue
      const partnerT =
        (wallThicknessByWallId[partnerId] ?? thicknessMm) / 1000
      if (end === 'start') capStart += partnerT
      else capEnd -= partnerT
    }
    if (capEnd - capStart > 0.02) {
      const localCx = (capStart + capEnd) / 2
      boxes.push({
        cx: sx + dirX * localCx,
        cy: totalHeightM + capHeightM / 2,
        cz: sz + dirZ * localCx,
        length: capEnd - capStart - 0.001,
        heightM: capHeightM - 0.001,
        thickness: thickness - 0.001,
        yRotation,
        color: colorOf(capCode),
        highlight: isHighlightedBlock(capCode, library),
      })
    }
  }

  return boxes
}



/**
 * Curved-wall renderer. Produces the SAME bond / block layout as a
 * straight wall (corners, halves on even stretcher courses, body
 * blocks at their library widths), then bends each block into a
 * trapezoidal wedge along the arc — matching how a bricklayer cuts the
 * REAR of each block to follow a curve while keeping the visible front
 * face at full block width.
 *
 * Two-pass approach:
 *   1. Build a virtual STRAIGHT wall with length = arc length on the
 *      OUTER (convex) face. We measure on the outer face because that
 *      face stays at full block width in real masonry — the inner
 *      (rear) face is where the angled cut shortens each block, so
 *      laying out by outer arc length is what makes the visible front
 *      look correct.
 *   2. Run the straight-wall pipeline on that virtual wall (no
 *      openings, no junctions — v1 limitation). Take every emitted
 *      WallSegmentBox, back-compute its (s0, s1) along the virtual
 *      wall from its centre + length, map those parameters to arc
 *      angles, and produce a WallSegmentWedge with the four
 *      ground-plane corners on the arc's outer / inner radii.
 *
 * Junctions are forced to 'free' on the virtual wall so corner
 * ownership doesn't fire — curved walls don't currently participate
 * in shared-corner block ownership with neighbours. Same for
 * openings — curved walls can't host doors / windows in v1.
 */
function segmentsForCurvedWall(
  wall: Wall,
  thicknessMm: number,
  courses: ResolvedCourse[],
  totalHeightM: number,
  bondType: 'stretcher' | 'stack',
  colorMap: Map<string, string>,
  library: Record<string, Block>,
  wallThicknessByWallId: Record<string, number>
): WallSegmentWedge[] {
  if (wall.midX === undefined || wall.midY === undefined) return []
  const geom = arcFromThreePoints(
    { x: wall.startX, y: wall.startY },
    { x: wall.midX, y: wall.midY },
    { x: wall.endX, y: wall.endY }
  )
  if (!geom) return []

  const centreX_mm = geom.centerX
  const centreY_mm = geom.centerY
  const R_mm = geom.radiusMm
  const t_mm = thicknessMm
  const outerR_mm = R_mm + t_mm / 2
  const innerR_mm = R_mm - t_mm / 2

  // OUTER arc length drives the virtual straight wall's length — this
  // is the line the visible front face follows, so blocks laid out at
  // their natural library widths fill the outer face exactly.
  const outerArcLenM = (outerR_mm / 1000) * Math.abs(geom.sweepAngle)
  if (outerArcLenM < 0.05) return []

  // Virtual straight wall — same id (so per-wall lookups still work)
  // but free junctions so corner-ownership phases don't run, and no
  // mid* fields so isCurvedWall returns false inside the recursive
  // call.
  const virtualWall: Wall = {
    ...wall,
    startX: 0,
    startY: 0,
    endX: outerArcLenM * 1000,
    endY: 0,
    startJunction: { type: 'free' },
    endJunction: { type: 'free' },
    kind: 'straight',
    midX: undefined,
    midY: undefined,
  }

  const boxes = segmentsForStraightWall(
    virtualWall, [], thicknessMm, courses, totalHeightM,
    bondType, colorMap, library, wallThicknessByWallId
  )

  // The virtual wall goes from (planX=0, planY=0) to
  // (planX=outerArcLenM*1000, planY=0). After segmentsForStraightWall's
  // X / Y negation:
  //   sx = 0,  sz = 0
  //   ex = -outerArcLenM,  ez = 0
  //   dirX = -1, dirZ = 0
  // So a box at centre (cx, cz=0) sits at local-s = -cx along the
  // virtual wall (m from the start), and extends ±length/2 around
  // that.
  //
  // Winding normalisation: the wedge renderer expects the four corners
  // (outerStart, outerEnd, innerEnd, innerStart) to trace a CCW loop
  // viewed from above, so its hardcoded triangle indices give outward-
  // facing normals (three.js FrontSide). For CCW sweeps (sweepAngle
  // > 0) the natural (theta0=start, theta1=end) labelling already
  // gives CCW corners. For CW sweeps we swap start/end so the corner
  // ordering stays CCW for the renderer — the spatial positions are
  // identical, only the labels move.
  const isCW = geom.sweepAngle < 0
  const wedges: WallSegmentWedge[] = []
  for (const box of boxes) {
    const localCentre = -box.cx
    const localS0 = Math.max(0, localCentre - box.length / 2)
    const localS1 = Math.min(outerArcLenM, localCentre + box.length / 2)
    if (localS1 - localS0 < 0.005) continue

    const t0 = localS0 / outerArcLenM
    const t1 = localS1 / outerArcLenM
    const theta0 = geom.startAngle + geom.sweepAngle * t0
    const theta1 = geom.startAngle + geom.sweepAngle * t1

    // Plan → world: 3D X = -planX/1000, 3D Z = -planY/1000 (same
    // negation segmentsForStraightWall uses so the curved wall lines
    // up with adjacent straight walls).
    const toWorld = (radiusMm: number, theta: number) => ({
      x: -(centreX_mm + radiusMm * Math.cos(theta)) / 1000,
      z: -(centreY_mm + radiusMm * Math.sin(theta)) / 1000,
    })

    // Per-block radii — buildBox in segmentsForStraightWall sets
    // box.thickness to the BLOCK's library depth (200 = 0.190, 300 =
    // 0.290), so a mixed-series curved wall gets per-course outer
    // faces stepped correctly. Without using box.thickness here every
    // wedge sat at the wall-LEVEL outer/inner radii, so a 200-on-300
    // curved wall rendered as if all courses were the 300-series
    // depth — the upper 200 courses bulged past their true face. The
    // wall centreline stays at R_mm; outer = R + boxT/2, inner = R −
    // boxT/2. Each course centres on the same centreline as straight
    // walls.
    const boxT_mm = box.thickness * 1000
    const wedgeOuterR_mm = R_mm + boxT_mm / 2
    const wedgeInnerR_mm = R_mm - boxT_mm / 2

    const tA = isCW ? theta1 : theta0
    const tB = isCW ? theta0 : theta1
    wedges.push({
      outerStart: toWorld(wedgeOuterR_mm, tA),
      outerEnd: toWorld(wedgeOuterR_mm, tB),
      innerEnd: toWorld(wedgeInnerR_mm, tB),
      innerStart: toWorld(wedgeInnerR_mm, tA),
      y0: box.cy - box.heightM / 2,
      y1: box.cy + box.heightM / 2,
      color: box.color,
      highlight: box.highlight,
    })
  }

  return wedges
}

/**
 * Curved-wall mortar shell config. Resolved by collectCurvedMortarShell
 * during the segments useMemo, then rendered by CurvedMortarShells as
 * a single smooth BufferGeometry per shell (shared seam vertices →
 * computeVertexNormals smooths across the seams, eliminating the
 * facet bands you get from independent per-micro-wedge meshes).
 */
interface CurvedMortarShell {
  centreXMm: number
  centreYMm: number
  innerRMm: number
  outerRMm: number
  startAngle: number
  sweepAngle: number
  y0: number
  y1: number
}

/**
 * Curved-wall mortar shell. Mirrors emitMortarForWall but produces a
 * smooth curved sweep instead of a single straight box.
 *
 * Each block wedge from segmentsForCurvedWall already has the same
 * MORTAR_GAP_M edge insets the straight-wall builder bakes into
 * buildBox — those insets become tiny angular gaps between adjacent
 * wedges. This shell sits at reduced thickness behind those gaps so
 * the recessed mortar reads as a real joint, exactly the way it
 * does on straight walls.
 *
 * Collected per-wall here and rendered later (one mesh per shell)
 * with shared seam vertices so the curved outer / inner faces shade
 * smoothly along the arc.
 */
function collectCurvedMortarShell(
  wall: Wall,
  thicknessMm: number,
  totalHeightM: number,
  maxBlockWidthMm: number,
  shells: CurvedMortarShell[]
): void {
  if (wall.midX === undefined || wall.midY === undefined) return
  const geom = arcFromThreePoints(
    { x: wall.startX, y: wall.startY },
    { x: wall.midX, y: wall.midY },
    { x: wall.endX, y: wall.endY }
  )
  if (!geom) return

  // Block-sagitta-aware recess: each block's outer face is a FLAT chord
  // spanning angle (blockWidth / outerR). The chord's midpoint dips
  // inward from the true arc by sagitta = outerR * (1 - cos(angle/2)).
  // On tight curves with wide blocks the sagitta can be tens of mm —
  // big enough that a mortar shell at the usual ~12 mm recess pokes
  // OUT in front of the block midpoints, showing up as a dark spot on
  // every block. Recessing the shell by sagitta + the desired visible
  // depth guarantees the shell stays behind the chord at every angle,
  // for any block size, on any radius. On wide curves the sagitta is
  // ~0 and behaviour matches the straight-wall shell.
  const outerArcR_mm = geom.radiusMm + thicknessMm / 2
  const innerArcR_mm = geom.radiusMm - thicknessMm / 2
  const blockAngle = maxBlockWidthMm / outerArcR_mm
  const sagittaMm = outerArcR_mm * (1 - Math.cos(blockAngle / 2))
  const visibleRecessMm = 12
  const totalRecessMm = sagittaMm + visibleRecessMm
  const mortarOuterR_mm = outerArcR_mm - totalRecessMm
  const mortarInnerR_mm = innerArcR_mm + totalRecessMm
  // Degenerate guard — if the recesses collapse the shell to zero or
  // negative thickness (wall too thin for both sides to recess), drop
  // the shell. Visually a wall this proportion (curve so tight relative
  // to thickness that the inner mortar passes the outer) doesn't have
  // a sensible recessed mortar plane anyway — straight walls would be
  // the right choice.
  if (mortarOuterR_mm - mortarInnerR_mm < 2) return

  // Centreline arc length is the right yardstick for the side inset —
  // it matches the envelopeInset metres → arc-length conversion that
  // the straight-wall builder uses on the wall's centreline length.
  const centreArcLenM = (geom.radiusMm / 1000) * Math.abs(geom.sweepAngle)
  const envelopeInsetM = MORTAR_GAP_M
  if (centreArcLenM < envelopeInsetM * 2 + 0.01) return

  const y0 = MORTAR_GAP_M
  const y1 = totalHeightM - MORTAR_GAP_M
  if (y1 - y0 < 0.01) return

  // Pull the angular sweep in slightly at both ends so the shell tucks
  // behind the start / end block faces instead of poking past them
  // (same role as the side envelopeInset on the straight builder).
  const insetFracStart = envelopeInsetM / centreArcLenM
  const insetFracEnd = 1 - insetFracStart
  const startAngle = geom.startAngle + geom.sweepAngle * insetFracStart
  const endAngle = geom.startAngle + geom.sweepAngle * insetFracEnd
  const sweepAngle = endAngle - startAngle

  shells.push({
    centreXMm: geom.centerX,
    centreYMm: geom.centerY,
    innerRMm: mortarInnerR_mm,
    outerRMm: mortarOuterR_mm,
    startAngle,
    sweepAngle,
    y0,
    y1,
  })
}

// ---------- Initial camera aim ----------

/**
 * Aims the camera at the given world point ONCE on mount. Without
 * an OrbitControls target to set lookAt implicitly, the camera
 * defaults to facing world origin instead of the building. Runs
 * BEFORE FirstPersonControls mounts so the controls' yaw/pitch
 * seed picks up this orientation.
 */
function InitialCameraAim({
  targetX,
  targetZ,
}: {
  targetX: number
  targetZ: number
}) {
  const camera = useThree((s) => s.camera)
  const invalidate = useThree((s) => s.invalidate)
  const aimedRef = useRef(false)
  useEffect(() => {
    if (aimedRef.current) return
    aimedRef.current = true
    camera.lookAt(targetX, 1, targetZ)
    invalidate()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return null
}

/**
 * Render all wall sub-boxes as a small set of InstancedMeshes — one
 * per (colour, highlight) group — instead of one <mesh> per box.
 * Cuts thousands of draw calls + React reconciliations down to a
 * handful, keeping interactive orbit / pan / zoom fluid even on
 * brick projects with tens of thousands of unit-sized bricks.
 *
 * Per-instance scale is baked into the matrix so every group can
 * share a single unit BoxGeometry (1×1×1) and still render each
 * box at its own length × heightM × thickness. Position and Y
 * rotation are baked in the same matrix.
 *
 * Materials are NOT shared between groups — each instanced mesh
 * carries its own meshStandardMaterial so colours stay distinct
 * and three.js can dispose them cleanly when the segments change.
 */
function InstancedSegments({
  segments,
}: {
  segments: WallSegmentBox[]
}) {
  // Group segments by (colour + highlight flag) so each group can be
  // a single InstancedMesh sharing one material. Same colour without
  // and with the highlight emissive glow go to separate groups so
  // they don't share a draw call (the materials genuinely differ).
  const groups = useMemo(() => {
    const map = new Map<string, WallSegmentBox[]>()
    for (const s of segments) {
      const key = `${s.color}|${s.highlight ? 1 : 0}`
      const arr = map.get(key)
      if (arr) arr.push(s)
      else map.set(key, [s])
    }
    return Array.from(map.entries()).map(([key, items]) => {
      const [color, hi] = key.split('|')
      return { color, highlight: hi === '1', items }
    })
  }, [segments])

  return (
    <>
      {groups.map((g) => (
        <InstancedSegmentGroup
          key={`${g.color}|${g.highlight ? 1 : 0}`}
          color={g.color}
          highlight={g.highlight}
          items={g.items}
        />
      ))}
    </>
  )
}

function InstancedSegmentGroup({
  color,
  highlight,
  items,
}: {
  color: string
  highlight: boolean
  items: WallSegmentBox[]
}) {
  const meshRef = useRef<THREE.InstancedMesh>(null)
  useEffect(() => {
    const mesh = meshRef.current
    if (!mesh) return
    const matrix = new THREE.Matrix4()
    const position = new THREE.Vector3()
    const quaternion = new THREE.Quaternion()
    const scale = new THREE.Vector3()
    const euler = new THREE.Euler()
    for (let i = 0; i < items.length; i++) {
      const s = items[i]
      position.set(s.cx, s.cy, s.cz)
      euler.set(0, s.yRotation, 0)
      quaternion.setFromEuler(euler)
      scale.set(s.length, s.heightM, s.thickness)
      matrix.compose(position, quaternion, scale)
      mesh.setMatrixAt(i, matrix)
    }
    mesh.instanceMatrix.needsUpdate = true
    mesh.computeBoundingSphere()
  }, [items])

  // args: [geometry, material, count] — passing nulls lets r3f wire
  // in the <boxGeometry> + <meshStandardMaterial> children below.
  return (
    <instancedMesh
      ref={meshRef}
      args={[undefined as unknown as THREE.BufferGeometry, undefined as unknown as THREE.Material, items.length]}
      frustumCulled={false}
    >
      <boxGeometry args={[1, 1, 1]} />
      {highlight ? (
        <meshLambertMaterial
          color={color}
          emissive={color}
          emissiveIntensity={0.45}
        />
      ) : (
        <meshLambertMaterial color={color} />
      )}
    </instancedMesh>
  )
}

/**
 * Cap mesh for a wall with a `topProfile`. Renders as a solid prism
 * in the wall's body brick colour, sitting on top of the wall body.
 *
 * Triangle gable → 3-vertex top silhouette (left base, peak, right
 * base) extruded by wall thickness, so 6 vertices + 8 triangles (top
 * triangle + 2 sloped side quads + bottom + 2 end caps = 8 tris in
 * fact, but each shared face triangulates to 2).
 *
 * Trapezoid raked → 4-vertex top silhouette (left base, left peak,
 * right peak, right base) extruded by wall thickness, 8 vertices.
 *
 * Stored as a generic silhouette (CCW points in along-X / Y space)
 * + extrusion vectors so a single mesh builder handles both shapes.
 */
interface CapMesh {
  /** Outline points of the cap face in CCW order (along-wall X +
   *  world Y). First and last points sit on the wall body top. */
  silhouette: Array<{ alongM: number; y: number }>
  /** Wall start in world metres (negated-mapping space, matching
   *  segmentsForStraightWall). */
  wallStartWorld: { x: number; z: number }
  /** Unit vector along the wall direction (world space). */
  wdirX: number
  wdirZ: number
  /** Unit vector perpendicular to the wall (across thickness). */
  perpX: number
  perpZ: number
  /** Half the wall thickness in metres — distance to extrude each
   *  silhouette point in ±perp direction. */
  halfThick: number
  color: string
  /** Wall body height in metres — baseline for UV V calculation
   *  (the V coordinate is the height above wall body in courses). */
  wallBodyHeightM: number
  /** Brick width + mortar in metres — the U-axis tile unit so the
   *  brick-pattern texture's vertical mortar joints line up at brick
   *  centres. */
  brickModularWidthM: number
  /** Brick height + mortar in metres — the V-axis tile unit so the
   *  texture's horizontal mortar joints line up at course tops. */
  courseModularHeightM: number
}

/**
 * Procedural brick-pattern texture for the gable cap.
 *
 * Built per (brickColor, mortarColor) pair: brick body painted at
 * the EXACT wall colour, mortar joints painted at the SHARED
 * MORTAR_COLOR (#c4bfb6 — same warm beige the body brickwork uses).
 * No multiply-tint magic; what's painted in the canvas is what
 * shows on the cap. Cap mortar reads identical to body mortar
 * regardless of wall colour.
 *
 * Pattern: one brick wide × two courses tall, with the second course
 * offset by half a brick — produces a proper stretcher bond when the
 * texture tiles via RepeatWrapping.
 *
 * Cheap: one 240×172 canvas per UNIQUE wall colour, generated lazily
 * on first cap render of that colour. Disposed when the colour leaves
 * the project. With ~4 brick wall types per estimate that's 4 tiny
 * textures.
 */
function makeBrickPatternTexture(
  brickColor: string,
  mortarColor: string,
): THREE.CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = 240
  canvas.height = 172
  const ctx = canvas.getContext('2d')
  if (ctx) {
    ctx.fillStyle = brickColor
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.fillStyle = mortarColor
    // Horizontal mortar joints at course boundaries.
    ctx.fillRect(0, 0, canvas.width, 4)
    ctx.fillRect(0, 84, canvas.width, 4)
    ctx.fillRect(0, 168, canvas.width, 4)
    // Vertical mortar joints — course 1 (top, y ∈ [4, 84]) joints
    // at the texture's edges (x = 0 / 240); course 2 (bottom,
    // y ∈ [88, 168]) joints offset by half a brick at x = 120.
    ctx.fillRect(0, 4, 4, 80)
    ctx.fillRect(236, 4, 4, 80)
    ctx.fillRect(118, 88, 4, 80)
  }
  const tex = new THREE.CanvasTexture(canvas)
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.RepeatWrapping
  tex.magFilter = THREE.NearestFilter
  tex.minFilter = THREE.NearestFilter
  tex.needsUpdate = true
  return tex
}

/**
 * Renders every wall cap mesh as one merged BufferGeometry per
 * colour. Same batching pattern as WedgeSegments — each cap can
 * have a different silhouette but they share the wall-type colour
 * within a project, so one draw call per palette slot covers it.
 */
function CapMeshes({ meshes }: { meshes: CapMesh[] }) {
  const groups = useMemo(() => {
    const map = new Map<string, CapMesh[]>()
    for (const m of meshes) {
      const arr = map.get(m.color)
      if (arr) arr.push(m)
      else map.set(m.color, [m])
    }
    return Array.from(map.entries()).map(([color, items]) => ({ color, items }))
  }, [meshes])

  return (
    <>
      {groups.map((g) => (
        <CapMeshGroupMesh key={g.color} color={g.color} items={g.items} />
      ))}
    </>
  )
}

function CapMeshGroupMesh({
  color,
  items,
}: {
  color: string
  items: CapMesh[]
}) {
  const geometry = useMemo(() => {
    const positions: number[] = []
    const uvs: number[] = []
    const indices: number[] = []
    for (const m of items) {
      const n = m.silhouette.length
      if (n < 3) continue
      const baseIdx = positions.length / 3
      // Emit FRONT face vertices (at -perp), then BACK face (at
      // +perp). Front comes first so index 0..n-1 = front,
      // n..2n-1 = back at the SAME silhouette index.
      const startBack = baseIdx + n
      const uvFor = (pt: { alongM: number; y: number }) => {
        const u = pt.alongM / m.brickModularWidthM
        const v = (pt.y - m.wallBodyHeightM) / m.courseModularHeightM
        return [u, v] as const
      }
      for (const pt of m.silhouette) {
        const x = m.wallStartWorld.x + m.wdirX * pt.alongM - m.perpX * m.halfThick
        const z = m.wallStartWorld.z + m.wdirZ * pt.alongM - m.perpZ * m.halfThick
        positions.push(x, pt.y, z)
        const [u, v] = uvFor(pt)
        uvs.push(u, v)
      }
      for (const pt of m.silhouette) {
        const x = m.wallStartWorld.x + m.wdirX * pt.alongM + m.perpX * m.halfThick
        const z = m.wallStartWorld.z + m.wdirZ * pt.alongM + m.perpZ * m.halfThick
        positions.push(x, pt.y, z)
        const [u, v] = uvFor(pt)
        uvs.push(u, v)
      }
      // Front face: triangle fan from vertex 0 to (n-1).
      for (let i = 1; i < n - 1; i++) {
        indices.push(baseIdx + 0, baseIdx + i, baseIdx + i + 1)
      }
      // Back face: triangle fan reversed so the normal points the
      // other way.
      for (let i = 1; i < n - 1; i++) {
        indices.push(startBack + 0, startBack + i + 1, startBack + i)
      }
      // Sides: connect each silhouette edge to its mate on the back
      // face as a quad (two triangles). Edges include the closing
      // edge (last → first).
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n
        const aFront = baseIdx + i
        const bFront = baseIdx + j
        const aBack = startBack + i
        const bBack = startBack + j
        indices.push(aFront, aBack, bFront)
        indices.push(bFront, aBack, bBack)
      }
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array(positions), 3),
    )
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uvs), 2))
    geo.setIndex(new THREE.BufferAttribute(new Uint32Array(indices), 1))
    geo.computeVertexNormals()
    geo.computeBoundingSphere()
    return geo
  }, [items])

  useEffect(() => {
    return () => {
      geometry.dispose()
    }
  }, [geometry])

  // Per-wall-type texture: brick body painted at the wall colour,
  // mortar joints at the shared MORTAR_COLOR. Material colour stays
  // white so the texture renders straight through without tinting.
  const texture = useMemo(
    () => makeBrickPatternTexture(color, MORTAR_COLOR),
    [color],
  )
  useEffect(() => {
    return () => {
      texture.dispose()
    }
  }, [texture])

  return (
    <mesh geometry={geometry} frustumCulled={false}>
      <meshLambertMaterial color="#ffffff" map={texture} />
    </mesh>
  )
}

/**
 * Wedge renderer for curved walls. Each WallSegmentWedge is a
 * trapezoidal prism (4 ground-plane corners extruded vertically by
 * y1 − y0) so blocks following an arc look correctly cut at the rear.
 *
 * Wedges can't share a single InstancedMesh geometry the way axis-
 * aligned cuboids can — every wedge has its own per-instance shape —
 * so we merge every wedge in a (colour, highlight) group into ONE
 * BufferGeometry. Result: one draw call per palette colour, same as
 * the straight-wall InstancedSegments path.
 */
function WedgeSegments({ wedges }: { wedges: WallSegmentWedge[] }) {
  const groups = useMemo(() => {
    const map = new Map<string, WallSegmentWedge[]>()
    for (const w of wedges) {
      const key = `${w.color}|${w.highlight ? 1 : 0}`
      const arr = map.get(key)
      if (arr) arr.push(w)
      else map.set(key, [w])
    }
    return Array.from(map.entries()).map(([key, items]) => {
      const [color, hi] = key.split('|')
      return { color, highlight: hi === '1', items }
    })
  }, [wedges])

  return (
    <>
      {groups.map((g) => (
        <WedgeGroupMesh
          key={`${g.color}|${g.highlight ? 1 : 0}`}
          color={g.color}
          highlight={g.highlight}
          items={g.items}
        />
      ))}
    </>
  )
}

function WedgeGroupMesh({
  color,
  highlight,
  items,
}: {
  color: string
  highlight: boolean
  items: WallSegmentWedge[]
}) {
  // Build one merged BufferGeometry holding every wedge in the group.
  //
  // 24 vertices + 12 triangles (36 indices) per wedge, organised as
  // 6 faces × 4 dedicated corners (same layout three.js BoxGeometry
  // uses). Per-face vertices means no normal averaging across edges,
  // so each face shades FLAT — matching the hard-edged look of
  // straight-wall InstancedMesh boxes. Sharing vertices across faces
  // would smooth the corners into a "pillow" and the curved walls
  // would visibly read different from the straight ones.
  //
  // Recomputed whenever the item list reference changes — happens
  // once per segments useMemo recompute, NOT per camera frame.
  const geometry = useMemo(() => {
    const VERTS_PER_WEDGE = 24
    const positions = new Float32Array(items.length * VERTS_PER_WEDGE * 3)
    const indices = new Uint32Array(items.length * 36)

    for (let i = 0; i < items.length; i++) {
      const w = items[i]
      const vOff = i * VERTS_PER_WEDGE * 3
      const iOff = i * 36
      const base = i * VERTS_PER_WEDGE

      // Each face owns 4 vertices laid out as: face f, corner c → slot f*4 + c.
      // Corners are in perimeter-CCW order viewed from OUTSIDE each face,
      // so the (v0,v1,v2) + (v0,v2,v3) split — same triangulation used by
      // three.js BoxGeometry — gives outward-facing normals under
      // FrontSide. Verified by cross-product on the canonical (+X, +Z)
      // wedge.
      //
      //   0 = TOP     (out +Y)  outerStart, innerStart, innerEnd, outerEnd
      //   1 = BOTTOM  (out −Y)  outerStart, outerEnd, innerEnd, innerStart
      //   2 = OUTER   (front)   outerStart_bot, outerStart_top,
      //                          outerEnd_top,  outerEnd_bot
      //   3 = END   (theta1)    outerEnd_bot,   outerEnd_top,
      //                          innerEnd_top,  innerEnd_bot
      //   4 = INNER   (rear)    innerEnd_bot,   innerEnd_top,
      //                          innerStart_top, innerStart_bot
      //   5 = START (theta0)    outerStart_bot, innerStart_bot,
      //                          innerStart_top, outerStart_top
      const setVert = (n: number, x: number, y: number, z: number) => {
        const p = vOff + n * 3
        positions[p] = x
        positions[p + 1] = y
        positions[p + 2] = z
      }
      // TOP
      setVert(0, w.outerStart.x, w.y1, w.outerStart.z)
      setVert(1, w.innerStart.x, w.y1, w.innerStart.z)
      setVert(2, w.innerEnd.x, w.y1, w.innerEnd.z)
      setVert(3, w.outerEnd.x, w.y1, w.outerEnd.z)
      // BOTTOM
      setVert(4, w.outerStart.x, w.y0, w.outerStart.z)
      setVert(5, w.outerEnd.x, w.y0, w.outerEnd.z)
      setVert(6, w.innerEnd.x, w.y0, w.innerEnd.z)
      setVert(7, w.innerStart.x, w.y0, w.innerStart.z)
      // OUTER (front face) — perimeter CCW from +X+Z view
      setVert(8, w.outerStart.x, w.y0, w.outerStart.z)
      setVert(9, w.outerStart.x, w.y1, w.outerStart.z)
      setVert(10, w.outerEnd.x, w.y1, w.outerEnd.z)
      setVert(11, w.outerEnd.x, w.y0, w.outerEnd.z)
      // END (theta1) — perimeter CCW from -tangent view
      setVert(12, w.outerEnd.x, w.y0, w.outerEnd.z)
      setVert(13, w.outerEnd.x, w.y1, w.outerEnd.z)
      setVert(14, w.innerEnd.x, w.y1, w.innerEnd.z)
      setVert(15, w.innerEnd.x, w.y0, w.innerEnd.z)
      // INNER (rear face) — perimeter CCW viewed from arc centre
      setVert(16, w.innerEnd.x, w.y0, w.innerEnd.z)
      setVert(17, w.innerEnd.x, w.y1, w.innerEnd.z)
      setVert(18, w.innerStart.x, w.y1, w.innerStart.z)
      setVert(19, w.innerStart.x, w.y0, w.innerStart.z)
      // START (theta0) — perimeter CCW from +tangent view
      setVert(20, w.outerStart.x, w.y0, w.outerStart.z)
      setVert(21, w.innerStart.x, w.y0, w.innerStart.z)
      setVert(22, w.innerStart.x, w.y1, w.innerStart.z)
      setVert(23, w.outerStart.x, w.y1, w.outerStart.z)

      // Each face: 2 triangles using its own 4 vertices, split along
      // the v0-v2 diagonal. Vertex layout above has each face's corners
      // in CCW order viewed from OUTSIDE the prism, so the canonical
      // (v0, v1, v2) + (v0, v2, v3) triangulation gives outward normals
      // under three.js FrontSide. Indices are absolute (base + slot).
      let p = iOff
      for (let f = 0; f < 6; f++) {
        const v0 = base + f * 4
        indices[p++] = v0
        indices[p++] = v0 + 1
        indices[p++] = v0 + 2
        indices[p++] = v0
        indices[p++] = v0 + 2
        indices[p++] = v0 + 3
      }
    }

    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geo.setIndex(new THREE.BufferAttribute(indices, 1))
    geo.computeVertexNormals()
    geo.computeBoundingSphere()
    return geo
  }, [items])

  // Dispose the geometry when the items reference changes (next
  // useMemo) or the mesh unmounts — avoids the GPU buffer leak the
  // straight-wall InstancedMesh side handles automatically via r3f.
  useEffect(() => {
    return () => {
      geometry.dispose()
    }
  }, [geometry])

  return (
    <mesh geometry={geometry} frustumCulled={false}>
      {highlight ? (
        <meshLambertMaterial
          color={color}
          emissive={color}
          emissiveIntensity={0.45}
        />
      ) : (
        <meshLambertMaterial color={color} />
      )}
    </mesh>
  )
}

/**
 * Renders the recessed mortar shell behind every curved wall as a
 * smooth ring-section BufferGeometry per wall. Shared seam vertices
 * mean computeVertexNormals averages adjacent face normals across
 * each radial seam — the curve shades smoothly instead of breaking
 * into N visible facet bands like independent micro-wedges do.
 *
 * One mesh per shell; mortar colour is uniform so each mesh is one
 * draw call. Cheaper than the equivalent number of micro-wedges
 * because vertices are deduplicated at every seam.
 */
function CurvedMortarShells({ shells }: { shells: CurvedMortarShell[] }) {
  return (
    <>
      {shells.map((shell, i) => (
        <CurvedMortarShellMesh key={i} shell={shell} />
      ))}
    </>
  )
}

function CurvedMortarShellMesh({ shell }: { shell: CurvedMortarShell }) {
  const geometry = useMemo(() => {
    // N angular segments → N+1 angle samples; 4 vertices per sample
    // (outer-bot, inner-bot, outer-top, inner-top). 96 segments keeps
    // the curve smooth at typical viewport zoom.
    const N = 96
    const samples = N + 1
    const positions = new Float32Array(samples * 4 * 3)
    // Per segment: 2 tris × 4 side faces (outer / inner / top / bot)
    //            = 8 tris per segment.
    // Plus 2 end caps × 2 tris each = 4 tris.
    // Total tris = 8N + 4, indices = 24N + 12.
    const indices = new Uint32Array(N * 24 + 12)

    const { centreXMm, centreYMm, innerRMm, outerRMm, startAngle, sweepAngle, y0, y1 } = shell
    const isCW = sweepAngle < 0

    for (let i = 0; i < samples; i++) {
      const t = i / N
      const theta = startAngle + sweepAngle * t
      const cos = Math.cos(theta)
      const sin = Math.sin(theta)
      const ox = -(centreXMm + outerRMm * cos) / 1000
      const oz = -(centreYMm + outerRMm * sin) / 1000
      const ix = -(centreXMm + innerRMm * cos) / 1000
      const iz = -(centreYMm + innerRMm * sin) / 1000
      const base = i * 4 * 3
      // 0: outer-bot, 1: inner-bot, 2: outer-top, 3: inner-top
      positions[base + 0] = ox
      positions[base + 1] = y0
      positions[base + 2] = oz
      positions[base + 3] = ix
      positions[base + 4] = y0
      positions[base + 5] = iz
      positions[base + 6] = ox
      positions[base + 7] = y1
      positions[base + 8] = oz
      positions[base + 9] = ix
      positions[base + 10] = y1
      positions[base + 11] = iz
    }

    // Triangle winding — chosen so outward normals point correctly for
    // a CCW sweep (sweepAngle > 0). For a CW sweep the natural
    // ordering flips inward/outward, so we swap each pair when isCW.
    let p = 0
    for (let i = 0; i < N; i++) {
      const a = i * 4 // start sample base index
      const b = (i + 1) * 4 // next sample base index
      // Per-sample vertex slot offsets: 0=ob, 1=ib, 2=ot, 3=it
      const aOB = a + 0, aIB = a + 1, aOT = a + 2, aIT = a + 3
      const bOB = b + 0, bIB = b + 1, bOT = b + 2, bIT = b + 3

      const push = (x: number, y: number, z: number) => {
        if (isCW) {
          indices[p++] = x
          indices[p++] = z
          indices[p++] = y
        } else {
          indices[p++] = x
          indices[p++] = y
          indices[p++] = z
        }
      }

      // Outer face (between samples i and i+1, on the outer radius)
      push(aOB, bOT, bOB)
      push(aOB, aOT, bOT)
      // Inner face (between samples i and i+1, on the inner radius)
      push(aIB, bIB, bIT)
      push(aIB, bIT, aIT)
      // Top face
      push(aOT, aIT, bIT)
      push(aOT, bIT, bOT)
      // Bottom face
      push(aOB, bOB, bIB)
      push(aOB, bIB, aIB)
    }
    // End caps — close the ring at the start (sample 0) and end
    // (sample N) so the shell isn't a hollow tube.
    const sOB = 0, sIB = 1, sOT = 2, sIT = 3
    const eOB = N * 4 + 0, eIB = N * 4 + 1, eOT = N * 4 + 2, eIT = N * 4 + 3
    const pushCap = (x: number, y: number, z: number) => {
      if (isCW) {
        indices[p++] = x
        indices[p++] = z
        indices[p++] = y
      } else {
        indices[p++] = x
        indices[p++] = y
        indices[p++] = z
      }
    }
    // Start cap — outward normal points back toward the wall start
    pushCap(sOB, sIB, sIT)
    pushCap(sOB, sIT, sOT)
    // End cap — outward normal points forward past the wall end
    pushCap(eOB, eOT, eIT)
    pushCap(eOB, eIT, eIB)

    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geo.setIndex(new THREE.BufferAttribute(indices, 1))
    geo.computeVertexNormals()
    geo.computeBoundingSphere()
    return geo
  }, [shell])

  useEffect(() => {
    return () => {
      geometry.dispose()
    }
  }, [geometry])

  return (
    <mesh geometry={geometry} frustumCulled={false}>
      <meshLambertMaterial color={MORTAR_COLOR} />
    </mesh>
  )
}

/**
 * Exposes `window.__beme3dCapture()` to take a PNG snapshot of the
 * current 3D viewport (camera angle, palette, plan floor, walls — all
 * of it). Returns a data URL the export pipeline can embed in the
 * PDF.
 *
 * Forces a synchronous render via `gl.render(scene, camera)` before
 * grabbing `gl.domElement.toDataURL()` so the buffer is up-to-date with
 * the current camera even if r3f's frameloop is on 'demand'. Requires
 * `preserveDrawingBuffer: true` in the Canvas gl config; without it
 * the browser clears the buffer immediately after each draw and
 * toDataURL returns a blank PNG.
 */
function CaptureExposer() {
  const gl = useThree((s) => s.gl)
  const scene = useThree((s) => s.scene)
  const camera = useThree((s) => s.camera)
  useEffect(() => {
    type Win = Window & { __beme3dCapture?: () => string | null }
    const capture = (): string | null => {
      try {
        gl.render(scene, camera)
        return gl.domElement.toDataURL('image/png')
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('[3D capture] failed:', e)
        return null
      }
    }
    ;(window as Win).__beme3dCapture = capture
    return () => {
      if ((window as Win).__beme3dCapture === capture) {
        delete (window as Win).__beme3dCapture
      }
    }
  }, [gl, scene, camera])
  return null
}

// ---------- CAD-style controls ----------

/**
 * AutoCAD / Revit-style camera. The camera orbits around a TARGET
 * point in world space, and both camera + target translate together
 * during a pan.
 *
 *   - Left / middle drag           → PAN (the user's "grab and drag
 *     the view" gesture). Left + middle do the same thing so users
 *     without a middle button still get the primary action on the
 *     standard left button. Moves both camera and target along the
 *     camera's local right/up axes. Pan distance scales with the
 *     camera↔target distance so dragging across the screen always
 *     moves the same number of "screen widths" worth of content.
 *   - Shift + left / middle drag   → ORBIT. Camera spins around the
 *     target on the unit sphere; target stays put. Pitch is clamped
 *     so the camera doesn't gimbal-flip over the pole.
 *   - Right-mouse drag             → ORBIT (matches AutoCAD's
 *     Shift+MMB convention on a single-button drag, plus it's the
 *     standard trackpad fallback).
 *   - Shift + right-mouse drag     → PAN.
 *   - Wheel                        → Zoom toward the cursor. Both
 *     camera and target slide along the camera-to-cursor ray; the
 *     pixel under the cursor stays put, AutoCAD-style.
 *
 * Target seeded from `initialTargetX`/`Z` (scene centre) on mount.
 * Spherical coords (radius, theta, phi) derived from the camera's
 * starting position relative to the target so the controller picks
 * up wherever InitialCameraAim left the camera looking.
 */
/**
 * Navigation conventions the user can choose between. Each name maps
 * to a (button, shift, alt) → Mode dispatch. Persisted in localStorage
 * so the choice survives reloads.
 *
 *   - autocad   — Middle/Left = pan; Shift = swap to orbit; Right = orbit.
 *                 The construction-industry default (AutoCAD, Revit).
 *   - sketchup  — Middle/Left = orbit; Shift = swap to pan; Right = pan.
 *                 The 3D-modelling default (SketchUp, Blender).
 *   - three     — Left/Middle = orbit; Right = pan. Three.js OrbitControls
 *                 default; common in browser-based 3D viewers.
 *   - maya      — Alt+Left = orbit, Alt+Middle = pan. No nav without Alt.
 *                 Used by Maya, Cinema 4D, Unreal.
 */
export type NavStyle = 'autocad' | 'sketchup' | 'three' | 'maya'

// Nav-style labels are intentionally generic — referencing the
// industry-standard CAD/3D packages each binding emulates makes the
// dropdown read like an integration list, which we don't want. The
// HINT line under each option still describes the exact mouse
// bindings, so the user can pick the one that matches whatever
// they're used to without us naming any third-party software.
export const NAV_STYLE_LABELS: Record<NavStyle, string> = {
  autocad: 'Style 1',
  sketchup: 'Style 2',
  three: 'Style 3',
  maya: 'Style 4',
}

export const NAV_STYLE_HINTS: Record<NavStyle, string> = {
  autocad: 'drag = pan · shift+drag = orbit · right-drag = orbit · scroll = zoom',
  sketchup: 'drag = orbit · shift+drag = pan · right-drag = pan · scroll = zoom',
  three: 'left/middle drag = orbit · right-drag = pan · scroll = zoom',
  maya: 'alt+left = orbit · alt+middle = pan · scroll = zoom',
}

function buttonToModeFor(
  style: NavStyle,
  button: number,
  shift: boolean,
  alt: boolean
): 'idle' | 'pan' | 'orbit' {
  switch (style) {
    case 'autocad':
      if (button === 0 || button === 1) return shift ? 'orbit' : 'pan'
      if (button === 2) return shift ? 'pan' : 'orbit'
      return 'idle'
    case 'sketchup':
      if (button === 0 || button === 1) return shift ? 'pan' : 'orbit'
      if (button === 2) return 'pan'
      return 'idle'
    case 'three':
      if (button === 0 || button === 1) return 'orbit'
      if (button === 2) return 'pan'
      return 'idle'
    case 'maya':
      // Maya's hold-Alt-to-navigate convention. Without Alt the buttons
      // do nothing — leaving room for a future click-to-select.
      if (!alt) return 'idle'
      if (button === 0) return 'orbit'
      if (button === 1) return 'pan'
      if (button === 2) return 'pan'
      return 'idle'
  }
}

function CADControls({
  initialTargetX,
  initialTargetZ,
  sceneSizeMax,
  navStyle,
}: {
  initialTargetX: number
  initialTargetZ: number
  /** Longer of the bounding box's width / depth in metres — used by
   *  the Fit-view shortcut to recompute the camera distance. */
  sceneSizeMax: number
  navStyle: NavStyle
}) {
  const camera = useThree((s) => s.camera)
  const gl = useThree((s) => s.gl)
  const scene = useThree((s) => s.scene)
  const invalidate = useThree((s) => s.invalidate)

  // Keep the LIVE navStyle accessible inside the (long-lived) pointer
  // handlers without rebinding the effect each time the user switches
  // styles. Rebinding would reset the orbit target, teleporting the
  // user back to the scene centre — not what they want.
  const navStyleRef = useRef(navStyle)
  useEffect(() => {
    navStyleRef.current = navStyle
  }, [navStyle])

  // Same trick for the scene-bound values consumed by fitView(): we
  // need them LIVE so pressing F re-frames the current scene, but we
  // must NOT re-run the controller effect when they change — that
  // would re-create `target` at the (potentially shifted) scene
  // centre and snap the user's view back to the default position
  // every time a wall is added / moved / saved. The refs let fitView
  // read the current value while the effect's dep array stays stable.
  const initialTargetXRef = useRef(initialTargetX)
  const initialTargetZRef = useRef(initialTargetZ)
  const sceneSizeMaxRef = useRef(sceneSizeMax)
  useEffect(() => {
    initialTargetXRef.current = initialTargetX
    initialTargetZRef.current = initialTargetZ
    sceneSizeMaxRef.current = sceneSizeMax
  }, [initialTargetX, initialTargetZ, sceneSizeMax])

  useEffect(() => {
    const dom = gl.domElement

    // Orbit target. Initially at the scene's horizontal centre, just
    // above the ground (1m) so we're looking at roughly where the
    // walls are, not at the ground plane. Read from refs so subsequent
    // bound changes (wall edits / saves) don't re-trigger this effect
    // and snap the camera back.
    const target = new THREE.Vector3(
      initialTargetXRef.current,
      1,
      initialTargetZRef.current,
    )

    // Seed spherical coords (theta=azimuth, phi=polar) from the
    // camera's offset from the target — so the controller picks up
    // wherever the camera is initially aimed.
    const offset = new THREE.Vector3().subVectors(camera.position, target)
    const spherical = new THREE.Spherical().setFromVector3(offset)
    const PHI_EPSILON = 0.01
    if (spherical.phi < PHI_EPSILON) spherical.phi = PHI_EPSILON
    if (spherical.phi > Math.PI - PHI_EPSILON) spherical.phi = Math.PI - PHI_EPSILON

    type Mode = 'idle' | 'pan' | 'orbit'
    const state = {
      mode: 'idle' as Mode,
      pointerId: -1,
      lastX: 0,
      lastY: 0,
    }

    // Sensitivity: radians per pixel for orbit, world units per
    // pixel for pan (scaled per-frame by camera distance).
    const ORBIT_SENS = 0.005
    const PAN_SCREEN_FRACTION = 1.0 // dragging across the canvas pans by ~1 canvas worth

    // Wheel zoom — each tick moves the camera + target a fixed
    // fraction of the way along the camera→cursor ray. Cursor-locked
    // zoom means the pixel under the cursor stays under the cursor.
    const WHEEL_STEP = 0.12 // 12% per tick
    const WHEEL_MIN_DISTANCE = 0.05 // metres — don't poke through walls
    const WHEEL_FALLBACK_DISTANCE = 10

    const raycaster = new THREE.Raycaster()

    /** Recompute camera.position from target + spherical offset and
     *  point it at the target. Call after any orbit/pan/zoom. */
    const updateCamera = () => {
      const off = new THREE.Vector3().setFromSpherical(spherical)
      camera.position.copy(target).add(off)
      camera.lookAt(target)
      invalidate()
    }

    /** Build a world-space ray from a screen pixel. Used for
     *  cursor-locked zoom. */
    const screenToRay = (clientX: number, clientY: number) => {
      const rect = dom.getBoundingClientRect()
      const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1
      const ndcY = -((clientY - rect.top) / rect.height) * 2 + 1
      raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), camera)
      return raycaster
    }

    /** Defer to the nav-style-specific dispatcher so this controller
     *  stays generic. Reads the LIVE navStyle from the ref so the
     *  effect doesn't have to re-bind (and reset target/spherical)
     *  every time the user picks a different style. */
    const buttonToMode = (button: number, shift: boolean, alt: boolean): Mode =>
      buttonToModeFor(navStyleRef.current, button, shift, alt)

    const onPointerDown = (e: PointerEvent) => {
      const mode = buttonToMode(e.button, e.shiftKey, e.altKey)
      if (mode === 'idle') return
      state.mode = mode
      state.pointerId = e.pointerId
      state.lastX = e.clientX
      state.lastY = e.clientY
      dom.setPointerCapture?.(e.pointerId)
      e.preventDefault()
    }

    const onPointerMove = (e: PointerEvent) => {
      if (state.mode === 'idle') return
      const dx = e.clientX - state.lastX
      const dy = e.clientY - state.lastY
      state.lastX = e.clientX
      state.lastY = e.clientY

      if (state.mode === 'orbit') {
        // Standard CAD orbit: dragging right spins the camera
        // around the target to the right (so the model appears to
        // turn left under your gaze). Flip signs if a user prefers
        // the opposite convention.
        spherical.theta -= dx * ORBIT_SENS
        spherical.phi -= dy * ORBIT_SENS
        if (spherical.phi < PHI_EPSILON) spherical.phi = PHI_EPSILON
        if (spherical.phi > Math.PI - PHI_EPSILON) {
          spherical.phi = Math.PI - PHI_EPSILON
        }
        updateCamera()
        return
      }

      // Pan. Scale screen pixels into world units using camera FOV
      // + canvas height, so a drag of the full canvas height moves
      // the scene by ~PAN_SCREEN_FRACTION × the camera↔target distance
      // along the camera's UP axis. Right/left scales analogously
      // via aspect ratio.
      const rect = dom.getBoundingClientRect()
      const persp = camera as THREE.PerspectiveCamera
      const fovRad = (persp.fov * Math.PI) / 180
      const dist = spherical.radius
      const worldPerPixelY = (2 * dist * Math.tan(fovRad / 2)) / rect.height
      const worldPerPixelX = worldPerPixelY * persp.aspect

      // Camera's local right + up in world space.
      const right = new THREE.Vector3().setFromMatrixColumn(
        camera.matrix,
        0
      )
      const up = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 1)
      const move = new THREE.Vector3()
        .addScaledVector(right, -dx * worldPerPixelX * PAN_SCREEN_FRACTION)
        .addScaledVector(up, dy * worldPerPixelY * PAN_SCREEN_FRACTION)
      target.add(move)
      // Camera moves with the target; spherical offset stays the
      // same so the view direction is preserved.
      updateCamera()
    }

    const onPointerUp = (e: PointerEvent) => {
      if (e.pointerId !== state.pointerId) return
      state.mode = 'idle'
      state.pointerId = -1
      dom.releasePointerCapture?.(e.pointerId)
    }

    const onContextMenu = (e: MouseEvent) => {
      // Suppress the right-click menu so right-drag = orbit works
      // (trackpad fallback path).
      e.preventDefault()
    }

    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      // Cursor-locked zoom: raycast through the cursor to find
      // either a scene hit or a phantom-distance fallback point,
      // then move BOTH camera and target a fraction of the way
      // toward that point. The cursor's world position stays under
      // the cursor after the zoom — the AutoCAD "scroll to zoom in
      // there" feel.
      const ray = screenToRay(e.clientX, e.clientY)
      const hits = ray.intersectObjects(scene.children, true)
      const dir = ray.ray.direction.clone() // already normalised
      const origin = ray.ray.origin.clone()
      const targetWorld =
        hits.length > 0
          ? hits[0].point
          : origin.clone().addScaledVector(dir, WHEEL_FALLBACK_DISTANCE)

      const sign = e.deltaY < 0 ? 1 : -1 // scroll up = zoom in
      const toTarget = new THREE.Vector3().subVectors(targetWorld, camera.position)
      let moveAmount = sign * WHEEL_STEP
      // Clamp inward zoom so we don't overshoot through the surface.
      if (sign === 1 && toTarget.length() * (1 - moveAmount) < WHEEL_MIN_DISTANCE) {
        moveAmount = 1 - WHEEL_MIN_DISTANCE / Math.max(toTarget.length(), 1e-3)
      }
      camera.position.addScaledVector(toTarget, moveAmount)
      target.addScaledVector(toTarget, moveAmount)
      // Re-derive spherical from new camera/target so subsequent
      // orbits + pans use the updated radius.
      const newOffset = new THREE.Vector3().subVectors(camera.position, target)
      spherical.setFromVector3(newOffset)
      if (spherical.phi < PHI_EPSILON) spherical.phi = PHI_EPSILON
      if (spherical.phi > Math.PI - PHI_EPSILON) {
        spherical.phi = Math.PI - PHI_EPSILON
      }
      camera.lookAt(target)
      invalidate()
    }

    /** Frame the building. Re-centres the target on the scene bounds,
     *  resets spherical radius to a true frame-to-fit distance, and
     *  picks a 3/4 viewing angle. Bound to the F key (Blender / Maya
     *  convention) and exposed on `window.__beme3dFit` so the overlay
     *  button can call into it. */
    const fitView = () => {
      target.set(initialTargetXRef.current, 1, initialTargetZRef.current)
      const FIT_FOV_RAD = (45 * Math.PI) / 180
      // Same aggressive multiplier (0.40) as the initial framing so
      // F-fit and the initial view match. See initialCamera comments
      // for the trade-off (long thin buildings may clip).
      const dist = Math.max(
        4,
        (sceneSizeMaxRef.current / 2) / Math.tan(FIT_FOV_RAD / 2) * 0.40
      )
      // theta = horizontal angle (45° = corner view).
      // phi = polar angle from world Y; ~60° gives a 3/4 elevation.
      spherical.theta = Math.PI / 4
      spherical.phi = (60 * Math.PI) / 180
      spherical.radius = dist
      updateCamera()
    }

    const onKeyDown = (e: KeyboardEvent) => {
      // Plain F only — no modifiers — so it doesn't conflict with
      // platform shortcuts (Cmd+F, Ctrl+F find dialog). Ignore key
      // events while the user is typing in an input/textarea
      // anywhere on the page.
      if (e.key !== 'f' && e.key !== 'F') return
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      e.preventDefault()
      fitView()
    }

    // Expose fitView on the window so the overlay button outside the
    // Canvas tree can call it. Cleanly removed on unmount.
    type Win = Window & { __beme3dFit?: () => void }
    ;(window as Win).__beme3dFit = fitView

    dom.addEventListener('pointerdown', onPointerDown)
    dom.addEventListener('pointermove', onPointerMove)
    dom.addEventListener('pointerup', onPointerUp)
    dom.addEventListener('pointercancel', onPointerUp)
    dom.addEventListener('contextmenu', onContextMenu)
    dom.addEventListener('wheel', onWheel, { passive: false })
    window.addEventListener('keydown', onKeyDown)

    // Apply the initial state once on mount so the camera lookAt is
    // immediately consistent with our spherical/target model.
    updateCamera()

    return () => {
      dom.removeEventListener('pointerdown', onPointerDown)
      dom.removeEventListener('pointermove', onPointerMove)
      dom.removeEventListener('pointerup', onPointerUp)
      dom.removeEventListener('pointercancel', onPointerUp)
      dom.removeEventListener('contextmenu', onContextMenu)
      dom.removeEventListener('wheel', onWheel)
      window.removeEventListener('keydown', onKeyDown)
      type Win = Window & { __beme3dFit?: () => void }
      if ((window as Win).__beme3dFit === fitView) {
        delete (window as Win).__beme3dFit
      }
    }
  }, [
    camera,
    gl,
    scene,
    invalidate,
    // initialTargetX/Z and sceneSizeMax intentionally NOT in deps —
    // read via refs above so wall edits / saves don't snap the camera.
  ])

  return null
}

// ---------- Scene ----------

function Scene({
  walls,
  openings,
  makeupsById,
  brickMakeupsById,
  wallThicknessByWallId,
  library,
  piers = [],
  pierMakeupsById = {},
  pierColorByPierId = {},
  navStyle,
  planTexture,
  pageWidthMm,
  pageHeightMm,
  pageScaleRatio,
  theme,
  palette,
  onResolvedCodes,
}: Omit<WorkspaceView3DProps, 'areas'> & {
  navStyle: NavStyle
  planTexture: { texture: THREE.Texture; widthM: number; heightM: number } | null
  theme: Theme
  palette: PaletteName
  onResolvedCodes: (codes: Map<string, string>) => void
}) {
  const { segments, wedges, mortarShells, capMeshes, segmentBounds, resolvedCodes } = useMemo(() => {
    // First pass: resolve each wall's per-course composition so we know
    // every block code (body + corner + half) that'll appear in the 3D
    // view. Codes are coloured via the pure-hash `bandColor`, so the
    // same code always lands on the same colour across every project.
    const wallResolutions = walls.map((wall) => {
      if (wall.trade === 'brick') return null
      return resolveWallCourses(wall, makeupsById, library)
    })

    // ── 3D-only opening head adjustment ─────────────────────────────
    //
    // Real masonry puts the window head 300 mm below the top of the
    // wall — that's the gap that holds the lintel + one head course.
    // The 2D data may carry an arbitrary sill (user typed-in or legacy
    // zero), which can render with the head right against the wall top
    // or floating mid-wall, looking wrong. For the 3D view (only — the
    // tally / export still use the raw opening data) we re-anchor each
    // WINDOW so its head sits at wallHeight − 300 mm; doors sit on the
    // floor at sill = 0 regardless.
    const wallById_forSill = new Map(walls.map((w) => [w.id, w]))
    const wallHeightMmFor = (wall: Wall): number => {
      if (typeof wall.heightMmOverride === 'number') return wall.heightMmOverride
      if (wall.trade === 'brick') {
        return brickMakeupsById[wall.makeupId]?.heightMm ?? FALLBACK_HEIGHT_MM
      }
      return makeupsById[wall.makeupId]?.heightMm ?? FALLBACK_HEIGHT_MM
    }
    // Sill positioning rules live in adjustOpeningForRender (shared
    // with the tally engine, so blocks are COUNTED where openings are
    // DRAWN — render and export stay in lockstep).
    const adjustedOpenings: Opening[] = openings.map((o) => {
      const wall = wallById_forSill.get(o.wallId)
      if (!wall) return o
      return adjustOpeningForRender(o, wallHeightMmFor(wall))
    })

    const allCodes: string[] = []
    for (const wr of wallResolutions) {
      if (!wr) continue
      for (const c of wr.courses) {
        allCodes.push(c.bodyCode, c.cornerCode, c.halfCode)
      }
      // Walk BOTH the user's explicit coursePattern (when set) AND the
      // synthesised band list from convertMakeupToBands. The synthesised
      // list adds height-makeup bands (20.71 / 20.140) based on the
      // wall's height remainder — these are what planWallLayout's
      // buildCourses actually renders, even if the user's coursePattern
      // didn't list them explicitly. Walking both guarantees every
      // RENDERED code lands in allCodes WITHOUT polluting the legend
      // with library codes that aren't actually used on the page.
      if (wr.makeup) {
        if (wr.makeup.coursePattern) {
          for (const band of wr.makeup.coursePattern) {
            if (band.blockCode) allCodes.push(band.blockCode)
          }
        }
        try {
          const synth = convertMakeupToBands(wr.makeup, undefined).bands
          for (const band of synth) {
            if (band.blockCode) allCodes.push(band.blockCode)
          }
        } catch {
          // convertMakeupToBands can throw on degenerate makeups —
          // skip silently; the per-course bodyCode loop above usually
          // covers the codes anyway.
        }
      }
    }
    // Lintel + sill override codes for the colour map. Block walls
    // auto-pick a lintel via selectBlockLintel based on each opening's
    // head height; the per-opening headCourseBlockCode override wins
    // when set. Either way we need the chosen code in allCodes so it
    // gets a palette slot.
    for (const wall of walls) {
      if (wall.trade === 'brick') continue
      const heightMm =
        typeof wall.heightMmOverride === 'number'
          ? wall.heightMmOverride
          : makeupsById[wall.makeupId]?.heightMm ?? FALLBACK_HEIGHT_MM
      const wallOpenings = adjustedOpenings.filter((o) => o.wallId === wall.id)
      for (const op of wallOpenings) {
        if (op.headCourseBlockCode) {
          allCodes.push(op.headCourseBlockCode)
        } else {
          const headHeightMm = heightMm - op.sillHeightMm - op.heightMm
          if (headHeightMm > 0) {
            const wallHeightMod200 = Math.round(heightMm) % 200
            const extras: number[] =
              wallHeightMod200 === 100
                ? [100]
                : wallHeightMod200 === 150
                  ? [150]
                  : []
            const spec = selectBlockLintel(
              headHeightMm,
              extras,
              op.lintelBlockCodeOverride
            )
            if (spec) allCodes.push(spec.code)
          }
        }
        if (op.sillCourseBlockCode) allCodes.push(op.sillCourseBlockCode)
      }
    }
    // Fraction codes — collected from each wall's planWall fits so any
    // 20.02 / 20.22 (or library-defined fraction) the planner picks for
    // a course gets its own distinct legend entry + colour. Without
    // this loop, fractions render in 3D but the legend only lists
    // body / corner / half / lintel, so the user has no way to see
    // which fraction code corresponds to which colour on the wall.
    const wallsByIdForFractions: Record<string, Wall> = {}
    for (const w of walls) wallsByIdForFractions[w.id] = w
    for (let i = 0; i < walls.length; i++) {
      const wall = walls[i]
      if (wall.trade === 'brick') continue
      const makeup = makeupsById[wall.makeupId]
      if (!makeup) continue
      try {
        const plan = planWall(wall, makeup, wallThicknessByWallId, wallsByIdForFractions)
        for (const fracCode of plan.oddCourseFit.fractions) allCodes.push(fracCode)
        for (const fracCode of plan.evenCourseFit.fractions) allCodes.push(fracCode)
      } catch {
        // planWall throws on degenerate geometry (zero-length walls).
        // Skip silently — those walls won't render fractions anyway.
      }
      // Height-makeup codes — derive by RUNNING buildCourses for this
      // wall and pulling the actual code off each height-71 / height-140
      // course it produces. Same call path the tally + 3D layout uses,
      // so the legend always shows the code that's actually rendered
      // instead of the raw makeup field. Critical when:
      //   - pickHeightMakeupBlock is depth-scoped (30.140 picked over
      //     20.140 on a 300-series wall, even when the makeup's saved
      //     field still says 20.140)
      //   - matchExactHeight is off (the height-71 / height-140 slot
      //     emits a cut body block instead of a height-makeup block,
      //     so the legend should reflect the body code not the
      //     never-used height-makeup code)
      try {
        const wallHeightMm =
          wall.heightMmOverride ?? getMakeupHeightMm(makeup)
        const stack = calculateCourseStack(wallHeightMm)
        const courses = buildCourses(stack, makeup)
        for (const c of courses) {
          if (c.type === 'height-71' || c.type === 'height-140') {
            allCodes.push(c.bodyBlock)
          }
        }
      } catch {
        // calculateCourseStack / buildCourses throw on degenerate
        // input; fall through to the legacy field reads below so the
        // legend at least has SOMETHING.
        if (makeup.heightMakeup71BlockCode) {
          allCodes.push(makeup.heightMakeup71BlockCode)
        }
        if (makeup.heightMakeup140BlockCode) {
          allCodes.push(makeup.heightMakeup140BlockCode)
        }
      }
      // Per-range height-makeup overrides used to be pushed here
      // unconditionally — that produced phantom legend entries when
      // the range existed in the makeup but didn't cover the actual
      // 71 / 140 course position (e.g. range fromCourse=1 toCourse=5
      // on a wall where the 71 row lands at course 14). The
      // buildCourses path above already returns the resolved code for
      // wherever the 71 / 140 course actually lands, which honours
      // any range that genuinely covers that position. So the per-
      // range push is redundant AND ghost-producing — dropped.
    }
    // Build the colour map via the raw hash `bandColor` rather than
    // `buildBlockColorMap`. The hash is pure-function-of-code, so
    // "30.01" always lands on the same palette slot — in this project,
    // the next project, the legend, the WallTypesPanel preview, every
    // 3D capture. Cross-estimate consistency: the supplier looking at
    // a brick schedule will see Standard Block in the same colour every
    // time.
    //
    // Trade-off: the per-project collision avoidance in
    // buildBlockColorMap is gone, so occasionally two codes that hash
    // to the same slot will share a colour. The legend label sits next
    // to the swatch so this is readable rather than ambiguous. The
    // 16-slot vibrant palette gives a ~1-in-16 collision rate per
    // additional code, low enough that most projects don't hit it.
    //
    // Filter to ONLY codes that exist in the current library. When the
    // user switches library templates, makeups keep their old codes in
    // storage — but those codes may not exist in the new library. Without
    // this filter the legend would show ghosts from the old library long
    // after the switch.
    const presentCodes = allCodes.filter((code) => library[code] !== undefined)
    const colorMap = new Map<string, string>()
    for (const code of presentCodes) {
      colorMap.set(code, bandColor(code, palette))
    }

    const out: WallSegmentBox[] = []
    const outWedges: WallSegmentWedge[] = []
    const outMortarShells: CurvedMortarShell[] = []
    /**
     * Cap meshes — one prism per wall with a `topProfile`. Renders
     * as a solid brick-coloured triangle (gable) or trapezoid (raked
     * top) on top of the wall body. The brick tally already accounts
     * for the cap's sq m + lineal m, so this is purely cosmetic —
     * shows the silhouette without per-brick complexity.
     */
    const outCapMeshes: CapMesh[] = []
    // Build wallsById ONCE outside the loop so both segmentsForStraightWall
    // (for outer-edge endpoint extension) and segmentsFromWallLayout
    // (for the same, plus corner ownership) can use it without
    // rebuilding per wall.
    const wallsByIdMap: Record<string, Wall> = {}
    for (const w of walls) wallsByIdMap[w.id] = w

    // Map of each wall's effective height in mm. Used by
    // segmentsForStraightWall to make corner ownership HEIGHT-AWARE:
    // when two walls of different heights meet at a corner, the
    // taller wall's courses above the shorter wall's top render as
    // a free end (no corner cube extension) — there's no
    // perpendicular wall to share a corner with up there.
    const wallHeightMmByWallId: Record<string, number> = {}
    for (const w of walls) {
      wallHeightMmByWallId[w.id] = resolveWallHeightMm(
        w,
        makeupsById,
        brickMakeupsById,
      )
    }

    /**
     * Emit a mortar fill behind every brick/block face of the given wall.
     * Mortar is a recessed box (depth × MORTAR_THICKNESS_FRAC), inset
     * from the wall envelope by MORTAR_GAP_M so its side/top/bottom
     * faces tuck behind the brick/block faces (which span the full
     * envelope at outer edges with no half-gap inset). Bricks/blocks
     * have a 3mm half-gap inset on edges that face a neighbour, so the
     * resulting 6mm gaps reveal this mortar plane behind them.
     *
     * Openings: emits as horizontal bands split at every opening y-
     * boundary; each band's strips skip s-ranges covered by an opening
     * fully spanning the band. Opening cavities stay empty instead of
     * showing mortar through.
     */
    function emitMortarForWall(
      wall: Wall,
      thicknessMm: number,
      totalHeightM: number,
      wallOpenings: Opening[],
      /**
       * Optional per-course info so the mortar plane can use the THINNEST
       * block depth in each band. Without this the mortar uses the wall-
       * level (max) thickness and extends past narrower courses, covering
       * their faces — visible as a "wash" over 200-series courses sitting
       * on top of 300-series.
       */
      courses?: Array<{
        bodyCode: BlockCode
        /** y range in metres. */
        y0: number
        y1: number
      }>
    ) {
      // Use outer-edge endpoints (matches the block-emission extent so
      // mortar terminates at the same outer corner the blocks do, not
      // at the data centerline).
      const extW = outerEdgeEndpoints(wall, wallThicknessByWallId, wallsByIdMap)
      const sxw = -extW.startX / 1000
      const szw = -extW.startY / 1000
      const exw = -extW.endX / 1000
      const ezw = -extW.endY / 1000
      const dxw = exw - sxw
      const dzw = ezw - szw
      const wallLenM = Math.hypot(dxw, dzw)
      if (wallLenM < 0.001) return
      const dirXw = dxw / wallLenM
      const dirZw = dzw / wallLenM
      const yRotW = Math.atan2(-dzw, dxw)
      const defaultMortarThick = (thicknessMm / 1000) * MORTAR_THICKNESS_FRAC
      // For each mortar band, find the thinnest block depth that
      // overlaps the band's y-range. Mortar uses that depth so it
      // never extends past the narrowest course in the band.
      const minDepthForBand = (bandY0: number, bandY1: number): number => {
        if (!courses || courses.length === 0) return defaultMortarThick
        let minDepthMm: number | null = null
        for (const c of courses) {
          if (c.y1 <= bandY0 + 0.001 || c.y0 >= bandY1 - 0.001) continue
          const d = library[c.bodyCode]?.dimensions.depthMm
          if (typeof d === 'number') {
            if (minDepthMm === null || d < minDepthMm) minDepthMm = d
          }
        }
        return minDepthMm !== null
          ? (minDepthMm / 1000) * MORTAR_THICKNESS_FRAC
          : defaultMortarThick
      }

      // Per-course corner-shift lookup. For mixed-series partners the
      // actual outer corner sits inboard from the wall-level outer
      // corner (the chord is extended via the partner's WALL-LEVEL
      // half-thickness; per-course it should land at the partner's
      // ACTUAL half-thickness at this Y). Mortar bands inherit that
      // shift so the mortar fill doesn't poke past where the blocks
      // actually land.
      const leftCornerNeighborW =
        wall.startJunction.type === 'corner'
          ? wall.startJunction.connectedWallIds?.[0]
          : undefined
      const rightCornerNeighborW =
        wall.endJunction.type === 'corner'
          ? wall.endJunction.connectedWallIds?.[0]
          : undefined
      const partnerHalfAtYMortar = (
        partnerId: string | undefined,
        yMidM: number
      ): number => {
        if (partnerId === undefined) return 0
        const partnerCourses = wallCoursesByIdCache?.[partnerId]
        if (partnerCourses) {
          for (const pc of partnerCourses) {
            if (yMidM >= pc.y0 - 0.001 && yMidM <= pc.y1 + 0.001) {
              const d = library[pc.bodyCode]?.dimensions.depthMm
              if (typeof d === 'number') return d / 2 / 1000
              break
            }
          }
        }
        return (
          (wallThicknessByWallId[partnerId] ?? thicknessMm) / 2 / 1000
        )
      }
      const leftWallLevelHalfMortar =
        leftCornerNeighborW !== undefined
          ? (wallThicknessByWallId[leftCornerNeighborW] ?? thicknessMm) /
            2 /
            1000
          : 0
      const rightWallLevelHalfMortar =
        rightCornerNeighborW !== undefined
          ? (wallThicknessByWallId[rightCornerNeighborW] ?? thicknessMm) /
            2 /
            1000
          : 0
      const shiftsForBand = (
        bandY0: number,
        bandY1: number
      ): { left: number; right: number } => {
        const yMid = (bandY0 + bandY1) / 2
        const left =
          leftCornerNeighborW !== undefined
            ? Math.max(
                0,
                leftWallLevelHalfMortar -
                  partnerHalfAtYMortar(leftCornerNeighborW, yMid)
              )
            : 0
        const right =
          rightCornerNeighborW !== undefined
            ? Math.max(
                0,
                rightWallLevelHalfMortar -
                  partnerHalfAtYMortar(rightCornerNeighborW, yMid)
              )
            : 0
        return { left, right }
      }

      const opLocal: { s0: number; s1: number; y0: number; y1: number }[] = []
      const yBoundaries = new Set<number>([0, totalHeightM])
      for (const op of wallOpenings) {
        if (op.wallId !== wall.id) continue
        const s0 = Math.max(0, op.startAlongWallMm / 1000)
        const s1 = Math.min(wallLenM, (op.startAlongWallMm + op.widthMm) / 1000)
        const y0 = Math.max(0, op.sillHeightMm / 1000)
        const y1 = Math.min(totalHeightM, (op.sillHeightMm + op.heightMm) / 1000)
        if (s1 > s0 + 0.001 && y1 > y0 + 0.001) {
          opLocal.push({ s0, s1, y0, y1 })
          yBoundaries.add(y0)
          yBoundaries.add(y1)
        }
      }
      // Also split at COURSE boundaries so each band sees a single
      // course's depth — without this the mortar uses the thinnest
      // depth across the whole wall, leaving the 300-series mortar
      // too thin and revealing a recessed gap behind those blocks.
      if (courses) {
        for (const c of courses) {
          yBoundaries.add(Math.max(0, Math.min(totalHeightM, c.y0)))
          yBoundaries.add(Math.max(0, Math.min(totalHeightM, c.y1)))
        }
      }
      const sortedYs = Array.from(yBoundaries).sort((a, b) => a - b)

      const envelopeInset = MORTAR_GAP_M
      const pushMortarStrip = (
        s0: number,
        s1: number,
        y0: number,
        y1: number,
        bandMortarThick: number,
        /** Effective left edge of this band (per-course shifted). When
         *  the strip touches this edge, inset by envelopeInset so the
         *  block's halfGap inset at the corner covers the mortar — no
         *  visible overhang at the per-course outer corner. */
        bandS0: number,
        bandS1: number
      ) => {
        const atLeftEdge = Math.abs(s0 - bandS0) < 0.001
        const atRightEdge = Math.abs(s1 - bandS1) < 0.001
        const aS0 = atLeftEdge ? s0 + envelopeInset : s0
        const aS1 = atRightEdge ? s1 - envelopeInset : s1
        const aY0 = y0 < 0.001 ? envelopeInset : y0
        const aY1 = y1 > totalHeightM - 0.001 ? totalHeightM - envelopeInset : y1
        if (aS1 - aS0 < 0.005 || aY1 - aY0 < 0.005) return
        const localCx = (aS0 + aS1) / 2
        out.push({
          cx: sxw + dirXw * localCx,
          cy: (aY0 + aY1) / 2,
          cz: szw + dirZw * localCx,
          length: aS1 - aS0,
          heightM: aY1 - aY0,
          thickness: bandMortarThick,
          yRotation: yRotW,
          color: MORTAR_COLOR,
          highlight: false,
        })
      }

      for (let bi = 0; bi < sortedYs.length - 1; bi++) {
        const bandY0 = sortedYs[bi]
        const bandY1 = sortedYs[bi + 1]
        if (bandY1 - bandY0 < 0.001) continue
        const bandMortarThick = minDepthForBand(bandY0, bandY1)
        // Per-band s extents: pulled inboard by the per-course shift so
        // mortar at the corner doesn't poke past where the blocks at
        // this Y actually land. For uniform partners both shifts are 0
        // and the band runs the full wall length.
        const bandShifts = shiftsForBand(bandY0, bandY1)
        const bandS0 = bandShifts.left
        const bandS1 = wallLenM - bandShifts.right
        if (bandS1 - bandS0 < 0.005) continue
        const blockingOps = opLocal
          .filter((o) => o.y0 <= bandY0 + 0.001 && o.y1 >= bandY1 - 0.001)
          .sort((a, b) => a.s0 - b.s0)
        let cursor = bandS0
        for (const op of blockingOps) {
          const clipped0 = Math.max(bandS0, op.s0)
          const clipped1 = Math.min(bandS1, op.s1)
          if (clipped0 > cursor) {
            pushMortarStrip(
              cursor,
              clipped0,
              bandY0,
              bandY1,
              bandMortarThick,
              bandS0,
              bandS1
            )
          }
          cursor = Math.max(cursor, clipped1)
        }
        if (cursor < bandS1) {
          pushMortarStrip(
            cursor,
            bandS1,
            bandY0,
            bandY1,
            bandMortarThick,
            bandS0,
            bandS1
          )
        }
      }
    }

    /**
     * Auto-detect when a block wall's geometry needs a corner lead-in
     * to land on stretcher bond, and search the library for a matching
     * block.
     *
     * Bond math: for the body grid to offset by exactly half a body
     * modular between owning and non-owning courses at a corner,
     * `corner_width − cube_depth` must equal `body_modular / 2`. For
     * 200-series (corner 390, cube 190, body 390+10) this is automatic:
     * 200 = 200. For 300-series (corner 390, cube 290) it's off by
     * 100mm — that gap is exactly what the 30.02 lead-in block fills.
     *
     * Returns a makeup with `cornerLeadInBlockCode` + `cornerLeadInCount`
     * overridden if (a) a lead-in is needed (>5mm mismatch), AND (b) the
     * library contains a block whose width matches the required lead-in
     * width (= required_modular − mortar). When neither condition holds
     * the original makeup is returned unchanged.
     */
    function resolveLeadInForWall(
      wall: Wall,
      makeup: WallMakeup
    ): WallMakeup {
      const bodyBlock = library[makeup.bodyBlockCode]
      const cornerBlock = library[makeup.cornerBlockCode]
      if (!bodyBlock || !cornerBlock) return makeup
      const bodyWidth = bodyBlock.dimensions.widthMm
      const cornerWidth = cornerBlock.dimensions.widthMm
      const MORTAR = DEFAULT_MORTAR_JOINT_MM
      const halfBodyModular = (bodyWidth + MORTAR) / 2

      // Use the start-corner's neighbour for cube depth; fall back to
      // end-corner or this wall's own thickness if start isn't a corner.
      const lookupCubeDepth = (): number => {
        const sNeighbor = wall.startJunction.type === 'corner'
          ? wall.startJunction.connectedWallIds?.[0]
          : undefined
        const eNeighbor = wall.endJunction.type === 'corner'
          ? wall.endJunction.connectedWallIds?.[0]
          : undefined
        const id = sNeighbor ?? eNeighbor
        if (!id) return wallThicknessByWallId[wall.id] ?? 190
        return wallThicknessByWallId[id] ?? wallThicknessByWallId[wall.id] ?? 190
      }
      const cubeDepth = lookupCubeDepth()
      const requiredLeadInModular = halfBodyModular - (cornerWidth - cubeDepth)
      const requiredLeadInWidth = requiredLeadInModular - MORTAR

      // Find a library block whose width is close to required. Sorted
      // by closeness so we pick the best match. Exclude the corner
      // block itself and anything with role 'corner' (don't pick the
      // wrong block by accident).
      const candidates = Object.values(library)
        .filter((b) => b.code !== makeup.cornerBlockCode && b.code !== makeup.bodyBlockCode)
        .filter((b) => Math.abs(b.dimensions.widthMm - requiredLeadInWidth) <= 15)
        .sort(
          (a, b) =>
            Math.abs(a.dimensions.widthMm - requiredLeadInWidth) -
            Math.abs(b.dimensions.widthMm - requiredLeadInWidth)
        )
      const match = candidates[0]

      if (import.meta.env.DEV) {
        // eslint-disable-next-line no-console
        console.log(`[lead-in detect] wall=${wall.id.slice(0, 8)}…`, {
          bodyBlockCode: makeup.bodyBlockCode,
          cornerBlockCode: makeup.cornerBlockCode,
          bodyWidthMm: bodyWidth,
          cornerWidthMm: cornerWidth,
          cubeDepthMm: cubeDepth,
          halfBodyModularMm: halfBodyModular,
          requiredLeadInModularMm: requiredLeadInModular,
          requiredLeadInWidthMm: requiredLeadInWidth,
          existingMakeupLeadInCode: makeup.cornerLeadInBlockCode ?? null,
          libraryCandidates: candidates.slice(0, 5).map((b) => ({
            code: b.code,
            widthMm: b.dimensions.widthMm,
          })),
          picked: match?.code ?? null,
          willApplyOverride: !!match && requiredLeadInModular >= 5,
        })
      }

      if (requiredLeadInModular < 5) return makeup // already on bond
      if (requiredLeadInWidth < 5) return makeup
      if (!match) return makeup
      return {
        ...makeup,
        cornerLeadInBlockCode: match.code,
        cornerLeadInCount: 1,
      }
    }

    // Lazily-built per-wall courses map for partner-cube-depth lookups
    // inside segmentsForStraightWall on mixed-series corners.
    let wallCoursesByIdCache: Record<string, ResolvedCourse[]> | undefined

    walls.forEach((wall, i) => {
      const thicknessMm = wallThicknessByWallId[wall.id] ?? 190

      if (wall.trade === 'brick') {
        // Brick walls render as a stacked grid of actual brick-sized
        // units. We look up the brick type's dimensions (default
        // standard 230×76×110), generate one course per brick height +
        // 10mm mortar joint, and pass a synthetic '__brick__' entry
        // into the library so segmentsForStraightWall reads the
        // right body width per cell. Same carve + jamb code path as
        // before; the smaller course height also means partial-height
        // openings line up against course boundaries cleanly.
        const heightMm = resolveWallHeightMm(wall, makeupsById, brickMakeupsById)
        const totalHeightM = heightMm / 1000
        // Cap-mesh prep — for walls with a topProfile, we render the
        // wall body as a normal rectangle (existing brick + mortar
        // pipeline, no rake clipping) and ADD a separate cap prism
        // mesh on top in the wall's body brick colour. The mesh is
        // a single triangle / trapezoid prism — clean silhouette,
        // no per-brick maths. Tally already accounts for the cap
        // area (see lib/wallTopProfile.ts), so the 3D pass is
        // purely cosmetic.
        const tp = wall.topProfile
        const wallLenM = Math.hypot(
          (wall.endX - wall.startX) / 1000,
          (wall.endY - wall.startY) / 1000,
        )

        // Resolve brick dimensions from the brick library via the
        // makeup's brickTypeCode. Falls back to AU standard if the
        // code isn't recognised (older/migrated makeups).
        const brickMakeup = brickMakeupsById[wall.makeupId]
        const brickType = brickMakeup?.brickTypeCode
          ? BRICK_LIBRARY[brickMakeup.brickTypeCode]
          : undefined
        const brickWidthMm = brickType?.widthMm ?? 230
        const brickHeightMm = brickType?.heightMm ?? 76
        const brickDepthMm = brickType?.depthMm ?? 110
        const BRICK_MORTAR_MM = 10
        const courseModularMm = brickHeightMm + BRICK_MORTAR_MM

        // Synthetic library entries so widthOf/heightOf calls inside
        // segmentsForStraightWall return THIS WALL'S brick dimensions
        // rather than block fallbacks (390mm wide etc.):
        //   __brick__       — full brick (body + owning-corner end)
        //   __brick_half__  — half brick (free-end even courses in
        //                     stretcher bond, creating the half-unit
        //                     offset between alternating courses)
        const brickLibrary: Record<string, Block> = {
          ...library,
          ['__brick__']: {
            code: '__brick__',
            name: brickType?.name ?? 'Brick',
            description: 'Brick wall unit',
            dimensions: {
              widthMm: brickWidthMm,
              heightMm: brickHeightMm,
              depthMm: brickDepthMm,
            },
            roles: ['body', 'corner'],
          } as Block,
          ['__brick_half__']: {
            code: '__brick_half__',
            name: `${brickType?.name ?? 'Brick'} (half)`,
            description: 'Half brick — stretcher bond end',
            dimensions: {
              widthMm: brickWidthMm / 2,
              heightMm: brickHeightMm,
              depthMm: brickDepthMm,
            },
            roles: ['end-termination'],
          } as Block,
        }

        // Colour: each wall TYPE (makeup) gets its own palette slot via
        // bandColor(wall.makeupId). Two walls sharing the same brick
        // library entry but different wall types still render in
        // distinct colours — keyed by makeupId, not by brickTypeCode.
        // Per-course range bricks (sill/head/middle bands) keep using
        // their brick code as the key so those bands still stand out
        // visually against the body colour.
        const brickWallTypePaletteKey = wall.makeupId
        const brickPaletteKey = brickWallTypePaletteKey
        const brickColorMap = new Map([['__brick__', bandColor(brickPaletteKey, palette)]])

        // Use the per-wall opening head adjustment computed once at
        // the top of this useMemo (doors → sill=0, windows → head at
        // wallHeight − 300 mm). Was inlined here for the brick path;
        // the upstream pass now applies the same rule to both block
        // and brick walls so the 3D view is consistent across trades.
        const brickOpenings = adjustedOpenings

        // Build brick courses bottom-up at the brick's modular
        // height, snapping the final course to the wall top so the
        // top edge stays flush (last course may be a partial-height
        // cut, like real masonry trimming the last course to fit).
        //
        // Bond alignment: corner-end widths come from the fudged
        // thickness map below (not from cornerCode). All courses can
        // share a single set of codes — segmentsForStraightWall
        // internally alternates ownership per course at corner
        // junctions, swapping end widths between cornerWidth (owning)
        // and the fudged neighbour thickness (non-owning) to produce
        // the half-brick offset stretcher bond needs.
        // Per-course brick type resolution from the makeup's
        // courseRanges. Each range starts at a given course number and
        // its brickTypeCode applies until the NEXT range begins (or to
        // the top of the wall if it's the last range). Course 1 falls
        // back to the makeup's primary brickTypeCode when no range
        // covers it explicitly. Same algorithm as
        // resolveBrickCourseSegments in brickCalc.ts so the 3D render
        // matches the tally bands exactly.
        // BELOW-COURSE semantics: each range's `fromCourse` value
        // (kept as the field name for back-compat with persistence)
        // means "this brick applies to courses BELOW this number".
        // Ranges sorted ascending; for each course, the FIRST range
        // where courseNum < range.fromCourse wins. Courses above
        // every range fall through to the makeup's default brick.
        const sortedRanges = [
          ...(brickMakeup?.courseRanges ?? []).filter(
            (r) =>
              Number.isFinite(r.fromCourse) &&
              r.fromCourse >= 1 &&
              !!r.brickTypeCode,
          ),
        ].sort((a, b) => a.fromCourse - b.fromCourse)
        const brickTypeForCourse = (courseNum: number): string => {
          for (const r of sortedRanges) {
            if (courseNum < r.fromCourse) return r.brickTypeCode
          }
          return brickMakeup?.brickTypeCode ?? ''
        }
        // Synthetic library + colour entries keyed per brick type so
        // segmentsForStraightWall reads the per-course brick width /
        // height / depth, and so the legend slot matches the renderer.
        // Each band gets its own pair of entries:
        //   __brick_<typeCode>__       — full brick at THIS type's dims
        //   __brick_<typeCode>_half__  — half brick at THIS type's dims
        const ensureSyntheticEntries = (code: string, isBodyDefault: boolean) => {
          const fullKey = `__brick_${code}__`
          const halfKey = `__brick_${code}_half__`
          if (brickLibrary[fullKey]) return { fullKey, halfKey }
          const bt = code ? BRICK_LIBRARY[code] : undefined
          const w = bt?.widthMm ?? brickWidthMm
          const h = bt?.heightMm ?? brickHeightMm
          const d = bt?.depthMm ?? brickDepthMm
          brickLibrary[fullKey] = {
            code: fullKey,
            name: bt?.name ?? 'Brick',
            description: 'Brick wall unit',
            dimensions: { widthMm: w, heightMm: h, depthMm: d },
            roles: ['body', 'corner'],
          } as Block
          brickLibrary[halfKey] = {
            code: halfKey,
            name: `${bt?.name ?? 'Brick'} (half)`,
            description: 'Half brick — stretcher bond end',
            dimensions: { widthMm: w / 2, heightMm: h, depthMm: d },
            roles: ['end-termination'],
          } as Block
          // Body courses paint with the wall-TYPE colour; range
          // overrides paint with their brick code so the band stays
          // distinct from the body. Falls back to the wall type key
          // when the range code is somehow blank.
          const colour = isBodyDefault
            ? bandColor(brickWallTypePaletteKey, palette)
            : bandColor(code || brickWallTypePaletteKey, palette)
          brickColorMap.set(fullKey, colour)
          brickColorMap.set(halfKey, colour)
          return { fullKey, halfKey }
        }
        const brickCourses: ResolvedCourse[] = []
        let cursorMm = 0
        let courseIdx = 0
        while (cursorMm < heightMm - 0.5) {
          const courseNum = courseIdx + 1
          const typeCode = brickTypeForCourse(courseNum)
          // A course is a "body default" when NO range applies — those
          // pick up the wall-type colour. Range-covered courses keep
          // their brick code as the palette key.
          const isBodyCourse = !sortedRanges.some(
            (r) => courseNum < r.fromCourse,
          )
          const bt = typeCode ? BRICK_LIBRARY[typeCode] : undefined
          const courseBrickHeight = bt?.heightMm ?? brickHeightMm
          const courseModMm = courseBrickHeight + BRICK_MORTAR_MM
          const { fullKey, halfKey } = ensureSyntheticEntries(typeCode, isBodyCourse)
          const y0Mm = cursorMm
          const y1Mm = Math.min(heightMm, cursorMm + courseBrickHeight)
          if (y1Mm - y0Mm > 0.5) {
            brickCourses.push({
              courseNumber: courseNum,
              y0: y0Mm / 1000,
              y1: y1Mm / 1000,
              bodyCode: fullKey,
              cornerCode: fullKey,
              halfCode: halfKey,
            })
          }
          cursorMm += courseModMm
          courseIdx++
        }
        // Opening sill / head no longer splits courses. The old
        // course-splitting pass tried to "snap" courses to opening
        // boundaries so the renderer wouldn't draw bricks straddling
        // an opening edge — but the split itself produced sliver
        // sub-courses (a course straddling y=900 became two strips
        // of 40 mm and 36 mm), and those slivers still rendered as
        // full-width bricks at squashed height, which looked like
        // random cut bricks in the middle of the wall. Letting
        // courses run at their natural height and trusting
        // segmentsForStraightWall to carve the body cells inside
        // opening x-spans gives a clean wall without any sliver
        // artefacts. The trade-off: bricks at the very edge of an
        // opening's sill / head are clipped by the opening void, the
        // same way a real bricklayer would cut a brick to fit.

        // Half-brick colour entries are now created per-band by
        // ensureSyntheticEntries above (each band has its own
        // __brick_<typeCode>_half__ key sharing the band's colour),
        // so no global half-brick colour mapping is needed.

        // Fudged thickness map for brick corners.
        //
        // segmentsForStraightWall reads
        // `wallThicknessByWallId[neighbour]` as the corner CUBE DEPTH
        // (the end-cell width on courses where the neighbour owns
        // the corner). Stretcher bond needs that to equal half THIS
        // wall's brick width — so we override the entry for EVERY
        // neighbour of this wall to be `brickWidthMm / 2`. The
        // neighbour's own rendering pass builds its own map from its
        // own perspective. Result: each brick wall sees a cube
        // depth that's exactly half its OWN brick width, so the bond
        // lines up perfectly regardless of whether the two walls at
        // the corner use the same brick type or different ones.
        //
        // Real box geometry stays at the actual wall thickness
        // (passed separately as `thicknessMm`), so the wall's
        // physical depth is unchanged.
        const brickCubeThicknessMap: Record<string, number> = { ...wallThicknessByWallId }
        const cubeHalfBrick = brickWidthMm / 2
        const startNeighbourIds = wall.startJunction.connectedWallIds ?? []
        const endNeighbourIds = wall.endJunction.connectedWallIds ?? []
        for (const nId of [...startNeighbourIds, ...endNeighbourIds]) {
          if (typeof nId === 'string') brickCubeThicknessMap[nId] = cubeHalfBrick
        }
        // Also override this wall's own entry so any internal
        // lookups (e.g. fallback paths) see the same value.
        brickCubeThicknessMap[wall.id] = cubeHalfBrick

        // ── Curved brick wall fast-path ───────────────────────────
        //
        // Curved walls bypass the straight-wall pipeline: no
        // openings, no trim, no jamb-mortar cover (curves don't
        // host openings yet — same constraint the block curve path
        // has). We feed the brick courses + synthetic library into
        // the shared segmentsForCurvedWall helper which lays the
        // bricks out along the outer arc length, then collect a
        // curved-mortar shell so the recessed joints read between
        // adjacent brick wedges.
        if (isCurvedWall(wall)) {
          outWedges.push(
            ...segmentsForCurvedWall(
              wall,
              thicknessMm,
              brickCourses,
              totalHeightM,
              'stretcher',
              brickColorMap,
              brickLibrary,
              brickCubeThicknessMap,
            ),
          )
          // Mortar shell sized to the largest brick width across all
          // courses — keeps the shell tucked behind the worst-case
          // chord midpoint on tight radii. Single brick width is the
          // common case; mixed-width course ranges pick up the max.
          let maxBrickWidthMm = brickWidthMm
          for (const c of brickCourses) {
            const w = brickLibrary[c.bodyCode]?.dimensions.widthMm ?? 0
            if (w > maxBrickWidthMm) maxBrickWidthMm = w
          }
          collectCurvedMortarShell(
            wall,
            thicknessMm,
            totalHeightM,
            maxBrickWidthMm,
            outMortarShells,
          )
          return
        }

        // ── Sill / head trim — anchored at opening edge ─────────────
        //
        // The trim brick uses its makeup dimensions (height + face
        // width) and ANCHORS at the opening edge:
        //   - Sill trim: top at sillHeightMm (= bottom of opening),
        //     bottom at sillHeightMm − trimHeight.
        //   - Head trim: bottom at openingHeadMm (= top of opening),
        //     top at openingHeadMm + trimHeight.
        // The trim is a row of full-size makeup bricks. Whatever body
        // course(s) it overlaps get FULLY carved (ghost opening that
        // covers the union of trim Y + overlapping course Y ranges,
        // so the body course is fully contained for carving). The
        // gap between the trim edge and the next intact body course
        // edge is filled with a thin body-coloured sliver (the "cut"
        // body brick) so the wall doesn't show a void.
        const trimMakeup = brickMakeup
        const trimGhostOpenings: Opening[] = []
        type TrimZone = {
          op: Opening
          kind: 'sill' | 'head'
          /** Trim brick render Y range — anchored to opening edge. */
          trimY0Mm: number
          trimY1Mm: number
          /** Body-sliver filler Y range — null if no cut needed. */
          fillerY0Mm: number | null
          fillerY1Mm: number | null
          startMm: number
          endMm: number
          brickFaceWidthMm: number
          /**
           * The trim brick's depth INTO the wall (perpendicular to
           * the wall face). Drives the rendered thickness — a header
           * brick (depth = 230 mm) extends past a 110 mm wall, so
           * `brickFaceDepthMm > wallThicknessMm` means the trim
           * sticks out front + back equally.
           */
          brickFaceDepthMm: number
          colour: string
          fillerColour: string
        }
        const trimYZones: TrimZone[] = []

        if (trimMakeup && (trimMakeup.sillBrickCode || trimMakeup.headBrickCode)) {
          const wallLenMmHere = Math.hypot(
            wall.endX - wall.startX,
            wall.endY - wall.startY,
          )
          const bodyColourFor = (course: { bodyCode: string } | undefined) => {
            if (!course) return DEFAULT_WALL_COLOR
            return brickColorMap.get(course.bodyCode) ?? DEFAULT_WALL_COLOR
          }
          for (const op of brickOpenings) {
            if (op.wallId !== wall.id) continue
            // Trim spans EXACTLY the opening width — no overhang.
            const startMm = Math.max(0, op.startAlongWallMm ?? 0)
            const endMm = Math.min(
              wallLenMmHere,
              (op.startAlongWallMm ?? 0) + op.widthMm,
            )
            if (endMm <= startMm + 1) continue

            // Resolve a brick type + orientation into:
            //   faceWMm — visible face width (along wall)
            //   faceHMm — visible face height (vertical)
            //   faceDMm — brick depth INTO the wall (perpendicular)
            //
            // Orientations:
            //   - stretcher: long face out — L along wall, D into wall,
            //                H vertical. Face = L × H = w × h. D = d.
            //   - soldier:   on end, long edge vertical — L vertical,
            //                D into wall, H along wall. Face = H × L.
            //                D = d (same as stretcher — depth
            //                unchanged when rotating around vertical).
            //   - rowlock:   on edge, depth showing as height —
            //                L along wall, D vertical, H into wall.
            //                Face = L × D. D-into-wall = h.
            //   - header:    flat, typical face UP, brick rolled 90°
            //                from rowlock — L into wall, H along wall,
            //                D vertical. Face = H × D (narrow, tall).
            //                D-into-wall = L = w. Header bricks are
            //                typically LONGER than the wall is thick,
            //                so they extend out front AND back of
            //                the wall equally.
            const orientedFace = (
              type: BrickType | undefined,
              orientation: 'stretcher' | 'soldier' | 'rowlock' | 'header' | undefined,
            ) => {
              const w = type?.widthMm ?? brickWidthMm
              const h = type?.heightMm ?? brickHeightMm
              const d = type?.depthMm ?? brickDepthMm
              switch (orientation) {
                case 'soldier':
                  return { faceWMm: h, faceHMm: w, faceDMm: d }
                case 'rowlock':
                  return { faceWMm: w, faceHMm: d, faceDMm: h }
                case 'header':
                  return { faceWMm: h, faceHMm: d, faceDMm: w }
                default:
                  return { faceWMm: w, faceHMm: h, faceDMm: d }
              }
            }

            // ── Sill trim ──
            // Doors skip the sill trim — opening reaches the floor,
            // so there's no sill course to lay bricks under.
            if (trimMakeup.sillBrickCode && op.kind !== 'door') {
              const sillType = BRICK_LIBRARY[trimMakeup.sillBrickCode]
              const {
                faceWMm: sillBrickWidthMm,
                faceHMm: sillBrickHeightMm,
                faceDMm: sillBrickDepthMm,
              } = orientedFace(sillType, trimMakeup.sillBrickOrientation)
              const trimY1Mm = op.sillHeightMm
              const trimY0Mm = Math.max(0, trimY1Mm - sillBrickHeightMm)
              if (trimY1Mm > trimY0Mm + 0.5) {
                // Body courses overlapping trim Y range
                const overlapping = brickCourses.filter((c) => {
                  const cY0 = c.y0 * 1000
                  const cY1 = c.y1 * 1000
                  return cY1 > trimY0Mm + 0.5 && cY0 < trimY1Mm - 0.5
                })
                // Ghost MUST fully contain every overlapping course
                // for the carving condition (op.sill ≤ courseY0 AND
                // op.head ≥ courseY1) to fire. Extend in both
                // directions to the union of overlap + trim.
                // Trim brick sits at its EXACT makeup height. Body
                // courses overlapping the trim Y range get carved by
                // the ghost; the gap between the trim's BOTTOM (for
                // sill) and the lowest carved course's bottom gets
                // filled with cut body bricks (individual bricks,
                // not a slab) so the bricklayer logic stays intact.
                let ghostY0Mm = trimY0Mm
                let ghostY1Mm = trimY1Mm
                let fillerY0Mm: number | null = null
                let fillerY1Mm: number | null = null
                let fillerColour = DEFAULT_WALL_COLOR
                if (overlapping.length > 0) {
                  const lowestY0Mm = Math.min(
                    ...overlapping.map((c) => c.y0 * 1000),
                  )
                  const highestY1Mm = Math.max(
                    ...overlapping.map((c) => c.y1 * 1000),
                  )
                  ghostY0Mm = Math.min(ghostY0Mm, lowestY0Mm)
                  ghostY1Mm = Math.max(ghostY1Mm, highestY1Mm)
                  // Body filler BELOW the trim — sits in solid wall.
                  // (Filler ABOVE the trim would be inside the
                  // opening void, so omitted for the sill case.)
                  if (lowestY0Mm < trimY0Mm - 0.5) {
                    fillerY0Mm = lowestY0Mm
                    fillerY1Mm = trimY0Mm
                    const bottomCourse = overlapping.reduce((a, b) =>
                      a.y0 < b.y0 ? a : b,
                    )
                    fillerColour = bodyColourFor(bottomCourse)
                  }
                }
                if (ghostY1Mm > ghostY0Mm + 0.5) {
                  trimGhostOpenings.push({
                    id: `${op.id}-sill-trim`,
                    wallId: op.wallId,
                    startAlongWallMm: startMm,
                    widthMm: endMm - startMm,
                    heightMm: ghostY1Mm - ghostY0Mm,
                    sillHeightMm: ghostY0Mm,
                  })
                }
                trimYZones.push({
                  op,
                  kind: 'sill',
                  trimY0Mm,
                  trimY1Mm,
                  fillerY0Mm,
                  fillerY1Mm,
                  startMm,
                  endMm,
                  brickFaceWidthMm: sillBrickWidthMm,
                  brickFaceDepthMm: sillBrickDepthMm,
                  colour: bandColor(trimMakeup.sillBrickCode, palette),
                  fillerColour,
                })
              }
            }

            // ── Head trim ──
            if (trimMakeup.headBrickCode) {
              const headType = BRICK_LIBRARY[trimMakeup.headBrickCode]
              const {
                faceWMm: headBrickWidthMm,
                faceHMm: headBrickHeightMm,
                faceDMm: headBrickDepthMm,
              } = orientedFace(headType, trimMakeup.headBrickOrientation)
              const trimY0Mm = op.sillHeightMm + op.heightMm
              const trimY1Mm = Math.min(
                totalHeightM * 1000,
                trimY0Mm + headBrickHeightMm,
              )
              if (trimY1Mm > trimY0Mm + 0.5) {
                const overlapping = brickCourses.filter((c) => {
                  const cY0 = c.y0 * 1000
                  const cY1 = c.y1 * 1000
                  return cY1 > trimY0Mm + 0.5 && cY0 < trimY1Mm - 0.5
                })
                let ghostY0Mm = trimY0Mm
                let ghostY1Mm = trimY1Mm
                let fillerY0Mm: number | null = null
                let fillerY1Mm: number | null = null
                let fillerColour = DEFAULT_WALL_COLOR
                if (overlapping.length > 0) {
                  const lowestY0Mm = Math.min(
                    ...overlapping.map((c) => c.y0 * 1000),
                  )
                  const highestY1Mm = Math.max(
                    ...overlapping.map((c) => c.y1 * 1000),
                  )
                  ghostY0Mm = Math.min(ghostY0Mm, lowestY0Mm)
                  ghostY1Mm = Math.max(ghostY1Mm, highestY1Mm)
                  // Body filler ABOVE the trim — sits in solid wall.
                  // Rendered as individual cut bricks below.
                  if (highestY1Mm > trimY1Mm + 0.5) {
                    fillerY0Mm = trimY1Mm
                    fillerY1Mm = highestY1Mm
                    const topCourse = overlapping.reduce((a, b) =>
                      a.y1 > b.y1 ? a : b,
                    )
                    fillerColour = bodyColourFor(topCourse)
                  }
                }
                if (ghostY1Mm > ghostY0Mm + 0.5) {
                  trimGhostOpenings.push({
                    id: `${op.id}-head-trim`,
                    wallId: op.wallId,
                    startAlongWallMm: startMm,
                    widthMm: endMm - startMm,
                    heightMm: ghostY1Mm - ghostY0Mm,
                    sillHeightMm: ghostY0Mm,
                  })
                }
                trimYZones.push({
                  op,
                  kind: 'head',
                  trimY0Mm,
                  trimY1Mm,
                  fillerY0Mm,
                  fillerY1Mm,
                  startMm,
                  endMm,
                  brickFaceWidthMm: headBrickWidthMm,
                  brickFaceDepthMm: headBrickDepthMm,
                  colour: bandColor(trimMakeup.headBrickCode, palette),
                  fillerColour,
                })
              }
            }
          }
        }

        const renderingOpenings = [...brickOpenings, ...trimGhostOpenings]
        out.push(
          ...segmentsForStraightWall(
            wall, renderingOpenings, thicknessMm, brickCourses, totalHeightM,
            'stretcher', brickColorMap, brickLibrary, brickCubeThicknessMap, wallsByIdMap,
            /* disableBlockLintels */ true,
            wallHeightMmByWallId,
          )
        )
        emitMortarForWall(wall, thicknessMm, totalHeightM, renderingOpenings)

        // ── Gable / raked cap mesh ─────────────────────────────────
        //
        // The tally already includes the cap area (sq m + lineal m
        // are what the brick estimate outputs). The 3D pass is
        // purely cosmetic, so render the cap as a single triangle
        // or trapezoid prism in the wall's body brick colour instead
        // of trying to slice individual bricks against the rake.
        // Clean silhouette, no peak / boundary subdivision maths
        // needed.
        if (tp && wallLenM > 0.001) {
          // Wall start + direction in WORLD METRES (matches the
          // negated mapping segmentsForStraightWall uses).
          const wsx = -wall.startX / 1000
          const wsz = -wall.startY / 1000
          const wex = -wall.endX / 1000
          const wez = -wall.endY / 1000
          const wdx = wex - wsx
          const wdz = wez - wsz
          const worldLen = Math.hypot(wdx, wdz)
          if (worldLen > 0.001) {
            const wdirX = wdx / worldLen
            const wdirZ = wdz / worldLen
            const perpX = -wdirZ
            const perpZ = wdirX
            const halfThick = thicknessMm / 1000 / 2
            const yBody = totalHeightM
            const capColor = bandColor(brickWallTypePaletteKey, palette)
            // Pre-compute the 2D silhouette of the cap as a list of
            // along-X / world-Y points (CCW around the polygon
            // viewed from +perp, i.e. from "front" of the wall).
            // Bottom edge runs from along=0 to along=worldLen on the
            // wall body's top. The top edge follows the rake — a
            // peak point for triangles, a single sloped line for
            // trapezoids.
            const silhouette: Array<{ alongM: number; y: number }> = []
            silhouette.push({ alongM: 0, y: yBody })
            if (tp.kind === 'triangle') {
              const peakAlong =
                Math.max(0, Math.min(1, tp.peakOffsetFraction)) * worldLen
              const peakY = yBody + Math.max(0, tp.peakHeightMm) / 1000
              if (peakAlong > 0.001 && peakAlong < worldLen - 0.001) {
                silhouette.push({ alongM: peakAlong, y: peakY })
              } else if (peakAlong <= 0.001) {
                silhouette[0] = { alongM: 0, y: peakY }
              } else {
                silhouette.push({ alongM: worldLen, y: peakY })
              }
            } else if (tp.kind === 'trapezoid') {
              const leftY = yBody + Math.max(0, tp.leftHeightMm) / 1000
              const rightY = yBody + Math.max(0, tp.rightHeightMm) / 1000
              silhouette[0] = { alongM: 0, y: leftY }
              silhouette.push({ alongM: worldLen, y: rightY })
            }
            // Always close the silhouette on the right end at the
            // wall body height (unless trapezoid which already
            // pushed that point).
            const last = silhouette[silhouette.length - 1]
            if (
              tp.kind === 'triangle' &&
              !(last.alongM === worldLen && last.y === yBody)
            ) {
              silhouette.push({ alongM: worldLen, y: yBody })
            }
            outCapMeshes.push({
              silhouette,
              wallStartWorld: { x: wsx, z: wsz },
              wdirX,
              wdirZ,
              perpX,
              perpZ,
              halfThick,
              color: capColor,
              wallBodyHeightM: yBody,
              // Texture tile size in world units. The U cycle is
              // ONE brick wide (the texture shows one brick across
              // its full width). The V cycle is TWO courses tall
              // because the texture stores TWO stagger-bonded
              // courses per V-cycle so RepeatWrapping naturally
              // gives stretcher bond. Without the ×2, the two
              // courses of pattern would compress into a single
              // course of geometry — the cap bricks would render
              // half as tall as the body bricks.
              brickModularWidthM: (brickWidthMm + BRICK_MORTAR_MM) / 1000,
              courseModularHeightM:
                2 * (brickHeightMm + BRICK_MORTAR_MM) / 1000,
            })
          }
        }

        // ── Jamb mortar cover ──────────────────────────────────────
        //
        // segmentsForStraightWall stamps a JAMB cell at every
        // opening edge with the bond's corner / half code. That
        // creates a 10 mm VERTICAL mortar joint between the jamb
        // brick and the body brick adjacent to it — visible at the
        // opening edge as a dark vertical column running the full
        // opening height. In real brickwork the body bond just
        // continues to the cut at the opening edge, so there's no
        // visible joint at the jamb position.
        //
        // We cover that visual gap by emitting a body-coloured box
        // at each jamb spanning the opening Y range, at the wall's
        // axial centerline + standard wall thickness. The cover
        // sits BEHIND the body / jamb brick faces (recessed
        // slightly) so it doesn't z-fight with them — it only fills
        // the 10 mm vertical mortar joint that would otherwise
        // expose the scene background.
        if (brickOpenings.some((o) => o.wallId === wall.id)) {
          // Use the SAME corner-extended endpoints as
          // segmentsForStraightWall — the cover's world position
          // must match the body bricks' world position or the
          // joint stays visible. wall.startX/endX alone is OFF by
          // the corner extension at corner / t-junction ends, which
          // is exactly the asymmetric "mortar protruding on the
          // left but not the right" the user noticed.
          const extJ = outerEdgeEndpoints(wall, brickCubeThicknessMap, wallsByIdMap)
          const sxJ = -extJ.startX / 1000
          const szJ = -extJ.startY / 1000
          const exJ = -extJ.endX / 1000
          const ezJ = -extJ.endY / 1000
          const dxJ = exJ - sxJ
          const dzJ = ezJ - szJ
          const wallLenMJ = Math.hypot(dxJ, dzJ)
          if (wallLenMJ > 0.001) {
            const dirXJ = dxJ / wallLenMJ
            const dirZJ = dzJ / wallLenMJ
            const yRotJ = Math.atan2(-dzJ, dxJ)
            // Pick the body code of a course AT the opening's Y
            // range, NOT the bottom-most course. For walls with
            // courseRanges (e.g. double-height bricks at lower
            // courses, standard bricks higher up), the bottom
            // course may be a completely different brick from the
            // one around the opening — using the wrong colour
            // makes the cover bleed through the mortar joints of
            // every body brick on this wall in the wrong colour.
            //
            // Picked per-opening below.
            // Cover thickness MUST be less than the mortar band's
            // thickness so the regular mortar between body bricks
            // (which fills horizontal joints and the vertical 6 mm
            // gaps within a course) wins the depth test against
            // the cover. Otherwise the cover shows through every
            // mortar joint on the wall in the cover's colour.
            // mortarBand thickness = wall × MORTAR_THICKNESS_FRAC
            // = ~96.8 mm for a 110 mm wall. Cover = mortar − 2 mm.
            const JAMB_COVER_THICKNESS_M =
              Math.max(
                0.001,
                (thicknessMm / 1000) * MORTAR_THICKNESS_FRAC - 0.002,
              )
            // Cover spans the FULL jamb width PLUS the opening edge
            // gap. There are TWO exposed mortar joints at each jamb:
            //   (1) body/jamb joint at (opStart - jambW)
            //   (2) jamb/opening edge gap at opStart (3 mm mortar
            //       inset on the jamb brick's edge facing the void)
            // And the jamb width alternates per course in stretcher
            // bond (full vs half brick). Use the FULL brick width
            // for the cover span and extend to the opening edge.
            // This handles all course alternations + both joints at
            // once. Recessed thickness so the body / jamb brick
            // faces render in front; the cover only fills the
            // gaps between bricks.
            const COVER_EDGE_INSET_MM = 6 // extends past body/jamb joint
            for (const op of brickOpenings) {
              if (op.wallId !== wall.id) continue
              const opStartMmJ = op.startAlongWallMm ?? 0
              const opEndMmJ = opStartMmJ + op.widthMm
              const opSillM = op.sillHeightMm / 1000
              const opHeadM = (op.sillHeightMm + op.heightMm) / 1000
              const heightM = opHeadM - opSillM
              if (heightM < 0.001) continue
              // Pick a body course whose Y range overlaps the
              // opening's centre — that course's bodyCode is the
              // colour the body bricks adjacent to the opening are
              // actually drawn with.
              const opMidY = (opSillM + opHeadM) / 2
              const coverCourse =
                brickCourses.find(
                  (c) => c.y0 <= opMidY && c.y1 >= opMidY,
                ) ?? brickCourses[brickCourses.length - 1] ?? brickCourses[0]
              const jambCoverColour =
                (coverCourse?.bodyCode &&
                  brickColorMap.get(coverCourse.bodyCode)) ??
                DEFAULT_WALL_COLOR
              // Other openings on the SAME wall, used to trim the
              // cover so it can't extend INTO an adjacent opening.
              // When two openings butt up against each other (shared
              // jamb), the un-trimmed cover lands inside the next
              // opening's void and renders as a body-colour column.
              // Clip each cover to the nearest neighbouring opening
              // edge to avoid that. When the cover collapses to zero
              // we emit a thin BLACK divider bar at the shared jamb
              // position so the reader can still see that there are
              // two separate openings.
              const siblingOps = brickOpenings.filter(
                (o) => o.wallId === wall.id && o !== op,
              )
              // Detect a sibling touching on the LEFT or RIGHT
              // (shared jamb). Used to emit the divider bar below.
              const SHARED_JAMB_TOUCH_MM = 1 // tolerance for "touch"
              const touchesLeft = siblingOps.some((so) => {
                const soEnd = (so.startAlongWallMm ?? 0) + so.widthMm
                return Math.abs(soEnd - opStartMmJ) < SHARED_JAMB_TOUCH_MM
              })
              const touchesRight = siblingOps.some(
                (so) =>
                  Math.abs((so.startAlongWallMm ?? 0) - opEndMmJ) <
                  SHARED_JAMB_TOUCH_MM,
              )
              // ── Left jamb cover ──
              // From (opStart − brickWidth − 6 mm) to opStart, clipped
              // by the nearest sibling opening to the LEFT (if any).
              {
                let leftStartMm = Math.max(
                  0,
                  opStartMmJ - brickWidthMm - COVER_EDGE_INSET_MM,
                )
                const leftEndMm = opStartMmJ
                // Trim against any sibling opening whose RIGHT edge
                // sits inside (leftStartMm, leftEndMm).
                for (const so of siblingOps) {
                  const soStart = so.startAlongWallMm ?? 0
                  const soEnd = soStart + so.widthMm
                  if (soEnd > leftStartMm && soEnd <= leftEndMm) {
                    leftStartMm = Math.max(leftStartMm, soEnd)
                  } else if (soStart < leftEndMm && soEnd >= leftEndMm) {
                    // sibling fully covers cover — skip entirely
                    leftStartMm = leftEndMm
                  }
                }
                if (leftEndMm > leftStartMm + 0.5) {
                  const centreM = (leftStartMm + leftEndMm) / 2 / 1000
                  const lenM = (leftEndMm - leftStartMm) / 1000
                  out.push({
                    cx: sxJ + dirXJ * centreM,
                    cy: (opSillM + opHeadM) / 2,
                    cz: szJ + dirZJ * centreM,
                    length: lenM,
                    heightM,
                    thickness: JAMB_COVER_THICKNESS_M,
                    yRotation: yRotJ,
                    color: jambCoverColour,
                    highlight: false,
                  })
                }
              }
              // ── Right jamb cover ──
              // From opEnd to (opEnd + brickWidth + 6 mm), clipped by
              // the nearest sibling opening to the RIGHT (if any).
              {
                const rightStartMm = opEndMmJ
                let rightEndMm = Math.min(
                  wallLenMJ * 1000,
                  opEndMmJ + brickWidthMm + COVER_EDGE_INSET_MM,
                )
                // Trim against any sibling opening whose LEFT edge
                // sits inside (rightStartMm, rightEndMm).
                for (const so of siblingOps) {
                  const soStart = so.startAlongWallMm ?? 0
                  const soEnd = soStart + so.widthMm
                  if (soStart >= rightStartMm && soStart < rightEndMm) {
                    rightEndMm = Math.min(rightEndMm, soStart)
                  } else if (soStart <= rightStartMm && soEnd > rightStartMm) {
                    rightEndMm = rightStartMm
                  }
                }
                if (rightEndMm > rightStartMm + 0.5) {
                  const centreM = (rightStartMm + rightEndMm) / 2 / 1000
                  const lenM = (rightEndMm - rightStartMm) / 1000
                  out.push({
                    cx: sxJ + dirXJ * centreM,
                    cy: (opSillM + opHeadM) / 2,
                    cz: szJ + dirZJ * centreM,
                    length: lenM,
                    heightM,
                    thickness: JAMB_COVER_THICKNESS_M,
                    yRotation: yRotJ,
                    color: jambCoverColour,
                    highlight: false,
                  })
                }
              }
              // ── Shared-jamb divider bar ───────────────────────
              // When this opening touches another on its RIGHT, emit
              // a thin black mullion at the shared jamb so the reader
              // can tell two openings apart even though there's no
              // structural body between them. Only the LEFT-side of
              // the pair emits (the RIGHT-side would otherwise
              // emit a duplicate at the same position).
              if (touchesRight) {
                const DIVIDER_WIDTH_MM = 30
                const dividerCentreMm = opEndMmJ
                const centreM = dividerCentreMm / 1000
                out.push({
                  cx: sxJ + dirXJ * centreM,
                  cy: (opSillM + opHeadM) / 2,
                  cz: szJ + dirZJ * centreM,
                  length: DIVIDER_WIDTH_MM / 1000,
                  heightM,
                  // Stand slightly proud of the wall plane so the
                  // bar is visible through the opening void.
                  thickness: thicknessMm / 1000 + 0.01,
                  yRotation: yRotJ,
                  color: '#0f172a',
                  highlight: false,
                })
              }
              void touchesLeft
            }
          }
        }

        // Emit trim bricks + body sliver fillers into the carved
        // Y-band. Trim brick uses the makeup brick's face width + the
        // anchored Y range (trimY0..trimY1, at the opening edge).
        // Filler is a single body-coloured strip in the leftover
        // sliver between the trim edge and the carved body course
        // boundary — the "cut brick" the user described. Thickness =
        // wall thickness exactly so trim + filler sit in plane with
        // the body wall.
        if (trimYZones.length > 0) {
          // Use the SAME corner-extended endpoints as
          // segmentsForStraightWall so trim X positions align with
          // body-brick X positions. wall.startX alone misaligns at
          // corner / t-junction ends (offset by the outer-edge
          // extension), which manifests as the mortar backing
          // pushing out further on one side than the other.
          const extT = outerEdgeEndpoints(wall, brickCubeThicknessMap, wallsByIdMap)
          const sxT = -extT.startX / 1000
          const szT = -extT.startY / 1000
          const exT = -extT.endX / 1000
          const ezT = -extT.endY / 1000
          const dxT = exT - sxT
          const dzT = ezT - szT
          const wallLenMT = Math.hypot(dxT, dzT)
          if (wallLenMT > 0.001) {
            const dirXT = dxT / wallLenMT
            const dirZT = dzT / wallLenMT
            const yRotT = Math.atan2(-dzT, dxT)
            const TRIM_MORTAR_MM = 10
            for (const z of trimYZones) {
              // Trim brick thickness = WALL thickness so the trim
              // course always sits FLUSH with the wall face,
              // regardless of orientation. The visible face width +
              // height still come from orientedFace (so e.g. a
              // header trim shows as a row of narrow tall bricks),
              // but the brick's depth into the wall is clamped to
              // the wall plane — no header bricks extending past
              // the front / back of the wall, no rowlock bricks
              // sitting inset from the wall face. Reads cleanly
              // across orientations and matches the standard
              // expectation that a course sits in plane with the
              // bricks around it.
              const trimThicknessM = thicknessMm / 1000
              // Kept as a noop reference so callers reading this
              // file see the orientation's actual depth is still
              // computed (the tally / future logic can use it).
              void z.brickFaceDepthMm
              const trimY0M = z.trimY0Mm / 1000
              const trimY1M = z.trimY1Mm / 1000

              // Mortar-coloured backing band runs the trim span at
              // slightly LESS depth than the trim bricks so the
              // 10 mm gaps between bricks read as recessed mortar
              // joints from EVERY view angle (front, back, side).
              // Using trim brick depth (not wall thickness) so a
              // header brick whose depth (230 mm) extends past the
              // wall still shows mortar through the gaps when viewed
              // from outside / inside / through the opening.
              //
              // X span is RECESSED 1 mm at each end so the backing's
              // left + right END FACES are hidden inside the first
              // and last trim brick. Without this recess the
              // backing's end face shows at the jamb as a brown
              // "mortar chunk extruding" past the wall plane
              // (because the band protrudes 60 mm front + back for
              // a header trim).
              const trimBackThicknessM =
                Math.max(0.001, trimThicknessM - 0.004)
              const BACKING_END_INSET_MM = 1
              const backingStartMm = z.startMm + BACKING_END_INSET_MM
              const backingEndMm = z.endMm - BACKING_END_INSET_MM
              const backingCentreM = (backingStartMm + backingEndMm) / 2 / 1000
              const backingLenM = (backingEndMm - backingStartMm) / 1000
              // Recess the backing 5 mm on the side that FACES the
              // opening void — top for sill (opening is above) and
              // bottom for head (opening is below) — so when you
              // look down at the sill from the room interior, the
              // brick tops read as flush instead of showing a wide
              // brown stripe in each mortar gap. The other end
              // stays flush with the trim brick edge so the mortar
              // joint visible from the front still reaches the
              // brick edge that abuts solid wall.
              const VOID_FACING_INSET_M = 0.005
              let backingY0M = trimY0M
              let backingY1M = trimY1M
              if (z.kind === 'sill') {
                backingY1M = trimY1M - VOID_FACING_INSET_M
              } else {
                backingY0M = trimY0M + VOID_FACING_INSET_M
              }
              out.push({
                cx: sxT + dirXT * backingCentreM,
                cy: (backingY0M + backingY1M) / 2,
                cz: szT + dirZT * backingCentreM,
                length: Math.max(0.001, backingLenM),
                heightM: Math.max(0.001, backingY1M - backingY0M),
                thickness: trimBackThicknessM,
                yRotation: yRotT,
                color: MORTAR_COLOR,
                highlight: false,
              })

              // Body filler — emitted as INDIVIDUAL CUT BRICKS at the
              // body bond's natural positions (alternating stretcher
              // stagger per course parity). The trim brick stays at
              // its makeup height; these cut bricks fill the gap
              // between the trim edge and the next body course
              // boundary, with widths CUT at the opening jambs the
              // way a real bricklayer would. Bricklayer logic
              // preserved: bond continues across the wall, no slab.
              if (
                z.fillerY0Mm !== null &&
                z.fillerY1Mm !== null &&
                z.fillerY1Mm - z.fillerY0Mm > 1
              ) {
                const fY0M = z.fillerY0Mm / 1000
                const fY1M = z.fillerY1Mm / 1000
                const fillerCY = (fY0M + fY1M) / 2
                const fillerHM = Math.max(0.001, fY1M - fY0M)
                const FILLER_MORTAR_MM = 10
                const fillerModularMm = brickWidthMm + FILLER_MORTAR_MM
                // Bond stagger — the course we're filling is the
                // CARVED body course (the one the ghost opening
                // removed). For head trim that's the course whose
                // top (y1) matches fillerY1Mm; for sill trim it's
                // the course whose bottom (y0) matches fillerY0Mm.
                // Read parity from THAT course so the cut bricks
                // continue the natural body bond stagger.
                const refCourse =
                  z.kind === 'head'
                    ? brickCourses.find(
                        (c) =>
                          Math.abs(c.y1 * 1000 - z.fillerY1Mm!) < 1,
                      )
                    : brickCourses.find(
                        (c) =>
                          Math.abs(c.y0 * 1000 - z.fillerY0Mm!) < 1,
                      )
                const courseNumber = refCourse?.courseNumber ?? 1
                const isEvenCourse = courseNumber % 2 === 0
                const bondOffsetMm = isEvenCourse ? -brickWidthMm / 2 : 0

                // Mortar BAND under the cut bricks — the ghost
                // opening blocked emitMortarForWall in this Y
                // range, so without our own band the 10 mm gaps
                // between cut bricks would show the scene
                // background. Thickness is recessed so cut bricks
                // (at full wall thickness) render in front; mortar
                // shows only in the gaps between bricks.
                const cutMortarThicknessM =
                  (thicknessMm / 1000) * MORTAR_THICKNESS_FRAC
                const cutMortarCentreM =
                  (z.startMm + z.endMm) / 2 / 1000
                const cutMortarLenM = (z.endMm - z.startMm) / 1000
                out.push({
                  cx: sxT + dirXT * cutMortarCentreM,
                  cy: fillerCY,
                  cz: szT + dirZT * cutMortarCentreM,
                  length: Math.max(0.001, cutMortarLenM),
                  heightM: fillerHM,
                  thickness: cutMortarThicknessM,
                  yRotation: yRotT,
                  color: MORTAR_COLOR,
                  highlight: false,
                })
                // Walk body bond positions across the wall and
                // clip each brick to the trim X span. Cuts at the
                // jambs are real cuts — that's the brick that
                // would be physically chiselled on site.
                let bxStartMm = bondOffsetMm
                while (bxStartMm < z.endMm) {
                  const bxEndMm = bxStartMm + brickWidthMm
                  const cxStartMm = Math.max(bxStartMm, z.startMm)
                  const cxEndMm = Math.min(bxEndMm, z.endMm)
                  if (cxEndMm > cxStartMm + 1) {
                    const alongCentreM = (cxStartMm + cxEndMm) / 2 / 1000
                    const widthM = (cxEndMm - cxStartMm) / 1000
                    out.push({
                      cx: sxT + dirXT * alongCentreM,
                      cy: fillerCY,
                      cz: szT + dirZT * alongCentreM,
                      length: Math.max(0.001, widthM),
                      heightM: fillerHM,
                      // Body brick thickness — full wall thickness.
                      thickness: thicknessMm / 1000,
                      yRotation: yRotT,
                      color: z.fillerColour,
                      highlight: false,
                    })
                  }
                  bxStartMm += fillerModularMm
                }
              }
              // Legacy slab emission — disabled; left in place as a
              // structural marker (the `if` above replaced its push)
              if (false) {
                out.push({
                  cx: sxT + dirXT * backingCentreM,
                  cy: (z.fillerY0Mm! + z.fillerY1Mm!) / 2 / 1000,
                  cz: szT + dirZT * backingCentreM,
                  length: 0.001,
                  heightM: 0.001,
                  thickness: trimThicknessM,
                  yRotation: yRotT,
                  color: z.fillerColour,
                  highlight: false,
                })
              }

              // Lay each trim brick at its makeup face width across
              // the trim X span. Final brick clamps to the span end
              // if it would overshoot.
              const modularMm = z.brickFaceWidthMm + TRIM_MORTAR_MM
              const totalSpanMm = z.endMm - z.startMm
              const brickCount = Math.max(
                1,
                Math.ceil(totalSpanMm / modularMm),
              )
              let cursorMm = z.startMm
              for (let i = 0; i < brickCount; i++) {
                const remainMm = z.endMm - cursorMm
                if (remainMm < 1) break
                const widthMm = Math.min(z.brickFaceWidthMm, remainMm)
                if (widthMm < 1) break
                const startMm = cursorMm
                const endMm = startMm + widthMm
                const alongCentreM = (startMm + endMm) / 2 / 1000
                const widthM = (endMm - startMm) / 1000
                out.push({
                  cx: sxT + dirXT * alongCentreM,
                  cy: (trimY0M + trimY1M) / 2,
                  cz: szT + dirZT * alongCentreM,
                  length: Math.max(0.001, widthM),
                  heightM: Math.max(0.001, trimY1M - trimY0M),
                  thickness: trimThicknessM,
                  yRotation: yRotT,
                  color: z.colour,
                  highlight: false,
                })
                // Advance by full modular even when the brick was
                // clamped — keeps the tally formula matching the
                // box count (ceil(span / modular)).
                cursorMm += modularMm
              }
            }
          }
        }
        return
      }

      const wr = wallResolutions[i]
      if (!wr || !wr.makeup) return
      // Build the per-wall courses map for partner cube-depth lookups
      // — passed into segmentsForStraightWall so corner cube depth on
      // each course uses the partner's actual block at the same Y.
      if (!wallCoursesByIdCache) {
        wallCoursesByIdCache = {}
        for (let j = 0; j < walls.length; j++) {
          const wj = walls[j]
          const wrj = wallResolutions[j]
          if (wj && wrj?.courses) wallCoursesByIdCache[wj.id] = wrj.courses
        }
      }
      const bondType = wr.makeup.bondType
      if (isCurvedWall(wall)) {
        outWedges.push(
          ...segmentsForCurvedWall(
            wall, thicknessMm, wr.courses, wr.totalHeightM,
            bondType, colorMap, library, wallThicknessByWallId
          )
        )
        // Curved-wall mortar shell — recessed curved sweep behind the
        // block faces so the per-block edge insets read as real mortar
        // joints. Rendered later as a smooth BufferGeometry (shared
        // seam vertices) so the curve doesn't break into facet bands.
        //
        // Max block width drives the sagitta-aware recess so the shell
        // stays behind the worst-case block chord midpoint on tight
        // curves. Body / corner / half codes across every course in
        // this wall's makeup, fall back to 390 mm (standard AU body)
        // if no library entry resolves.
        let maxBlockWidthMm = 0
        for (const c of wr.courses) {
          for (const code of [c.bodyCode, c.cornerCode, c.halfCode]) {
            const w = library[code]?.dimensions.widthMm ?? 0
            if (w > maxBlockWidthMm) maxBlockWidthMm = w
          }
        }
        if (maxBlockWidthMm <= 0) maxBlockWidthMm = 390
        collectCurvedMortarShell(
          wall, thicknessMm, wr.totalHeightM, maxBlockWidthMm, outMortarShells
        )
      } else {
        // Use the tally-aligned layout path when the wall has no
        // openings. The layout enumerates exactly the blocks the
        // export tally counts (verifyLayoutMatchesTally confirms it
        // at dev-time), so what the user sees IS what gets exported.
        //
        // Openings still take the legacy path until planWallLayout
        // learns to emit jambs / lintels / body-subtraction under
        // openings. Tracked as the follow-up to task #62.
        const wallHasOpenings = adjustedOpenings.some((o) => o.wallId === wall.id)
        if (!wallHasOpenings) {
          // Corner ownership: at each shared corner, only ONE wall
          // emits the corner block per course (alternating per
          // course). The cumulative count across both walls matches
          // calculateProjectTally's deduplicated total — and gives
          // visible stretcher-bond alternation at corners in 3D.
          //
          // Passing wallsByIdMap activates the corner-count-aware
          // sort, so a corner-to-corner wall takes priority over its
          // corner+free neighbours at both ends and gets a symmetric
          // Course 1 (owns both corners or neither, never one).
          const ownership = cornerOwnershipFor(
            wall,
            wallsByIdMap,
            wallThicknessByWallId
          )
          // Lead-in auto-detection disabled — the per-course cut block
          // emission (planWallLayout's startCutWidthMm / endCutWidthMm)
          // now handles getting the body grid back on bond after a
          // deep-series corner, so we no longer need to inject a
          // standalone lead-in block (30.02 etc). Any walls that still
          // have `cornerLeadInBlockCode` hand-set in their makeup will
          // continue to emit those blocks; only the auto-override is
          // turned off.
          void resolveLeadInForWall
          const effectiveMakeup = wr.makeup
          const layout = planWallLayout(
            wall,
            effectiveMakeup,
            [],
            wallThicknessByWallId,
            wallsByIdMap,
            ownership
          )
          // Dev-time sanity check: layout aggregated → tally check.
          // With ownership applied, the per-wall tally is below
          // calculateWallTally by design (corners deduplicated), so
          // the verifier no-ops in this mode. Project-level
          // verification would need a separate pass across all walls
          // — a TODO once openings + curves are handled too.
          if (import.meta.env.DEV) {
            const check = verifyLayoutMatchesTally(
              layout,
              wall,
              wr.makeup,
              [],
              wallThicknessByWallId,
              wallsByIdMap,
              /* cornerOwnershipApplied */ true
            )
            if (!check.ok) {
              // eslint-disable-next-line no-console
              console.warn(
                `[3D layout] tally mismatch for wall ${wall.id}:`,
                check.differences
              )
            }
            // Per-wall corner diagnostic — surfaces the resolved
            // cornerBlock code, its widthMm, junction type at each
            // end, and the ownership phase at each end. If a wall's
            // corner block is rendering at the wrong width or never
            // alternating, this log makes it obvious which wall.
            const startConnected = wall.startJunction.connectedWallIds ?? []
            const endConnected = wall.endJunction.connectedWallIds ?? []
            const cornerCode = wr.makeup.cornerBlockCode
            const cornerBlockDef = library[cornerCode]
            const startInfo = startConnected.length
              ? [wall.id, ...startConnected].sort()
              : null
            const endInfo = endConnected.length
              ? [wall.id, ...endConnected].sort()
              : null
            // eslint-disable-next-line no-console
            console.log(
              `[3D corner] wall=${wall.id.slice(0, 8)}…`,
              {
                startJunction: wall.startJunction.type,
                startConnected,
                startMyIdx: startInfo ? startInfo.indexOf(wall.id) : null,
                startPhase: startInfo
                  ? `1/${startInfo.length}`
                  : 'n/a',
                endJunction: wall.endJunction.type,
                endConnected,
                endMyIdx: endInfo ? endInfo.indexOf(wall.id) : null,
                endPhase: endInfo ? `1/${endInfo.length}` : 'n/a',
                cornerCode,
                cornerWidthMm: cornerBlockDef?.dimensions.widthMm,
                halfCode: wr.makeup.halfBlockCode,
                halfWidthMm: wr.makeup.halfBlockCode
                  ? library[wr.makeup.halfBlockCode]?.dimensions.widthMm
                  : undefined,
                thicknessMm,
                bondType,
              }
            )
          }
          out.push(
            ...segmentsFromWallLayout(
              wall,
              layout,
              thicknessMm,
              colorMap,
              library,
              wallsByIdMap,
              wallThicknessByWallId,
              wr.makeup,
              wallCoursesByIdCache,
            )
          )
        } else {
          out.push(
            ...segmentsForStraightWall(
              wall, adjustedOpenings, thicknessMm, wr.courses, wr.totalHeightM,
              bondType, colorMap, library, wallThicknessByWallId, wallsByIdMap,
              /* disableBlockLintels */ false,
              wallHeightMmByWallId,
              wallCoursesByIdCache,
              // Same ownership the no-openings layout path uses — keeps
              // corner alternation consistent across the two paths and
              // matches the export tally's corner deduplication.
              cornerOwnershipFor(wall, wallsByIdMap, wallThicknessByWallId),
              DEFAULT_MORTAR_JOINT_MM / 1000,
            )
          )
        }
        // Same mortar fill as brick walls — recessed behind the block
        // faces, inset from the outer envelope so its side / top /
        // bottom box faces tuck behind the block faces, skipped
        // wherever openings carve voids.
        if (!isCurvedWall(wall)) {
          emitMortarForWall(
            wall,
            thicknessMm,
            wr.totalHeightM,
            adjustedOpenings,
            wr.courses
          )
        }
      }
    })

    // ── Pier segments ──
    // Each pier becomes a vertical stack of boxes — one per course in
    // the makeup's coursePattern (cycling). Block dims drive the
    // footprint: widthMm × depthMm × heightMm.
    //
    // CRITICAL: world coords are the NEGATED mm coords (see the wall
    // renderer's `-ext.startX / 1000` lines). Without the negation
    // piers land in a mirrored position off in the distance and the
    // user thinks the pier didn't draw.
    const COURSE_FALLBACK_MM = 200
    const wallsByIdForPiers = new Map(walls.map((w) => [w.id, w]))
    for (const pier of piers) {
      const pm = pier.pierMakeupId
        ? pierMakeupsById[pier.pierMakeupId]
        : undefined
      const pattern =
        pm?.coursePattern && pm.coursePattern.length > 0
          ? pm.coursePattern
          : []
      if (pattern.length === 0) continue

      // Total height — tied inherits wall, freestanding uses its own.
      let totalHeightMm: number
      let cxM = 0
      let czM = 0
      let yRotation = 0
      if (pier.type === 'tied') {
        const wall = wallsByIdForPiers.get(pier.wallId)
        if (!wall || isCurvedWall(wall)) continue
        totalHeightMm = resolveWallHeightMm(
          wall,
          makeupsById,
          brickMakeupsById
        )
        // Same negate-then-divide convention as the wall renderer
        // (see WorkspaceView3D.tsx ~line 470). Walk from the negated
        // start to the negated end so the pier lands ON the wall.
        const sxW = -wall.startX / 1000
        const szW = -wall.startY / 1000
        const exW = -wall.endX / 1000
        const ezW = -wall.endY / 1000
        const dxW = exW - sxW
        const dzW = ezW - szW
        const wallLenM = Math.hypot(dxW, dzW)
        if (wallLenM === 0) continue
        const t = Math.max(0, Math.min(1, pier.alongMm / 1000 / wallLenM))
        cxM = sxW + dxW * t
        czM = szW + dzW * t
        yRotation = Math.atan2(-dzW, dxW)
      } else {
        totalHeightMm = pier.heightMm
        cxM = -pier.x / 1000
        czM = -pier.y / 1000
      }

      // Course module = block height + mortar joint. Masonry convention
      // is that a 190 mm block carries a 10 mm bed joint above it, so
      // each course occupies 200 mm vertically. Total pier height =
      // courseCount × courseModule, which lines up with how walls
      // count courses (e.g. a 2000 mm pier is exactly 10 courses of
      // 200 mm).
      //
      // Mortar render strategy matches the wall's emitMortarForWall:
      // a single column of MORTAR_COLOR runs the pier's full height,
      // recessed inward (cross-section × MORTAR_THICKNESS_FRAC) so the
      // block faces sit proud of the mortar plane. The 10 mm gap
      // between each course's block reveals the mortar column behind,
      // reading as a true joint line rather than the empty dark
      // scene bg.
      const MORTAR_MM = 10
      const mortarM = MORTAR_MM / 1000
      const firstBlock = library[pattern[0]]
      const firstBlockHeightMm =
        firstBlock?.dimensions.heightMm ?? 190
      const firstBlockWidthMm = firstBlock?.dimensions.widthMm ?? 390
      const firstBlockDepthMm = firstBlock?.dimensions.depthMm ?? 190
      const courseModuleMm = firstBlockHeightMm + MORTAR_MM
      const courseCount = Math.max(
        1,
        Math.floor(totalHeightMm / courseModuleMm)
      )
      const totalPierHeightM = (courseCount * courseModuleMm) / 1000

      // Mortar column — sits behind the block faces, recessed inward
      // on both width + depth so it's hidden by the blocks where they
      // overlap, visible only through the joint gaps.
      out.push({
        cx: cxM,
        cy: totalPierHeightM / 2,
        cz: czM,
        length: (firstBlockWidthMm / 1000) * MORTAR_THICKNESS_FRAC,
        thickness: (firstBlockDepthMm / 1000) * MORTAR_THICKNESS_FRAC,
        heightM: totalPierHeightM,
        yRotation,
        color: MORTAR_COLOR,
        highlight: false,
      })

      let yCursorM = 0
      for (let i = 0; i < courseCount; i++) {
        const code = pattern[i % pattern.length]
        const block = library[code]
        const widthMm = block?.dimensions.widthMm ?? 390
        const depthMm = block?.dimensions.depthMm ?? 190
        const blockHeightMm = block?.dimensions.heightMm ?? 190
        // Block renders at FULL face dimensions (width × depth ×
        // block-height). No inset on width/depth — piers are one
        // block wide per course, so there's no neighbour to leave a
        // visual gap against. The mortar joint is the gap above the
        // block (next course bottom sits at yCursor + blockHeight +
        // MORTAR_MM), and the recessed mortar column above shows
        // through it.
        const widthM = widthMm / 1000
        const depthM = depthMm / 1000
        const blockHeightM = blockHeightMm / 1000
        out.push({
          cx: cxM,
          cy: yCursorM + blockHeightM / 2,
          cz: czM,
          length: widthM,
          heightM: blockHeightM,
          thickness: depthM,
          yRotation,
          color: bandColor(code, palette),
          highlight: false,
        })
        yCursorM += blockHeightM + mortarM
      }
    }

    // Bounds for ground plane + orbit target.
    // The plan-as-floor (when present) is also factored into the
    // sizeMax — otherwise a pier-only scene gets a tiny ~0.4m
    // bounds, the fog (sizeMax * 2..*8) crushes everything around
    // the pier into the clear-colour, and the pan multiplier
    // (proportional to sceneSize) feels glacial. Plan footprint
    // gives the camera + fog a sensible extent to work with.
    const planExtentM = planTexture
      ? Math.max(planTexture.widthM, planTexture.heightM)
      : 0
    let bounds: { centerX: number; centerZ: number; sizeMax: number } = {
      centerX: 0,
      centerZ: 0,
      sizeMax: Math.max(20, planExtentM),
    }
    if (out.length > 0 || outWedges.length > 0) {
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity
      for (const s of out) {
        const r = Math.max(s.length, s.thickness) / 2
        minX = Math.min(minX, s.cx - r)
        maxX = Math.max(maxX, s.cx + r)
        minZ = Math.min(minZ, s.cz - r)
        maxZ = Math.max(maxZ, s.cz + r)
      }
      // Wedges contribute their four ground-plane corners — same min /
      // max sweep used for boxes, just with the explicit corner list.
      for (const w of outWedges) {
        const xs = [w.outerStart.x, w.outerEnd.x, w.innerEnd.x, w.innerStart.x]
        const zs = [w.outerStart.z, w.outerEnd.z, w.innerEnd.z, w.innerStart.z]
        for (const x of xs) {
          if (x < minX) minX = x
          if (x > maxX) maxX = x
        }
        for (const z of zs) {
          if (z < minZ) minZ = z
          if (z > maxZ) maxZ = z
        }
      }
      bounds = {
        centerX: (minX + maxX) / 2,
        centerZ: (minZ + maxZ) / 2,
        // 4 m absolute floor, plus the plan extent if a plan-as-floor
        // is mounted, so a lone pier inherits the plan's room instead
        // of collapsing to a 0.4m frustum.
        sizeMax: Math.max(maxX - minX, maxZ - minZ, planExtentM, 4),
      }
    }
    // Gather every code → colour pair that actually ends up rendered
    // (includes makeup-declared codes, per-course resolved fractions
    // and lintels via the block colorMap, plus per-makeup brick TYPE
    // codes for brick walls — synthetic placeholders like __brick__
    // are skipped because they're not meaningful in a legend).
    const codes = new Map<string, string>()
    for (const [code, color] of colorMap) {
      if (code.startsWith('__')) continue
      codes.set(code, color)
    }
    for (const wall of walls) {
      if (wall.trade !== 'brick') continue
      const m = brickMakeupsById[wall.makeupId]
      if (!m) continue
      // Brick legend lists one entry per wall TYPE — the makeup name
      // with its body colour. Range / sill / head brick codes are
      // intentionally NOT surfaced as separate legend rows: the user
      // wants the legend to read as "these are the walls in the
      // model" rather than "these are the brick codes". The 3D
      // scene still paints those bands in their per-code colour so
      // the bands are visually distinct, just unlabelled.
      const wtKey = `wt:${m.id}`
      if (!codes.has(wtKey)) {
        codes.set(wtKey, bandColor(m.id, palette))
      }
    }
    // Pier block codes — piers render via bandColor directly without
    // going through the wall-side colorMap, so without this loop the
    // legend would miss every block code that ONLY appears in pier
    // course patterns. Walks each pier's makeup pattern and adds any
    // codes not already in the wall side.
    for (const pier of piers) {
      const pm = pier.pierMakeupId ? pierMakeupsById[pier.pierMakeupId] : undefined
      const pattern = pm?.coursePattern ?? []
      for (const code of pattern) {
        if (!code || code.startsWith('__')) continue
        if (!codes.has(code)) {
          codes.set(code, bandColor(code, palette))
        }
      }
    }
    return {
      segments: out,
      wedges: outWedges,
      mortarShells: outMortarShells,
      capMeshes: outCapMeshes,
      segmentBounds: bounds,
      resolvedCodes: codes,
    }
  }, [
    walls,
    openings,
    makeupsById,
    brickMakeupsById,
    wallThicknessByWallId,
    library,
    piers,
    pierMakeupsById,
    pierColorByPierId,
    planTexture,
    palette,
  ])

  // Bubble the resolved code/colour map up to the parent so it can
  // render the legend overlay matching exactly what's in the scene.
  useEffect(() => {
    onResolvedCodes(resolvedCodes)
  }, [resolvedCodes, onResolvedCodes])

  return (
    <>
      {/* Scene fog — fades the far ground plane into the canvas
          clearColor so the user never sees the plane's edge. The fog
          extends in metres, sized off the scene's overall extent. */}
      <fog
        attach="fog"
        args={[
          sceneBgFor(theme),
          segmentBounds.sizeMax * 2,
          segmentBounds.sizeMax * 8,
        ]}
      />
      <ambientLight intensity={0.6} />
      <directionalLight position={[10, 20, 10]} intensity={0.8} />

      {/* Ground plane — sized to a HUGE multiple of the scene so its
          edge never reaches the camera, even when the user pans /
          orbits / zooms far out. We also drop it a couple of cm
          below the wall base so the wall meshes never z-fight with
          the plane at the corners.

          Two-sided so looking at the ground from below (e.g. an
          underground cutaway angle the user might pan into) still
          paints something instead of going black. */}
      {/* No-PDF mode: render the empty-workspace page footprint as a
          grid "plan" floor. The 2D view shows an A1 sheet at the
          project's scale ratio as a grid-paper backdrop; mirror that
          in 3D by sizing the grid to the same real-world dimensions
          (pageWidthMm × pageScaleRatio).
          - cellSize: 1m, light line
          - sectionSize: 5m, brighter / thicker line
          followCamera=false so the grid stays anchored to the page
          footprint instead of dragging with the camera. */}
      {!planTexture && (() => {
        // Real-world page dimensions in metres. Default to A1 at 1:100
        // (84.1 × 59.4 m) if the props aren't passed — same fallback the
        // empty-workspace seed uses, so a 3D view opened before the
        // first calibration still gets a sensible-looking floor.
        const pageW = pageWidthMm && pageScaleRatio
          ? (pageWidthMm * pageScaleRatio) / 1000
          : 84.1
        const pageH = pageHeightMm && pageScaleRatio
          ? (pageHeightMm * pageScaleRatio) / 1000
          : 59.4
        return (
          <>
            {/* Dark backing fills the page footprint so a low-angle
                camera doesn't see through to the void underneath the
                grid lines. Slightly larger than the grid so the page
                edge reads as a clean rectangle. */}
            <mesh
              rotation={[-Math.PI / 2, 0, 0]}
              position={[-pageW / 2, -0.02, -pageH / 2]}
            >
              <planeGeometry args={[pageW, pageH]} />
              <meshStandardMaterial color={groundColorFor(theme)} side={THREE.DoubleSide} />
            </mesh>
            <Grid
              position={[-pageW / 2, -0.01, -pageH / 2]}
              args={[pageW, pageH]}
              cellSize={1}
              cellThickness={0.6}
              // Blueprint feel: floor + grid contrast inverts with theme
              // so a dark room reads as the cool blueprint look, and a
              // light room reads as a faint pencil grid on warm paper.
              // Cell tone is the "secondary" line weight (~slate-500 / -400).
              cellColor={theme === 'light' ? '#94a3b8' : '#64748b'}
              sectionSize={5}
              sectionThickness={1.2}
              // Section lines (every 5m) get the stronger tone in each
              // theme: near-white on dark, dark slate on light. Matches
              // the heavy / light line pattern of a real CAD plan.
              sectionColor={theme === 'light' ? '#475569' : '#cbd5e1'}
              fadeDistance={Math.max(pageW, pageH) * 2}
              fadeStrength={1.2}
              followCamera={false}
              infiniteGrid={false}
            />
          </>
        )
      })()}

      {/* Plan-as-floor: when the host has rasterised the current PDF
          page, render it as a horizontal plane sized to its real-world
          footprint (page_mm × scale_ratio). Sits at y=-0.015 — above
          the dark ground plane (-0.02) to avoid z-fighting, below the
          wall base (y=0) so the bottom course visually rests on it.

          Position centres the plane at (-w/2, -h/2) so its extent
          matches the building's world-negative-quadrant coords. The
          texture itself is 180°-mirrored (both U and V) at rasterise
          time to compensate for the 3D renderer's wall X/Y negation,
          landing image (0,0) at world (0,0). DoubleSide so the plane
          stays visible regardless of which face the rotation points
          upward. */}
      {planTexture && (
        <mesh
          rotation={[-Math.PI / 2, 0, 0]}
          position={[-planTexture.widthM / 2, -0.015, -planTexture.heightM / 2]}
        >
          <planeGeometry args={[planTexture.widthM, planTexture.heightM]} />
          <meshBasicMaterial
            map={planTexture.texture}
            toneMapped={false}
            side={THREE.DoubleSide}
          />
        </mesh>
      )}

      {/* Boxes batched as InstancedMesh per (colour, highlight) group.
          With brick walls now emitting ~300 unit-sized bricks per wall
          plus per-cell mortar strips, a 30-wall project balloons past
          15k individual meshes — each its own draw call + React
          reconciliation. Grouping by colour means one instanced draw
          call per palette slot (16-ish total) regardless of brick
          count, which is what keeps interactive orbit / pan / zoom
          smooth on integrated GPUs. */}
      <InstancedSegments segments={segments} />

      {/* Curved-wall blocks — trapezoidal wedges merged per colour into
          a single BufferGeometry so each palette colour is one draw
          call, mirroring the InstancedSegments batching above. */}
      <WedgeSegments wedges={wedges} />

      {/* Curved-wall mortar shell — one smooth ring-section mesh per
          curved wall, recessed behind the block faces so the per-block
          edge insets read as real mortar joints. */}
      <CurvedMortarShells shells={mortarShells} />

      {/* Solid cap prisms for walls with a gable / raked topProfile.
          Each cap is a single extruded silhouette in the wall's body
          brick colour — cosmetic only, tally already accounts for the
          cap area. Empty array for walls without a topProfile. */}
      <CapMeshes meshes={capMeshes} />

      {/* InitialCameraAim must render BEFORE CADControls so its
          lookAt is applied before the controls seed their spherical
          state from camera.position. */}
      <InitialCameraAim
        targetX={segmentBounds.centerX}
        targetZ={segmentBounds.centerZ}
      />
      <CaptureExposer />
      {/* AutoCAD / Revit-style camera. Middle-mouse drag pans, shift
          + middle orbits around the target, right-drag is a trackpad
          fallback for orbit/pan, wheel zooms toward the cursor. */}
      <CADControls
        initialTargetX={segmentBounds.centerX}
        initialTargetZ={segmentBounds.centerZ}
        sceneSizeMax={segmentBounds.sizeMax}
        navStyle={navStyle}
      />
    </>
  )
}

// ---------- Top-level export ----------

const NAV_STYLE_STORAGE_KEY = 'beme:3d-nav-style'

/** Read the persisted nav style from localStorage, falling back to
 *  AutoCAD-style (the construction-industry default the user picked
 *  initially). Safe inside React rendering — localStorage reads are
 *  synchronous and never throw on the supported browsers. */
function loadNavStyle(): NavStyle {
  if (typeof window === 'undefined') return 'autocad'
  const v = window.localStorage.getItem(NAV_STYLE_STORAGE_KEY)
  if (v === 'autocad' || v === 'sketchup' || v === 'three' || v === 'maya') {
    return v
  }
  return 'autocad'
}

const PALETTE_STORAGE_KEY = 'beme:3d-palette'
const SNAPSHOTS_STORAGE_KEY_BASE = 'beme:3d-export-snapshots'

/**
 * Storage key for 3D snapshots — namespaced by projectId so captures
 * from one project don't leak into another. Snapshots for ALL pages of
 * a project live under the same key; each snapshot carries its own
 * `pageNumber` so the 3D view can filter to the active page.
 *
 * Legacy mode (no projectId): falls back to a global "no-project"
 * bucket so draft / offline workflows keep working.
 */
function snapshotsStorageKey(
  projectId: string | null | undefined,
  mode: 'block' | 'brick' | undefined
): string {
  // Storage key is namespaced by BOTH project and trade — a block-mode
  // capture and a brick-mode capture on the same project go into
  // different buckets so the queue the user sees in 3D matches the
  // walls currently rendered. Older clients (pre-trade-split) used
  // just the projectId; the legacy 'no-trade' bucket is reserved for
  // those keys so reads don't accidentally overwrite them.
  const tradeSegment = mode ?? 'no-trade'
  return `${SNAPSHOTS_STORAGE_KEY_BASE}:${projectId ?? 'no-project'}:${tradeSegment}`
}

/** Read the persisted block-colour palette from localStorage, falling
 *  back to 'mono' (orange + black + white, matches the rest of the
 *  app). Legacy palettes stay selectable through the picker. */
function loadPalette(): PaletteName {
  if (typeof window === 'undefined') return 'mono'
  const v = window.localStorage.getItem(PALETTE_STORAGE_KEY)
  if (
    v === 'mono' ||
    v === 'concrete' ||
    v === 'brick' ||
    v === 'sandstone' ||
    v === 'slate' ||
    v === 'vibrant'
  ) {
    return v
  }
  return 'mono'
}

export default function WorkspaceView3D(props: WorkspaceView3DProps) {
  const { walls, pdfFile, currentPageNumber, pageWidthMm, pageHeightMm, pageScaleRatio, projectId, mode, snapshots: snapshotsProp, onSnapshotsChange } = props
  // Theme drives the scene clearColor + the PDF threshold pass colour
  // pair. We only read the value (the 3D view doesn't change the theme).
  // The Header has the picker; this view just re-renders when it flips.
  const [theme] = useTheme()
  const [navStyle, setNavStyleState] = useState<NavStyle>(loadNavStyle)
  const setNavStyle = (v: NavStyle) => {
    setNavStyleState(v)
    try {
      window.localStorage.setItem(NAV_STYLE_STORAGE_KEY, v)
    } catch {
      // localStorage can throw in private-browsing / quota-exceeded.
      // Persisting is a nice-to-have; ignore the failure so the user
      // can still switch the live setting.
    }
  }
  // Block-colour palette state. Re-running the segments useMemo on
  // change re-keys every block/brick colour to the new palette.
  const [palette, setPaletteState] = useState<PaletteName>(loadPalette)
  const setPalette = (v: PaletteName) => {
    setPaletteState(v)
    try {
      window.localStorage.setItem(PALETTE_STORAGE_KEY, v)
    } catch {
      // ignore — same rationale as the nav-style setter
    }
  }

  // Legend items for the in-scene block-/brick-colour legend (rendered
  // beneath the picker row, top-right). Codes are reported up by
  // Scene's onResolvedCodes callback so the legend reflects EVERY
  // code that actually ends up in the rendered scene — makeup-declared
  // codes (body / corner / half / cap), per-course resolved fractions
  // emitted by the calc engine (e.g. 20.03 halves), per-opening
  // lintels (selectBlockLintel by head height), auto-detected lead-in
  // blocks (30.02 etc.), and brick TYPE codes for brick walls. Each
  // code's label resolves through `library[code]?.name` (block library)
  // then `BRICK_LIBRARY[code]?.name` (brick library) before falling
  // back to the raw code string.
  const [resolvedCodes, setResolvedCodes] = useState<Map<string, string>>(
    () => new Map()
  )
  const legendItems = useMemo(() => {
    return Array.from(resolvedCodes.entries())
      .map(([code, color]) => {
        // Wall-type entries (prefix `wt:<makeupId>`) resolve their
        // label off the brick makeups list — display the user-facing
        // wall type name, not the synthetic id. Falls back to a
        // generic 'Wall' label when the makeup has been deleted but
        // a render is still using its colour mid-state-update.
        if (code.startsWith('wt:')) {
          const makeupId = code.slice(3)
          const name = props.brickMakeupsById[makeupId]?.name
          return { code, label: name ?? 'Wall type', color }
        }
        return {
          code,
          label:
            props.library[code]?.name ??
            BRICK_LIBRARY[code]?.name ??
            code,
          color,
        }
      })
      .sort((a, b) => a.label.localeCompare(b.label))
  }, [resolvedCodes, props.library, props.brickMakeupsById])

  // Snapshots: captured 3D viewport PNGs the user queued for the
  // export. STATE IS OWNED BY PdfWorkspace and threaded in through
  // props so the captures live on the SavedProject and can't bleed
  // across projects. This component is purely a controlled view
  // over that list now — it reads `snapshotsProp` to render the
  // right-side queue panel and calls `onSnapshotsChange` to push
  // captures + deletions up.
  type SnapshotLegendItem = { code: string; label: string; color: string }
  type Snapshot = {
    id: string
    dataUrl: string
    createdAt: number
    pageNumber?: number
    trade?: 'block' | 'brick'
    legend?: SnapshotLegendItem[]
  }
  const snapshots: Snapshot[] = snapshotsProp ?? []
  const persistSnapshots = (next: Snapshot[]) => {
    onSnapshotsChange?.(next)
  }
  // Visible queue = ALL snapshots, regardless of which page / trade /
  // area the user is currently viewing. Captures are project-level
  // artefacts (the user took them deliberately and wants to be able
  // to see them in the queue from anywhere). Previously we filtered
  // by pageNumber + trade, which caused captures to disappear when
  // switching area filters (the area change cascaded into mode
  // switches when only one trade had walls in the new area). Showing
  // them unconditionally also makes the export-side selection more
  // intuitive — what's in the queue IS what goes into the export.
  void currentPageNumber
  void mode
  const visibleSnapshots = snapshots
  // Visual feedback for the Capture button: short-lived "Saved" state
  // that flips back automatically. Avoids a toast dep here.
  const [captureFlash, setCaptureFlash] = useState(false)
  const handleCapture = () => {
    type Win = Window & { __beme3dCapture?: () => string | null }
    const dataUrl = (window as Win).__beme3dCapture?.()
    if (!dataUrl) return
    const snap: Snapshot = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      dataUrl,
      createdAt: Date.now(),
      pageNumber: currentPageNumber,
      // Trade tag drives per-trade filtering in the export panel +
      // the in-view queue. Read off `mode`; left undefined for the
      // legacy unscoped case so older saves keep showing up.
      ...(mode ? { trade: mode } : {}),
      legend: legendItems.map(({ code, label, color }) => ({ code, label, color })),
    }
    persistSnapshots([...snapshots, snap])
    setCaptureFlash(true)
    window.setTimeout(() => setCaptureFlash(false), 900)
  }
  const handleDeleteSnapshot = (id: string) => {
    persistSnapshots(snapshots.filter((s) => s.id !== id))
  }

  // ── Plan-as-floor texture ───────────────────────────────────────
  // When the host passes pdfFile + page metadata, rasterise the
  // current page, threshold to a B&W line drawing, and expose it as
  // a THREE texture sized to the page's REAL-WORLD footprint
  // (page_mm × scale_ratio). Scene mounts it as a horizontal plane
  // under the walls so every wall sits on top of its 2D-drawn
  // position. Missing any input → null → Scene falls back to the
  // dark ground plane.
  const [planTexture, setPlanTexture] = useState<{
    texture: THREE.Texture
    widthM: number
    heightM: number
  } | null>(null)
  useEffect(() => {
    if (
      !pdfFile ||
      !currentPageNumber ||
      !pageWidthMm ||
      !pageHeightMm ||
      !pageScaleRatio
    ) {
      setPlanTexture(null)
      return
    }
    let cancelled = false
    let createdTexture: THREE.Texture | null = null
    rasterisePdfPage(pdfFile, currentPageNumber, 2).then((result) => {
      if (cancelled || !result) return
      // Need an HTMLImage to draw onto a 2D canvas before we can
      // apply the B&W threshold pixel pass.
      const img = new Image()
      img.onload = () => {
        if (cancelled) return
        const canvas = document.createElement('canvas')
        canvas.width = img.width
        canvas.height = img.height
        const ctx = canvas.getContext('2d')
        if (!ctx) return
        ctx.drawImage(img, 0, 0)
        // Two-tone wireframe pass: pixels darker than ~78% white become
        // the theme's "ink" line colour; everything else becomes the
        // canvas-background colour so the page "white" disappears and
        // only the drawn lines remain visible.
        //   - Dark mode: white lines on dark slate.
        //   - Light mode: dark slate lines on warm off-white.
        // The bg rgb here MUST match the gl.setClearColor call below so
        // the page edge can't be seen against the canvas backdrop.
        const [lr, lg, lb] = planLineRgbFor(theme)
        const [br, bg, bb] = sceneBgRgbFor(theme)
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
        const data = imageData.data
        for (let i = 0; i < data.length; i += 4) {
          const gray = (data[i] + data[i + 1] + data[i + 2]) / 3
          if (gray < 200) {
            // Drawn line — high contrast against the theme background.
            data[i] = lr
            data[i + 1] = lg
            data[i + 2] = lb
            data[i + 3] = 255
          } else {
            // Page background — matches the canvas clearColor so the
            // sheet visually disappears.
            data[i] = br
            data[i + 1] = bg
            data[i + 2] = bb
            data[i + 3] = 255
          }
        }
        ctx.putImageData(imageData, 0, 0)
        const texture = new THREE.CanvasTexture(canvas)
        texture.minFilter = THREE.LinearFilter
        texture.magFilter = THREE.LinearFilter
        // Mirror BOTH axes. After rotating the plane -π/2 around X (to
        // lay it flat) and positioning it at (-w/2, ., -h/2) so its
        // extent matches the building's negative-quadrant world coords,
        // the natural texture mapping puts image top-left at world
        // (-w, -h) — diagonally OPPOSITE of where we need it (0, 0).
        // Mirroring both UVs rotates the texture 180° so image top-
        // left ends up at world (0, 0), matching the negated wall
        // coordinate frame.
        texture.wrapS = THREE.RepeatWrapping
        texture.wrapT = THREE.RepeatWrapping
        texture.repeat.x = -1
        texture.repeat.y = -1
        texture.offset.x = 1
        texture.offset.y = 1
        texture.needsUpdate = true
        createdTexture = texture
        const widthM = (pageWidthMm * pageScaleRatio) / 1000
        const heightM = (pageHeightMm * pageScaleRatio) / 1000
        setPlanTexture({ texture, widthM, heightM })
      }
      img.src = result.dataUrl
    })
    return () => {
      cancelled = true
      // Free GPU memory when the page changes or 3D unmounts.
      if (createdTexture) createdTexture.dispose()
    }
  }, [pdfFile, currentPageNumber, pageWidthMm, pageHeightMm, pageScaleRatio, theme])

  const initialCamera = useMemo<[number, number, number]>(() => {
    if (walls.length === 0) return [10, 12, 10]
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity
    for (const w of walls) {
      // Mirror X to match the negation in segmentsForStraightWall so
      // the bounding box (and therefore the camera target) lines up
      // with where the walls actually render.
      const sx = -w.startX / 1000, sz = -w.startY / 1000
      const ex = -w.endX / 1000, ez = -w.endY / 1000
      minX = Math.min(minX, sx, ex)
      maxX = Math.max(maxX, sx, ex)
      minZ = Math.min(minZ, sz, ez)
      maxZ = Math.max(maxZ, sz, ez)
    }
    const cx = (minX + maxX) / 2
    const cz = (minZ + maxZ) / 2
    // Distance derived from a true frame-to-fit: place the camera at
    // a distance where the building's diagonal extent fits inside
    // the vertical FOV. fov = 45°, half-fov = 22.5°, tan(22.5°) ≈ 0.414
    // → distance ≈ diagonal × 1.21 for an edge-on view. We pull
    // back another 1.1× for breathing room, and pull DOWN the camera
    // angle so the building reads as a 3/4 view instead of a top-down.
    const sizeX = Math.max(maxX - minX, 4)
    const sizeZ = Math.max(maxZ - minZ, 4)
    // Use the LARGER horizontal extent (not the diagonal) so the
    // initial framing matches what F-fit does. Previously we used
    // the diagonal which over-shot distance by ~1.4× for square-ish
    // footprints, leaving a lot of empty canvas around the model.
    const sizeMax = Math.max(sizeX, sizeZ)
    const FIT_FOV_RAD = (45 * Math.PI) / 180
    // Aggressive fill: a 3/4 view projects the building's horizontal
    // extent onto the viewport as roughly `sizeMax × sin(elevation) +
    // height`, which is smaller than `sizeMax` itself — so fitting
    // the camera to `sizeMax` over-shoots distance and leaves the
    // building taking ~50% of the canvas. Multiplier 0.40 brings the
    // camera in tight; long thin buildings may clip on the long axis
    // but F-fit lets the user recover. (Tried 0.28 — too aggressive,
    // camera ended up INSIDE the model on small footprints.)
    const dist = (sizeMax / 2) / Math.tan(FIT_FOV_RAD / 2) * 0.40
    // Place at 45° around the building, slightly elevated. Keeping
    // Y proportional to dist (0.55) gives a comfortable 3/4 view.
    return [cx + dist * 0.7, dist * 0.55, cz + dist * 0.7]
  }, [walls])

  // Empty-state gate: only block the 3D scene when there's neither
  // walls NOR piers on the current page. Pier-only pages still render
  // (the scene's segment builder happily emits a stack of pier boxes
  // alone), and the camera-fit memo below tolerates an empty walls
  // list — sizeMax just falls back to the default 20m frustum.
  if (walls.length === 0 && (props.piers ?? []).length === 0) {
    return (
      <div className="w-full h-full flex items-center justify-center text-ink-400 text-sm">
        Draw a wall or place a pier on the 2D view to see it here.
      </div>
    )
  }

  return (
    // r3f's internal useMeasure was getting an undersized initial
    // reading and never updating — the canvas stuck at ~70% of the
    // wrapper. Fix: own the measurement here via ResizeObserver, pass
    // pixel dimensions to Canvas as explicit style. The observer
    // fires on every wrapper size change (initial mount + flex
    // resolution + window resize + mode toggle) so the canvas
    // tracks the wrapper exactly.
    //
    // We RENDER Canvas only after a non-zero measurement has come
    // back — avoids the prior SizedCanvasShell race where Canvas
    // mounted at 0×0 and never updated.
    <ManualResizeCanvas>
      {(width, height, glRef) => (
        <>
        <Canvas
          frameloop="demand"
          dpr={[0.75, 1]}
          camera={{ position: initialCamera, fov: 45, near: 0.1, far: 5000 }}
          shadows={false}
          gl={{ antialias: false, powerPreference: 'high-performance', preserveDrawingBuffer: true }}
          onCreated={({ gl }) => {
            glRef.current = gl
            gl.setClearColor(new THREE.Color(sceneBgFor(theme)))
            // Force the initial size manually — bypass r3f's useMeasure
            // which gets the wrong reading on this layout.
            gl.setSize(width, height, true)
          }}
          style={{
            // CSS sizing uses 100% so the canvas element ALWAYS visually
            // fills its parent, regardless of whether our ManualResizeCanvas
            // got a stale or pre-final measurement. The pixel-precise
            // `width` / `height` props are still passed below to drive
            // the WebGL framebuffer resolution via gl.setSize, but the
            // displayed CSS size is decoupled — so even if the
            // framebuffer is a frame behind, the visible canvas surface
            // doesn't show the wrapper's bg through gaps.
            width: '100%',
            height: '100%',
            display: 'block',
          }}
          // Key on theme so the clearColor takes effect on theme flip.
          key={theme}
        >
            <Suspense fallback={null}>
              <Scene
                {...props}
                navStyle={navStyle}
                planTexture={planTexture}
                theme={theme}
                palette={palette}
                onResolvedCodes={setResolvedCodes}
              />
            </Suspense>
          </Canvas>

          {/* Nav-style picker + Fit button, top-right corner. */}
          <div className="absolute top-2 right-3 pointer-events-auto flex items-center gap-2">
        <button
          type="button"
          onClick={() => {
            type Win = Window & { __beme3dFit?: () => void }
            ;(window as Win).__beme3dFit?.()
          }}
          title="Fit view (F)"
          className="px-2 py-1 text-[11px] text-ink-100 bg-ink-800/85 backdrop-blur-sm border border-ink-600/70 rounded-lg hover:border-beme-500/60 hover:text-beme-200 transition-colors shadow-md"
        >
          ⤢ Fit
        </button>
        <button
          type="button"
          onClick={handleCapture}
          title="Capture this view for export"
          className={`px-2 py-1 text-[11px] rounded-lg shadow-md border transition-colors backdrop-blur-sm ${
            captureFlash
              ? 'bg-emerald-500/30 border-emerald-400/60 text-emerald-100'
              : 'bg-ink-800/85 border-ink-600/70 text-ink-100 hover:border-beme-500/60 hover:text-beme-200'
          }`}
        >
          {captureFlash ? '✓ Saved' : '▣ Capture'}
        </button>
        <PalettePicker value={palette} onChange={setPalette} />
        <NavStylePicker value={navStyle} onChange={setNavStyle} />
      </div>

      {/* Legend + captured snapshots column, sits under the picker row
          (top-12 ≈ 48px = ~one picker height + padding). Same dark
          translucent chrome as the pickers; flex column so snapshots
          stack directly under the legend. Both hide when empty. */}
      <div className="absolute top-12 right-3 pointer-events-auto flex flex-col gap-2 max-w-[260px]">
        {legendItems.length > 0 && <BlockLegend items={legendItems} />}
        {visibleSnapshots.length > 0 && (
          <SnapshotsPanel
            snapshots={visibleSnapshots}
            onDelete={handleDeleteSnapshot}
          />
        )}
      </div>

          {/* Controls hint, bottom-left. Updates as the user switches nav
              style so they always see the bindings for the active mode. */}
          <div className="absolute bottom-2 left-3 text-[11px] text-ink-400/70 pointer-events-none select-none leading-tight">
            {`${NAV_STYLE_HINTS[navStyle]} · F = fit view`}
          </div>
        </>
      )}
    </ManualResizeCanvas>
  )
}

/**
 * Wraps the r3f Canvas in a div that the component owns the
 * measurement of via ResizeObserver. On every size change it BOTH
 * passes pixel dimensions to children (for the Canvas's CSS style)
 * AND directly calls `gl.setSize()` on the WebGL renderer — bypassing
 * r3f's internal useMeasure entirely, which on this layout was
 * returning stale dimensions and getting wedged at an undersized
 * reading.
 *
 * Why so heavy-handed: simpler approaches (CSS 100% sizing,
 * ResizeObserver with `>0` gating, passing pixel style to Canvas
 * only) all left the canvas stuck at a smaller size than the wrapper.
 * The console showed transient `{w: 196, h: 0}` reflows that the
 * built-in r3f observer never recovered from. Driving gl.setSize
 * manually means we don't depend on r3f's observer at all — every
 * size update from our own observer goes straight to the WebGL
 * renderer.
 */
function ManualResizeCanvas({
  children,
}: {
  children: (
    width: number,
    height: number,
    glRef: React.MutableRefObject<THREE.WebGLRenderer | null>,
  ) => React.ReactNode
}) {
  const ref = useRef<HTMLDivElement | null>(null)
  const glRef = useRef<THREE.WebGLRenderer | null>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })

  useEffect(() => {
    const el = ref.current
    if (!el) return
    // Shared measure-and-commit so the ResizeObserver, window-resize,
    // and transition-end paths all produce identical updates.
    const measureAndCommit = () => {
      const rect = el.getBoundingClientRect()
      const w = Math.round(rect.width)
      const h = Math.round(rect.height)
      if (w === 0 || h === 0) return
      setSize((prev) =>
        prev.width === w && prev.height === h ? prev : { width: w, height: h }
      )
    }
    // Schedule a follow-up measure after CSS transitions land. The
    // LeftNav toggle animates its width over 200ms; r3f's internal
    // useMeasure races with our ResizeObserver during the
    // transition and the LAST observation to fire wins the gl size.
    // Half the time r3f's stale intermediate reading lands last and
    // the canvas freezes at a sub-final size. Re-measuring ~280ms
    // after any size change (slightly past the 200ms transition end)
    // guarantees we apply the FINAL post-transition dimensions even
    // if r3f overrode us mid-flight.
    let trailingTimer: ReturnType<typeof setTimeout> | null = null
    const scheduleTrailingMeasure = () => {
      if (trailingTimer !== null) clearTimeout(trailingTimer)
      trailingTimer = setTimeout(() => {
        trailingTimer = null
        measureAndCommit()
        // After the size has settled, refit the camera so the model
        // fills the new canvas dimensions. Without this, switching
        // 2D↔3D, toggling panels, or resizing the window leaves the
        // model floating small inside a larger canvas. window.__beme3dFit
        // is the same hook the F-key + Fit-button use, so this path
        // produces an identical framing.
        type Win = Window & { __beme3dFit?: () => void }
        ;(window as Win).__beme3dFit?.()
      }, 280)
    }
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const w = Math.round(entry.contentRect.width)
        const h = Math.round(entry.contentRect.height)
        // Ignore zero / collapsed reads — they happen transiently
        // during reflow. Keep the previous good size so the canvas
        // stays mounted with valid framebuffer dimensions.
        if (w === 0 || h === 0) continue
        setSize((prev) =>
          prev.width === w && prev.height === h ? prev : { width: w, height: h }
        )
      }
      scheduleTrailingMeasure()
    })
    observer.observe(el)
    // Window-resize fallback. ResizeObserver SHOULD fire on every
    // size change, but in practice — especially when this layout
    // sits inside an html-zoom container with a sticky flex parent
    // — some browser resize gestures (drag-resize, devtools open /
    // close, zoom via Ctrl+/-) leave the observer silent while the
    // wrapper IS actually re-sizing. Re-measure on window resize as
    // a belt-and-braces fallback so the canvas always tracks the
    // viewport. requestAnimationFrame defers the read past the
    // browser's layout pass so we read the post-resize dimensions
    // not the pre-resize ones.
    let rafId = 0
    const onWindowResize = () => {
      cancelAnimationFrame(rafId)
      rafId = requestAnimationFrame(() => {
        measureAndCommit()
        scheduleTrailingMeasure()
      })
    }
    window.addEventListener('resize', onWindowResize)
    // Catch CSS width / height transitions completing anywhere in
    // the ancestor chain — the LeftNav toggle is the main culprit,
    // but any future animated panel that affects this column will
    // also trigger a re-measure. We listen at the wrapper so events
    // bubbling up from nested elements still reach us.
    const onTransitionEnd = (e: TransitionEvent) => {
      if (e.propertyName === 'width' || e.propertyName === 'height') {
        measureAndCommit()
      }
    }
    window.addEventListener('transitionend', onTransitionEnd)
    // Seed synchronously so the canvas mounts on the first render
    // cycle (ResizeObserver only fires on the NEXT frame).
    measureAndCommit()
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', onWindowResize)
      window.removeEventListener('transitionend', onTransitionEnd)
      cancelAnimationFrame(rafId)
      if (trailingTimer !== null) clearTimeout(trailingTimer)
    }
  }, [])

  // Drive gl.setSize manually on every size change. Bypasses r3f's
  // built-in useMeasure (which was the root cause of the stuck
  // canvas). updateStyle=true forces the framebuffer + canvas CSS
  // to match our measured size — paired with the absolute-position
  // CSS injection in the Canvas style below so the canvas surface
  // always covers its wrapper, even if the measured size is briefly
  // smaller than the wrapper's true flex-resolved size.
  useEffect(() => {
    const gl = glRef.current
    if (!gl || size.width === 0 || size.height === 0) return
    gl.setSize(size.width, size.height, true)
  }, [size.width, size.height])

  return (
    <div
      ref={ref}
      className="absolute inset-0"
      style={{ width: '100%', height: '100%' }}
    >
      {/* Hard override for r3f's canvas element. r3f's internal
          useMeasure fires AFTER mount and writes pixel width/height
          directly onto the canvas inline style, sometimes with a
          stale undersized reading — which produced the "flash then
          shrink" behaviour where the canvas mounted at full size,
          then resized smaller a frame later, leaving workspace bg
          visible to the right and below. This style rule forces
          the canvas to ALWAYS render at 100% of its wrapper
          regardless of what r3f writes, decoupling the visible
          surface from r3f's measurement. The framebuffer resolution
          still updates correctly via our own ManualResizeCanvas
          measurement → gl.setSize path. */}
      <style>{`
        .beme-3d-canvas-fill canvas {
          width: 100% !important;
          height: 100% !important;
          display: block !important;
        }
      `}</style>
      <div className="beme-3d-canvas-fill w-full h-full">
        {size.width > 0 && size.height > 0 && children(size.width, size.height, glRef)}
      </div>
    </div>
  )
}

/**
 * Measures its own rendered size via ResizeObserver and passes pixel
 * width + height as render-prop arguments. Used to give the r3f Canvas
 * inside an explicit pixel size — without this, Canvas was occasionally
 * rendering at the parent's INITIAL measured size (which could be a
 * fraction of the final flex-resolved size if the observer fires
 * before layout settles), leaving the wrapper's bg visible around it.
 *
 * Renders nothing until the first measurement comes back (avoids a
 * 0×0 Canvas mount that then has to resize on next frame).
 */
/** Compact dropdown in the 3D viewport's top-right corner. Lets the
 *  user try each nav style without leaving the scene. Persists to
 *  localStorage via the parent setter. */
function NavStylePicker({
  value,
  onChange,
}: {
  value: NavStyle
  onChange: (v: NavStyle) => void
}) {
  return (
    <label className="flex items-center gap-2 bg-ink-800/85 backdrop-blur-sm border border-ink-600/70 rounded-lg px-2 py-1 text-[11px] text-ink-200 shadow-md">
      <span className="text-ink-400">Nav</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as NavStyle)}
        className="bg-transparent text-ink-100 text-[11px] focus:outline-none cursor-pointer pr-1"
        aria-label="3D navigation style"
      >
        {(Object.keys(NAV_STYLE_LABELS) as NavStyle[]).map((k) => (
          <option key={k} value={k} className="bg-ink-800 text-ink-100">
            {NAV_STYLE_LABELS[k]}
          </option>
        ))}
      </select>
    </label>
  )
}

/** Block / brick colour legend — one row per unique code in use,
 *  showing a colour swatch and the block/brick name. Same dark
 *  translucent chrome as the picker chips; max-height so it scrolls
 *  internally if the project has many wall types. */
function BlockLegend({
  items,
}: {
  items: Array<{ code: string; label: string; color: string }>
}) {
  return (
    <div className="bg-ink-800/85 backdrop-blur-sm border border-ink-600/70 rounded-lg shadow-md text-[11px] text-ink-200 max-h-[60vh] overflow-y-auto min-w-[120px]">
      <div className="px-2 py-1 border-b border-ink-700/70 text-ink-400 sticky top-0 bg-ink-800/95 backdrop-blur-sm">
        Legend
      </div>
      <ul className="py-1">
        {items.map((it) => {
          // Wall-type entries carry a `wt:<makeupId>` code that's a
          // UUID — useless to show in the row. Hide the code column
          // for those; the label IS the identity. Brick / block code
          // rows keep the secondary code so estimators can match a
          // colour to the underlying material code.
          const isWallTypeRow = it.code.startsWith('wt:')
          return (
            <li
              key={it.code}
              className="flex items-center gap-2 px-2 py-1 leading-tight"
              title={isWallTypeRow ? it.label : it.code}
            >
              <span
                className="inline-block w-3 h-3 rounded-sm border border-ink-600/60 flex-shrink-0"
                style={{ backgroundColor: it.color }}
              />
              <span className="text-ink-100 truncate">{it.label}</span>
              {!isWallTypeRow && (
                <span className="text-ink-500 text-[10px] ml-auto pl-1 flex-shrink-0">
                  {it.code}
                </span>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/** List of captured 3D viewport snapshots queued for the export.
 *  Each row shows a thumbnail (clipped to a fixed aspect) and a
 *  delete (×) button. Rendered immediately below the BlockLegend in
 *  the same column so they share the top-right overlay strip.
 *
 *  Header acts as a collapse toggle — clicking it hides the thumbnail
 *  list so the panel shrinks to just its title row. Useful when the
 *  user has stacked up a lot of snapshots and the thumbnails are
 *  starting to block the canvas. Default state is expanded so a
 *  fresh capture is visible without needing an extra click. */
function SnapshotsPanel({
  snapshots,
  onDelete,
}: {
  snapshots: Array<{ id: string; dataUrl: string; createdAt: number }>
  onDelete: (id: string) => void
}) {
  // Minimised by default — the snapshot thumbnails are tall and can
  // obscure the canvas, so the user opts in to seeing them. Header
  // chip with count tells them captures are queued without needing
  // the strip open.
  const [expanded, setExpanded] = useState(false)
  return (
    <div className="bg-ink-800/85 backdrop-blur-sm border border-ink-600/70 rounded-lg shadow-md text-[11px] text-ink-200 max-h-[40vh] overflow-y-auto min-w-[140px]">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full px-2 py-1 border-b border-ink-700/70 text-ink-400 sticky top-0 bg-ink-800/95 backdrop-blur-sm flex items-center justify-between gap-2 hover:text-ink-200 transition-colors text-left"
        aria-expanded={expanded}
        title={expanded ? 'Hide snapshots' : 'Show snapshots'}
      >
        <span className="flex items-center gap-1.5">
          <span className="text-[10px]">{expanded ? '▾' : '▸'}</span>
          <span>Snapshots</span>
        </span>
        <span className="text-ink-500 text-[10px]">{snapshots.length}</span>
      </button>
      {expanded && (
        <ul className="p-1.5 space-y-1.5">
          {snapshots.map((s, i) => (
            <li
              key={s.id}
              className="relative group rounded overflow-hidden border border-ink-600/50 bg-ink-900/60"
            >
              <img
                src={s.dataUrl}
                alt={`Snapshot ${i + 1}`}
                className="block w-full h-auto"
              />
              <div className="absolute top-1 left-1 text-[10px] text-ink-200 bg-ink-900/70 px-1 py-0.5 rounded">
                {`#${i + 1}`}
              </div>
              <button
                type="button"
                onClick={() => onDelete(s.id)}
                title="Remove snapshot"
                className="absolute top-1 right-1 w-5 h-5 flex items-center justify-center rounded bg-ink-900/70 hover:bg-rose-500/80 text-ink-100 text-[12px] leading-none transition-colors"
                aria-label="Remove snapshot"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** Compact dropdown in the 3D viewport's top-right corner letting the
 *  user pick the block / brick colour palette (concrete, brick,
 *  sandstone, slate, vibrant). Persists to localStorage via the
 *  parent setter. */
function PalettePicker({
  value,
  onChange,
}: {
  value: PaletteName
  onChange: (v: PaletteName) => void
}) {
  return (
    <label className="flex items-center gap-2 bg-ink-800/85 backdrop-blur-sm border border-ink-600/70 rounded-lg px-2 py-1 text-[11px] text-ink-200 shadow-md">
      <span className="text-ink-400">Palette</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as PaletteName)}
        className="bg-transparent text-ink-100 text-[11px] focus:outline-none cursor-pointer pr-1"
        aria-label="3D block colour palette"
      >
        {(Object.keys(PALETTE_LABELS) as PaletteName[]).map((k) => (
          <option key={k} value={k} className="bg-ink-800 text-ink-100">
            {PALETTE_LABELS[k]}
          </option>
        ))}
      </select>
    </label>
  )
}
