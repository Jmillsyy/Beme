import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import Header from '../components/Header'
import DonutChart from '../components/DonutChart'
import LocalMigrationBanner from '../components/LocalMigrationBanner'
import {
  type ProjectOutcome,
  type ProjectStatus,
  type SavedProject,
  deleteProject,
  duplicateProject,
  findProjectByReferenceNumber,
  getProject,
  listProjects,
  saveProject,
} from '../lib/projectStorage'
import { accountTypeOf, signOut, useAuth } from '../lib/auth'
import { useUserSettings } from '../lib/userSettings'
import { LIBRARY_TEMPLATES } from '../data/libraryTemplates'
import { analyseLibraryHealth, useBlockLibrary } from '../data/blockLibrary'
import { confirm } from '../lib/confirm'
import { ProjectRowSkeleton } from '../components/Skeleton'
import { toast } from '../lib/toast'
import { listOrgMembers, useOrganisations } from '../lib/organisations'
import type { OrgMember, Organisation } from '../types/organisations'

type Filter = 'all' | 'in-progress' | 'completed' | 'won' | 'lost' | 'pending'

/**
 * Which trades have content in this project. Wraps the post-migration
 * `trades` field with a fallback to the legacy `type` for any project
 * the migration somehow missed (defensive — shouldn't happen). If
 * neither is set the project is treated as block (the historical
 * default).
 */
function tradesOf(project: { type?: 'block' | 'brick'; trades?: ('block' | 'brick')[] }): ('block' | 'brick')[] {
  if (project.trades && project.trades.length > 0) return project.trades
  if (project.type) return [project.type]
  return ['block']
}

/**
 * Resolve the workspace URL for a project. With the unified workspace,
 * both block and brick projects open the same `PdfWorkspace` — the
 * route just picks the INITIAL trade. Users can switch trades inside the
 * workspace via the trade chip group. We pick the first trade in the
 * project's `trades` array as the initial.
 */
function projectUrl(project: { id: string; type?: 'block' | 'brick'; trades?: ('block' | 'brick')[] }): string {
  const trade = tradesOf(project)[0]
  return `/project/${trade}?id=${project.id}`
}

/**
 * Render a single trade pill for a project row.
 *   - Single trade (just block OR just brick) → coloured pill with
 *     that trade's name.
 *   - Both trades → ONE neutral-colour pill labelled "Brick and Block".
 *
 * Earlier this rendered two coloured pills side-by-side for unified
 * projects, which read as visual clutter. One combined label is
 * tidier and matches how the user thinks about the project.
 */
function TradeBadges({ trades }: { trades: ('block' | 'brick')[] }) {
  const isBoth = trades.includes('block') && trades.includes('brick')
  if (isBoth) {
    return (
      <span className="text-[10px] px-1.5 py-0.5 rounded uppercase tracking-wider font-semibold bg-ink-500/15 text-ink-200 border border-ink-500/30">
        Brick and Block
      </span>
    )
  }
  const single = trades[0] ?? 'block'
  return (
    <span
      className={`text-[10px] px-1.5 py-0.5 rounded uppercase tracking-wider font-semibold ${
        single === 'brick'
          ? 'bg-amber-500/15 text-amber-300 border border-amber-500/30'
          : 'bg-beme-500/15 text-beme-300 border border-beme-500/30'
      }`}
    >
      {single === 'brick' ? 'Brick' : 'Block'}
    </span>
  )
}

/**
 * Format a project's reference number as a 6-digit zero-padded string.
 * Values that overflow 6 digits (won't happen for a long time) just print
 * as-is rather than silently truncating. Mirrors the helper in ProjectBar
 * so the workspace and dashboard show the number identically.
 */
function formatRef(n: number): string {
  return n >= 100000 ? `${n}` : n.toString().padStart(6, '0')
}

/**
 * Cheap roll-up of a project's wall count and total run-length in
 * metres. Used by the dashboard cards to give each tile a glanceable
 * "size" beyond name + date — a 200-block apartment job should look
 * meaningfully different from a 12-block fence quote even before the
 * user opens it. Computed off `wallsByPage` (whatever's saved on the
 * project) without touching the calc engine.
 */
function projectMetrics(project: {
  wallsByPage?: Record<number, Array<{
    startX: number
    startY: number
    endX: number
    endY: number
  }>>
}): { wallCount: number; runMetres: number } {
  let wallCount = 0
  let totalMm = 0
  const pages = project.wallsByPage ?? {}
  for (const walls of Object.values(pages)) {
    for (const w of walls) {
      wallCount++
      const dx = w.endX - w.startX
      const dy = w.endY - w.startY
      totalMm += Math.sqrt(dx * dx + dy * dy)
    }
  }
  return { wallCount, runMetres: totalMm / 1000 }
}

/**
 * Trade → Tailwind class for the thin colour stripe down the left
 * edge of a project card. Mirrors the TradeBadges palette so the
 * stripe and the badge read as the same encoding.
 */
function tradeStripeClass(trades: ('block' | 'brick')[]): string {
  const isBoth = trades.includes('block') && trades.includes('brick')
  if (isBoth) return 'bg-gradient-to-b from-beme-500 to-amber-400'
  const t = trades[0] ?? 'block'
  return t === 'brick' ? 'bg-amber-400' : 'bg-beme-500'
}

/**
 * Compact owner-initial pip — round avatar with the user's display
 * name initials. Falls back to a single hyphen when no owner is
 * resolvable so the column alignment stays consistent.
 */
function OwnerPip({ name }: { name: string | null }) {
  const initials = (name ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0])
    .join('')
    .toUpperCase()
  return (
    <span
      className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-ink-700 border border-ink-500 text-[9px] font-semibold text-ink-200"
      title={name ? `Owner: ${name}` : 'Unowned'}
    >
      {initials || '–'}
    </span>
  )
}

function formatRelative(iso: string): string {
  const date = new Date(iso)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMin = Math.round(diffMs / 60000)
  if (diffMin < 1) return 'just now'
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHr = Math.round(diffMin / 60)
  if (diffHr < 24) return `${diffHr}h ago`
  const diffDay = Math.round(diffHr / 24)
  if (diffDay < 7) return `${diffDay}d ago`
  return date.toLocaleDateString()
}

function statusBadge(status: ProjectStatus) {
  if (status === 'completed') {
    return (
      <span className="text-[11px] px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/40 font-medium">
        Completed
      </span>
    )
  }
  return (
    <span className="text-[11px] px-2 py-0.5 rounded-full bg-beme-500/15 text-beme-300 border border-beme-500/40 font-medium">
      In progress
    </span>
  )
}

/** Cycle: undefined (pending) → 'won' → 'lost' → undefined */
function nextOutcome(o: ProjectOutcome | undefined): ProjectOutcome | undefined {
  if (o === undefined) return 'won'
  if (o === 'won') return 'lost'
  return undefined
}

/**
 * The dashboard branches at the top level: org users get the team layout
 * (project lists across the org, team-wide stats); personal / single-user
 * accounts keep the win-rate donut + per-project drill-down.
 *
 * Splitting the two layouts at the component boundary keeps each one simple —
 * trying to merge them led to a bunch of "this stat is only meaningful for
 * X" branches that obscured the actual UI.
 */
export default function HomePage() {
  const { signedIn, user, loading: authLoading } = useAuth()
  const { currentOrg, loading: orgsLoading } = useOrganisations()
  // Region picker used to auto-pop on the dashboard every signin when
  // no libraryTemplateKey was set, which doubled as a "refresh nag" —
  // the modal came back every reload until the user picked a template.
  // It's now only reachable via Settings → Switch template, so refresh
  // is silent and users opt in when they're ready.

  // Wait for both auth and org info to resolve before deciding which dashboard
  // to render. Otherwise the personal dashboard flashes on first paint for org
  // members (signedIn starts as false → personal-dashboard renders → auth and
  // orgs resolve → org-dashboard takes over a moment later).
  const stillResolving = authLoading || orgsLoading

  // 'org-invited' users (signed up via /accept-invite) never see the personal
  // dashboard — even when they're temporarily not in any org (just removed,
  // or invited to a new org but haven't accepted yet). They live in a
  // different product space than self-served personal users. 'personal'
  // users (legacy admins who signed themselves up before the invite flow
  // existed) keep the existing dual-mode behaviour: OrgDashboard when in an
  // org, PersonalDashboard when not.
  const accountType = accountTypeOf(user)
  const isOrgInvited = accountType === 'org-invited'

  return (
    <div className="min-h-screen bg-ink-900 text-ink-50">
      <Header />
      {/* Two-column dashboard: main content on the left, a sticky sidebar
          of quick links / shortcuts on the right (lg+ only).
          px-20 to match the header (and the workspace below) so the
          team-dashboard heading, project rows, and right rail all line
          up vertically with the Beme logo on the left and the user pill
          on the right — no inset "centred column" look on wide monitors. */}
      <main className="px-20 py-12">
        {signedIn && <LocalMigrationBanner />}
        {stillResolving ? (
          <div className="space-y-3 py-12">
            <div className="h-8 w-48 bg-ink-700/60 rounded-md animate-pulse mx-auto" />
            <div className="h-4 w-72 bg-ink-700/40 rounded-md animate-pulse mx-auto" />
          </div>
        ) : (
          <div className="flex flex-col lg:flex-row gap-8 items-start">
            <div className="flex-1 min-w-0 w-full">
              {currentOrg ? (
                <OrgDashboard org={currentOrg} userId={user?.id ?? null} />
              ) : isOrgInvited ? (
                <NoOrgEmptyState />
              ) : (
                <PersonalDashboard />
              )}
            </div>
            <DashboardSidebar isOrgUser={!!currentOrg} />
          </div>
        )}
      </main>

    </div>
  )
}

/**
 * Right rail on the dashboard — quick links into the parts of Beme that
 * don't have a natural surfacing on the dashboard itself, plus the team /
 * help shortcuts. Sticky on lg+ so it stays visible while the main column
 * scrolls. Stacks under the main content on smaller viewports.
 */
function DashboardSidebar({ isOrgUser }: { isOrgUser: boolean }) {
  // isOrgUser is no longer branched on inside this sidebar (the
  // org-only Start-a-new-estimate card moved to the dashboard's
  // stats row), but the prop is kept on the signature so the call
  // site doesn't need to change and so future org-gated rail content
  // doesn't have to re-thread it.
  void isOrgUser
  // Library health nudge. Mirrors the LibraryHealthBanner that already
  // surfaces on /library, but as a compact badge on the dashboard sidebar
  // card so the user is alerted to issues without having to navigate
  // there. Zero issues → no badge (card looks the same as before).
  // Errors take colour priority over warnings.
  const { library, version: libraryVersion } = useBlockLibrary()
  const healthChecks = useMemo(
    () => analyseLibraryHealth(library),
    [library, libraryVersion],
  )
  const errorCount = healthChecks.filter((c) => c.severity === 'error').length
  const warningCount = healthChecks.filter((c) => c.severity === 'warning').length
  const healthSummary =
    errorCount > 0
      ? {
          tone: 'error' as const,
          label: `${errorCount} issue${errorCount === 1 ? '' : 's'}`,
          tooltip: `Your block library has ${errorCount} unresolved issue${errorCount === 1 ? '' : 's'} that will affect the calc engine. Click to review.`,
        }
      : warningCount > 0
        ? {
            tone: 'warning' as const,
            label: `${warningCount} to review`,
            tooltip: `Your block library has ${warningCount} advisor${warningCount === 1 ? 'y' : 'ies'}. Click to review.`,
          }
        : null

  return (
    <aside className="w-full lg:w-[260px] lg:flex-shrink-0 lg:sticky lg:top-8 space-y-3">
      {/* "+ New estimate" used to live up here as the rail's first
          card. It's been promoted to a tile in the dashboard's stats
          row so the create action sits flush with the In progress /
          Completed-this-week numbers — one eye-sweep across the top
          of the page. The rail now leads with Material library. */}

      {/* Material library — the next-most-frequent destination from the
          dashboard (users tune blocks, bricks, and supply items between
          projects). On the org dashboard it sits below the estimate-start
          card so the create actions get the prime spot. On the personal
          dashboard it's the top-of-rail card since estimate-start is
          already in the body.

          Visual treatment: a thin orange accent bar on the left, no
          heavy border ring / glow. Earlier it had a 2px beme-500
          border and shadow, which made it look like a primary CTA
          competing with "+ New estimate". The accent bar alone keeps
          it discoverable without shouting. */}
      <div className="border border-ink-600 rounded-xl bg-ink-800/60 p-3">
        <Link
          to="/library"
          title={healthSummary?.tooltip}
          className="px-3 py-3 rounded-lg bg-ink-900 border border-ink-600 hover:border-beme-500 hover:bg-ink-800 transition-colors group flex items-center gap-3"
        >
          <span
            className="inline-block w-1 h-10 rounded-full bg-beme-500 flex-shrink-0"
            aria-hidden
          />
          <div className="flex-1 text-left min-w-0">
            <div className="font-bold text-sm leading-tight text-ink-50 flex items-center gap-2">
              <span>Material library</span>
              {/* Health-issue badge — only renders when there's at least
                  one error or warning. Errors take colour priority. */}
              {healthSummary && (
                <span
                  className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono font-semibold ${
                    healthSummary.tone === 'error'
                      ? 'bg-rose-500/20 text-rose-200 border border-rose-500/40'
                      : 'bg-amber-500/20 text-amber-200 border border-amber-500/40'
                  }`}
                  aria-label={healthSummary.tooltip}
                >
                  <span
                    className={`inline-block w-1.5 h-1.5 rounded-full ${
                      healthSummary.tone === 'error' ? 'bg-rose-400' : 'bg-amber-400'
                    }`}
                  />
                  {healthSummary.label}
                </span>
              )}
            </div>
            <div className="text-[11px] text-ink-300 group-hover:text-ink-200 mt-0.5">
              Blocks, bricks, supply items
            </div>
          </div>
          <span className="text-ink-400 group-hover:text-beme-500 transition-colors">→</span>
        </Link>
      </div>

      {/* Find by reference number — every project has a 6-digit ID stamped
          on its exported PDF + project bar. The estimator (or sales person)
          types the number a customer quotes them over the phone, hits
          Enter, and lands on the project. Lives in the rail next to
          Shortcuts because it's a navigation aid, not a primary action. */}
      <FindByReferenceCard />

      {/* Active region template — surfaces which seed template the user
          picked at sign-up (or last switched to via Settings). Small,
          but useful when a teammate is helping over the phone ("which
          library are you on, UK or AU?"). */}
      <ActiveTemplateCard />

      {/* Shortcuts — secondary nav into the parts of Beme that don't
          have a natural surfacing on the dashboard itself. Below "Start
          something new" so the create actions get the prime real estate. */}
      <div className="border border-ink-600 rounded-xl bg-ink-800/60 overflow-hidden">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-400 px-4 pt-3 pb-2">
          Shortcuts
        </h3>
        <nav className="flex flex-col">
          {/* Material library used to live here as a SidebarLink — promoted
              to the rail's top card so the Shortcuts list stays tight and
              the library is one click away from any dashboard view. */}
          <SidebarLink to="/guide" title="Beme guide" desc="Full walkthrough + shortcuts" />
          <SidebarLink to="/settings" title="Settings" desc="Defaults, regional features, theme" />
        </nav>
      </div>

      {/* Tip of the day — a rotating quick-tip / shortcut. Keeps the rail
          alive without surfacing primary actions, and is the single
          place users discover keyboard / drawing shortcuts that would
          otherwise live buried in the guide. */}
      <TipCard />

      {/* Tiny credits / version badge so the rail doesn't end abruptly.
          Updates the user's sense of where they are in the product
          (build / branch / status) without taking attention. */}
      <div className="text-[11px] text-ink-500 px-4">
        Beme · Building estimates made easy
      </div>
    </aside>
  )
}

/**
 * Sidebar lookup card — type a project's 6-digit reference number, hit
 * Enter, land on the project. The reference number is stamped on every
 * exported PDF + shown in the workspace project bar, so this is the
 * fastest path "customer quotes me a number on the phone → I'm in the
 * project."
 */
function FindByReferenceCard() {
  const navigate = useNavigate()
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    const cleaned = value.trim().replace(/^#/, '').replace(/\s+/g, '')
    const n = Number(cleaned)
    if (!Number.isInteger(n) || n <= 0) {
      setError('Reference numbers are 6 digits, e.g. 100123.')
      return
    }
    setBusy(true)
    try {
      const hit = await findProjectByReferenceNumber(n)
      if (!hit) {
        setError(`No project found with reference #${cleaned}.`)
        return
      }
      const url = projectUrl(hit)
      navigate(url)
    } catch (err) {
      setError((err as Error).message ?? 'Lookup failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="border border-ink-600 rounded-xl bg-ink-800/60 p-4 space-y-2"
    >
      <h3 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-400">
        Find by reference
      </h3>
      <div className="flex items-stretch gap-2">
        <div className="flex items-center px-2 rounded-l-md border border-ink-600 border-r-0 bg-ink-800 text-ink-400 text-sm">
          #
        </div>
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          inputMode="numeric"
          placeholder="100123"
          className="flex-1 min-w-0 px-2 py-1.5 rounded-r-md border border-ink-600 bg-ink-900 text-ink-50 text-sm tabular-nums focus:outline-none focus:border-beme-500"
        />
        <button
          type="submit"
          disabled={busy || value.trim().length === 0}
          className="px-3 py-1.5 rounded-md bg-beme-500 text-black text-sm font-semibold hover:bg-beme-400 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {busy ? '…' : 'Open'}
        </button>
      </div>
      {error ? (
        <p className="text-xs text-rose-300">{error}</p>
      ) : (
        <p className="text-[11px] text-ink-500">
          6-digit number from any Beme-exported PDF.
        </p>
      )}
    </form>
  )
}

/**
 * Active region template — surfaces which library seed the user picked
 * (AU-SEQ, US-CMU, UK-Block, blank). Click-through opens the library
 * page where the template controls live. Falls back to "AU-SEQ" for
 * legacy users who pre-date the libraryTemplateKey field — that matches
 * the pre-region default.
 */
function ActiveTemplateCard() {
  const { settings } = useUserSettings()
  const key = settings.preferences.libraryTemplateKey ?? 'au-seq'
  const template = LIBRARY_TEMPLATES.find((t) => t.key === key)
  const displayName = template?.displayName ?? 'Australia (SEQ)'
  const region = template?.region ?? 'AU-SEQ'

  return (
    <div className="border border-ink-600 rounded-xl bg-ink-800/60 p-3">
      <div className="flex items-center justify-between mb-1.5">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-400">
          Active template
        </h3>
        <Link
          to="/library"
          className="text-[11px] text-beme-500 hover:text-beme-400 hover:underline"
          title="Switch template in the Material library"
        >
          Switch
        </Link>
      </div>
      <div className="text-sm font-medium text-ink-100 truncate">
        {displayName}
      </div>
      <div className="text-[11px] text-ink-500 mt-0.5">{region}</div>
    </div>
  )
}

/**
 * Tip card — a rotating one-liner with a keyboard / drawing shortcut.
 * Keeps the rail visually balanced and is the natural surface for
 * discoverability: users learn shortcuts gradually as they see them.
 * Tips rotate on every component mount (i.e. every dashboard visit)
 * so a long session doesn't see the same tip ten times.
 */
function TipCard() {
  const tips = [
    {
      title: 'Jump anywhere fast',
      body: 'Press Cmd+K (or Ctrl+K on Windows) to open the command palette — projects, library, settings, all searchable.',
    },
    {
      title: 'See every shortcut',
      body: 'Press ? anywhere to open the keyboard shortcut reference.',
    },
    {
      title: 'Type a wall length',
      body: 'While drawing a wall, just type the length in mm and press Enter to drop it.',
    },
    {
      title: 'Esc cancels anything',
      body: 'Pressing Esc clears the current tool — drawing, ruler, opening, pier, control joint.',
    },
    {
      title: 'Delete to remove',
      body: 'Select a wall, opening, or pier and press Delete (or Backspace) to remove it.',
    },
    {
      title: 'Snap to wall faces',
      body: 'New walls snap to the 4 faces of any nearby wall — corners and butt joints just work.',
    },
    {
      title: 'Reference numbers',
      body: 'Every exported PDF stamps a 6-digit ref. Type it in the rail to jump straight back.',
    },
    {
      title: 'Click a card to activate',
      body: 'In the workspace, click any wall or pier type card to make it the active type for the next thing you draw.',
    },
  ]
  const tip = useMemo(() => tips[Math.floor(Math.random() * tips.length)], [])
  return (
    <div className="border border-ink-600 rounded-xl bg-ink-800/60 p-3">
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-beme-500">
          Tip
        </span>
        <span className="text-[11px] text-ink-400 truncate">· {tip.title}</span>
      </div>
      <p className="text-[11px] text-ink-300 leading-snug">{tip.body}</p>
    </div>
  )
}

/**
 * One row in the dashboard sidebar's Shortcuts list. Borderless on top so
 * each row reads as a section in a list rather than a card of its own.
 */
function SidebarLink({
  to,
  title,
  desc,
}: {
  to: string
  title: string
  desc: string
}) {
  return (
    <Link
      to={to}
      className="flex items-start gap-3 px-4 py-2.5 hover:bg-ink-700/60 border-t border-ink-700/60 first:border-t-0 transition-colors group"
    >
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-ink-100 group-hover:text-beme-500 transition-colors">
          {title}
        </div>
        <div className="text-xs text-ink-400 mt-0.5">{desc}</div>
      </div>
      <span className="text-ink-500 group-hover:text-beme-500 transition-colors">→</span>
    </Link>
  )
}

/**
 * Shown to an 'org-invited' user when they're not currently a member of any
 * organisation — either because they were removed, or their invitation to
 * a new org is still pending. Deliberately doesn't fall through to the
 * personal-projects flow because that's a different product entirely
 * (separate billing track in the longer term).
 */
function NoOrgEmptyState() {
  return (
    <div className="max-w-xl mx-auto py-12">
      <div className="border border-ink-600 rounded-2xl bg-ink-800 p-8 text-center">
        <div className="mx-auto w-14 h-14 rounded-xl bg-beme-500/15 border border-beme-500/40 flex items-center justify-center mb-4">
          <span className="text-2xl">📭</span>
        </div>
        <h2 className="text-2xl font-extrabold tracking-tight text-ink-50 mb-2">
          You're not in any organisation
        </h2>
        <p className="text-sm text-ink-300 mb-6">
          Your account was set up via an invitation, so you'll see work
          here once an admin adds you to an organisation. If you were
          recently removed or expected to be a member already, reach out
          to whoever runs your team — they can send a fresh invite link.
        </p>
        <button
          type="button"
          onClick={() => void signOut()}
          className="px-4 py-2 rounded-lg border border-ink-600 text-ink-200 hover:bg-ink-700 text-sm transition-colors"
        >
          Sign out
        </button>
      </div>
    </div>
  )
}

// ============================================================================
// Org dashboard — what an ABC employee sees
// ============================================================================

/**
 * Org-aware dashboard. Projects-led now that the estimate-request /
 * inbox flow has been removed — users share work by handing over a
 * 6-digit reference number, not by routing it through an inbox.
 *
 * Layout:
 *   - Title row + actions ("+ New estimate" is the primary action;
 *     no request-creation surface any more).
 *   - Stats row: in-progress + completed-this-week. Both sourced from
 *     PROJECTS.
 *   - "Your projects" — projects this user started.
 *   - "Team projects" — active projects belonging to other org members,
 *     so an admin can see the team's load at a glance.
 *   - "Recently completed" — last few finished projects across the team.
 */
function OrgDashboard({ org, userId }: { org: Organisation; userId: string | null }) {
  const [members, setMembers] = useState<OrgMember[]>([])
  // All projects visible to the user — both org-scoped (everyone on the team
  // sees them) and personal (their own).
  const [projects, setProjects] = useState<SavedProject[]>([])
  const [, setLoading] = useState(true)

  // Wrapped in useCallback so the focus / visibility listeners below
  // can reuse the same loader without re-creating it on every render.
  // The org id is the only dependency that determines what to fetch.
  const reloadDashboard = useCallback(() => {
    let cancelled = false
    setLoading(true)
    Promise.all([
      listOrgMembers(org.id),
      // listProjects returns every project this user can see (their own +
      // any org-scoped project where they're a member). Cloud RLS does
      // the filtering server-side so anyone in the org sees the same set.
      listProjects(),
    ])
      .then(([mems, projs]) => {
        if (cancelled) return
        setMembers(mems)
        setProjects(projs)
        setLoading(false)
      })
      .catch(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [org.id])

  useEffect(() => {
    const cancel = reloadDashboard()
    return cancel
  }, [reloadDashboard])

  // Refresh whenever the window regains focus or the tab becomes
  // visible. Catches the common workflow where the user marks a
  // project complete in the workspace and navigates back to the
  // dashboard — without this, the stats stayed stale until a hard
  // reload. Same handler covers the multi-device case: tab away to
  // a different machine, come back, see the up-to-date numbers.
  useEffect(() => {
    const refresh = () => {
      // Skip when the tab is hidden — no point fetching if the user
      // isn't looking. The next visibility change will pick it up.
      if (document.visibilityState !== 'visible') return
      reloadDashboard()
    }
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [reloadDashboard])

  // Member lookup for creator name display on project rows.
  const memberById = useMemo(() => {
    const m = new Map<string, OrgMember>()
    for (const x of members) m.set(x.userId, x)
    return m
  }, [members])

  // Stats: in-progress + completed-this-week, both sourced from
  // PROJECTS. Pending / inbox tiles are gone with the request system —
  // projects are the only thing that exists now.
  const stats = useMemo(() => {
    const inProgress = projects.filter((p) => p.status === 'in-progress').length
    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000
    const completedThisWeek = projects.filter(
      (p) =>
        p.status === 'completed' &&
        p.completedAt &&
        new Date(p.completedAt).getTime() >= weekAgo
    ).length
    // "Stale" — in-progress projects that haven't been touched in 5+
    // days. Surfaces work that's drifting before it slips entirely.
    const staleCutoff = Date.now() - 5 * 24 * 60 * 60 * 1000
    const stale = projects.filter(
      (p) =>
        p.status === 'in-progress' &&
        new Date(p.updatedAt).getTime() < staleCutoff
    ).length
    return { inProgress, completedThisWeek, stale }
  }, [projects])

  // Split the in-progress projects into 'mine' (above) and 'team' (below) so
  // the user's own work is the FIRST thing they see in the project list.
  //
  // 'mine' = projects where the user is the OWNER (i.e. they created the
  //          underlying estimate request, or they started a direct '+ Brick /
  //          + Block' project) OR they're the current assignee of the linked
  //          estimate request (i.e. they were allocated to work on it,
  //          regardless of who created it).
  //
  // Split in-progress projects into 'mine' vs 'team'. With the inbox
  // flow gone, ownership is solely creator/owner — no assignee
  // augmentation. Most recent first within each bucket.
  const { myProjects, teamProjects } = useMemo(() => {
    const sortRecent = (a: SavedProject, b: SavedProject) =>
      new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    const all = projects.filter((p) => p.status === 'in-progress')
    const mine: SavedProject[] = []
    const team: SavedProject[] = []
    for (const p of all) {
      const owner = p.ownerUserId ?? p.createdByUserId ?? null
      const isOwner = !!userId && owner === userId
      if (isOwner) mine.push(p)
      else team.push(p)
    }
    return { myProjects: mine.sort(sortRecent), teamProjects: team.sort(sortRecent) }
  }, [projects, userId])

  // Team-wide "shipped in the last 7 days" feed — projects only. NOT
  // sliced here; the CompletedColumn slices to its own slotCount so
  // it can compute overflow and surface a "View all N →" link.
  const recentlyCompleted = useMemo(() => {
    const weekAgoMs = Date.now() - 7 * 24 * 60 * 60 * 1000
    const withinPastWeek = (iso: string | undefined) => {
      if (!iso) return false
      const t = new Date(iso).getTime()
      return Number.isFinite(t) && t >= weekAgoMs
    }
    return projects
      .filter(
        (p) =>
          p.status === 'completed' && withinPastWeek(p.completedAt ?? p.updatedAt)
      )
      .sort(
        (a, b) =>
          new Date(b.completedAt ?? b.updatedAt).getTime() -
          new Date(a.completedAt ?? a.updatedAt).getTime()
      )
  }, [projects])

  // Look up the current user in the org's member list to surface a real
  // display name in the welcome strip. Falls back to the email local-part,
  // then to "there" if neither is available.
  const currentMember = useMemo(
    () => members.find((m) => m.userId === userId) ?? null,
    [members, userId]
  )
  const userDisplayName =
    currentMember?.displayName ||
    (currentMember?.email ? currentMember.email.split('@')[0] : null)

  return (
    <>
      <div className="flex items-end justify-between flex-wrap gap-4 mb-2">
        <div>
          <h2 className="text-3xl font-extrabold tracking-tight text-ink-50">
            Team dashboard
          </h2>
          <p className="text-ink-300 text-sm mt-1">
            In-progress jobs and recent wins across {org.name}.
          </p>
        </div>
        <WelcomeStrip
          name={userDisplayName}
          actionItems={myProjects.length}
          actionLabel={
            myProjects.length === 1 ? 'project on the go' : 'projects on the go'
          }
        />
      </div>

      {/* ── Stats strip + New-estimate CTA ──
          Three read-only stat tiles followed by the primary "+ New
          estimate" CTA tile sitting flush with them. "Stale" surfaces
          in-progress work that's drifted past 5 days, so the user
          spots stalled jobs at a glance instead of having to scan the
          list dates. Stacks to 2-up on small screens. */}
      <section className="mt-6 grid grid-cols-2 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <StatTile label="In progress" value={stats.inProgress} accent="beme" />
        <StatTile
          label="Completed this week"
          value={stats.completedThisWeek}
          accent="emerald"
        />
        <StatTile
          label="Stale &gt; 5 days"
          value={stats.stale}
          accent="amber"
          sub={
            stats.stale > 0
              ? `Last touch over 5 days ago`
              : `All active work is fresh`
          }
        />
        <NewEstimateTile />
      </section>

      {/* ── Your projects ──
          Two side-by-side columns: the user's own active projects on
          the left, the rest of the team's on the right. Capped at 4 each
          so the row stays a clean glance — a "View all →" link surfaces
          below the column when there's more. Stacks vertically on
          narrow viewports so the rows don't squash. Hidden entirely
          when neither column has any work. */}
      {/* ── Project lists — three columns side by side ──
          Your projects · Your team's projects · Recently completed.
          Each column is capped at 3 rows so the entire dashboard
          (header + stats row + this grid) fits a 13" MacBook Pro
          viewport. Overflow surfaces via per-column "View all" links.
          Stacks vertically on narrow viewports. */}
      {(() => {
        const COLUMN_CAP = 3
        const slotCount = Math.min(
          COLUMN_CAP,
          Math.max(
            myProjects.length,
            teamProjects.length,
            recentlyCompleted.length,
            1
          )
        )
        return (
          <section className="mt-8 grid grid-cols-1 lg:grid-cols-3 gap-x-6 gap-y-8 items-start">
            <ProjectsColumn
              title="Your projects"
              projects={myProjects}
              viewAllHref={`/projects?status=in-progress${
                userId ? `&owner=${userId}` : ''
              }`}
              members={members}
              currentUserId={userId}
              slotCount={slotCount}
              emptyCopy="No personal projects on the go — kick one off above."
            />
            <ProjectsColumn
              title="Your team's projects"
              projects={teamProjects}
              viewAllHref="/projects?status=in-progress"
              members={members}
              currentUserId={userId}
              slotCount={slotCount}
              emptyCopy="Quiet over here — your team's caught up."
            />
            <CompletedColumn
              title="Recently completed"
              projects={recentlyCompleted}
              viewAllHref="/projects?status=completed"
              slotCount={slotCount}
              emptyCopy="Nothing finished by the team this week."
            />
          </section>
        )
      })()}

      {/* Material library and Beme guide tiles have been promoted to the
          dashboard sidebar (right rail). They were big banner cards down
          here; relocating them frees vertical space and gives them a
          permanent, always-visible spot. */}
    </>
  )
}


/**
 * One column inside the side-by-side "Your projects" / "Your team's
 * projects" dashboard grid. Renders a section header, the project
 * count chip, up to `slotCount` rows, and a "View all →" link below
 * when there are more projects than visible slots.
 *
 * `slotCount` is computed by the caller off the busier column so both
 * sides render the same number of slots — empty slots become dashed-
 * border placeholders so the grid stays visually balanced even when
 * one side is much quieter than the other. When the column has no
 * projects at all, the first placeholder carries an `emptyCopy`
 * message instead of being a silent dash.
 */
function ProjectsColumn({
  title,
  projects,
  viewAllHref,
  members,
  currentUserId,
  slotCount,
  emptyCopy,
}: {
  title: string
  projects: SavedProject[]
  viewAllHref: string
  members: OrgMember[]
  currentUserId: string | null
  slotCount: number
  emptyCopy: string
}) {
  const visible = projects.slice(0, slotCount)
  const fillerCount = Math.max(0, slotCount - visible.length)
  const overflow = projects.length - visible.length
  return (
    <div>
      <div className="flex items-center justify-between mb-3 gap-3">
        <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-ink-400">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-beme-500" aria-hidden="true" />
          {title}
        </h3>
        <span className="text-xs text-ink-400 whitespace-nowrap">
          {projects.length}{' '}
          {projects.length === 1 ? 'project' : 'projects'} on the go
        </span>
      </div>
      <ul className="space-y-2">
        {visible.map((p) => (
          <ProjectInProgressRow
            key={p.id}
            project={p}
            members={members}
            currentUserId={currentUserId}
          />
        ))}
        {Array.from({ length: fillerCount }).map((_, i) => (
          <li key={`filler-${i}`}>
            {/* Dashed placeholder slot. Matches ProjectInProgressRow's
                outer shape + min-height so both columns line up cell
                for cell. First filler in an EMPTY column carries the
                section's copy so the user sees a friendly explanation
                instead of a silent dash.

                Border + background bumped a notch so the placeholder
                reads as "an intentional empty slot" rather than
                vanishing into the page background — was almost
                invisible at ink-700/60 + ink-800/20. */}
            <div className="border border-dashed border-ink-500/70 rounded-lg bg-ink-800/60 px-4 py-3 min-h-[124px] flex items-center justify-center text-center">
              <span className="text-xs text-ink-300">
                {i === 0 && visible.length === 0 ? emptyCopy : '—'}
              </span>
            </div>
          </li>
        ))}
      </ul>
      {overflow > 0 && (
        <Link
          to={viewAllHref}
          className="mt-2 inline-flex items-center gap-1 text-xs text-beme-500 hover:text-beme-400"
        >
          View all {projects.length} →
        </Link>
      )}
    </div>
  )
}

/**
 * Recently-completed column — sister of {@link ProjectsColumn} that
 * renders {@link CompletedProjectCard} tiles instead of in-progress
 * rows. Same header + slot-count + filler + View-all flow so all
 * three dashboard columns read as one unified grid.
 */
function CompletedColumn({
  title,
  projects,
  viewAllHref,
  slotCount,
  emptyCopy,
}: {
  title: string
  projects: SavedProject[]
  viewAllHref: string
  slotCount: number
  emptyCopy: string
}) {
  const visible = projects.slice(0, slotCount)
  const fillerCount = Math.max(0, slotCount - visible.length)
  const overflow = projects.length - visible.length
  return (
    <div>
      <div className="flex items-center justify-between mb-3 gap-3">
        <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-ink-400">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-beme-500" aria-hidden="true" />
          {title}
        </h3>
        <span className="text-xs text-ink-400 whitespace-nowrap">
          {projects.length}{' '}
          {projects.length === 1 ? 'project' : 'projects'} this week
        </span>
      </div>
      <ul className="space-y-2">
        {visible.map((p) => (
          <li key={p.id}>
            <CompletedProjectCard project={p} />
          </li>
        ))}
        {Array.from({ length: fillerCount }).map((_, i) => (
          <li key={`completed-filler-${i}`}>
            {/* Same dashed-edge placeholder pattern as ProjectsColumn so
                all three columns line up cell-for-cell when one side
                is quieter than the rest. */}
            <div className="border border-dashed border-ink-500/70 rounded-lg bg-ink-800/60 px-4 py-3 min-h-[124px] flex items-center justify-center text-center">
              <span className="text-xs text-ink-300">
                {i === 0 && visible.length === 0 ? emptyCopy : '—'}
              </span>
            </div>
          </li>
        ))}
      </ul>
      {overflow > 0 && (
        <Link
          to={viewAllHref}
          className="mt-2 inline-flex items-center gap-1 text-xs text-beme-500 hover:text-beme-400"
        >
          View all {projects.length} →
        </Link>
      )}
    </div>
  )
}

/**
 * Single row in the 'In-progress projects' dashboard section. Lighter than
 * a richer card because there's less status to convey — the project's just
 * sitting there waiting to be worked on. Click anywhere on the row to open
 * the workspace; brick / block decides the URL path.
 */
function ProjectInProgressRow({
  project,
  members,
  currentUserId,
}: {
  project: SavedProject
  members: OrgMember[]
  currentUserId: string | null
}) {
  const name =
    project.projectDetails.projectName.trim() ||
    project.projectDetails.siteAddress.trim() ||
    'Untitled project'
  const subtitle =
    project.projectDetails.projectName.trim() &&
    project.projectDetails.siteAddress.trim()
      ? project.projectDetails.siteAddress
      : ''
  const href = projectUrl(project)

  // Resolve the owner's display name. Fallback chain: ownerUserId →
  // createdByUserId → null. Suppresses the label when the project is the
  // current user's (the section header above already says 'Your projects')
  // so the row doesn't read "by Josh" to Josh.
  const ownerId = project.ownerUserId ?? project.createdByUserId ?? null
  const ownerMember = ownerId ? members.find((m) => m.userId === ownerId) : null
  const ownerName =
    ownerMember?.displayName ||
    ownerMember?.email ||
    (ownerId ? 'a teammate' : null)
  const isMyProject = ownerId && currentUserId && ownerId === currentUserId

  const trades = tradesOf(project)
  const metrics = projectMetrics(project)
  const sizeLine =
    metrics.wallCount > 0
      ? `${metrics.wallCount} wall${metrics.wallCount === 1 ? '' : 's'} · ${metrics.runMetres.toFixed(1)} m run`
      : 'No walls drawn yet'

  return (
    <li>
      <Link
        to={href}
        className="relative block border border-ink-600 rounded-lg bg-ink-800 pl-5 pr-4 py-3 min-h-[124px] hover:border-beme-500/40 hover:bg-ink-700/40 transition-colors overflow-hidden"
      >
        {/* Trade-coloured stripe down the left edge. Block = brand
            orange, brick = amber, mixed = vertical gradient between
            the two. Lets the eye scan a column and pick out trade at
            a glance without parsing the badge text. */}
        <span
          aria-hidden="true"
          className={`absolute left-0 top-0 bottom-0 w-1 ${tradeStripeClass(trades)}`}
        />
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-ink-50 truncate">
              {name}
            </span>
            {typeof project.referenceNumber === 'number' && (
              <span
                className="text-[11px] tabular-nums font-semibold text-beme-500"
                title="Reference number — quote this when looking the project up."
              >
                #{formatRef(project.referenceNumber)}
              </span>
            )}
            <TradeBadges trades={trades} />
          </div>
          {/* Subtitle slot always rendered so rows of varying content
              (with/without an address line) keep an identical height.
              Empty when not present — gives the next line a stable
              Y position to slot into. */}
          <div className="text-sm text-ink-300 mt-0.5 truncate min-h-[20px]">
            {subtitle || ' '}
          </div>
          {/* Size line. Gives the row weight beyond the name.
              Tabular-nums so a 1-wall card vs a 12-wall card don't
              shimmy column alignment. */}
          <div className="text-xs text-ink-300/80 mt-1 tabular-nums">
            {sizeLine}
          </div>
          {/* Footer row. Updated-relative on the left, owner pip on
              the right (only when not the current user — owners of
              their own projects already see their column header). */}
          <div className="flex items-center justify-between gap-2 mt-1">
            <div className="text-xs text-ink-400">
              Updated {formatRelative(project.updatedAt)}
            </div>
            {ownerName && !isMyProject && (
              <OwnerPip name={ownerName} />
            )}
          </div>
        </div>
      </Link>
    </li>
  )
}

/**
 * Recently-completed card for a project. Same visual shape as the old
 * request-flavoured CompletedCard but sources all fields off
 * `projectDetails` and links straight back to the project workspace.
 */
function CompletedProjectCard({ project }: { project: SavedProject }) {
  const created = new Date(project.createdAt).getTime()
  const completedIso = project.completedAt ?? project.updatedAt
  const completed = new Date(completedIso).getTime()
  const turnaroundDays = (completed - created) / (1000 * 60 * 60 * 24)
  const turnaroundLabel = formatTurnaround(turnaroundDays)
  const title =
    project.projectDetails.clientName.trim() ||
    project.projectDetails.projectName.trim() ||
    project.projectDetails.siteAddress.trim() ||
    'Untitled project'
  const sub = project.projectDetails.siteAddress.trim()
  const href = projectUrl(project)

  const trades = tradesOf(project)
  const metrics = projectMetrics(project)
  const sizeLine =
    metrics.wallCount > 0
      ? `${metrics.wallCount} wall${metrics.wallCount === 1 ? '' : 's'} · ${metrics.runMetres.toFixed(1)} m run`
      : 'No walls drawn'
  return (
    // Mirrors ProjectInProgressRow's layout 1:1 so all three columns
    // read as a single grid of identically-shaped pods of the same
    // height. Same rows in the same order: title + size line + footer,
    // with the trade-colour stripe matching across columns.
    <Link
      to={href}
      className="relative block border border-ink-600 rounded-lg bg-ink-800 pl-5 pr-4 py-3 min-h-[124px] hover:border-emerald-500/40 hover:bg-ink-700/40 transition-colors overflow-hidden"
    >
      <span
        aria-hidden="true"
        className={`absolute left-0 top-0 bottom-0 w-1 ${tradeStripeClass(trades)}`}
      />
      <div className="min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-semibold text-ink-50 truncate">
            {title}
          </span>
          {typeof project.referenceNumber === 'number' && (
            <span
              className="text-[11px] tabular-nums font-semibold text-beme-500"
              title="Reference number — quote this when looking the project up."
            >
              #{formatRef(project.referenceNumber)}
            </span>
          )}
          <TradeBadges trades={trades} />
        </div>
        {/* Subtitle slot always rendered so rows of varying content
            (with/without a site-address line) keep an identical
            vertical footprint. */}
        <div className="text-sm text-ink-300 mt-0.5 truncate min-h-[20px]">
          {sub && sub !== title ? sub : ' '}
        </div>
        {/* Size line — same line the in-progress sibling shows. */}
        <div className="text-xs text-ink-300/80 mt-1 tabular-nums">
          {sizeLine}
        </div>
        {/* Footer row: completed-relative on the left, turnaround
            chip on the right — same shape as the in-progress card's
            "Updated · owner pip" footer so all three columns end on
            the same row. */}
        <div className="flex items-center justify-between gap-2 mt-1">
          <div className="text-xs text-ink-400">
            Completed {formatRelative(completedIso)}
          </div>
          <span
            className="text-[11px] text-emerald-400 tabular-nums"
            title={`Turnaround: ${turnaroundLabel}`}
          >
            ✓ {turnaroundLabel}
          </span>
        </div>
      </div>
    </Link>
  )
}

/**
 * Format a number of days as a short turnaround label. Sub-day shows hours,
 * single digit days show one decimal, otherwise rounded days.
 */
function formatTurnaround(days: number): string {
  if (days < 1) {
    const hours = Math.max(1, Math.round(days * 24))
    return `${hours}h`
  }
  if (days < 10) return `${days.toFixed(1)}d`
  return `${Math.round(days)}d`
}

// ============================================================================
// Personal dashboard — what a supply-and-lay bricklayer sees
// ============================================================================

/**
 * Personal dashboard for users not signed in to any organisation. Same UI
 * we've had since the dashboard was first built — outcome donut, win-rate
 * stats, full projects list with won/lost filters. The metaphor here is a
 * subcontractor quoting their own jobs, so win rate is the headline metric.
 */
function PersonalDashboard() {
  const navigate = useNavigate()
  const [projects, setProjects] = useState<SavedProject[]>([])
  const [filter, setFilter] = useState<Filter>('all')
  const [searchQuery, setSearchQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const { signedIn, user } = useAuth()

  const refreshProjects = useCallback(() => {
    setLoading(true)
    listProjects()
      .then((list) => setProjects(list))
      .catch((err) => console.error('Failed to list projects', err))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    refreshProjects()
  }, [refreshProjects, signedIn])

  const stats = useMemo(() => {
    const total = projects.length
    const inProgress = projects.filter((p) => p.status === 'in-progress').length
    const completed = projects.filter((p) => p.status === 'completed').length
    const won = projects.filter((p) => p.outcome === 'won').length
    const lost = projects.filter((p) => p.outcome === 'lost').length
    const pending = total - won - lost
    const decided = won + lost
    const winRate = decided === 0 ? null : Math.round((won / decided) * 100)
    return { total, inProgress, completed, won, lost, pending, winRate }
  }, [projects])

  const filtered = useMemo(() => {
    // Status / outcome filter first.
    let base: SavedProject[]
    if (filter === 'all') base = projects
    else if (filter === 'in-progress' || filter === 'completed')
      base = projects.filter((p) => p.status === filter)
    else if (filter === 'won') base = projects.filter((p) => p.outcome === 'won')
    else if (filter === 'lost') base = projects.filter((p) => p.outcome === 'lost')
    else base = projects.filter((p) => !p.outcome)
    // Then search — case-insensitive substring match against project name,
    // site address, client name, and estimator name. The four fields cover
    // every way an estimator typically remembers a job.
    const q = searchQuery.trim().toLowerCase()
    if (!q) return base
    return base.filter((p) => {
      const d = p.projectDetails
      return (
        d.projectName.toLowerCase().includes(q) ||
        d.siteAddress.toLowerCase().includes(q) ||
        d.clientName.toLowerCase().includes(q) ||
        d.estimatorName.toLowerCase().includes(q)
      )
    })
  }, [projects, filter, searchQuery])

  async function handleDelete(id: string) {
    const ok = await confirm({
      title: 'Delete this project?',
      message: "You can undo within a few seconds from the toast.",
      confirmLabel: 'Delete project',
      variant: 'destructive',
    })
    if (!ok) return
    // Fetch the FULL project (with PDF blob + reference PDFs) before
    // deletion so Undo can resurrect it byte-for-byte. The row in
    // `projects` state lacks the blob payloads — listProjects() returns
    // metadata only for performance.
    let cached: SavedProject | undefined
    try {
      cached = await getProject(id)
    } catch (err) {
      console.warn('[handleDelete] Could not pre-fetch project for Undo cache', err)
    }
    try {
      await deleteProject(id)
      setProjects((prev) => prev.filter((p) => p.id !== id))
      // 8-second sticky toast with an Undo action that recreates the
      // project from the cached blob. After 8s the cache evicts via
      // toast auto-dismiss and the deletion becomes permanent.
      if (cached) {
        toast.success('Project deleted', {
          durationMs: 8000,
          action: {
            label: 'Undo',
            onClick: () => {
              void (async () => {
                try {
                  await saveProject(cached)
                  // Re-insert into the local list so the user sees it
                  // back immediately. Order by updatedAt desc to match
                  // the dashboard's default sort.
                  setProjects((prev) =>
                    [cached, ...prev.filter((p) => p.id !== cached!.id)]
                  )
                  toast.success('Project restored')
                } catch (err) {
                  toast.error('Could not restore project', {
                    description: (err as Error)?.message ?? 'Unknown error',
                  })
                }
              })()
            },
          },
        })
      } else {
        // Couldn't snapshot — degraded UX (no Undo) but the delete still
        // works. Surface the situation in the description so the user
        // isn't surprised.
        toast.success('Project deleted', {
          description: 'Undo not available — the project couldn\'t be snapshotted.',
        })
      }
    } catch (err) {
      console.error('Failed to delete', err)
      toast.error('Delete failed', {
        description: (err as Error)?.message ?? 'Unknown error',
      })
    }
  }

  /**
   * Duplicate an existing project into a fresh in-progress one with the same
   * wall types, brick settings, pier patterns etc. — but no walls, no PDFs.
   * The whole point is "start a new job from my last similar one in one click",
   * so we route the user straight into the new workspace afterwards.
   */
  async function handleDuplicate(project: SavedProject) {
    try {
      const newId = await duplicateProject(project.id)
      if (!newId) {
        window.alert('Could not duplicate that project.')
        return
      }
      // Push the new project into the list immediately so the user sees a
      // confirming entry before the route change kicks in. Then navigate.
      const refreshed = await listProjects()
      setProjects(refreshed)
      navigate(projectUrl({ ...project, id: newId }))
    } catch (err) {
      console.error('Failed to duplicate', err)
      window.alert('Could not duplicate that project. See the console for details.')
    }
  }

  async function handleCycleOutcome(project: SavedProject) {
    const next = nextOutcome(project.outcome)
    setProjects((prev) =>
      prev.map((p) => (p.id === project.id ? { ...p, outcome: next } : p))
    )
    try {
      await saveProject({
        ...project,
        outcome: next,
        updatedAt: new Date().toISOString(),
      })
    } catch (err) {
      console.error('Failed to update outcome', err)
      setProjects((prev) => prev.map((p) => (p.id === project.id ? project : p)))
    }
  }

  // Derive a friendly name from the auth user — "joshmills03@hotmail.com"
  // becomes "joshmills03". Falls through to undefined when not signed in
  // (the welcome strip then just shows the greeting without a name).
  const personalName = user?.email ? user.email.split('@')[0] : null

  return (
    <>
      <div className="flex items-end justify-between flex-wrap gap-4 mb-2">
        <div>
          <h2 className="text-3xl font-extrabold tracking-tight text-ink-50">Your dashboard</h2>
          <p className="text-ink-300 text-sm mt-1">
            Your estimates, win rate, and current jobs at a glance.
          </p>
        </div>
        <WelcomeStrip
          name={personalName}
          actionItems={stats.inProgress}
          actionLabel={stats.inProgress === 1 ? 'project on the go' : 'projects on the go'}
        />
      </div>

      <section className="mt-6 grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatTile label="Total projects" value={stats.total} />
        <StatTile label="In progress" value={stats.inProgress} accent="beme" />
        <StatTile label="Won" value={stats.won} accent="emerald" />
        <WinRateTile
          winRate={stats.winRate}
          won={stats.won}
          lost={stats.lost}
          pending={stats.pending}
        />
      </section>

      {/* Primary action — one card. With the unified workspace, an estimate
          can hold block, brick, or both. The user picks the starting trade
          inside the workspace (via the trade chip group at the top of the
          right rail) and can add the other later — so the dashboard surfaces
          a single "+ New estimate" entry instead of forcing a trade choice
          upfront. */}
      <section className="mt-6">
        <Link
          to="/project/block"
          className="block border border-ink-600 rounded-xl bg-ink-800 hover:border-beme-500 hover:bg-ink-700 transition-all p-5 group"
        >
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div className="min-w-0">
              <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-400">
                Start a new estimate
              </div>
              <h4 className="text-xl font-bold text-beme-400 group-hover:text-beme-300 mt-1 mb-1">
                + New estimate
              </h4>
              <p className="text-sm text-ink-300 max-w-2xl">
                Upload a plan, trace walls, openings, and piers. Block, brick,
                or both — switch trades inside the workspace via the chip
                group at the top of the right rail.
              </p>
            </div>
            {/* Visual hint that both trades are available inside — sits in
                the top-right of the card so it doesn't dominate. */}
            <div className="flex items-center gap-1.5 flex-shrink-0 mt-1">
              <span className="text-[10px] px-1.5 py-0.5 rounded uppercase tracking-wider font-semibold bg-beme-500/15 text-beme-300 border border-beme-500/30">
                Block
              </span>
              <span className="text-[10px] px-1.5 py-0.5 rounded uppercase tracking-wider font-semibold bg-amber-500/15 text-amber-300 border border-amber-500/30">
                Brick
              </span>
            </div>
          </div>
          <div className="mt-3 text-xs text-ink-400 group-hover:text-beme-300 transition-colors">
            Open the workspace →
          </div>
        </Link>
      </section>

      <section className="mt-10">
        <div className="flex items-center justify-between flex-wrap gap-3 mb-3">
          <h3 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-400">
            Projects
          </h3>
          <div className="flex items-center gap-2 flex-wrap">
            {/* Search — matches project name, site address, client name,
                estimator name. Case-insensitive substring. Layered on top
                of the status / outcome filter to the right. */}
            <div className="relative">
              <input
                type="search"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search projects…"
                className="pl-8 pr-3 py-1.5 w-56 rounded-lg border border-ink-600 bg-ink-800 text-sm text-ink-100 placeholder:text-ink-500 focus:outline-none focus:border-beme-400"
              />
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
                className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-ink-500 pointer-events-none"
              >
                <circle cx="11" cy="11" r="8" />
                <path d="m21 21-4.3-4.3" />
              </svg>
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery('')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-ink-500 hover:text-ink-200 text-xs"
                  aria-label="Clear search"
                  type="button"
                >
                  ×
                </button>
              )}
            </div>
            <div className="flex items-center gap-1 border border-ink-600 rounded-lg p-1 bg-ink-800 flex-wrap">
              <FilterTab label="All" count={stats.total} active={filter === 'all'} onClick={() => setFilter('all')} />
              <FilterTab label="In progress" count={stats.inProgress} active={filter === 'in-progress'} onClick={() => setFilter('in-progress')} />
              <FilterTab label="Completed" count={stats.completed} active={filter === 'completed'} onClick={() => setFilter('completed')} />
              <FilterTab label="Won" count={stats.won} active={filter === 'won'} onClick={() => setFilter('won')} />
              <FilterTab label="Lost" count={stats.lost} active={filter === 'lost'} onClick={() => setFilter('lost')} />
              <FilterTab label="Pending" count={stats.pending} active={filter === 'pending'} onClick={() => setFilter('pending')} />
            </div>
          </div>
        </div>

        {loading && (
          <ul className="space-y-2" aria-label="Loading projects">
            <ProjectRowSkeleton />
            <ProjectRowSkeleton />
            <ProjectRowSkeleton />
          </ul>
        )}

        {!loading && filtered.length === 0 && (
          <div className="border border-dashed border-ink-600 rounded-xl p-12 text-center text-ink-400 bg-ink-800/50">
            {projects.length === 0 ? (
              <span>
                No saved projects yet. Click <strong>+ New estimate</strong>{' '}
                above to start one.
              </span>
            ) : searchQuery ? (
              <span>
                No projects match <strong>"{searchQuery}"</strong>.
              </span>
            ) : (
              <span>No projects with this filter.</span>
            )}
          </div>
        )}

        {!loading && filtered.length > 0 && (
          <ul className="space-y-2">
            {filtered.map((p) => (
              <ProjectRow
                key={p.id}
                project={p}
                onDelete={() => handleDelete(p.id)}
                onDuplicate={() => handleDuplicate(p)}
                onCycleOutcome={() => handleCycleOutcome(p)}
              />
            ))}
          </ul>
        )}
      </section>

      {/* Material library and Beme guide tiles moved to the dashboard
          sidebar (right rail) — see DashboardSidebar in HomePage. */}
    </>
  )
}

// ---------- Shared sub-components ----------

/**
 * Personalised greeting block shown on the right of the dashboard title
 * row. Time-aware ("Good morning / afternoon / evening"), shows today's
 * date, and surfaces an amber action-items pill when the user has work
 * waiting. Right-aligned so it fills the space the create-action buttons
 * used to occupy without visually competing with the heading.
 */
function WelcomeStrip({
  name,
  actionItems,
  actionLabel,
}: {
  name: string | null
  actionItems: number
  actionLabel: string
}) {
  const hour = new Date().getHours()
  const greeting =
    hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'
  const today = new Date().toLocaleDateString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  })
  return (
    <div className="text-right max-w-full">
      <div className="text-sm text-ink-300">
        {greeting}
        {name ? (
          <>
            , <span className="text-ink-50 font-semibold">{name}</span>
          </>
        ) : null}
      </div>
      <div className="text-xs text-ink-400 mt-0.5">{today}</div>
      {actionItems > 0 && (
        <div className="mt-2 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-amber-500/15 border border-amber-500/40 text-amber-200 text-xs whitespace-nowrap">
          <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
          {actionItems} {actionLabel}
        </div>
      )}
    </div>
  )
}

/**
 * Win-rate stat tile with an inline mini-donut sitting next to the
 * value. Replaces the previous big Outcomes donut card that took a
 * third of the action row and looked sparse until the user marked
 * something Won/Lost. Same data, far less real estate.
 *
 * Falls back to the standard "—" + sub-line treatment when no outcomes
 * have been recorded yet, so the empty state is calm rather than a
 * grey ring.
 */
function WinRateTile({
  winRate,
  won,
  lost,
  pending,
}: {
  winRate: number | null
  won: number
  lost: number
  pending: number
}) {
  if (winRate === null) {
    return (
      <StatTile
        label="Win rate"
        value="—"
        sub="No outcomes yet"
      />
    )
  }
  return (
    <div className="border border-ink-600 rounded-xl bg-ink-800 px-4 py-3.5 flex items-center gap-3">
      <div className="flex-1 min-w-0">
        <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-400">
          Win rate
        </div>
        <div className="text-2xl font-extrabold tracking-tight tabular-nums mt-1 text-ink-50">
          {winRate}%
        </div>
        <div className="text-xs text-ink-400 mt-0.5">
          {won} won · {lost} lost
        </div>
      </div>
      <DonutChart
        size={64}
        thickness={9}
        slices={[
          { label: 'Won', value: won, color: 'var(--color-beme-500)' },
          { label: 'Lost', value: lost, color: 'var(--color-ink-500)' },
          { label: 'Pending', value: pending, color: 'var(--color-ink-600)' },
        ]}
      />
    </div>
  )
}

function StatTile({
  label,
  value,
  sub,
  accent,
}: {
  label: string
  value: string | number
  sub?: string
  accent?: 'beme' | 'emerald' | 'amber'
}) {
  // Accent colours bumped one step brighter (300 → 500 for beme,
  // 300 → 400 for emerald/amber) so the headline numbers carry the
  // brand orange / green more strongly. Earlier the burnt-tone
  // beme-300 read as muted brown in light mode.
  const accentClass =
    accent === 'beme'
      ? 'text-beme-500'
      : accent === 'emerald'
        ? 'text-emerald-400'
        : accent === 'amber'
          ? 'text-amber-400'
          : 'text-ink-50'
  return (
    <div className="border border-ink-600 rounded-xl bg-ink-800 px-4 py-3.5">
      <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-400">
        {label}
      </div>
      <div className={`text-2xl font-extrabold tracking-tight tabular-nums mt-1 ${accentClass}`}>
        {value}
      </div>
      {sub && <div className="text-xs text-ink-400 mt-0.5">{sub}</div>}
    </div>
  )
}

/**
 * "+ New estimate" tile that lives in the stats row to the right of
 * the read-only metrics. Matches StatTile's outer shape (border,
 * radius, padding) so the row reads as three equal cells, but the
 * whole thing is a Link with a beme-orange title + descriptive
 * sub-line — visually the primary CTA on the page.
 */
function NewEstimateTile() {
  return (
    <Link
      to="/project/block"
      title="Start a new masonry estimate — block, brick, or both"
      className="block border border-ink-600 rounded-xl bg-ink-800 px-4 py-3.5 hover:border-beme-500 hover:bg-ink-700/40 transition-colors group"
    >
      <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-400 flex items-center justify-between gap-2">
        <span>Start a new estimate</span>
        <span className="text-ink-500 group-hover:text-beme-500 transition-colors">→</span>
      </div>
      {/* Title font tuned down from text-2xl/extrabold to a chunkier
          lg/bold — the long phrase looked squished at the stat-value
          weight while the digits (6, 9) read fine. Colour bumped to
          beme-500 so it matches the brighter brand-orange the rail
          accents use, not the muted beme-300 burnt tone. */}
      <div className="text-lg font-bold tracking-tight mt-1 text-beme-500 group-hover:text-beme-400">
        + New estimate
      </div>
      <div className="text-xs text-ink-400 mt-0.5">
        Block, brick, or both — switch trades inside
      </div>
    </Link>
  )
}

function FilterTab({
  label,
  count,
  active,
  onClick,
}: {
  label: string
  count: number
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1 rounded text-sm transition-colors ${
        active
          ? 'bg-beme-500 text-black font-medium'
          : 'text-ink-300 hover:bg-ink-700 hover:text-ink-100'
      }`}
    >
      {label} <span className={active ? 'opacity-70' : 'text-ink-400'}>{count}</span>
    </button>
  )
}

function OutcomePill({
  outcome,
  onClick,
}: {
  outcome: ProjectOutcome | undefined
  onClick: () => void
}) {
  let label = 'Mark won'
  let className = 'bg-ink-700 text-ink-300 border-ink-600 hover:bg-ink-600'
  if (outcome === 'won') {
    label = 'Won'
    className = 'bg-beme-500/15 text-beme-300 border-beme-500/40 hover:bg-beme-500/25'
  } else if (outcome === 'lost') {
    label = 'Lost'
    className = 'bg-rose-500/15 text-rose-300 border-rose-500/40 hover:bg-rose-500/25'
  }
  return (
    <button
      type="button"
      onClick={(e) => {
        e.preventDefault()
        e.stopPropagation()
        onClick()
      }}
      className={`text-[11px] px-2 py-0.5 rounded-full border font-medium transition-colors ${className}`}
      title="Click to cycle: pending → won → lost"
    >
      {label}
    </button>
  )
}

function ProjectRow({
  project,
  onDelete,
  onDuplicate,
  onCycleOutcome,
}: {
  project: SavedProject
  onDelete: () => void
  onDuplicate: () => void
  onCycleOutcome: () => void
}) {
  const name =
    project.projectDetails.projectName.trim() ||
    project.projectDetails.siteAddress.trim() ||
    'Untitled project'
  const subtitle =
    project.projectDetails.projectName.trim() && project.projectDetails.siteAddress.trim()
      ? project.projectDetails.siteAddress
      : ''
  const typeLabel = project.type === 'block' ? 'Block' : 'Brick'

  return (
    <li className="border border-ink-600 rounded-xl bg-ink-800 hover:border-beme-500/60 transition-colors">
      <div className="flex items-center justify-between flex-wrap gap-3 p-4">
        <Link
          to={`/project/${project.type}?id=${project.id}`}
          className="flex-1 min-w-0 group"
        >
          <div className="flex items-center gap-3 flex-wrap">
            <span className="text-base font-semibold text-ink-50 group-hover:text-beme-300 transition-colors">
              {name}
            </span>
            {/* Reference number pill — same affordance the OrgDashboard
                rows and ProjectBar show. Personal projects DO get
                reference numbers allocated by the Postgres trigger on
                insert; this was simply missing from the personal list
                view. Quote-by-phone / cross-look-up by 6-digit number
                works the same way for personal and team projects. */}
            {typeof project.referenceNumber === 'number' && (
              <span
                className="text-[11px] tabular-nums font-semibold text-beme-400/80"
                title="Reference number — quote this when looking the project up."
              >
                #{formatRef(project.referenceNumber)}
              </span>
            )}
            {statusBadge(project.status)}
            <OutcomePill outcome={project.outcome} onClick={onCycleOutcome} />
            <span className="text-[11px] px-2 py-0.5 rounded-full bg-ink-700 text-ink-200 border border-ink-600">
              {typeLabel}
            </span>
          </div>
          {subtitle && <div className="text-sm text-ink-300 mt-0.5">{subtitle}</div>}
          <div className="text-xs text-ink-400 mt-1">
            Updated {formatRelative(project.updatedAt)}
            {project.completedAt && (
              <span> · Completed {formatRelative(project.completedAt)}</span>
            )}
          </div>
        </Link>
        <div className="flex items-center gap-2">
          <Link
            to={`/project/${project.type}?id=${project.id}`}
            className="px-3 py-1.5 rounded-lg bg-beme-500 text-black text-sm hover:bg-beme-400 transition-colors font-medium"
          >
            Open
          </Link>
          <button
            onClick={onDuplicate}
            title="Start a new project with the same wall types, brick settings, pier patterns — fresh canvas, no PDFs."
            className="px-3 py-1.5 rounded-lg border border-ink-600 text-ink-300 text-sm hover:bg-beme-500/10 hover:border-beme-500/40 hover:text-beme-300 transition-colors"
          >
            Duplicate
          </button>
          <button
            onClick={onDelete}
            className="px-3 py-1.5 rounded-lg border border-ink-600 text-ink-300 text-sm hover:bg-rose-500/10 hover:border-rose-500/40 hover:text-rose-300 transition-colors"
          >
            Delete
          </button>
        </div>
      </div>
    </li>
  )
}
