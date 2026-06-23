/**
 * wallGeom — wall endpoint / length geometry shared by the calc engine
 * and the 3D wall-segment enumeration. Extracted from blockCalc.ts so
 * wallSegments.ts can import it without a circular dependency.
 */
import type { Wall } from '../types/walls'
import { arcFromThreePoints, isCurvedWall } from './curveGeom'

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
