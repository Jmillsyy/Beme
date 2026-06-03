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
  pickCornerBlock,
  pickCurveWedge,
  pickFractionBlocks,
  pickHalfBlock,
  pickHeightMakeupBlock,
  pickPierBlock,
} from '../data/blockLibrary'
import type { BlockCode, BlockDimensions, BlockRole } from '../types/blocks'
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
import { getCourseCount, getMakeupHeightMm, resolveCourseBlocks } from './makeups'
import { resolveBlockByRole } from './blockRoles'

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

// ---------- Stale-makeup heal ----------

/**
 * Region-swap guard. If a saved makeup carries a block code that isn't
 * in the active library (e.g. a US user opens a project that was saved
 * under AU), swap the code for the role-equivalent block from the live
 * library so the tally lands on codes the user actually has.
 *
 * AU users see no change — every AU code is in their seed library, so
 * this is a pass-through.
 *
 * The fallback chain prefers the requested role; if no block in the
 * library carries that role, it falls back to 'body' (the only role
 * every region's library is guaranteed to have); if even that's
 * missing, the original code is returned untouched and the tally just
 * reports the missing code.
 */
function healCode(code: BlockCode, role: BlockRole): BlockCode {
  if (BLOCK_LIBRARY[code]) return code
  // Route through the central role resolver. The calc engine doesn't
  // currently thread UserSettings into here — when that arrives, this
  // call site picks up DefaultsByRole "for free" by passing { settings }.
  // For now it's an equivalent role-tag scan, just consolidated.
  const byRole = resolveBlockByRole(role, BLOCK_LIBRARY)
  if (byRole) return byRole.code
  const byBody = resolveBlockByRole('body', BLOCK_LIBRARY)
  return (byBody?.code ?? code) as BlockCode
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

/**
 * Available fraction blocks for length makeup, computed from the live
 * library by role. Each fraction-tagged block contributes its
 * (widthMm + mortar) as the modular size the packer can fit.
 *
 * AU SEQ defaults (20.02 = 290+10=300mm, 20.22 = 340+10=350mm) are the
 * fallback when the library has no fraction blocks tagged; that way
 * existing AU projects produce identical tallies even if the library is
 * stripped of role tags.
 */
function getFractionOptions(): FractionOption[] {
  const blocks = pickFractionBlocks()
  // No fraction blocks in the library? Return empty — the wall just
  // rounds up its body count, no fractional fillers. We DON'T fall
  // back to AU 20.02 / 20.22 here because those codes don't exist
  // in US / UK libraries; emitting them would surface a phantom AU
  // block in non-AU tallies.
  if (blocks.length === 0) return []
  return blocks.map((b) => ({
    code: b.code,
    modular: b.dimensions.widthMm + MORTAR_MM,
  }))
}

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
    for (const f of getFractionOptions()) {
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
    return { bodyCount: 0, fractions: [], cutBlocks: 0, actualLengthMm: 0 }
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
    // Free, T-junction, control-joint: alternating in stretcher.
    // Control joints are treated as free ends so each half of a
    // split renders its own end termination at the seam (two
    // independent walls with stretcher alternation).
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
  // Stack bond — same full block all courses regardless of junction.
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
  /**
   * Rule 4 (running bond): when true, the end-side parity has been inverted
   * relative to the start so the half-end alternates between the two ends
   * across courses (full+half on Course 1, half+full on Course 2). Downstream
   * consumers that re-derive end blocks from `isOddCourse` (planWallLayout's
   * resolveEndForCourse, calculateWallTally's resolveEndForCourse) must flip
   * the `odd` argument they pass for the END side when this flag is set so
   * the tally matches the layout. planEnd / planWall do the actual swap on
   * `endEnd.{odd,even}{Block,Modular}` so any consumer that reads those
   * fields directly already sees the post-flip values.
   */
  endParityInverted?: boolean
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

  // ── Rule 4 (running bond): pick the cleaner end-parity ───────────
  //
  // `planEnd` returns { odd: full, even: half } for any stretcher-
  // friendly end (free / T-junction / control-joint). Called for both
  // ends, the two plans alternate IN SYNC by default:
  //   Course 1: full + full     Course 2: half + half
  // That's the right answer for "modular" walls whose length fits
  // cleanly as full + N×body + full (790, 1190, 1590, 1990 mm …) —
  // bodies pack with no cuts and the bond break comes from the
  // half-on-both-ends-on-alternating-courses scheme.
  //
  // But for walls sized as full + N×body + half-end (590, 990, 1390,
  // 1790 mm …) the SYNC scheme leaves a 180-200 mm sliver to cut on
  // every course, while INVERTING one end's parity lands them flush:
  //   Course 1: full + half     Course 2: half + full
  // The half jumps end-to-end across courses, body offsets break the
  // bond, no cuts needed.
  //
  // So the rule is: try both arrangements, pick the one whose worst-
  // course gap is smallest. This collapses to the original sync
  // behaviour on modular walls and to the canonical full+body+half
  // alternation on half-modular walls, without us needing to detect
  // the case explicitly. Walls between the two grids pick whichever
  // option needs the smaller cut.
  //
  // Only fires for stretcher bond, and only when this end isn't a
  // structural corner. Corners must keep the full block every course
  // so the perpendicular wall's bond returns correctly — see
  // corner-ownership handling further down. Stack bond skips the flip
  // because both parities are identical for stack anyway.
  //
  // Rule 4a (half-ends only at wall ends) is enforced upstream by
  // `pickFractionBlocks` excluding any block tagged 'end-termination',
  // so the half-end never lands in an interior fraction slot regardless
  // of which arrangement wins here.
  const syncOddFit = fitCourseLength(
    lengthMm,
    startEnd.oddModular + endEnd.oddModular,
    makeup.useFractions
  )
  const syncEvenFit = fitCourseLength(
    lengthMm,
    startEnd.evenModular + endEnd.evenModular,
    makeup.useFractions
  )
  let oddCourseFit = syncOddFit
  let evenCourseFit = syncEvenFit
  let endParityInverted = false

  const endIsBondFlippable =
    makeup.bondType === 'stretcher' && wall.endJunction.type !== 'corner'
  if (endIsBondFlippable) {
    // Inverted: pair startEnd.odd with endEnd.even, and vice versa.
    const invOddFit = fitCourseLength(
      lengthMm,
      startEnd.oddModular + endEnd.evenModular,
      makeup.useFractions
    )
    const invEvenFit = fitCourseLength(
      lengthMm,
      startEnd.evenModular + endEnd.oddModular,
      makeup.useFractions
    )
    // "Worst-course gap" = max gap across both courses. The cleaner
    // arrangement is the one with the smaller worst-course gap. Ties
    // (e.g. both schemes fit perfectly with gap=0) keep the sync
    // arrangement to preserve historical layouts on modular walls.
    const syncWorstGap = Math.max(
      Math.abs(lengthMm - syncOddFit.actualLengthMm),
      Math.abs(lengthMm - syncEvenFit.actualLengthMm)
    )
    const invWorstGap = Math.max(
      Math.abs(lengthMm - invOddFit.actualLengthMm),
      Math.abs(lengthMm - invEvenFit.actualLengthMm)
    )
    if (invWorstGap < syncWorstGap) {
      // Inverted wins — commit by swapping endEnd's odd/even pair so
      // downstream consumers (planWallLayout, calculateWallTally) read
      // the right parity off plan.endEnd.{odd,even}{Block,Modular}.
      const tmpBlock = endEnd.oddBlock
      endEnd.oddBlock = endEnd.evenBlock
      endEnd.evenBlock = tmpBlock
      const tmpMod = endEnd.oddModular
      endEnd.oddModular = endEnd.evenModular
      endEnd.evenModular = tmpMod
      oddCourseFit = invOddFit
      evenCourseFit = invEvenFit
      endParityInverted = true
    }
  }

  return { startEnd, endEnd, oddCourseFit, evenCourseFit, endParityInverted }
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
  // ---- Bands path: makeup.coursePattern wins over the stack-driven flow ----
  // When the user defines an explicit list of bands, those bands ARE the
  // course composition; the legacy "uniform 200 mm courses + optional
  // height-makeup at the top" math is skipped. The bands enumerate
  // exactly which block sits on each course bottom-up, so the resulting
  // CourseSpec[] just maps each band to its `count` courses.
  //
  // Course-type classification per band block:
  //   - 200 mm modular block (190 + 10 mortar) → 'body' so end-block
  //     alternation (full / half) fires in stretcher bond.
  //   - 100 mm modular (90 + 10) → 'height-71' so the course is a
  //     full-width fill with no end-block carve-out.
  //   - 150 mm modular (140 + 10) → 'height-140', same treatment.
  //   - Anything else → 'body' as a safe default.
  // First course gets special handling: if its band block carries a
  // `pairedWith` tile in the library (cleanout pattern, e.g. 20.45/50.45),
  // it's emitted as type 'base' with the paired tile so the project tally
  // counts the tile separately. Otherwise it's whatever the block height
  // dictates.
  if (makeup.coursePattern && makeup.coursePattern.length > 0) {
    void stack
    const out: CourseSpec[] = []
    let courseIndex = 0
    for (const band of makeup.coursePattern) {
      if (band.count <= 0) continue
      const healedCode = healCode(band.blockCode, 'body')
      const block = BLOCK_LIBRARY[healedCode]
      const heightMm = block?.dimensions.heightMm ?? 190
      let baseType: CourseType
      if (heightMm <= 100) baseType = 'height-71'
      else if (heightMm <= 150) baseType = 'height-140'
      else baseType = 'body'
      for (let i = 0; i < band.count; i++) {
        const isFirstCourse = courseIndex === 0
        // Pairing is a property of the BLOCK (library), so whenever the
        // user puts a paired block on a course we emit its tile. The
        // ratio (pairedPer) is read at tally time so the count is
        // correct regardless of where the block lands on the wall.
        const pairedTile = block?.pairedWith
        out.push({
          type: isFirstCourse && pairedTile ? 'base' : baseType,
          bodyBlock: healedCode,
          pairedTile,
        })
        courseIndex++
      }
    }
    // courseOverrides still apply on top (1-indexed against the bands-
    // derived course list). Caller picked specific block for specific
    // row — heal that too in case the override predates the template
    // switch.
    if (makeup.courseOverrides) {
      for (const override of makeup.courseOverrides) {
        const idx = override.courseNumber - 1
        if (idx >= 0 && idx < out.length) {
          out[idx] = {
            ...out[idx],
            bodyBlock: healCode(override.blockCode, 'body'),
          }
        }
      }
    }
    return out
  }

  const courses: CourseSpec[] = []

  // Per-course block resolution lives on the makeups module so the UI and the
  // calc engine agree on which code wins for a given course. A course that's
  // outside any range still resolves correctly — it just gets the makeup
  // defaults straight back.
  const blocksForCourse = (courseNumber: number) => resolveCourseBlocks(makeup, courseNumber)

  // ---- Course 1: base ----
  {
    const b = blocksForCourse(1)
    // Heal the base code against the live library so a stale AU code
    // on a US user's saved makeup resolves to their library's
    // base-course block (or body block as a fallback if no
    // base-course tagged).
    const healedBase =
      healCode(b.baseCourseBlockCode, 'base-course') ||
      healCode(b.baseCourseBlockCode, 'body')
    const baseBlock = BLOCK_LIBRARY[healedBase]
    // Pairing is now ONLY a library-level property (Block.pairedWith).
    // The legacy `makeup.baseCourseTileCode` fallback used to keep
    // 50.45 on AU walls after the pairing migration; dropping it
    // here means US/UK walls (whose body block has no pairedWith)
    // no longer tally a phantom AU tile.
    const pairedTile = baseBlock?.pairedWith
    courses.push({
      type: 'base',
      bodyBlock: healedBase,
      pairedTile,
    })
  }

  // ---- Middle body courses (exclude base and top from standardCount) ----
  const standardBodyCount = Math.max(stack.standardCount - 2, 0)
  for (let i = 0; i < standardBodyCount; i++) {
    // courseNumber is 1-indexed; courses array index i corresponds to course (i+1)
    // after the base, so i=0 here is course 2.
    const courseNumber = 2 + i
    const b = blocksForCourse(courseNumber)
    courses.push({
      type: 'body',
      bodyBlock: healCode(b.bodyBlockCode, 'body'),
    })
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
    // Heal — falls back to height-makeup tagged block if the saved
    // code isn't in the library, else to a body block.
    courses.push({
      type: 'height-71',
      bodyBlock: healCode(b.heightMakeup71BlockCode, 'height-makeup'),
    })
  }

  // ---- Top course ----
  if (stack.totalCourses >= 2) {
    // topCourseBlockCode is a makeup-level choice (bond beam or not) — keep it
    // makeup-driven; heal against the live library so a stale AU top
    // code resolves to the user's top-course (then body) block.
    const healedTop =
      BLOCK_LIBRARY[makeup.topCourseBlockCode]
        ? makeup.topCourseBlockCode
        : (resolveBlockByRole('top-course', BLOCK_LIBRARY)?.code ??
            healCode(makeup.topCourseBlockCode, 'body'))
    courses.push({ type: 'top', bodyBlock: healedTop })
  }

  // ---- Apply per-course overrides ----
  if (makeup.courseOverrides) {
    for (const override of makeup.courseOverrides) {
      const idx = override.courseNumber - 1 // 1-indexed -> 0-indexed
      if (idx >= 0 && idx < courses.length) {
        courses[idx] = {
          ...courses[idx],
          bodyBlock: healCode(override.blockCode, 'body'),
        }
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
  // For bands-driven walls, makeup.heightMm may be stale — getMakeupHeightMm
  // sums the actual course pattern. heightMmOverride still takes priority for
  // legacy (non-bands) walls; bands walls ignore the override because the
  // pattern itself defines the wall height.
  const heightMm = wall.heightMmOverride ?? getMakeupHeightMm(makeup)
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
    // Only structural CORNER junctions get the full-block-every-course
    // treatment. Control joints are treated as free ends so each half
    // of a split emits its own alternating end termination at the
    // seam. Mirrors planEnd.
    if (makeup.bondType === 'stretcher' && junctionType !== 'corner') {
      return isOddCourse
        ? healCode(blocks.cornerBlockCode, 'corner')
        : healCode(blocks.halfBlockCode, 'end-termination')
    }
    return healCode(blocks.cornerBlockCode, 'corner')
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
    // Rule 4 (running bond) — see planWall + planWallLayout. The flag
    // carries planWall's per-wall decision so this tally counts the
    // same end blocks the layout will place.
    const endParityOdd = plan.endParityInverted ? !isOddCourse : isOddCourse
    const endBlock = plan.noEndBlocks
      ? (isOddCourse ? plan.endEnd.oddBlock : plan.endEnd.evenBlock)
      : resolveEndForCourse(wall.endJunction.type, courseNumber, endParityOdd)
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

    // Paired-tile count uses the BODY block's pairedPer ratio from
    // the library: 1 means 1:1 (one tile per block — AU default for
    // 20.45 + 50.45), 2 means 1:2 (one tile per two blocks), etc.
    // Always rounded up so the bricklayer never runs short.
    const bodyBlockDef = BLOCK_LIBRARY[course.bodyBlock]
    const pairedPer = bodyBlockDef?.pairedPer ?? 1
    if (course.pairedTile && fit.bodyCount > 0) {
      addToTally(tally, course.pairedTile, Math.ceil(fit.bodyCount / pairedPer))
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

  // Optional capping tile — sits on top of the wall and runs along
  // its full outer-edge length. Count `ceil(wallLength / capWidth)`
  // tiles per wall. We DON'T apply opening deductions to the cap row:
  // openings sit below the cap, the cap continues unbroken across
  // them (lintel + cap is the typical detail). If the user has cap
  // length = wall length intent, ceil() handles the partial at the
  // end. Cap width fallback = 390mm (standard block face width) when
  // the library can't resolve a dimension.
  if (makeup.capBlockCode) {
    const capBlock = BLOCK_LIBRARY[makeup.capBlockCode]
    const capWidthMm = capBlock?.dimensions.widthMm ?? 390
    if (capWidthMm > 0) {
      const wallLenMm = wallLengthMm(wall, thicknessByWallId, wallsById)
      addToTally(tally, makeup.capBlockCode, Math.ceil(wallLenMm / capWidthMm))
    }
  }

  return tally
}

// ---------- Per-wall positioned layout ----------
//
// `planWallLayout` produces a positioned-block list that mirrors what
// `calculateWallTally` counts. Same wall + makeup + openings always
// gives the same blocks at the same positions. Two consumers:
//
//   1. The export tally (sum-by-code = identical to calculateWallTally).
//      Aggregating planWallLayout.blocks into a BlockTally MUST match
//      calculateWallTally(...) exactly; the verifyLayoutMatchesTally
//      helper below will console.warn during dev if they diverge.
//   2. The 3D renderer (WorkspaceView3D) which lays one box per
//      positioned block, guaranteeing the user sees exactly what the
//      export counts.
//
// All positions are in mm, in WALL-LOCAL coordinates (s along the
// wall axis from the START junction toward the END junction; y from
// the wall base going up). The 3D code converts to world space.
//
// Block widths are LIBRARY face widths (no mortar). Successive blocks
// in the same course are MORTAR_MM apart, i.e. block n+1's s0 =
// block n's s0 + block n's widthMm + MORTAR_MM. A "cut" body block
// keeps its full face width here — the calc engine tallies one full
// block whether it was cut or not, so the layout matches the tally;
// the 3D renderer clamps display to the wall length so cut blocks
// don't overhang the model visually.
//
// Out of scope for this initial version (will be added in follow-up
// commits, gated behind explicit branches inside this function):
//   - Openings (jambs, lintels, body subtraction under head)
//   - Curved walls (sample-based segment layout)

export type PositionedBlockRole =
  | 'corner'
  | 'end-half'
  | 'lead-in'
  | 'body'
  | 'fraction'
  | 'paired-tile'
  | 'jamb'
  | 'lintel'

export interface PositionedBlock {
  /** Library block code (whatever the tally counts). */
  code: BlockCode
  /** Role tag — used by the 3D renderer for colouring / highlighting,
   *  not used for aggregation (sum by code only). */
  role: PositionedBlockRole
  /** Position along wall axis (mm from wall start). */
  s0Mm: number
  /** Block's library face width (mm). Successive blocks are
   *  MORTAR_MM apart, so block n+1.s0Mm = blockN.s0Mm + blockN.widthMm
   *  + MORTAR_MM. */
  widthMm: number
  /** 0-based course index this block belongs to. */
  courseIdx: number
  /** When true, the block is included for visual rendering but
   *  EXCLUDED from tally aggregation. Used for cube fillers at
   *  shared corners on non-owning courses — the corner block is
   *  physically owned (and counted) by the OTHER wall this course,
   *  but visually the cube exterior on this wall would otherwise
   *  read as empty space because the perpendicular block's faces
   *  don't lie on this wall's exterior plane. The filler fills that
   *  visual hole without inflating any tally. */
  renderOnly?: boolean
}

export interface CourseLayoutEntry {
  /** 1-based course number. Matches resolveCourseBlocks' convention. */
  courseNumber: number
  type: CourseType
  /** Body block code for this course (per `buildCourses`). */
  bodyBlock: BlockCode
  /** Course bottom Y from wall base (mm). */
  yBottomMm: number
  /** Course height in mm — block face height (190 / 90 / 140). */
  heightMm: number
}

export interface WallLayout {
  wallId: string
  isCurved: boolean
  /** Wall length used for fitting (outer edge — what wallLengthMm returns). */
  lengthMm: number
  /** Total stack height in mm (matches calculateCourseStack.actualHeightMm). */
  heightMm: number
  courses: CourseLayoutEntry[]
  blocks: PositionedBlock[]
}

/**
 * Decides which wall at a corner places the corner block for a given
 * course. Returns true if THIS wall is the owner of the corner at
 * `end` ('start' or 'end' of THIS wall) on the given 1-based course.
 *
 * Two-wall corners: alternates per course so the cumulative count
 * across both walls equals N (one corner block per course at the
 * cube), matching what calculateProjectTally produces after its
 * deduplication subtraction.
 *
 * 3+ wall corners: rotates ownership round-robin by sorted wall id.
 *
 * Free / T-junction / control-joint ends: not a shared corner — caller
 * should not consult this function (those ends always own their end
 * block).
 */
export type CornerOwnership = (args: {
  wallEnd: 'start' | 'end'
  courseNumber: number
}) => boolean

/**
 * Build a CornerOwnership function for a given wall, deriving phase
 * from its junction `connectedWallIds`. Walls connect at corners with
 * one or more other walls; this function decides which wall owns the
 * shared corner block on each course by id-sorted index modulo the
 * participant count.
 *
 * For a 2-wall corner the result is exactly opposite-phase between
 * the two walls — odd courses belong to the lower-id wall, even to
 * the higher-id wall. That's the natural stretcher-bond alternation
 * a real corner block produces when 200×200×400 blocks stack at 90°.
 */
export function cornerOwnershipFor(wall: Wall): CornerOwnership {
  const partySortedAt = (junction: Wall['startJunction']) => {
    if (junction.type !== 'corner' && junction.type !== 'control-joint') {
      return null
    }
    const others = junction.connectedWallIds ?? []
    if (others.length === 0) return null
    const all = [...others, wall.id].sort()
    const myIdx = all.indexOf(wall.id)
    return { all, myIdx, n: all.length }
  }
  const startInfo = partySortedAt(wall.startJunction)
  const endInfo = partySortedAt(wall.endJunction)
  return ({ wallEnd, courseNumber }) => {
    const info = wallEnd === 'start' ? startInfo : endInfo
    if (!info) return true // Not a shared corner — caller owns it.
    return (courseNumber - 1) % info.n === info.myIdx
  }
}

/**
 * Returns the positioned-block layout for a wall using the same rules
 * as `calculateWallTally`. The sum of `blocks` by code MUST match the
 * tally produced for the same inputs (the dev-time verifier asserts
 * this).
 *
 * `cornerOwnership` (optional) deduplicates corner blocks at shared
 * corners. Without it the layout matches per-wall `calculateWallTally`
 * exactly (each wall counts its full corner column at every corner).
 * With it, the layout only emits a corner block when this wall is the
 * owner of the corner for that course — total corners across all
 * walls then equals the project-level deduplicated count produced by
 * `calculateProjectTally` (which subtracts (n-1) per shared corner).
 *
 * Curved walls fall through to a simpler centreline-based layout for
 * now; openings are not yet applied (TODO).
 */
export function planWallLayout(
  wall: Wall,
  makeup: WallMakeup,
  openings: Opening[] = [],
  thicknessByWallId?: Record<string, number>,
  wallsById?: Record<string, Wall>,
  cornerOwnership?: CornerOwnership
): WallLayout {
  // Curved walls: return a minimal stub layout (no blocks) for now.
  // The 3D code's existing curve sampler still works as the fallback
  // until we extend planWallLayout to handle curves.
  if (isCurvedWall(wall)) {
    return {
      wallId: wall.id,
      isCurved: true,
      lengthMm: wallLengthMm(wall, thicknessByWallId, wallsById),
      heightMm: wall.heightMmOverride ?? getMakeupHeightMm(makeup),
      courses: [],
      blocks: [],
    }
  }

  const heightMm = wall.heightMmOverride ?? getMakeupHeightMm(makeup)
  const stack = calculateCourseStack(heightMm)
  const plan = planWall(wall, makeup, thicknessByWallId, wallsById)
  const courses = buildCourses(stack, makeup)
  const lengthMm = wallLengthMm(wall, thicknessByWallId, wallsById)

  // Resolve a block's face width from the library, falling back to
  // 390 for the rare case where a code isn't in the live library
  // (after a region swap). Matches the calc engine's defensive
  // handling in fitCourseLength.
  const widthOf = (code: BlockCode): number => {
    const def = BLOCK_LIBRARY[code]
    return def?.dimensions.widthMm ?? 390
  }
  // Course height (face height) for the 3D y-axis. Course modular is
  // height + MORTAR_MM; we want the face height since blocks have
  // visible mortar joints between courses.
  const courseFaceHeightMm = (type: CourseType): number => {
    switch (type) {
      case 'height-71':
        return 90
      case 'height-140':
        return 140
      default:
        return 190
    }
  }

  const layout: WallLayout = {
    wallId: wall.id,
    isCurved: false,
    lengthMm,
    heightMm: stack.actualHeightMm,
    courses: [],
    blocks: [],
  }

  // Build courses metadata first (yBottom positions), then walk
  // again to lay blocks. Two passes keeps the per-course placement
  // logic from having to know about whatever course came before.
  let yCursor = 0
  for (let i = 0; i < courses.length; i++) {
    const courseSpec = courses[i]
    const faceH = courseFaceHeightMm(courseSpec.type)
    layout.courses.push({
      courseNumber: i + 1,
      type: courseSpec.type,
      bodyBlock: courseSpec.bodyBlock,
      yBottomMm: yCursor,
      heightMm: faceH,
    })
    // Next course sits on a 10mm mortar bed above this one.
    yCursor += faceH + MORTAR_MM
  }

  // The wall-length re-fit machinery in calculateWallTally: when a
  // course carries a corner lead-in, the ends consume extra modular
  // and we re-fit the body length against that course's adjusted
  // ends.
  const wallLenForRefit = lengthMm

  for (let i = 0; i < courses.length; i++) {
    const courseSpec = courses[i]
    const courseNumber = i + 1
    const isOddCourse = i % 2 === 0

    // End block resolution — mirrors calculateWallTally exactly.
    // Only structural CORNER junctions get full-block-every-course.
    // Control joints alternate like free ends so each half emits
    // its own end termination at the seam.
    const resolveEndForCourse = (
      junctionType: JunctionType,
      cNum: number,
      odd: boolean
    ): BlockCode => {
      const blocks = resolveCourseBlocks(makeup, cNum)
      if (makeup.bondType === 'stretcher' && junctionType !== 'corner') {
        return odd
          ? healCode(blocks.cornerBlockCode, 'corner')
          : healCode(blocks.halfBlockCode, 'end-termination')
      }
      return healCode(blocks.cornerBlockCode, 'corner')
    }
    const startBlock: BlockCode = plan.noEndBlocks
      ? (isOddCourse ? plan.startEnd.oddBlock : plan.startEnd.evenBlock)
      : resolveEndForCourse(wall.startJunction.type, courseNumber, isOddCourse)
    // Rule 4 (running bond): when planWall inverted the end-side
    // parity (smaller worst-course gap that way), resolveEndForCourse
    // needs to see the FLIPPED `odd` arg for the END side so it picks
    // the half-end when isOddCourse is true and the full-end when
    // false. plan.endParityInverted carries planWall's decision so we
    // don't re-evaluate the rule here.
    const endParityOdd = plan.endParityInverted ? !isOddCourse : isOddCourse
    const endBlock: BlockCode = plan.noEndBlocks
      ? (isOddCourse ? plan.endEnd.oddBlock : plan.endEnd.evenBlock)
      : resolveEndForCourse(wall.endJunction.type, courseNumber, endParityOdd)

    // Corner lead-in (e.g. 30.02 × 2 inside 300-series corners).
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
        const blockDef = BLOCK_LIBRARY[leadInCode]
        const blockModular = blockDef
          ? blockDef.dimensions.widthMm + MORTAR_MM
          : 0
        leadInModularTotal = (startLeadInCount + endLeadInCount) * blockModular
      }
    }

    // ── Corner ownership (computed EARLY so fit-selection below can
    //    account for the cube-shift on non-owning courses) ────────────
    //
    // At a shared corner, the perpendicular wall's corner block extends
    // into THIS wall by `cubeDepth` (≈ neighbour wall's thickness, ~190
    // mm) on courses where the perpendicular owns. On those courses,
    // this wall's body grid starts at `cubeDepth + mortar` (~200) from
    // the wall end instead of at `fullCornerWidth + mortar` (~400). The
    // 200 mm shift is what produces the natural running-bond offset at
    // corners — and it also means the fit's body count has to be re-
    // computed for that course, otherwise we plan for the wrong amount
    // of body-grid room and the layout falls short (extra filler) or
    // overshoots (clamped body).
    const startIsSharedCorner = wall.startJunction.type === 'corner'
    const ownsStartCorner =
      !cornerOwnership || !startIsSharedCorner
        ? true
        : cornerOwnership({ wallEnd: 'start', courseNumber })
    const endIsSharedCorner = wall.endJunction.type === 'corner'
    const ownsEndCorner =
      !cornerOwnership || !endIsSharedCorner
        ? true
        : cornerOwnership({ wallEnd: 'end', courseNumber })
    // Perpendicular wall's thickness = corner cube depth on this wall's
    // axis. Falls back to this wall's own thickness (almost always
    // equal at a corner) then 190 mm if unknown.
    const wallThickness =
      thicknessByWallId?.[wall.id] ??
      BLOCK_LIBRARY[makeup.bodyBlockCode]?.dimensions.depthMm ??
      190
    const startNeighborId =
      wall.startJunction.type === 'corner' ||
      wall.startJunction.type === 'control-joint'
        ? wall.startJunction.connectedWallIds?.[0]
        : undefined
    const startCubeDepth =
      startNeighborId !== undefined
        ? (thicknessByWallId?.[startNeighborId] ?? wallThickness)
        : wallThickness
    const endNeighborId =
      wall.endJunction.type === 'corner' ||
      wall.endJunction.type === 'control-joint'
        ? wall.endJunction.connectedWallIds?.[0]
        : undefined
    const endCubeDepth =
      endNeighborId !== undefined
        ? (thicknessByWallId?.[endNeighborId] ?? wallThickness)
        : wallThickness

    // Pick the fit for this course, re-fitting whenever any of:
    //   - lead-in widens an end (e.g. 30.02 pair at 300-series corners)
    //   - corner ownership shifts the start by (fullCorner − cubeDepth)
    //   - corner ownership shifts the end by the same
    //
    // The re-fit substitutes each end's effective modular: the full
    // end-block modular when this wall owns the corner, or the cube
    // modular (cubeDepth + mortar) when the perpendicular wall does.
    const baseStartEndModular = isOddCourse
      ? plan.startEnd.oddModular
      : plan.startEnd.evenModular
    const baseEndEndModular = isOddCourse
      ? plan.endEnd.oddModular
      : plan.endEnd.evenModular
    const startModuleForFit = ownsStartCorner
      ? baseStartEndModular
      : startCubeDepth + MORTAR_MM
    const endModuleForFit = ownsEndCorner
      ? baseEndEndModular
      : endCubeDepth + MORTAR_MM
    const needsRefit =
      leadInModularTotal > 0 ||
      !ownsStartCorner ||
      !ownsEndCorner
    let fit = isOddCourse ? plan.oddCourseFit : plan.evenCourseFit
    if (needsRefit) {
      const adjustedEndsTotal =
        startModuleForFit + endModuleForFit + leadInModularTotal
      fit = fitCourseLength(
        wallLenForRefit,
        adjustedEndsTotal,
        makeup.useFractions
      )
    }

    const startEndWidth = widthOf(startBlock)
    const endEndWidth = widthOf(endBlock)
    const leadInWidth = leadInCode ? widthOf(leadInCode) : 0

    // ---- Lay blocks left-to-right ----
    let s = 0

    // Height-makeup courses (20.71 / 20.140) span the FULL course
    // length with cut-to-length height-makeup blocks. The calc tally
    // sums fit.bodyCount + fit.fractions.length + endCount + lead-ins
    // worth of the same block (`course.bodyBlock`). To keep the
    // layout faithful, we emit that many positioned blocks across
    // the wall length, evenly distributing them. Each is the
    // height-makeup block; the role tag stays 'body' since the
    // bricklayer sees one continuous row.
    if (courseSpec.type === 'height-71' || courseSpec.type === 'height-140') {
      const totalBlocks =
        fit.bodyCount +
        fit.fractions.length +
        (plan.noEndBlocks ? 0 : 2) +
        startLeadInCount +
        endLeadInCount
      // Evenly tile across the wall length so the count matches the
      // tally. Each block's width is wallLength / totalBlocks; this
      // is an approximation but it preserves the count exactly.
      // Bricklayer cuts each block to fit on site anyway.
      if (totalBlocks > 0) {
        const perWidth = (lengthMm - (totalBlocks - 1) * MORTAR_MM) / totalBlocks
        for (let b = 0; b < totalBlocks; b++) {
          layout.blocks.push({
            code: courseSpec.bodyBlock,
            role: 'body',
            s0Mm: s,
            widthMm: Math.max(0, perWidth),
            courseIdx: i,
          })
          s += perWidth + MORTAR_MM
        }
      }
      continue
    }

    // ---- Normal course (base / body / top / single-block-stub) ----

    if (plan.noEndBlocks) {
      // Single-block-stub mode: fit.fractions contains exactly one
      // block code chosen by fitSingleBlockWall — one block per
      // course, spanning the full wall length. Centre it.
      const code = fit.fractions[0] ?? courseSpec.bodyBlock
      const w = Math.min(widthOf(code), lengthMm)
      layout.blocks.push({
        code,
        role: 'fraction',
        s0Mm: (lengthMm - w) / 2,
        widthMm: w,
        courseIdx: i,
      })
      continue
    }

    // Start end block — at a shared corner we may SKIP emission if
    // another wall at the same corner owns the block this course.
    //
    // When SKIPPED, the body cursor advances by only the corner CUBE
    // DEPTH (= perpendicular wall's thickness) instead of the full
    // cornerW. The cube boundary is the actual extent of the corner
    // along this wall's axis; the perpendicular wall's owning corner
    // block fills the cube AND extends 100-200mm past it into its
    // own wall, NOT into this one. So body blocks on this wall can
    // start right at the cube boundary — no gap.
    //
    // The shift between owning vs non-owning (cornerW - cubeDepth)
    // is the natural stretcher-bond offset that real corner blocks
    // produce when 200×200×400 blocks stack at 90°.
    // Only structural CORNER junctions invoke the corner-ownership
    // alternation (where two walls at a 90° join share a corner
    // block on alternating courses). Control joints are NOT shared —
    // they are a physical break with two independent walls on either
    // side. Each half owns its OWN corner block on every course,
    // producing the clean vertical edge a control joint should have.
    //
    // ownsStartCorner, ownsEndCorner, startCubeDepth, endCubeDepth,
    // and wallThickness are all computed earlier in this iteration so
    // the per-course re-fit above can account for the cube-shift. We
    // just consume them here for the actual emit.
    if (ownsStartCorner) {
      layout.blocks.push({
        code: startBlock,
        role:
          BLOCK_LIBRARY[startBlock]?.roles.includes('corner')
            ? 'corner'
            : 'end-half',
        s0Mm: s,
        widthMm: startEndWidth,
        courseIdx: i,
      })
      s += startEndWidth + MORTAR_MM
    } else {
      // Skipped — body grid starts at the cube boundary, not cornerW.
      // We still emit a render-only "cube filler" at s∈[0, cubeDepth]
      // so this wall's exterior shows continuous corner colour across
      // the cube area on every course. The perpendicular wall's
      // owning corner block fills the cube physically but its faces
      // don't lie on THIS wall's exterior plane, so without the
      // filler the camera sees a recessed gap. renderOnly=true keeps
      // this out of the tally — the perpendicular wall's block is
      // already counted.
      layout.blocks.push({
        code: startBlock,
        role: 'corner',
        s0Mm: 0,
        widthMm: startCubeDepth,
        courseIdx: i,
        renderOnly: true,
      })
      s += startCubeDepth + MORTAR_MM
    }

    // Start lead-ins.
    for (let k = 0; k < startLeadInCount; k++) {
      layout.blocks.push({
        code: leadInCode!,
        role: 'lead-in',
        s0Mm: s,
        widthMm: leadInWidth,
        courseIdx: i,
      })
      s += leadInWidth + MORTAR_MM
    }

    // Pre-compute the end-side anchor BEFORE body emission so the
    // body/fraction/lead-in loop can respect it. Anchoring the end
    // block at its natural position (lengthMm - endEndWidth) and
    // letting the body absorb any cut is the construction-correct
    // behaviour — masons cut a body block to fit, never the end
    // termination. ownsEndCorner / endCubeDepth come from the early
    // computation block above.
    const endRegionStart = ownsEndCorner
      ? lengthMm - endEndWidth
      : lengthMm - endCubeDepth
    // The last s-position bodies / fractions / lead-ins are allowed
    // to reach — one mortar joint short of the end region's start,
    // so the gap between the last body and the end block reads as
    // a proper mortar line.
    const bodyCap = endRegionStart - MORTAR_MM

    // Body blocks. The tally counts `fit.bodyCount` of
    // courseSpec.bodyBlock; we emit that many. The LAST body absorbs
    // any leftover cut (when fitCourseLength rounded up because no
    // fraction fit) by shrinking its rendered widthMm to whatever
    // space remains before bodyCap. Tally is unaffected — that uses
    // block COUNT, not widthMm.
    const bodyWidth = widthOf(courseSpec.bodyBlock)
    for (let b = 0; b < fit.bodyCount; b++) {
      // Available room from the current s up to the bodyCap. If a
      // full body would overrun, clamp it to whatever fits. If there
      // isn't even a meaningful sliver left (≤ TINY_GAP_MM), drop
      // the block entirely so we don't emit a near-zero-width box.
      const room = bodyCap - s
      if (room <= 30) break
      const actualWidth = Math.min(bodyWidth, room)
      layout.blocks.push({
        code: courseSpec.bodyBlock,
        role: 'body',
        s0Mm: s,
        widthMm: actualWidth,
        courseIdx: i,
      })
      s += actualWidth + MORTAR_MM
    }

    // Fractions (gap-fillers). Same room-aware clamping as bodies —
    // fractions are naturally narrow (90-290mm) so they almost never
    // need clamping, but the safety net keeps us symmetric.
    for (const fracCode of fit.fractions) {
      const w = widthOf(fracCode)
      const room = bodyCap - s
      if (room <= 30) break
      const actualWidth = Math.min(w, room)
      layout.blocks.push({
        code: fracCode,
        role: 'fraction',
        s0Mm: s,
        widthMm: actualWidth,
        courseIdx: i,
      })
      s += actualWidth + MORTAR_MM
    }

    // End lead-ins (between the body/fraction zone and the end corner).
    for (let k = 0; k < endLeadInCount; k++) {
      const room = bodyCap - s
      if (room <= 30) break
      const actualWidth = Math.min(leadInWidth, room)
      layout.blocks.push({
        code: leadInCode!,
        role: 'lead-in',
        s0Mm: s,
        widthMm: actualWidth,
        courseIdx: i,
      })
      s += actualWidth + MORTAR_MM
    }

    // Render-only gap filler: when the body grid leaves a visible
    // gap before the end region (typically because corner ownership
    // shifted the start grid by cornerW - cubeDepth on this course),
    // insert a body-coloured filler so the visual reads as a
    // continuous body row.
    const fillerSlotEnd = endRegionStart - MORTAR_MM
    const fillerWidth = fillerSlotEnd - s
    if (fillerWidth > 30) {
      layout.blocks.push({
        code: courseSpec.bodyBlock,
        role: 'body',
        s0Mm: s,
        widthMm: fillerWidth,
        courseIdx: i,
        renderOnly: true,
      })
    }

    if (ownsEndCorner) {
      // End block emitted at its natural anchor position with its
      // full library face width — no Math.max(s, …) any more. With
      // bodies now respecting bodyCap, s should be ≤ endRegionStart
      // by construction; the end block always fits.
      layout.blocks.push({
        code: endBlock,
        role:
          BLOCK_LIBRARY[endBlock]?.roles.includes('corner')
            ? 'corner'
            : 'end-half',
        s0Mm: lengthMm - endEndWidth,
        widthMm: endEndWidth,
        courseIdx: i,
      })
    } else {
      // Non-owning end: emit a render-only cube filler at
      // s∈[length - cubeDepth, length] so the cube exterior is
      // visually continuous on every course (same reasoning as the
      // start cube filler above).
      layout.blocks.push({
        code: endBlock,
        role: 'corner',
        s0Mm: lengthMm - endCubeDepth,
        widthMm: endCubeDepth,
        courseIdx: i,
        renderOnly: true,
      })
    }

    // Paired-tile (cleanouts): the tally adds ceil(bodyCount /
    // pairedPer) of the tile. We emit those tiles paired with body
    // blocks. They share Y with the course but the 3D renderer can
    // ignore them (or render them at the wall's interior face) —
    // they're part of the tally regardless.
    if (courseSpec.pairedTile && fit.bodyCount > 0) {
      const bodyDef = BLOCK_LIBRARY[courseSpec.bodyBlock]
      const pairedPer = bodyDef?.pairedPer ?? 1
      const tileCount = Math.ceil(fit.bodyCount / pairedPer)
      const tileWidth = widthOf(courseSpec.pairedTile)
      // Tiles ride on the BACK of body blocks — we tile them across
      // the body region for positional plausibility, but the 3D code
      // typically won't render them (they're inside the cavity).
      const bodyZoneStart = startEndWidth + MORTAR_MM
      const bodyZoneEnd = lengthMm - endEndWidth - MORTAR_MM
      const bodyZoneLen = Math.max(0, bodyZoneEnd - bodyZoneStart)
      const spacing = tileCount > 0 ? bodyZoneLen / tileCount : 0
      for (let t = 0; t < tileCount; t++) {
        layout.blocks.push({
          code: courseSpec.pairedTile,
          role: 'paired-tile',
          s0Mm: bodyZoneStart + t * spacing,
          widthMm: tileWidth,
          courseIdx: i,
        })
      }
    }
  }

  // Openings — TODO: extend planWallLayout to emit jamb + lintel
  // positioned blocks and remove body blocks under openings. Until
  // then we don't apply opening adjustments here; the 3D renderer
  // will continue to apply its own opening carving on top of the
  // layout for the visual. This means the layout's tally is
  // _wall-without-openings_ and will diverge from
  // calculateWallTally(...) for any wall that HAS openings.
  // verifyLayoutMatchesTally handles this gracefully (it skips the
  // check when openings are present).
  void openings

  return layout
}

/**
 * Aggregate a WallLayout's blocks into a BlockTally. Used both by
 * verifyLayoutMatchesTally for the runtime sanity check and as the
 * eventual replacement for calculateWallTally's per-course addToTally
 * calls.
 */
export function tallyFromLayout(layout: WallLayout): BlockTally {
  const tally: BlockTally = {}
  for (const b of layout.blocks) {
    if (b.renderOnly) continue
    addToTally(tally, b.code, 1)
  }
  return tally
}

/**
 * Dev-time consistency check — compares the layout's aggregated tally
 * to what calculateWallTally returns for the same inputs. console.warn
 * any differences so divergences surface during development. No-op
 * when openings are present (layout doesn't apply them yet).
 */
export function verifyLayoutMatchesTally(
  layout: WallLayout,
  wall: Wall,
  makeup: WallMakeup,
  openings: Opening[] = [],
  thicknessByWallId?: Record<string, number>,
  wallsById?: Record<string, Wall>,
  cornerOwnershipApplied = false
): { ok: boolean; differences: Array<{ code: BlockCode; layout: number; tally: number }> } {
  // Skip the check while openings live in calculateWallTally only,
  // for curved walls (not yet handled by layout), and when corner
  // ownership was applied — the layout intentionally drops corners
  // on non-owning courses, so its per-wall tally is BELOW
  // calculateWallTally by design.
  //
  // Note: caps (makeup.capBlockCode) also live in calculateWallTally
  // but NOT in planWallLayout — the cap is an additive top layer,
  // emitted separately by segmentsFromWallLayout. The 3D path always
  // passes cornerOwnershipApplied=true, so the verifier already
  // skips, but if a future caller runs the verifier without ownership
  // it will need a `capPresent` skip flag (or planWallLayout should
  // emit cap blocks too).
  if (openings.length > 0 || layout.isCurved || cornerOwnershipApplied) {
    return { ok: true, differences: [] }
  }
  const layoutTally = tallyFromLayout(layout)
  const expected = calculateWallTally(
    wall,
    makeup,
    openings,
    thicknessByWallId,
    wallsById
  )
  const codes = new Set<BlockCode>([
    ...(Object.keys(layoutTally) as BlockCode[]),
    ...(Object.keys(expected) as BlockCode[]),
  ])
  const differences: Array<{ code: BlockCode; layout: number; tally: number }> = []
  for (const code of codes) {
    const l = layoutTally[code] ?? 0
    const t = expected[code] ?? 0
    if (l !== t) differences.push({ code, layout: l, tally: t })
  }
  return { ok: differences.length === 0, differences }
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
  // Bands-aware: use the actual summed band height instead of the legacy
  // makeup.heightMm field (which may be stale for coursePattern walls).
  // Note: sill/head course indexing still assumes 200mm modular per course —
  // mixed-height bands within an opening span will give approximate head
  // positioning. Task #95 (per-course heightMm metadata) addresses that.
  const wallHeightMm = wall.heightMmOverride ?? getMakeupHeightMm(makeup)

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
      // Subtract paired tiles at the same ratio they were ADDED — using
      // the BODY block's pairedPer (1 = 1:1, 2 = 1:2, etc.). Without
      // this, a 1:2 pairing would have its tiles subtracted faster
      // than they were tallied, leaving negative remainders that the
      // export would zero out and misreport.
      const bodyDef = BLOCK_LIBRARY[course.bodyBlock]
      const pairedPer = bodyDef?.pairedPer ?? 1
      const tilesToSubtract = Math.ceil(n / pairedPer)
      const tileCur = tally[course.pairedTile] ?? 0
      const tileNext = Math.max(0, tileCur - tilesToSubtract)
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
      jambCode = isOddCourse
        ? healCode(resolved.cornerBlockCode, 'corner')
        : healCode(resolved.halfBlockCode, 'end-termination')
      bodyToSubtract = (isOddCourse ? 2 : 1) + blocksAcrossOpening
    } else {
      jambCode = healCode(resolved.cornerBlockCode, 'corner')
      bodyToSubtract = 2 + blocksAcrossOpening
    }

    addToTally(tally, jambCode, 2)
    subtractCourseBody(courseIdx, bodyToSubtract)
  }

  // ---- Head area: lintel + body subtraction ----
  const headHeightMm = wallHeightMm - opening.sillHeightMm - opening.heightMm
  if (headHeightMm <= 0) return

  // Pick a lintel from the user's library by head height (bucket
  // metadata + fallback to smallest-height-≥-head). Returns null when
  // no block carries the `lintel` role at all — the user has either
  // opted out of in-tally lintels (e.g. a structural steel beam
  // handled outside the schedule) or hasn't tagged a library block
  // yet. When null we skip BOTH the lintel tally line AND the body
  // subtraction below: with no lintel in the tally, the head courses
  // above the opening are full-width body, and the count is correct
  // as-is.
  const lintel = selectBlockLintel(headHeightMm)
  if (!lintel) return

  // Lintel span = opening width + bearing on each side. Bearing is
  // per-lintel (block.lintelOverhangMm via LintelSpec.overhangMm,
  // defaults to 200mm). The bearing is where the lintel sits on the
  // body courses each side; the lintel itself spans the full bearing-
  // to-bearing distance as one continuous piece (or multiple block
  // pieces tiled across — same modular count math either way).
  const lintelSpanMm = opening.widthMm + 2 * lintel.overhangMm

  // Single row of lintels across the head — no vertical stacking. The
  // user has registered a lintel block whose own dimensions match how
  // the lintel is laid; the head-height bucket already picked the
  // right-sized block. Multiplying by `headHeight / verticalModule`
  // double-counted by stacking copies of a block that's already meant
  // to be one course of lintels at the chosen size.
  const lintelCount = Math.ceil(lintelSpanMm / lintel.horizontalModuleMm)
  addToTally(tally, lintel.code, lintelCount)

  // Body subtraction — only for the head courses the lintel actually
  // occupies. The lintel's vertical footprint in standard courses is
  // ceil(lintelVerticalModule / COURSE_MODULE_MM): a 200mm lintel
  // occupies 1 course, a 400mm lintel occupies 2. Courses ABOVE the
  // lintel (if any — i.e. when the head area is taller than the
  // lintel) are full-width body and need no subtraction.
  const headStartIdx = sillCoursesFloor + openingCourses
  const lintelCoursesNeeded = Math.ceil(
    lintel.verticalModuleMm / COURSE_MODULE_MM,
  )
  const lintelCoursesAvailable = Math.max(0, courses.length - headStartIdx)
  const lintelCoursesToUse = Math.min(lintelCoursesNeeded, lintelCoursesAvailable)
  const bodyPerLintelCourse = Math.ceil(lintelSpanMm / BODY_BLOCK_MODULE_MM)

  for (let i = 0; i < lintelCoursesToUse; i++) {
    subtractCourseBody(headStartIdx + i, bodyPerLintelCourse)
  }
}

/**
 * Compute the OUTER-EDGE endpoints of a straight wall.
 *
 * The drawing layer snaps a corner-forming endpoint to the CENTRE of
 * the existing wall's last block — i.e. halfThickness INSIDE the
 * existing wall's data endpoint along its own direction. So at a
 * corner, the two walls' data endpoints are not coincident: one sits
 * at the outer-corner intersection, the other 95mm (200-series) or
 * 145mm (300-series) inside the first wall's body.
 *
 * For the 3D renderer to lay block boxes at positions that go from 0
 * to `wallLengthMm` (outer-edge length), the wall's spatial extent in
 * 3D must also reach the outer corner. This helper applies the same
 * overlap math as `wallLengthMm` but produces extended start/end
 * positions instead of a scalar length. Used by `segmentsFromWallLayout`
 * and `segmentsForStraightWall` so the wall's 3D box positions align
 * with the calculated length and adjacent walls' corners meet cleanly.
 *
 * For T-junction ends the adjustment is NEGATIVE (the data endpoint
 * sits inside the through-wall body and the stem must visually end at
 * the through-wall face). For free ends the endpoint is unchanged.
 */
export function outerEdgeEndpoints(
  wall: Wall,
  thicknessByWallId?: Record<string, number>,
  wallsById?: Record<string, Wall>
): { startX: number; startY: number; endX: number; endY: number } {
  const result = {
    startX: wall.startX,
    startY: wall.startY,
    endX: wall.endX,
    endY: wall.endY,
  }
  if (!thicknessByWallId || !wallsById) return result
  const dx = wall.endX - wall.startX
  const dy = wall.endY - wall.startY
  const centrelineLength = Math.sqrt(dx * dx + dy * dy)
  if (centrelineLength === 0) return result
  // Unit vector pointing FROM start TO end.
  const ux = dx / centrelineLength
  const uy = dy / centrelineLength

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
    const perpDist = Math.abs(
      (dataX - other.startX) * onx + (dataY - other.startY) * ony
    )
    const overlap = Math.max(0, otherThickness / 2 - perpDist)
    if (overlap === 0) continue
    // Corner: EXTEND outward. The start moves in -direction, the end
    // moves in +direction (both away from the wall body).
    // T-junction: PULL BACK toward the wall body (opposite signs).
    const signCorner = which === 'start' ? -1 : 1
    const sign = junction.type === 'corner' ? signCorner : -signCorner
    if (which === 'start') {
      result.startX = wall.startX + ux * overlap * sign
      result.startY = wall.startY + uy * overlap * sign
    } else {
      result.endX = wall.endX + ux * overlap * sign
      result.endY = wall.endY + uy * overlap * sign
    }
  }

  return result
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

  const heightMm = wall.heightMmOverride ?? getMakeupHeightMm(makeup)
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
  // Modular face width comes from the actual block dimensions + mortar:
  // wedge front face (typically 190+10=200mm), or standard body block
  // (typically 390+10=400mm). For the cut zone the block face stays
  // full width — only the back is shaved — so still uses the body's
  // own modular.
  const bodyBlock = BLOCK_LIBRARY[bodyCode]
  const bodyModularMm = useWedge && wedge
    ? wedge.dimensions.widthMm + MORTAR_MM
    : (bodyBlock?.dimensions.widthMm ?? 390) + MORTAR_MM

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
  const corner = pickCornerBlock()
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
 * pattern via the Pier types section of WallTypesPanel.
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
  // Bands-driven walls: course count comes from the band counts directly
  // (so a wall with 4×20.48 + 2×20.71 pattern reports 6 courses regardless
  // of what stack.totalCourses would say from the legacy 200mm-modular path).
  const heightMm = wall.heightMmOverride ?? getMakeupHeightMm(makeup)
  const stack = calculateCourseStack(heightMm)
  const N =
    makeup.coursePattern && makeup.coursePattern.length > 0
      ? getCourseCount(makeup)
      : stack.totalCourses
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
    const heightMm = wall.heightMmOverride ?? getMakeupHeightMm(makeup)
    const stack = calculateCourseStack(heightMm)
    const totalCourses =
      makeup.coursePattern && makeup.coursePattern.length > 0
        ? getCourseCount(makeup)
        : stack.totalCourses
    const pattern = pierMakeup?.coursePattern?.length
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

    // Walk the wall's actual course list — works the same for bands-driven
    // walls and legacy walls because buildCourses returns a unified
    // CourseSpec[] either way. For each shared-corner block we subtract
    // (n-1) copies of the blockCode that ROW puts at the corner column.
    //
    //  - Standard courses ('base' / 'body' / 'top'): corner column carries
    //    the wall's corner block (resolveCourseBlocks honours any 300/200
    //    series range overlay for that row).
    //  - Height-makeup rows ('height-71' / 'height-140'): the height-makeup
    //    block IS the corner column — there's no separate corner column at
    //    that row. Subtract the height-makeup block itself.
    const heightMm = firstWall.heightMmOverride ?? getMakeupHeightMm(makeup)
    const stack = calculateCourseStack(heightMm)
    const courses = buildCourses(stack, makeup)
    if (courses.length <= 0) continue

    for (let ci = 0; ci < courses.length; ci++) {
      const courseNumber = ci + 1
      const course = courses[ci]
      if (course.type === 'height-71' || course.type === 'height-140') {
        // Height-makeup courses: the block itself fills the corner column,
        // so dedup against the course's actual blockCode.
        addToTally(adjustment, course.bodyBlock, n - 1)
      } else {
        // Standard courses: dedup against the corner block resolved for
        // this row (range overlay-aware). Healed against the live
        // library so the subtraction targets the same code the wall
        // tally added.
        const resolved = resolveCourseBlocks(makeup, courseNumber)
        addToTally(adjustment, healCode(resolved.cornerBlockCode, 'corner'), n - 1)
      }
    }
    void pickHeightMakeupBlock // legacy helper retained for non-bands callers
  }

  return adjustment
}
