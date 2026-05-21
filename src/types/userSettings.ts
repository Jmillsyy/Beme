/**
 * User-wide settings — shared across every project the user owns.
 *
 * Distinct from `ProjectDetails` which is per-project. These settings drive
 * defaults for new projects (wall height, brick type, etc.), display
 * preferences (units, currency, theme), and the business identity used on
 * exported estimates.
 */

export type Units = 'metric' | 'imperial'
export type Currency = 'AUD' | 'USD' | 'GBP' | 'EUR' | 'NZD' | 'CAD'
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
  /** Default GST / tax rate as a decimal (0.10 for 10% AU GST). */
  defaultTaxRate: number
}

export interface UserPreferences {
  units: Units
  currency: Currency
  dateFormat: DateFormat
  theme: Theme
  /** What clicking "+ New estimate" defaults to on the dashboard. */
  defaultProjectType: 'block' | 'brick'
  /**
   * Regional feature toggles — which "extras" the estimator typically prices
   * into their jobs. Different markets use different practices and the user
   * shouldn't have to wade past line items that never apply to them. These
   * defaults flow into new brick projects' BrickSettings and export
   * inclusions; users can still override per-project.
   *
   * Defaults to all-on so existing AU users see no change.
   */
  regionalFeatures: {
    /**
     * Lintel calculation + export. AU/UK estimators usually price the lintel
     * separately (steel for brick, stood-up lintel block for block walls);
     * US estimators often roll lintels into the structural design rather
     * than the masonry takeoff. Off → no lintel section in the export.
     */
    lintels: boolean
    /**
     * Brick ties between veneer and structural backing. Universal in cavity
     * construction (AU/UK/NZ/US) but rate per m² and supplier vary.
     */
    brickTies: boolean
    /**
     * Plascourse / DPC (damp-proof course). AU + UK term. US equivalent is
     * usually a flashing membrane priced under sealants, not masonry.
     */
    plascourse: boolean
  }
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
}

export interface UserSettings {
  profile: UserProfile
  business: BusinessProfile
  preferences: UserPreferences
  defaults: EstimatingDefaults
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
      defaultTaxRate: 0.1,
    },
    preferences: {
      units: 'metric',
      currency: 'AUD',
      dateFormat: 'DD/MM/YYYY',
      theme: 'dark',
      defaultProjectType: 'block',
      regionalFeatures: {
        lintels: true,
        brickTies: true,
        plascourse: true,
      },
    },
    defaults: {
      defaultWallHeightMm: 2400,
      defaultBondType: 'stretcher',
      defaultMortarJointMm: 10,
      defaultBrickTypeCode: 'standard',
    },
    supplyItems: createDefaultSupplyItems(),
  }
}

/**
 * Seed supply items every new install starts with. Includes the supplies
 * the brick estimate has historically tallied (ties), plus a couple of
 * common additions (cement bags, cavity flashing) that estimators will
 * recognise. The rates match what most Australian estimators use day-to-
 * day; users edit them in the Material library page.
 *
 * 'Brick Ties' is intentionally `enabledByDefault: true` so the brick
 * export shows ties on a fresh project without the user having to flip
 * anything. The brick export de-dupes against this item so the legacy
 * BrickSettings.ties row doesn't double up. The other items default off
 * — they're there to be visible / one-toggle-away in the library, not to
 * auto-add to every estimate.
 */
export function createDefaultSupplyItems(): SupplyItem[] {
  return [
    {
      id: 'seed-brick-ties',
      name: 'Brick Ties',
      description: 'Wall ties tying brickwork to the structural backing.',
      unit: 'per-m2',
      rate: 2,
      appliesTo: ['brick'],
      enabledByDefault: true,
    },
    {
      id: 'seed-plascourse',
      name: 'Plascourse',
      description:
        'Damp-course / plastic course rolls. ~1 roll per 30 lineal metres of brickwork (rate = 1/30 ≈ 0.0333 rolls per m).',
      unit: 'per-m-lineal',
      rate: 1 / 30,
      appliesTo: ['brick'],
      enabledByDefault: true,
    },
    {
      id: 'seed-cement',
      name: 'Cement (bags)',
      description: 'GP cement bags for mortar — adjust the rate to suit your mix.',
      unit: 'per-m2',
      rate: 0.3,
      appliesTo: ['brick', 'block'],
      enabledByDefault: false,
    },
    {
      id: 'seed-cavity-flashing',
      name: 'Cavity flashing (m)',
      description: 'Damp-proof flashing across cavity bases / lintel heads.',
      unit: 'per-m-lineal',
      rate: 1,
      appliesTo: ['brick'],
      enabledByDefault: false,
    },
    {
      id: 'seed-vertical-rebar',
      name: 'N12 vertical rebar (each)',
      description: 'Reinforcing bar placed in filled cores — one per N blocks.',
      unit: 'per-block',
      rate: 0.05,
      appliesTo: ['block'],
      enabledByDefault: false,
    },
  ]
}
