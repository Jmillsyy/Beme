/**
 * Brick estimate calculation engine.
 *
 * Brick estimates are simpler than block — there's no bond pattern, no end terminations,
 * no fraction maths. We just count brickwork m², subtract opening areas, apply a "bricks
 * per m²" rate, and add ties / plascourse / lintels according to the brief's rules.
 */

import type { BrickLintelEntry, BrickSettings, Opening, Wall } from '../types/walls'
import { brickLintelBearingMm } from './lintels'

// ---------- Brick lintel catalogue ----------

export type LintelProfile = 'Flatbar' | '100×100 Galintel' | '100×150 Galintel'

export interface BrickLintelSize {
  lengthMm: number
  profile: LintelProfile
}

/**
 * Stock lintel sizes available from suppliers. The calculation rounds the required
 * length (opening width + bearing) up to the smallest size in this list that fits.
 */
export const BRICK_LINTEL_SIZES: BrickLintelSize[] = [
  // Flatbar — small openings
  { lengthMm: 600, profile: 'Flatbar' },
  { lengthMm: 700, profile: 'Flatbar' },
  { lengthMm: 800, profile: 'Flatbar' },
  { lengthMm: 900, profile: 'Flatbar' },
  { lengthMm: 1000, profile: 'Flatbar' },
  // 100×100 Galintels
  { lengthMm: 1200, profile: '100×100 Galintel' },
  { lengthMm: 1500, profile: '100×100 Galintel' },
  { lengthMm: 1800, profile: '100×100 Galintel' },
  { lengthMm: 2100, profile: '100×100 Galintel' },
  { lengthMm: 2400, profile: '100×100 Galintel' },
  { lengthMm: 2700, profile: '100×100 Galintel' },
  // 100×150 Galintels
  { lengthMm: 3000, profile: '100×150 Galintel' },
  { lengthMm: 3300, profile: '100×150 Galintel' },
  { lengthMm: 3600, profile: '100×150 Galintel' },
  { lengthMm: 4000, profile: '100×150 Galintel' },
  { lengthMm: 4200, profile: '100×150 Galintel' },
  { lengthMm: 4500, profile: '100×150 Galintel' },
  { lengthMm: 5000, profile: '100×150 Galintel' },
  { lengthMm: 5200, profile: '100×150 Galintel' },
  { lengthMm: 5500, profile: '100×150 Galintel' },
  { lengthMm: 6000, profile: '100×150 Galintel' },
]

/**
 * Returns the smallest stock lintel size that's >= the required length, or null if the
 * required length exceeds the largest available size (6000mm). Callers should flag null
 * results as "custom — exceeds stock sizes".
 */
export function selectBrickLintelSize(requiredLengthMm: number): BrickLintelSize | null {
  return BRICK_LINTEL_SIZES.find((s) => s.lengthMm >= requiredLengthMm) ?? null
}

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
  /** Per-opening lintel entries. */
  lintels: BrickLintelEntry[]
  /** Sum of `lintels[].totalLintelLengthMm`. */
  totalLintelLengthMm: number
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

  const lintels: BrickLintelEntry[] = []
  let totalLintelLengthMm = 0

  for (const op of openings) {
    totalAreaSqMm -= op.widthMm * op.heightMm

    const bearingEachSideMm = brickLintelBearingMm(op.widthMm)
    const requiredLengthMm = op.widthMm + 2 * bearingEachSideMm
    const selectedLintel = selectBrickLintelSize(requiredLengthMm)
    lintels.push({
      openingId: op.id,
      openingWidthMm: op.widthMm,
      bearingEachSideMm,
      requiredLengthMm,
      selectedLintel,
    })
    if (selectedLintel) totalLintelLengthMm += selectedLintel.lengthMm
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
    lintels,
    totalLintelLengthMm,
    tiesCount,
    plascourseCount,
  }
}

/**
 * Sensible defaults for a fresh brick estimate.
 *
 * Defaults to the 'standard' brick type from the library (230×76 face). The
 * brick library may rename or re-dimension that type; we don't compute the
 * rate here because the library hasn't loaded yet at module init. The brick
 * settings panel reconciles `bricksPerSquareMetre` against the active type
 * whenever it changes.
 */
export function createDefaultBrickSettings(): BrickSettings {
  return {
    defaultWallHeightMm: 2400,
    brickTypeCode: 'standard',
    bricksPerSquareMetre: 48, // 230×76 + 10mm joint → ~48/m²
    ties: { enabled: false, perSquareMetre: 2 },
    plascourse: { enabled: false, metresPerUnit: 30 },
  }
}
