import { Link, Outlet } from 'react-router-dom'
import { useState } from 'react'
import { useAuth, signOut } from '../lib/auth'
import BemeLogo from './BemeLogo'
import LeftNav from './LeftNav'

/** Primary app destinations shown in the mobile dropdown (the left rail is
 *  hidden below lg). Mirrors the LeftNav's primary surfaces. */
const MOBILE_NAV_ITEMS = [
  { to: '/', label: 'Dashboard' },
  { to: '/projects', label: 'Projects' },
  { to: '/library', label: 'Material library' },
  { to: '/guide', label: 'Guide' },
  { to: '/settings', label: 'Settings' },
]

/**
 * App-wide layout chrome for non-workspace pages.
 *
 * Pairs a persistent left nav rail with a full-width main column.
 * Used as a router LAYOUT route in App.tsx so that LeftNav stays
 * mounted across navigations between Dashboard / Projects / Library /
 * Guide / Settings - only <Outlet /> swaps. Without this, each page
 * wrapping itself in <AppShell> caused the whole tree (LeftNav
 * included) to unmount and remount on every click, producing the
 * "page flashes then continues" feel.
 *
 * Workspace pages (block / brick estimate) DON'T use this shell -
 * they need the full viewport for the canvas and have their own
 * contextual right rail. They mount their own LeftNav directly.
 *
 * Backwards-compatible - still accepts `children` so a page can
 * embed AppShell explicitly if it really wants to (rare; the layout-
 * route pattern is the normal path).
 *
 * Mobile fallback: when the left rail is hidden (<lg viewport), a
 * slim top brand bar appears so the user still has a way back to
 * the dashboard.
 */
export default function AppShell({
  children,
}: {
  children?: React.ReactNode
}) {
  const { signedIn } = useAuth()
  const [menuOpen, setMenuOpen] = useState(false)
  return (
    <div className="min-h-screen bg-ink-900 text-ink-50 flex relative overflow-hidden">
      {/* Decorative ambient orange wash - a wide, soft radial that
          fades in from the top-right corner of the main viewport.
          Pure aesthetic: gives the surface a warm anchor at the top
          so the brand colour reads as part of the environment
          rather than confined to small pill highlights.
          pointer-events-none so it never intercepts clicks; -z-0
          stacks it behind every content layer.
          Dark mode: higher alpha (10%) because the dark surface
          absorbs colour quickly. Light mode: lower alpha (4%) so
          the wash doesn't fight the cream background - over there
          the brand orange already reads more strongly against
          near-white, so a subtler tint is enough. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute top-0 right-0 w-[60%] h-[420px] bg-[radial-gradient(ellipse_at_top_right,rgba(255,122,45,0.10),transparent_60%)] light:bg-[radial-gradient(ellipse_at_top_right,rgba(255,122,45,0.04),transparent_60%)] z-0"
      />
      {/* Thin brand accent bar - 2px gradient stripe spanning the FULL
          viewport width, INCLUDING the LeftNav. Absolutely positioned
          so it overlays both the rail and the main column as one
          unbroken band instead of starting at the LeftNav's right
          edge. pointer-events-none + z-20 so it never intercepts
          clicks but sits above the LeftNav + content. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute top-0 left-0 right-0 h-[2px] bg-gradient-to-r from-beme-500 via-beme-400 to-transparent z-20"
      />
      {signedIn && <LeftNav />}
      <div className="flex-1 min-w-0 flex flex-col relative z-10">
        {/* Mobile top brand strip - only on narrow viewports (<lg)
            where the left rail is hidden. Keeps a clickable Beme
            mark so users can always get home. */}
        <header className="lg:hidden sticky top-0 z-30 border-b border-ink-700 bg-ink-800">
          <div className="flex items-center justify-between px-5 py-3">
            <Link
              to="/"
              className="flex items-center gap-2.5"
              onClick={() => setMenuOpen(false)}
            >
              <BemeLogo size={28} />
            </Link>
            {signedIn && (
              <button
                type="button"
                onClick={() => setMenuOpen((v) => !v)}
                aria-label={menuOpen ? 'Close menu' : 'Open menu'}
                aria-expanded={menuOpen}
                className="inline-flex items-center justify-center w-10 h-10 -mr-1 rounded-lg text-ink-300 hover:text-ink-50 hover:bg-ink-700/40 transition-colors"
              >
                {menuOpen ? (
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                ) : (
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                    <line x1="3" y1="6" x2="21" y2="6" />
                    <line x1="3" y1="12" x2="21" y2="12" />
                    <line x1="3" y1="18" x2="21" y2="18" />
                  </svg>
                )}
              </button>
            )}
          </div>
          {menuOpen && signedIn && (
            <nav className="absolute top-full left-0 right-0 border-b border-ink-700 bg-ink-800 shadow-lg shadow-black/10 flex flex-col py-2">
              {MOBILE_NAV_ITEMS.map((item) => (
                <Link
                  key={item.to}
                  to={item.to}
                  onClick={() => setMenuOpen(false)}
                  className="px-5 py-3 text-ink-100 hover:text-beme-500 font-medium transition-colors"
                >
                  {item.label}
                </Link>
              ))}
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false)
                  void signOut()
                }}
                className="mt-1 border-t border-ink-700 px-5 py-3 text-left text-ink-300 hover:text-beme-500 font-medium transition-colors"
              >
                Sign out
              </button>
            </nav>
          )}
        </header>
        <main className="flex-1 min-w-0">
          {/* Layout-route mode: render the matched child route via
              <Outlet />. Legacy mode: render children if a caller
              explicitly wrapped itself in <AppShell>. */}
          {children ?? <Outlet />}
        </main>
      </div>
    </div>
  )
}
