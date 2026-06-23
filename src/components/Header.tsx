import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import BemeMark from './BemeMark'
import { useTheme } from '../lib/theme'
import { displayNameOf, signOut, useAuth } from '../lib/auth'
import { useUserSettings } from '../lib/userSettings'
import { useOrganisations } from '../lib/organisations'
import { useOnlineStatus } from '../lib/useOnlineStatus'
import type { Organisation } from '../types/organisations'

/**
 * Resolve the personalised name shown in the header, in order of preference:
 *
 * 1. Current organisation name - when the user is acting inside an org.
 * 2. Business / company name from settings (personal/single-user mode).
 * 3. User's display name from settings.
 * 4. User's signed-in name (from Microsoft OAuth metadata).
 *
 * Returns `null` when nothing's set - caller decides whether to render
 * anything. We deliberately don't fall back to a placeholder string; the
 * header looks cleaner with nothing there until the user types their name.
 */
function resolvePersonalisedName(opts: {
  currentOrg: Organisation | null
  business: { companyName: string }
  profile: { displayName: string }
  authUser: import('@supabase/supabase-js').User | null
}): string | null {
  // Org accounts: the org name is always the right thing to surface.
  if (opts.currentOrg) return opts.currentOrg.name
  const company = opts.business.companyName.trim()
  if (company) return company
  const profile = opts.profile.displayName.trim()
  if (profile) return profile
  if (opts.authUser) {
    const oauthName = displayNameOf(opts.authUser).trim()
    if (oauthName) return oauthName
  }
  return null
}

/**
 * App-level top header shown on every page. Contains the Beme brand, a
 * personalised "Tailored for X" line (company → display name → OAuth name →
 * fallback), and the dark / light theme switch. When signed in, also shows
 * the user pill on the right.
 */
export default function Header() {
  const [theme, setTheme] = useTheme()
  const { user, signedIn } = useAuth()
  const { settings } = useUserSettings()
  const { organisations, currentOrg, setCurrentOrg } = useOrganisations()
  const isLight = theme === 'light'

  const personalisedName = resolvePersonalisedName({
    currentOrg,
    business: settings.business,
    profile: settings.profile,
    authUser: user,
  })

  return (
    <header className="bg-ink-800 border-b border-ink-600">
      {/* Full-width row at px-20 so the Beme logo + org/user pills sit at
          the same horizontal edges as the workspace canvas AND every
          dashboard page below. All page `<main>` containers now use
          `px-20` (no max-w cap) for the same reason - so the header's
          left/right edges line up with every page's content edges on
          monitors of any width. */}
      <div className="px-20 py-6 flex items-center justify-between gap-6">
        <Link to="/" className="flex items-center gap-3 group">
          <span className="text-beme-500 group-hover:text-beme-400 transition-colors inline-block">
            <BemeMark size={32} />
          </span>
          <div className="leading-tight">
            <div className="text-2xl font-extrabold tracking-tight text-ink-50">Beme</div>
            <div className="text-xs text-ink-300">Building estimates made easy</div>
          </div>
        </Link>

        <div className="flex items-center gap-3">
          {/* Offline indicator - only renders when navigator.onLine is
              false. Explains "why is my save failing" before the user has
              to discover it through a failed toast. */}
          <OfflinePill />

          {/* Org switcher - appears only when the user is signed in and
              belongs to at least one org. Single-org users see a static
              "ORG NAME" pill; multi-org users get a dropdown to switch. */}
          {signedIn && organisations.length > 0 && (
            <OrgSwitcher
              organisations={organisations}
              currentOrg={currentOrg}
              onSwitch={setCurrentOrg}
            />
          )}

          {/* Personalised tag - only shown when the user is NOT inside an
              org context (the org switcher already labels the workspace for
              org users). For single-user / personal mode it shows the
              company / profile / OAuth name when any of those are set. */}
          {!currentOrg && personalisedName && (
            <p
              className="text-[12px] text-ink-400 uppercase tracking-wider hidden md:block max-w-[260px] truncate"
              title={personalisedName}
            >
              {personalisedName}
            </p>
          )}

          {signedIn && user ? (
            <UserMenu user={user} />
          ) : (
            // Cog icon for signed-out users - still need access to settings.
            <Link
              to="/settings"
              title="Settings"
              aria-label="Settings"
              className="w-8 h-8 rounded-full border border-ink-600 text-ink-300 hover:bg-ink-700 hover:text-ink-100 transition-colors flex items-center justify-center text-sm"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
            </Link>
          )}

          <ThemeSwitch theme={theme} onToggle={() => setTheme(isLight ? 'dark' : 'light')} />
        </div>
      </div>
    </header>
  )
}

/**
 * Tiny pill that appears in the header when the device is offline.
 * Hidden when navigator.onLine is true (zero DOM weight in the common
 * case). The rose accent matches the toast system's error variant so
 * the offline / save-failed visual language stays consistent.
 */
function OfflinePill() {
  const online = useOnlineStatus()
  if (online) return null
  return (
    <span
      className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md border border-rose-500/40 bg-rose-500/10 text-[11px] text-rose-300"
      title="No internet connection - saves will retry once you're back online."
      role="status"
      aria-live="polite"
    >
      <span
        className="inline-block w-1.5 h-1.5 rounded-full bg-rose-500"
        aria-hidden
      />
      Offline
    </span>
  )
}

/**
 * Compact org pill in the header. Single-org users see a non-interactive
 * label; multi-org users get a dropdown so they can flip between (e.g.) the
 * supplier they work for and a personal sandbox org for testing.
 */
function OrgSwitcher({
  organisations,
  currentOrg,
  onSwitch,
}: {
  organisations: Organisation[]
  currentOrg: Organisation | null
  onSwitch: (orgId: string | null) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const navigate = useNavigate()
  const isMulti = organisations.length > 1

  useEffect(() => {
    if (!open) return
    function handleClick(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handleClick)
      document.removeEventListener('keydown', handleKey)
    }
  }, [open])

  const label = currentOrg?.name ?? 'Personal'

  if (!isMulti) {
    // One org → just show its name in a static pill. Saves a click and tells
    // the user where they are without offering a menu they don't need.
    return (
      <span
        className="hidden md:inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border border-ink-600 bg-ink-700/40 text-xs text-ink-100 max-w-[220px] truncate"
        title={label}
      >
        <span className="w-1.5 h-1.5 rounded-full bg-beme-500" />
        {label}
      </span>
    )
  }

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 px-2.5 py-1 rounded-full border border-ink-600 hover:bg-ink-700 text-xs text-ink-100 max-w-[220px]"
        aria-expanded={open}
        aria-haspopup="menu"
        title={label}
      >
        <span className="w-1.5 h-1.5 rounded-full bg-beme-500" />
        <span className="truncate">{label}</span>
        <span className="text-ink-400">▾</span>
      </button>
      {open && (
        <div className="absolute right-0 mt-2 w-64 rounded-lg border border-ink-600 bg-ink-800 shadow-xl shadow-black/40 z-30 py-1 text-sm">
          <div className="px-3 py-2 text-[11px] text-ink-400 uppercase tracking-wider">
            Organisations
          </div>
          {organisations.map((org) => (
            <button
              key={org.id}
              type="button"
              onClick={() => {
                onSwitch(org.id)
                setOpen(false)
              }}
              className={`w-full text-left px-4 py-2 hover:bg-ink-700 transition-colors flex items-center justify-between ${
                org.id === currentOrg?.id ? 'text-beme-300 font-medium' : 'text-ink-100'
              }`}
            >
              <span className="truncate">{org.name}</span>
              {org.id === currentOrg?.id && <span className="text-beme-300">✓</span>}
            </button>
          ))}
          <div className="border-t border-ink-600 my-1" />
          <button
            type="button"
            onClick={() => {
              setOpen(false)
              navigate('/settings')
            }}
            className="w-full text-left px-4 py-2 text-ink-100 hover:bg-ink-700 transition-colors text-xs"
          >
            Manage organisations →
          </button>
        </div>
      )}
    </div>
  )
}

/**
 * Signed-in user pill. Click for a dropdown with email + sign-out.
 */
function UserMenu({ user }: { user: import('@supabase/supabase-js').User }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const navigate = useNavigate()

  useEffect(() => {
    if (!open) return
    function handleClick(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handleClick)
      document.removeEventListener('keydown', handleKey)
    }
  }, [open])

  // Prefer the name the user set in Settings (Profile > display name), read
  // through the reactive settings hook so editing it updates the header
  // live. Falls back to the OAuth / email-derived name when blank.
  const { settings } = useUserSettings()
  const name = settings.profile.displayName.trim() || displayNameOf(user)
  const initials = (() => {
    const parts = name.split(/\s+/).filter(Boolean)
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
    return (parts[0]?.[0] ?? '?').toUpperCase()
  })()

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 pl-1 pr-3 py-0.5 rounded-full border border-ink-600 hover:bg-ink-700 transition-colors"
        aria-expanded={open}
        aria-haspopup="menu"
      >
        <span className="w-7 h-7 rounded-full bg-beme-500 text-black text-xs font-bold flex items-center justify-center">
          {initials}
        </span>
        <span className="text-sm text-ink-100 max-w-[160px] truncate hidden sm:inline">
          {name}
        </span>
        <span className="text-ink-400 text-xs">▾</span>
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-64 rounded-lg border border-ink-600 bg-ink-800 shadow-xl shadow-black/40 z-30 py-1 text-sm">
          <div className="px-4 py-3 border-b border-ink-600">
            <div className="font-semibold text-ink-50 truncate">{name}</div>
            <div className="text-xs text-ink-400 truncate">{user.email}</div>
          </div>
          <button
            type="button"
            onClick={() => {
              setOpen(false)
              navigate('/settings')
            }}
            className="w-full text-left px-4 py-2 text-ink-100 hover:bg-ink-700 transition-colors flex items-center gap-2"
          >
            Settings
          </button>
          <div className="border-t border-ink-600 my-1" />
          <button
            type="button"
            onClick={() => {
              setOpen(false)
              void signOut()
            }}
            className="w-full text-left px-4 py-2 text-ink-100 hover:bg-ink-700 transition-colors"
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  )
}

/**
 * Compact icon-toggle between dark (moon) and light (sun) themes.
 */
function ThemeSwitch({
  theme,
  onToggle,
}: {
  theme: 'dark' | 'light'
  onToggle: () => void
}) {
  const isLight = theme === 'light'
  return (
    <button
      type="button"
      role="switch"
      aria-checked={isLight}
      onClick={onToggle}
      title={isLight ? 'Switch to dark mode' : 'Switch to light mode'}
      className="relative inline-flex items-center h-8 w-[60px] rounded-full border border-ink-600 bg-ink-700/60 hover:bg-ink-700 transition-colors cursor-pointer"
    >
      {/* Thumb (slides left for dark, right for light; the title attr and
          position convey the state without an icon). */}
      <span
        className="absolute top-0.5 left-0.5 w-6 h-6 rounded-full bg-beme-500 shadow-sm shadow-black/20 transition-transform duration-200"
        style={{ transform: isLight ? 'translateX(28px)' : 'translateX(0)' }}
      />
    </button>
  )
}
