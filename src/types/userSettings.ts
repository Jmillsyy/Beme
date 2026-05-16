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

export interface UserSettings {
  profile: UserProfile
  business: BusinessProfile
  preferences: UserPreferences
  defaults: EstimatingDefaults
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
    },
    defaults: {
      defaultWallHeightMm: 2400,
      defaultBondType: 'stretcher',
      defaultMortarJointMm: 10,
      defaultBrickTypeCode: 'standard',
    },
  }
}
