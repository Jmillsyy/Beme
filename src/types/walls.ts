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
 * One contiguous run of identical courses inside a wall's vertical stack.
 *
 * Walls can be specified two ways:
 *
 *   1. Legacy: just a target `heightMm` on the makeup. The calc engine
 *      derives uniform 200 mm courses (190 mm block + 10 mm mortar)
 *      and inserts optional 100/150 mm height-makeup courses at the top
 *      to land near the target.
 *
 *   2. Bands: an ordered list of {blockCode, count} entries. Each entry
 *      says "N courses of this block stacked bottom-up". The wall's
 *      height becomes a derived sum of (count × course-modular-height)
 *      across every band. Lets the user spec retaining-wall patterns
 *      like "4× 20.48, 2× 20.71, 4× 20.48, ..." cleanly.
 *
 * Course-modular-height per band = block.heightMm + 10 mm mortar.
 * 20.48 / 20.01 / 20.45 etc → 200 mm modular. 20.71 → 100 mm. 20.140
 * → 150 mm. The library is the source of truth so a user-added block
 * automatically picks up the right modular height.
 *
 * Bands are evaluated bottom-up (band 0 = course 1 = base).
 */
export interface CourseBand {
  /** Block laid across every course in this band. */
  blockCode: BlockCode
  /** How many consecutive courses use this block. Must be ≥ 1. */
  count: number
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
   *
   * Ranges reference 1-indexed course numbers. When a `coursePattern` is set
   * on the makeup, the course numbers a range targets are determined by the
   * bands-derived course list, not by `heightMm / 200`.
   */
  courseSeriesRanges?: CourseSeriesRange[]

  /**
   * Optional repeating course pattern. When present and non-empty, OVERRIDES
   * the legacy "compute uniform 200 mm courses from heightMm" flow:
   *   - Course composition comes from the bands list (bottom-up).
   *   - Wall height becomes the sum of (count × course-modular-height) across
   *     every band. `heightMm` is still stored (and the UI displays the
   *     derived sum) but the bands are authoritative.
   *   - Existing `courseSeriesRanges` and `courseOverrides` apply on top
   *     (range = "courses 1-6 use 300 series" still works regardless of how
   *     the bands derive the course list).
   *
   * Unset / empty → legacy uniform-200 mm flow. Both paths share the rest of
   * the calc engine — only `buildCourses` branches.
   */
  coursePattern?: CourseBand[]

  // ---- Corner / termination preferences ----
  /**
   * Full-length end-termination / corner block. Defaults to 20.01 in the
   * seed library but any block from the user's library can stand in here —
   * 20.21 (Knockout Corner) for better corefill, a 290 mm short end for
   * specific suppliers, etc. Used at every corner and on odd courses of
   * stretcher bond at free / T-junction / control-joint ends.
   */
  cornerBlockCode: BlockCode
  /**
   * Half-length end-termination block. Defaults to 20.03 in the seed
   * library; user-replaceable per makeup. Used on even courses of
   * stretcher bond at free / T-junction / control-joint ends to maintain
   * the half-block offset. When unset (older saved projects) the calc
   * engine falls back to picking the library's role-tagged half block.
   */
  halfBlockCode?: BlockCode

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
  /**
   * Height for piers of this type, in mm. Used by freestanding piers — they
   * inherit this when placed and update when the makeup is edited. Tied
   * piers ignore this and always take their host wall's height.
   *
   * Optional + missing on saves predating the type-level pier-height field.
   */
  heightMm?: number
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

// BrickLintelEntry removed — brick lintels are now per-opening supply
// items the user defines in the material library, tagged with an
// opening-width range. The tally / export tally those supplies
// alongside ties, flashings, etc.

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
  /**
   * Per-page "Wall Layout" overview diagrams — one section per PDF page
   * that has walls drawn on it, with the rasterised plan as the background
   * and the walls overlaid in colour. Mirrors the block export's layout
   * pages so the deliverable looks the same across product modes.
   */
  wallLayout: boolean
  /**
   * Overlay the user's on-canvas ruler measurements (dashed lines with the
   * measured distance) onto each Wall Layout overview. Useful when sharing
   * the export with a tradie who needs the same reference dimensions the
   * estimator was working off. Scoped per page — only the measurements
   * drawn on a given page appear on that page's overview.
   */
  measurements: boolean
  brickAreaSummary: boolean
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
  /**
   * Overlay the user's on-canvas ruler measurements (dashed lines with the
   * measured distance) onto each Wall Layout overview. Useful when sharing
   * the export with a tradie who needs the same reference dimensions the
   * estimator was working off. Scoped per page — only the measurements
   * drawn on a given page appear on that page's overview.
   */
  measurements: boolean
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
