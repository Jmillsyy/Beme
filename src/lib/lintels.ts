/**
 * Lintel rules — pure functions implementing the rules from the Project Brief.
 *
 * Block walls: a lintel is any block in the user's library that the user
 * has tagged with the `lintel` role. There's no separate concept of a
 * "lintel block" any more — a 20.13, a 20.18, a bond beam, or even a
 * regular body block can serve as a lintel just by adding the role.
 *
 * Selection is by head height: pick the SMALLEST lintel whose heightMm ≥
 * the opening's head height (so the head course is fully bridged). If no
 * single lintel is tall enough, the tallest is returned and the calc
 * engine stacks it vertically to cover.
 *
 * If the library has NO block with the lintel role at all, no lintel
 * block is added to the tally and the head course is simply left empty.
 * (The body subtraction below the head still runs, so the wall maths
 * remains correct.) Users in regions that bridge openings with a separate
 * structural lintel beam can leave the role off and the schedule won't
 * include any block-level lintels.
 *
 * Brick walls: handled separately via per-opening supply items.
 */

import {
  pickLintelForHeadHeightIn,
  pickLintelBlockIn,
  BLOCK_LIBRARY,
} from '../data/blockLibrary'
import { DEFAULT_MORTAR_JOINT_MM } from '../types/blocks'

// ---------- Block walls: lintel spec by head height ----------

export interface LintelSpec {
  /** Block code used for this head range — references the user's library. */
  code: string
  /** Modular vertical height per stood-up lintel (block tall dim + 10mm mortar). */
  verticalModuleMm: number
  /** Modular horizontal face per stood-up lintel (190mm face + 10mm mortar = 200). */
  horizontalModuleMm: number
  /**
   * Bearing length on each side of the opening, in mm. The calc engine
   * computes the lintel span as `openingWidth + 2 × overhangMm`. Comes
   * from the block's `lintelOverhangMm` field; defaults to 200mm when
   * the block doesn't set it (standard AU masonry practice). Per-block
   * so different lintels (e.g. a precast piece vs a masonry block) can
   * carry their own bearing requirements.
   */
  overhangMm: number
}

/**
 * Choose the appropriate lintel for an opening's head height. Returns
 * `null` when no block in the user's library is tagged with the `lintel`
 * role — callers treat that as "head course left empty, no lintel
 * blocks added to tally".
 *
 * Role-based: looks up every block tagged with role `lintel` and picks
 * by head-height bucket if the block carries one, else by the smallest
 * block whose face height ≥ the head. There's no AU-default fallback —
 * an empty / non-AU library that never tagged a lintel block produces a
 * null result, not a phantom 20.18 in the schedule.
 *
 * Modular dims come from the block's actual dimensions + mortar joint —
 * since the library stores dimensions in the as-used orientation,
 * heightMm IS the vertical module driver and widthMm IS the horizontal
 * one. No flipping.
 */
export function selectBlockLintel(headHeightMm: number): LintelSpec | null {
  // Region-agnostic primary path: pick by lintelMinHeadHeightMm /
  // lintelMaxHeadHeightMm bucket metadata. Falls through to height-based
  // selection for lintel blocks without bucket metadata yet.
  const block =
    pickLintelForHeadHeightIn(BLOCK_LIBRARY, headHeightMm) ??
    pickLintelBlockIn(BLOCK_LIBRARY, headHeightMm)

  if (!block) return null

  return {
    code: block.code,
    verticalModuleMm: block.dimensions.heightMm + DEFAULT_MORTAR_JOINT_MM,
    horizontalModuleMm: block.dimensions.widthMm + DEFAULT_MORTAR_JOINT_MM,
    // Pull the per-block bearing override; default 200mm matches the
    // historic constant that lived in blockCalc.ts. Users in regions
    // with different conventions set lintelOverhangMm on their lintel
    // blocks in the library editor.
    overhangMm: block.lintelOverhangMm ?? 200,
  }
}

// Brick-lintel bearing rules previously lived here as
// brickLintelBearingMm + brickLintelTotalLengthMm. They were AU-specific
// (Galintel catalogue, 100/150/200mm bearings) and have been replaced
// by per-opening supply items with optional opening-width ranges (see
// SupplyItem.openingWidthMinMm / openingWidthMaxMm). Users define
// their own lintels in the material library now.
