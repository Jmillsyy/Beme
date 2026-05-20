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
import {
  BLOCK_LIBRARY,
  pickCurveWedge,
  pickHalfBlock,
  pickHeightMakeupBlock,
  pickLintelBlock,
  pickPierBlock,
} from '../data/blockLibrary'
import type { BlockCode, BlockDimensions } from '../types/blocks'
import type {
  BlockTally,
  BondType,
  FreestandingPier,
  JunctionType,
  Opening,
  Pier,
  PierMakeup,
  TiedPier,
  Wall,
  WallMakeup,
} from '../types/walls'
import { findCornerPoints } from './junctions'
import { selectBlockLintel } from './lintels'
import { arcFromThreePoints, isCurvedWall } from './curveGeom'
import { resolveCourseBlocks } from './makeups'
import { getUserSettings } from './userSettings'

/**
 * Geometric derivation: a block of front-face width w_f, rear-face width w_r, depth d
 * sits on a curve with outer radius r_outer. Matching the modular angle at front and rear
 * gives:
 *
 *     m_r = (w_f − w_r) + m_f − d × (w_f + m_f) / r_outer
 *
 * where m_f and m_r are the front and rear mortar joint widths. The thresholds below come
 * straight out of that formula.
 */
const MORTAR_MM = DEFAULT_MORTAR_JOINT_MM
const HALF_BLOCK_DEPTH_MM = (dims: BlockDimensions) => dims.depthMm / 2

/**
 * Three radius bands govern how a curve is built. The numbers below the
 * constants come straight from the rectangular-block mortar formula
 *   m_rear = m_front − w_face × (w_face + m_front) / r_outer
 * applied to the stock 20.48 (390 × 190 × 190 + 10 mortar), plus the wedge
 * 20.03CW geometry (190 × 190 × 190, rear 140) where the same idea is run
 * with the wedge's wider front-to-rear differential absorbing the curve.
 *
 *   r ≥ NO_CUT (~6000mm centreline)
 *       Stock 20.48 fits with slightly compressed rear mortar. No cutting.
 *
 *   WEDGE ≤ r < NO_CUT  (~1500mm – 6000mm)
 *       Stock 20.48 used (so the curve inherits the makeup's body block,
 *       same as the walls it extends from), but each block needs a small
 *       saw-cut on its rear corners to remove the overlap that would
 *       otherwise occur. Cut amount per block roughly:
 *         R = 6000 → ~3mm
 *         R = 3500 → ~11mm
 *         R = 2000 → ~26mm
 *
 *   MIN_FEASIBLE ≤ r < WEDGE  (~665mm – 1500mm)
 *       20.03CW wedge block (190 front × 140 rear) — its taper is
 *       designed for this band. Above 1500mm the wedge gives absurdly
 *       fat rear mortar (~40mm+) so cut 20.48s are the better answer.
 *
 *   r < MIN_FEASIBLE (~665mm centreline)
 *       Even the wedge runs out — custom blocks required. Beme reports
 *       this as a warning rather than tallying a generic block.
 */

/**
 * Above this centreline radius (mm) stock body blocks fit without
 * meaningful cutting — the rear mortar joint compresses from 10 mm down
 * to a couple of mm but stays positive, so the bricklayer doesn't need
 * to saw anything off the back of the blocks.
 *
 * Rounded to 6000mm; at this centreline the 20.48 rear mortar is about
 * 2.7 mm of overlap which a bricklayer can absorb by tightening the
 * joint a touch — anything tighter (smaller radius) and the cut starts
 * to be visible.
 */
export const CURVED_WALL_NO_CUT_RADIUS_MM = 6000

/**
 * Below this centreline radius (mm) the 20.03CW wedge is the right
 * answer; above it, cut stock body blocks fit better. The wedge has a
 * 50 mm front-to-rear taper which gives perfect 10 mm mortar around
 * R_outer ≈ 760 mm, but at larger radii the same taper produces
 * comically fat rear mortar (e.g. 49 mm at R = 3500 mm). Setting the
 * boundary at 1500 mm keeps the wedge's rear mortar under ~40 mm,
 * which is the practical limit for pourable joints.
 */
export const CURVED_WALL_WEDGE_RADIUS_MM = 1500

/**
 * Centreline radius (mm) below which even the 20.03CW wedge can't absorb
 * the curve — the block's rear face would need to be narrower than its
 * actual 140mm. Curves tighter than this need custom-cut blocks. Derived
 * from 20.03CW geometry: r_outer = d × (w_f + m) / (w_f − w_r).
 *
 * For the stock 20.03CW (190 × 190 × 190, rear 140):
 * r_outer = 190 × 200 / 50 = 760 mm, centreline ≈ 665 mm.
 */
export const CURVED_WALL_MIN_FEASIBLE_RADIUS_MM = (() => {
  // Pick the curve-wedge block by role so a US / UK / custom library with a
  // differently-named tapered block (or no wedge at all) still resolves.
  // If the user has no curve-wedge block defined, every curve is treated as
  // custom-cut — which is the safe fallback.
  const wedge = pickCurveWedge()
  if (!wedge) return Number.POSITIVE_INFINITY
  const block = wedge.dimensions
  if (!block.rearWidthMm) return Number.POSITIVE_INFINITY
  const diff = block.widthMm - block.rearWidthMm
  if (diff <= 0) return Number.POSITIVE_INFINITY
  const rOuter = (block.depthMm * (block.widthMm + MORTAR_MM)) / diff
  return Math.round(rOuter - HALF_BLOCK_DEPTH_MM(block))
})()

/** Curve build zone for a given centreline radius. Drives both the tally
 *  (which block to use) and the export assumption (whether to mention cuts). */
export type CurveZone = 'standard' | 'cut' | 'wedge' | 'custom'

export function curveZoneForRadius(radiusMm: number): CurveZone {
  if (radiusMm >= CURVED_WALL_NO_CUT_RADIUS_MM) return 'standard'
  if (radiusMm >= CURVED_WALL_WEDGE_RADIUS_MM) return 'cut'
  if (radiusMm >= CURVED_WALL_MIN_FEASIBLE_RADIUS_MM) return 'wedge'
  return 'custom'
}

// ---------- Modular constants (block face + mortar joint) ----------

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
/** Modular height of a 20.71 height-makeup course (90 block + 10 mortar
 *  joint = 100mm). The makeup block sits in a course with its own mortar
 *  bed, same as a standard. */
const HEIGHT_MAKEUP_71_MM = 100
/** Modular height of a 20.140 height-makeup course (140 block + 10 mortar
 *  joint = 150mm). E.g. 13 standards + 1 × 20.140 = 13×200 + 150 = 2750mm,
 *  which is also the closest achievable height when the user requests
 *  2740mm — the rounding-up logic in calculateCourseStack applies the
 *  20.140 and notes the 10 mm overage in the export Assumptions. */
const HEIGHT_MAKEUP_140_MM = 150

/**
 * Wall-length threshold (mm) below which there's no room for two end blocks. Walls below
 * this are built with ONE block per course — the single block whose face width is closest
 * to the wall's drawn length, picked from 20.03 / 20.02 / 20.22 / 20.01.
 *
 * 400mm is just over two end-block face widths (~390mm + mortar), so it's the natural
 * cutoff between "single-block stub" and "two-end short wall".
 */
const SINGLE_BLOCK_WALL_THRESHOLD_MM = 400

/**
 * Single-block options for the very-short-wall rule, derived from the live
 * library by role. We collect anything that can play `end-termination`,
 * `corner`, or `fraction` — those are the blocks a mason would reach for to
 * build a single-block-wide stub course. Sorted by face width ascending so
 * the picker walks small → large.
 *
 * Calling this lazily (inside the packer) means library edits flow through
 * without an app restart.
 */
function singleBlockOptions(): Array<{ code: BlockCode; faceWidthMm: number }> {
  return Object.values(BLOCK_LIBRARY)
    .filter(
      (b) =>
        b.roles.includes('end-termination') ||
        b.roles.includes('corner') ||
        b.roles.includes('fraction')
    )
    .map((b) => ({ code: b.code, faceWidthMm: b.dimensions.widthMm }))
    .sort((a, b) => a.faceWidthMm - b.faceWidthMm)
}

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

/** Subtract `b` from `a` (clamps to ≥ 0 and removes empty entries). Does not mutate inputs. */
export function subtractTally(a: BlockTally, b: BlockTally): BlockTally {
  const result: BlockTally = { ...a }
  for (const key of Object.keys(b) as BlockCode[]) {
    const aVal = result[key] ?? 0
    const bVal = b[key] ?? 0
    const diff = aVal - bVal
    if (diff > 0) result[key] = diff
    else delete result[key]
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
  /** Requested wall height in mm (what the user asked for). */
  requestedHeightMm: number
  /** Actual built height in mm given the stack — `standardCount * 200 + has71 * 90 + has140 * 140`. */
  actualHeightMm: number
  /** Difference between actual and requested (always ≥ 0 — we round UP). */
  overageMm: number
}

/**
 * Decide how the wall height breaks down into courses.
 *
 * Modular course heights (block + 10 mm mortar joint):
 *   Standard (20.48): 200mm (190 + 10)
 *   20.71:            100mm (90 + 10)
 *   20.140:           150mm (140 + 10)
 *
 * Rather than failing when the requested height doesn't sum exactly from
 * the available course heights, we pick the SMALLEST stack whose total is
 * ≥ the requested height — i.e. round UP to the nearest achievable height.
 * The closest-size makeup block gets applied and the bricklayer trims
 * mortar on site to suit. The overage is surfaced in the export's
 * Assumptions section so the estimator sees they're quoting for slightly
 * more than requested.
 *
 * Examples:
 *   3000mm → 15 standard (exact, 3000)
 *   2700mm → 13 standard + 1× 20.71 (exact, 2700)
 *   2750mm → 13 standard + 1× 20.140 (exact, 2750)
 *   2740mm → 13 standard + 1× 20.140 (2750, overage 10mm — the 20.140 is
 *            the closest-size block that gets the wall ≥ the request)
 *   2850mm → 13 standard + 1× 20.71 + 1× 20.140 (exact, 2850)
 *   3050mm → 14 standard + 1× 20.71 + 1× 20.140 = 3050 (exact)
 */
export function calculateCourseStack(heightMm: number): CourseStack {
  // Enumerate every reasonable combination and pick the smallest total
  // that's >= requested. Upper bound on N comes from a sanity-check
  // ceiling of the requested height plus enough headroom for both
  // makeup blocks; in practice all combinations fit inside a handful
  // of iterations.
  const maxN = Math.ceil(heightMm / COURSE_MODULE_MM) + 2
  let best: { N: number; has71: boolean; has140: boolean; total: number } | null = null
  for (let N = 0; N <= maxN; N++) {
    for (const has71 of [false, true]) {
      for (const has140 of [false, true]) {
        const total =
          N * COURSE_MODULE_MM +
          (has71 ? HEIGHT_MAKEUP_71_MM : 0) +
          (has140 ? HEIGHT_MAKEUP_140_MM : 0)
        if (total < heightMm) continue
        // Prefer smaller total. Tie-break by fewer total courses so e.g.
        // 14 standards (2800) wins over 13 + 20.71 + 20.140 (2830).
        if (!best || total < best.total) {
          best = { N, has71, has140, total }
        }
      }
    }
  }
  // best is non-null because N=maxN with both makeup blocks comfortably
  // exceeds heightMm. Belt-and-braces fallback for paranoia:
  if (!best) {
    const fallbackN = Math.ceil(heightMm / COURSE_MODULE_MM)
    return {
      standardCount: fallbackN,
      has71: false,
      has140: false,
      totalCourses: fallbackN,
      valid: false,
      requestedHeightMm: heightMm,
      actualHeightMm: fallbackN * COURSE_MODULE_MM,
      overageMm: fallbackN * COURSE_MODULE_MM - heightMm,
    }
  }
  return {
    standardCount: best.N,
    has71: best.has71,
    has140: best.has140,
    totalCourses: best.N + (best.has71 ? 1 : 0) + (best.has140 ? 1 : 0),
    valid: true,
    requestedHeightMm: heightMm,
    actualHeightMm: best.total,
    overageMm: best.total - heightMm,
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

  // Degenerate case — the ends alone already cover (or exceed) the wall.
  // Same answer as before: zero bodies, length capped at the ends' contribution.
  if (targetTotal - endsTotal <= 0) {
    return {
      bodyCount: 0,
      fractions: [],
      actualLengthMm: Math.max(endsTotal - MORTAR_MM, 0),
      cutBlocks: 0,
    }
  }

  // -----------------------------------------------------------------
  // Algorithm — the gap-filler rule.
  //
  //  1. Lay full body blocks until one more wouldn't fit (floor count).
  //     "baseActual" is the wall length at that point — N_floor bodies
  //     + the ends, no extras.
  //  2. Compute the "gap" — how much shorter the wall is than the
  //     drawn length after step 1.
  //  3. Decide what fills the gap:
  //       - gap ≤ TINY_GAP_MM:    leave it. Absorbed in mortar.
  //       - useFractions AND a fraction's face fits in the gap:
  //         insert the LARGEST fitting fraction. No cuts. This is the
  //         "use a 20.02 where a cut 20.48 would have gone" case.
  //       - otherwise: round up — N_floor+1 bodies, last one cut to
  //         fit the gap (cutBlocks = 1). Same as fractions-OFF
  //         behaviour, applied whenever no fraction fits cleanly.
  //
  //  Concretely:
  //    5100 mm odd course (ends=800):  N_floor=10, base=4790, gap=310.
  //                                    20.02 (face 290) fits → use it.
  //                                    Wall = 5090 mm.  ← 1 fraction.
  //    5800 mm odd course (ends=800):  N_floor=12, base=5590, gap=210.
  //                                    No fraction's face fits (smallest
  //                                    is 290). Round up → 13 bodies,
  //                                    last cut.  Wall = 5990 mm. No
  //                                    fractions in the schedule.
  //    5990 mm odd course:             N_floor=13, base=5990, gap=0.
  //                                    Exact. 13 bodies, no extras.
  // -----------------------------------------------------------------
  /** Gaps at or below this are quietly absorbed in mortar thickness
   *  instead of triggering a cut block or fraction. Anything bigger
   *  visibly needs something filling the space. */
  const TINY_GAP_MM = 30

  const nFloor = Math.max(
    0,
    Math.floor((targetTotal - endsTotal) / BODY_BLOCK_MODULE_MM)
  )
  const baseModular = endsTotal + nFloor * BODY_BLOCK_MODULE_MM
  const baseActual = baseModular - MORTAR_MM
  const gap = wallLengthMm - baseActual

  // Step 3a — tiny gap → leave it.
  if (gap <= TINY_GAP_MM) {
    return {
      bodyCount: nFloor,
      fractions: [],
      actualLengthMm: baseActual,
      cutBlocks: 0,
    }
  }

  // Step 3b — fraction substitution. The fraction's FACE width has to
  // actually fit in the gap (face ≤ gap), so the bricklayer can drop
  // the stock fraction in instead of cutting a body. The largest such
  // fraction wins so the cut-down body the user would have used is
  // replaced by the closest pre-made block. Tolerance up to +20mm
  // overhang absorbs in mortar — without that slack a wall a few mm
  // short of a fraction's face misses the substitution entirely.
  if (useFractions) {
    const FRACTION_OVERHANG_TOLERANCE_MM = 20
    let bestFrac: FractionOption | null = null
    for (const f of FRACTION_OPTIONS) {
      const faceWidth = f.modular - MORTAR_MM
      if (faceWidth > gap + FRACTION_OVERHANG_TOLERANCE_MM) continue
      if (!bestFrac || f.modular > bestFrac.modular) bestFrac = f
    }
    if (bestFrac) {
      return {
        bodyCount: nFloor,
        fractions: [bestFrac.code],
        actualLengthMm: baseActual + bestFrac.modular,
        cutBlocks: 0,
      }
    }
  }

  // Step 3c — no fraction fits, gap isn't tiny → round up to N+1 bodies
  // and mark one as cut. Identical to the fractions-OFF behaviour for
  // this branch.
  return {
    bodyCount: nFloor + 1,
    fractions: [],
    actualLengthMm: baseActual + BODY_BLOCK_MODULE_MM,
    cutBlocks: 1,
  }
}

/**
 * Fit a VERY SHORT wall (under {@link SINGLE_BLOCK_WALL_THRESHOLD_MM}) as a single
 * block per course — the block whose face width is closest to the wall's drawn length,
 * picked from 20.03 / 20.02 / 20.22 / 20.01.
 *
 * Returns the fit with `fractions: [chosenCode]` — the calc loop will tally one of that
 * block per course. Start/end blocks are NOT added when the WallPlan has `noEndBlocks`.
 */
function fitSingleBlockWall(wallLengthMm: number): CourseLengthFit {
  const options = singleBlockOptions()
  if (options.length === 0) {
    // Library has no end / corner / fraction blocks at all — fall back to a
    // safe zero so the caller doesn't crash. The user will see no blocks
    // counted for this stub, which is the visible signal to add a block.
    return { bodyCount: 0, fractions: [], actualLengthMm: 0, overshootMm: 0 } as CourseLengthFit
  }
  let best = options[0]
  let bestDiff = Math.abs(best.faceWidthMm - wallLengthMm)
  for (const opt of options) {
    const diff = Math.abs(opt.faceWidthMm - wallLengthMm)
    if (diff < bestDiff) {
      best = opt
      bestDiff = diff
    }
  }
  return {
    bodyCount: 0,
    fractions: [best.code],
    actualLengthMm: best.faceWidthMm,
    cutBlocks: 0,
  }
}

// ---------- End block plan (per end) ----------

/**
 * The end-block choice and modular width for a single wall end, for each course-parity.
 *
 * The two walls at a T-junction are treated as COMPLETELY SEPARATE walls: the stem has its
 * own full end termination at the junction (same as a free end), and the through wall is
 * unaffected. T-junctions therefore fall through to the free-end rule below — there's no
 * special t-junction branch.
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
  cornerBlockCode: BlockCode,
  bodyBlockCode: BlockCode = '20.48',
  /**
   * Optional per-makeup half-block override. When provided, replaces the
   * library role-based pick — that's what lets a user configure "this
   * wall type uses 30.03 halves at free ends" without touching the
   * library. Falls back to pickHalfBlock() then to '20.03' so older
   * saved makeups (no halfBlockCode yet) keep working unchanged.
   */
  halfBlockCode?: BlockCode
): EndPlan {
  // bodyBlockCode kept in the signature for compatibility with curved-wall logic;
  // T-junction ends no longer use it (they take a normal end termination).
  void bodyBlockCode
  const fullEndBlock = cornerBlockCode

  if (bondType === 'stretcher') {
    if (junctionType === 'corner') {
      return {
        oddBlock: fullEndBlock,
        evenBlock: fullEndBlock,
        oddModular: FULL_END_MODULE_MM,
        evenModular: FULL_END_MODULE_MM,
      }
    }
    // Free, T-junction, control-joint: alternating in stretcher — the stem has its own
    // complete end termination at the T, treated identically to a free end.
    // Half block: per-makeup override → library role pick → '20.03' fallback.
    const halfFromLib = pickHalfBlock()
    const resolvedHalf = halfBlockCode ?? halfFromLib?.code ?? '20.03'
    return {
      oddBlock: fullEndBlock,
      evenBlock: resolvedHalf,
      oddModular: FULL_END_MODULE_MM,
      evenModular: HALF_END_MODULE_MM,
    }
  }
  // Stack bond
  if (junctionType === 'corner') {
    return {
      oddBlock: fullEndBlock,
      evenBlock: fullEndBlock,
      oddModular: FULL_END_MODULE_MM,
      evenModular: FULL_END_MODULE_MM,
    }
  }
  // Stack bond free / T-junction / control-joint: same full block all courses.
  // TODO: implement best-fit picker that considers both ends together.
  return {
    oddBlock: fullEndBlock,
    evenBlock: fullEndBlock,
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
  /**
   * When true, the per-course tally skips startEnd / endEnd entirely — the fit's
   * fractions array IS the course (single-block-per-course mode for very short walls).
   */
  noEndBlocks?: boolean
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
export function planWall(
  wall: Wall,
  makeup: WallMakeup,
  thicknessByWallId?: Record<string, number>,
  wallsById?: Record<string, Wall>
): WallPlan {
  // Outer-edge length (= centreline + corner extensions). Used so the body block fit
  // accounts for the corner block area where the polygon mitre extends past the centreline.
  const lengthMm = wallLengthMm(wall, thicknessByWallId, wallsById)

  // ----- Single-block-stub rule -----
  // Walls under SINGLE_BLOCK_WALL_THRESHOLD_MM (default 400mm) can't fit two end blocks
  // side-by-side. Use ONE block per course — the block whose face width is closest to
  // the wall's drawn length, picked from 20.03 / 20.02 / 20.22 / 20.01.
  if (lengthMm > 0 && lengthMm < SINGLE_BLOCK_WALL_THRESHOLD_MM) {
    const fit = fitSingleBlockWall(lengthMm)
    // EndPlan values are unused when noEndBlocks is true; pass through a placeholder
    // so the type checker is happy and we don't accidentally tally end blocks.
    const placeholderEnd: EndPlan = {
      oddBlock: makeup.cornerBlockCode,
      evenBlock: makeup.cornerBlockCode,
      oddModular: 0,
      evenModular: 0,
    }
    return {
      startEnd: placeholderEnd,
      endEnd: placeholderEnd,
      oddCourseFit: fit,
      evenCourseFit: fit,
      noEndBlocks: true,
    }
  }

  // No short-wall special case — walls under 800mm follow the same end-
  // alternation + gap-filler rule as longer walls, using whatever blocks
  // the makeup specifies. If the user wants different blocks for a small
  // wall (no body blocks, half-block fills only, etc.), they can create
  // a separate makeup for it rather than the calc engine guessing.

  const startEnd = planEnd(
    makeup.bondType,
    wall.startJunction.type,
    makeup.cornerBlockCode,
    makeup.bodyBlockCode,
    makeup.halfBlockCode
  )
  const endEnd = planEnd(
    makeup.bondType,
    wall.endJunction.type,
    makeup.cornerBlockCode,
    makeup.bodyBlockCode,
    makeup.halfBlockCode
  )

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
 * Each course's block code is resolved through the makeup's course-series
 * ranges (if any) — so a 300-series range covering courses 1-5 swaps in
 * 30.45 for the base, 30.48 for body, 30.71 for height-makeup, etc.
 *
 * Course overrides from makeup.courseOverrides are applied LAST so they win
 * over both the makeup defaults and any series-range substitution. The
 * override is a single explicit code that knows what it's doing.
 */
export function buildCourses(stack: CourseStack, makeup: WallMakeup): CourseSpec[] {
  const courses: CourseSpec[] = []

  // Per-course block resolution lives on the makeups module so the UI and the
  // calc engine agree on which code wins for a given course. A course that's
  // outside any range still resolves correctly — it just gets the makeup
  // defaults straight back.
  const blocksForCourse = (courseNumber: number) => resolveCourseBlocks(makeup, courseNumber)

  // ---- Course 1: base ----
  {
    const b = blocksForCourse(1)
    courses.push({
      type: 'base',
      bodyBlock: b.baseCourseBlockCode,
      pairedTile: b.baseCourseTileCode,
    })
  }

  // ---- Middle body courses (exclude base and top from standardCount) ----
  const standardBodyCount = Math.max(stack.standardCount - 2, 0)
  for (let i = 0; i < standardBodyCount; i++) {
    // courseNumber is 1-indexed; courses array index i corresponds to course (i+1)
    // after the base, so i=0 here is course 2.
    const courseNumber = 2 + i
    const b = blocksForCourse(courseNumber)
    courses.push({ type: 'body', bodyBlock: b.bodyBlockCode })
  }

  // ---- Height-makeup courses (placed before the top, so they end up "second from top") ----
  if (stack.has140) {
    // Pick the 140 mm height-makeup block by role — falls back to the SEQ
    // 20.140 in AU libraries (which is role-tagged), and a US / UK user can
    // tag their equivalent (e.g. a 4" tall CMU) to make this work.
    const courseNumber = courses.length + 1
    void courseNumber
    const block140 = pickHeightMakeupBlock(140)
    if (block140) {
      courses.push({ type: 'height-140', bodyBlock: block140.code })
    }
  }
  if (stack.has71) {
    const courseNumber = courses.length + 1
    const b = blocksForCourse(courseNumber)
    courses.push({ type: 'height-71', bodyBlock: b.heightMakeup71BlockCode })
  }

  // ---- Top course ----
  if (stack.totalCourses >= 2) {
    // topCourseBlockCode is a makeup-level choice (bond beam or not) — keep it
    // makeup-driven; if a user wants a 300-series top course they'd put a
    // 30.20 (none exists in this catalogue) on it via the makeup field.
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
 * Calculate the block tally for a single wall instance, with optional openings subtracted.
 *
 * Each end of the wall is planned independently based on its junction state (free, corner,
 * T-junction, control-joint). Corners in stretcher bond use the corner block on every course;
 * other end types alternate (stretcher) or use the same block on every course (stack).
 *
 * Note: when two walls share a corner, each wall's tally will include a full corner column
 * of end blocks. The project-level `calculateProjectTally` subtracts the duplicate column to
 * give the correct physical count.
 */
export function calculateWallTally(
  wall: Wall,
  makeup: WallMakeup,
  openings: Opening[] = [],
  thicknessByWallId?: Record<string, number>,
  wallsById?: Record<string, Wall>
): BlockTally {
  // Curved walls bypass the straight-wall planning machinery entirely.
  if (isCurvedWall(wall)) {
    return calculateCurvedWallTally(wall, makeup)
  }
  const heightMm = wall.heightMmOverride ?? makeup.heightMm
  const stack = calculateCourseStack(heightMm)
  const plan = planWall(wall, makeup, thicknessByWallId, wallsById)
  const courses = buildCourses(stack, makeup)

  const tally: BlockTally = {}

  // Pick the right end-of-wall block for THIS course. Honours both the
  // makeup-level cornerBlock / half-block defaults and any course-series range
  // override (so a 300-series course gets 30.01 / 30.03 instead of 20.01 /
  // 20.03 at its ends). Mirrors the parity logic in planEnd: corner ends use
  // the full block on every course; free / T-junction / control-joint ends
  // alternate in stretcher and stay full in stack.
  function resolveEndForCourse(
    junctionType: JunctionType,
    courseNumber: number,
    isOddCourse: boolean
  ): BlockCode {
    const blocks = resolveCourseBlocks(makeup, courseNumber)
    if (makeup.bondType === 'stretcher' && junctionType !== 'corner') {
      return isOddCourse ? blocks.cornerBlockCode : blocks.halfBlockCode
    }
    return blocks.cornerBlockCode
  }

  // Cached outer-edge length for re-fitting courses whose corner ends carry a
  // lead-in (e.g. the 30.02 pair on 300-series corners) — those courses
  // consume extra modular width that the base oddCourseFit / evenCourseFit
  // doesn't know about, so we recompute a fit per course as needed.
  const wallLenForRefit = wallLengthMm(wall, thicknessByWallId, wallsById)

  for (let i = 0; i < courses.length; i++) {
    const course = courses[i]
    const courseNumber = i + 1
    const isOddCourse = i % 2 === 0 // courseIndex 0 = course 1 (odd)
    // Resolve per-course so 300-series courses get 30.01 / 30.03 at their
    // ends and 200-series courses get 20.01 / 20.03 — even within the same
    // wall. planWall's block codes are only consulted for short-wall and
    // single-block-stub fallback modes (which both set startEnd/endEnd to
    // the makeup defaults uniformly).
    const startBlock = plan.noEndBlocks
      ? (isOddCourse ? plan.startEnd.oddBlock : plan.startEnd.evenBlock)
      : resolveEndForCourse(wall.startJunction.type, courseNumber, isOddCourse)
    const endBlock = plan.noEndBlocks
      ? (isOddCourse ? plan.endEnd.oddBlock : plan.endEnd.evenBlock)
      : resolveEndForCourse(wall.endJunction.type, courseNumber, isOddCourse)
    // Single-block-stub mode skips the start/end pair entirely (the fit's fractions list
    // IS the whole course — one block).
    const endCount = plan.noEndBlocks ? 0 : 2

    // Corner lead-in (e.g. 30.02 × 2 on 300-series corner ends): inserted
    // between the corner block and the regular body to get back on bond after
    // the corner block's deeper footprint. Only fires at corner junctions on
    // courses where the resolved series defines a lead-in — fall-back is 0.
    // The lead-in is tallied as its own block code and the per-course modular
    // gets adjusted so the body fit still hits the wall length.
    let leadInCode: BlockCode | undefined
    let startLeadInCount = 0
    let endLeadInCount = 0
    let leadInModularTotal = 0
    if (!plan.noEndBlocks) {
      const resolvedCourse = resolveCourseBlocks(makeup, courseNumber)
      leadInCode = resolvedCourse.cornerLeadInBlockCode
      if (leadInCode && resolvedCourse.cornerLeadInCount > 0) {
        if (wall.startJunction.type === 'corner') {
          startLeadInCount = resolvedCourse.cornerLeadInCount
        }
        if (wall.endJunction.type === 'corner') {
          endLeadInCount = resolvedCourse.cornerLeadInCount
        }
        const block = BLOCK_LIBRARY[leadInCode]
        const blockModular = block ? block.dimensions.widthMm + MORTAR_MM : 0
        leadInModularTotal = (startLeadInCount + endLeadInCount) * blockModular
      }
    }

    // Per-course fit: if this course doesn't carry a lead-in, reuse the
    // pre-computed odd/even fit (the original common case). If it does, the
    // ends consume more modular so we re-fit against the actual wall length.
    let fit = isOddCourse ? plan.oddCourseFit : plan.evenCourseFit
    if (leadInModularTotal > 0) {
      const startEndModular = isOddCourse ? plan.startEnd.oddModular : plan.startEnd.evenModular
      const endEndModular = isOddCourse ? plan.endEnd.oddModular : plan.endEnd.evenModular
      const adjustedEndsTotal = startEndModular + endEndModular + leadInModularTotal
      fit = fitCourseLength(wallLenForRefit, adjustedEndsTotal, makeup.useFractions)
    }

    // Height-makeup courses (20.71, 20.140) extend across the FULL course length —
    // the height-makeup block is cut to the size of any end block (20.03) and any fill
    // block, so the course is just a row of height-makeup blocks butted end-to-end. We
    // supply enough of the height-makeup block to cover body + fill + both ends.
    if (course.type === 'height-71' || course.type === 'height-140') {
      // Height-makeup blocks are cut to length to fill the WHOLE course
      // including any lead-in zone — the lead-in is masonry sitting at the
      // 290 mm-deep footprint, so the height-makeup block for that course
      // extends out over it. Count one extra height-makeup unit per lead-in
      // position to keep the cut-to-length yield right.
      const totalBlocks =
        fit.bodyCount + fit.fractions.length + endCount + startLeadInCount + endLeadInCount
      addToTally(tally, course.bodyBlock, totalBlocks)
      continue
    }

    addToTally(tally, course.bodyBlock, fit.bodyCount)

    if (course.pairedTile && fit.bodyCount > 0) {
      addToTally(tally, course.pairedTile, fit.bodyCount)
    }

    if (leadInCode && (startLeadInCount > 0 || endLeadInCount > 0)) {
      addToTally(tally, leadInCode, startLeadInCount + endLeadInCount)
    }

    for (const fracCode of fit.fractions) {
      addToTally(tally, fracCode)
    }

    if (!plan.noEndBlocks) {
      addToTally(tally, startBlock)
      addToTally(tally, endBlock)
    }
  }

  for (const opening of openings) {
    applyOpeningAdjustments(tally, opening, wall, makeup, courses)
  }

  return tally
}

/**
 * Apply an opening's block-tally adjustments per the brief's refined rules.
 *
 * Jambs (sides of opening) — alternate with the wall's course parity in stretcher bond:
 *   Odd course → 20.01 (full), Even course → 20.03 (half). 2 jambs per course.
 *   In stack bond → always 20.01 (no alternation).
 *
 * Body subtraction per opening course (stretcher):
 *   Odd  course: −(2 + ceil(W/400))  body blocks
 *   Even course: −(1 + ceil(W/400))  body blocks  (smaller 20.03 jambs mean fewer net bodies lost)
 *   Stack bond:  −(2 + ceil(W/400))  per course (same modular jambs as bodies)
 *
 * Head area — lintel slab fills (W + 2 × 200mm bearing) horizontally × headHeight vertically:
 *   Lintels are stood UP with 190mm face × variable height (190 / 290 / 390).
 *   Horizontal count = ceil(lintelSpanMm / 200)
 *   Vertical count   = ceil(headHeightMm / lintelVerticalModule)
 *   Total lintels    = horizontal × vertical
 *   Body subtraction per head course = ceil((W + 400) / 400)
 *
 * The per-course bodyBlock is read from the courses array (so an opening that covers the
 * base course subtracts 20.45 + 50.45 instead of 20.48, etc.).
 */
function applyOpeningAdjustments(
  tally: BlockTally,
  opening: Opening,
  wall: Wall,
  makeup: WallMakeup,
  courses: CourseSpec[]
): void {
  const wallHeightMm = wall.heightMmOverride ?? makeup.heightMm

  const sillCoursesFloor = Math.floor(opening.sillHeightMm / COURSE_MODULE_MM)
  const openingCourses = Math.max(0, Math.floor(opening.heightMm / COURSE_MODULE_MM))
  if (openingCourses === 0) return

  const blocksAcrossOpening = Math.ceil(opening.widthMm / BODY_BLOCK_MODULE_MM)
  const isStretcher = makeup.bondType === 'stretcher'

  /** Subtract `n` of the actual course's body block (and paired tile if present). */
  function subtractCourseBody(courseIdx: number, n: number) {
    const course = courses[courseIdx]
    if (!course || n <= 0) return
    const code = course.bodyBlock
    const cur = tally[code] ?? 0
    const next = Math.max(0, cur - n)
    if (next > 0) tally[code] = next
    else delete tally[code]
    if (course.pairedTile) {
      const tileCur = tally[course.pairedTile] ?? 0
      const tileNext = Math.max(0, tileCur - n)
      if (tileNext > 0) tally[course.pairedTile] = tileNext
      else delete tally[course.pairedTile]
    }
  }

  // The "full" jamb block follows the per-course resolved corner — 20.01 by
  // default (or 20.21 with knockout corners) for 200-series courses, 30.01 for
  // 300-series courses. Half-block jambs (even courses, stretcher) similarly
  // swap between 20.03 and 30.03 according to the course's range.
  // ---- Opening area: jambs + body subtraction per course (parity-aware) ----
  for (let i = 0; i < openingCourses; i++) {
    const wallCourseNumber = sillCoursesFloor + i + 1 // 1-indexed from wall base
    const courseIdx = sillCoursesFloor + i
    const isOddCourse = wallCourseNumber % 2 === 1

    const resolved = resolveCourseBlocks(makeup, wallCourseNumber)
    let jambCode: BlockCode
    let bodyToSubtract: number

    if (isStretcher) {
      jambCode = isOddCourse ? resolved.cornerBlockCode : resolved.halfBlockCode
      bodyToSubtract = (isOddCourse ? 2 : 1) + blocksAcrossOpening
    } else {
      jambCode = resolved.cornerBlockCode
      bodyToSubtract = 2 + blocksAcrossOpening
    }

    addToTally(tally, jambCode, 2)
    subtractCourseBody(courseIdx, bodyToSubtract)
  }

  // ---- Head area: lintels + body subtraction per head course ----
  const headHeightMm = wallHeightMm - opening.sillHeightMm - opening.heightMm
  if (headHeightMm <= 0) return

  // Lintel blocks are only added if the user's regional preference is ON.
  // When OFF (some US / European markets that leave the head open and
  // bridge with a structural lintel beam handled elsewhere), the head
  // courses are still subtracted from the body tally so the wall maths
  // remains correct — there's just no lintel block line in the schedule.
  // The toggle lives in Settings → Preferences → Regional features and in
  // the Block library's Lintel blocks section.
  const useLintels = getUserSettings().preferences.regionalFeatures.lintels
  if (useLintels) {
    const lintel = selectBlockLintel(headHeightMm)
    const bearingMm = 200
    const lintelSpanMm = opening.widthMm + 2 * bearingMm
    const horizontalLintelCount = Math.ceil(lintelSpanMm / lintel.horizontalModuleMm)
    const verticalLintelCount = Math.ceil(headHeightMm / lintel.verticalModuleMm)
    const lintelTotal = horizontalLintelCount * verticalLintelCount
    addToTally(tally, lintel.code, lintelTotal)
  }

  // Body subtraction in head area — per head course, bodies within the lintel span are replaced
  const headStartIdx = sillCoursesFloor + openingCourses
  const headCoursesNeeded = Math.ceil(headHeightMm / COURSE_MODULE_MM)
  const headCoursesAvailable = Math.max(0, courses.length - headStartIdx)
  const headCoursesToUse = Math.min(headCoursesNeeded, headCoursesAvailable)
  const bodyPerHeadCourse = Math.ceil((opening.widthMm + 400) / BODY_BLOCK_MODULE_MM)

  for (let i = 0; i < headCoursesToUse; i++) {
    subtractCourseBody(headStartIdx + i, bodyPerHeadCourse)
  }
}

/**
 * Real-world wall length in mm.
 *
 * For straight walls this is the chord (start → end).
 * For curved walls this is the arc length through the three anchor points.
 */
export function wallLengthMm(
  wall: Wall,
  thicknessByWallId?: Record<string, number>,
  wallsById?: Record<string, Wall>
): number {
  if (isCurvedWall(wall) && wall.midX !== undefined && wall.midY !== undefined) {
    const geom = arcFromThreePoints(
      { x: wall.startX, y: wall.startY },
      { x: wall.midX, y: wall.midY },
      { x: wall.endX, y: wall.endY }
    )
    if (geom) return geom.arcLengthMm
  }
  const dx = wall.endX - wall.startX
  const dy = wall.endY - wall.startY
  const centrelineLength = Math.sqrt(dx * dx + dy * dy)

  // Adjust for junction overlap at each end. The same per-end formula handles both:
  //   overlap = max(0, halfThickness_other − perpDist_to_other_centreline)
  //
  // - CORNER end: ADD the overlap to extend the wall out to the L's outer corner (the
  //   visible/outer-edge length). For the newly-drawn wall whose endpoint snapped onto the
  //   other wall's centreline (perpDist=0) this is +halfThickness_other; for the pre-existing
  //   wall whose endpoint is at its own outer face (perpDist=halfThickness_other) this is 0.
  //
  // - T-JUNCTION end: SUBTRACT the overlap to give the face-aligned length, since the two
  //   walls at a T are treated as completely separate. The stem ends at the through wall's
  //   face and has its own end termination — the inside overlap (where the data endpoint
  //   sits because of "snap to centre of last block") doesn't count toward the wall length.
  if (!thicknessByWallId || !wallsById) return centrelineLength

  let lengthAdjust = 0
  for (const which of ['start', 'end'] as const) {
    const junction = which === 'start' ? wall.startJunction : wall.endJunction
    if (junction.type !== 'corner' && junction.type !== 't-junction') continue
    const otherId = junction.connectedWallIds?.[0]
    if (!otherId) continue
    const other = wallsById[otherId]
    if (!other) continue
    const otherThickness = thicknessByWallId[otherId]
    if (!otherThickness) continue
    const dataX = which === 'start' ? wall.startX : wall.endX
    const dataY = which === 'start' ? wall.startY : wall.endY
    const odx = other.endX - other.startX
    const ody = other.endY - other.startY
    const oLen = Math.sqrt(odx * odx + ody * ody)
    if (oLen === 0) continue
    const onx = -ody / oLen
    const ony = odx / oLen
    const perpDist = Math.abs((dataX - other.startX) * onx + (dataY - other.startY) * ony)
    const overlap = Math.max(0, otherThickness / 2 - perpDist)
    lengthAdjust += junction.type === 'corner' ? overlap : -overlap
  }
  return Math.max(0, centrelineLength + lengthAdjust)
}

/**
 * Tally for a curved wall.
 *
 * Curves bypass the straight-wall course-fit machinery because:
 *   - Fraction blocks (20.02 / 20.22) don't make sense on a curve — the wedge absorbs length.
 *   - The body block changes based on radius (20.03CW for tight, makeup.bodyBlockCode otherwise).
 *
 * Model (per the spec from the project owner):
 *   - The curve is purely body blocks stack-bonded — every course has the same block count,
 *     each block sitting directly on top of the one below.
 *   - No special end columns: the curve's blocks butt straight into the adjoining wall's face
 *     at each end (like a T-junction stem). The adjoining wall provides its own end termination.
 *   - Block choice by centreline radius:
 *       radius < threshold → 20.03CW wedge (190mm front × 140mm rear) — fits tight curves naturally
 *       radius ≥ threshold → makeup's body block with widened rear mortar joints
 *   - No openings, bond beam, or height makeup on curves — out of scope for v1.
 */
function calculateCurvedWallTally(wall: Wall, makeup: WallMakeup): BlockTally {
  if (!isCurvedWall(wall) || wall.midX === undefined || wall.midY === undefined) return {}
  const geom = arcFromThreePoints(
    { x: wall.startX, y: wall.startY },
    { x: wall.midX, y: wall.midY },
    { x: wall.endX, y: wall.endY }
  )
  if (!geom) return {}

  const heightMm = wall.heightMmOverride ?? makeup.heightMm
  const courseCount = Math.round(heightMm / COURSE_MODULE_MM)
  if (courseCount <= 0) return {}

  // Pick body block by radius zone. Curves at moderate radii (cut zone)
  // inherit the makeup's body block so the curve uses the same material
  // as the straight walls it extends from — the bricklayer just saws a
  // few mm off the rear corners. The export's assumption page notes that
  // cuts are required so the supplier doesn't see "20.48" on a curve and
  // assume zero modification.
  const zone = curveZoneForRadius(geom.radiusMm)
  // Use the wedge block when the curve is tight enough — picked by role so a
  // US / UK / custom library with a non-SEQ wedge still works. If no wedge
  // is defined we fall back to the makeup's body block (the tally will be
  // slightly over but the user is alerted via the curve-zone export note).
  const wedge = pickCurveWedge()
  const useWedge = zone === 'wedge' && !!wedge
  const bodyCode: BlockCode = useWedge && wedge ? wedge.code : makeup.bodyBlockCode
  // Modular face width: 20.03CW front face is 190 + 10 mortar = 200;
  // standard body block is 390 + 10 = 400. For the cut zone the block
  // face stays 390mm — only the back is shaved — so still 400 modular.
  const bodyModularMm = useWedge ? 200 : BODY_BLOCK_MODULE_MM

  // Body blocks per course along the arc — ceil, leaves a touch of overshoot for safety.
  const blocksPerCourse = Math.max(1, Math.ceil(geom.arcLengthMm / bodyModularMm))

  const tally: BlockTally = {}
  addToTally(tally, bodyCode, blocksPerCourse * courseCount)
  // Note: no corner end columns — curves butt into the adjoining walls' faces.

  return tally
}

// ---------- Pier tally ----------

/**
 * Default course pattern when a pier has no PierMakeup attached.
 *
 * Derived from the live library by role: pier-tagged block for the pier
 * course, corner-tagged block for the alternating tie course. Falls back to
 * SEQ codes (40.925 / 20.01) if the library has nothing tagged with those
 * roles — keeps existing AU projects working unchanged.
 *
 * Computed lazily inside helpers so library edits flow through without an
 * app restart.
 */
function defaultTiedPierPattern(): BlockCode[] {
  const pier = pickPierBlock()
  const corner = Object.values(BLOCK_LIBRARY).find((b) => b.roles.includes('corner'))
  return [pier?.code ?? '40.925', corner?.code ?? '20.01']
}
function defaultFreestandingPierPattern(): BlockCode[] {
  const pier = pickPierBlock()
  return [pier?.code ?? '40.925']
}

/**
 * Sum a repeating block pattern over a given number of courses. The pattern repeats
 * starting at course 1 (so course i uses `pattern[(i - 1) % len]`).
 */
function tallyFromCoursePattern(pattern: BlockCode[], courseCount: number): BlockTally {
  const tally: BlockTally = {}
  if (pattern.length === 0 || courseCount <= 0) return tally
  for (let i = 0; i < courseCount; i++) {
    const code = pattern[i % pattern.length]
    addToTally(tally, code, 1)
  }
  return tally
}

/**
 * Block tally for a single tied pier (built into a wall).
 *
 * The pier column runs the wall's full course count. Each course's block comes from the
 * tied pier's `PierMakeup.coursePattern` (cycling). The default pattern is
 * `['40.925', '20.01']` (alternating), matching the brief — but users can configure any
 * pattern via the PierTypesPanel.
 *
 * Body-block displacement (subtracting one body block per course at the pier position
 * on the wall) is applied at the project level — see {@link calculateProjectTally}.
 */
export function calculateTiedPierTally(
  pier: TiedPier,
  wall: Wall,
  makeup: WallMakeup,
  pierMakeup?: PierMakeup
): BlockTally {
  const heightMm = wall.heightMmOverride ?? makeup.heightMm
  const stack = calculateCourseStack(heightMm)
  const N = stack.totalCourses
  if (N <= 0) return {}
  const pattern = pierMakeup?.coursePattern?.length
    ? pierMakeup.coursePattern
    : defaultTiedPierPattern()
  void pier
  return tallyFromCoursePattern(pattern, N)
}

/**
 * Block tally for a single freestanding pier.
 *
 * Course count = floor(heightMm / 200). Each course's block comes from the pier's
 * `PierMakeup.coursePattern` (cycling). Default pattern is `['40.925']` — every course
 * stacked with the pier block.
 */
export function calculateFreestandingPierTally(
  pier: FreestandingPier,
  pierMakeup?: PierMakeup
): BlockTally {
  const courseCount = Math.floor(pier.heightMm / COURSE_MODULE_MM)
  if (courseCount <= 0) return {}
  const pattern = pierMakeup?.coursePattern?.length
    ? pierMakeup.coursePattern
    : defaultFreestandingPierPattern()
  return tallyFromCoursePattern(pattern, courseCount)
}

// ---------- Project-level aggregation ----------

/**
 * Aggregate tallies across multiple walls, then subtract over-counted corner columns.
 *
 * Per-wall, each corner end contributes one corner-column block per course to the tally.
 * On standard / base / top courses that's `cornerBlockCode` (20.01 or 20.21). On a
 * height-makeup course (20.71 / 20.140) it's the height-makeup block itself, because that
 * row extends across the full course length (the height-makeup block is cut to the size of
 * an end block at each end).
 *
 * When two walls share a corner, the column gets counted once per wall → 2× the real count.
 * For each unique corner shared by n walls, we subtract (n − 1) of each course's corner
 * column to leave exactly one corner column counted per physical corner.
 *
 * Assumption: walls meeting at a corner share the same height and makeup. The corner
 * column composition and course count are taken from the first wall at the corner. If
 * makeups differ across a corner this is approximate.
 */
export function calculateProjectTally(
  walls: Wall[],
  makeupsById: Record<string, WallMakeup>,
  openings: Opening[] = [],
  piers: Pier[] = [],
  pierMakeupsById: Record<string, PierMakeup> = {}
): BlockTally {
  // Compute per-wall thickness + lookup map once so wallLengthMm can return outer-edge
  // length (centreline + asymmetric corner extensions).
  const thicknessByWallId: Record<string, number> = {}
  const wallsById: Record<string, Wall> = {}
  for (const w of walls) {
    const makeup = makeupsById[w.makeupId]
    const block = makeup ? BLOCK_LIBRARY[makeup.bodyBlockCode] : undefined
    thicknessByWallId[w.id] = block?.dimensions.depthMm ?? 190
    wallsById[w.id] = w
  }

  // Group openings by wall id once
  const openingsByWallId: Record<string, Opening[]> = {}
  for (const op of openings) {
    if (!openingsByWallId[op.wallId]) openingsByWallId[op.wallId] = []
    openingsByWallId[op.wallId].push(op)
  }

  const wallTallies = walls
    .map((wall) => {
      const makeup = makeupsById[wall.makeupId]
      if (!makeup) return null
      return calculateWallTally(
        wall,
        makeup,
        openingsByWallId[wall.id] ?? [],
        thicknessByWallId,
        wallsById
      )
    })
    .filter((t): t is BlockTally => t !== null)
  let summed = combineTallies(...wallTallies)

  // ----- Piers -----
  // For each tied pier, add the pier's tally (one block per course from its makeup pattern),
  // then subtract a wall block for each course where the pier block is DEEPER than the wall
  // body — i.e. it actually sticks out and physically displaces the wall block at that
  // column. On "tie" courses where the pattern's block fits within the wall thickness
  // (e.g. a 20.01 in a default tied makeup), no displacement: the H block stays in the wall
  // and the 20.01 sits perpendicular to it as the tie-back, so it's PURE ADDITION.
  //
  // Example: a 2400mm wall (12 courses) with pattern [40.925, 20.01]:
  //   +6 × 40.925  (six pier-block courses)
  //   +6 × 20.01   (six tie-block courses)
  //   −6 × 20.48   (only the 40.925 courses displace an H block; the 20.01 courses don't)
  const pierDisplacement: BlockTally = {}
  for (const pier of piers) {
    const pierMakeup = pier.pierMakeupId ? pierMakeupsById[pier.pierMakeupId] : undefined
    if (pier.type === 'freestanding') {
      summed = combineTallies(summed, calculateFreestandingPierTally(pier, pierMakeup))
      continue
    }
    // Tied pier
    const wall = wallsById[pier.wallId]
    if (!wall) continue
    const makeup = makeupsById[wall.makeupId]
    if (!makeup) continue
    summed = combineTallies(summed, calculateTiedPierTally(pier, wall, makeup, pierMakeup))

    // Per-course displacement, gated on the pattern block's depth vs wall body depth.
    // The displaced block is always the wall's body block (H block) — masonry convention
    // is that the pier replaces an H block's worth of material at each displacement
    // course, regardless of whether the wall course is a base, body, top, or height-makeup
    // row. Base-course tiles + cleanout layout around the pier are unaffected.
    const heightMm = wall.heightMmOverride ?? makeup.heightMm
    const stack = calculateCourseStack(heightMm)
    const totalCourses = stack.totalCourses
    const pattern =
      pierMakeup?.coursePattern?.length
        ? pierMakeup.coursePattern
        : defaultTiedPierPattern()
    const wallBodyDepth =
      BLOCK_LIBRARY[makeup.bodyBlockCode]?.dimensions.depthMm ?? 190

    let displacedCount = 0
    for (let i = 0; i < totalCourses; i++) {
      const pierCode = pattern[i % pattern.length]
      const pierDepth = BLOCK_LIBRARY[pierCode]?.dimensions.depthMm ?? 0
      // Only displace when the pier block is deeper than the wall body block — i.e. it
      // physically extends past the wall face and takes the wall column. Otherwise the
      // pier block sits perpendicular (alongside) and adds without subtracting.
      if (pierDepth > wallBodyDepth) displacedCount++
    }
    if (displacedCount > 0) {
      addToTally(pierDisplacement, makeup.bodyBlockCode, displacedCount)
    }
  }

  const adjustment = calculateCornerAdjustment(walls, makeupsById)
  return subtractTally(subtractTally(summed, adjustment), pierDisplacement)
}

/**
 * Compute the corner over-count adjustment (a tally to subtract from the summed per-wall tally).
 */
export function calculateCornerAdjustment(
  walls: Wall[],
  makeupsById: Record<string, WallMakeup>
): BlockTally {
  const wallsById = new Map(walls.map((w) => [w.id, w]))
  const adjustment: BlockTally = {}
  const corners = findCornerPoints(walls)

  for (const corner of corners) {
    // Filter to walls that ACTUALLY contribute a corner column. Walls in single-block-stub
    // mode (under SINGLE_BLOCK_WALL_THRESHOLD_MM long) have no end blocks at all — they're
    // one block per course — so they don't add a corner column to dedupe against.
    const participatingWallIds = corner.wallIds.filter((id) => {
      const w = wallsById.get(id)
      if (!w) return false
      const dx = w.endX - w.startX
      const dy = w.endY - w.startY
      const chordLen = Math.sqrt(dx * dx + dy * dy)
      return chordLen >= SINGLE_BLOCK_WALL_THRESHOLD_MM
    })

    const n = participatingWallIds.length
    if (n < 2) continue

    // Use the first PARTICIPATING wall for makeup + course count
    const firstWall = wallsById.get(participatingWallIds[0])
    if (!firstWall) continue
    const makeup = makeupsById[firstWall.makeupId]
    if (!makeup) continue

    const heightMm = firstWall.heightMmOverride ?? makeup.heightMm
    const stack = calculateCourseStack(heightMm)
    if (stack.totalCourses <= 0) continue

    // Each course's corner column contributes whatever block code that COURSE
    // resolves to. With a 300-series range covering courses 1-5, the bottom
    // five corner-column subtractions are 30.01, the rest are 20.01 — so we
    // walk the stack rather than scaling a single code by standardCount.
    const standardCornerColumn = stack.standardCount
    if (standardCornerColumn > 0) {
      // Build the course list the same way calculateWallTally does — bases,
      // bodies, height-makeup, top — and read the corner block per course.
      const courses = buildCourses(stack, makeup)
      for (let ci = 0; ci < courses.length; ci++) {
        const courseNumber = ci + 1
        const course = courses[ci]
        if (course.type === 'height-71' || course.type === 'height-140') continue
        const resolved = resolveCourseBlocks(makeup, courseNumber)
        addToTally(adjustment, resolved.cornerBlockCode, n - 1)
      }
    }
    // Height-makeup courses contribute the height-makeup block itself at the
    // corner column. Use the resolved height-makeup code so a 300-series
    // height-makeup row dedups to 30.71 (when one's defined for the range).
    if (stack.has71) {
      // buildCourses lays courses out as: base(1), bodies(2..standardCount-1),
      // [140](standardCount), [71](next), top(last). So the 71 row's 1-indexed
      // course number is standardCount + (has140 ? 1 : 0).
      const heightMakeupCourseNumber = stack.standardCount + (stack.has140 ? 1 : 0)
      const resolved = resolveCourseBlocks(makeup, heightMakeupCourseNumber)
      addToTally(adjustment, resolved.heightMakeup71BlockCode, n - 1)
    }
    if (stack.has140) {
      // Look up the 140 mm height-makeup block by role so corner-column
      // dedup works for any region's library, not just SEQ 20.140.
      const block140 = pickHeightMakeupBlock(140)
      if (block140) {
        addToTally(adjustment, block140.code, n - 1)
      }
    }
  }

  return adjustment
}
