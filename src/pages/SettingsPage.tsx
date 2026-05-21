import { useCallback, useState } from 'react'
import { Link } from 'react-router-dom'
import Header from '../components/Header'
import {
  resetUserSettings,
  updateUserSettings,
  useUserSettings,
} from '../lib/userSettings'
import { useTheme } from '../lib/theme'
import { signOut, updateEmail, updatePassword, useAuth } from '../lib/auth'
import { isSupabaseConfigured } from '../lib/supabase'
import { resetBlockLibrary, useBlockLibrary } from '../data/blockLibrary'
import { resetBrickLibrary, useBrickLibrary } from '../data/brickLibrary'
import {
  useOrganisations,
  listOrgMembers,
  isCurrentUserOrgAdmin,
  removeOrgMember,
  updateOrgMemberRole,
} from '../lib/organisations'
import {
  createInvitation,
  inviteAcceptUrl,
  listInvitations,
  revokeInvitation,
  statusOf,
  type Invitation,
} from '../lib/invitations'
import { useEffect } from 'react'
import type { OrgMember, OrgRole } from '../types/organisations'
import { orgRoleLabel } from '../types/organisations'
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

type TabKey = 'profile' | 'business' | 'preferences' | 'defaults' | 'organisation' | 'account'

interface Tab {
  key: TabKey
  label: string
  description: string
  /** When set, the tab is hidden unless this predicate returns true. */
  showWhen?: (ctx: { hasOrg: boolean }) => boolean
}

const TABS: Tab[] = [
  { key: 'profile', label: 'Profile', description: 'You — name, contact, role' },
  { key: 'business', label: 'Business', description: 'Used on every quote you export' },
  { key: 'preferences', label: 'Preferences', description: 'Units, currency, date, theme' },
  { key: 'defaults', label: 'Defaults', description: 'Starting values for new estimates' },
  {
    key: 'organisation',
    label: 'Organisation',
    description: 'Members and roles in your team',
    // Only render the tab for users who actually belong to an org. Personal
    // single-user accounts (supply-and-lay bricklayers) don't need it.
    showWhen: ({ hasOrg }) => hasOrg,
  },
  { key: 'account', label: 'Account', description: 'Sign out, reset, danger zone' },
]

/**
 * The settings hub. Tabs along the left, panel on the right. Every change
 * persists immediately — no Save button. Studio Black themed throughout.
 */
export default function SettingsPage() {
  const { settings } = useUserSettings()
  const { currentOrg } = useOrganisations()
  const [activeTab, setActiveTab] = useState<TabKey>('profile')

  // Filter tabs by membership context — the Organisation tab disappears for
  // personal-only users so the rail doesn't show empty / inapplicable sections.
  const visibleTabs = TABS.filter(
    (t) => !t.showWhen || t.showWhen({ hasOrg: !!currentOrg })
  )

  return (
    <div className="min-h-screen bg-ink-900 text-ink-50">
      <Header />

      <main className="max-w-[1600px] mx-auto px-6 py-10">
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
            {visibleTabs.map((t) => {
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
            {activeTab === 'organisation' && <OrganisationTab />}
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

      {/* Regional features — toggle off line items that don't apply in your
          market. New brick projects pick up these defaults; per-project
          overrides are still available in the brick settings panel. */}
      <FieldGroup
        title="Regional features"
        description="Different markets use different masonry conventions. Turn off anything you don't price into your estimates and it'll be hidden from new project tallies and exports."
      >
        <Toggle
          label="Lintels"
          hint="Steel / concrete lintels over brick openings, or stood-up lintel blocks over block openings. US estimators often leave lintels to the structural engineer rather than the masonry takeoff."
          checked={preferences.regionalFeatures.lintels}
          onChange={(checked) =>
            set({
              regionalFeatures: {
                ...preferences.regionalFeatures,
                lintels: checked,
              },
            })
          }
        />
        <Toggle
          label="Brick ties"
          hint="Ties between brick veneer and structural backing in cavity walls. Universal in AU/UK/NZ/US but the rate per m² varies by code."
          checked={preferences.regionalFeatures.brickTies}
          onChange={(checked) =>
            set({
              regionalFeatures: {
                ...preferences.regionalFeatures,
                brickTies: checked,
              },
            })
          }
        />
        <Toggle
          label="Plascourse (DPC)"
          hint="Damp-proof course / plastic course at the base of brick walls. AU & UK terminology. US construction typically uses flashing membrane priced under sealants instead."
          checked={preferences.regionalFeatures.plascourse}
          onChange={(checked) =>
            set({
              regionalFeatures: {
                ...preferences.regionalFeatures,
                plascourse: checked,
              },
            })
          }
        />
      </FieldGroup>
    </PanelCard>
  )
}

/**
 * Simple labelled toggle row — matches the Field/FieldGroup styling but
 * uses a checkbox instead of a value input.
 */
function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string
  hint?: string
  checked: boolean
  onChange: (next: boolean) => void
}) {
  return (
    <label className="flex items-start gap-3 cursor-pointer py-2">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-1 w-4 h-4 accent-beme-500 cursor-pointer"
      />
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-ink-100">{label}</div>
        {hint && <div className="text-xs text-ink-400 mt-0.5">{hint}</div>}
      </div>
    </label>
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

// ─── Organisation ─────────────────────────────────────────────────────────

/**
 * Members and (eventually) settings for the user's current organisation.
 *
 * Reads the org context for the active org id, then fetches the live members
 * list from Supabase on mount. The fetch is intentionally not cached in the
 * org singleton — there isn't much value in keeping a copy around between
 * settings visits, and it stays fresh each time the user opens the tab.
 *
 * Adding / removing members from the UI is not wired up yet — that comes in
 * a follow-up. For now the page surfaces who's in the org and what role
 * they have, plus an "invite by email" hint pointing at the SETUP.md
 * provisioning steps (until self-serve invites are built).
 */
function OrganisationTab() {
  const { currentOrg } = useOrganisations()
  const { user } = useAuth()
  const [members, setMembers] = useState<OrgMember[]>([])
  const [loading, setLoading] = useState(true)
  const [isAdmin, setIsAdmin] = useState(false)
  // Per-row busy state for in-flight role changes / removals so we can
  // disable just the row being edited rather than the whole table.
  const [busyMemberId, setBusyMemberId] = useState<string | null>(null)
  const [memberError, setMemberError] = useState<string | null>(null)

  const refreshMembers = useCallback(async () => {
    if (!currentOrg) return
    const list = await listOrgMembers(currentOrg.id)
    setMembers(list)
  }, [currentOrg])

  useEffect(() => {
    let cancelled = false
    if (!currentOrg) return
    setLoading(true)
    Promise.all([
      listOrgMembers(currentOrg.id),
      isCurrentUserOrgAdmin(currentOrg.id),
    ])
      .then(([memberList, admin]) => {
        if (cancelled) return
        setMembers(memberList)
        setIsAdmin(admin)
        setLoading(false)
      })
      .catch(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [currentOrg])

  async function handleChangeRole(member: OrgMember, newRole: OrgRole) {
    if (newRole === member.role) return
    setBusyMemberId(member.id)
    setMemberError(null)
    try {
      await updateOrgMemberRole(member.id, newRole)
      await refreshMembers()
    } catch (err) {
      setMemberError((err as Error).message ?? 'Could not change role.')
    } finally {
      setBusyMemberId(null)
    }
  }

  async function handleRemoveMember(member: OrgMember) {
    const isSelf = member.userId === user?.id
    const label = member.displayName || member.email || 'this member'
    const msg = isSelf
      ? `Leave ${currentOrg?.name}? You'll lose access to its projects and requests until an admin re-invites you.`
      : `Remove ${label} from ${currentOrg?.name}? They'll lose access immediately. Existing estimate requests they were assigned to stay in place, just unattributed.`
    if (!window.confirm(msg)) return
    setBusyMemberId(member.id)
    setMemberError(null)
    try {
      await removeOrgMember(member.id)
      if (isSelf) {
        // Reload so the org context drops this org from the list and the
        // user lands back in personal mode / sign-in if it was their only
        // org.
        window.location.assign('/')
        return
      }
      await refreshMembers()
    } catch (err) {
      setMemberError((err as Error).message ?? 'Could not remove member.')
    } finally {
      setBusyMemberId(null)
    }
  }

  if (!currentOrg) {
    return (
      <PanelCard title="Organisation">
        <p className="text-sm text-ink-400">
          You're not signed in to an organisation. Personal projects live under your
          own account; nothing to manage here.
        </p>
      </PanelCard>
    )
  }

  return (
    <div className="space-y-6">
      <PanelCard
        title={currentOrg.name}
        subtitle="The workspace you and your teammates share. Estimate requests, projects, and branding all live here."
      >
        <FieldGroup>
          <Field label="Organisation name">
            <TextInput value={currentOrg.name} onChange={() => {}} disabled />
          </Field>
          <Field label="URL slug">
            <TextInput value={currentOrg.slug} onChange={() => {}} disabled />
          </Field>
        </FieldGroup>
        <p className="text-xs text-ink-400 mt-2">
          Renaming your organisation isn't available from the app yet. Ping the
          admin if you need it changed.
        </p>
      </PanelCard>

      <PanelCard
        title="Members"
        subtitle={`${members.length} ${members.length === 1 ? 'person' : 'people'} in ${currentOrg.name}.`}
      >
        {loading ? (
          <p className="text-sm text-ink-400">Loading members…</p>
        ) : members.length === 0 ? (
          <p className="text-sm text-ink-400">
            No members yet — that's unusual since you're seeing this page. Try
            refreshing.
          </p>
        ) : (
          <div className="border border-ink-600 rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-ink-700/40">
                <tr className="text-left text-xs uppercase tracking-wider text-ink-400">
                  <th className="px-3 py-2 font-semibold">Name</th>
                  <th className="px-3 py-2 font-semibold">Role</th>
                  <th className="px-3 py-2 font-semibold">Joined</th>
                  {isAdmin && (
                    <th className="px-3 py-2 font-semibold text-right">Actions</th>
                  )}
                </tr>
              </thead>
              <tbody>
                {members.map((m) => {
                  const isSelf = m.userId === user?.id
                  const rowBusy = busyMemberId === m.id
                  return (
                    <tr
                      key={m.id}
                      className="border-t border-ink-600 text-ink-100"
                    >
                      <td className="px-3 py-2">
                        <div className="font-medium text-ink-50">
                          {m.displayName || m.email || (
                            <span className="text-ink-400 italic">Member</span>
                          )}
                          {isSelf && (
                            <span className="ml-2 text-[10px] uppercase tracking-wider text-ink-400">
                              You
                            </span>
                          )}
                        </div>
                        {m.email && m.email !== m.displayName && (
                          <div className="text-xs text-ink-400">{m.email}</div>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        {isAdmin ? (
                          // Admins get an inline dropdown. The RPC blocks
                          // demoting the last admin, so the destructive
                          // case is server-enforced; we just surface the
                          // resulting error in memberError below.
                          <select
                            value={m.role}
                            onChange={(e) =>
                              handleChangeRole(m, e.target.value as OrgRole)
                            }
                            disabled={rowBusy}
                            className="px-2 py-1 rounded border border-ink-600 bg-ink-900 text-ink-50 text-xs focus:outline-none focus:border-beme-400 disabled:opacity-40"
                          >
                            <option value="admin">Admin</option>
                            <option value="staff">Staff</option>
                          </select>
                        ) : (
                          <span
                            className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                              m.role === 'admin'
                                ? 'bg-beme-500/15 text-beme-300 border border-beme-500/40'
                                : 'bg-ink-700 text-ink-200 border border-ink-600'
                            }`}
                          >
                            {orgRoleLabel(m.role)}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-xs text-ink-400">
                        {new Date(m.createdAt).toLocaleDateString()}
                      </td>
                      {isAdmin && (
                        <td className="px-3 py-2 text-right">
                          <button
                            type="button"
                            onClick={() => handleRemoveMember(m)}
                            disabled={rowBusy}
                            className="text-xs text-rose-300 hover:text-rose-200 disabled:opacity-40 disabled:cursor-not-allowed"
                          >
                            {rowBusy ? '…' : isSelf ? 'Leave org' : 'Remove'}
                          </button>
                        </td>
                      )}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        {memberError && (
          <p className="text-sm text-rose-300 mt-3">{memberError}</p>
        )}

        {!isAdmin && (
          <div className="mt-4 p-3 rounded-lg border border-ink-600 bg-ink-700/30 text-xs text-ink-300">
            <strong className="text-ink-100">Want to add a teammate?</strong>{' '}
            Ask an admin to send them an invite from this page.
          </div>
        )}
      </PanelCard>

      {/* Invite teammate — admins only. Workflow: admin types email + picks
          role, app creates the invitation row + builds the accept URL, admin
          copies the URL into Slack / email / wherever. The invitee opens the
          link, sets their password on /accept-invite, and lands in the org. */}
      {isAdmin && (
        <InvitationsPanel orgId={currentOrg.id} />
      )}
    </div>
  )
}

/**
 * Invite-teammate card. Lives at the bottom of the Organisation tab for
 * admins. Creates rows in `public.invitations` and shows the resulting
 * URL, plus a list of pending / used / expired invites so the admin can
 * see what's outstanding and revoke ones they shouldn't have sent.
 */
function InvitationsPanel({ orgId }: { orgId: string }) {
  const [invitations, setInvitations] = useState<Invitation[]>([])
  const [loading, setLoading] = useState(true)
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<OrgRole>('staff')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Most recently created invitation. Its row stays in the table below too,
  // but we surface the copy link inline above the form so the admin doesn't
  // have to hunt for the one they just made.
  const [justCreated, setJustCreated] = useState<Invitation | null>(null)
  // Tracks which invite is currently showing a "Copied!" tick instead of
  // the Copy button — clears itself after 1.5s.
  const [copiedId, setCopiedId] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    const list = await listInvitations(orgId)
    setInvitations(list)
    setLoading(false)
  }, [orgId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  async function handleCopy(token: string) {
    const url = inviteAcceptUrl(token)
    try {
      await navigator.clipboard.writeText(url)
    } catch {
      // Some browsers (older Safari over http) can't write to the clipboard
      // — fall back to a temporary textarea so we never silently fail.
      const ta = document.createElement('textarea')
      ta.value = url
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
    }
    setCopiedId(token)
    setTimeout(() => {
      setCopiedId((cur) => (cur === token ? null : cur))
    }, 1500)
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    if (creating || !email.trim()) return
    setCreating(true)
    setError(null)
    try {
      const inv = await createInvitation(orgId, email.trim(), role)
      setJustCreated(inv)
      setEmail('')
      // Pre-copy the link so the admin can paste straight into Slack/email
      // without an extra click. Falls back to manual copy via the Copy
      // button if the clipboard API rejects.
      await handleCopy(inv.id)
      await refresh()
    } catch (err) {
      setError((err as Error).message ?? 'Failed to create invitation')
    } finally {
      setCreating(false)
    }
  }

  async function handleRevoke(invitationId: string) {
    if (!window.confirm('Revoke this invitation? The link will stop working.')) return
    try {
      await revokeInvitation(invitationId)
      if (justCreated?.id === invitationId) setJustCreated(null)
      await refresh()
    } catch (err) {
      setError((err as Error).message ?? 'Failed to revoke')
    }
  }

  return (
    <PanelCard
      title="Invite a teammate"
      subtitle="Generate a link they can use to set their own password and join the org. Send it however suits — Slack, email, SMS."
    >
      <form onSubmit={handleCreate} className="grid grid-cols-1 sm:grid-cols-[1fr_180px_auto] gap-2 items-end">
        <Field label="Teammate email">
          <TextInput
            value={email}
            onChange={setEmail}
            placeholder="teammate@yourcompany.com.au"
            type="email"
          />
        </Field>
        <Field label="Role">
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as OrgRole)}
            className="w-full px-3 py-2 rounded-lg border border-ink-600 bg-ink-900 text-ink-50 text-sm focus:outline-none focus:border-beme-400"
          >
            <option value="staff">Staff</option>
            <option value="admin">Admin</option>
          </select>
        </Field>
        <button
          type="submit"
          disabled={creating || !email.trim()}
          className="px-4 py-2 rounded-lg bg-beme-500 text-black text-sm font-semibold hover:bg-beme-400 disabled:opacity-40 disabled:cursor-not-allowed transition-colors h-fit"
        >
          {creating ? 'Generating…' : 'Generate link'}
        </button>
      </form>

      {error && <p className="text-sm text-rose-300 mt-2">{error}</p>}

      {justCreated && (
        <div className="mt-4 p-3 rounded-lg border border-emerald-500/40 bg-emerald-500/10 text-sm text-emerald-100">
          <strong className="text-emerald-50">Invite link ready</strong>
          <p className="text-xs mt-1">
            Copied to your clipboard. Paste it to <strong>{justCreated.email}</strong>{' '}
            so they can set their password and sign in.
          </p>
          <div className="mt-2 flex items-center gap-2 flex-wrap">
            <code className="text-xs px-2 py-1 rounded bg-ink-900/50 text-ink-100 truncate max-w-[28rem] flex-1 min-w-0">
              {inviteAcceptUrl(justCreated.id)}
            </code>
            <button
              type="button"
              onClick={() => handleCopy(justCreated.id)}
              className="px-3 py-1 rounded border border-emerald-500/40 text-emerald-200 text-xs hover:bg-emerald-500/20 transition-colors"
            >
              {copiedId === justCreated.id ? 'Copied!' : 'Copy'}
            </button>
          </div>
        </div>
      )}

      {/* Existing invites — pending sit at top, used + expired below.
          Admin can copy a still-valid link or revoke any of them. */}
      <div className="mt-6">
        <h4 className="text-xs uppercase tracking-wider text-ink-400 mb-2">
          Pending + recent invites
        </h4>
        {loading ? (
          <p className="text-sm text-ink-400">Loading…</p>
        ) : invitations.length === 0 ? (
          <p className="text-sm text-ink-400">No invitations yet.</p>
        ) : (
          <div className="border border-ink-600 rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-ink-700/40">
                <tr className="text-left text-xs uppercase tracking-wider text-ink-400">
                  <th className="px-3 py-2 font-semibold">Email</th>
                  <th className="px-3 py-2 font-semibold">Role</th>
                  <th className="px-3 py-2 font-semibold">Status</th>
                  <th className="px-3 py-2 font-semibold text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {invitations.map((inv) => {
                  const status = statusOf(inv)
                  const statusClass =
                    status === 'pending'
                      ? 'bg-amber-500/15 text-amber-200 border-amber-500/40'
                      : status === 'used'
                        ? 'bg-emerald-500/15 text-emerald-200 border-emerald-500/40'
                        : 'bg-ink-700 text-ink-300 border-ink-600'
                  return (
                    <tr key={inv.id} className="border-t border-ink-600 text-ink-100">
                      <td className="px-3 py-2">
                        <div className="font-medium text-ink-50 truncate max-w-[18rem]">
                          {inv.email}
                        </div>
                        <div className="text-[11px] text-ink-400">
                          Sent {new Date(inv.createdAt).toLocaleDateString()}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-xs text-ink-300">
                        {orgRoleLabel(inv.role)}
                      </td>
                      <td className="px-3 py-2">
                        <span
                          className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${statusClass}`}
                        >
                          {status}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right">
                        <div className="inline-flex gap-2">
                          {status === 'pending' && (
                            <button
                              type="button"
                              onClick={() => handleCopy(inv.id)}
                              className="text-xs text-beme-300 hover:text-beme-200"
                            >
                              {copiedId === inv.id ? 'Copied!' : 'Copy link'}
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => handleRevoke(inv.id)}
                            className="text-xs text-rose-300 hover:text-rose-200"
                          >
                            {status === 'pending' ? 'Revoke' : 'Delete'}
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </PanelCard>
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

      {/* Email card — change the signed-in user's email address. Supabase
          sends a verification link to the new address; once clicked, the
          new email replaces the old for sign-in. */}
      {isSupabaseConfigured && signedIn && user && (
        <EmailCard currentEmail={user.email ?? ''} />
      )}

      {/* Password card — set or change the signed-in user's password.
          Works whether they originally signed in via magic link, Microsoft
          OAuth, or password. After setting, they can also use email +
          password to sign in alongside whatever they used first. */}
      {isSupabaseConfigured && signedIn && <PasswordCard />}

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

/**
 * Change the signed-in user's email address. Lives inside the Account tab,
 * directly below the account header so the user sees the email they're
 * currently signed in with and can edit it without scrolling. Submitting
 * triggers a Supabase verification email to the new address — until the
 * user clicks that link, sign-in keeps working with the old address.
 *
 * Heads-up displayed in the card: for users whose auth comes from
 * Microsoft OAuth, Supabase still accepts the update, but the next OAuth
 * sign-in will overwrite the email with whatever Microsoft sends — so
 * for those users the long-term fix is to update the email in their
 * Microsoft account rather than here.
 */
function EmailCard({ currentEmail }: { currentEmail: string }) {
  const [email, setEmail] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (submitting) return
    if (!email.trim()) {
      setError('Enter the new email you want to use.')
      return
    }
    if (email.trim().toLowerCase() === currentEmail.toLowerCase()) {
      setError("That's already the email on your account.")
      return
    }
    setSubmitting(true)
    setError(null)
    setSuccess(null)
    const { error: updateErr } = await updateEmail(email.trim())
    if (updateErr) {
      setError(updateErr.message)
      setSubmitting(false)
      return
    }
    setSuccess(
      `Verification email sent to ${email.trim()}. Click the link in it to switch over. You'll keep using ${currentEmail} to sign in until then.`
    )
    setEmail('')
    setSubmitting(false)
  }

  return (
    <PanelCard
      title="Email address"
      description="Change the email Beme uses to sign you in. We'll send a verification link to the new address — until you click it, your current email keeps working."
    >
      <div className="space-y-3 max-w-md">
        <div className="text-xs text-ink-300">
          Currently signed in as{' '}
          <span className="font-medium text-ink-50">{currentEmail || '(unknown)'}</span>
        </div>
        <form onSubmit={handleSubmit} className="space-y-3">
          <label className="block">
            <span className="text-xs text-ink-300 mb-1.5 inline-block">
              New email
            </span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              autoComplete="email"
              className="w-full px-3 py-2 rounded-lg border border-ink-600 bg-ink-900 text-ink-50 text-sm focus:outline-none focus:border-beme-400"
            />
          </label>

          {error && (
            <p className="text-sm text-rose-300 px-3 py-2 rounded-lg border border-rose-500/40 bg-rose-500/10">
              {error}
            </p>
          )}
          {success && (
            <p className="text-sm text-emerald-200 px-3 py-2 rounded-lg border border-emerald-500/40 bg-emerald-500/10">
              {success}
            </p>
          )}

          <button
            type="submit"
            disabled={submitting || !email.trim()}
            className="px-4 py-2 rounded-lg bg-beme-500 text-black text-sm font-semibold hover:bg-beme-400 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {submitting ? 'Sending…' : 'Send verification email'}
          </button>
        </form>
        <p className="text-[11px] text-ink-500">
          If you signed in with Microsoft, your email comes from Microsoft on
          every sign-in. Changing it here works, but the next Microsoft
          sign-in will overwrite it — update it in your Microsoft account
          for a permanent change.
        </p>
      </div>
    </PanelCard>
  )
}

/**
 * Set or change the signed-in user's password. Lives inside the Account tab.
 * Doesn't ask for the existing password — Supabase auth.updateUser trusts
 * the active session, and we treat session ownership as proof of identity
 * (someone with a stolen session can do worse things than change a
 * password). If a higher bar is needed later, gate this behind a fresh
 * sign-in or require the current password explicitly.
 */
function PasswordCard() {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (submitting) return
    if (password.length < 8) {
      setError('Password must be at least 8 characters.')
      return
    }
    if (password !== confirm) {
      setError("Passwords don't match.")
      return
    }
    setSubmitting(true)
    setError(null)
    setSuccess(false)
    const { error: updateErr } = await updatePassword(password)
    if (updateErr) {
      setError(updateErr.message)
      setSubmitting(false)
      return
    }
    // Clear the form so the user can see a fresh empty state if they
    // open it again; surfaces the success banner instead.
    setPassword('')
    setConfirm('')
    setSuccess(true)
    setSubmitting(false)
  }

  return (
    <PanelCard
      title="Password"
      description="Set a password so you can sign in with email + password as an alternative to magic links. Updating this won't affect your current session."
    >
      <form onSubmit={handleSubmit} className="space-y-3 max-w-md">
        <label className="block">
          <span className="text-xs text-ink-300 mb-1.5 inline-block">
            New password
          </span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="At least 8 characters"
            autoComplete="new-password"
            minLength={8}
            className="w-full px-3 py-2 rounded-lg border border-ink-600 bg-ink-900 text-ink-50 text-sm focus:outline-none focus:border-beme-400"
          />
        </label>
        <label className="block">
          <span className="text-xs text-ink-300 mb-1.5 inline-block">
            Confirm new password
          </span>
          <input
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
            minLength={8}
            className="w-full px-3 py-2 rounded-lg border border-ink-600 bg-ink-900 text-ink-50 text-sm focus:outline-none focus:border-beme-400"
          />
        </label>

        {error && (
          <p className="text-sm text-rose-300 px-3 py-2 rounded-lg border border-rose-500/40 bg-rose-500/10">
            {error}
          </p>
        )}
        {success && (
          <p className="text-sm text-emerald-200 px-3 py-2 rounded-lg border border-emerald-500/40 bg-emerald-500/10">
            Password saved. You can now sign in with email + password from the
            sign-in page.
          </p>
        )}

        <button
          type="submit"
          disabled={submitting || password.length < 8 || password !== confirm}
          className="px-4 py-2 rounded-lg bg-beme-500 text-black text-sm font-semibold hover:bg-beme-400 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {submitting ? 'Saving…' : 'Save password'}
        </button>
      </form>
    </PanelCard>
  )
}
