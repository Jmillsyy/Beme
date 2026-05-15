/**
 * Block calculation engine — pure functions that turn a Wall + WallMakeup into a BlockTally.
 *
 * This file implements the calculation rules from the Project Brief, focused on Section 4
 * (Block Estimates):
 *
 *   - Course stack: choose how many standard (20.48-height) courses and which height-makeup
 *     courses (20.71 / 20.140) to use for a given wall height (Section 4.4).
 *   - Length fit: pick body block count and fraction blocks (20.02 / 20.22) to absorb leftover
 *     wall length with smallest overshoot (Section 4.6).
 *   - End termination plan: alternating 20.01 / 20.03 per course for stretcher bond, or the
 *     best-fit single block stacked for stack bond (Section 4.5).
 *   - Per-course composition: base course (cleanout + tile + ends), body courses, top course
 *     (bond beam if specified), height-makeup courses placed second from top.
 *   - Combine all course tallies into a single BlockTally for the wall.
 *
 * Out of scope for this iteration (future work):
 *   - Corner block substitution (requires junction state from drawn walls)
 *   - T-junction tie-in / no-tie
 *   - Openings, jamb blocks, lintels
 *   - Piers (tied vs freestanding)
 *   - Control joints
 *   - Curved walls (radius -> standard or 20.03CW)
 *   - Stepped walls (variable height in one run)
 */

import { DEFAULT_MORTAR_JOINT_MM } from '../types/blocks'
import type { BlockCode } from '../types/blocks'
import type { BlockTally, BondType, JunctionType, Wall, WallMakeup } from '../types/walls'

// ---------- Modular constants (block face + mortar joint) ----------

const MORTAR_MM = DEFAULT_MORTAR_JOINT_MM // 10mm

/** Modular height of a standard 20.48-height course (190 + 10). */
const COURSE_MODULE_MM = 200
/** Modular length of a standard body block 20.48 (390 + 10). */
const BODY_BLOCK_MODULE_MM = 400
/** Modular length of a full end block 20.01 (390 + 10). */
const FULL_END_MODULE_MM = 400
/** Modular length of a half end block 20.03 (190 + 10). */
const HALF_END_MODULE_MM = 200
/** Modular length of a 3/4 fraction 20.02 (290 + 10). */
const FRAC_75_MODULE_MM = 300
/** Modular length of a 7/8 fraction 20.22 (340 + 10). */
const FRAC_875_MODULE_MM = 350
/** Modular height of a 20.71 height-makeup course (90 + 10). */
const HEIGHT_MAKEUP_71_MM = 100
/** Modular height of a 20.140 height-makeup course (140 + 10). */
const HEIGHT_MAKEUP_140_MM = 150

// ---------- Tally helpers ----------

/** Add `count` of block `code` to the tally in place. Returns the same tally. */
export function addToTally(tally: BlockTally, code: BlockCode, count = 1): BlockTally {
  tally[code] = (tally[code] ?? 0) + count
  return tally
}

/** Combine any number of tallies into a single tally (does not mutate inputs). */
export function combineTallies(...tallies: BlockTally[]): BlockTally {
  const result: BlockTally = {}
  for (const t of tallies) {
    for (const key of Object.keys(t) as BlockCode[]) {
      const v = t[key]
      if (v) result[key] = (result[key] ?? 0) + v
    }
  }
  return result
}

// ---------- Course stack (height) ----------

export interface CourseStack {
  /** Count of standard (20.48-height = 200mm) courses, including base and top. */
  standardCount: number
  /** True if a 20.71 height-makeup row is included. */
  has71: boolean
  /** True if a 20.140 height-makeup row is included. */
  has140: boolean
  /** Total courses in the wall (standard + 20.71 + 20.140). */
  totalCourses: number
  /** True if the wall height could be made up exactly with the available block heights. */
  valid: boolean
}

/**
 * Decide how the wall height breaks down into courses.
 *
 * Heights per course (modular = block + mortar):
 *   Standard (20.48): 200mm
 *   20.71: 100mm
 *   20.140: 150mm
 *
 * Tries combinations in order of simplicity: all standards, +20.71, +20.140, +both.
 * Returns the first combination that sums to exactly heightMm.
 *
 * Examples (per brief):
 *   3000mm → 15 standard
 *   3100mm → 15 standard + 1× 20.71
 *   3150mm → 15 standard + 1× 20.140
 *   3050mm → 14 standard + 1× 20.71 + 1× 20.140
 */
export function calculateCourseStack(heightMm: number): CourseStack {
  const combos: Array<[number, number]> = [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
  ]
  for (const [a, b] of combos) {
    const remaining = heightMm - a * HEIGHT_MAKEUP_71_MM - b * HEIGHT_MAKEUP_140_MM
    if (remaining >= 0 && remaining % COURSE_MODULE_MM === 0) {
      const N = remaining / COURSE_MODULE_MM
      return {
        standardCount: N,
        has71: a === 1,
        has140: b === 1,
        totalCourses: N + a + b,
        valid: true,
      }
    }
  }
  // Fall back: round down to nearest 200mm and flag as invalid
  const fallbackN = Math.floor(heightMm / COURSE_MODULE_MM)
  return {
    standardCount: fallbackN,
    has71: false,
    has140: false,
    totalCourses: fallbackN,
    valid: false,
  }
}

// ---------- Length fit (body count + fractions) ----------

export interface CourseLengthFit {
  /** Number of body blocks across this course. */
  bodyCount: number
  /** Fraction blocks used adjacent to the ends — 0, 1, or 2 entries of {20.02, 20.22}. */
  fractions: BlockCode[]
  /** Actual built length in mm (≥ wallLengthMm). */
  actualLengthMm: number
  /** Number of cut blocks (only > 0 when fractions are OFF and rounding leaves a cut). */
  cutBlocks: number
}

interface FractionOption {
  code: BlockCode
  modular: number
}

const FRACTION_OPTIONS: FractionOption[] = [
  { code: '20.02', modular: FRAC_75_MODULE_MM },
  { code: '20.22', modular: FRAC_875_MODULE_MM },
]

/**
 * Find the combination of fraction blocks (optional) and body blocks (variable count)
 * that achieves a length closest to but ≥ wallLengthMm, given a fixed total end-block
 * modular contribution.
 *
 * When fractions are ON:
 *   Tries 0, 1, or 2 fraction blocks (each independently one of {20.02, 20.22}).
 *   Picks the combination with the smallest overshoot vs wallLengthMm.
 *
 * When fractions are OFF:
 *   Uses body blocks only, rounded up. cutBlocks = 1 if the last block needs cutting.
 *
 * @param wallLengthMm Real-world wall length in millimetres
 * @param endsTotalModular Sum of both ends' modular widths (e.g. 800 for 20.01+20.01, 600 for 20.01+20.03)
 * @param useFractions Whether fraction blocks are allowed
 */
export function fitCourseLength(
  wallLengthMm: number,
  endsTotalModular: number,
  useFractions: boolean
): CourseLengthFit {
  // We work in "modular" lengths: every block contributes (face width + mortar) mm.
  // A wall of N blocks has its mortar joints between blocks: total length =
  // sum(blockWidths) + (N-1)*mortar. Equivalent to: sum(blockModulars) - mortar.
  // So "target total modular" = wallLengthMm + mortar.
  const targetTotal = wallLengthMm + MORTAR_MM
  const endsTotal = endsTotalModular

  if (!useFractions) {
    const remainingForBody = targetTotal - endsTotal
    if (remainingForBody <= 0) {
      return {
        bodyCount: 0,
        fractions: [],
        actualLengthMm: Math.max(endsTotal - MORTAR_MM, 0),
        cutBlocks: 0,
      }
    }
    const bodyCount = Math.ceil(remainingForBody / BODY_BLOCK_MODULE_MM)
    const actualModular = endsTotal + bodyCount * BODY_BLOCK_MODULE_MM
    const actualLengthMm = actualModular - MORTAR_MM
    return {
      bodyCount,
      fractions: [],
      actualLengthMm,
      cutBlocks: actualLengthMm > wallLengthMm ? 1 : 0,
    }
  }

  // Build all fraction combinations: empty, one of each option, or two (any combination).
  const fracCombos: FractionOption[][] = [
    [],
    ...FRACTION_OPTIONS.map((f) => [f]),
    ...FRACTION_OPTIONS.flatMap((f1) => FRACTION_OPTIONS.map((f2) => [f1, f2])),
  ]

  let best: CourseLengthFit | null = null

  for (const fracs of fracCombos) {
    const fracsTotal = fracs.reduce((s, f) => s + f.modular, 0)
    const remainingForBody = targetTotal - endsTotal - fracsTotal
    if (remainingForBody < 0) continue
    const bodyCount = Math.ceil(remainingForBody / BODY_BLOCK_MODULE_MM)
    const actualModular = endsTotal + fracsTotal + bodyCount * BODY_BLOCK_MODULE_MM
    const actualLengthMm = actualModular - MORTAR_MM
    if (actualLengthMm < wallLengthMm) continue // shouldn't happen — defensive

    const overshoot = actualLengthMm - wallLengthMm
    const bestOvershoot = best ? best.actualLengthMm - wallLengthMm : Infinity
    if (overshoot < bestOvershoot) {
      best = {
        bodyCount,
        fractions: fracs.map((f) => f.code),
        actualLengthMm,
        cutBlocks: 0,
      }
    }
  }

  return (
    best ?? {
      bodyCount: 0,
      fractions: [],
      actualLengthMm: 0,
      cutBlocks: 0,
    }
  )
}

// ---------- End block plan (per end) ----------

/**
 * The end-block choice and modular width for a single wall end, for each course-parity.
 *
 * In stretcher bond:
 *   - Free / T-junction / control-joint ends alternate (20.01 odd, 20.03 even).
 *   - Corner ends use the makeup's corner block (20.01 or 20.21) on EVERY course
 *     — per the brief's rule: at a corner, the 20.03 halves are substituted for full blocks.
 *
 * In stack bond:
 *   - All ends use the same block top-to-bottom.
 *   - Corner ends use the corner block.
 *   - Free / T-junction / control-joint ends default to 20.01 for now (a future improvement
 *     is to pick 20.01 vs 20.03 based on best length fit when free ends are involved).
 */
export interface EndPlan {
  /** Block code at this end for odd courses (course 1, 3, …). */
  oddBlock: BlockCode
  /** Block code at this end for even courses (course 2, 4, …). */
  evenBlock: BlockCode
  /** Modular width (mm) of oddBlock. */
  oddModular: number
  /** Modular width (mm) of evenBlock. */
  evenModular: number
}

export function planEnd(
  bondType: BondType,
  junctionType: JunctionType,
  cornerBlockCode: BlockCode
): EndPlan {
  if (bondType === 'stretcher') {
    if (junctionType === 'corner') {
      return {
        oddBlock: cornerBlockCode,
        evenBlock: cornerBlockCode,
        oddModular: FULL_END_MODULE_MM,
        evenModular: FULL_END_MODULE_MM,
      }
    }
    // Free, T-junction, control-joint: alternating in stretcher
    return {
      oddBlock: '20.01',
      evenBlock: '20.03',
      oddModular: FULL_END_MODULE_MM,
      evenModular: HALF_END_MODULE_MM,
    }
  }
  // Stack bond
  if (junctionType === 'corner') {
    return {
      oddBlock: cornerBlockCode,
      evenBlock: cornerBlockCode,
      oddModular: FULL_END_MODULE_MM,
      evenModular: FULL_END_MODULE_MM,
    }
  }
  // Stack bond free / T-junction / control-joint: simplification — always 20.01.
  // TODO: implement best-fit picker that considers both ends together.
  return {
    oddBlock: '20.01',
    evenBlock: '20.01',
    oddModular: FULL_END_MODULE_MM,
    evenModular: FULL_END_MODULE_MM,
  }
}

// ---------- Wall plan (start end + end end + per-course fits) ----------

export interface WallPlan {
  startEnd: EndPlan
  endEnd: EndPlan
  /** Length fit (body count + fractions) for odd courses. */
  oddCourseFit: CourseLengthFit
  /** Length fit for even courses. May differ from oddCourseFit if end-block modulars differ between course parities. */
  evenCourseFit: CourseLengthFit
}

/**
 * Plan a wall: figure out end blocks per parity and length fit per course-type.
 *
 * If both ends are the same kind (e.g. both free, or both corner), the odd and even fits
 * will be similar except for body count (in stretcher with alternating ends, even courses
 * use 1 extra body block).
 *
 * If ends differ (e.g. one free, one corner), odd and even fits are computed independently —
 * they may pick different fraction combinations or body counts to hit the wall length with
 * the smallest overshoot.
 */
export function planWall(wall: Wall, makeup: WallMakeup): WallPlan {
  const startEnd = planEnd(makeup.bondType, wall.startJunction.type, makeup.cornerBlockCode)
  const endEnd = planEnd(makeup.bondType, wall.endJunction.type, makeup.cornerBlockCode)
  const lengthMm = wallLengthMm(wall)

  const oddCourseFit = fitCourseLength(
    lengthMm,
    startEnd.oddModular + endEnd.oddModular,
    makeup.useFractions
  )
  const evenCourseFit = fitCourseLength(
    lengthMm,
    startEnd.evenModular + endEnd.evenModular,
    makeup.useFractions
  )

  return { startEnd, endEnd, oddCourseFit, evenCourseFit }
}

// ---------- Per-course composition ----------

export type CourseType = 'base' | 'body' | 'height-71' | 'height-140' | 'top'

export interface CourseSpec {
  type: CourseType
  /** The body block for this course (e.g. 20.45 for base, 20.20 for bond-beam top, 20.48 for body). */
  bodyBlock: BlockCode
  /** Tile paired with each body block (only set for base course with cleanouts). */
  pairedTile?: BlockCode
}

/**
 * Build the ordered list of courses bottom-to-top for a wall.
 *
 * Layout:
 *   Course 1                = base course (cleanouts + tiles)
 *   Course 2 to (N-1)        = body courses (or overrides)
 *   Course N-1 (or N-2)     = height-makeup row, if present (placed second from top)
 *   Course N                = top course (bond beam if specified, else body block)
 *
 * Course overrides from makeup.courseOverrides are applied after the default layout is built.
 */
export function buildCourses(stack: CourseStack, makeup: WallMakeup): CourseSpec[] {
  const courses: CourseSpec[] = []

  // ---- Course 1: base ----
  courses.push({
    type: 'base',
    bodyBlock: makeup.baseCourseBlockCode,
    pairedTile: makeup.baseCourseTileCode,
  })

  // ---- Middle body courses (exclude base and top from standardCount) ----
  const standardBodyCount = Math.max(stack.standardCount - 2, 0)
  for (let i = 0; i < standardBodyCount; i++) {
    courses.push({ type: 'body', bodyBlock: makeup.bodyBlockCode })
  }

  // ---- Height-makeup courses (placed before the top, so they end up "second from top") ----
  if (stack.has140) courses.push({ type: 'height-140', bodyBlock: '20.140' })
  if (stack.has71) courses.push({ type: 'height-71', bodyBlock: '20.71' })

  // ---- Top course ----
  if (stack.totalCourses >= 2) {
    courses.push({ type: 'top', bodyBlock: makeup.topCourseBlockCode })
  }

  // ---- Apply per-course overrides ----
  if (makeup.courseOverrides) {
    for (const override of makeup.courseOverrides) {
      const idx = override.courseNumber - 1 // 1-indexed -> 0-indexed
      if (idx >= 0 && idx < courses.length) {
        courses[idx] = { ...courses[idx], bodyBlock: override.blockCode }
      }
    }
  }

  return courses
}

// ---------- Wall tally ----------

/**
 * Calculate the block tally for a single wall instance.
 *
 * Each end of the wall is planned independently based on its junction state (free, corner,
 * T-junction, control-joint). Corners in stretcher bond use the corner block on every course;
 * other end types alternate (stretcher) or use the same block on every course (stack).
 *
 * Known limitation: when two walls meet at a corner, each currently counts an end block on its
 * corner side, double-counting the shared corner column. A project-level correction will be
 * added in a follow-up.
 */
export function calculateWallTally(wall: Wall, makeup: WallMakeup): BlockTally {
  const heightMm = wall.heightMmOverride ?? makeup.heightMm
  const stack = calculateCourseStack(heightMm)
  const plan = planWall(wall, makeup)
  const courses = buildCourses(stack, makeup)

  const tally: BlockTally = {}

  for (let i = 0; i < courses.length; i++) {
    const course = courses[i]
    const isOddCourse = i % 2 === 0 // courseIndex 0 = course 1 (odd)
    const fit = isOddCourse ? plan.oddCourseFit : plan.evenCourseFit
    const startBlock = isOddCourse ? plan.startEnd.oddBlock : plan.startEnd.evenBlock
    const endBlock = isOddCourse ? plan.endEnd.oddBlock : plan.endEnd.evenBlock

    // Body blocks (this course's body block: 20.45 / 20.48 / 20.20 / 20.71 / 20.140)
    addToTally(tally, course.bodyBlock, fit.bodyCount)

    // Paired tiles (50.45 with 20.45 on the base course)
    if (course.pairedTile && fit.bodyCount > 0) {
      addToTally(tally, course.pairedTile, fit.bodyCount)
    }

    // Fraction blocks (length makeup)
    for (const fracCode of fit.fractions) {
      addToTally(tally, fracCode)
    }

    // End termination blocks (one per end)
    addToTally(tally, startBlock)
    addToTally(tally, endBlock)
  }

  return tally
}

/** Real-world wall length in mm (from start to end coordinates). */
export function wallLengthMm(wall: Wall): number {
  const dx = wall.endX - wall.startX
  const dy = wall.endY - wall.startY
  return Math.sqrt(dx * dx + dy * dy)
}

// ---------- Project-level aggregation ----------

/**
 * Aggregate tallies across multiple walls (just a convenience wrapper around combineTallies).
 */
export function calculateProjectTally(
  walls: Wall[],
  makeupsById: Record<string, WallMakeup>
): BlockTally {
  const tallies = walls
    .map((wall) => {
      const makeup = makeupsById[wall.makeupId]
      return makeup ? calculateWallTally(wall, makeup) : null
    })
    .filter((t): t is BlockTally => t !== null)
  return combineTallies(...tallies)
}
