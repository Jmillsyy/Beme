import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useTheme } from '../lib/theme'
import { displayNameOf, initialsOf, signOut, useAuth } from '../lib/auth'
import { useUserSettings } from '../lib/userSettings'

/**
 * Resolve the personalised name shown in the header, in order of preference:
 *
 *   1. Organisation name — for org accounts (future)
 *   2. Business / company name from settings
 *   3. User's display name from settings
 *   4. User's signed-in name (from Microsoft OAuth metadata)
 *
 * Returns `null` when nothing's set — caller decides whether to render
 * anything. We deliberately don't fall back to a placeholder string; the
 * header looks cleaner with nothing there until the user types their name.
 */
function resolvePersonalisedName(opts: {
  business: { companyName: string }
  profile: { displayName: string }
  authUser: import('@supabase/supabase-js').User | null
}): string | null {
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
  const isLight = theme === 'light'

  const personalisedName = resolvePersonalisedName({
    business: settings.business,
    profile: settings.profile,
    authUser: user,
  })

  return (
    <header className="bg-ink-800 border-b border-ink-600">
      <div className="max-w-[1500px] mx-auto px-6 py-5 flex items-center justify-between gap-6">
        <Link to="/" className="flex items-center gap-3 group">
          <div className="relative w-[26px] h-[26px] rounded-[5px] bg-beme-500 group-hover:bg-beme-400 transition-colors">
            <div className="absolute inset-[5px] bg-ink-900 rounded-[2px]" />
          </div>
          <div className="leading-tight">
            <div className="text-2xl font-extrabold tracking-tight text-ink-50">Beme</div>
            <div className="text-[12px] text-ink-300">Building estimates made easy</div>
          </div>
        </Link>

        <div className="flex items-center gap-3">
          {/* Personalised tag — shows the company / profile / OAuth name
              when any of those are set. Stays hidden on first-run so the
              header doesn't read as a placeholder. */}
          {personalisedName && (
            <p
              className="text-[11px] text-ink-400 uppercase tracking-wider hidden md:block max-w-[260px] truncate"
              title={personalisedName}
            >
              {personalisedName}
            </p>
          )}

          {signedIn && user ? (
            <UserMenu user={user} />
          ) : (
            // Cog icon for signed-out users — still need access to settings.
            <Link
              to="/settings"
              title="Settings"
              aria-label="Settings"
              className="w-8 h-8 rounded-full border border-ink-600 text-ink-300 hover:bg-ink-700 hover:text-ink-100 transition-colors flex items-center justify-center text-sm"
            >
              ⚙
            </Link>
          )}

          <ThemeSwitch theme={theme} onToggle={() => setTheme(isLight ? 'dark' : 'light')} />
        </div>
      </div>
    </header>
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

  const name = displayNameOf(user)
  const initials = initialsOf(user)

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2.5 pl-1 pr-3 py-1 rounded-full border border-ink-600 hover:bg-ink-700 transition-colors"
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
            <span className="text-ink-400">⚙</span> Settings
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
      {/* Track icons */}
      <span className="absolute left-1.5 text-[12px] text-ink-400">🌙</span>
      <span className="absolute right-1.5 text-[12px] text-ink-400">☀️</span>
      {/* Thumb */}
      <span
        className="absolute top-0.5 left-0.5 w-6 h-6 rounded-full bg-beme-500 shadow-sm shadow-black/20 transition-transform duration-200 flex items-center justify-center text-[11px]"
        style={{ transform: isLight ? 'translateX(28px)' : 'translateX(0)' }}
      >
        {isLight ? '☀️' : '🌙'}
      </span>
    </button>
  )
}
