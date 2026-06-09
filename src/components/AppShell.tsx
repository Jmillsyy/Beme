import { Link } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import BemeMark from './BemeMark'
import LeftNav from './LeftNav'

/**
 * App-wide layout chrome for non-workspace pages.
 *
 * Pairs a persistent left nav rail with a full-width main column.
 * Replaces the previous top-header + right-sidebar pattern on
 * Dashboard, Projects, Library, Guide and Settings. Workspace
 * pages (block / brick estimate) DON'T use this shell — they need
 * the full viewport for the canvas and have their own contextual
 * right rail.
 *
 * Mobile fallback: when the left rail is hidden (<lg viewport), a
 * slim top brand bar appears so the user still has a way back to
 * the dashboard. Each consumer page can render its own page-level
 * heading inside the main column.
 *
 * Usage:
 *   <AppShell>
 *     <YourPageContent />
 *   </AppShell>
 */
export default function AppShell({ children }: { children: React.ReactNode }) {
  const { signedIn } = useAuth()
  return (
    <div className="min-h-screen bg-ink-900 text-ink-50 flex relative overflow-hidden">
      {/* Decorative ambient orange wash — a wide, soft radial that
          fades in from the top-right corner of the main viewport.
          Pure aesthetic: gives the surface a warm anchor at the top
          so the brand colour reads as part of the environment
          rather than confined to small pill highlights.
          pointer-events-none so it never intercepts clicks; -z-0
          stacks it behind every content layer.
          Dark mode: higher alpha (10%) because the dark surface
          absorbs colour quickly. Light mode: lower alpha (4%) so
          the wash doesn't fight the cream background — over there
          the brand orange already reads more strongly against
          near-white, so a subtler tint is enough. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute top-0 right-0 w-[60%] h-[420px] bg-[radial-gradient(ellipse_at_top_right,rgba(255,122,45,0.10),transparent_60%)] light:bg-[radial-gradient(ellipse_at_top_right,rgba(255,122,45,0.04),transparent_60%)] z-0"
      />
      {signedIn && <LeftNav />}
      <div className="flex-1 min-w-0 flex flex-col relative z-10">
        {/* Thin brand accent bar at the very top — a 2px gradient
            stripe across the main column. Subtle but unmistakably
            Beme; visually answers "what is this product?" before the
            user reads a single word of content. */}
        <div
          aria-hidden="true"
          className="h-[2px] bg-gradient-to-r from-beme-500 via-beme-400 to-transparent flex-shrink-0"
        />
        {/* Mobile top brand strip — only on narrow viewports (<lg)
            where the left rail is hidden. Keeps a clickable Beme
            mark so users can always get home. */}
        <header className="lg:hidden flex items-center justify-between px-5 py-3 border-b border-ink-700 bg-ink-900 sticky top-0 z-10">
          <Link to="/" className="flex items-center gap-2.5">
            <span className="text-beme-500 inline-block">
              <BemeMark size={28} />
            </span>
            <span className="text-base font-extrabold tracking-tight text-ink-50">
              Beme
            </span>
          </Link>
        </header>
        <main className="flex-1 min-w-0">
          {children}
        </main>
      </div>
    </div>
  )
}
