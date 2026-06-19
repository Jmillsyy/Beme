/**
 * wallSegments — the straight-wall block enumeration shared by the 3D
 * renderer AND the export tally.
 *
 * Extracted verbatim from WorkspaceView3D.tsx so that the box list the
 * renderer draws is the same list the tally counts. Pure functions, no
 * Three.js / React dependencies.
 */
import type { Wall, Opening, WallMakeup, CourseBand } from '../types/walls'
import type { Block, BlockCode } from '../types/blocks'
import { DEFAULT_MORTAR_JOINT_MM } from '../types/blocks'
import { isCurvedWall } from './curveGeom'
import {
  convertMakeupToBands,
  moduleHeightForBand,
  resolveCourseBlocks,
} from './makeups'
import { pickDepthScopedSlotBlockIn } from '../data/blockLibrary'
import { selectBlockLintel } from './lintels'
import { outerEdgeEndpoints } from './wallGeom'
import type { CornerOwnership } from './blockCalc'

/** Head gap (mm) used by the renderer's window auto-anchoring. */
export const RENDER_HEAD_GAP_FROM_TOP_MM = 300

/**
 * The renderer's opening-positioning rules, shared with the tally so
 * blocks are counted exactly where they are drawn:
 *   - doors sit on the floor (sill forced to 0)
 *   - sill = 0 is respected as floor-to-head (door-like) positioning
 *   - windows with a non-zero sill auto-anchor so the head lands
 *     RENDER_HEAD_GAP_FROM_TOP_MM below the wall top (clamped >= 0).
 *     This default is what the modal uses when the user hasn't set
 *     an explicit head allowance.
 *   - no-head openings keep their stored sill but extend the void
 *     UP to the wall top — the brickwork above the typed opening
 *     height is removed. noHead doesn't relocate the opening; it
 *     just opens up the head zone above wherever the opening sits.
 */
export function adjustOpeningForRender(
  o: Opening,
  wallHeightMm: number
): Opening {
  let adjusted: Opening
  if (o.kind === 'door') {
    adjusted = o.sillHeightMm === 0 ? o : { ...o, sillHeightMm: 0 }
  } else if (o.kind !== 'window' || o.sillHeightMm === 0 || o.noHead) {
    // Keep stored sill exactly for:
    //   - block-mode openings (no kind, explicit head+sill from user)
    //   - sill = 0 (already floor-anchored)
    //   - no-head openings (their saved sill is the position; the
    //     void extension below opens up the head zone)
    adjusted = o
  } else {
    const targetSill = Math.max(
      0,
      wallHeightMm - RENDER_HEAD_GAP_FROM_TOP_MM - o.heightMm,
    )
    adjusted =
      targetSill === o.sillHeightMm ? o : { ...o, sillHeightMm: targetSill }
  }
  // No-head: extend the void from the (already-positioned) opening
  // upward to the wall top so the brickwork above is removed. The
  // opening's POSITION doesn't change — only its effective height.
  if (o.noHead) {
    const effH = Math.max(
      adjusted.heightMm,
      wallHeightMm - adjusted.sillHeightMm,
    )
    if (effH !== adjusted.heightMm) {
      adjusted = { ...adjusted, heightMm: effH }
    }
  }
  return adjusted
}


export const FALLBACK_HEIGHT_MM = 2400

// Brick walls render as a solid extrusion using this single colour
// (per-course brick banding is a v2 feature). #a85540 is a mid
// red-brick — sits between a fresh-from-kiln common brick and the
// slightly weathered tone of a finished wall. Also acts as the
// fallback when a block code isn't in the colour map (rare).
export const DEFAULT_WALL_COLOR = '#a85540'

/** Fallback widths (mm) when the library doesn't carry the block. AU
 *  defaults — full end 20.01 ≈ 390mm, half end 20.03 ≈ 190mm. */
export const FALLBACK_CORNER_WIDTH_MM = 390
export const FALLBACK_HALF_WIDTH_MM = 190
export const FALLBACK_BODY_WIDTH_MM = 390

/** Visible gap (m) inset on every block's edges that face a
 *  neighbouring cell. We keep the gap so adjacent blocks read as
 *  discrete units (bond pattern stays visible) but Phase 7 mortar
 *  emission is skipped — the gap shows the dark wrapper background
 *  rather than a mortar fill. 6mm reads as a clean joint at typical
 *  camera distances without producing thick / glitchy seams. */
export const MORTAR_GAP_M = 0.006

/** Mortar fill colour — light warm-grey reading as dry Portland cement
 *  between the block faces. Was the darker #6a635a; lightened so the
 *  mortar reads more clearly against both the concrete-grey blocks and
 *  the vibrant-palette blocks, where the previous value blended into
 *  darker faces and lost the "joints between blocks" visual.
 *  Renders behind each block course so the gaps between blocks show
 *  mortar rather than empty space (the dark wrapper bg). */
export const MORTAR_COLOR = '#c4bfb6'

/** Fraction of wall thickness the mortar layer occupies. Less than 1.0
 *  means the mortar is RECESSED — set inside the wall slightly so block
 *  faces sit visually proud of the mortar (matches real masonry where
 *  blocks protrude a few mm beyond the mortar plane).
 *
 *  0.88 gives a clear depth separation between block face (z = +thickness/2)
 *  and mortar plane (z = +thickness * 0.44) — enough to avoid z-fight
 *  artifacts even at oblique camera angles without exaggerating the
 *  step into a deep groove. */
export const MORTAR_THICKNESS_FRAC = 0.88

/** Look up a block's face width (mm), falling back to the AU default. */
export function widthOf(code: BlockCode | undefined, library: Record<string, Block>, fallback: number): number {
  if (!code) return fallback
  return library[code]?.dimensions.widthMm ?? fallback
}

/**
 * One course of the wall — body + corner + half codes already resolved
 * against the makeup's series ranges. y0/y1 are the course's world-space
 * vertical band (in metres).
 */
export interface ResolvedCourse {
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
export function resolveWallCourses(
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
      //   - Curved walls: ALL courses use the makeup's bodyBlockCode
      //     (no base / top / height-makeup variation). Matches what
      //     calculateCurvedWallTally counts — the curve tally
      //     simplifies to "body-only" because base / top / height-
      //     makeup blocks aren't built into the wedge math for v1.
      //     The 3D used to keep the base / top variants here even on
      //     a curve, which made a wall spec'd as "all 20.03CW" still
      //     render the first course as the rectangular 20.45 cleanout
      //     and the top as the 20.20 bond beam. Aligning the 3D with
      //     the tally fixes that mismatch.
      //   - Straight walls keep the standard variation:
      //     - Course 1 (base course): baseCourseBlockCode from makeup /
      //       series-range. Typically 20.45 cleanout (with internal
      //       50.45 tile — not visualised separately).
      //     - Last course (top course): topCourseBlockCode from makeup.
      //       Typically 20.48 H block or 20.20 bond beam when a slab
      //       sits above.
      //     - Height-makeup courses: use band.blockCode (20.71 / 20.140)
      //       directly so they render with their own height-makeup
      //       colour and aren't overridden by the generic body code.
      //     - Middle body courses: series-range body overlay, falling
      //       through to band code (which is the makeup's bodyBlockCode
      //       by default).
      let bodyCode: BlockCode
      if (isCurvedWall(wall)) {
        bodyCode = scopedMakeup.bodyBlockCode || resolved.bodyBlockCode || band.blockCode
      } else if (courseNum === 1) {
        bodyCode = resolved.baseCourseBlockCode || resolved.bodyBlockCode || band.blockCode
      } else if (courseNum === totalCourses) {
        // Depth-scope the top course against the body so a stale
        // topCourseBlockCode (different series / depth) can't drop a
        // visually mismatched block onto the top — e.g. a 100-series
        // 10.01 sitting on a 200-series 20.48 body. Helper trusts the
        // saved code when depth matches; falls through to a
        // depth-compatible top-course role block, then body block.
        // Mirrors the same fix in blockCalc.buildCourses — both calc
        // and render now agree on the resolved code.
        const candidateBody =
          resolved.bodyBlockCode || band.blockCode || scopedMakeup.bodyBlockCode
        bodyCode = pickDepthScopedSlotBlockIn(
          library,
          scopedMakeup.topCourseBlockCode,
          'top-course',
          candidateBody,
        )
      } else if (isHeightMakeupBand) {
        bodyCode = band.blockCode
      } else {
        bodyCode = resolved.bodyBlockCode || band.blockCode
      }
      // Curved walls: every cell — body AND end terminations — uses the
      // makeup's bodyBlockCode. Matches calculateCurvedWallTally, which
      // tallies the whole curve as a single body block ('all 20.03CW',
      // not 'mostly 20.03CW with 20.01 / 20.03 at the ends'). Without
      // this, the virtual-straight-wall path in segmentsForCurvedWall
      // still injects a standard corner/half at each alternating
      // course, which the user saw as the "standard blocks" mixed
      // into their curve.
      const curveCorner = isCurvedWall(wall)
        ? scopedMakeup.bodyBlockCode || resolved.cornerBlockCode
        : resolved.cornerBlockCode
      const curveHalf = isCurvedWall(wall)
        ? scopedMakeup.bodyBlockCode || resolved.halfBlockCode
        : resolved.halfBlockCode
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
        cornerCode: curveCorner,
        halfCode: curveHalf,
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
      // If the makeup hasn't named a half block, fall through to the
      // body block. Real masons cut a body block to fit at a free end
      // when no dedicated half exists, and using the body code keeps
      // the cell pointing at a real block in any library (the old
      // '20.03' fallback assumed the AU SEQ catalogue).
      halfCode: makeup.halfBlockCode ?? makeup.bodyBlockCode,
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
export interface WallSegmentBox {
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
  /** Library block code this box represents. Set by the cell-grid
   *  enumerator (segmentsForStraightWall) so the export tally can count
   *  the exact boxes the renderer draws. Optional because render-only
   *  producers (mortar fill, layout-path cap strips) don't carry one. */
  code?: BlockCode
  /** 1-based wall course this box belongs to. Block cells only —
   *  lintel / gap-fill boxes span courses and leave it undefined. */
  courseNumber?: number
}

/**
 * Decide whether a given block code should be visually highlighted in
 * the 3D view. Used to make specialty blocks (the ones with a specific
 * structural purpose — cleanouts, knockouts, lintels, bond-beam tops,
 * curve wedges) stand out from the regular body / corner / half blocks.
 *
 * Detection is two-pronged:
 *   1. ROLE — base-course, lintel, top-course, curve-tight.
 *      Catches block codes the library has tagged for these roles.
 *   2. NAME pattern — anything containing Knockout / Cleanout / Lintel /
 *      Wedge / Bond Beam in its name. Catches blocks like 20.21 (Knockout
 *      Corner) whose role is just 'corner' but whose NAME identifies it
 *      as a specialty piece, and the legacy 50.45 cleanout tile (no
 *      special role since the base-tile role was removed).
 */
const HIGHLIGHT_ROLES = new Set([
  'base-course',
  'lintel',
  'top-course',
  'curve-tight',
])
const HIGHLIGHT_NAME_RE = /knockout|cleanout|lintel|wedge|bond.?beam/i

export function isHighlightedBlock(
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
export function segmentsForStraightWall(
  wall: Wall,
  openings: Opening[],
  thicknessMm: number,
  courses: ResolvedCourse[],
  totalHeightM: number,
  bondType: 'stretcher' | 'stack',
  colorMap: Map<string, string>,
  library: Record<string, Block>,
  wallThicknessByWallId: Record<string, number>,
  wallsById?: Record<string, Wall>,
  /**
   * When true, skip the block-lintel emission at opening heads. Brick
   * walls run through this function for layout but don't get concrete
   * block lintels — brick openings are bridged by per-opening steel
   * angle / catnic supply items the user defines separately, not
   * masonry block lintels. With this flag the head course just
   * continues as bricks like the rest of the wall.
   */
  disableBlockLintels = false,
  /**
   * Optional map of each wall's effective height in mm. Used to make
   * corner ownership height-aware: when two walls of different
   * heights meet at a corner, the TALLER wall's courses ABOVE the
   * shorter wall's top render as a free end (half block on even
   * courses, no corner cube extension) — there's no perpendicular
   * wall to share a corner with at those upper courses. When the
   * map is omitted or doesn't contain the partner wall's id, the
   * corner is treated as full-height like before.
   */
  wallHeightMmByWallId?: Record<string, number>,
  /**
   * Optional per-wall resolved courses map. When provided, corner cube
   * depth on each course is computed from the perpendicular wall's
   * body block depth AT THIS COURSE'S Y — supporting mixed-series
   * partners where the upper courses are narrower than the base.
   * Without this map, falls back to wall-level (max) thickness.
   */
  wallCoursesById?: Record<string, ResolvedCourse[]>,
  /**
   * Optional corner-ownership function (cornerOwnershipFor from
   * blockCalc). When provided it replaces the legacy id-comparison
   * phase so this path agrees with the planWallLayout path about WHICH
   * wall owns a shared corner on each course — and so the tally
   * derived from these boxes deduplicates corners identically to the
   * layout-path tally. Omitted -> legacy id-phase (back-compat for the
   * curved-wall virtual call, which has free junctions anyway).
   */
  cornerOwnership?: CornerOwnership,
  /**
   * Mortar pitch (metres) for the body-cell grid. 0 (default) tiles
   * cells edge-to-edge at face width — the original behaviour, kept
   * for the brick path whose corner maths assume contiguous tiling.
   * Block walls pass DEFAULT_MORTAR_JOINT_MM/1000 so the grid steps at
   * the true modular pitch (face + joint = 400) and stays in lockstep
   * with planWallLayout / the tally maths. Without it the grid drifts
   * 10mm per block and accumulates phantom sliver cells at the far end
   * of carved courses.
   */
  gridMortarM = 0
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
  // Control-joint sealant gap — pulls the rendered wall back from
  // any control-joint end so the seam between two halves shows a
  // visible vertical gap (real-world sealant joint). Render-only.
  const SEALANT_GAP_M = 0.02
  const startSealant =
    wall.startJunction.type === 'control-joint' ? SEALANT_GAP_M : 0
  const endSealant =
    wall.endJunction.type === 'control-joint' ? SEALANT_GAP_M : 0
  const effectiveLeftM = startSealant
  const effectiveRightM = length - endSealant

  const buildBox = (
    s0: number,
    s1: number,
    y0: number,
    y1: number,
    color: string,
    code: BlockCode,
    courseNumber?: number
  ): WallSegmentBox => {
    const halfGap = MORTAR_GAP_M / 2
    // Clamp to effective wall extent (= wall length minus any control-
    // joint sealant gap), so blocks at a control-joint end render
    // inset by SEALANT_GAP_M.
    //
    // COPLANAR_EPS_M: envelope edges used to be perfectly flush, which
    // made wall A's end faces mathematically coplanar with wall B's
    // side faces at every corner / T-junction — invisible while the
    // colours matched, a z-fight shimmer wherever they didn't (jogs,
    // short returns, mixed makeups). A 0.5mm inset is sub-pixel at any
    // practical zoom but gives the GPU an unambiguous winner.
    const COPLANAR_EPS_M = 0.0005
    const clampedS0 = Math.max(effectiveLeftM, Math.min(effectiveRightM, s0))
    const clampedS1 = Math.max(effectiveLeftM, Math.min(effectiveRightM, s1))
    const leftInset =
      clampedS0 < effectiveLeftM + 0.001 ? COPLANAR_EPS_M : halfGap
    const rightInset =
      clampedS1 > effectiveRightM - 0.001 ? COPLANAR_EPS_M : halfGap
    const bottomInset = y0 < 0.001 ? 0 : halfGap
    const topInset = y1 > totalHeightM - 0.001 ? COPLANAR_EPS_M : halfGap
    const aS0 = clampedS0 + leftInset
    const aS1 = clampedS1 - rightInset
    const aY0 = y0 + bottomInset
    const aY1 = y1 - topInset
    const localCx = (aS0 + aS1) / 2
    // Per-block thickness — use this block's library depth so a
    // 200-series block on top of a 300-series base renders at its
    // own depth, centered on the wall centerline (50mm step each
    // side at the boundary). Falls back to the wall-level thickness
    // when the block has no library entry.
    const perBlockDepthMm = library[code]?.dimensions.depthMm
    const perBlockThickness =
      (perBlockDepthMm !== undefined ? perBlockDepthMm / 1000 : thickness) -
      COPLANAR_EPS_M * 2
    return {
      cx: sx + dirX * localCx,
      cy: (aY0 + aY1) / 2,
      cz: sz + dirZ * localCx,
      length: Math.max(0.001, aS1 - aS0),
      heightM: Math.max(0.001, aY1 - aY0),
      thickness: perBlockThickness,
      yRotation,
      color,
      highlight: isHighlightedBlock(code, library),
      code,
      courseNumber,
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

  // emitBlocksInSpan predates the cell-grid architecture and has no
  // call sites left; referenced here so the moved file matches the
  // original's lint posture until it's deleted for good.
  void emitBlocksInSpan

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
   *  span — not just the single "lintel course".
   *
   *  Block walls only — brick walls use steel angle / catnic supply
   *  items handled separately (disableBlockLintels=true). Per-opening
   *  override via `headCourseBlockCode` still wins over the auto-pick
   *  when set; otherwise selectBlockLintel chooses by head height. */
  const wallHeightMm = totalHeightM * 1000
  const lintelFootprints = disableBlockLintels
    ? []
    : wallOpenings
        .map((op) => {
          const headHeightMm = wallHeightMm - op.sill * 1000 - (op.head - op.sill) * 1000
          if (headHeightMm <= 0) return null
          // User override on the opening's headCourseBlockCode wins
          // over the auto-pick. Look up the source opening (op here
          // is the geometry-only slice; the override field lives on
          // the original Opening record).
          const sourceOp = openings.find(
            (o) =>
              o.wallId === wall.id &&
              Math.abs(o.startAlongWallMm / 1000 - op.start) < 0.001 &&
              Math.abs(o.widthMm / 1000 - (op.end - op.start)) < 0.001
          )
          let code: BlockCode | null = null
          if (sourceOp?.headCourseBlockCode) {
            code = sourceOp.headCourseBlockCode as BlockCode
          } else {
            // Detect height-makeup course modular from wall height
            // (the only way a non-200mm course sneaks into the head
            // area). 100mm → 20.71 stub; 150mm → 20.140 stub.
            const wallHeightMod200 = Math.round(wallHeightMm) % 200
            const extras: number[] =
              wallHeightMod200 === 100
                ? [100]
                : wallHeightMod200 === 150
                  ? [150]
                  : []
            // Pass the per-opening lintelBlockCodeOverride so the 3D
            // render matches the calc tally — both honour the same
            // user pick. Auto-fallback still happens inside
            // selectBlockLintel if the override code is missing or
            // no longer tagged as a lintel.
            const spec = selectBlockLintel(
              headHeightMm,
              extras,
              sourceOp?.lintelBlockCodeOverride
            )
            if (spec) code = spec.code as BlockCode
          }
          if (!code) return null
          const block = library[code]
          if (!block) return null
          const lintelHeightM = block.dimensions.heightMm / 1000
          const lintelBlockW = block.dimensions.widthMm / 1000
          // Clip the lintel at the wall top so a 390mm lintel chosen
          // for a 200mm head area renders as 200mm tall instead of
          // poking out above the wall. Matches how the lintel would
          // be cut on site — the block above wall top is sawn off,
          // the count in the tally still includes the whole block
          // (you still buy and cut a whole one). Without this clip
          // the 3D view shows a phantom block above the wall and
          // the lintel footprint extends into "no-wall" space which
          // breaks downstream cell-removal and mortar emission.
          // `totalHeightM` comes from the outer wall scope so the
          // clamp uses the same wall top the rest of the render
          // honours.
          const y1Raw = op.head + lintelHeightM
          const y1 = Math.min(y1Raw, totalHeightM)
          return {
            code,
            spanStart: op.start,
            spanEnd: op.end,
            y0: op.head,
            y1,
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
    /** Effective LEFT end-block width on this course — corner block,
     *  cube extension, or half/full depending on junction + parity.
     *  Used by jamb stamping to avoid overlapping the end block. */
    leftEndWidth: number
    /** Effective RIGHT end-block width on this course — same rules. */
    rightEndWidth: number
    bodyW: number
    /** Per-course inward shift on the LEFT (start) end, metres.
     *  Wall `length` is extended by the partner wall's MAX (wall-level)
     *  halfThickness so the chord reaches the outer building corner.
     *  But on a mixed-series partner (e.g. 300 base + 200 above), the
     *  partner's actual block at THIS course is thinner — so the actual
     *  outer face at this Y is `partnerWallLevelHalf - partnerActualHalf`
     *  closer in. Cells that touch s=0 on this course get clamped to
     *  `leftCornerShiftM` so their outer face lands on the partner's
     *  real face at this Y rather than overshooting the centerline. */
    leftCornerShiftM: number
    /** Per-course inward shift on the RIGHT (end) end, metres. Same
     *  rule as `leftCornerShiftM` but for the wall's end side. */
    rightCornerShiftM: number
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
  // Renamed `*Raw` so per-course shadow vars inside grid.map can use
  // the bare names after the mixed-height corner override.
  const leftIsFreeEndRaw =
    wall.startJunction.type === 'free' ||
    wall.startJunction.type === 't-junction' ||
    leftIsControlJoint
  const rightIsFreeEndRaw =
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
  const leftPhaseRaw: CornerPhase | null = leftCornerNeighbor
    ? cornerPhase(leftCornerNeighbor)
    : null
  const rightPhaseRaw: CornerPhase | null = rightCornerNeighbor
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

    // Mixed-height corner: if the partner wall at a corner end is
    // SHORTER than this course's top, the corner doesn't physically
    // exist at this Y — there's nothing perpendicular to bond with.
    // Treat the end as a free end on THIS course only (override
    // leftPhase/rightPhase to null, leftIsFreeEnd/rightIsFreeEnd to
    // true) so the upper courses don't render a corner cube
    // extension into thin air. Shadowing the outer-scope variables
    // here scopes the override to this course's grid entry without
    // touching the wall-level corner config.
    const courseTopMm = course.y1 * 1000
    const leftPartnerHeight =
      leftCornerNeighbor !== undefined && wallHeightMmByWallId
        ? wallHeightMmByWallId[leftCornerNeighbor]
        : undefined
    const rightPartnerHeight =
      rightCornerNeighbor !== undefined && wallHeightMmByWallId
        ? wallHeightMmByWallId[rightCornerNeighbor]
        : undefined
    const leftCornerActive =
      leftPartnerHeight === undefined || courseTopMm <= leftPartnerHeight + 0.5
    const rightCornerActive =
      rightPartnerHeight === undefined || courseTopMm <= rightPartnerHeight + 0.5
    const leftPhase = leftCornerActive ? leftPhaseRaw : null
    const rightPhase = rightCornerActive ? rightPhaseRaw : null
    const leftIsFreeEnd = leftIsFreeEndRaw || !leftCornerActive
    const rightIsFreeEnd = rightIsFreeEndRaw || !rightCornerActive

    // Half blocks alternate at every non-corner end in stretcher
    // bond — including control joints. The seam between two split
    // halves should show two free-end terminations meeting (full
    // corner on odd courses, half block on even on each side).
    const useHalfLeft = isEvenStretcher && leftIsFreeEnd
    const useHalfRight = isEvenStretcher && rightIsFreeEnd

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
    // Half-end slot face width is dictated by the BOND, not by whichever
    // block the user nominated for the slot. Stretcher bond's half-end
    // position must offset the body grid by exactly half a body+mortar
    // module — geometry-locked. So the slot face = (bodyFace − mortar)
    // / 2 regardless of what block is in there. If the user picks a
    // full block (e.g. 20.01 = 390 mm) for the half slot, the 3D
    // caps the render width at the slot, visually cutting the block
    // to fit. The bond is preserved no matter what; the block adapts.
    //
    // For 20.48 (390 mm body): half slot face = (390 − 10) / 2 = 190 mm
    // For 30.48 (290 mm body): half slot face = (290 − 10) / 2 = 140 mm
    //
    // Stack bond never uses the half slot, so this only kicks in when
    // useHalfLeft / useHalfRight is true. The library width still
    // serves as the floor — if the user picks a 20.03 half (190 mm)
    // for a 20.48 wall, library width = slot width, no cut visible.
    const BLOCK_MORTAR_MM = 10
    const bodyFaceMm = widthOf(course.bodyCode, library, FALLBACK_BODY_WIDTH_MM)
    const halfSlotFaceMm = Math.max(1, (bodyFaceMm - BLOCK_MORTAR_MM) / 2)
    const halfBlockLibraryWMm = widthOf(course.halfCode, library, FALLBACK_HALF_WIDTH_MM)
    const halfBlockW = Math.min(halfBlockLibraryWMm, halfSlotFaceMm) / 1000
    const cornerWidth =
      widthOf(course.cornerCode, library, FALLBACK_CORNER_WIDTH_MM) / 1000
    // Corner cube depth on this wall's axis = perpendicular wall's
    // depth AT THIS COURSE'S Y. For uniform walls this matches the
    // partner's overall thickness; for mixed-series partners (e.g.
    // 300 base + 200 above), it shrinks to the partner's actual
    // block depth at this y so the cube doesn't extend past the
    // narrower upper courses. Falls back to wall-level thickness
    // when partner courses aren't available.
    const partnerCubeDepthM = (partnerId: string | undefined): number => {
      if (partnerId === undefined) return thicknessMm / 1000
      const partnerCourses = wallCoursesById?.[partnerId]
      if (partnerCourses) {
        const yMid = (course.y0 + course.y1) / 2
        for (const pc of partnerCourses) {
          if (yMid >= pc.y0 - 0.001 && yMid <= pc.y1 + 0.001) {
            const d = library[pc.bodyCode]?.dimensions.depthMm
            if (typeof d === 'number') return d / 1000
            break
          }
        }
      }
      return (wallThicknessByWallId[partnerId] ?? thicknessMm) / 1000
    }
    const leftCornerCubeDepth = partnerCubeDepthM(leftCornerNeighbor)
    const rightCornerCubeDepth = partnerCubeDepthM(rightCornerNeighbor)
    // Per-course outer-face shift on this wall's axis.
    //
    // The wall's `length` was computed with `outerEdgeEndpoints` using
    // each corner partner's WALL-LEVEL thickness (the partner's maximum
    // thickness across its courses) — so the chord extends to the outer
    // building corner of the WIDEST partner course. For a mixed-series
    // partner (e.g. 300 base + 200 above), every course where the
    // partner's actual block is thinner than its wall-level max has its
    // real outer-face plane closer in by (partnerWallLevelHalf −
    // partnerActualHalfAtY). Without correction the corner block on
    // this course pokes 50mm past the partner's real face — exactly
    // the symptom of "200 above 300 corner pushing out" the user sees.
    //
    // partnerCubeDepthM returns the partner's FULL block depth at this
    // course's Y (in metres), so partnerActualHalfM = cubeDepth/2.
    // wallThicknessByWallId is mm; convert.
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
    const leftCornerShiftM =
      leftCornerActive && leftCornerNeighbor !== undefined
        ? Math.max(0, leftWallLevelHalfM - leftCornerCubeDepth / 2)
        : 0
    const rightCornerShiftM =
      rightCornerActive && rightCornerNeighbor !== undefined
        ? Math.max(0, rightWallLevelHalfM - rightCornerCubeDepth / 2)
        : 0
    const leftHasCornerJunction = leftPhase !== null
    const rightHasCornerJunction = rightPhase !== null
    const ownsLeftThisCourse =
      leftHasCornerJunction &&
      (cornerOwnership
        ? cornerOwnership({ wallEnd: 'start', courseNumber: course.courseNumber })
        : ownsCornerThisCourse(leftPhase, course.courseNumber))
    const ownsRightThisCourse =
      rightHasCornerJunction &&
      (cornerOwnership
        ? cornerOwnership({ wallEnd: 'end', courseNumber: course.courseNumber })
        : ownsCornerThisCourse(rightPhase, course.courseNumber))

    const leftEndCode = useHalfLeft ? course.halfCode : course.cornerCode
    const rightEndCode = useHalfRight ? course.halfCode : course.cornerCode
    const leftEndColor = colorOf(leftEndCode)
    const rightEndColor = colorOf(rightEndCode)
    // Corner-junction non-ownership: the shared corner cube is ONE
    // physical block, owned by exactly one of the two walls per course.
    // The owning wall's corner block fills the cube + extends into its
    // body region; the non-owning wall must NOT render its own end
    // cell at the cube area (the cube position is in the other wall's
    // geometry already). Without this suppression, both walls draw an
    // orange end block at the same world position with the same colour
    // — they merge visually into one block with no joint between them,
    // which is what makes short corner extensions look like the two
    // walls are morphing into each other at the corner.
    //
    // The end WIDTH (cubeDepth) is still used below for body-region
    // alignment so the stretcher half-offset between owning/non-owning
    // courses still emerges naturally — body cells just start AT the
    // cube boundary instead of past an end cell.
    const renderLeftEnd = !leftHasCornerJunction || ownsLeftThisCourse
    const renderRightEnd = !rightHasCornerJunction || ownsRightThisCourse
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
      // single BODY cell at the wall length. Real masons cut a body
      // block to fit rather than chopping down a corner/half — corner
      // blocks have finished end faces you don't want to waste, and
      // body blocks are cheaper. The cell's BOX width matches the
      // wall length (not the block's natural width) because the
      // geometry has to fit the wall.
      cells.push({
        role: 'BODY',
        code: course.bodyCode,
        color: bodyColor,
        s0: 0,
        s1: length,
      })
    } else if (length < leftEndWidth + rightEndWidth) {
      // Wall too short for both end blocks at their natural widths.
      // Cutting priority: keep the FREE-END half / corner block at
      // its natural width (its finished short face IS the visible
      // end of the wall — chopping it down wastes the finish) and
      // cut whichever end is the CORNER-JUNCTION end (its block
      // extends into a corner cube that the perpendicular wall is
      // also building around, so trimming its body-facing edge
      // doesn't waste anything).
      //
      // When both ends are corner junctions (rare on short walls)
      // or both are free, neither has clear priority — fall back to
      // "left natural + body fill" so at least one end stays at full
      // width and the leftover sliver is a body cut, matching the
      // standard layout's rule that body cells absorb length cuts.
      if (leftHasCornerJunction && !rightHasCornerJunction) {
        // Cut LEFT (corner junction), keep RIGHT (free end half /
        // corner) at natural width. But if the LEFT is a non-owning
        // cube (perpendicular wall covers [0, leftEndWidth]), the
        // RIGHT end can't extend into the cube — it has to start at
        // the cube boundary, which means cutting the right end too
        // when the wall is shorter than cube + naturalRightEnd.
        const idealRightStart = length - rightEndWidth
        const rightStart = !renderLeftEnd
          ? Math.max(leftEndWidth, idealRightStart)
          : idealRightStart
        if (renderLeftEnd && rightStart > 0.02) {
          cells.push({
            role: 'END',
            code: leftEndCode,
            color: leftEndColor,
            s0: 0,
            s1: rightStart,
          })
        } else if (!renderLeftEnd && rightStart > leftEndWidth + 0.02) {
          // Non-owning cube: perpendicular wall covers [0, leftEndWidth].
          // Fill the gap between cube boundary and right end with body.
          cells.push({
            role: 'BODY',
            code: course.bodyCode,
            color: bodyColor,
            s0: leftEndWidth,
            s1: rightStart,
          })
        }
        if (renderRightEnd && length - rightStart > 0.02) {
          cells.push({
            role: 'END',
            code: rightEndCode,
            color: rightEndColor,
            s0: rightStart,
            s1: length,
          })
        }
      } else if (rightHasCornerJunction && !leftHasCornerJunction) {
        // Mirror of above — cut RIGHT, keep LEFT at natural. If
        // RIGHT is non-owning cube, LEFT end can't extend past the
        // (length - rightEndWidth) cube boundary.
        const idealLeftEnd = leftEndWidth
        const leftEnd = !renderRightEnd
          ? Math.min(length - rightEndWidth, idealLeftEnd)
          : idealLeftEnd
        if (renderLeftEnd && leftEnd > 0.02) {
          cells.push({
            role: 'END',
            code: leftEndCode,
            color: leftEndColor,
            s0: 0,
            s1: leftEnd,
          })
        }
        const rightCellStart = leftEnd
        if (renderRightEnd && length - rightCellStart > 0.02) {
          cells.push({
            role: 'END',
            code: rightEndCode,
            color: rightEndColor,
            s0: rightCellStart,
            s1: length,
          })
        } else if (!renderRightEnd && (length - rightEndWidth) - leftEnd > 0.02) {
          // Non-owning right cube: perpendicular wall covers [length-rightEndWidth, length].
          // Fill the gap between left end and cube boundary with body.
          cells.push({
            role: 'BODY',
            code: course.bodyCode,
            color: bodyColor,
            s0: leftEnd,
            s1: length - rightEndWidth,
          })
        }
      } else {
        // Both corner OR both free — no clear priority. Left at
        // natural width, body cell fills the leftover.
        if (renderLeftEnd) {
          cells.push({
            role: 'END',
            code: leftEndCode,
            color: leftEndColor,
            s0: 0,
            s1: leftEndWidth,
          })
        }
        if (length - leftEndWidth > 0.02) {
          cells.push({
            role: 'BODY',
            code: course.bodyCode,
            color: bodyColor,
            s0: leftEndWidth,
            s1: length,
          })
        }
      }
    } else {
      if (renderLeftEnd) {
        cells.push({
          role: 'END',
          code: leftEndCode,
          color: leftEndColor,
          s0: 0,
          s1: leftEndWidth,
        })
      }
      // Cut block after the corner on owning courses — gets the body
      // grid back on stretcher bond when the block series is deep
      // (e.g. 300-series: bodyDepth 290 vs bodyLength 390 → 90mm cut).
      // For 200-series (depth = halfLength) the math gives 0 → no cell.
      const bodyDepthM = thicknessMm / 1000
      const mortarM = DEFAULT_MORTAR_JOINT_MM / 1000
      const halfBodyModularM = (bodyW + mortarM) / 2
      let c = leftEndWidth + gridMortarM
      if (leftHasCornerJunction && ownsLeftThisCourse) {
        const cutW =
          halfBodyModularM - (cornerWidth - leftCornerCubeDepth) - mortarM
        if (cutW > 0.005) {
          cells.push({
            role: 'BODY',
            code: course.bodyCode,
            color: bodyColor,
            s0: c,
            s1: c + cutW,
          })
          c += cutW + gridMortarM
        }
      }
      const rightCutW =
        rightHasCornerJunction && ownsRightThisCourse
          ? halfBodyModularM - (cornerWidth - rightCornerCubeDepth) - mortarM
          : 0
      const stampRightCut = rightCutW > 0.005
      const bodyEnd =
        length -
        rightEndWidth -
        gridMortarM -
        (stampRightCut ? rightCutW + gridMortarM : 0)
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
        c += bodyW + gridMortarM
      }
      if (stampRightCut) {
        cells.push({
          role: 'BODY',
          code: course.bodyCode,
          color: bodyColor,
          s0: bodyEnd + gridMortarM,
          s1: bodyEnd + gridMortarM + rightCutW,
        })
      }
      if (renderRightEnd) {
        cells.push({
          role: 'END',
          code: rightEndCode,
          color: rightEndColor,
          s0: length - rightEndWidth,
          s1: length,
        })
      }
      // Suppress unused-var lint for bodyDepthM (kept for future use).
      void bodyDepthM
    }
    return {
      course,
      cells,
      endCode,
      endColor,
      endWidth,
      leftEndWidth,
      rightEndWidth,
      bodyW,
      leftCornerShiftM,
      rightCornerShiftM,
    }
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

    // End-block boundaries on this course. Jambs must stay inside the
    // body region — without these clamps a jamb stamped right at a
    // wall corner overlaps the corner block's column, producing the
    // doubled / confused pattern at the corner.
    const leftBodyStart = entry.leftEndWidth
    const rightBodyEnd = length - entry.rightEndWidth

    for (let i = 0; i < openingsFull.length; i++) {
      const op = openingsFull[i]
      const prevOp = i > 0 ? openingsFull[i - 1] : null
      const nextOp = i < openingsFull.length - 1 ? openingsFull[i + 1] : null

      // Left jamb of this opening — at [start, op.start].
      // Start is the LARGEST of: wall body start (leftEndWidth),
      // ideal jambW back from op, OR midpoint of the pier between
      // prev opening and this one (so paired inner jambs meet rather
      // than overlap). Clamping at leftBodyStart prevents the jamb
      // from overlapping the corner / end block at the wall start.
      const leftIdeal = op.start - jambW
      const leftFloor = prevOp ? (prevOp.end + op.start) / 2 : leftBodyStart
      const leftJambStart = Math.max(leftBodyStart, leftIdeal, leftFloor)
      // Also clamp the END of the left jamb — if the opening's edge
      // is inside the end-block region (very near corner), there's
      // no space for a jamb at all and we skip it.
      const leftJambEnd = Math.min(op.start, rightBodyEnd)
      if (leftJambEnd - leftJambStart > 0.02) {
        stampZone(cells, leftJambStart, leftJambEnd, {
          role: 'JAMB',
          code: jambCode,
          color: jambColor,
          s0: leftJambStart,
          s1: leftJambEnd,
        })
      }

      // Right jamb of this opening — at [op.end, end]. End is
      // the SMALLEST of: wall body end (length-rightEndWidth), ideal
      // jambW forward from op, OR midpoint of the pier with next
      // opening. Clamping at rightBodyEnd prevents the jamb from
      // overlapping the corner / end block at the wall end.
      const rightIdeal = op.end + jambW
      const rightCeil = nextOp ? (op.end + nextOp.start) / 2 : rightBodyEnd
      const rightJambEnd = Math.min(rightBodyEnd, rightIdeal, rightCeil)
      const rightJambStart = Math.max(op.end, leftBodyStart)
      if (rightJambEnd - rightJambStart > 0.02) {
        stampZone(cells, rightJambStart, rightJambEnd, {
          role: 'JAMB',
          code: jambCode,
          color: jambColor,
          s0: rightJambStart,
          s1: rightJambEnd,
        })
      }
    }
  }

  // ── Phase 4: stamp lintels ───────────────────────────────────────
  // Lintels span multiple courses vertically (e.g. 20.18 = 390mm = 2
  // course heights). For each lintel footprint, in EVERY course it
  // overlaps, remove cells in the lintel x range. Then emit the
  // lintel separately as its own multi-course mesh (Phase 6 below).
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
  // Snapshot each course's BODY-cell positions BEFORE the lintel stamp
  // clears them. The Phase 6 "pack lintel top course remainder" pass
  // uses this to align its fill blocks with the course's natural
  // stretcher bond offset — without it the pack stepped linearly from
  // the lintel's start, breaking the bond pattern across the lintel
  // column. Stored per-course, indexed by course reference identity.
  const bodyCellSnapshot = new Map<
    CourseEntry,
    Array<{ s0: number; s1: number }>
  >()
  for (const entry of grid) {
    bodyCellSnapshot.set(
      entry,
      entry.cells
        .filter((c) => c.role === 'BODY')
        .map((c) => ({ s0: c.s0, s1: c.s1 })),
    )
  }
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

    // No separate height-makeup gap-fill above the lintel — the
    // "pack lintel top course remainder" block further down (Phase 6,
    // "Pack the remainder of the lintel's TOP course") already fills
    // the space between the lintel top and the next course boundary
    // with cut blocks from the course's own bodyCode. With both paths
    // active the wall double-rendered: a magenta height-makeup band
    // PLUS a cyan top-course remainder, stacked. The pack path is the
    // right one because it picks up the course's intended block (top
    // course on the top, body on a middle course), so the wall reads
    // as one continuous course composition above the lintel instead
    // of an extra makeup band the calc doesn't even count.
  }

  // ── Phase 4b: sill course override (windows only) ───────────────
  //
  // The HEAD course is handled by the lintel logic above (auto-pick
  // OR user override via headCourseBlockCode). The SILL course is a
  // separate concept: the row of blocks immediately below the
  // opening's bottom edge, on windows only. When the user sets
  // sillCourseBlockCode the cells in that row get overridden to
  // that block.
  if (!disableBlockLintels) {
    for (const op of wallOpenings) {
      const sourceOp = openings.find(
        (o) =>
          o.wallId === wall.id &&
          Math.abs(o.startAlongWallMm / 1000 - op.start) < 0.001 &&
          Math.abs(o.widthMm / 1000 - (op.end - op.start)) < 0.001
      )
      if (!sourceOp) continue
      if (!sourceOp.sillCourseBlockCode || op.sill <= 0.001) continue
      let sillCourse: typeof grid[number] | undefined
      for (let i = grid.length - 1; i >= 0; i--) {
        if (grid[i].course.y1 <= op.sill + 0.001) {
          sillCourse = grid[i]
          break
        }
      }
      if (sillCourse) {
        const code = sourceOp.sillCourseBlockCode as BlockCode
        stampZone(sillCourse.cells, op.start, op.end, {
          role: 'BODY',
          code,
          color: colorOf(code),
          s0: op.start,
          s1: op.end,
        })
      }
    }
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
        Math.abs(cur.s1 - next.s0) < gridMortarM + 0.001 &&
        cur.s1 - cur.s0 < bodyW * 0.9 &&
        next.s1 - next.s0 < bodyW * 0.9
      ) {
        cur.s1 = next.s1
        cells.splice(i + 1, 1)
      }
    }
  }

  // ── Phase 4.7: per-course outer-edge translate-and-trim ────────
  // For courses where the partner wall's actual block at this Y is
  // thinner than the partner's wall-level max thickness, the actual
  // outer corner sits inboard by (partnerWallLevelHalf − partnerActualHalf).
  // Translate cells touching the wall's left/right edge by that shift
  // (PRESERVING their natural width — corner block stays at e.g. 390mm
  // instead of being clipped shorter), then trim any body cells the
  // shifted ends overlap into. For uniform partners both shifts are 0
  // and this phase is a no-op.
  for (const entry of grid) {
    const { cells, leftCornerShiftM, rightCornerShiftM } = entry
    if (leftCornerShiftM < 0.001 && rightCornerShiftM < 0.001) continue
    // Translate any cell whose outer edge sits at the wall start (s=0)
    // inward by leftCornerShiftM. Width preserved.
    if (leftCornerShiftM > 0.001) {
      for (const cell of cells) {
        if (cell.s0 < 0.001) {
          cell.s0 += leftCornerShiftM
          cell.s1 += leftCornerShiftM
        }
      }
    }
    // Same for the wall end (s=length).
    if (rightCornerShiftM > 0.001) {
      for (const cell of cells) {
        if (cell.s1 > length - 0.001) {
          cell.s0 -= rightCornerShiftM
          cell.s1 -= rightCornerShiftM
        }
      }
    }
    // After translation, the body cell adjacent to a shifted end now
    // overlaps the shifted end. Resolve by trimming the right-hand
    // cell's start to meet the left-hand cell's end (real masons
    // would cut the body block to fit at the corner).
    cells.sort((a, b) => a.s0 - b.s0)
    for (let i = 0; i < cells.length - 1; i++) {
      if (cells[i].s1 > cells[i + 1].s0 + 0.001) {
        cells[i + 1].s0 = cells[i].s1
      }
    }
    // Drop slivers left over after trim.
    for (let i = cells.length - 1; i >= 0; i--) {
      if (cells[i].s1 - cells[i].s0 < 0.02) cells.splice(i, 1)
    }
  }

  // ── Phase 5: emit cells ──────────────────────────────────────────
  // Openings whose sill / head land MID-course (e.g. sill 700 on a
  // 200mm grid) partially overlap a course in Y. The old rule left
  // those courses untouched ("mortar fills the straddle"), which
  // rendered the wall THROUGH the opening's partial band and left an
  // air gap above lintels. Real masonry cuts blocks to the sill and
  // packs above the head — so a cell crossed by a partial opening now
  // emits as CUT sub-bands (above and/or below the void) instead of a
  // full-height cell. Each sub-band box still carries the cell's code
  // and course, so the tally counts the cut blocks like any others.
  const MIN_BAND_M = 0.03
  for (const { course, cells } of grid) {
    for (const cell of cells) {
      if (cell.role === 'REMOVED') continue
      // Partial-overlap openings crossing this cell's x-range.
      const partials = wallOpenings.filter(
        (op) =>
          op.start < cell.s1 - 0.001 &&
          op.end > cell.s0 + 0.001 &&
          // overlaps the course in y...
          op.head > course.y0 + 0.001 &&
          op.sill < course.y1 - 0.001 &&
          // ...but does NOT fully cover it (those were carved in Phase 2)
          !(op.sill <= course.y0 + 0.001 && op.head >= course.y1 - 0.001)
      )
      if (partials.length === 0) {
        boxes.push(
          buildBox(
            cell.s0, cell.s1, course.y0, course.y1, cell.color, cell.code,
            course.courseNumber
          )
        )
        continue
      }
      // Split the cell along x at the opening edges; emit full-height
      // segments outside the opening span and cut sub-bands inside it.
      const xCuts = [cell.s0, cell.s1]
      for (const op of partials) {
        if (op.start > cell.s0 && op.start < cell.s1) xCuts.push(op.start)
        if (op.end > cell.s0 && op.end < cell.s1) xCuts.push(op.end)
      }
      xCuts.sort((a, b) => a - b)
      for (let i = 0; i < xCuts.length - 1; i++) {
        const x0 = xCuts[i]
        const x1 = xCuts[i + 1]
        if (x1 - x0 < 0.02) continue
        const inOpening = partials.find(
          (op) => op.start <= x0 + 0.001 && op.end >= x1 - 0.001
        )
        if (!inOpening) {
          boxes.push(
            buildBox(
              x0, x1, course.y0, course.y1, cell.color, cell.code,
              course.courseNumber
            )
          )
          continue
        }
        // Below the void: course bottom up to the sill.
        const lowTop = Math.min(course.y1, inOpening.sill)
        if (lowTop - course.y0 >= MIN_BAND_M) {
          boxes.push(
            buildBox(
              x0, x1, course.y0, lowTop, cell.color, cell.code,
              course.courseNumber
            )
          )
        }
        // Above the void: head up to the course top.
        const highBottom = Math.max(course.y0, inOpening.head)
        if (course.y1 - highBottom >= MIN_BAND_M) {
          boxes.push(
            buildBox(
              x0, x1, highBottom, course.y1, cell.color, cell.code,
              course.courseNumber
            )
          )
        }
      }
    }
  }

  // ── Phase 6: emit lintels (as individual blocks across span) ────
  // Each lintel footprint becomes a row of lintel-coded blocks at
  // the lintel's natural block width, spanning [s0, s1] at the
  // lintel's y-range. Body cells in this range were already removed
  // in Phase 4.
  for (const lm of lintelMeshes) {
    let cursor = lm.s0
    while (cursor < lm.s1) {
      const blockEnd = Math.min(cursor + lm.blockWidthM, lm.s1)
      if (blockEnd - cursor > 0.02) {
        boxes.push(buildBox(cursor, blockEnd, lm.y0, lm.y1, lm.color, lm.code))
      }
      cursor += lm.blockWidthM + gridMortarM
    }
    // Pack the remainder of the lintel's TOP course: when the lintel's
    // top lands mid-course (mid-course opening heads, or a lintel face
    // that isn't a clean course multiple), the full-course carve in
    // Phase 4 left an air gap from the lintel top to the next course
    // boundary. Fill it with cut body blocks aligned to the course's
    // NATURAL stretcher bond — the same s0/s1 positions the cells
    // would have had before the lintel cleared them. Read from the
    // pre-stamp snapshot rather than stepping linearly from the
    // lintel start; otherwise the fill blocks wander off the bond
    // pattern of the courses above/below and the wall reads broken.
    const topCourse = grid.find(
      (g) => g.course.y0 < lm.y1 - 0.005 && g.course.y1 > lm.y1 + 0.005
    )
    if (topCourse) {
      const fillY0 = lm.y1 + gridMortarM
      const fillY1 = topCourse.course.y1
      if (fillY1 - fillY0 >= 0.03) {
        const bodyColor = colorOf(topCourse.course.bodyCode)
        const originalCells = bodyCellSnapshot.get(topCourse) ?? []
        for (const cell of originalCells) {
          // Clip each pre-stamp body cell to the lintel's span. Any
          // cell that doesn't overlap the lintel's column is skipped
          // (the body grid emits it for real above the lintel).
          const cs = Math.max(cell.s0, lm.s0)
          const ce = Math.min(cell.s1, lm.s1)
          if (ce - cs > 0.02) {
            boxes.push(
              buildBox(
                cs, ce, fillY0, fillY1, bodyColor,
                topCourse.course.bodyCode, topCourse.course.courseNumber
              )
            )
          }
        }
      }
    }
  }

  // Phase 7 (mortar emit) intentionally skipped — mortar removed at
  // user request. pushMortar kept defined above so re-enabling
  // later is just removing this `void` line.
  void pushMortar

  return boxes
}
