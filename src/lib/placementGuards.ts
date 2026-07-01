/**
 * Placement guard rails for the 2D plan.
 *
 * Stops the user putting plan items where they make no masonry sense, so
 * the drawing experience is harder to break:
 *  - a control joint or height step sitting ON a window / door opening
 *  - an opening drawn ACROSS a height step (it would straddle two heights)
 *  - any item crowded against a wall end / corner (no room for end blocks)
 *  - openings overlapping each other, or a step / control joint dropped
 *    on top of an existing one
 *
 * The 2D layer uses these in two places: to colour the hover preview red
 * over an invalid spot, and to ignore the commit click there.
 *
 * UNITS: every position here is CENTRELINE distance-along-wall in mm -
 * the same basis projectOntoWall, opening.startAlongWallMm and
 * heightSteps[].alongMm already use - so the comparisons line up with no
 * conversion. Control joints are NOT passed in: placing one splits the
 * wall into two, so a wall never carries an inline control joint; the
 * end-clearance check covers a control-joint junction sitting at an end.
 */

/** A window / door footprint along the wall. */
export interface OpeningSpan {
  startAlongWallMm: number
  widthMm: number
}

export interface PlacementContext {
  /** Centreline length of the wall (mm). */
  wallLengthMm: number
  /** Openings already on this wall. */
  openings: OpeningSpan[]
  /** Existing height-step positions on this wall (centreline mm). */
  stepAlongMms: number[]
  /**
   * Minimum clear distance (mm) an item must keep from a wall end, and
   * that two items must keep from each other. Roughly a block so an end
   * block still fits. Falls back to DEFAULT_END_CLEARANCE_MM, and is the
   * fallback for startClearanceMm / endClearanceMm when those are unset.
   */
  clearanceMm?: number
  /**
   * Per-end clearances (centreline mm) when the two ends differ - e.g. a
   * corner reserves its full corner-block module while a free end only
   * needs the end block. Each is the clearance measured in CENTRELINE
   * space (the caller has already converted the desired tape distance via
   * the wall's end extension). Fall back to clearanceMm when unset.
   */
  startClearanceMm?: number
  endClearanceMm?: number
}

/** ~A standard block: enough room for an end block + its joint. */
export const DEFAULT_END_CLEARANCE_MM = 200

/**
 * Tolerance (mm) on the end-clearance checks. A position snapped exactly
 * to the corner-block edge should count as placeable; this absorbs any
 * float wobble between the snap and the clearance so the marker doesn't
 * blank one pixel short of the edge.
 */
const CLEARANCE_EPS_MM = 1

/**
 * True when `alongMm` sits on (or right at the edge of) an opening. The
 * 2D layer uses this to HIDE a control-joint / step preview over an
 * opening entirely, rather than drawing a red "blocked" marker across
 * the window or door.
 */
export function isOverOpening(
  alongMm: number,
  openings: OpeningSpan[],
): boolean {
  for (const o of openings) {
    if (
      alongMm >= o.startAlongWallMm - 1 &&
      alongMm <= o.startAlongWallMm + o.widthMm + 1
    ) {
      return true
    }
  }
  return false
}

/**
 * Validate a single-point item (a control joint or a height step) at
 * `alongMm`. Invalid when it is crowded against an end, sits on an
 * opening, or lands on top of an existing step.
 */
export function isPointPlacementValid(
  alongMm: number,
  ctx: PlacementContext,
): boolean {
  const clear = ctx.clearanceMm ?? DEFAULT_END_CLEARANCE_MM
  const startClear = ctx.startClearanceMm ?? clear
  const endClear = ctx.endClearanceMm ?? clear
  // Too close to either end - no room for the corner / end block.
  if (alongMm < startClear - CLEARANCE_EPS_MM) return false
  if (alongMm > ctx.wallLengthMm - endClear + CLEARANCE_EPS_MM) return false
  // Sitting on an opening.
  if (isOverOpening(alongMm, ctx.openings)) return false
  // On top of / crowding an existing step.
  for (const s of ctx.stepAlongMms) {
    if (Math.abs(alongMm - s) < clear) return false
  }
  return true
}

/**
 * Validate a new opening spanning [startMm, startMm + widthMm]. Invalid
 * when it has no width, runs into a wall end, straddles a height step, or
 * overlaps an existing opening.
 */
export function isOpeningPlacementValid(
  startMm: number,
  widthMm: number,
  ctx: PlacementContext,
): boolean {
  if (widthMm <= 0) return false
  const clear = ctx.clearanceMm ?? DEFAULT_END_CLEARANCE_MM
  const startClear = ctx.startClearanceMm ?? clear
  const endClear = ctx.endClearanceMm ?? clear
  const endMm = startMm + widthMm
  // Must sit clear of both wall ends (room for a jamb / corner block).
  if (startMm < startClear - CLEARANCE_EPS_MM) return false
  if (endMm > ctx.wallLengthMm - endClear + CLEARANCE_EPS_MM) return false
  // Must not straddle a height step.
  for (const s of ctx.stepAlongMms) {
    if (s > startMm + 1 && s < endMm - 1) return false
  }
  // Must not overlap an existing opening.
  for (const o of ctx.openings) {
    const oStart = o.startAlongWallMm
    const oEnd = o.startAlongWallMm + o.widthMm
    if (startMm < oEnd && endMm > oStart) return false
  }
  return true
}
