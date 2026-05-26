/**
 * Brick estimate calculation engine.
 *
 * Brick estimates are simpler than block — there's no bond pattern, no end terminations,
 * no fraction maths. We just count brickwork m², subtract opening areas, apply a "bricks
 * per m²" rate, and add ties / plascourse / lintels according to the brief's rules.
 */

import type { BrickSettings, Opening, Wall } from '../types/walls'
import { BRICK_LIBRARY } from '../data/brickLibrary'
import { getUserSettings } from './userSettings'

// ---------- Brick tally ----------
//
// Lintels used to be a first-class concept in this tally, with a
// hardcoded AU Galintel catalogue + bearing rules. The catalogue
// didn't fit US (steel angles) or UK (concrete + IG) construction,
// so lintels now live as PER-OPENING supply items the user defines
// in the material library with an optional opening-width range
// (see SupplyItem.openingWidthMinMm / openingWidthMaxMm). The brick
// export + brick tally tally those supply items per opening the
// same way they tally ties and flashings.

export interface BrickTally {
  /** Number of walls drawn. */
  wallCount: number
  /** Number of openings placed. */
  openingCount: number
  /** Total wall lineal length (mm). */
  totalLinealMm: number
  /** Total brickwork face area in mm² (sum of wall area minus all opening areas, clamped at 0). */
  totalAreaSqMm: number
  /** Number of face bricks (areaSqM × bricksPerSquareMetre, rounded up). */
  brickCount: number
  /** Total brick ties (if enabled), else 0. */
  tiesCount: number
  /** Total plascourse units (if enabled), else 0. */
  plascourseCount: number
}

function wallLengthMm(wall: Wall): number {
  const dx = wall.endX - wall.startX
  const dy = wall.endY - wall.startY
  return Math.sqrt(dx * dx + dy * dy)
}

/**
 * Compute the brick tally for a set of walls + openings, given the brick settings.
 */
export function calculateBrickTally(
  walls: Wall[],
  openings: Opening[],
  settings: BrickSettings
): BrickTally {
  let totalLinealMm = 0
  let totalAreaSqMm = 0

  for (const wall of walls) {
    const len = wallLengthMm(wall)
    const height = wall.heightMmOverride ?? settings.defaultWallHeightMm
    totalLinealMm += len
    totalAreaSqMm += len * height
  }

  for (const op of openings) {
    totalAreaSqMm -= op.widthMm * op.heightMm
  }

  if (totalAreaSqMm < 0) totalAreaSqMm = 0

  const areaSqM = totalAreaSqMm / 1_000_000
  const brickCount = Math.ceil(areaSqM * settings.bricksPerSquareMetre)

  const tiesCount = settings.ties.enabled
    ? Math.ceil(areaSqM * settings.ties.perSquareMetre)
    : 0

  const totalLengthM = totalLinealMm / 1000
  const plascourseCount =
    settings.plascourse.enabled && settings.plascourse.metresPerUnit > 0
      ? Math.ceil(totalLengthM / settings.plascourse.metresPerUnit)
      : 0

  return {
    wallCount: walls.length,
    openingCount: openings.length,
    totalLinealMm,
    totalAreaSqMm,
    brickCount,
    tiesCount,
    plascourseCount,
  }
}

/**
 * Sensible defaults for a fresh brick estimate.
 *
 * Picks the first brick code in the live BRICK_LIBRARY so a US user with
 * the US-modular library gets 'modular' as the default, a UK user gets
 * 'standard' (BS 215×65), AU users get the legacy 'standard' (230×76).
 * Falls back to 'standard' as a last resort if the library is empty.
 *
 * Initial bricks/m² is computed from the chosen brick's face dimensions
 * + the makeup mortar (default 10mm). The brick settings panel keeps
 * this in lockstep with the active brick type after creation.
 */
export function createDefaultBrickSettings(): BrickSettings {
  // Ties + plascourse default to "enabled if your region uses them" so a new
  // brick project pre-ticks the boxes for AU/UK users and pre-unticks for
  // markets where these don't apply. Per-project overrides remain in the
  // brick settings panel.
  const regional = getUserSettings().preferences.regionalFeatures
  const firstBrick = Object.values(BRICK_LIBRARY)[0]
  const brickTypeCode = firstBrick?.code ?? 'standard'
  // Compute bricks/m² from the brick's face area + assumed 10mm joint.
  // (faceW + 10) × (faceH + 10) = m²-area per brick; flip for rate.
  const computedRate = firstBrick
    ? Math.round(
        1_000_000 /
          ((firstBrick.widthMm + 10) * (firstBrick.heightMm + 10))
      )
    : 48
  return {
    defaultWallHeightMm: 2400,
    brickTypeCode,
    bricksPerSquareMetre: computedRate,
    ties: { enabled: regional.brickTies, perSquareMetre: 2 },
    plascourse: { enabled: regional.plascourse, metresPerUnit: 30 },
  }
}
