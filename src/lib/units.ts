/**
 * Unit-aware display helpers.
 *
 * The calc engine is metric-only internally — every dimension lives in mm.
 * These helpers format mm values for display in the UI / exports, respecting
 * the user's units preference, and parse user-typed strings back into mm
 * (accepting feet-inches notation with fractions, metric notation with
 * unit suffix, or a plain number interpreted per the user's settings).
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

// ─── Input parsing ─────────────────────────────────────────────────────────

/**
 * Parse a user-typed length string into millimetres.
 *
 * Accepted formats (whitespace flexible, quote characters optional):
 *
 *   Imperial feet-inches:
 *     8'-6"           → 2590.8 mm
 *     8'6"            → 2590.8 mm
 *     8' 6"           → 2590.8 mm
 *     8'-6 1/2"       → 2603.5 mm
 *     8'              → 2438.4 mm  (feet only)
 *     8.5'            → 2590.8 mm  (decimal feet)
 *
 *   Imperial inches:
 *     6"              → 152.4 mm
 *     6 1/2"          → 165.1 mm
 *     1/2"            → 12.7 mm
 *     6.5"            → 165.1 mm
 *
 *   Metric with suffix:
 *     2400mm          → 2400
 *     2.4m            → 2400
 *
 *   Plain number (no unit) — interpreted per the units argument:
 *     "2400" + metric    → 2400 mm
 *     "96"   + imperial  → 2438.4 mm   (interpreted as inches)
 *
 * Returns null when the string can't be parsed. The parser is forgiving
 * about whitespace and the dash between feet and inches, but otherwise
 * strict — junk input returns null rather than silently producing 0.
 */
export function parseLengthInput(
  input: string,
  units: Units = 'metric',
): number | null {
  if (typeof input !== 'string') return null
  // Normalise whitespace + lowercase. Curly quotes and primes from
  // copy-paste also map to straight ASCII so 8′-6″ parses too.
  const s = input
    .trim()
    .replace(/[‘’‚′]/g, "'") // curly single quotes + prime → '
    .replace(/[“”„″]/g, '"') // curly double quotes + double-prime → "
    .replace(/\s+/g, ' ')
    .toLowerCase()
  if (!s) return null

  // ── Metric with explicit suffix ─────────────────────────────────
  // mm, cm, m. Plain number falls through to the units-aware path
  // below.
  const mmMatch = s.match(/^(-?\d+(?:\.\d+)?)\s*mm$/)
  if (mmMatch) return parseFloat(mmMatch[1])
  const cmMatch = s.match(/^(-?\d+(?:\.\d+)?)\s*cm$/)
  if (cmMatch) return parseFloat(cmMatch[1]) * 10
  const mMatch = s.match(/^(-?\d+(?:\.\d+)?)\s*m$/)
  if (mMatch) return parseFloat(mMatch[1]) * 1000

  // ── Imperial feet-and-inches ────────────────────────────────────
  // Match anything with a feet marker ('). Inches portion is
  // optional. Dash, hyphen or whitespace between feet and inches all
  // accepted. Inches can be whole, decimal, or whole + fraction.
  //
  // Layout:                  feet  sep  inches
  //   8'                       8    .    .
  //   8'6                      8    .    6
  //   8'6"                     8    .    6
  //   8'-6 1/2"                8    -    6 1/2
  //   8' 6.25"                 8    sp   6.25
  //   8.5'                     8.5  .    .
  const feetMatch = s.match(
    // (1) feet (decimal allowed)
    // (2) inches part (optional) — capture everything after the ' to "
    //
    // We deliberately split the inches parsing into a second pass so
    // we can use the inches helper for the "no feet" case too.
    /^(-?\d+(?:\.\d+)?)\s*'\s*-?\s*(?:(.+?)\s*"?)?\s*$/,
  )
  if (feetMatch) {
    const feet = parseFloat(feetMatch[1])
    const inchesStr = feetMatch[2]?.trim() ?? ''
    const inches = inchesStr ? parseInchesFragment(inchesStr) : 0
    if (inches === null) return null
    return (feet * 12 + inches) * MM_PER_INCH
  }

  // ── Imperial inches only (no feet marker) ───────────────────────
  // Match anything that ends in " or has a fraction. Whole-number
  // strings without a quote fall through to the units-aware path
  // (where they're inches when units='imperial').
  if (s.includes('"') || /\d+\/\d+/.test(s)) {
    const cleaned = s.replace(/"$/, '').trim()
    const inches = parseInchesFragment(cleaned)
    if (inches !== null) return inches * MM_PER_INCH
  }

  // ── Plain number ────────────────────────────────────────────────
  // Interpreted per the units argument: mm in metric mode, inches in
  // imperial mode. This is the path most everyday inputs hit — the
  // user types `2400` (metric) or `96` (imperial) without thinking
  // about unit markers.
  const plainMatch = s.match(/^-?\d+(?:\.\d+)?$/)
  if (plainMatch) {
    const n = parseFloat(s)
    if (!Number.isFinite(n)) return null
    return units === 'imperial' ? n * MM_PER_INCH : n
  }

  return null
}

/**
 * Parse an inches fragment — accepts:
 *   "6"            → 6
 *   "6 1/2"        → 6.5
 *   "1/2"          → 0.5
 *   "6.25"         → 6.25
 * Returns null on garbage.
 */
function parseInchesFragment(s: string): number | null {
  const t = s.trim()
  if (!t) return 0
  // Whole + fraction: "6 1/2"
  const wholeFrac = t.match(/^(\d+)\s+(\d+)\/(\d+)$/)
  if (wholeFrac) {
    const w = parseInt(wholeFrac[1], 10)
    const n = parseInt(wholeFrac[2], 10)
    const d = parseInt(wholeFrac[3], 10)
    if (d === 0) return null
    return w + n / d
  }
  // Pure fraction: "1/2"
  const frac = t.match(/^(\d+)\/(\d+)$/)
  if (frac) {
    const n = parseInt(frac[1], 10)
    const d = parseInt(frac[2], 10)
    if (d === 0) return null
    return n / d
  }
  // Decimal or whole number: "6.5" or "6"
  const num = t.match(/^\d+(?:\.\d+)?$/)
  if (num) return parseFloat(t)
  return null
}

/**
 * Placeholder hint for a length input, customised per the user's units
 * preference. Use as the `placeholder` prop on a length input so users
 * see an example of the expected format.
 */
export function lengthInputPlaceholder(units: Units = 'metric'): string {
  return units === 'imperial' ? `8'-6"` : '2400'
}

/**
 * Default suffix label for a length input. Pair with the input as a
 * suffix chip so users know what the field expects when they leave it
 * blank.
 */
export function lengthInputSuffix(units: Units = 'metric'): string {
  return units === 'imperial' ? 'ft-in' : 'mm'
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
