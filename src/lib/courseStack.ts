/**
 * Course-stack picker: the SINGLE source of truth for deciding how a wall
 * height breaks down into courses (how many standard courses + which
 * height-makeup blocks). Both the calc/render path (blockCalc.buildCourses
 * / planWallLayout) and the bands path (makeups.convertMakeupToBands) call
 * this, so the 3D body, the tally, the wall envelope, the cap and the
 * mortar can never disagree about whether a 90mm / 140mm makeup course
 * exists. Previously this logic was duplicated in two places that drifted
 * apart (one placed a 20.71 makeup course, the other sized a full course
 * slot, opening a fat joint); keep it here, in one place, forever.
 */
import { BLOCK_LIBRARY, pickHeightMakeupBlock } from '../data/blockLibrary'
import { DEFAULT_MORTAR_JOINT_MM } from '../types/blocks'
import type { WallMakeup } from '../types/walls'

/** Modular height of a standard 20.48-height course (190 + 10). */
export const COURSE_MODULE_MM = 200
const MORTAR_MM = DEFAULT_MORTAR_JOINT_MM

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
  /** Actual built height in mm given the stack - `standardCount * 200 + has71 * 90 + has140 * 140`. */
  actualHeightMm: number
  /** Difference between actual and requested (always ≥ 0 - we round UP). */
  overageMm: number
}

/**
 * Decide how the wall height breaks down into courses.
 *
 * Modular course heights (block + 10 mm mortar joint):
 * Standard (20.48): 200mm (190 + 10)
 * 20.71:            100mm (90 + 10)
 * 20.140:           150mm (140 + 10)
 *
 * Rather than failing when the requested height doesn't sum exactly from
 * the available course heights, we pick the SMALLEST stack whose total is
 * ≥ the requested height - i.e. round UP to the nearest achievable height.
 * The closest-size makeup block gets applied and the bricklayer trims
 * mortar on site to suit. The overage is surfaced in the export's
 * Assumptions section so the estimator sees they're quoting for slightly
 * more than requested.
 *
 * Examples:
 * 3000mm → 15 standard (exact, 3000)
 * 2700mm → 13 standard + 1× 20.71 (exact, 2700)
 * 2750mm → 13 standard + 1× 20.140 (exact, 2750)
 * 2740mm → 13 standard + 1× 20.140 (2750, overage 10mm - the 20.140 is
 * the closest-size block that gets the wall ≥ the request)
 * 2850mm → 13 standard + 1× 20.71 + 1× 20.140 (exact, 2850)
 * 3050mm → 14 standard + 1× 20.71 + 1× 20.140 = 3050 (exact)
 */
export function calculateCourseStack(
  heightMm: number,
  /**
   * Optional standard course modular (face + mortar). When provided,
   * replaces the hardcoded 200mm (AU 20.48: 190 + 10) so the stack
   * counts courses for the actual block-in-use. Critical for libraries
   * whose body block isn't 190mm tall - e.g. US CMU8 (194 + 10 = 204).
   */
  courseModuleMm: number = COURSE_MODULE_MM,
  /**
   * Optional ACTUAL height-makeup-band modulars (face + mortar) so
   * the stack picker scores combinations against what will really
   * render, not nominal AU values. Without this, a US library (e.g.
   * CMU8-HH at 92mm face) gets the nominal 150mm budgeted but only
   * 102mm actually emitted, leaving the wall ~48mm shorter than the
   * picker thought it would be. Undefined = the library has no block
   * for that band, so it is not offered.
   */
  hm140ModuleMm?: number,
  hm71ModuleMm?: number,
): CourseStack {
  // Enumerate every reasonable (N, has71, has140) combination and
  // pick the one that lands the wall closest to the user's target,
  // PREFERRING combinations that don't overshoot. Real masons would
  // rather have a wall a few mm short of nominal (which the top of
  // an adjacent slab or a strip flashing absorbs) than overshoot it
  // and have to cut the top course. Height-makeup blocks (a 90 / 140
  // mm block instead of a full course) are what make under-target
  // landings possible - for a 2400 mm wall with US CMU8 (204 mm
  // modular), 11 std + 1 × 92 mm HM = 2346 mm, beating 12 × 204 =
  // 2448 mm (48 mm over).
  const maxN = Math.ceil(heightMm / courseModuleMm) + 2
  type Candidate = {
    N: number
    has71: boolean
    has140: boolean
    total: number
    dist: number
    nCourses: number
    hmCount: number
  }
  let bestUnder: Candidate | null = null
  let bestOver: Candidate | null = null
  // Height-makeup courses are offered ONLY for bands this library
  // actually has a block for. hm71ModuleMm / hm140ModuleMm arrive as the
  // real block face + mortar (via resolveHmModules), or undefined when
  // the library has no such block. So AU (with its 20.71 / 20.140) lands
  // the wall closer to target using makeup blocks, while a library
  // without them falls back to the std-only stack + joint scaling. The
  // modules are ACTUAL resolved heights, so a US / UK library scores its
  // own makeup-course size, not a nominal AU value.
  const allow71 = typeof hm71ModuleMm === 'number' && hm71ModuleMm > 0
  const allow140 = typeof hm140ModuleMm === 'number' && hm140ModuleMm > 0
  const mod71 = allow71 ? (hm71ModuleMm as number) : 0
  const mod140 = allow140 ? (hm140ModuleMm as number) : 0
  for (let N = 0; N <= maxN; N++) {
    for (const has140 of allow140 ? [false, true] : [false]) {
      for (const has71 of allow71 ? [false, true] : [false]) {
        const total =
          N * courseModuleMm + (has140 ? mod140 : 0) + (has71 ? mod71 : 0)
        if (total <= 0) continue
        const hmCount = (has71 ? 1 : 0) + (has140 ? 1 : 0)
        const dist = Math.abs(total - heightMm)
        const nCourses = N + hmCount
        const cand: Candidate = {
          N,
          has71,
          has140,
          total,
          dist,
          nCourses,
          hmCount,
        }
        // Prefer the closest landing; tie-break toward fewer total
        // courses, then fewer makeup courses - so a wall that fits on
        // std courses alone never gets a needless makeup row, but a
        // 900mm AU wall (4 std + 1x20.71 = 900 exact) beats both the
        // 800mm and 1000mm std-only stacks.
        if (total <= heightMm) {
          if (
            !bestUnder ||
            dist < bestUnder.dist ||
            (dist === bestUnder.dist && nCourses < bestUnder.nCourses) ||
            (dist === bestUnder.dist &&
              nCourses === bestUnder.nCourses &&
              hmCount < bestUnder.hmCount)
          ) {
            bestUnder = cand
          }
        } else {
          if (
            !bestOver ||
            dist < bestOver.dist ||
            (dist === bestOver.dist && nCourses < bestOver.nCourses) ||
            (dist === bestOver.dist &&
              nCourses === bestOver.nCourses &&
              hmCount < bestOver.hmCount)
          ) {
            bestOver = cand
          }
        }
      }
    }
  }
  // Pick whichever side is closer to the target. Makeup courses can
  // land an exact (or near-exact) UNDER stack, so undershoot is no
  // longer a penalty - just take the smallest absolute distance.
  // Tie-break by picking the OVER stack (more masonry beats less for
  // a fixed height target).
  const best =
    bestUnder && bestOver
      ? bestOver.dist < bestUnder.dist
        ? bestOver
        : bestOver.dist === bestUnder.dist
          ? bestOver
          : bestUnder
      : bestUnder ?? bestOver
  if (!best) {
    const fallbackN = Math.ceil(heightMm / courseModuleMm)
    return {
      standardCount: fallbackN,
      has71: false,
      has140: false,
      totalCourses: fallbackN,
      valid: false,
      requestedHeightMm: heightMm,
      actualHeightMm: fallbackN * courseModuleMm,
      overageMm: fallbackN * courseModuleMm - heightMm,
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

/**
 * Resolve a makeup's actual height-makeup band modulars (block face +
 * mortar) for its active library, or undefined for a band the library
 * has no block for. This is what gates makeup courses per library:
 * calculateCourseStack only offers a 20.71 / 20.140 (or a region's
 * equivalent) when one really exists, and scores it against the real
 * block height.
 *
 * IMPORTANT: pickHeightMakeupBlock matches blocks with height <= target,
 * and the AU block names are NOT their heights (20.71 is a 90mm block,
 * 20.140 is 140mm). So the slots are targeted by their COURSE MODULE
 * (block + 10mm mortar): 100 finds the ~90mm small makeup, 150 finds the
 * ~140mm large one. Targeting by the "71" nickname matched nothing
 * (90 <= 71 is false), which left the picker only the 140 option and
 * dropped a 140mm block onto a 900mm wall. Same targets getCourseCount
 * already uses.
 */
export function resolveHmModules(makeup: WallMakeup): {
  hm71ModuleMm?: number
  hm140ModuleMm?: number
} {
  const bodyDepthMm = BLOCK_LIBRARY[makeup.bodyBlockCode]?.dimensions.depthMm
  const small = pickHeightMakeupBlock(100, bodyDepthMm)
  const large = pickHeightMakeupBlock(150, bodyDepthMm)
  const smallMod = small ? small.dimensions.heightMm + MORTAR_MM : undefined
  const largeMod = large ? large.dimensions.heightMm + MORTAR_MM : undefined
  // A library with only one makeup size resolves both lookups to the same
  // block - offer it once (as the large slot) so the picker doesn't stack
  // the same band twice.
  if (small && large && small.code === large.code) {
    return { hm71ModuleMm: undefined, hm140ModuleMm: largeMod }
  }
  return { hm71ModuleMm: smallMod, hm140ModuleMm: largeMod }
}
