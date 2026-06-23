/**
 * Wall-footprint geometry - the physical rectangle a straight wall occupies
 * on plan, with its corner / T-junction ends mitred or trimmed so adjacent
 * walls tile into clean Ls and Ts instead of overlapping rectangles.
 *
 * This is the SAME geometry the live 2D canvas (WallDrawingLayer) uses to
 * draw wall bodies; it's lifted here so the PDF export's layout diagram can
 * render walls identically - the user expects the exported plan to look like
 * the on-screen plan, mitred corners and all, not a pile of overlapping
 * boxes.
 *
 * Everything is in real-world MILLIMETRES (wall.startX/startY/… are mm), so
 * callers in either pixel space (multiply by a mm→px scale) or mm space (the
 * export, whose SVG user units ARE mm) can consume the points directly.
 *
 * NOTE: WallDrawingLayer still carries an inline twin of these helpers. The
 * two are intentionally identical; this module is the canonical home and the
 * canvas copy should fold into it in a later cleanup. Keep them in sync until
 * then.
 */

import type { Wall } from '../types/walls'
import { isCurvedWall } from './curveGeom'

export interface Point {
  x: number
  y: number
}

/** A 2D line in point-and-direction form. */
interface LineMm {
  px: number
  py: number
  dx: number
  dy: number
}

/**
 * Intersection point of two lines (each given as a point + direction).
 * Returns null if the lines are parallel (no unique intersection).
 */
function intersectLinesMm(l1: LineMm, l2: LineMm): Point | null {
  const det = l1.dx * -l2.dy - l1.dy * -l2.dx
  if (Math.abs(det) < 1e-6) return null
  const dx = l2.px - l1.px
  const dy = l2.py - l1.py
  const s = (-l2.dy * dx - -l2.dx * dy) / det
  return { x: l1.px + s * l1.dx, y: l1.py + s * l1.dy }
}

/**
 * Compute the two long face lines of a straight wall (each as a LineMm).
 * - posFace is on the +N side (perpendicular rotated 90° CCW from wall dir).
 * - negFace is on the -N side.
 */
function wallFaceLines(
  wall: Wall,
  thicknessMm: number
): { posFace: LineMm; negFace: LineMm } | null {
  const dx = wall.endX - wall.startX
  const dy = wall.endY - wall.startY
  const len = Math.sqrt(dx * dx + dy * dy)
  if (len === 0) return null
  const ux = dx / len
  const uy = dy / len
  const nx = -uy
  const ny = ux
  const half = thicknessMm / 2
  return {
    posFace: { px: wall.startX + nx * half, py: wall.startY + ny * half, dx: ux, dy: uy },
    negFace: { px: wall.startX - nx * half, py: wall.startY - ny * half, dx: ux, dy: uy },
  }
}

/**
 * For a wall with a 'corner' junction endpoint, compute the two mitred
 * polygon-corner points so the wall tiles cleanly into an L with the
 * connected wall. "Appropriate" face is decided by the angle bisector at the
 * corner - inner face meets inner face, outer meets outer - giving two points
 * forming a diagonal across the wall at the corner end that BOTH walls'
 * polygons share. Returns null on degenerate geometry.
 */
export function mitredCornerPointsMm(
  wall: Wall,
  end: 'start' | 'end',
  walls: Wall[],
  thicknessByWallId: Record<string, number>
): { posCorner: Point; negCorner: Point } | null {
  const junction = end === 'start' ? wall.startJunction : wall.endJunction
  if (junction.type !== 'corner') return null
  const otherId = junction.connectedWallIds?.[0]
  if (!otherId) return null
  const other = walls.find((w) => w.id === otherId)
  if (!other || isCurvedWall(other)) return null

  const wallThickness = thicknessByWallId[wall.id] ?? 190
  const otherThickness = thicknessByWallId[otherId] ?? 190
  const wallFaces = wallFaceLines(wall, wallThickness)
  const otherFaces = wallFaceLines(other, otherThickness)
  if (!wallFaces || !otherFaces) return null

  // Intersections of all 4 face combinations.
  const i_pp = intersectLinesMm(wallFaces.posFace, otherFaces.posFace)
  const i_pn = intersectLinesMm(wallFaces.posFace, otherFaces.negFace)
  const i_np = intersectLinesMm(wallFaces.negFace, otherFaces.posFace)
  const i_nn = intersectLinesMm(wallFaces.negFace, otherFaces.negFace)
  if (!i_pp || !i_pn || !i_np || !i_nn) return null

  // Determine which end of OTHER is the corner end by following
  // connectedWallIds back to THIS wall (not by comparing positions - the
  // "preserve wall length" model leaves the two corner endpoints at
  // different positions on each other's faces).
  const otherStartIsCornerHere =
    other.startJunction.type === 'corner' &&
    (other.startJunction.connectedWallIds?.includes(wall.id) ?? false)
  const otherEndIsCornerHere =
    other.endJunction.type === 'corner' &&
    (other.endJunction.connectedWallIds?.includes(wall.id) ?? false)
  if (!otherStartIsCornerHere && !otherEndIsCornerHere) return null
  // OTHER's "far" direction = from the corner end toward the opposite end.
  const otherDirX = otherStartIsCornerHere
    ? other.endX - other.startX
    : other.startX - other.endX
  const otherDirY = otherStartIsCornerHere
    ? other.endY - other.startY
    : other.startY - other.endY
  const otherDirLen = Math.sqrt(otherDirX * otherDirX + otherDirY * otherDirY)
  if (otherDirLen === 0) return null
  const ubX = otherDirX / otherDirLen
  const ubY = otherDirY / otherDirLen

  // u_a: from this corner end toward this wall's far end.
  const wallDirX = end === 'start' ? wall.endX - wall.startX : wall.startX - wall.endX
  const wallDirY = end === 'start' ? wall.endY - wall.startY : wall.startY - wall.endY
  const wallDirLen = Math.sqrt(wallDirX * wallDirX + wallDirY * wallDirY)
  if (wallDirLen === 0) return null
  const uaX = wallDirX / wallDirLen
  const uaY = wallDirY / wallDirLen

  // Angle bisector - direction the inner-of-L points.
  const bisectorX = uaX + ubX
  const bisectorY = uaY + ubY
  const bLen = Math.sqrt(bisectorX * bisectorX + bisectorY * bisectorY)
  if (bLen < 1e-6) return null // walls are anti-parallel - no L
  const bX = bisectorX / bLen
  const bY = bisectorY / bLen

  // For each wall, +N is "inner" if it points along the bisector.
  const wdx = wall.endX - wall.startX
  const wdy = wall.endY - wall.startY
  const wlen = Math.sqrt(wdx * wdx + wdy * wdy)
  const wnx = -wdy / wlen
  const wny = wdx / wlen
  const odx = other.endX - other.startX
  const ody = other.endY - other.startY
  const olen = Math.sqrt(odx * odx + ody * ody)
  const onx = -ody / olen
  const ony = odx / olen
  const wallPosIsInner = wnx * bX + wny * bY > 0
  const otherPosIsInner = onx * bX + ony * bY > 0

  // Inner corner = intersection of inner faces. Outer = intersection of outer.
  const innerCorner = wallPosIsInner
    ? otherPosIsInner
      ? i_pp
      : i_pn
    : otherPosIsInner
      ? i_np
      : i_nn
  const outerCorner = wallPosIsInner
    ? otherPosIsInner
      ? i_nn
      : i_np
    : otherPosIsInner
      ? i_pn
      : i_pp

  return wallPosIsInner
    ? { posCorner: innerCorner, negCorner: outerCorner }
    : { posCorner: outerCorner, negCorner: innerCorner }
}

/**
 * For a stem wall with a t-junction endpoint, find where the stem's
 * centreline crosses the through-wall's NEAR FACE - that's where the
 * rendered rectangle should end. Clamped to [0,1] so it never extends past
 * the original endpoint or wraps beyond the stem's far end.
 */
export function trimmedEndpointMm(
  wall: Wall,
  end: 'start' | 'end',
  walls: Wall[],
  thicknessByWallId: Record<string, number>
): Point {
  const original: Point =
    end === 'start'
      ? { x: wall.startX, y: wall.startY }
      : { x: wall.endX, y: wall.endY }
  const junction = end === 'start' ? wall.startJunction : wall.endJunction
  if (junction.type !== 't-junction') return original
  const throughId = junction.connectedWallIds?.[0]
  if (!throughId) return original
  const through = walls.find((w) => w.id === throughId)
  if (!through || isCurvedWall(through)) return original

  const farEnd: Point =
    end === 'start'
      ? { x: wall.endX, y: wall.endY }
      : { x: wall.startX, y: wall.startY }

  // Through-wall direction & normal.
  const tdx = through.endX - through.startX
  const tdy = through.endY - through.startY
  const tLen = Math.sqrt(tdx * tdx + tdy * tdy)
  if (tLen === 0) return original
  const nDirX = -tdy / tLen
  const nDirY = tdx / tLen

  // Which side of the through-wall the stem sits on (far endpoint as ref).
  const signedPerp =
    (farEnd.x - through.startX) * nDirX + (farEnd.y - through.startY) * nDirY
  const side = signedPerp >= 0 ? 1 : -1

  const throughHalfThickness = (thicknessByWallId[throughId] ?? 190) / 2

  // A point on the through-wall's near face (the face on the stem's side).
  const facePtX = through.startX + side * throughHalfThickness * nDirX
  const facePtY = through.startY + side * throughHalfThickness * nDirY

  // Find s where the stem's centreline crosses the face line.
  const alpha = (farEnd.x - facePtX) * nDirX + (farEnd.y - facePtY) * nDirY
  const beta = (original.x - farEnd.x) * nDirX + (original.y - farEnd.y) * nDirY
  if (Math.abs(beta) < 0.001) return original // stem parallel to through-wall

  const s = Math.max(0, Math.min(1, -alpha / beta))
  return {
    x: farEnd.x + s * (original.x - farEnd.x),
    y: farEnd.y + s * (original.y - farEnd.y),
  }
}

/**
 * The four corner points (mm) of a straight wall's physical footprint, in
 * order [startPos, endPos, endNeg, startNeg] so they close into a polygon.
 * Corner-junction ends are mitred into the adjacent wall, t-junction ends are
 * trimmed to the through-wall's near face, free ends are square (butt).
 *
 * Returns null for curved or zero-length walls - callers handle those (e.g.
 * the export samples curves into a polyline separately).
 */
export function straightWallFootprintMm(
  wall: Wall,
  walls: Wall[],
  thicknessByWallId: Record<string, number>
): [Point, Point, Point, Point] | null {
  if (isCurvedWall(wall)) return null
  const thicknessMm = thicknessByWallId[wall.id] ?? 190
  const dx = wall.endX - wall.startX
  const dy = wall.endY - wall.startY
  const wlen = Math.sqrt(dx * dx + dy * dy)
  if (wlen === 0) return null
  const nx = -dy / wlen
  const ny = dx / wlen
  const half = thicknessMm / 2

  let startPos: Point
  let startNeg: Point
  if (wall.startJunction.type === 'corner') {
    const m = mitredCornerPointsMm(wall, 'start', walls, thicknessByWallId)
    if (m) {
      startPos = m.posCorner
      startNeg = m.negCorner
    } else {
      startPos = { x: wall.startX + nx * half, y: wall.startY + ny * half }
      startNeg = { x: wall.startX - nx * half, y: wall.startY - ny * half }
    }
  } else {
    const trim =
      wall.startJunction.type === 't-junction'
        ? trimmedEndpointMm(wall, 'start', walls, thicknessByWallId)
        : { x: wall.startX, y: wall.startY }
    startPos = { x: trim.x + nx * half, y: trim.y + ny * half }
    startNeg = { x: trim.x - nx * half, y: trim.y - ny * half }
  }

  let endPos: Point
  let endNeg: Point
  if (wall.endJunction.type === 'corner') {
    const m = mitredCornerPointsMm(wall, 'end', walls, thicknessByWallId)
    if (m) {
      endPos = m.posCorner
      endNeg = m.negCorner
    } else {
      endPos = { x: wall.endX + nx * half, y: wall.endY + ny * half }
      endNeg = { x: wall.endX - nx * half, y: wall.endY - ny * half }
    }
  } else {
    const trim =
      wall.endJunction.type === 't-junction'
        ? trimmedEndpointMm(wall, 'end', walls, thicknessByWallId)
        : { x: wall.endX, y: wall.endY }
    endPos = { x: trim.x + nx * half, y: trim.y + ny * half }
    endNeg = { x: trim.x - nx * half, y: trim.y - ny * half }
  }

  return [startPos, endPos, endNeg, startNeg]
}
