/**
 * User-wide settings — shared across every project the user owns.
 *
 * Distinct from `ProjectDetails` which is per-project. These settings drive
 * defaults for new projects (wall height, brick type, etc.), display
 * preferences (units, currency, theme), and the business identity used on
 * exported estimates.
 */

export type Units = 'metric' | 'imperial'
export type DateFormat = 'DD/MM/YYYY' | 'MM/DD/YYYY' | 'YYYY-MM-DD'
export type Theme = 'dark' | 'light'

export interface UserProfile {
  /** Display name shown in the header user menu and on exports. */
  displayName: string
  /** Email — read-only when synced from Microsoft OAuth. */
  email: string
  /** Phone — used on the export header. */
  phone: string
  /** Job title / role — e.g. "Owner", "Estimator". */
  role: string
}

export interface BusinessProfile {
  /** Trading name / company name. */
  companyName: string
  /** Australian Business Number (or VAT / EIN equivalent). */
  abn: string
  /** Street address. */
  addressLine1: string
  addressLine2: string
  suburb: string
  state: string
  postcode: string
  /** Phone number — separate from personal. */
  phone: string
  /** Website / Instagram / wherever customers find you. */
  website: string
  /**
   * URL to the company logo (PNG or SVG). When set, embedded in the
   * exported estimate header. (Upload UI is v2 — for now you paste a URL.)
   */
  logoUrl: string
  // defaultTaxRate retired — beme estimates quantities, not prices.
}

export interface UserPreferences {
  units: Units
  dateFormat: DateFormat
  theme: Theme
  /** What clicking "+ New estimate" defaults to on the dashboard. */
  defaultProjectType: 'block' | 'brick'
  /**
   * The block-library template the user picked at signup (or via
   * Settings → Library template). Drives the seed block set, the default
   * mortar joint for new makeups, and the regional flavour of the
   * onboarding / settings copy.
   *
   * Optional / undefined for legacy users — they continue running on the
   * AU-SEQ seed library that's been live since v1. Set to one of the
   * keys from LIBRARY_TEMPLATES in src/data/libraryTemplates.ts.
   */
  libraryTemplateKey?:
    | 'au-seq'
    | 'nz-block'
    | 'us-cmu'
    | 'ca-cmu'
    | 'uk-block'
    | 'blank'

  // Currency + regional features were retired. Beme estimates quantities,
  // not prices, so a currency selector was misleading. Regional feature
  // toggles (lintels / brick ties / plascourse) are now driven by the
  // Material library directly — block lintels via the 'lintel' BlockRole,
  // brick lintels / ties / plascourse via supply items with their own
  // enable / include flags. Single source of truth.
}

export interface EstimatingDefaults {
  /** Default wall height (mm) — used for new wall makeups and brick settings. */
  defaultWallHeightMm: number
  /** Default bond — stretcher or stack. */
  defaultBondType: 'stretcher' | 'stack'
  /** Default mortar joint thickness (mm). */
  defaultMortarJointMm: number
  /** Default brick type code — references a code in the user's BrickLibrary. */
  defaultBrickTypeCode: string
  /**
   * Wall-length snap increment (mm). When the user draws a wall, the live
   * preview rounds the wall length to the nearest multiple of this value
   * (after axis + endpoint snaps have run). 50 mm fits the AU SEQ block
   * library cleanly — every combination of full / 7-8 / 3-4 / half blocks
   * lands on a 50 mm grid. Set lower (e.g. 25 or 10) for libraries with
   * finer block widths; set higher (e.g. 100) to discourage 7-8 / 3-4
   * cuts and limit walls to full + half compositions.
   *
   * Optional — older accounts without this field treated 5 mm as default;
   * new accounts get 50 mm and the snap function falls back to 50 when
   * the field is missing.
   */
  wallLengthSnapMm?: number

  /**
   * Whether new wall makeups default to "match exact wall length" (use
   * fraction-tagged blocks / cut blocks to absorb leftover length).
   * Most users set this once for their region's practice and forget it,
   * so it lives here as a user preference rather than per-makeup. Older
   * accounts default to `true` to preserve the previous behaviour where
   * every makeup turned this on at creation.
   */
  defaultMatchExactLength?: boolean

  /**
   * When "match exact wall length" is on, which course types it applies
   * to. Each entry switches on fraction / cut-block fitting for that
   * course type; absent entries fall back to whole-block rounding for
   * that course type. Undefined = all course types (default).
   */
  defaultExactLengthCourses?: Array<'base' | 'body' | 'height-makeup' | 'top'>
}

/**
 * Unit of measure for a supply item — how the rate is applied against the
 * estimate's geometry.
 *
 * - `each`: flat count entered per project (e.g. "2× lintels supplied").
 * - `per-block`: rate × total block count.
 * - `per-brick`: rate × total brick count.
 * - `per-m2`: rate × total brickwork / blockwork area.
 * - `per-m-lineal`: rate × total wall run length.
 * - `per-opening`: rate × number of openings on the plan.
 */
export type SupplyItemUnit =
  | 'each'
  | 'per-block'
  | 'per-brick'
  | 'per-m2'
  | 'per-m-lineal'
  | 'per-opening'

/**
 * A user-defined supply item that gets added to estimate totals based on a
 * rate. Generalisation of the existing ties / plascourse mechanism — any
 * "this many of X per Y" addition can be expressed here.
 *
 * Examples:
 *   - "Cement bags" — per-m2, rate 0.3 (so 0.3 bags per m² of brickwork)
 *   - "N12 vertical rebar" — per-block, rate 0.05 (so 1 bar per 20 blocks)
 *   - "Steel lintels — 1500mm" — per-opening, rate 1 (one per opening)
 *   - "Brick ties" — per-m2, rate 2 (same as the legacy ties.perSquareMetre)
 *   - "Cavity flashing" — per-m-lineal, rate 1
 */
export interface SupplyItem {
  id: string
  /** User-chosen display name. Shown in the supply-items section of the export. */
  name: string
  /** Optional description / supplier note. */
  description?: string
  unit: SupplyItemUnit
  /** Quantity per unit (e.g. 2 ties per m² → rate: 2, unit: 'per-m2'). */
  rate: number
  /** Which estimate types this item applies to. */
  appliesTo: ('block' | 'brick')[]
  /**
   * Default-on for new projects. Per-project the user can still tick/untick
   * individual items if a job doesn't need this particular supply.
   */
  enabledByDefault: boolean
  /**
   * Optional grouping label — items sharing the same category render as
   * a collapsible section in the SupplyItemsPanel. Free-text so users
   * pick whatever taxonomy works for them ("Lintels", "Galintel",
   * "Ties", "Cement", etc.). Items without a category fall under
   * "Uncategorised". Case-sensitive equality groups items together;
   * the UI offers autocomplete from existing categories.
   */
  category?: string
  /**
   * For `unit: 'per-opening'` supplies ONLY — restrict the count to
   * openings whose WIDTH falls within this range (mm). Lets the user
   * configure lintels / sills / heads as supply items that auto-pick
   * based on opening width:
   *
   *   - "Galintel 100×100" → openingWidthMinMm 1200, openingWidthMaxMm 1800
   *   - "Steel angle L 3.5×3.5" → openingWidthMinMm 1800, openingWidthMaxMm 3000
   *
   * Either bound undefined means "open" on that side. Both undefined
   * means the supply applies to EVERY opening (which is the
   * pre-existing per-opening behaviour, kept for back-compat).
   */
  openingWidthMinMm?: number
  openingWidthMaxMm?: number
  /**
   * Decimal places to display this item's quantity at. Whole-unit items
   * (bricks, blocks, lintels, ties) stay at 0 so they keep rounding up to
   * a whole count; consumable items like cement / sand / flashing where
   * a fractional quantity is meaningful can pick 1–3 so the deliverable
   * reads "0.30 m³" rather than "1" or "0".
   *
   * The rounding mode is still "ceil" — fractional quantities round UP
   * to the next tick at the chosen precision so the estimator never
   * under-orders. Defaults to 0 when missing so existing libraries keep
   * the original whole-unit behaviour.
   */
  decimalPlaces?: number
}

/** Clamp a SupplyItem's decimalPlaces to a sane range (0–3) and default
 *  missing values to 0. Centralised so the panel / brick export / block
 *  export all agree on the same precision per row. */
export function supplyItemDecimals(item: Pick<SupplyItem, 'decimalPlaces'>): number {
  const d = item.decimalPlaces ?? 0
  if (!Number.isFinite(d)) return 0
  return Math.max(0, Math.min(3, Math.floor(d)))
}

/** Round a quantity UP to the item's chosen precision. 0 dp → whole
 *  units (Math.ceil), 1 dp → ceil to 0.1, etc. Used everywhere the
 *  quantity surfaces so the panel, the tally line, and the PDF row
 *  always print the same number. */
export function roundSupplyQuantity(
  qty: number,
  item: Pick<SupplyItem, 'decimalPlaces'>,
): number {
  const places = supplyItemDecimals(item)
  const factor = Math.pow(10, places)
  return Math.ceil(qty * factor) / factor
}

/** Format a quantity at the item's chosen precision. Always emits the
 *  full decimals (toFixed) so 0.30 doesn't collapse to 0.3 in the
 *  schedule — keeps columns visually aligned. Uses toLocaleString for
 *  the integer-side grouping (1,200 not 1200) to match the panel's
 *  existing display. */
export function formatSupplyQuantity(
  qty: number,
  item: Pick<SupplyItem, 'decimalPlaces'>,
): string {
  const places = supplyItemDecimals(item)
  const rounded = roundSupplyQuantity(qty, item)
  return rounded.toLocaleString(undefined, {
    minimumFractionDigits: places,
    maximumFractionDigits: places,
  })
}

/**
 * Maps each "the engine needs to pick a block for me" role to a specific
 * BlockCode from the user's library. Used by auto-create paths (new wall
 * type defaults, curved-wall makeup auto-pick, pier makeup seed) and by
 * the engine's "what block fits this role here" lookups (lintels by head
 * height, height-makeup by remainder).
 *
 * Every entry is optional — missing keys fall through to the legacy
 * library-side role-tag search. The migration plan is to populate this
 * map for the user's region template at first sign-in and stop relying
 * on the per-block roles[] array entirely.
 */
export interface DefaultsByRole {
  body?: string
  corner?: string
  half?: string
  base?: string
  top?: string
  pier?: string
  pierTie?: string
  lintel?: string
  curveWedge?: string
  heightMakeup90?: string
  heightMakeup140?: string
  cornerLeadIn?: string
}

export interface UserSettings {
  profile: UserProfile
  business: BusinessProfile
  preferences: UserPreferences
  defaults: EstimatingDefaults
  /**
   * Per-role default block IDs. Optional — present on accounts that have
   * been migrated to the role-defaults model; absent on legacy / older
   * accounts (callers fall back to library role-tag lookup).
   */
  defaultsByRole?: DefaultsByRole
  /**
   * User's catalogue of additional supply items. Each new project picks up
   * the enabledByDefault items into its supply-list; user can toggle them
   * per-project in the brick/block settings panel.
   */
  supplyItems?: SupplyItem[]
}

/**
 * Sensible defaults for a brand-new install. Australian-flavoured because that's
 * the primary market — but every field is editable in the settings page.
 */
export function createDefaultUserSettings(): UserSettings {
  return {
    profile: {
      displayName: '',
      email: '',
      phone: '',
      role: '',
    },
    business: {
      companyName: '',
      abn: '',
      addressLine1: '',
      addressLine2: '',
      suburb: '',
      state: '',
      postcode: '',
      phone: '',
      website: '',
      logoUrl: '',
    },
    preferences: {
      units: 'metric',
      dateFormat: 'DD/MM/YYYY',
      theme: 'dark',
      defaultProjectType: 'block',
    },
    defaults: {
      defaultWallHeightMm: 2400,
      defaultBondType: 'stretcher',
      defaultMortarJointMm: 10,
      defaultBrickTypeCode: 'standard',
      // 50 mm matches the AU SEQ block library's modular GCD —
      // any combination of full / 7-8 / 3-4 / half blocks composes
      // cleanly on this grid. Customisable in Settings.
      wallLengthSnapMm: 50,
      defaultMatchExactLength: true,
      // undefined = all course types (same as ['base', 'body',
      // 'height-makeup', 'top'])
    },
    supplyItems: createDefaultSupplyItems(),
  }
}

/**
 * Supply items are intentionally EMPTY for new accounts. Supplies (ties,
 * cement, rebar, flashing, etc.) vary so much by region, by supplier,
 * and by estimator preference that any preset would be wrong for someone.
 * Users add the supplies they actually price into estimates from the
 * Material library page — Beme just provides the framework (rate × unit
 * × applicable-to). The library-template Reset action also clears
 * supplyItems so a wipe-and-reseed leaves no stale items behind.
 */
export function createDefaultSupplyItems(): SupplyItem[] {
  return []
}
