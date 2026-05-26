/**
 * Unit-aware display helpers.
 *
 * The calc engine is metric-only internally — every dimension lives in mm.
 * These helpers format mm values for display in the UI / exports, respecting
 * the user's units preference.
 *
 * Inputs stay metric for v1 — the conversion is one-way (mm → display string).
 * Deep imperial input support is v2.
 */

import type { DateFormat, Units } from '../types/userSettings'

const MM_PER_INCH = 25.4
const MM_PER_FOOT = 304.8

/**
 * Format a length in mm for display.
 *
 *   metric:    1234   → "1234 mm"
 *              28500  → "28.5 m"
 *
 *   imperial:  1234   → "48 5/8\""  (rounded to 1/8 inch)
 *              28500  → "93' 5\""
 */
export function formatLengthMm(mm: number, units: Units = 'metric'): string {
  if (!Number.isFinite(mm)) return '—'
  if (units === 'imperial') return formatLengthImperial(mm)
  // Metric — show m when ≥ 1000mm.
  if (Math.abs(mm) >= 1000) {
    return `${(mm / 1000).toFixed(mm % 1000 === 0 ? 0 : 2)} m`
  }
  return `${Math.round(mm)} mm`
}

/**
 * Compact label form used on the canvas (no unit suffix for metric — the
 * project bar / settings tells you what units are active, and saving the
 * letters keeps the labels readable on a busy plan).
 */
export function formatLengthShort(mm: number, units: Units = 'metric'): string {
  if (!Number.isFinite(mm)) return ''
  if (units === 'imperial') return formatLengthImperial(mm)
  return `${Math.round(mm)}`
}

/**
 * Format an area in mm² for display.
 *
 *   metric:    19_600_000 → "19.6 m²"
 *   imperial:  19_600_000 → "211 ft²"
 */
export function formatAreaSqMm(sqMm: number, units: Units = 'metric'): string {
  if (!Number.isFinite(sqMm)) return '—'
  if (units === 'imperial') {
    const sqFt = sqMm / (MM_PER_FOOT * MM_PER_FOOT)
    return `${sqFt.toFixed(sqFt >= 10 ? 0 : 1)} ft²`
  }
  const sqM = sqMm / 1_000_000
  return `${sqM.toFixed(sqM >= 10 ? 1 : 2)} m²`
}

// ─── Imperial conversion ───────────────────────────────────────────────────

/**
 * mm → "X' Y Z/8\""  imperial string. Rounds to nearest 1/8 inch.
 * Below 12 inches drops the feet portion ("11 3/8\"").
 */
function formatLengthImperial(mm: number): string {
  if (Math.abs(mm) < 0.5) return '0"'

  // Round to nearest 1/8 inch.
  const eighths = Math.round(mm / (MM_PER_INCH / 8))
  const totalInches = eighths / 8
  const sign = totalInches < 0 ? '-' : ''
  const absInches = Math.abs(totalInches)
  const feet = Math.floor(absInches / 12)
  const inches = absInches - feet * 12

  const whole = Math.floor(inches)
  const fractionalEighths = Math.round((inches - whole) * 8)
  let frac = ''
  if (fractionalEighths === 8) {
    // Rounded up to a whole inch.
    if (feet > 0) return `${sign}${feet}' ${whole + 1}"`
    return `${sign}${whole + 1}"`
  }
  if (fractionalEighths > 0) {
    const reduced = reduceFraction(fractionalEighths, 8)
    frac = ` ${reduced[0]}/${reduced[1]}`
  }
  if (feet > 0) {
    return `${sign}${feet}' ${whole}${frac}"`
  }
  return `${sign}${whole}${frac}"`
}

function reduceFraction(num: number, den: number): [number, number] {
  const g = gcd(num, den)
  return [num / g, den / g]
}
function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b)
}

// Currency helpers (currencySymbol + formatCurrency) lived here until
// the Currency preference was retired — beme estimates quantities, not
// prices, so neither helper had any callers. Deleted to keep the
// formatter module focused on units + dates.

// ─── Date ──────────────────────────────────────────────────────────────────

/** Format an ISO date string (YYYY-MM-DD) per the user's preference. */
export function formatDate(iso: string, fmt: DateFormat = 'DD/MM/YYYY'): string {
  if (!iso) return ''
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (!m) return iso
  const [, y, mo, d] = m
  if (fmt === 'YYYY-MM-DD') return `${y}-${mo}-${d}`
  if (fmt === 'MM/DD/YYYY') return `${mo}/${d}/${y}`
  return `${d}/${mo}/${y}`
}
