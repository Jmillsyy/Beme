/**
 * Lintel rules — pure functions implementing the rules from the Project Brief.
 *
 * Block walls use lintel BLOCKS (Section 4.8 of the brief).
 * Brick walls use lintels (steel/concrete) calculated by opening width
 * with a bearing rule (Section 3.4 of the brief).
 */

import type { BlockCode } from '../types/blocks'

// ---------- Block walls: lintel block selection by head height ----------

/**
 * Selects the appropriate lintel block for a block wall based on the opening's
 * head height (the space between the top of the opening and the wall top).
 *
 * Rules (from brief Section 4.8):
 *   - head height > 300mm           → 20.18 (stacked vertically across opening)
 *   - head height 190mm – 290mm     → 20.25
 *   - head height ~200mm flat       → 20.12 (uncommon)
 */
export function selectBlockLintel(headHeightMm: number): BlockCode {
  if (headHeightMm > 300) return '20.18'
  if (headHeightMm >= 190 && headHeightMm <= 290) return '20.25'
  return '20.12'
}

// ---------- Brick walls: bearing rule by opening width ----------

/**
 * Returns the required bearing (lintel overlap) on EACH side of a brick-wall
 * opening, given the opening width.
 *
 * Rules (from brief Section 3.4):
 *   - opening ≤ 800mm              → 100mm each side
 *   - 800 < opening ≤ 4000mm       → 150mm each side
 *   - opening > 4000mm             → 200mm each side
 */
export function brickLintelBearingMm(openingWidthMm: number): number {
  if (openingWidthMm <= 800) return 100
  if (openingWidthMm <= 4000) return 150
  return 200
}

/**
 * Total length of the brick-wall lintel required to span an opening, including
 * bearing on both sides.
 */
export function brickLintelTotalLengthMm(openingWidthMm: number): number {
  return openingWidthMm + 2 * brickLintelBearingMm(openingWidthMm)
}
