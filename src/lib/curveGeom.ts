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
 * Normalise an angle into the range (−π, π].
 */
function normaliseAngle(a: number): number {
  let x = a
  while (x > Math.PI) x -= 2 * Math.PI
  while (x <= -Math.PI) x += 2 * Math.PI
  return x
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
