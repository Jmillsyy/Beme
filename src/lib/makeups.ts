/**
 * Factory helpers for creating WallMakeup objects with sensible defaults
 * straight from the Project Brief.
 */

import type { WallMakeup, BondType } from '../types/walls'

/**
 * Generates a unique id. Uses crypto.randomUUID when available (modern browsers),
 * otherwise falls back to a timestamp-based id for tests / non-browser contexts.
 */
function uid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export interface CreateMakeupOptions {
  name?: string
  bondType?: BondType
  heightMm?: number
  /** When true, the top course is a 20.20 bond beam (e.g. when a slab is poured above). */
  bondBeamOnTop?: boolean
  /**
   * Use 20.21 knockout-corner blocks at corners (for additional corefill at corner cores)
   * rather than the default 20.01.
   */
  knockoutCorners?: boolean
  useFractions?: boolean
}

/**
 * Creates a new wall makeup with defaults from the brief:
 *   - Bond: stretcher
 *   - Height: 2400mm
 *   - Base course: 20.45 cleanouts + 50.45 tiles
 *   - Body: 20.48 H blocks
 *   - Top: 20.48 (or 20.20 if bondBeamOnTop)
 *   - Corner: 20.01 (or 20.21 if knockoutCorners)
 *   - Fractions: ON
 */
export function createDefaultWallMakeup(options: CreateMakeupOptions = {}): WallMakeup {
  const {
    name = 'New wall type',
    bondType = 'stretcher',
    heightMm = 2400,
    bondBeamOnTop = false,
    knockoutCorners = false,
    useFractions = true,
  } = options

  return {
    id: uid(),
    name,
    bondType,
    heightMm,
    baseCourseBlockCode: '20.45',
    baseCourseTileCode: '50.45',
    bodyBlockCode: '20.48',
    topCourseBlockCode: bondBeamOnTop ? '20.20' : '20.48',
    cornerBlockCode: knockoutCorners ? '20.21' : '20.01',
    useFractions,
  }
}
