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
  /** Curve radius in mm (null/undefined for straight walls). */
  curveRadiusMm?: number
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
 */
export interface BrickLintelEntry {
  openingId: string
  openingWidthMm: number
  bearingEachSideMm: number
  totalLintelLengthMm: number
}
