/**
 * Factory helpers for creating WallMakeup objects with sensible defaults
 * straight from the Project Brief.
 */

import type { BlockCode } from '../types/blocks'
import { BLOCK_LIBRARY } from '../data/blockLibrary'
import { DEFAULT_MORTAR_JOINT_MM } from '../types/blocks'
import type {
  BrickMakeup,
  CourseBand,
  CourseSeriesRange,
  PierMakeup,
  BondType,
  WallMakeup,
} from '../types/walls'

/**
 * Generates a unique id. Uses crypto.randomUUID when available (modern browsers),
 * otherwise falls back to a timestamp-based id for tests / non-browser contexts.
 */
function uid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export interface CreateMakeupOptions {
  name?: string
  bondType?: BondType
  heightMm?: number
  /** When true, the top course is a 20.20 bond beam (e.g. when a slab is poured above). */
  bondBeamOnTop?: boolean
  /**
   * Use 20.21 knockout-corner blocks at corners (for additional corefill at corner cores)
   * rather than the default 20.01.
   */
  knockoutCorners?: boolean
  useFractions?: boolean
}

/**
 * Creates a new wall makeup with defaults from the brief:
 *   - Bond: stretcher
 *   - Height: 2400mm
 *   - Base course: 20.45 cleanouts + 50.45 tiles
 *   - Body: 20.48 H blocks
 *   - Top: 20.48 (or 20.20 if bondBeamOnTop)
 *   - Corner: 20.01 (or 20.21 if knockoutCorners)
 *   - Fractions: ON
 */
export function createDefaultWallMakeup(options: CreateMakeupOptions = {}): WallMakeup {
  const {
    name = 'New wall type',
    bondType = 'stretcher',
    heightMm = 2400,
    bondBeamOnTop = false,
    knockoutCorners = false,
    useFractions = true,
  } = options

  return {
    id: uid(),
    name,
    bondType,
    heightMm,
    baseCourseBlockCode: '20.45',
    baseCourseTileCode: '50.45',
    bodyBlockCode: '20.48',
    topCourseBlockCode: bondBeamOnTop ? '20.20' : '20.48',
    cornerBlockCode: knockoutCorners ? '20.21' : '20.01',
    useFractions,
  }
}

// ---------- Pier makeups ----------

/**
 * Default tied-pier makeup — alternating 40.925 (pier block) and 20.01 (full end block).
 * Course 1 = 40.925, course 2 = 20.01, repeating up the wall height.
 */
export function createDefaultTiedPierMakeup(name = 'Tied pier (40.925 / 20.01)'): PierMakeup {
  return {
    id: uid(),
    name,
    coursePattern: ['40.925', '20.01'],
    suggestedPlacement: 'tied',
  }
}

/**
 * Default freestanding-pier makeup — 40.925 stacked every course.
 */
export function createDefaultFreestandingPierMakeup(
  name = 'Freestanding pier (40.925)'
): PierMakeup {
  return {
    id: uid(),
    name,
    coursePattern: ['40.925'],
    suggestedPlacement: 'freestanding',
    heightMm: 2400,
  }
}

/**
 * Build the initial pair of pier makeups for a new project.
 */
export function createDefaultPierMakeups(): PierMakeup[] {
  return [createDefaultTiedPierMakeup(), createDefaultFreestandingPierMakeup()]
}

// ---------- Brick wall makeups ----------

/**
 * Build a single brick makeup with sensible defaults.
 *
 * Brick wall types come pre-seeded for new projects so estimators don't
 * have to set them up before drawing the first wall. The seeded
 * `brickTypeCode` is intentionally blank — the user picks an actual brick
 * type from the project's brick library when they review the makeup. Until
 * they do, the wall falls back to the project-level `brickSettings.brickTypeCode`
 * at calc time.
 */
export function createDefaultBrickMakeup(opts: {
  name?: string
  heightMm?: number
  brickTypeCode?: string
} = {}): BrickMakeup {
  return {
    id: uid(),
    name: opts.name ?? 'Facework',
    brickTypeCode: opts.brickTypeCode ?? '',
    heightMm: opts.heightMm ?? 2400,
  }
}

/**
 * The default set of brick wall types for a new brick project. Two
 * sensible categories an estimator will reach for on most jobs:
 * facework (visible exterior) and rendered (interior or render-coated).
 * Users add / rename / remove freely.
 */
export function createDefaultBrickMakeups(): BrickMakeup[] {
  return [
    createDefaultBrickMakeup({ name: 'Facework' }),
    createDefaultBrickMakeup({ name: 'Rendered' }),
  ]
}

// ---------- Course series ranges ----------

/**
 * The set of block codes that govern a single course's composition. The block
 * calc engine consults these per course rather than reaching for makeup.* — so
 * a course that lives inside a 300-series range gets 30.48 / 30.01 / 30.03 /
 * 30.45 / 30.71 instead of the 200-series defaults.
 *
 * `heightMakeup140BlockCode` is intentionally not range-able: 20.140 is a
 * 200-series-only height-makeup block, and the doc the user shared doesn't
 * include a 30.140 equivalent. If they need it later it can be added without
 * breaking the shape of this resolver.
 */
export interface ResolvedCourseBlocks {
  bodyBlockCode: BlockCode
  cornerBlockCode: BlockCode
  /** Used on even courses in stretcher bond. 20.03 unless overridden. */
  halfBlockCode: BlockCode
  baseCourseBlockCode: BlockCode
  baseCourseTileCode?: BlockCode
  heightMakeup71BlockCode: BlockCode
  /**
   * If set, this block is laid `cornerLeadInCount` times between the corner
   * block and the regular body on every course at a CORNER end. Undefined
   * means no lead-in (standard 200-series behaviour). See
   * CourseSeriesRange.cornerLeadInBlockCode for the rationale.
   */
  cornerLeadInBlockCode?: BlockCode
  /** Number of cornerLeadInBlockCode to place at each corner end. Defaults
   *  to 2 when cornerLeadInBlockCode is set, 0 otherwise. */
  cornerLeadInCount: number
}

/**
 * Find the range that owns a given course number, or null if no range
 * matches (in which case the calc engine should fall back to the makeup
 * defaults for that course).
 *
 * Ranges are matched in declaration order — the first range whose
 * [fromCourse, toCourse] window contains `courseNumber` wins. Ranges
 * shouldn't overlap; the UI enforces non-overlap, but if a user hand-edits
 * a saved project the calc engine is still deterministic.
 */
export function findSeriesRangeForCourse(
  makeup: WallMakeup,
  courseNumber: number
): CourseSeriesRange | null {
  if (!makeup.courseSeriesRanges?.length) return null
  for (const range of makeup.courseSeriesRanges) {
    if (courseNumber >= range.fromCourse && courseNumber <= range.toCourse) {
      return range
    }
  }
  return null
}

/**
 * Resolve the per-course block picks for course `courseNumber` of `makeup`.
 *
 * Looks up the matching series range and overlays its overrides on top of the
 * makeup defaults. A range without a given override leaves that role on the
 * makeup default, so ranges are "additive" — a user can say "courses 1-5 use
 * 300 series for the body and corner only" and the base course will still be
 * makeup.baseCourseBlockCode.
 *
 * Pass the constants for `defaultHalfBlockCode` (usually '20.03') and
 * `defaultHeightMakeup71BlockCode` (usually '20.71') in via the makeup-level
 * defaults — the calc engine knows these as hard-coded constants today, so we
 * pass them through here too rather than hard-coding inside the resolver.
 */
export function resolveCourseBlocks(
  makeup: WallMakeup,
  courseNumber: number,
  defaults: {
    halfBlockCode: BlockCode
    heightMakeup71BlockCode: BlockCode
  } = { halfBlockCode: '20.03', heightMakeup71BlockCode: '20.71' }
): ResolvedCourseBlocks {
  const range = findSeriesRangeForCourse(makeup, courseNumber)
  const cornerLeadInBlockCode = range?.cornerLeadInBlockCode
  return {
    bodyBlockCode: range?.bodyBlockCode ?? makeup.bodyBlockCode,
    cornerBlockCode: range?.cornerBlockCode ?? makeup.cornerBlockCode,
    // Half-block resolution chain: range override → makeup override (new
    // top-level halfBlockCode field) → constant default. Older makeups
    // without halfBlockCode set fall straight through to the default so
    // pre-existing saves render unchanged.
    halfBlockCode: range?.halfBlockCode ?? makeup.halfBlockCode ?? defaults.halfBlockCode,
    baseCourseBlockCode: range?.baseCourseBlockCode ?? makeup.baseCourseBlockCode,
    baseCourseTileCode: range?.baseCourseTileCode ?? makeup.baseCourseTileCode,
    heightMakeup71BlockCode:
      range?.heightMakeup71BlockCode ?? defaults.heightMakeup71BlockCode,
    cornerLeadInBlockCode,
    cornerLeadInCount: cornerLeadInBlockCode ? range?.cornerLeadInCount ?? 2 : 0,
  }
}

/**
 * Convenience: does this makeup mix more than one block series?
 *
 * Used by the export / UI to decide whether to surface the "mixed series" hint
 * (e.g. show the wall's footprint at its widest course thickness in the wall
 * layout diagram).
 */
export function hasMixedCourseSeries(makeup: WallMakeup): boolean {
  return (makeup.courseSeriesRanges?.length ?? 0) > 0
}

// ─── Course pattern helpers ─────────────────────────────────────────────────

/**
 * Resolve a band's modular course height (mm) — the block's height plus a
 * mortar joint. Falls back to 200 mm when the block isn't in the library
 * (defensive: matches the legacy default rather than zeroing out a course).
 */
export function moduleHeightForBand(
  band: CourseBand,
  library: Record<BlockCode, { dimensions: { heightMm: number } }> = BLOCK_LIBRARY
): number {
  const block = library[band.blockCode]
  if (!block) return 200
  return block.dimensions.heightMm + DEFAULT_MORTAR_JOINT_MM
}

/**
 * Derived wall height for a makeup. When `coursePattern` is set, the bands
 * are authoritative — sum every band's (count × course-modular-height) and
 * return that. Otherwise return `heightMm` (legacy uniform-200 path).
 *
 * Read this helper everywhere `makeup.heightMm` used to be read directly;
 * keeps band-driven walls in lockstep with legacy walls across the UI and
 * the export.
 */
export function getMakeupHeightMm(makeup: WallMakeup): number {
  const bands = makeup.coursePattern
  if (!bands || bands.length === 0) return makeup.heightMm
  let sum = 0
  for (const b of bands) {
    if (b.count <= 0) continue
    sum += b.count * moduleHeightForBand(b)
  }
  return sum
}

/**
 * Total course count for a makeup. Bands → sum of counts; legacy → derived
 * from heightMm / 200 (caller responsible for matching the existing
 * calculateCourseStack behaviour).
 */
export function getCourseCount(makeup: WallMakeup): number {
  const bands = makeup.coursePattern
  if (!bands || bands.length === 0) {
    return Math.max(0, Math.round(makeup.heightMm / 200))
  }
  return bands.reduce((s, b) => s + Math.max(0, b.count), 0)
}

/**
 * Convert an existing legacy makeup into a starting bands list — used when
 * the user clicks "Convert to course pattern" in the wall-type editor.
 *
 * Translates the current calc-engine output (base + N body + optional
 * 100/150 mm height-makeup + top) into bands that produce the same
 * physical wall. The user can then edit / repeat / add bands from there.
 *
 * Conservative: only handles makeups WITHOUT existing courseOverrides
 * cleanly. If the user has overrides, we still seed the bands but flag
 * the result as approximate via the returned `lossy` flag so the UI can
 * tell them.
 */
export function convertMakeupToBands(makeup: WallMakeup): {
  bands: CourseBand[]
  lossy: boolean
} {
  const totalHeight = makeup.heightMm
  const COURSE = 200
  const HEIGHT_71 = 100
  const HEIGHT_140 = 150
  // Mirror calculateCourseStack's logic without importing it (avoid the
  // makeups → blockCalc dependency that doesn't exist today).
  const stdCount = Math.floor(totalHeight / COURSE)
  let remainder = totalHeight - stdCount * COURSE
  let has140 = false
  let has71 = false
  if (remainder >= HEIGHT_140) {
    has140 = true
    remainder -= HEIGHT_140
  }
  if (remainder >= HEIGHT_71) {
    has71 = true
    remainder -= HEIGHT_71
  }
  const totalCourses = stdCount + (has140 ? 1 : 0) + (has71 ? 1 : 0)
  const bands: CourseBand[] = []
  if (totalCourses === 0) {
    return { bands, lossy: false }
  }
  // Course 1 = base; courses 2 .. (N-1) = body; height-makeup goes second-
  // from-top; course N = top.
  // We emit bands so each contiguous run of identical block codes collapses
  // into a single { blockCode, count }.
  const courses: BlockCode[] = []
  courses.push(makeup.baseCourseBlockCode)
  const bodyCount = Math.max(0, stdCount - 2)
  for (let i = 0; i < bodyCount; i++) courses.push(makeup.bodyBlockCode)
  if (has140) courses.push('20.140')
  if (has71) courses.push('20.71')
  if (totalCourses >= 2) courses.push(makeup.topCourseBlockCode)

  for (const code of courses) {
    const last = bands[bands.length - 1]
    if (last && last.blockCode === code) last.count += 1
    else bands.push({ blockCode: code, count: 1 })
  }

  return {
    bands,
    lossy: (makeup.courseOverrides?.length ?? 0) > 0,
  }
}
