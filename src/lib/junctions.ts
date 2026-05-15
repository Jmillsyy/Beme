/**
 * Junction detection for newly drawn walls.
 *
 * When a wall is created and one of its endpoints is at an existing wall's endpoint
 * (within a small tolerance), both walls' junctions at that shared point are tagged
 * as 'corner' and reference each other's wall id. This drives the corner-substitution
 * rule from the brief (in stretcher bond, 20.03 halves at the corner are replaced
 * with full 20.01 blocks every course).
 */

import type { JunctionType, Wall, WallJunction } from '../types/walls'

interface Point {
  x: number
  y: number
}

/** mm tolerance for matching endpoint coordinates (after snap, they should be effectively identical). */
const ENDPOINT_TOLERANCE_MM = 0.5

function pointsMatch(a: Point, b: Point): boolean {
  return Math.abs(a.x - b.x) < ENDPOINT_TOLERANCE_MM && Math.abs(a.y - b.y) < ENDPOINT_TOLERANCE_MM
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
 * Given a freshly-drawn wall and the list of existing walls (same page), produce:
 *   - The new wall with its start/end junctions tagged where corners are detected
 *   - The updated existing walls with their matching endpoints tagged as corners too
 */
export function detectJunctionsForNewWall(
  newWall: Wall,
  existingWalls: Wall[]
): { newWall: Wall; updatedExistingWalls: Wall[] } {
  let startJunction: WallJunction = { ...newWall.startJunction }
  let endJunction: WallJunction = { ...newWall.endJunction }

  const updatedById = new Map<string, Wall>()

  const newStart = { x: newWall.startX, y: newWall.startY }
  const newEnd = { x: newWall.endX, y: newWall.endY }

  for (const wall of existingWalls) {
    const wallStart = { x: wall.startX, y: wall.startY }
    const wallEnd = { x: wall.endX, y: wall.endY }

    // newWall.start <-> wall.start
    if (pointsMatch(newStart, wallStart)) {
      startJunction = addConnection(startJunction, wall.id)
      const u = updatedById.get(wall.id) ?? { ...wall }
      u.startJunction = addConnection(u.startJunction, newWall.id)
      updatedById.set(wall.id, u)
    }
    // newWall.start <-> wall.end
    else if (pointsMatch(newStart, wallEnd)) {
      startJunction = addConnection(startJunction, wall.id)
      const u = updatedById.get(wall.id) ?? { ...wall }
      u.endJunction = addConnection(u.endJunction, newWall.id)
      updatedById.set(wall.id, u)
    }

    // newWall.end <-> wall.start
    if (pointsMatch(newEnd, wallStart)) {
      endJunction = addConnection(endJunction, wall.id)
      const u = updatedById.get(wall.id) ?? { ...wall }
      u.startJunction = addConnection(u.startJunction, newWall.id)
      updatedById.set(wall.id, u)
    }
    // newWall.end <-> wall.end
    else if (pointsMatch(newEnd, wallEnd)) {
      endJunction = addConnection(endJunction, wall.id)
      const u = updatedById.get(wall.id) ?? { ...wall }
      u.endJunction = addConnection(u.endJunction, newWall.id)
      updatedById.set(wall.id, u)
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
 */
export function recomputeAllJunctions(walls: Wall[]): Wall[] {
  // Reset everything to free first
  const reset: Wall[] = walls.map((w) => ({
    ...w,
    startJunction: { type: 'free' },
    endJunction: { type: 'free' },
  }))

  // For every pair of walls, check all 4 endpoint combinations
  for (let i = 0; i < reset.length; i++) {
    for (let j = i + 1; j < reset.length; j++) {
      const a = reset[i]
      const b = reset[j]
      const aStart = { x: a.startX, y: a.startY }
      const aEnd = { x: a.endX, y: a.endY }
      const bStart = { x: b.startX, y: b.startY }
      const bEnd = { x: b.endX, y: b.endY }

      if (pointsMatch(aStart, bStart)) {
        a.startJunction = addConnection(a.startJunction, b.id)
        b.startJunction = addConnection(b.startJunction, a.id)
      }
      if (pointsMatch(aStart, bEnd)) {
        a.startJunction = addConnection(a.startJunction, b.id)
        b.endJunction = addConnection(b.endJunction, a.id)
      }
      if (pointsMatch(aEnd, bStart)) {
        a.endJunction = addConnection(a.endJunction, b.id)
        b.startJunction = addConnection(b.startJunction, a.id)
      }
      if (pointsMatch(aEnd, bEnd)) {
        a.endJunction = addConnection(a.endJunction, b.id)
        b.endJunction = addConnection(b.endJunction, a.id)
      }
    }
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

function positionKey(x: number, y: number): string {
  // Round to nearest 0.1mm for hashing (avoids floating-point near-misses)
  return `${Math.round(x * 10) / 10},${Math.round(y * 10) / 10}`
}

/**
 * Collect every unique point where multiple walls meet at a corner.
 *
 * A corner is detected when 2+ walls have a corner-tagged endpoint at the same position.
 * Returned corners are the basis for project-level adjustments — e.g. subtracting the
 * over-counted corner column from the project tally.
 */
export function findCornerPoints(walls: Wall[]): CornerPoint[] {
  const groups = new Map<string, CornerPoint>()

  function record(x: number, y: number, wallId: string, type: JunctionType) {
    if (type !== 'corner') return
    const key = positionKey(x, y)
    let g = groups.get(key)
    if (!g) {
      g = { key, x, y, wallIds: [] }
      groups.set(key, g)
    }
    if (!g.wallIds.includes(wallId)) g.wallIds.push(wallId)
  }

  for (const wall of walls) {
    record(wall.startX, wall.startY, wall.id, wall.startJunction.type)
    record(wall.endX, wall.endY, wall.id, wall.endJunction.type)
  }

  return Array.from(groups.values()).filter((g) => g.wallIds.length >= 2)
}
