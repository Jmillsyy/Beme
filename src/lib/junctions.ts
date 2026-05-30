/**
 * Junction detection for newly drawn walls.
 *
 * When a wall is created and one of its endpoints is at an existing wall's endpoint
 * (within a small tolerance), both walls' junctions at that shared point are tagged
 * as 'corner' and reference each other's wall id. This drives the corner-substitution
 * rule from the brief (in stretcher bond, 20.03 halves at the corner are replaced
 * with full 20.01 blocks every course).
 */

import type { Wall, WallJunction } from '../types/walls'
import { isCurvedWall } from './curveGeom'

interface Point {
  x: number
  y: number
}

/** mm tolerance for matching endpoint coordinates (after snap, they should be effectively identical). */
const ENDPOINT_TOLERANCE_MM = 0.5
/**
 * Extra mm tolerance on top of the wall's halfThickness when testing "point on wall body".
 * Allows a small margin for click imprecision around the face line.
 */
const FACE_TOLERANCE_MM = 5

function pointsMatch(a: Point, b: Point): boolean {
  return Math.abs(a.x - b.x) < ENDPOINT_TOLERANCE_MM && Math.abs(a.y - b.y) < ENDPOINT_TOLERANCE_MM
}


/**
 * Distance from point P to the BODY of a wall (the rectangle around the centreline AB,
 * `halfThicknessMm` thick on each side). Returns 0 if P is inside the rectangle, the
 * perpendicular shortfall if outside the long edges, or Infinity if P is COINCIDENT with
 * either endpoint (those are corner candidates, not T-junctions).
 *
 * Note: we only treat P as "near an endpoint" if the candidate point itself is close to
 * the endpoint, not just its projection. Otherwise the new "snap to centre of last block"
 * behaviour — which puts a butting wall's endpoint at the perpendicular face directly
 * opposite the through-wall's endpoint — would be excluded incorrectly.
 */
function distanceFromPointToWallBody(
  p: Point,
  a: Point,
  b: Point,
  halfThicknessMm: number
): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const lengthSq = dx * dx + dy * dy
  if (lengthSq < 0.001) return Infinity

  const length = Math.sqrt(lengthSq)
  const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq
  const distAlong = t * length

  // Only exclude points that are TRULY coincident with an endpoint of A→B (which would be
  // corner-detection candidates handled elsewhere). A point whose projection lands at the
  // endpoint but whose perpendicular distance is large is a legitimate T-junction onto
  // the wall's body and should NOT be excluded.
  if (distAlong < ENDPOINT_TOLERANCE_MM) {
    const dxToA = p.x - a.x
    const dyToA = p.y - a.y
    if (dxToA * dxToA + dyToA * dyToA < ENDPOINT_TOLERANCE_MM * ENDPOINT_TOLERANCE_MM) {
      return Infinity
    }
  }
  if (distAlong > length - ENDPOINT_TOLERANCE_MM) {
    const dxToB = p.x - b.x
    const dyToB = p.y - b.y
    if (dxToB * dxToB + dyToB * dyToB < ENDPOINT_TOLERANCE_MM * ENDPOINT_TOLERANCE_MM) {
      return Infinity
    }
  }
  // Also exclude projections that fall completely outside the segment (the point is
  // beyond either short end with no overlap with the wall body).
  if (distAlong < -ENDPOINT_TOLERANCE_MM || distAlong > length + ENDPOINT_TOLERANCE_MM) {
    return Infinity
  }

  const projX = a.x + t * dx
  const projY = a.y + t * dy
  const perpDist = Math.sqrt((p.x - projX) ** 2 + (p.y - projY) ** 2)
  // 0 if inside the rectangle; otherwise the perpendicular shortfall to the nearest face.
  return Math.max(0, perpDist - halfThicknessMm)
}

/**
 * If `point` lies on (or near) the body of any wall in `walls`, return that wall's id.
 * "On the body" means within the wall's rectangle (centreline ± halfThickness perpendicular,
 * between start/end along the centreline) plus a small face tolerance. Curves are skipped.
 */
function findWallWhoseBodyContains(
  point: Point,
  walls: Wall[],
  thicknessByWallId: Record<string, number>,
  excludeWallId?: string
): string | null {
  let bestId: string | null = null
  let bestDist = FACE_TOLERANCE_MM
  for (const wall of walls) {
    if (wall.id === excludeWallId) continue
    if (isCurvedWall(wall)) continue
    const halfThickness = (thicknessByWallId[wall.id] ?? 190) / 2
    const d = distanceFromPointToWallBody(
      point,
      { x: wall.startX, y: wall.startY },
      { x: wall.endX, y: wall.endY },
      halfThickness
    )
    if (d < bestDist) {
      bestDist = d
      bestId = wall.id
    }
  }
  return bestId
}

function addConnection(junction: WallJunction, otherWallId: string): WallJunction {
  const ids = junction.connectedWallIds ?? []
  if (ids.includes(otherWallId)) return junction
  return {
    type: 'corner',
    connectedWallIds: [...ids, otherWallId],
  }
}

/**
 * Returns the "corner candidate" position for one of a wall's endpoints — i.e. the
 * spot a new wall lands on when it snaps to that end to form an L corner.
 *
 * The drawing layer snaps a corner-forming click to the CENTRE of the existing wall's
 * end block (halfThickness in from the data endpoint, along the wall's own direction)
 * rather than to the data endpoint itself. That makes the two walls share a single
 * corner block cleanly, instead of overshooting it. But the new wall's stored endpoint
 * is then halfT inside the through-wall body, which strict-coordinate corner matching
 * doesn't see — it falls through to T-junction detection, which is the bug we hit.
 *
 * Always returning the inset point (regardless of the wall's current junction type) is
 * safe: for any wall whose end already participates in a corner, the partner wall's
 * data endpoint sits at exactly this inset point, so the existing direct-match path
 * keeps working too.
 */
function freeEndCornerPoint(
  wall: Wall,
  end: 'start' | 'end',
  halfThicknessMm: number
): Point {
  const dataX = end === 'start' ? wall.startX : wall.endX
  const dataY = end === 'start' ? wall.startY : wall.endY
  const farX = end === 'start' ? wall.endX : wall.startX
  const farY = end === 'start' ? wall.endY : wall.startY
  const dx = dataX - farX
  const dy = dataY - farY
  const len = Math.sqrt(dx * dx + dy * dy)
  if (len < 0.001) return { x: dataX, y: dataY }
  const offset = Math.min(halfThicknessMm, len)
  return {
    x: dataX - (dx / len) * offset,
    y: dataY - (dy / len) * offset,
  }
}

/**
 * Do `wallA.endA` and `wallB.endB` represent the same corner? Two endpoints corner
 * together when their data positions coincide, OR when one wall's data endpoint sits
 * at the other wall's inset "corner-block-centre" position (the drawing-time snap
 * target), OR when both walls' inset points coincide (when both ends were drawn with
 * the inset snap behaviour).
 */
function endpointsFormCorner(
  wallA: Wall,
  endA: 'start' | 'end',
  wallB: Wall,
  endB: 'start' | 'end',
  thicknessByWallId: Record<string, number>
): boolean {
  const aPoint = endA === 'start'
    ? { x: wallA.startX, y: wallA.startY }
    : { x: wallA.endX, y: wallA.endY }
  const bPoint = endB === 'start'
    ? { x: wallB.startX, y: wallB.startY }
    : { x: wallB.endX, y: wallB.endY }

  if (pointsMatch(aPoint, bPoint)) return true

  const halfA = (thicknessByWallId[wallA.id] ?? 190) / 2
  const halfB = (thicknessByWallId[wallB.id] ?? 190) / 2
  const aCornerPt = freeEndCornerPoint(wallA, endA, halfA)
  const bCornerPt = freeEndCornerPoint(wallB, endB, halfB)

  if (pointsMatch(aPoint, bCornerPt)) return true
  if (pointsMatch(bPoint, aCornerPt)) return true
  if (pointsMatch(aCornerPt, bCornerPt)) return true
  return false
}

/**
 * If `endpoint` lies STRICTLY INSIDE the body of another wall, return the perpendicular
 * face point on the side facing `oppositeEndpoint` (i.e. the side the new wall is coming
 * from). Otherwise return `endpoint` unchanged.
 *
 * Background: the wall-snap during drawing only fires when the cursor is within ~20px of
 * a face. On thick walls (e.g. 290 mm) clicking near the centreline puts you outside that
 * radius, so the cursor doesn't snap and the wall endpoint is stored at the click position
 * — typically halfThickness past the face. Visually the wall trims to the face (the
 * displayed length subtracts the T-junction overlap), but the underlying coordinates
 * say the wall is longer than it really is, which surfaces as confusing differences
 * between the on-screen length label and the centreline distance the rest of the app
 * sees.
 *
 * This helper pulls the endpoint back onto the face so stored coords = visual position.
 * The displayed length is unchanged: before-snap centrelineLen − halfT_other = after-snap
 * centrelineLen, and the T-junction overlap adjustment becomes 0.
 *
 * The face side is picked from the OTHER endpoint of the new wall — whichever face is
 * on that side of the through-wall is the one the new wall is approaching. If the other
 * endpoint sits on the through-wall's centreline (degenerate), we fall back to the
 * endpoint's own side, and ultimately to +N if everything is on the line.
 *
 * Curved walls are skipped (they snap at endpoints only, not their body).
 */
export function snapEndpointToThroughWallFace(
  endpoint: Point,
  oppositeEndpoint: Point,
  walls: Wall[],
  thicknessByWallId: Record<string, number>,
  excludeWallId?: string
): Point {
  for (const wall of walls) {
    if (wall.id === excludeWallId) continue
    if (isCurvedWall(wall)) continue
    const dx = wall.endX - wall.startX
    const dy = wall.endY - wall.startY
    const len2 = dx * dx + dy * dy
    if (len2 < 0.001) continue
    const len = Math.sqrt(len2)
    // Project endpoint onto the centreline as a parameter 0..1 along start→end.
    const t = ((endpoint.x - wall.startX) * dx + (endpoint.y - wall.startY) * dy) / len2
    // Ignore points whose projection falls past the ends — they're not "inside the body".
    if (t < 0 || t > 1) continue
    const projX = wall.startX + t * dx
    const projY = wall.startY + t * dy
    const perpDx = endpoint.x - projX
    const perpDy = endpoint.y - projY
    const perpDist = Math.sqrt(perpDx * perpDx + perpDy * perpDy)
    const halfT = (thicknessByWallId[wall.id] ?? 190) / 2
    // Only snap if STRICTLY inside (not already on or past a face). The 0.5 mm
    // slack keeps us from doing redundant work when the wall-snap during drawing
    // already deposited the endpoint exactly on the face.
    if (perpDist >= halfT - 0.5) continue
    // Skip the snap-to-face if the endpoint's projection sits within halfT of either
    // data endpoint along the centreline — that's the "centre of the corner block"
    // position the drawing-time snap deliberately puts a new wall at when it L-corners
    // onto a free end. Pulling those points sideways onto the perpendicular face would
    // convert a real corner into a T-junction and break corner detection downstream.
    const distAlongMm = t * len
    if (distAlongMm < halfT + ENDPOINT_TOLERANCE_MM) continue
    if (distAlongMm > len - halfT - ENDPOINT_TOLERANCE_MM) continue
    // Face side = the side the OTHER endpoint of the new wall lies on. If the
    // other endpoint is itself on the centreline, fall back to the endpoint's
    // own perpendicular sign; if that's also zero, default to +N.
    const nx = -dy / len
    const ny = dx / len
    const otherDot =
      (oppositeEndpoint.x - projX) * nx + (oppositeEndpoint.y - projY) * ny
    const ownDot = perpDx * nx + perpDy * ny
    const decisive =
      Math.abs(otherDot) > 0.001 ? otherDot : Math.abs(ownDot) > 0.001 ? ownDot : 1
    const sign = decisive >= 0 ? 1 : -1
    return {
      x: projX + sign * nx * halfT,
      y: projY + sign * ny * halfT,
    }
  }
  return endpoint
}

/**
 * Given a freshly-drawn wall and the list of existing walls (same page), produce:
 *   - The new wall with its start/end junctions tagged where corners are detected
 *   - The updated existing walls with their matching endpoints tagged as corners too
 */
export function detectJunctionsForNewWall(
  newWall: Wall,
  existingWalls: Wall[],
  thicknessByWallId: Record<string, number>
): { newWall: Wall; updatedExistingWalls: Wall[] } {
  let startJunction: WallJunction = { ...newWall.startJunction }
  let endJunction: WallJunction = { ...newWall.endJunction }

  const updatedById = new Map<string, Wall>()

  const newStart = { x: newWall.startX, y: newWall.startY }
  const newEnd = { x: newWall.endX, y: newWall.endY }

  for (const wall of existingWalls) {
    // newWall.start <-> wall.start
    if (endpointsFormCorner(newWall, 'start', wall, 'start', thicknessByWallId)) {
      startJunction = addConnection(startJunction, wall.id)
      const u = updatedById.get(wall.id) ?? { ...wall }
      u.startJunction = addConnection(u.startJunction, newWall.id)
      updatedById.set(wall.id, u)
    }
    // newWall.start <-> wall.end
    else if (endpointsFormCorner(newWall, 'start', wall, 'end', thicknessByWallId)) {
      startJunction = addConnection(startJunction, wall.id)
      const u = updatedById.get(wall.id) ?? { ...wall }
      u.endJunction = addConnection(u.endJunction, newWall.id)
      updatedById.set(wall.id, u)
    }

    // newWall.end <-> wall.start
    if (endpointsFormCorner(newWall, 'end', wall, 'start', thicknessByWallId)) {
      endJunction = addConnection(endJunction, wall.id)
      const u = updatedById.get(wall.id) ?? { ...wall }
      u.startJunction = addConnection(u.startJunction, newWall.id)
      updatedById.set(wall.id, u)
    }
    // newWall.end <-> wall.end
    else if (endpointsFormCorner(newWall, 'end', wall, 'end', thicknessByWallId)) {
      endJunction = addConnection(endJunction, wall.id)
      const u = updatedById.get(wall.id) ?? { ...wall }
      u.endJunction = addConnection(u.endJunction, newWall.id)
      updatedById.set(wall.id, u)
    }
  }

  // T-junction pass on the new wall's free endpoints against existing wall bodies.
  // (Corner detection has already run above, so only free endpoints reach this.)
  if (startJunction.type === 'free') {
    const through = findWallWhoseBodyContains(newStart, existingWalls, thicknessByWallId, newWall.id)
    if (through) {
      startJunction = { type: 't-junction', connectedWallIds: [through] }
    }
  }
  if (endJunction.type === 'free') {
    const through = findWallWhoseBodyContains(newEnd, existingWalls, thicknessByWallId, newWall.id)
    if (through) {
      endJunction = { type: 't-junction', connectedWallIds: [through] }
    }
  }

  return {
    newWall: { ...newWall, startJunction, endJunction },
    updatedExistingWalls: existingWalls.map((w) => updatedById.get(w.id) ?? w),
  }
}

/**
 * Recompute every wall's junction state from scratch based on the current set of walls.
 *
 * Used after edits (moving an endpoint, deleting a wall) to make sure no stale 'corner'
 * tags remain — if the endpoints no longer coincide, the junctions revert to 'free'.
 *
 * Control-joint tags are PRESERVED through this recompute: a control joint is a logical
 * marker chosen by the user (split a wall at this point) — the two halves' endpoints sit
 * at the same coordinates, which would otherwise be detected as a corner. Preserving the
 * tag lets the corner/T detection coexist with control-joint splits cleanly.
 */
export function recomputeAllJunctions(
  walls: Wall[],
  thicknessByWallId: Record<string, number>
): Wall[] {
  // Capture control-joint tags so they survive the reset-and-rederive cycle below.
  // A control joint exists at a point where two halves of a previously-single wall meet
  // — their endpoint coordinates are identical, so the naive corner pass would re-tag
  // them as 'corner'. We restore the control-joint tag at the end.
  const preservedControlJoints: Array<{
    wallId: string
    end: 'start' | 'end'
    junction: WallJunction
  }> = []
  for (const w of walls) {
    if (w.startJunction.type === 'control-joint') {
      preservedControlJoints.push({
        wallId: w.id,
        end: 'start',
        junction: { ...w.startJunction },
      })
    }
    if (w.endJunction.type === 'control-joint') {
      preservedControlJoints.push({
        wallId: w.id,
        end: 'end',
        junction: { ...w.endJunction },
      })
    }
  }

  // Reset everything to free first
  const reset: Wall[] = walls.map((w) => ({
    ...w,
    startJunction: { type: 'free' },
    endJunction: { type: 'free' },
  }))

  // Set of (wallId|end) strings that should NOT participate in corner detection — these
  // are endpoints that the user explicitly marked as control-joint splits.
  const skipCornerKeys = new Set(
    preservedControlJoints.map(({ wallId, end }) => `${wallId}|${end}`)
  )

  // Corners and T-junctions are derived from pure geometry below. No
  // collinear-butt auto-detection — if the user wants a control joint
  // they place one explicitly with the Control Joint tool, which splits
  // a wall in two and tags both halves' inner ends as 'control-joint'
  // (preserved through the reset above).

  // For every pair of walls, check all 4 endpoint combinations
  for (let i = 0; i < reset.length; i++) {
    for (let j = i + 1; j < reset.length; j++) {
      const a = reset[i]
      const b = reset[j]
      const aStartCJ = skipCornerKeys.has(`${a.id}|start`)
      const aEndCJ = skipCornerKeys.has(`${a.id}|end`)
      const bStartCJ = skipCornerKeys.has(`${b.id}|start`)
      const bEndCJ = skipCornerKeys.has(`${b.id}|end`)

      if (endpointsFormCorner(a, 'start', b, 'start', thicknessByWallId) && !aStartCJ && !bStartCJ) {
        a.startJunction = addConnection(a.startJunction, b.id)
        b.startJunction = addConnection(b.startJunction, a.id)
      }
      if (endpointsFormCorner(a, 'start', b, 'end', thicknessByWallId) && !aStartCJ && !bEndCJ) {
        a.startJunction = addConnection(a.startJunction, b.id)
        b.endJunction = addConnection(b.endJunction, a.id)
      }
      if (endpointsFormCorner(a, 'end', b, 'start', thicknessByWallId) && !aEndCJ && !bStartCJ) {
        a.endJunction = addConnection(a.endJunction, b.id)
        b.startJunction = addConnection(b.startJunction, a.id)
      }
      if (endpointsFormCorner(a, 'end', b, 'end', thicknessByWallId) && !aEndCJ && !bEndCJ) {
        a.endJunction = addConnection(a.endJunction, b.id)
        b.endJunction = addConnection(b.endJunction, a.id)
      }
    }
  }

  // No T-junction auto-detection. Free-end endpoints landing on another
  // wall's face stay 'free' — the face snap during drawing already put
  // them at the right position. Junction types are corner (endpoints
  // coincide), control-joint (placed explicitly via the tool), or free.

  // ----- Restore preserved control-joint tags -----
  // If the matching counterpart no longer exists (the other half was deleted), the tag
  // falls back to 'free' so the now-orphaned endpoint behaves like a normal free end.
  const byId = new Map(reset.map((w) => [w.id, w]))
  for (const cj of preservedControlJoints) {
    const wall = byId.get(cj.wallId)
    if (!wall) continue
    const otherId = cj.junction.connectedWallIds?.[0]
    const otherExists = otherId ? byId.has(otherId) : false
    const restored: WallJunction = otherExists
      ? cj.junction
      : { type: 'free' }
    if (cj.end === 'start') wall.startJunction = restored
    else wall.endJunction = restored
  }

  return reset
}

// ---------- Corner-point grouping ----------

export interface CornerPoint {
  /** Stringified mm coordinates used as a hash key. */
  key: string
  /** Real-world x in mm. */
  x: number
  /** Real-world y in mm. */
  y: number
  /** IDs of walls sharing this corner column. */
  wallIds: string[]
}

/**
 * Collect every unique corner — each is a set of walls that share a corner column.
 *
 * A corner pair is identified via `junction.connectedWallIds` rather than spatial coincidence
 * because the no-migration model has the two walls' corner endpoints at *different* positions
 * (each at the other's face or snap-centre, not on top of each other). Mutual references in
 * connectedWallIds tell us which walls are at the same physical corner.
 *
 * Returned corners are the basis for project-level adjustments — e.g. subtracting the
 * over-counted corner column from the project tally.
 *
 * `x`/`y` on the returned CornerPoint are the centreline-centreline intersection of the
 * first two walls in the corner group, useful for visualisation but not used by the dedup
 * itself (which only cares about `wallIds`).
 */
export function findCornerPoints(walls: Wall[]): CornerPoint[] {
  // Build a union-find-ish grouping. Each wall id can belong to one corner group keyed by
  // a canonical (sorted) id-set. Walk every corner-tagged endpoint, follow its connections
  // and merge into a single group.
  const wallToGroup = new Map<string, Set<string>>()

  function unite(a: string, b: string) {
    const ga = wallToGroup.get(a)
    const gb = wallToGroup.get(b)
    if (ga && gb) {
      if (ga === gb) return
      // Merge gb into ga
      for (const id of gb) {
        ga.add(id)
        wallToGroup.set(id, ga)
      }
    } else if (ga) {
      ga.add(b)
      wallToGroup.set(b, ga)
    } else if (gb) {
      gb.add(a)
      wallToGroup.set(a, gb)
    } else {
      const fresh = new Set([a, b])
      wallToGroup.set(a, fresh)
      wallToGroup.set(b, fresh)
    }
  }

  for (const wall of walls) {
    if (isCurvedWall(wall)) continue
    for (const junction of [wall.startJunction, wall.endJunction]) {
      if (junction.type !== 'corner') continue
      const connected = junction.connectedWallIds ?? []
      for (const otherId of connected) {
        // Confirm the other wall actually exists and references back (mutual). Avoids
        // stale connection ids hanging around if a wall was deleted.
        const other = walls.find((w) => w.id === otherId)
        if (!other || isCurvedWall(other)) continue
        const mutual =
          (other.startJunction.type === 'corner' &&
            other.startJunction.connectedWallIds?.includes(wall.id)) ||
          (other.endJunction.type === 'corner' &&
            other.endJunction.connectedWallIds?.includes(wall.id))
        if (!mutual) continue
        unite(wall.id, otherId)
      }
    }
  }

  // Deduplicate the groups (each Set was shared across all its members).
  const seenSets = new Set<Set<string>>()
  const result: CornerPoint[] = []
  for (const group of wallToGroup.values()) {
    if (seenSets.has(group)) continue
    seenSets.add(group)
    if (group.size < 2) continue
    const wallIds = Array.from(group).sort()
    // Pick a representative position: centreline-centreline intersection of the first two
    // walls (used for visualisation / debugging only — dedup math doesn't care).
    const a = walls.find((w) => w.id === wallIds[0])
    const b = walls.find((w) => w.id === wallIds[1])
    let x = a ? a.startX : 0
    let y = a ? a.startY : 0
    if (a && b) {
      const adx = a.endX - a.startX
      const ady = a.endY - a.startY
      const bdx = b.endX - b.startX
      const bdy = b.endY - b.startY
      const det = adx * -bdy - ady * -bdx
      if (Math.abs(det) > 1e-6) {
        const sdx = b.startX - a.startX
        const sdy = b.startY - a.startY
        const s = (-bdy * sdx - -bdx * sdy) / det
        x = a.startX + s * adx
        y = a.startY + s * ady
      }
    }
    result.push({ key: wallIds.join('|'), x, y, wallIds })
  }
  return result
}
