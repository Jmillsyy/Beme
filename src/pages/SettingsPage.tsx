import { useState } from 'react'
import { Link } from 'react-router-dom'
import Header from '../components/Header'
import {
  resetUserSettings,
  updateUserSettings,
  useUserSettings,
} from '../lib/userSettings'
import { useTheme } from '../lib/theme'
import { signOut, useAuth } from '../lib/auth'
import { isSupabaseConfigured } from '../lib/supabase'
import { resetBlockLibrary, useBlockLibrary } from '../data/blockLibrary'
import { resetBrickLibrary, useBrickLibrary } from '../data/brickLibrary'
import {
  bricksPerSquareMetreOf,
  type BrickType,
} from '../types/bricks'
import type {
  BusinessProfile,
  Currency,
  DateFormat,
  EstimatingDefaults,
  Theme as ThemePref,
  UserPreferences,
  UserProfile,
  Units,
} from '../types/userSettings'

type TabKey = 'profile' | 'business' | 'preferences' | 'defaults' | 'account'

interface Tab {
  key: TabKey
  label: string
  description: string
}

const TABS: Tab[] = [
  { key: 'profile', label: 'Profile', description: 'You — name, contact, role' },
  { key: 'business', label: 'Business', description: 'Used on every quote you export' },
  { key: 'preferences', label: 'Preferences', description: 'Units, currency, date, theme' },
  { key: 'defaults', label: 'Defaults', description: 'Starting values for new estimates' },
  { key: 'account', label: 'Account', description: 'Sign out, reset, danger zone' },
]

/**
 * The settings hub. Tabs along the left, panel on the right. Every change
 * persists immediately — no Save button. Studio Black themed throughout.
 */
export default function SettingsPage() {
  const { settings } = useUserSettings()
  const [activeTab, setActiveTab] = useState<TabKey>('profile')

  return (
    <div className="min-h-screen bg-ink-900 text-ink-50">
      <Header />

      <main className="max-w-[1200px] mx-auto px-6 py-10">
        <div className="flex items-end justify-between flex-wrap gap-4 mb-8">
          <div>
            <Link
              to="/"
              className="text-xs text-ink-400 hover:text-ink-100 transition-colors"
            >
              ← Back to dashboard
            </Link>
            <h2 className="text-4xl font-extrabold tracking-tight text-ink-50 mt-2">
              Settings
            </h2>
            <p className="text-ink-300 text-sm mt-1">
              Your profile, business info, preferences, and defaults — applied across every
              project on this device.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-[240px_1fr] gap-6 items-start">
          {/* ── Tab rail ── */}
          <nav className="border border-ink-600 rounded-xl bg-ink-800 p-1.5 flex flex-col gap-0.5 sticky top-6">
            {TABS.map((t) => {
              const active = t.key === activeTab
              return (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => setActiveTab(t.key)}
                  className={`text-left px-3 py-2 rounded-lg transition-colors ${
                    active
                      ? 'bg-beme-500/15 border border-beme-500/40'
                      : 'border border-transparent hover:bg-ink-700'
                  }`}
                >
                  <div
                    className={`text-sm font-semibold ${
                      active ? 'text-beme-300' : 'text-ink-100'
                    }`}
                  >
                    {t.label}
                  </div>
                  <div className="text-[11px] text-ink-400 mt-0.5">{t.description}</div>
                </button>
              )
            })}
          </nav>

          {/* ── Panel ── */}
          <section className="min-w-0">
            {activeTab === 'profile' && <ProfileTab profile={settings.profile} />}
            {activeTab === 'business' && <BusinessTab business={settings.business} />}
            {activeTab === 'preferences' && (
              <PreferencesTab preferences={settings.preferences} />
            )}
            {activeTab === 'defaults' && (
              <DefaultsTab defaults={settings.defaults} />
            )}
            {activeTab === 'account' && <AccountTab />}
          </section>
        </div>
      </main>
    </div>
  )
}

// ─── Shared form primitives ────────────────────────────────────────────────

function FieldGroup({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-1 md:grid-cols-2 gap-4">{children}</div>
}

function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <label className="block">
      <span className="block text-xs font-semibold uppercase tracking-[0.08em] text-ink-400 mb-1">
        {label}
      </span>
      {children}
      {hint && <span className="block text-[11px] text-ink-400 mt-1">{hint}</span>}
    </label>
  )
}

function TextInput({
  value,
  onChange,
  type = 'text',
  placeholder,
  disabled,
}: {
  value: string
  onChange: (v: string) => void
  type?: string
  placeholder?: string
  disabled?: boolean
}) {
  return (
    <input
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      disabled={disabled}
      className="w-full px-3 py-2 border border-ink-600 rounded-lg text-sm bg-ink-900 text-ink-50 focus:outline-none focus:border-beme-400 disabled:opacity-60"
    />
  )
}

function NumberInput({
  value,
  onChange,
  min,
  step,
  suffix,
}: {
  value: number
  onChange: (v: number) => void
  min?: number
  step?: number
  suffix?: string
}) {
  return (
    <div className="flex items-stretch">
      <input
        type="number"
        value={value}
        min={min}
        step={step}
        onChange={(e) => onChange(parseFloat(e.target.value || '0') || 0)}
        className={`flex-1 min-w-0 px-3 py-2 border border-ink-600 ${
          suffix ? 'rounded-l-lg border-r-0' : 'rounded-lg'
        } text-sm bg-ink-900 text-ink-50 focus:outline-none focus:border-beme-400`}
      />
      {suffix && (
        <span className="flex items-center px-3 border border-ink-600 rounded-r-lg bg-ink-700 text-ink-300 text-xs">
          {suffix}
        </span>
      )}
    </div>
  )
}

function Select<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T
  onChange: (v: T) => void
  options: { value: T; label: string }[]
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as T)}
      className="w-full px-3 py-2 border border-ink-600 rounded-lg text-sm bg-ink-900 text-ink-50 focus:outline-none focus:border-beme-400"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

function PanelCard({
  title,
  description,
  children,
}: {
  title: string
  description?: string
  children: React.ReactNode
}) {
  return (
    <div className="border border-ink-600 rounded-xl bg-ink-800 p-6">
      <div className="mb-5">
        <h3 className="text-lg font-bold text-ink-50">{title}</h3>
        {description && (
          <p className="text-sm text-ink-300 mt-1">{description}</p>
        )}
      </div>
      <div className="space-y-4">{children}</div>
    </div>
  )
}

// ─── Profile ──────────────────────────────────────────────────────────────

function ProfileTab({ profile }: { profile: UserProfile }) {
  const set = (p: Partial<UserProfile>) => updateUserSettings({ profile: p })
  return (
    <PanelCard
      title="Profile"
      description="Personal details — used in the header and on exported quotes."
    >
      <FieldGroup>
        <Field label="Display name">
          <TextInput
            value={profile.displayName}
            onChange={(v) => set({ displayName: v })}
            placeholder="e.g. Sam Reeves"
          />
        </Field>
        <Field
          label="Email"
          hint="Read-only when you sign in with Microsoft — the email comes from your work account."
        >
          <TextInput
            value={profile.email}
            onChange={(v) => set({ email: v })}
            placeholder="you@example.com"
            type="email"
          />
        </Field>
        <Field label="Phone">
          <TextInput
            value={profile.phone}
            onChange={(v) => set({ phone: v })}
            placeholder="0400 000 000"
            type="tel"
          />
        </Field>
        <Field label="Role / job title">
          <TextInput
            value={profile.role}
            onChange={(v) => set({ role: v })}
            placeholder="Owner / Estimator / Site supervisor"
          />
        </Field>
      </FieldGroup>
    </PanelCard>
  )
}

// ─── Business ─────────────────────────────────────────────────────────────

function BusinessTab({ business }: { business: BusinessProfile }) {
  const set = (p: Partial<BusinessProfile>) => updateUserSettings({ business: p })
  return (
    <div className="space-y-6">
      <PanelCard
        title="Business identity"
        description="Appears in the header of every exported quote / estimate."
      >
        <FieldGroup>
          <Field label="Company / trading name">
            <TextInput
              value={business.companyName}
              onChange={(v) => set({ companyName: v })}
              placeholder="e.g. ABC Bricklaying Pty Ltd"
            />
          </Field>
          <Field label="ABN / business number">
            <TextInput
              value={business.abn}
              onChange={(v) => set({ abn: v })}
              placeholder="12 345 678 901"
            />
          </Field>
          <Field label="Business phone">
            <TextInput
              value={business.phone}
              onChange={(v) => set({ phone: v })}
              placeholder="(07) 1234 5678"
              type="tel"
            />
          </Field>
          <Field label="Website">
            <TextInput
              value={business.website}
              onChange={(v) => set({ website: v })}
              placeholder="abcbricklaying.com.au"
            />
          </Field>
        </FieldGroup>
      </PanelCard>

      <PanelCard title="Business address">
        <FieldGroup>
          <Field label="Address line 1">
            <TextInput
              value={business.addressLine1}
              onChange={(v) => set({ addressLine1: v })}
              placeholder="14 Mothership Drive"
            />
          </Field>
          <Field label="Address line 2">
            <TextInput
              value={business.addressLine2}
              onChange={(v) => set({ addressLine2: v })}
              placeholder="Unit 3 (optional)"
            />
          </Field>
          <Field label="Suburb / city">
            <TextInput
              value={business.suburb}
              onChange={(v) => set({ suburb: v })}
              placeholder="Berrinba"
            />
          </Field>
          <Field label="State / region">
            <TextInput
              value={business.state}
              onChange={(v) => set({ state: v })}
              placeholder="QLD"
            />
          </Field>
          <Field label="Postcode">
            <TextInput
              value={business.postcode}
              onChange={(v) => set({ postcode: v })}
              placeholder="4117"
            />
          </Field>
        </FieldGroup>
      </PanelCard>

      <PanelCard
        title="Branding & tax"
        description="Logo and default tax rate for exports."
      >
        <FieldGroup>
          <Field
            label="Logo URL"
            hint="Direct link to a PNG or SVG. File upload coming soon — for now you paste a URL."
          >
            <TextInput
              value={business.logoUrl}
              onChange={(v) => set({ logoUrl: v })}
              placeholder="https://…/logo.png"
            />
          </Field>
          <Field
            label="Default tax rate"
            hint="Applied to quotes. 10% for Australian GST."
          >
            <NumberInput
              value={Math.round(business.defaultTaxRate * 1000) / 10}
              onChange={(v) => set({ defaultTaxRate: v / 100 })}
              min={0}
              step={0.5}
              suffix="%"
            />
          </Field>
        </FieldGroup>

        {business.logoUrl && (
          <div className="mt-3 pt-4 border-t border-ink-600">
            <div className="text-xs font-semibold uppercase tracking-[0.08em] text-ink-400 mb-2">
              Logo preview
            </div>
            <div className="bg-white p-3 rounded-lg inline-block">
              <img
                src={business.logoUrl}
                alt="Logo preview"
                className="max-h-16"
                onError={(e) => {
                  ;(e.currentTarget as HTMLImageElement).style.display = 'none'
                }}
              />
            </div>
          </div>
        )}
      </PanelCard>
    </div>
  )
}

// ─── Preferences ──────────────────────────────────────────────────────────

function PreferencesTab({ preferences }: { preferences: UserPreferences }) {
  const set = (p: Partial<UserPreferences>) => updateUserSettings({ preferences: p })
  const [, setTheme] = useTheme()

  // Keep the theme module in sync with settings.preferences.theme.
  function handleThemeChange(t: ThemePref) {
    set({ theme: t })
    setTheme(t)
  }

  return (
    <PanelCard
      title="Preferences"
      description="How beme displays things — units, currency, date format, theme."
    >
      <FieldGroup>
        <Field
          label="Units"
          hint="Display preference only — measurements stay in mm internally."
        >
          <Select<Units>
            value={preferences.units}
            onChange={(v) => set({ units: v })}
            options={[
              { value: 'metric', label: 'Metric (mm / m)' },
              { value: 'imperial', label: 'Imperial (in / ft)' },
            ]}
          />
        </Field>

        <Field label="Currency">
          <Select<Currency>
            value={preferences.currency}
            onChange={(v) => set({ currency: v })}
            options={[
              { value: 'AUD', label: 'Australian Dollar — A$' },
              { value: 'NZD', label: 'New Zealand Dollar — NZ$' },
              { value: 'USD', label: 'US Dollar — $' },
              { value: 'CAD', label: 'Canadian Dollar — C$' },
              { value: 'GBP', label: 'British Pound — £' },
              { value: 'EUR', label: 'Euro — €' },
            ]}
          />
        </Field>

        <Field label="Date format">
          <Select<DateFormat>
            value={preferences.dateFormat}
            onChange={(v) => set({ dateFormat: v })}
            options={[
              { value: 'DD/MM/YYYY', label: 'DD/MM/YYYY (Aus / UK)' },
              { value: 'MM/DD/YYYY', label: 'MM/DD/YYYY (US)' },
              { value: 'YYYY-MM-DD', label: 'YYYY-MM-DD (ISO)' },
            ]}
          />
        </Field>

        <Field label="Theme">
          <Select<ThemePref>
            value={preferences.theme}
            onChange={handleThemeChange}
            options={[
              { value: 'dark', label: 'Dark (Studio Black)' },
              { value: 'light', label: 'Light' },
            ]}
          />
        </Field>

        <Field
          label="Default project type"
          hint="What's selected when you click + New estimate."
        >
          <Select<'block' | 'brick'>
            value={preferences.defaultProjectType}
            onChange={(v) => set({ defaultProjectType: v })}
            options={[
              { value: 'block', label: 'Block estimate' },
              { value: 'brick', label: 'Brick estimate' },
            ]}
          />
        </Field>
      </FieldGroup>
    </PanelCard>
  )
}

// ─── Defaults ─────────────────────────────────────────────────────────────

function DefaultsTab({ defaults }: { defaults: EstimatingDefaults }) {
  const set = (p: Partial<EstimatingDefaults>) => updateUserSettings({ defaults: p })
  const { library: brickLibrary } = useBrickLibrary()
  const brickOptions = Object.values(brickLibrary)
    .sort((a: BrickType, b: BrickType) => a.heightMm - b.heightMm)
    .map((b: BrickType) => ({
      value: b.code,
      label: `${b.name} · ${bricksPerSquareMetreOf(b)}/m²`,
    }))

  return (
    <div className="space-y-6">
      <PanelCard
        title="Wall defaults"
        description="Applied when you create a new wall makeup in a project."
      >
        <FieldGroup>
          <Field label="Default wall height">
            <NumberInput
              value={defaults.defaultWallHeightMm}
              onChange={(v) => set({ defaultWallHeightMm: v })}
              min={200}
              step={50}
              suffix="mm"
            />
          </Field>
          <Field label="Default bond type">
            <Select<'stretcher' | 'stack'>
              value={defaults.defaultBondType}
              onChange={(v) => set({ defaultBondType: v })}
              options={[
                { value: 'stretcher', label: 'Stretcher bond (half-block stagger)' },
                { value: 'stack', label: 'Stack bond (no stagger)' },
              ]}
            />
          </Field>
          <Field label="Default mortar joint">
            <NumberInput
              value={defaults.defaultMortarJointMm}
              onChange={(v) => set({ defaultMortarJointMm: v })}
              min={0}
              step={1}
              suffix="mm"
            />
          </Field>
          <Field
            label="Default brick type"
            hint="Used when starting a new brick estimate."
          >
            <Select<string>
              value={defaults.defaultBrickTypeCode}
              onChange={(v) => set({ defaultBrickTypeCode: v })}
              options={brickOptions}
            />
          </Field>
        </FieldGroup>
      </PanelCard>

    </div>
  )
}

// ─── Account ──────────────────────────────────────────────────────────────

function AccountTab() {
  const { signedIn, user } = useAuth()
  const { version: bv } = useBlockLibrary()
  const { version: br } = useBrickLibrary()
  void bv
  void br

  async function handleClearLocal() {
    if (
      !window.confirm(
        'Clear all local data on this device (projects, libraries, settings)? This cannot be undone. ' +
          (signedIn
            ? 'Your cloud-stored projects are unaffected.'
            : 'Your local projects WILL be deleted.')
      )
    ) {
      return
    }
    // Wipe the userData store + projects store.
    try {
      const req = indexedDB.deleteDatabase('beme')
      req.onsuccess = () => {
        window.localStorage.removeItem('beme-theme')
        window.localStorage.removeItem('beme-local-migration-dismissed')
        window.location.reload()
      }
      req.onerror = () => {
        alert('Could not clear local data. Check the browser console.')
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(err)
    }
  }

  return (
    <div className="space-y-6">
      {isSupabaseConfigured && (
        <PanelCard
          title="Account"
          description={signedIn ? 'Signed in to Beme via Microsoft.' : 'Not signed in.'}
        >
          {signedIn && user ? (
            <>
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div>
                  <div className="font-semibold text-ink-50">{user.email}</div>
                  <div className="text-xs text-ink-400">
                    Signed in via Microsoft. Your projects are synced to the cloud.
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => void signOut()}
                  className="px-3 py-1.5 rounded-md border border-ink-600 text-sm text-ink-200 hover:bg-ink-700 transition-colors"
                >
                  Sign out
                </button>
              </div>
            </>
          ) : (
            <p className="text-sm text-ink-300">
              Sign in to sync your projects across devices.
            </p>
          )}
        </PanelCard>
      )}

      <PanelCard
        title="Reset libraries"
        description="Restore the SEQ QLD seed defaults. Custom blocks / bricks are removed."
      >
        <div className="flex gap-2 flex-wrap">
          <button
            type="button"
            onClick={() => {
              if (
                window.confirm(
                  'Reset the block library to SEQ QLD defaults? Custom blocks will be removed.'
                )
              ) {
                resetBlockLibrary()
              }
            }}
            className="px-3 py-1.5 rounded-md border border-ink-600 text-sm text-ink-200 hover:bg-ink-700 transition-colors"
          >
            ↺ Reset block library
          </button>
          <button
            type="button"
            onClick={() => {
              if (
                window.confirm(
                  'Reset the brick library to defaults? Custom brick types will be removed.'
                )
              ) {
                resetBrickLibrary()
              }
            }}
            className="px-3 py-1.5 rounded-md border border-ink-600 text-sm text-ink-200 hover:bg-ink-700 transition-colors"
          >
            ↺ Reset brick library
          </button>
          <button
            type="button"
            onClick={() => {
              if (window.confirm('Reset all settings to defaults?')) {
                resetUserSettings()
              }
            }}
            className="px-3 py-1.5 rounded-md border border-ink-600 text-sm text-ink-200 hover:bg-ink-700 transition-colors"
          >
            ↺ Reset settings
          </button>
        </div>
      </PanelCard>

      <PanelCard
        title="Danger zone"
        description="Permanent destructive actions — make sure you've exported anything you want to keep."
      >
        <button
          type="button"
          onClick={handleClearLocal}
          className="px-3 py-1.5 rounded-md border border-rose-500/40 text-sm text-rose-300 hover:bg-rose-500/10 transition-colors"
        >
          🗑 Clear all local data on this device
        </button>
      </PanelCard>
    </div>
  )
}
