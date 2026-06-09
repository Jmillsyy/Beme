/**
 * Geometry helpers for curved walls.
 *
 * A curved wall is defined by THREE points: start, mid, end. The three points
 * uniquely determine a circle, and the wall is the arc on that circle that
 * goes from `start` through `mid` to `end`. This is the "CAD-style" definition
 * the user described — they click two endpoints and a midpoint.
 *
 * All coordinates are in real-world millimetres on the plan (post-calibration),
 * matching the rest of the wall geometry in the app.
 */

export interface Point {
  x: number
  y: number
}

export interface ArcGeometry {
  /** Centre of the arc's circle, in mm. */
  centerX: number
  centerY: number
  /** Centreline radius in mm. */
  radiusMm: number
  /** Angle in radians from centre to `start`, measured the usual atan2 way. */
  startAngle: number
  /** Angle to `mid`. */
  midAngle: number
  /** Angle to `end`. */
  endAngle: number
  /**
   * Signed sweep angle (radians) from startAngle to endAngle along the arc
   * passing through `mid`. Positive = counter-clockwise, negative = clockwise.
   */
  sweepAngle: number
  /** Arc length in mm (always positive). */
  arcLengthMm: number
}

/**
 * Compute the circumcircle of three points (centre + radius).
 *
 * Returns null if the points are collinear (no finite circle through them — that's
 * a straight line, not a curve).
 */
export function circleThroughThreePoints(
  a: Point,
  b: Point,
  c: Point
): { centerX: number; centerY: number; radiusMm: number } | null {
  // Standard circumcentre formula via the determinant approach.
  const ax = a.x
  const ay = a.y
  const bx = b.x
  const by = b.y
  const cx = c.x
  const cy = c.y
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by))
  if (Math.abs(d) < 1e-6) return null

  const aSq = ax * ax + ay * ay
  const bSq = bx * bx + by * by
  const cSq = cx * cx + cy * cy

  const ux = (aSq * (by - cy) + bSq * (cy - ay) + cSq * (ay - by)) / d
  const uy = (aSq * (cx - bx) + bSq * (ax - cx) + cSq * (bx - ax)) / d

  const r = Math.sqrt((ax - ux) ** 2 + (ay - uy) ** 2)
  return { centerX: ux, centerY: uy, radiusMm: r }
}


/**
 * Given a circle centre and a point, return the angle from centre to point.
 */
function angleFromCentre(centerX: number, centerY: number, p: Point): number {
  return Math.atan2(p.y - centerY, p.x - centerX)
}

/**
 * Full arc geometry from three points on the arc.
 *
 * The sweep direction (CW vs CCW) is chosen so the arc passes through `mid`.
 * Returns null if the three points are collinear.
 */
export function arcFromThreePoints(start: Point, mid: Point, end: Point): ArcGeometry | null {
  const circle = circleThroughThreePoints(start, mid, end)
  if (!circle) return null

  const { centerX, centerY, radiusMm } = circle
  const startAngle = angleFromCentre(centerX, centerY, start)
  const midAngle = angleFromCentre(centerX, centerY, mid)
  const endAngle = angleFromCentre(centerX, centerY, end)

  // Pick the sweep direction (CCW = +, CW = −) so the arc from start→end passes
  // through mid. Method: compute the CCW distance from start to mid and to end
  // (both in [0, 2π)). If mid sits before end going CCW, the arc is CCW; otherwise
  // the arc must go CW (and the sweep is negative).
  //
  // The previous implementation used signed-shortest-angle differences and broke
  // when start/end straddled the −π/+π seam (mid would end up "outside" what the
  // boolean check considered the span, the algorithm fell back to CCW sweep,
  // and the rendered arc went the long way around the circle — exactly what the
  // user was seeing when the cursor was on one side of the wall and the preview
  // bulged out on the other).
  const ccwStartToMid = ((midAngle - startAngle) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI)
  const ccwStartToEnd = ((endAngle - startAngle) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI)

  const sweepAngle = ccwStartToMid < ccwStartToEnd
    ? ccwStartToEnd                      // CCW path goes start → mid → end
    : ccwStartToEnd - 2 * Math.PI        // CW path (negative)

  const arcLengthMm = Math.abs(sweepAngle) * radiusMm

  return {
    centerX,
    centerY,
    radiusMm,
    startAngle,
    midAngle,
    endAngle,
    sweepAngle,
    arcLengthMm,
  }
}

/**
 * Sample N evenly-spaced points along the arc (inclusive of start and end).
 * Useful for rendering the arc as a polyline.
 */
export function sampleArc(geom: ArcGeometry, samples = 32): Point[] {
  const pts: Point[] = []
  const n = Math.max(2, samples)
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1)
    const a = geom.startAngle + t * geom.sweepAngle
    pts.push({
      x: geom.centerX + geom.radiusMm * Math.cos(a),
      y: geom.centerY + geom.radiusMm * Math.sin(a),
    })
  }
  return pts
}

/**
 * Convenience: compute arc length directly from three points without holding the geometry.
 * Falls back to the straight-line chord length if the points are collinear.
 */
export function arcLengthFromThreePoints(start: Point, mid: Point, end: Point): number {
  const geom = arcFromThreePoints(start, mid, end)
  if (!geom) {
    const dx = end.x - start.x
    const dy = end.y - start.y
    return Math.sqrt(dx * dx + dy * dy)
  }
  return geom.arcLengthMm
}

/**
 * Helper: is this Wall a curved wall? Uses the discriminator if present, falling
 * back to checking for midX/midY (so older saved walls don't accidentally read as curved).
 */
export function isCurvedWall(wall: {
  kind?: 'straight' | 'curved'
  midX?: number
  midY?: number
}): boolean {
  return wall.kind === 'curved' && wall.midX !== undefined && wall.midY !== undefined
}

/**
 * Project a click point onto an arc. Returns the closest point ON the arc
 * (not on the underlying full circle) plus its along-arc position from
 * the arc's start in millimetres.
 *
 * Algorithm:
 *   1. Compute the click's angle relative to the arc centre.
 *   2. Map that angle to a CCW offset from the arc's startAngle, in the
 *      sweep direction. If the offset falls inside [0, |sweepAngle|] the
 *      closest point is the radial projection. Otherwise the click sits
 *      "outside" the arc — clamp to whichever endpoint (start or end) is
 *      closer in angular distance.
 *   3. alongMm = (offset / |sweepAngle|) * arcLengthMm, capped at the arc
 *      ends.
 *
 * Returned `distFromArcMm` is the radial distance from the click to its
 * closest point on the arc (positive). Useful for hit-testing.
 */
export function projectOntoArc(
  clickPt: Point,
  geom: ArcGeometry,
): { point: Point; alongMm: number; distFromArcMm: number; t: number } {
  const cxToClick = clickPt.x - geom.centerX
  const cyToClick = clickPt.y - geom.centerY
  const distFromCentre = Math.sqrt(cxToClick * cxToClick + cyToClick * cyToClick)
  // Click direction from the centre — radial unit vector.
  const dirX = distFromCentre > 1e-9 ? cxToClick / distFromCentre : 1
  const dirY = distFromCentre > 1e-9 ? cyToClick / distFromCentre : 0

  // CCW offset from start, normalised into [0, 2π).
  const TWO_PI = 2 * Math.PI
  const rawAngle = Math.atan2(cyToClick, cxToClick)
  const ccwOffset = ((rawAngle - geom.startAngle) % TWO_PI + TWO_PI) % TWO_PI

  // Project into the SWEEP direction. For a CCW arc (sweepAngle > 0) we
  // keep ccwOffset as-is. For a CW arc (sweepAngle < 0) we measure the
  // CW offset, which is (TWO_PI - ccwOffset).
  const sweepMag = Math.abs(geom.sweepAngle)
  const offsetInSweep = geom.sweepAngle >= 0 ? ccwOffset : TWO_PI - ccwOffset

  let t: number
  if (offsetInSweep <= sweepMag) {
    // Inside the arc — radial projection lands on the live segment.
    t = offsetInSweep / sweepMag
  } else {
    // Outside the arc — clamp to whichever endpoint is closer along the
    // CIRCLE. Distances are angular: from the click's angle to the
    // start (offset = offsetInSweep) and to the end (offset = sweepMag).
    // The "gap" past the end is offsetInSweep - sweepMag. The "gap"
    // before the start (wrapping the long way round) is TWO_PI -
    // offsetInSweep. Closer wins.
    const gapPastEnd = offsetInSweep - sweepMag
    const gapBeforeStart = TWO_PI - offsetInSweep
    t = gapPastEnd < gapBeforeStart ? 1 : 0
  }

  const pointX = geom.centerX + geom.radiusMm * dirX
  const pointY = geom.centerY + geom.radiusMm * dirY
  // If we clamped to an endpoint the radial projection above isn't on
  // the live arc — overwrite with the actual endpoint coordinates.
  let finalX = pointX
  let finalY = pointY
  if (t === 0) {
    finalX = geom.centerX + geom.radiusMm * Math.cos(geom.startAngle)
    finalY = geom.centerY + geom.radiusMm * Math.sin(geom.startAngle)
  } else if (t === 1) {
    finalX = geom.centerX + geom.radiusMm * Math.cos(geom.startAngle + geom.sweepAngle)
    finalY = geom.centerY + geom.radiusMm * Math.sin(geom.startAngle + geom.sweepAngle)
  }

  const dxFinal = clickPt.x - finalX
  const dyFinal = clickPt.y - finalY
  const distFromArcMm = Math.sqrt(dxFinal * dxFinal + dyFinal * dyFinal)

  return {
    point: { x: finalX, y: finalY },
    alongMm: t * geom.arcLengthMm,
    distFromArcMm,
    t,
  }
}

/**
 * Split an arc at parameter t ∈ [0, 1] (where t is measured along the
 * arc, NOT along the chord). Returns two new (start, mid, end) triples
 * that together trace the original arc exactly. The new mid points are
 * placed at the midpoint of each sub-sweep so both halves remain valid
 * three-point curves.
 *
 * Caller is expected to clamp t away from 0 and 1 (e.g. by a minimum
 * along-arc distance) so neither half collapses to zero length.
 */
export function splitArcAtParameter(
  geom: ArcGeometry,
  t: number,
): {
  first: { start: Point; mid: Point; end: Point }
  second: { start: Point; mid: Point; end: Point }
} {
  const tClamped = Math.max(0.001, Math.min(0.999, t))
  const ptOn = (angle: number): Point => ({
    x: geom.centerX + geom.radiusMm * Math.cos(angle),
    y: geom.centerY + geom.radiusMm * Math.sin(angle),
  })
  const startAng = geom.startAngle
  const endAng = geom.startAngle + geom.sweepAngle
  const splitAng = geom.startAngle + geom.sweepAngle * tClamped

  const firstMidAng = startAng + (splitAng - startAng) / 2
  const secondMidAng = splitAng + (endAng - splitAng) / 2

  return {
    first: {
      start: ptOn(startAng),
      mid: ptOn(firstMidAng),
      end: ptOn(splitAng),
    },
    second: {
      start: ptOn(splitAng),
      mid: ptOn(secondMidAng),
      end: ptOn(endAng),
    },
  }
}
