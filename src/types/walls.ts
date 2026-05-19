/**
 * Wall-related types for beme.
 *
 * All measurements are in millimetres (mm) unless noted.
 */

import type { BlockCode } from './blocks'

/**
 * Bond type — how blocks are arranged from course to course.
 *
 * - 'stretcher': alternating courses are offset by half a block. Visually staggered.
 *   End terminations alternate full (20.01) and half (20.03) per course.
 *
 * - 'stack': courses align vertically. No offset.
 *   End column uses a single block type (20.01 or 20.03) full height,
 *   selected by best-fit length.
 */
export type BondType = 'stretcher' | 'stack'

/**
 * Specifies what block to use for a specific course (row) in a wall,
 * overriding the wall makeup's default body block.
 *
 * Used for intermediate bond beams, height-makeup courses (20.71 / 20.140),
 * or any course that needs a different block.
 */
export interface CourseOverride {
  /** Course number, 1-indexed from the bottom (so course 1 is the base course). */
  courseNumber: number
  /** Block to use for the body of that course. */
  blockCode: BlockCode
}

/**
 * A contiguous run of courses that uses a different block series than the rest
 * of the wall.
 *
 * Lets a user say "the bottom 5 courses use the wider 300 series for engineering
 * (290 mm-deep blocks), and everything above sits on the standard 200 series".
 * Each range carries its own overrides for the role-based block picks the calc
 * engine makes (body, corner, end-termination half, base-course cleanout/tile,
 * and the half-height makeup row). Anything not specified falls back to the
 * makeup's top-level default — so a range is "additive": only set the codes
 * that differ from the rest of the wall.
 *
 * Course numbers are 1-indexed from the base. Ranges must not overlap; the
 * calc engine takes the FIRST matching range when looking up a block code for
 * a given course, so overlap would be ambiguous. The UI enforces this.
 */
export interface CourseSeriesRange {
  /** First course (1-indexed) in this range, inclusive. */
  fromCourse: number
  /**
   * Last course (1-indexed) in this range, inclusive. Use a value greater than
   * the wall's total course count to mean "to the top" — the calc engine just
   * checks `course >= fromCourse && course <= toCourse`, so any large number
   * (e.g. 9999) works as an open-ended upper bound.
   */
  toCourse: number
  /** Body block (e.g. 30.48 in a 300-series range). */
  bodyBlockCode?: BlockCode
  /** Full end / corner block (e.g. 30.01). Used at both corners and as the
   *  odd-course end in stretcher bond. */
  cornerBlockCode?: BlockCode
  /** Half block used on even courses in stretcher bond (e.g. 30.03). Falls back
   *  to 20.03 when not set. */
  halfBlockCode?: BlockCode
  /** Base-course cleanout block. Only consulted when the range covers course 1. */
  baseCourseBlockCode?: BlockCode
  /** Tile paired with the base-course cleanout. Only consulted when the range
   *  covers course 1. */
  baseCourseTileCode?: BlockCode
  /** 90 mm half-height makeup block (e.g. 30.71). Used when the height-makeup
   *  row for this wall falls inside this range. Falls back to 20.71. */
  heightMakeup71BlockCode?: BlockCode
  /**
   * Optional "corner lead-in" block laid between the corner block and the
   * regular body on every course at a CORNER end. Used in 300 series because
   * the 30.01 corner block's 290 mm depth would otherwise leave the next 30.48
   * body off the stretcher offset — two 30.02 cube blocks absorb that and get
   * the wall back on bond. Defaults to 2 lead-ins per corner end when set;
   * override via `cornerLeadInCount`.
   *
   * Only fires at junction-type 'corner'; free / T-junction / control-joint
   * ends still use the normal corner / half alternation. When unset, no lead-in
   * is added (standard 200-series behaviour).
   */
  cornerLeadInBlockCode?: BlockCode
  /** How many lead-in blocks to place at each corner end. Defaults to 2. */
  cornerLeadInCount?: number
}

/**
 * Pier configurations supported by beme.
 *
 * - 'tied': pier built into the wall. 40.925 every 2nd course with 20.01 the others.
 * - 'freestanding': separate pier. 40.925 stacked every course.
 */
export type PierType = 'tied' | 'freestanding'

/**
 * Wall makeup — the structural spec for a *type* of wall.
 *
 * A project can have multiple makeups (e.g. "External 3100mm Stretcher", "Internal 2400mm Stack")
 * and each drawn wall references one makeup by id. Walls can be reassigned a different
 * makeup after drawing.
 */
export interface WallMakeup {
  /** Unique id within the project. */
  id: string
  /** Human-readable name, e.g. "External 3100mm Stretcher". */
  name: string

  bondType: BondType
  /** Wall height in mm. */
  heightMm: number

  // ---- Course composition ----
  /** Block used for the base (bottom) course. Default: 20.45 cleanout. */
  baseCourseBlockCode: BlockCode
  /** Tile paired with every base course block. Default: 50.45. Omit if none. */
  baseCourseTileCode?: BlockCode
  /** Default body block for the middle of the wall. Default: 20.48 H block. */
  bodyBlockCode: BlockCode
  /** Block used for the top course. 20.20 if a bond beam is required, otherwise 20.48. */
  topCourseBlockCode: BlockCode

  /**
   * Per-course overrides for any course that doesn't use the default body block.
   * Useful for intermediate bond beams or height-makeup rows.
   */
  courseOverrides?: CourseOverride[]

  /**
   * Optional list of course-series ranges. When present, courses inside a range
   * pick their body / end / corner / base / height-makeup blocks from the
   * range's overrides instead of the makeup defaults. Used to mix 300 series
   * (wider, engineering-required base courses) with standard 200 series above,
   * or any analogous mix. Empty / undefined → wall uses the makeup defaults
   * for every course (legacy behaviour).
   */
  courseSeriesRanges?: CourseSeriesRange[]

  // ---- Corner / termination preferences ----
  /**
   * Preferred corner block. Defaults to 20.01 (Standard).
   * Use 20.21 (Knockout Corner) where better corefill is needed.
   */
  cornerBlockCode: BlockCode

  // ---- Length-makeup behaviour ----
  /**
   * When true, beme uses fraction blocks (20.02 and 20.22) to absorb leftover length,
   * picking the combination that minimises leftover with no cuts where possible.
   * When false, the wall is built from full 20.48 blocks rounded up, with the last cut.
   */
  useFractions: boolean

  // ---- Pier ----
  /** If walls of this makeup contain piers, what type. */
  pierType?: PierType

  /**
   * Centreline radius (mm) of the curve this makeup was auto-created for. Set
   * by the curve-placement flow when a curved wall is drawn — present means
   * "this is a curved-wall makeup". Drives the WallTypeForm's dual section
   * UI: one section for the 20.03CW wedge composition, one for normal-block
   * composition. The radius decides which section is editable (the other is
   * disabled with a hint), so users can't accidentally try to build a wedge
   * wall with normal blocks (or vice-versa).
   *
   * Absent / undefined means this is a regular (non-curved) wall makeup and
   * the standard single Block Composition section is rendered.
   */
  curveRadiusMm?: number
}

/**
 * How an end of a wall meets other geometry.
 *
 * - 'free': free end (no other wall here). Gets a standard end termination.
 * - 'corner': formed when a new wall is drawn off the free end of an existing wall.
 *             In stretcher bond, 20.03 halves are substituted for 20.01 fulls at this column.
 * - 't-junction': this wall butts into the middle of another. Treated as a free end
 *                 (standard end termination) but with no tie-in to the through-wall.
 * - 'control-joint': created by a control joint splitting a wall. Both sides get
 *                    a standard end termination.
 */
export type JunctionType = 'free' | 'corner' | 't-junction' | 'control-joint'

export interface WallJunction {
  type: JunctionType
  /** IDs of the other walls involved in this junction (for corners/T-junctions). */
  connectedWallIds?: string[]
}

/**
 * A wall instance drawn on the plan.
 *
 * Start/end coordinates are in real-world millimetres (after scale calibration),
 * not pixels. The calibration converts pixel clicks to mm.
 *
 * Straight walls (default) only use start* and end*. Curved walls additionally
 * carry a midpoint that lies on the arc — start, mid, end together define a
 * unique circle, and the wall renders/tallies as the arc through those three
 * points. Existing saved walls without `kind` are treated as straight.
 */
export interface Wall {
  id: string
  /** References a WallMakeup in the project. */
  makeupId: string
  /** Start point in mm (real world). */
  startX: number
  startY: number
  /** End point in mm. */
  endX: number
  endY: number
  /** Junction state at the start point. */
  startJunction: WallJunction
  /** Junction state at the end point. */
  endJunction: WallJunction
  /** Optional per-wall height override (mm), otherwise inherits from makeup. */
  heightMmOverride?: number
  /**
   * Wall geometry kind. Defaults to 'straight' if missing (so old saved data still loads).
   * 'curved' walls additionally have midX/midY defining a point on the arc between
   * start and end.
   */
  kind?: 'straight' | 'curved'
  /** Midpoint X for curved walls (a point on the arc, not the chord centre). */
  midX?: number
  /** Midpoint Y for curved walls. */
  midY?: number
}

/**
 * A pier on the plan.
 *
 * The PIER instance carries placement information (where it sits, and whether it's tied
 * into a wall or freestanding). The block composition — which blocks make up the pier
 * column and in what order — lives separately on a {@link PierMakeup}, referenced by id.
 *
 * - Tied: built into the wall at a specific point along it. Inherits the wall's height.
 *   In the default tied makeup the pier column alternates 40.925 / 20.01 per course over
 *   the wall's full course count. The pier also displaces one body block per course at
 *   that position on the wall.
 *
 * - Freestanding: a standalone pier placed anywhere on the plan. Has its own height.
 *   In the default freestanding makeup it's 40.925 stacked every course.
 */
export type Pier = TiedPier | FreestandingPier

export interface TiedPier {
  id: string
  type: 'tied'
  /** Wall this pier is built into. */
  wallId: string
  /** Distance from the wall's start (mm) where the pier sits. */
  alongMm: number
  /** Which pier makeup defines the course pattern. */
  pierMakeupId?: string
}

export interface FreestandingPier {
  id: string
  type: 'freestanding'
  /** Position in real-world mm. */
  x: number
  y: number
  /** Pier height in mm. Must be a multiple of 200 (one course). */
  heightMm: number
  /** Which pier makeup defines the course pattern. */
  pierMakeupId?: string
}

/**
 * A pier makeup — the block-by-block course pattern used for a pier column.
 *
 * The pattern repeats up the pier: course i (1-indexed from the base) uses
 * `coursePattern[(i - 1) % coursePattern.length]`. So a tied default of
 * `['40.925', '20.01']` means course 1 = 40.925, course 2 = 20.01, course 3 = 40.925, …
 *
 * A freestanding default of `['40.925']` means every course is a 40.925.
 *
 * `suggestedPlacement` is only a hint — it controls which makeup is preselected when the
 * user clicks the "+ Tied pier" or "+ Freestanding pier" toolbar buttons. A user can
 * still re-assign any pier to any makeup after placement.
 */
export interface PierMakeup {
  id: string
  name: string
  /** Block code per course, cycling. Length ≥ 1. */
  coursePattern: BlockCode[]
  /** Hint for which placement button picks this makeup as the default. */
  suggestedPlacement: 'tied' | 'freestanding'
}

/**
 * Opening (window or door) on a wall.
 *
 * Position is measured along the wall (start to end) in mm.
 */
export interface Opening {
  id: string
  wallId: string
  /** Distance from the wall's start where the opening begins (mm). */
  startAlongWallMm: number
  /** Width of the opening (mm). */
  widthMm: number
  /** Height of the opening (mm). */
  heightMm: number
  /** Height of the bottom of the opening above the wall base (mm). */
  sillHeightMm: number
  /** Height of the head — typically derived from wall height − sillHeight − openingHeight. */
  headHeightMm?: number
}

/**
 * A block tally for an estimate — total count per block code.
 * Partial because most tallies won't include every code in the library.
 */
export type BlockTally = Partial<Record<BlockCode, number>>

/**
 * A single lintel entry for a brick estimate.
 *
 * `requiredLengthMm` is the raw figure (opening width + 2 × bearing). The actual lintel
 * supplied (`selectedLintel`) is the next stock size up from the catalogue. `selectedLintel`
 * may be null when the required length exceeds the largest stock size — these need a
 * custom lintel and are flagged separately in the UI.
 */
export interface BrickLintelEntry {
  openingId: string
  openingWidthMm: number
  bearingEachSideMm: number
  requiredLengthMm: number
  selectedLintel: { lengthMm: number; profile: string } | null
}

/**
 * Project metadata captured before/during an estimate — used in the exported document header.
 */
export interface ProjectDetails {
  projectName: string
  siteAddress: string
  clientName: string
  estimatorName: string
  /** ISO date string (YYYY-MM-DD). */
  date: string
  /** Multi-line free text — each non-empty line becomes an extra assumption in the export. */
  notes: string
}

/**
 * Tickbox state for which sections to include in the brick estimate export.
 */
export interface BrickExportInclusions {
  assumptions: boolean
  brickAreaSummary: boolean
  lintels: boolean
  brickTies: boolean
  plascourse: boolean
  disclaimer: boolean
}

/**
 * Tickbox state for which sections to include in the block estimate export.
 */
export interface BlockExportInclusions {
  assumptions: boolean
  /**
   * A "Wall Specifications" section listing every wall type used on the
   * project with its bond, height, block composition, any course-series
   * ranges, course overrides, and the walls + total length using it.
   * Sits between Assumptions and the Wall Layout overview pages.
   */
  wallSpecs: boolean
  /** The full block-by-code schedule. */
  blockSchedule: boolean
  /** Breakdown of the schedule grouped by wall type (makeup). */
  wallTypeBreakdown: boolean
  /** List of openings with dimensions, head, sill, and chosen lintel block. */
  openingsList: boolean
  disclaimer: boolean
}

/**
 * Project-level settings for a brick estimate. Applied across all walls/openings on the page.
 */
export interface BrickSettings {
  /** Height applied to newly drawn brick walls. Existing walls keep their `heightMmOverride`. */
  defaultWallHeightMm: number
  /**
   * Active brick type for this project. References a code in the user's BrickLibrary.
   * When set, `bricksPerSquareMetre` is auto-derived from this type unless the user
   * has manually overridden the rate.
   *
   * Older saved projects (pre-brick-library) won't have this — they fall back to the
   * manual `bricksPerSquareMetre` value.
   */
  brickTypeCode?: string
  /**
   * Bricks per square metre of brickwork. Either the auto-derived value from the
   * active brick type, or a manual override.
   *
   * Typical Australian face brick ≈ 48–57 depending on the brick size.
   */
  bricksPerSquareMetre: number
  /** Brick ties — added per m² of brickwork when enabled. */
  ties: {
    enabled: boolean
    perSquareMetre: number
  }
  /** Plascourse — one unit per `metresPerUnit` of brickwork when enabled. */
  plascourse: {
    enabled: boolean
    metresPerUnit: number
  }
}

/**
 * Brick wall makeup — the per-wall spec for a category of brick wall.
 *
 * Parallel to {@link WallMakeup} (block) but with a much smaller field set
 * because brick walls don't have course composition, corner-block rules,
 * pier types, or any of the other things that make a block wall layered.
 * The user defines a handful of named types ("Facework", "Rendered", etc.)
 * and assigns each drawn brick wall to one. The wall picks up the
 * makeup's height + brick type at calc time.
 *
 * Brick ties / plascourse / per-m² rate stay on the project-level
 * {@link BrickSettings} — they're job-wide accounting rules, not per-wall.
 */
export interface BrickMakeup {
  /** Unique id within the project. */
  id: string
  /** Human-readable name, e.g. "Facework", "Rendered", "Common 76mm". */
  name: string
  /**
   * Brick type code this makeup uses. References a row in the user's
   * BrickLibrary. Each makeup carries its own brick type so a single
   * project can mix face brick on the exterior with common brick on the
   * party walls without retallying.
   */
  brickTypeCode: string
  /** Wall height (mm) applied to walls of this type by default. */
  heightMm: number
}
