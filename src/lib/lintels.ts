/**
 * Lintel rules — pure functions implementing the rules from the Project Brief.
 *
 * Block walls: lintel blocks stood UPWARDS over the opening. Type chosen by head height
 *   (height of wall above the opening). Multiple stood-up lintels are placed side by side
 *   horizontally (each 200mm modular wide) to span the opening + bearing, and stacked
 *   vertically to fill tall heads.
 *
 *   Head height       Lintel block   Stood-up dims (face × tall)   Modular (W × H)
 *   ≥ 300mm           20.18          190 × 390 mm                  200 × 400
 *   200 – 299mm       20.25          190 × 290 mm                  200 × 300
 *   < 200mm           20.13          190 × 190 mm                  200 × 200
 *
 * Brick walls: steel/concrete lintels calculated by opening width with a bearing rule.
 */

import type { BlockCode } from '../types/blocks'

// ---------- Block walls: lintel spec by head height ----------

export interface LintelSpec {
  /** Block code used for this head range. */
  code: BlockCode
  /** Modular vertical height per stood-up lintel (block tall dim + 10mm mortar). */
  verticalModuleMm: number
  /** Modular horizontal face per stood-up lintel (190mm face + 10mm mortar = 200). */
  horizontalModuleMm: number
}

/**
 * Choose the appropriate lintel for an opening's head height.
 * Returns the block code AND its modular dimensions so the calculation engine can compute
 * vertical (stacking) and horizontal (span) counts.
 */
export function selectBlockLintel(headHeightMm: number): LintelSpec {
  if (headHeightMm >= 300) {
    return { code: '20.18', verticalModuleMm: 400, horizontalModuleMm: 200 }
  }
  if (headHeightMm >= 200) {
    return { code: '20.25', verticalModuleMm: 300, horizontalModuleMm: 200 }
  }
  return { code: '20.13', verticalModuleMm: 200, horizontalModuleMm: 200 }
}

// ---------- Brick walls: bearing rule by opening width ----------

/**
 * Bearing (lintel overlap) on EACH side of a brick-wall opening:
 *   - opening ≤ 800mm       → 100mm each side
 *   - 800 < opening ≤ 4000  → 150mm each side
 *   - opening > 4000mm      → 200mm each side
 */
export function brickLintelBearingMm(openingWidthMm: number): number {
  if (openingWidthMm <= 800) return 100
  if (openingWidthMm <= 4000) return 150
  return 200
}

/** Total brick-wall lintel length: opening width + bearing on both sides. */
export function brickLintelTotalLengthMm(openingWidthMm: number): number {
  return openingWidthMm + 2 * brickLintelBearingMm(openingWidthMm)
}
