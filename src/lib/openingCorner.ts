/**
 * "Opening hard against a corner" detection.
 *
 * When an opening is placed right at a corner - close enough that only the
 * corner block (no full body block) fits between the corner and the opening
 * jamb - the wall can't actually turn the corner on that side. It ends like
 * an OPEN END at the opening (alternating full / half blocks), and the
 * PERPENDICULAR wall carries the corner instead. This module just answers
 * the geometric question "is an opening hard against this end?"; the bond /
 * ownership consequences are wired in by the callers (the 3D builder, the
 * tally's corner-ownership, and the export).
 *
 * All distances are CENTRELINE mm along the wall - the same basis
 * opening.startAlongWallMm uses.
 */

import type { Wall } from '../types/walls'
import { DEFAULT_MORTAR_JOINT_MM } from '../types/blocks'

export interface OpeningSpan {
  startAlongWallMm: number
  widthMm: number
}

/**
 * True when some opening's near jamb sits within `thresholdMm` of the given
 * wall end. The caller passes a threshold big enough to mean "no full body
 * block fits between the corner block and the opening" - typically the
 * corner-block module plus part of a body block.
 */
export function openingHardAgainstEnd(
  end: 'start' | 'end',
  wallLengthMm: number,
  openings: OpeningSpan[],
  thresholdMm: number,
): boolean {
  for (const o of openings) {
    if (end === 'start') {
      if (o.startAlongWallMm <= thresholdMm) return true
    } else if (o.startAlongWallMm + o.widthMm >= wallLengthMm - thresholdMm) {
      return true
    }
  }
  return false
}

/**
 * Whether a wall's CORNER end should be demoted to an open end because an
 * opening sits hard against it. Only a real corner can be demoted - a free
 * end is already open and a T-junction butts into a face. The threshold is
 * the corner-block module along this wall: the PERPENDICULAR wall's
 * thickness (what sets the corner-section depth) plus a mortar joint. An
 * opening whose near jamb falls inside that has only the corner block
 * between it and the corner, so the corner can't be turned here.
 *
 * Note on bases: opening.startAlongWallMm and the wall length are centreline
 * mm; the corner module is a face figure. They aren't the same basis, but
 * the corner-block edge always lands at a smaller centreline value than the
 * module, and the next block grid lands past it, so the simple "< module"
 * test cleanly separates "right at the corner" from "a block in".
 */
export function isWallEndHardAgainstCorner(
  wall: Wall,
  end: 'start' | 'end',
  openingsForWall: OpeningSpan[],
  thicknessByWallId: Record<string, number>,
): boolean {
  const j = end === 'start' ? wall.startJunction : wall.endJunction
  if (j.type !== 'corner') return false
  const otherId = j.connectedWallIds?.[0]
  const perpThickness = otherId ? thicknessByWallId[otherId] : undefined
  if (!perpThickness || perpThickness <= 0) return false
  const cornerModuleMm = perpThickness + DEFAULT_MORTAR_JOINT_MM
  const wallLengthMm = Math.hypot(
    wall.endX - wall.startX,
    wall.endY - wall.startY,
  )
  return openingHardAgainstEnd(end, wallLengthMm, openingsForWall, cornerModuleMm)
}
