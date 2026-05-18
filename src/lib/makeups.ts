/**
 * Factory helpers for creating WallMakeup objects with sensible defaults
 * straight from the Project Brief.
 */

import type { BlockCode } from '../types/blocks'
import type {
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
  }
}

/**
 * Build the initial pair of pier makeups for a new project.
 */
export function createDefaultPierMakeups(): PierMakeup[] {
  return [createDefaultTiedPierMakeup(), createDefaultFreestandingPierMakeup()]
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
  return {
    bodyBlockCode: range?.bodyBlockCode ?? makeup.bodyBlockCode,
    cornerBlockCode: range?.cornerBlockCode ?? makeup.cornerBlockCode,
    halfBlockCode: range?.halfBlockCode ?? defaults.halfBlockCode,
    baseCourseBlockCode: range?.baseCourseBlockCode ?? makeup.baseCourseBlockCode,
    baseCourseTileCode: range?.baseCourseTileCode ?? makeup.baseCourseTileCode,
    heightMakeup71BlockCode:
      range?.heightMakeup71BlockCode ?? defaults.heightMakeup71BlockCode,
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
