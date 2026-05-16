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
