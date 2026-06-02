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
import { Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { Canvas, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import type { Wall, Opening, WallMakeup, BrickMakeup, CourseBand } from '../types/walls'
import type { ProjectArea } from '../lib/projectStorage'
import type { Block, BlockCode } from '../types/blocks'
import { arcFromThreePoints, sampleArc, isCurvedWall } from '../lib/curveGeom'
import {
  convertMakeupToBands,
  moduleHeightForBand,
  resolveCourseBlocks,
} from '../lib/makeups'
import { DEFAULT_MORTAR_JOINT_MM } from '../types/blocks'
import { bandColor } from '../lib/blockColors'
import { selectBlockLintel } from '../lib/lintels'
import {
  planWallLayout,
  verifyLayoutMatchesTally,
  cornerOwnershipFor,
  outerEdgeEndpoints,
  type WallLayout,
} from '../lib/blockCalc'

// ---------- Constants ----------

const FALLBACK_HEIGHT_MM = 2400
// Brick walls render as a solid extrusion using this single colour
// (per-course brick banding is a v2 feature). #a85540 is a mid
// red-brick — sits between a fresh-from-kiln common brick and the
// slightly weathered tone of a finished wall. Also acts as the
// fallback when a block code isn't in the colour map (rare).
const DEFAULT_WALL_COLOR = '#a85540'
const GROUND_COLOR = '#3a3f48'
const CURVE_SAMPLES = 24

/** Fallback widths (mm) when the library doesn't carry the block. AU
 *  defaults — full end 20.01 ≈ 390mm, half end 20.03 ≈ 190mm. */
const FALLBACK_CORNER_WIDTH_MM = 390
const FALLBACK_HALF_WIDTH_MM = 190
const FALLBACK_BODY_WIDTH_MM = 390

/** Visible gap (m) inset on every block's edges that face a
 *  neighbouring cell. We keep the gap so adjacent blocks read as
 *  discrete units (bond pattern stays visible) but Phase 7 mortar
 *  emission is skipped — the gap shows the dark wrapper background
 *  rather than a mortar fill. 6mm reads as a clean joint at typical
 *  camera distances without producing thick / glitchy seams. */
const MORTAR_GAP_M = 0.006

/** Mortar fill colour — warm medium-grey reading as cement between the
 *  block faces. Renders behind each block course so the gaps between
 *  blocks show mortar rather than empty space (the dark wrapper bg). */
const MORTAR_COLOR = '#6a635a'

/** Fraction of wall thickness the mortar layer occupies. Less than 1.0
 *  means the mortar is RECESSED — set inside the wall slightly so block
 *  faces sit visually proud of the mortar (matches real masonry where
 *  blocks protrude a few mm beyond the mortar plane).
 *
 *  0.88 gives a clear depth separation between block face (z = +thickness/2)
 *  and mortar plane (z = +thickness * 0.44) — enough to avoid z-fight
 *  artifacts even at oblique camera angles without exaggerating the
 *  step into a deep groove. */
const MORTAR_THICKNESS_FRAC = 0.88

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
  // Re-assigned below when the wall type has an optional cap tile,
  // so that the rendered envelope includes the cap above the wall's
  // structural height.
  let totalHeightM = heightMm / 1000

  if (!makeup) {
    return { courses: [], totalHeightM, makeup: undefined }
  }
  // Clone with override so band counts size to the wall's actual height.
  const scopedMakeup: WallMakeup =
    typeof wall.heightMmOverride === 'number'
      ? { ...makeup, heightMm: wall.heightMmOverride }
      : makeup
  // Band source priority:
  //   1. makeup.coursePattern (user-defined band stack) — authoritative
  //      when set, mirrors how buildCourses / planWallLayout pick
  //      bands. convertMakeupToBands IGNORES coursePattern and always
  //      derives from heightMm, so calling it for a coursePattern
  //      makeup produces a stale band list that doesn't match the
  //      no-openings 3D renderer.
  //   2. convertMakeupToBands(scopedMakeup, undefined) — synthesised
  //      from heightMm using the standard stack rules (base + body…
  //      + optional height-makeup + top). skipHeightMakeup defaults
  //      to false so the 20.71 / 20.140 rows are included; that flag
  //      exists for the wall-types preview, not the 3D path.
  const bands: CourseBand[] =
    scopedMakeup.coursePattern && scopedMakeup.coursePattern.length > 0
      ? scopedMakeup.coursePattern
          .filter((b) => b.count > 0)
          .map((b) => ({ blockCode: b.blockCode, count: b.count }))
      : convertMakeupToBands(scopedMakeup, undefined).bands

  // Count total courses first so we know which one is the "top course"
  // and can stamp the topCourseBlockCode (typically a bond beam 20.20).
  const totalCourses = bands.reduce(
    (sum, b) => sum + Math.max(0, b.count),
    0
  )

  const courses: ResolvedCourse[] = []
  let y = 0
  let courseNum = 1
  // Standard course module (block face + mortar) is 200 mm. Any band
  // whose modular height differs is a HEIGHT-MAKEUP band (20.71 at
  // 100mm modular, 20.140 at 150mm) — those bands carry their own
  // distinct block code which we MUST preserve in bodyCode so the
  // 3D renders them with their own colour. The series-range body
  // override only applies to standard body courses.
  const STD_COURSE_MODULE_MM = 200
  for (const band of bands) {
    if (band.count <= 0) continue
    // Pass the full CourseBand (not band.blockCode). BlockCode is
    // `string` so TS doesn't catch a mistyped first arg; at runtime
    // `(band.blockCode as any).blockCode` is undefined and
    // moduleHeightForBand returns its 200mm fallback for every band
    // — which is exactly the height-makeup-not-rendering bug.
    const bandModuleMm = moduleHeightForBand(band, library)
    const isHeightMakeupBand = bandModuleMm !== STD_COURSE_MODULE_MM
    for (let i = 0; i < band.count; i++) {
      const resolved = resolveCourseBlocks(scopedMakeup, courseNum)
      // Per-course body code resolution order:
      //   - Course 1 (base course): baseCourseBlockCode from makeup /
      //     series-range. Typically 20.45 cleanout (with internal
      //     50.45 tile — not visualised separately).
      //   - Last course (top course): topCourseBlockCode from makeup.
      //     Typically 20.48 H block or 20.20 bond beam when a slab sits
      //     above.
      //   - Height-makeup courses: use band.blockCode (20.71 / 20.140)
      //     directly so they render with their own height-makeup
      //     colour and aren't overridden by the generic body code.
      //   - Middle body courses: series-range body overlay, falling
      //     through to band code (which is the makeup's bodyBlockCode
      //     by default).
      let bodyCode: BlockCode
      if (courseNum === 1) {
        bodyCode = resolved.baseCourseBlockCode || resolved.bodyBlockCode || band.blockCode
      } else if (courseNum === totalCourses) {
        bodyCode = scopedMakeup.topCourseBlockCode || resolved.bodyBlockCode || band.blockCode
      } else if (isHeightMakeupBand) {
        bodyCode = band.blockCode
      } else {
        bodyCode = resolved.bodyBlockCode || band.blockCode
      }
      // Course height: size by the BLOCK actually being rendered in
      // this course, not the band's nominal blockCode. If the user
      // sets a 40mm capping tile as topCourseBlockCode (or a base
      // course block with a non-standard height), the course slot
      // collapses to match — otherwise the cap rendered inside a
      // 200mm modular slot and looked ~190mm tall.
      //
      // Falls back to the band module when the resolved bodyCode isn't
      // in the library (defensive: matches the legacy uniform-course
      // behaviour rather than zeroing out a course).
      const courseBlock = library[bodyCode]
      const courseModuleMm = courseBlock
        ? courseBlock.dimensions.heightMm + DEFAULT_MORTAR_JOINT_MM
        : bandModuleMm
      const courseHeightM = courseModuleMm / 1000
      courses.push({
        courseNumber: courseNum,
        y0: y,
        y1: y + courseHeightM,
        bodyCode,
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
  // Optional cap tile — sits ON TOP of the wall's structural height
  // (totalHeightM is unchanged before this point, so openings + wall
  // body remain anchored to the user-set wall height). The cap adds
  // ONE course above with its own modular height (block + mortar
  // joint). totalHeightM gets bumped so the renderer's bounding /
  // camera fit picks up the cap.
  //
  // Use cornerCode = halfCode = capBlockCode so the cap renders as
  // a single uniform strip across the wall — no end-termination
  // alternation for the cap row, since a tile is the same shape end
  // to end.
  const capCode = scopedMakeup.capBlockCode
  if (capCode) {
    const capBlock = library[capCode]
    const capModuleMm = capBlock
      ? capBlock.dimensions.heightMm + DEFAULT_MORTAR_JOINT_MM
      : 50 // 40mm tile + 10mm joint as a sensible fallback
    const capHeightM = capModuleMm / 1000
    const y0 = totalHeightM
    courses.push({
      courseNumber: courses.length + 1,
      y0,
      y1: y0 + capHeightM,
      bodyCode: capCode,
      cornerCode: capCode,
      halfCode: capCode,
    })
    totalHeightM = y0 + capHeightM
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
  /** True for specialty blocks (cleanout, knockout, lintel, curve wedge,
   *  bond beam). Renders with an emissive glow so they stand out from
   *  the body / corner / half blocks that make up the bulk of the wall. */
  highlight: boolean
}

/**
 * Decide whether a given block code should be visually highlighted in
 * the 3D view. Used to make specialty blocks (the ones with a specific
 * structural purpose — cleanouts, knockouts, lintels, bond-beam tops,
 * curve wedges) stand out from the regular body / corner / half blocks.
 *
 * Detection is two-pronged:
 *   1. ROLE — base-course, base-tile, lintel, top-course, curve-tight.
 *      Catches block codes the library has tagged for these roles.
 *   2. NAME pattern — anything containing Knockout / Cleanout / Lintel /
 *      Wedge / Bond Beam in its name. Catches blocks like 20.21 (Knockout
 *      Corner) whose role is just 'corner' but whose NAME identifies it
 *      as a specialty piece.
 */
const HIGHLIGHT_ROLES = new Set([
  'base-course',
  'base-tile',
  'lintel',
  'top-course',
  'curve-tight',
])
const HIGHLIGHT_NAME_RE = /knockout|cleanout|lintel|wedge|bond.?beam/i

function isHighlightedBlock(
  code: BlockCode,
  library: Record<string, Block>
): boolean {
  if (!code) return false
  const block = library[code]
  if (!block) return false
  if (block.roles.some((r) => HIGHLIGHT_ROLES.has(r))) return true
  if (HIGHLIGHT_NAME_RE.test(block.name)) return true
  return false
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
  makeup?: WallMakeup
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

  // Mortar joint visualisation: each box is inset slightly on edges
  // that face a neighbour, so adjacent blocks read as discrete units.
  // Outer wall edges and the wall base / top are flush (no inset)
  // for clean corners.
  const halfGap = MORTAR_GAP_M / 2
  const totalHeightM = layout.heightMm / 1000

  const boxes: WallSegmentBox[] = []
  const colorOf = (code: BlockCode) =>
    colorMap.get(code) ?? DEFAULT_WALL_COLOR

  for (const block of layout.blocks) {
    // Paired tiles sit inside the wall cavity (cleanout backing) and
    // don't have a face on the exterior to render. Skip them so the
    // 3D doesn't show stray boxes at body interior positions.
    if (block.role === 'paired-tile') continue

    const course = layout.courses[block.courseIdx]
    if (!course) continue

    // Convert mm → m.
    const s0 = block.s0Mm / 1000
    const s1 = (block.s0Mm + block.widthMm) / 1000
    const y0 = course.yBottomMm / 1000
    const y1 = (course.yBottomMm + course.heightMm) / 1000

    // Clamp s to wall length so cut blocks don't overhang the model
    // (the tally still counts the full block; here we just trim the
    // visible face).
    const cs0 = Math.max(0, Math.min(wallLenM, s0))
    const cs1 = Math.max(0, Math.min(wallLenM, s1))
    if (cs1 - cs0 < 0.001) continue

    // Mortar-style inset on edges that face a neighbour. Edges
    // touching the wall envelope stay flush.
    const leftInset = cs0 < 0.001 ? 0 : halfGap
    const rightInset = cs1 > wallLenM - 0.001 ? 0 : halfGap
    const bottomInset = y0 < 0.001 ? 0 : halfGap
    const topInset = y1 > totalHeightM - 0.001 ? 0 : halfGap

    const aS0 = cs0 + leftInset
    const aS1 = cs1 - rightInset
    const aY0 = y0 + bottomInset
    const aY1 = y1 - topInset
    if (aS1 - aS0 < 0.001 || aY1 - aY0 < 0.001) continue

    const localCx = (aS0 + aS1) / 2
    boxes.push({
      cx: sx + dirX * localCx,
      cy: (aY0 + aY1) / 2,
      cz: sz + dirZ * localCx,
      length: aS1 - aS0,
      heightM: aY1 - aY0,
      thickness,
      yRotation,
      color: colorOf(block.code),
      highlight: isHighlightedBlock(block.code, library),
    })
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
    const localCx = wallLenM / 2
    boxes.push({
      cx: sx + dirX * localCx,
      cy: totalHeightM + capHeightM / 2,
      cz: sz + dirZ * localCx,
      length: wallLenM,
      heightM: capHeightM,
      thickness,
      yRotation,
      color: colorOf(capCode),
      highlight: isHighlightedBlock(capCode, library),
    })
  }

  return boxes
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
  library: Record<string, Block>,
  wallThicknessByWallId: Record<string, number>,
  wallsById?: Record<string, Wall>
): WallSegmentBox[] {
  // Negate BOTH X and Y in the plan → 3D mapping. The Y negation was
  // there from day 1 ("plan down" = "3D back"); the X negation mirrors
  // the model so its on-screen left/right matches the plan's left/right
  // when viewed from the camera's +X+Y+Z corner. Without it the camera
  // angle would show plan-left walls on screen-right (and vice versa)
  // because we're looking from the building's right side back toward
  // its left.
  //
  // outerEdgeEndpoints extends the wall to the outer-corner intersection
  // when at corners (and pulls back to the through-wall face at
  // T-junctions). Same math as wallLengthMm — keeps the 3D spatial
  // extent in sync with the block-fit length so adjacent walls
  // visually meet at the outer corner.
  const ext = wallsById
    ? outerEdgeEndpoints(wall, wallThicknessByWallId, wallsById)
    : { startX: wall.startX, startY: wall.startY, endX: wall.endX, endY: wall.endY }
  const sx = -ext.startX / 1000
  const sz = -ext.startY / 1000
  const ex = -ext.endX / 1000
  const ez = -ext.endY / 1000
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
   *  wall start) and a vertical band (y0..y1, metres from base). The
   *  `code` argument is the block code this box represents — used to
   *  flag specialty blocks (cleanout, knockout, lintel, etc.) for the
   *  emissive glow highlight.
   *
   *  Mortar gap applied only on INNER edges (where the cell has an
   *  adjacent neighbour). Outer edges flush with the wall boundary
   *  (s0=0 left end, s1=length right end, y0=0 wall base, y1=total
   *  wall top) get no inset so the wall has a clean outer face
   *  without visible mortar at the corners or sill. */
  const buildBox = (
    s0: number,
    s1: number,
    y0: number,
    y1: number,
    color: string,
    code: BlockCode
  ): WallSegmentBox => {
    const halfGap = MORTAR_GAP_M / 2
    const leftInset = s0 < 0.001 ? 0 : halfGap
    const rightInset = s1 > length - 0.001 ? 0 : halfGap
    const bottomInset = y0 < 0.001 ? 0 : halfGap
    const topInset = y1 > totalHeightM - 0.001 ? 0 : halfGap
    const aS0 = s0 + leftInset
    const aS1 = s1 - rightInset
    const aY0 = y0 + bottomInset
    const aY1 = y1 - topInset
    const localCx = (aS0 + aS1) / 2
    return {
      cx: sx + dirX * localCx,
      cy: (aY0 + aY1) / 2,
      cz: sz + dirZ * localCx,
      length: Math.max(0.001, aS1 - aS0),
      heightM: Math.max(0.001, aY1 - aY0),
      thickness,
      yRotation,
      color,
      highlight: isHighlightedBlock(code, library),
    }
  }

  /** Walk a horizontal span [spanStart, spanEnd] and emit one box per
   *  body block, ALIGNED to the course's natural block grid anchored
   *  at `gridOrigin`. The block width comes from the library so a
   *  290mm block stays 290mm in 3D.
   *
   *  Why grid alignment matters: head-fill / sill-fill spans don't
   *  start at the course's natural body-block boundary — they start
   *  at the opening's edge. Without grid alignment, head-fill blocks
   *  would start at the opening edge regardless of the course's bond,
   *  making every course above an opening look like stack bond (rows
   *  aligned) even when the wall is stretcher.
   *
   *  Grid origin = the course's end-cap width (cornerW on odd courses,
   *  halfW on even). Body blocks naturally start at that offset and
   *  step by bodyW. By computing block boundaries relative to that
   *  origin (not the span start), head-fill blocks line up with the
   *  rest of the course's bond — including the stretcher offset that
   *  makes even / odd courses staircase. Blocks at the span edges are
   *  clipped to [spanStart, spanEnd] so partial blocks show as cuts
   *  (matching real masonry where the bricklayer cuts a block at an
   *  opening edge). */
  const emitBlocksInSpan = (
    spanStart: number,
    spanEnd: number,
    y0: number,
    y1: number,
    bodyCode: BlockCode,
    bodyColor: string,
    bodyW: number,
    gridOrigin: number
  ) => {
    // First grid line at or before spanStart.
    const firstIdx = Math.floor((spanStart - gridOrigin) / bodyW)
    let cursor = gridOrigin + firstIdx * bodyW
    while (cursor < spanEnd) {
      const blockEnd = Math.min(cursor + bodyW, spanEnd)
      const blockStart = Math.max(cursor, spanStart)
      const blockWidth = blockEnd - blockStart
      if (blockWidth > 0.02) {
        boxes.push(
          buildBox(blockStart, blockEnd, y0, y1, bodyColor, bodyCode)
        )
      }
      cursor += bodyW
    }
  }

  /** Pre-compute lintel footprints per opening. Each footprint is the
   *  3D-space rectangle the lintel block(s) occupy: x = opening span,
   *  y = (op.head → op.head + lintel.heightMm). The lintel block's
   *  ACTUAL dimensions come from the library, so a 20.18 lintel
   *  (390mm tall, 190mm wide) renders at its true 390mm height and
   *  fills the opening width with 190mm-wide blocks side-by-side.
   *
   *  The lintel often spans MULTIPLE courses (a 390mm lintel takes up
   *  ~2 courses of 200mm). So body emission in EVERY course whose y-
   *  range overlaps the lintel footprint must exclude the lintel's
   *  span — not just the single "lintel course". */
  const wallHeightMm = totalHeightM * 1000
  const lintelFootprints = wallOpenings
    .map((op) => {
      const headHeightMm = wallHeightMm - op.sill * 1000 - (op.head - op.sill) * 1000
      if (headHeightMm <= 0) return null
      const spec = selectBlockLintel(headHeightMm)
      if (!spec) return null
      const block = library[spec.code]
      if (!block) return null
      const lintelHeightM = block.dimensions.heightMm / 1000
      const lintelBlockW = block.dimensions.widthMm / 1000
      return {
        code: spec.code as BlockCode,
        spanStart: op.start,
        spanEnd: op.end,
        y0: op.head,
        y1: op.head + lintelHeightM,
        blockWidthM: lintelBlockW,
      }
    })
    .filter((l): l is NonNullable<typeof l> => l !== null)

  /** Push a mortar fill box at the requested span. Bypasses buildBox so
   *  it doesn't get the MORTAR_GAP_M inset (mortar should fill the gaps
   *  between blocks, not have gaps of its own). Renders at recessed
   *  thickness so block faces sit visually proud of the mortar plane. */
  const pushMortar = (s0: number, s1: number, y0: number, y1: number) => {
    if (s1 - s0 < 0.005 || y1 - y0 < 0.005) return
    const localCx = (s0 + s1) / 2
    boxes.push({
      cx: sx + dirX * localCx,
      cy: (y0 + y1) / 2,
      cz: sz + dirZ * localCx,
      length: s1 - s0,
      heightM: y1 - y0,
      thickness: thickness * MORTAR_THICKNESS_FRAC,
      yRotation,
      color: MORTAR_COLOR,
      highlight: false,
    })
  }

  // === BLOCK-GRID ARCHITECTURE ===
  //
  // Instead of making layout decisions during emission (which produced
  // edge-case bugs around multi-opening walls), we build a complete
  // data model of every cell in the wall first, transform it through
  // a series of phases, then emit one mesh per non-removed cell.
  // Cells never overlap by construction → no z-fighting. Mortar is
  // emitted last in spans that exclude both opening voids and lintel
  // footprints → no mortar bleeds through windows or behind lintels.

  type CellRole = 'END' | 'BODY' | 'JAMB' | 'REMOVED'
  interface Cell {
    role: CellRole
    code: BlockCode
    color: string
    s0: number
    s1: number
  }
  interface CourseEntry {
    course: ResolvedCourse
    cells: Cell[]
    endCode: BlockCode
    endColor: string
    endWidth: number
    bodyW: number
  }

  // Junction-aware end handling:
  //
  // FREE / T-JUNCTION ends — stretcher bond's even courses use a half
  // block at the end. This is the ONLY place halves appear.
  //
  // CORNER / CONTROL-JOINT ends — ONE wall owns the corner cube
  // PER COURSE. In stretcher bond ownership ALTERNATES per course
  // (this is exactly how natural stretcher bond emerges at corners
  // when 200×200×400 blocks stack at 90°). In stack bond the lower-id
  // wall always owns. Whichever wall isn't the owner this course has
  // its body extend INTO the corner space (its last body block butts
  // against the owner's corner block).
  //
  // Length-makeup (3/4 / cut blocks) is a separate concern handled by
  // the existing body-cell carving — not part of corner logic.
  // Control joints behave like free ends for the corner-ownership
  // perspective (no shared block, no alternation) BUT also force the
  // full corner block on every course — skipping the half-block-on-
  // even-courses rule that applies to true free / T-junction ends.
  const leftIsControlJoint = wall.startJunction.type === 'control-joint'
  const rightIsControlJoint = wall.endJunction.type === 'control-joint'
  const leftIsFreeEnd =
    wall.startJunction.type === 'free' ||
    wall.startJunction.type === 't-junction' ||
    leftIsControlJoint
  const rightIsFreeEnd =
    wall.endJunction.type === 'free' ||
    wall.endJunction.type === 't-junction' ||
    rightIsControlJoint
  // Only true STRUCTURAL corners go through shared-corner ownership.
  const leftCornerNeighbor =
    wall.startJunction.type === 'corner'
      ? wall.startJunction.connectedWallIds?.[0]
      : undefined
  const rightCornerNeighbor =
    wall.endJunction.type === 'corner'
      ? wall.endJunction.connectedWallIds?.[0]
      : undefined
  // Corner phase: 'lead-odd' = this wall owns the corner on odd
  // courses (and the OTHER wall owns on even). Determined deterministically
  // from id comparison so the two walls have opposite phases.
  type CornerPhase = 'lead-odd' | 'lead-even'
  function cornerPhase(other: string): CornerPhase {
    return wall.id < other ? 'lead-odd' : 'lead-even'
  }
  const leftPhase: CornerPhase | null = leftCornerNeighbor
    ? cornerPhase(leftCornerNeighbor)
    : null
  const rightPhase: CornerPhase | null = rightCornerNeighbor
    ? cornerPhase(rightCornerNeighbor)
    : null
  function ownsCornerThisCourse(
    phase: CornerPhase | null,
    courseNum: number
  ): boolean {
    if (!phase) return false
    if (bondType === 'stack') return phase === 'lead-odd'
    return phase === 'lead-odd' ? courseNum % 2 === 1 : courseNum % 2 === 0
  }

  // ── Phase 1: build empty grid (per course: END + BODY cells + END) ──
  const grid: CourseEntry[] = courses.map((course) => {
    const isEvenStretcher =
      bondType === 'stretcher' && course.courseNumber % 2 === 0
    // Halves ONLY at TRUE free / T-junction ends in stretcher bond's
    // even courses. Control joints (which we group with free ends for
    // the no-shared-corner logic above) are intentionally excluded
    // here so they always render the full corner block — giving the
    // user the "two walls with full end terminations" look at a split.
    const useHalfLeft = isEvenStretcher && leftIsFreeEnd && !leftIsControlJoint
    const useHalfRight = isEvenStretcher && rightIsFreeEnd && !rightIsControlJoint

    // Corner-cell handling — both walls ALWAYS render a corner-
    // coloured end cell (so the visible corner column stays solid red
    // every course, no alternating red/green flicker). What
    // alternates per course is the WIDTH of that cell:
    //
    //   - On the course where THIS wall owns the corner cube (its
    //     corner block runs along this wall): full cornerW wide
    //     (~390mm). The block extends past the corner cube into this
    //     wall's body region.
    //   - On the course where the OTHER wall owns: only the corner-
    //     cube depth wide (= the OTHER wall's thickness, ~190mm for
    //     200 series or ~290mm for 300 series). This represents the
    //     short header face of the other wall's corner block visible
    //     on this wall's exterior at the corner cube.
    //
    // CRITICAL: non-owning width must equal the perpendicular wall's
    // thickness, NOT halfBlockW. For 200 series these are the same
    // number (~190mm) so either works; for 300 series the wall is
    // 290mm thick and using halfBlockW=190 leaves a 100mm gap where
    // the green body cell shows next to the red corner column —
    // visually wrong, the corner column appears to step in/out.
    //
    // The two walls at a corner are deterministically opposite phase
    // (lower-id leads on odd), so on every course one wall has
    // cornerW and the other has cornerCubeDepth. The body grid then
    // offsets by (cornerW - cornerCubeDepth) between courses, which
    // is the natural stretcher bond offset produced by real corner
    // blocks stacking at 90° (200mm for 200 series, 100mm for 300).
    //
    // In stack bond ownership doesn't alternate; the lower-id wall
    // always owns so widths stay constant and bodies don't offset.
    const halfBlockW =
      widthOf(course.halfCode, library, FALLBACK_HALF_WIDTH_MM) / 1000
    const cornerWidth =
      widthOf(course.cornerCode, library, FALLBACK_CORNER_WIDTH_MM) / 1000
    // Corner cube depth on this wall's axis = perpendicular wall's
    // thickness. Fallback to this wall's own thickness (almost always
    // the same — same-series walls meet at corners), then halfBlockW.
    const leftCornerCubeDepth =
      leftCornerNeighbor !== undefined
        ? (wallThicknessByWallId[leftCornerNeighbor] ?? thicknessMm) / 1000
        : thicknessMm / 1000
    const rightCornerCubeDepth =
      rightCornerNeighbor !== undefined
        ? (wallThicknessByWallId[rightCornerNeighbor] ?? thicknessMm) / 1000
        : thicknessMm / 1000
    const leftHasCornerJunction = leftPhase !== null
    const rightHasCornerJunction = rightPhase !== null
    const ownsLeftThisCourse =
      leftHasCornerJunction &&
      ownsCornerThisCourse(leftPhase, course.courseNumber)
    const ownsRightThisCourse =
      rightHasCornerJunction &&
      ownsCornerThisCourse(rightPhase, course.courseNumber)

    const leftEndCode = useHalfLeft ? course.halfCode : course.cornerCode
    const rightEndCode = useHalfRight ? course.halfCode : course.cornerCode
    const leftEndColor = colorOf(leftEndCode)
    const rightEndColor = colorOf(rightEndCode)
    // Always render end cells (overlap with the perpendicular wall's
    // cell is invisible because both are the same corner colour).
    const renderLeftEnd = true
    const renderRightEnd = true
    // End-cell widths per junction state:
    //   - corner junction + this wall owns this course: cornerW.
    //   - corner junction + other wall owns this course: corner cube
    //     depth (= perpendicular wall's thickness).
    //   - free / t-junction: corner or half by parity (free-end rule).
    const leftEndWidth = leftHasCornerJunction
      ? (ownsLeftThisCourse ? cornerWidth : leftCornerCubeDepth)
      : (useHalfLeft ? halfBlockW : cornerWidth)
    const rightEndWidth = rightHasCornerJunction
      ? (ownsRightThisCourse ? cornerWidth : rightCornerCubeDepth)
      : (useHalfRight ? halfBlockW : cornerWidth)

    const endCode = useHalfLeft && useHalfRight ? course.halfCode : course.cornerCode
    const endColor = colorOf(endCode)
    const endWidth = Math.max(leftEndWidth, rightEndWidth)
    const bodyColor = colorOf(course.bodyCode)
    const bodyW =
      widthOf(course.bodyCode, library, FALLBACK_BODY_WIDTH_MM) / 1000

    const cells: Cell[] = []
    if (length <= leftEndWidth + 0.001) {
      // Wall is shorter than (or equal to) one left end block. Emit a
      // single cell at the wall length. If length < natural block
      // width this is a physically "cut" block — unavoidable when the
      // wall is shorter than the chosen block. The cell's BOX width
      // matches the wall length (not the block's natural width)
      // because the geometry has to fit the wall.
      cells.push({
        role: 'END',
        code: leftEndCode,
        color: leftEndColor,
        s0: 0,
        s1: length,
      })
    } else if (length < leftEndWidth + rightEndWidth) {
      // Wall fits left end at its natural width but not both ends.
      // Render left at natural width, then right gets the remainder
      // (right cell is physically a cut block, but at least the LEFT
      // block stays at its natural width — the most common case where
      // the user notices stretching).
      cells.push({
        role: 'END',
        code: leftEndCode,
        color: leftEndColor,
        s0: 0,
        s1: leftEndWidth,
      })
      if (length - leftEndWidth > 0.02) {
        cells.push({
          role: 'END',
          code: rightEndCode,
          color: rightEndColor,
          s0: leftEndWidth,
          s1: length,
        })
      }
    } else {
      cells.push({
        role: 'END',
        code: leftEndCode,
        color: leftEndColor,
        s0: 0,
        s1: leftEndWidth,
      })
      let c = leftEndWidth
      const bodyEnd = length - rightEndWidth
      while (c < bodyEnd) {
        const cellEnd = Math.min(c + bodyW, bodyEnd)
        if (cellEnd - c > 0.02) {
          cells.push({
            role: 'BODY',
            code: course.bodyCode,
            color: bodyColor,
            s0: c,
            s1: cellEnd,
          })
        }
        c += bodyW
      }
      cells.push({
        role: 'END',
        code: rightEndCode,
        color: rightEndColor,
        s0: length - rightEndWidth,
        s1: length,
      })
    }
    return { course, cells, endCode, endColor, endWidth, bodyW }
  })

  // ── Helper: stamp a span (replace cells in [zoneS0, zoneS1]) ─────
  // Removes/clips/splits any cells overlapping the zone, then inserts
  // a new cell at [zoneS0, zoneS1] (or just clears them if `newCell`
  // is null). Keeps cells sorted by s0 and non-overlapping. Threshold
  // 0.02m drops slivers that would z-fight visibly.
  const stampZone = (
    cells: Cell[],
    zoneS0: number,
    zoneS1: number,
    newCell: Cell | null
  ) => {
    for (let i = cells.length - 1; i >= 0; i--) {
      const c = cells[i]
      if (c.s1 <= zoneS0 + 0.001 || c.s0 >= zoneS1 - 0.001) continue
      if (c.s0 >= zoneS0 - 0.001 && c.s1 <= zoneS1 + 0.001) {
        cells.splice(i, 1)
      } else if (c.s0 < zoneS0 && c.s1 > zoneS1) {
        // Cell straddles both edges of zone — split into two
        const right: Cell = { ...c, s0: zoneS1 }
        cells[i] = { ...c, s1: zoneS0 }
        cells.splice(i + 1, 0, right)
      } else if (c.s0 < zoneS0) {
        c.s1 = zoneS0
      } else {
        c.s0 = zoneS1
      }
    }
    if (newCell) cells.push(newCell)
    cells.sort((a, b) => a.s0 - b.s0)
    // Drop slivers left behind
    for (let i = cells.length - 1; i >= 0; i--) {
      if (cells[i].s1 - cells[i].s0 < 0.02) cells.splice(i, 1)
    }
  }

  // ── Phase 2: opening cuts (carve voids) ─────────────────────────
  // For each course, any opening that intersects the course's y-range
  // (fully or partially) removes cells in [op.start, op.end] where
  // the opening covers the FULL vertical range of the cell. Partial
  // sill/head overlaps don't carve (cells stay; mortar fills the
  // straddle region behind the partial opening).
  for (const entry of grid) {
    const { course, cells } = entry
    const { y0, y1 } = course
    for (const op of wallOpenings) {
      // Only fully-covering openings carve (sill at or below course
      // bottom AND head at or above course top).
      if (op.sill > y0 + 0.001) continue
      if (op.head < y1 - 0.001) continue
      stampZone(cells, op.start, op.end, {
        role: 'REMOVED',
        code: '' as BlockCode,
        color: '#000',
        s0: op.start,
        s1: op.end,
      })
    }
  }

  // ── Phase 3: stamp jambs at every opening edge ──────────────────
  // Walls can't terminate with a body block — every opening edge
  // needs a corner/half (closed-end) block. So for each opening,
  // emit a jamb on BOTH sides (not just outer edges of merged
  // groups). When two openings are close together (narrow pier),
  // each opening's inner jamb gets clipped at the pier midpoint
  // so the two jambs meet in the middle instead of overlapping.
  //
  // Pier widths and how this resolves:
  //   - pier ≥ 2 × endWidth: each opening gets full endWidth jamb,
  //     remaining body fits in the middle (jamb + body + jamb)
  //   - pier = 2 × endWidth: each jamb full endWidth, no body
  //     (just two jambs touching: jamb | jamb)
  //   - pier < 2 × endWidth: each jamb clipped to half the pier
  //     width so they meet at the midpoint (two narrow cut jambs)
  //
  // Codes / widths come from the library so any region's blocks
  // work — no hardcoded AU defaults.
  for (const entry of grid) {
    const { course, cells } = entry
    const { y0, y1 } = course
    const openingsFull = wallOpenings
      .filter((o) => o.sill <= y0 + 0.001 && o.head >= y1 - 0.001)
      .sort((a, b) => a.start - b.start)
    if (openingsFull.length === 0) continue

    // Per-course jamb code + width — alternates corner/half on
    // stretcher bond, just like wall end caps. Stack bond always
    // uses corner. This is what stops jamb columns at openings from
    // rendering as stack bond (the user-visible 'no stack bond
    // unless the wall type is stack' rule).
    const isEvenStretcher =
      bondType === 'stretcher' && course.courseNumber % 2 === 0
    const jambCode = isEvenStretcher ? course.halfCode : course.cornerCode
    const jambColor = colorOf(jambCode)
    const jambW =
      widthOf(jambCode, library, FALLBACK_CORNER_WIDTH_MM) / 1000

    for (let i = 0; i < openingsFull.length; i++) {
      const op = openingsFull[i]
      const prevOp = i > 0 ? openingsFull[i - 1] : null
      const nextOp = i < openingsFull.length - 1 ? openingsFull[i + 1] : null

      // Left jamb of this opening — at [start, op.start].
      // Start is the LARGER of: wall start (0), ideal jambW back
      // from op, OR midpoint of the pier between prev opening and
      // this one (so paired inner jambs meet rather than overlap).
      const leftIdeal = op.start - jambW
      const leftFloor = prevOp ? (prevOp.end + op.start) / 2 : 0
      const leftJambStart = Math.max(0, leftIdeal, leftFloor)
      if (op.start - leftJambStart > 0.02) {
        stampZone(cells, leftJambStart, op.start, {
          role: 'JAMB',
          code: jambCode,
          color: jambColor,
          s0: leftJambStart,
          s1: op.start,
        })
      }

      // Right jamb of this opening — at [op.end, end]. End is
      // the SMALLER of: wall end (length), ideal jambW forward
      // from op, OR midpoint of the pier with next opening.
      const rightIdeal = op.end + jambW
      const rightCeil = nextOp ? (op.end + nextOp.start) / 2 : length
      const rightJambEnd = Math.min(length, rightIdeal, rightCeil)
      if (rightJambEnd - op.end > 0.02) {
        stampZone(cells, op.end, rightJambEnd, {
          role: 'JAMB',
          code: jambCode,
          color: jambColor,
          s0: op.end,
          s1: rightJambEnd,
        })
      }
    }
  }

  // ── Phase 4: stamp lintels ───────────────────────────────────────
  // Lintels span multiple courses vertically (e.g. 20.18 = 390mm = 2
  // course heights). For each lintel footprint, in EVERY course it
  // overlaps, remove cells in the lintel x range. Then emit the
  // lintel separately as its own multi-course mesh.
  interface LintelMesh {
    code: BlockCode
    color: string
    s0: number
    s1: number
    y0: number
    y1: number
    blockWidthM: number
  }
  const lintelMeshes: LintelMesh[] = []
  for (const lintel of lintelFootprints) {
    for (const entry of grid) {
      const { course, cells } = entry
      if (course.y1 <= lintel.y0 + 0.001) continue
      if (course.y0 >= lintel.y1 - 0.001) continue
      stampZone(cells, lintel.spanStart, lintel.spanEnd, null)
    }
    lintelMeshes.push({
      code: lintel.code,
      color: colorOf(lintel.code),
      s0: lintel.spanStart,
      s1: lintel.spanEnd,
      y0: lintel.y0,
      y1: lintel.y1,
      blockWidthM: lintel.blockWidthM,
    })
  }

  // ── Phase 4.5: merge narrow adjacent body cells ─────────────────
  // After all stamps, a narrow pier (e.g. 400mm wall between two
  // openings) may end up with two clipped body cells side-by-side
  // where the original body grid had a boundary in the middle (e.g.
  // [200, 400] + [400, 600]). In real masonry the bricklayer would
  // use ONE block (or use proper half blocks) rather than two thin
  // cuts. Merge any two adjacent body cells where BOTH are narrow
  // (< 0.9 × bodyW) into a single cell — gives a cleaner pier look
  // for narrow sections without affecting wide-wall layouts where
  // every body block is its full width.
  for (const entry of grid) {
    const { cells, bodyW } = entry
    cells.sort((a, b) => a.s0 - b.s0)
    for (let i = cells.length - 2; i >= 0; i--) {
      const cur = cells[i]
      const next = cells[i + 1]
      if (
        cur.role === 'BODY' &&
        next.role === 'BODY' &&
        Math.abs(cur.s1 - next.s0) < 0.001 &&
        cur.s1 - cur.s0 < bodyW * 0.9 &&
        next.s1 - next.s0 < bodyW * 0.9
      ) {
        cur.s1 = next.s1
        cells.splice(i + 1, 1)
      }
    }
  }

  // ── Phase 5: emit cells ──────────────────────────────────────────
  for (const { course, cells } of grid) {
    for (const cell of cells) {
      if (cell.role === 'REMOVED') continue
      boxes.push(
        buildBox(cell.s0, cell.s1, course.y0, course.y1, cell.color, cell.code)
      )
    }
  }

  // ── Phase 6: emit lintels (as individual blocks across span) ────
  for (const lm of lintelMeshes) {
    let cursor = lm.s0
    while (cursor < lm.s1) {
      const blockEnd = Math.min(cursor + lm.blockWidthM, lm.s1)
      if (blockEnd - cursor > 0.02) {
        boxes.push(buildBox(cursor, blockEnd, lm.y0, lm.y1, lm.color, lm.code))
      }
      cursor += lm.blockWidthM
    }
  }

  // Phase 7 (mortar emit) intentionally skipped — mortar removed at
  // user request. pushMortar / lintelFootprints kept defined above
  // so re-enabling later is just removing this `void` line.
  void pushMortar

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
  library: Record<string, Block>,
  wallThicknessByWallId: Record<string, number>
): WallSegmentBox[] {
  if (wall.midX === undefined || wall.midY === undefined) return []
  const geom = arcFromThreePoints(
    { x: wall.startX, y: wall.startY },
    { x: wall.midX, y: wall.midY },
    { x: wall.endX, y: wall.endY }
  )
  if (!geom) {
    return segmentsForStraightWall(
      wall, [], thicknessMm, courses, totalHeightM, bondType, colorMap, library, wallThicknessByWallId
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
        fakeWall, [], thicknessMm, courses, totalHeightM, bondType, colorMap, library, wallThicknessByWallId
      )
    )
  }
  return boxes
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

export const NAV_STYLE_LABELS: Record<NavStyle, string> = {
  autocad: 'AutoCAD / Revit',
  sketchup: 'SketchUp / Blender',
  three: 'Three.js Orbit',
  maya: 'Maya / Cinema 4D',
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

  useEffect(() => {
    const dom = gl.domElement

    // Orbit target. Initially at the scene's horizontal centre, just
    // above the ground (1m) so we're looking at roughly where the
    // walls are, not at the ground plane.
    const target = new THREE.Vector3(initialTargetX, 1, initialTargetZ)

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
      target.set(initialTargetX, 1, initialTargetZ)
      const FIT_FOV_RAD = (45 * Math.PI) / 180
      const dist = Math.max(
        4,
        (sceneSizeMax / 2) / Math.tan(FIT_FOV_RAD / 2) * 1.1
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
    initialTargetX,
    initialTargetZ,
    sceneSizeMax,
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
  navStyle,
}: Omit<WorkspaceView3DProps, 'areas'> & { navStyle: NavStyle }) {
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
    // Lintel codes — collected for every opening on a block wall so the
    // lintel block gets its own distinct palette slot. selectBlockLintel
    // resolves per opening's head height; null if the library carries
    // no lintel-tagged block.
    for (const wall of walls) {
      if (wall.trade === 'brick') continue
      const heightMm =
        typeof wall.heightMmOverride === 'number'
          ? wall.heightMmOverride
          : makeupsById[wall.makeupId]?.heightMm ?? FALLBACK_HEIGHT_MM
      const wallOpenings = openings.filter((o) => o.wallId === wall.id)
      for (const op of wallOpenings) {
        const headHeightMm = heightMm - op.sillHeightMm - op.heightMm
        if (headHeightMm <= 0) continue
        const spec = selectBlockLintel(headHeightMm)
        if (spec) allCodes.push(spec.code)
      }
    }
    // Build the colour map via plain hash-based `bandColor` for every
    // code. We DELIBERATELY don't use buildBlockColorMap here, even
    // though it would dedupe slot collisions — because the
    // WallTypesPanel preview builds its own (smaller) code set with
    // buildBlockColorMap, and the two sets produce different slot
    // assignments for the same code (the collision-avoidance walk
    // depends on which other codes are sorted before it). That made
    // the same `20.48` block look different in the panel preview vs
    // the 3D scene — the bug the user reported.
    //
    // Plain bandColor() is a pure function of the code itself, so the
    // same code always resolves to the same palette slot, regardless
    // of which other codes are around. ~1/16 of codes will collide on
    // a shared slot, but with the concrete-grey palette where slots
    // differ mainly by lightness, that's acceptable in exchange for
    // perfect cross-view consistency.
    const colorMap = new Map<string, string>()
    for (const code of new Set(allCodes)) {
      colorMap.set(code, bandColor(code))
    }

    const out: WallSegmentBox[] = []
    // Build wallsById ONCE outside the loop so both segmentsForStraightWall
    // (for outer-edge endpoint extension) and segmentsFromWallLayout
    // (for the same, plus corner ownership) can use it without
    // rebuilding per wall.
    const wallsByIdMap: Record<string, Wall> = {}
    for (const w of walls) wallsByIdMap[w.id] = w
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
            'stack', brickColorMap, library, wallThicknessByWallId, wallsByIdMap
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
            bondType, colorMap, library, wallThicknessByWallId
          )
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
        const wallHasOpenings = openings.some((o) => o.wallId === wall.id)
        if (!wallHasOpenings) {
          // Corner ownership: at each shared corner, only ONE wall
          // emits the corner block per course (alternating per
          // course). The cumulative count across both walls matches
          // calculateProjectTally's deduplicated total — and gives
          // visible stretcher-bond alternation at corners in 3D.
          const ownership = cornerOwnershipFor(wall)
          const layout = planWallLayout(
            wall,
            wr.makeup,
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
              wr.makeup
            )
          )
        } else {
          out.push(
            ...segmentsForStraightWall(
              wall, openings, thicknessMm, wr.courses, wr.totalHeightM,
              bondType, colorMap, library, wallThicknessByWallId, wallsByIdMap
            )
          )
        }
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
      {/* Scene fog — fades the far ground plane into the canvas
          clearColor so the user never sees the plane's edge. The fog
          extends in metres, sized off the scene's overall extent. */}
      <fog
        attach="fog"
        args={[
          '#1a1d24',
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
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[segmentBounds.centerX, -0.02, segmentBounds.centerZ]}
      >
        <planeGeometry args={[segmentBounds.sizeMax * 50, segmentBounds.sizeMax * 50]} />
        <meshStandardMaterial color={GROUND_COLOR} side={THREE.DoubleSide} />
      </mesh>

      {/* One mesh per wall sub-box. Per-course rendering means ~5x more
          meshes than band rendering, but with ~30 walls × 13 courses ×
          ~3 cells = ~1200 meshes the cost is still fine on integrated
          GPUs. InstancedMesh by colour collapses this to ~16 draw calls
          if a busier project warrants. */}
      {segments.map((s, i) => (
        <mesh key={i} position={[s.cx, s.cy, s.cz]} rotation={[0, s.yRotation, 0]}>
          <boxGeometry args={[s.length, s.heightM, s.thickness]} />
          {/* Highlighted specialty blocks (cleanout / knockout / lintel /
              curve wedge / bond beam) emit a glow of their own colour so
              they stand out from the body / corner blocks around them.
              Regular blocks render with a flat standard material. */}
          {s.highlight ? (
            <meshStandardMaterial
              color={s.color}
              emissive={s.color}
              emissiveIntensity={0.45}
            />
          ) : (
            <meshStandardMaterial color={s.color} />
          )}
        </mesh>
      ))}

      {/* InitialCameraAim must render BEFORE CADControls so its
          lookAt is applied before the controls seed their spherical
          state from camera.position. */}
      <InitialCameraAim
        targetX={segmentBounds.centerX}
        targetZ={segmentBounds.centerZ}
      />
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

export default function WorkspaceView3D(props: WorkspaceView3DProps) {
  const { walls } = props
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
    const diagonal = Math.hypot(sizeX, sizeZ)
    const FIT_FOV_RAD = (45 * Math.PI) / 180
    const dist = (diagonal / 2) / Math.tan(FIT_FOV_RAD / 2) * 1.1
    // Place at 45° around the building, slightly elevated. Keeping
    // Y proportional to dist (0.55) gives a comfortable 3/4 view.
    return [cx + dist * 0.7, dist * 0.55, cz + dist * 0.7]
  }, [walls])

  if (walls.length === 0) {
    return (
      <div className="w-full h-full flex items-center justify-center text-ink-400 text-sm">
        Draw a wall on the 2D view to see it here.
      </div>
    )
  }

  return (
    // Direct fill: the Canvas is absolutely positioned to inset-0 of
    // this wrapper, which is itself absolute-inset-0 of the PdfWorkspace
    // 3D pod (line ~6400 — `flex-1 min-w-0 min-h-0 relative`). This
    // means the Canvas always matches the pod's CSS size, no
    // measurement / RAF / ResizeObserver dance. r3f handles the WebGL
    // framebuffer resize internally via its own observer.
    //
    // Earlier we used a SizedCanvasShell that measured the wrapper
    // and passed explicit pixel `style={{ width, height }}` to Canvas
    // — but if the initial measurement was taken before flex resolved,
    // the canvas got stuck at the smaller size. Direct CSS fill is
    // robust to that race.
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
        style={{ position: 'absolute', inset: 0, display: 'block' }}
      >
        <Suspense fallback={null}>
          <Scene {...props} navStyle={navStyle} />
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
        <NavStylePicker value={navStyle} onChange={setNavStyle} />
      </div>

      {/* Controls hint, bottom-left. Updates as the user switches nav
          style so they always see the bindings for the active mode. */}
      <div className="absolute bottom-2 left-3 text-[11px] text-ink-400/70 pointer-events-none select-none leading-tight">
        {`${NAV_STYLE_HINTS[navStyle]} · F = fit view`}
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
