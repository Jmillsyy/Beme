/**
 * Lintel rules — pure functions implementing the rules from the Project Brief.
 *
 * Block walls: lintel blocks fill the head course above each opening. The
 * library stores each lintel's dimensions in the as-used orientation
 * (widthMm = horizontal face when placed, heightMm = vertical extent). No
 * rotation at calc time — Beme just uses width × height as stored and
 * tallies enough blocks to span (opening + bearing) horizontally × head
 * height vertically.
 *
 * Selection is by head height: pick the tallest lintel whose heightMm ≤
 * the opening's head height. Library can hold any number of lintels so
 * different head heights pick the appropriate block.
 *
 * Reference seed sizes (SEQ QLD):
 *   Head height       Lintel block   Dims (W × H × D)         Modular (W × H)
 *   ≥ 300mm           20.18          190 × 390 × 190 mm        200 × 400
 *   200 – 299mm       20.25          190 × 290 × 190 mm        200 × 300
 *   < 200mm           20.13          190 × 190 × 190 mm        200 × 200
 *
 * Brick walls: steel/concrete lintels calculated by opening width with a bearing rule.
 */

import type { BlockCode } from '../types/blocks'
import {
  pickLintelForHeadHeightIn,
  pickLintelBlockIn,
  BLOCK_LIBRARY,
  DEFAULT_BLOCK_LIBRARY,
} from '../data/blockLibrary'
import { DEFAULT_MORTAR_JOINT_MM } from '../types/blocks'

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
 *
 * Role-based: looks up every block tagged with role `lintel` and picks the
 * SMALLEST one whose heightMm ≥ the head height. The lintel has to bridge
 * the entire head — a 290 mm lintel over a 310 mm head leaves a 20 mm gap,
 * which doesn't work — so a 20.25 wouldn't be valid there; you'd use a
 * 20.18 instead. If no lintel is tall enough on its own, the tallest is
 * returned so the calc engine can stack it vertically to cover.
 *
 * Modular dims are derived from the block's actual dimensions + mortar
 * joint — since the library stores dimensions in the as-used orientation,
 * heightMm IS the vertical module driver and widthMm IS the horizontal
 * one. No flipping.
 *
 * Falls back to the SEQ defaults if the user's library has no lintel blocks
 * defined — keeps existing AU projects unchanged.
 */
export function selectBlockLintel(headHeightMm: number): LintelSpec {
  // 1) Region-agnostic primary path: pick by lintelMinHeadHeightMm /
  //    lintelMaxHeadHeightMm bucket metadata, so each region's library
  //    can carry its own head-height thresholds. AU SEQ 20.13 / 20.25 /
  //    20.18 are tagged 0–200 / 200–300 / 300+ in the seed library.
  let block =
    pickLintelForHeadHeightIn(BLOCK_LIBRARY, headHeightMm) ??
    // 2) Older lintels without bucket metadata — fall back to the
    //    height-based selector (smallest block whose face height ≥ head).
    pickLintelBlockIn(BLOCK_LIBRARY, headHeightMm)

  if (!block) {
    // 3) Library has no lintel blocks at all — fall back to the SEQ
    //    default library so older AU projects opened against a stripped
    //    library still report sensibly.
    block =
      pickLintelForHeadHeightIn(DEFAULT_BLOCK_LIBRARY, headHeightMm) ??
      pickLintelBlockIn(DEFAULT_BLOCK_LIBRARY, headHeightMm)
  }

  if (block) {
    return {
      code: block.code,
      verticalModuleMm: block.dimensions.heightMm + DEFAULT_MORTAR_JOINT_MM,
      horizontalModuleMm: block.dimensions.widthMm + DEFAULT_MORTAR_JOINT_MM,
    }
  }

  // 4) Ultimate fallback — even the seed library was empty. Hardcoded
  //    SEQ values matching the original brief so the engine never
  //    crashes on a totally-empty library state.
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
