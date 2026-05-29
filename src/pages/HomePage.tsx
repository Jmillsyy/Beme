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
import {
  listEstimateRequests,
  pickUpEstimateRequest,
} from '../lib/estimateRequests'
import type { EstimateRequest } from '../types/estimateRequests'
import { estimateRequestStatusLabel } from '../types/estimateRequests'
import type { OrgMember, Organisation } from '../types/organisations'

type Filter = 'all' | 'in-progress' | 'completed' | 'won' | 'lost' | 'pending'

/**
 * Format a project's reference number as a 6-digit zero-padded string.
 * Values that overflow 6 digits (won't happen for a long time) just print
 * as-is rather than silently truncating. Mirrors the helper in ProjectBar
 * so the workspace and dashboard show the number identically.
 */
function formatRef(n: number): string {
  return n >= 100000 ? `${n}` : n.toString().padStart(6, '0')
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
 * The dashboard branches at the top level: if the user is signed in to an
 * organisation, they get the org-aware layout (inbox first, request-centric
 * stats, secondary project access). Personal / single-user accounts keep the
 * brick-and-block-layer-focused dashboard with the win-rate donut.
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
          of quick links / shortcuts on the right (lg+ only). Bumped the
          outer max-width to 1800px so the sidebar adds horizontal density
          without squeezing the existing content cards. */}
      <main className="max-w-[1800px] mx-auto px-6 py-12">
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
      {/* Start a new estimate — ORG ONLY. The body of the org dashboard is
          reserved for team activity (pending requests, In-progress
          projects, recently completed), so the estimate-start actions
          go into the rail to keep the team feed clean. Sits ABOVE the
          Material library so it's the first thing the user's eye lands
          on. PersonalDashboard already gives these the prominent hero
          card treatment in its body, so showing the same shortcut in
          the rail there would just duplicate the affordance. */}
      {isOrgUser && (
        <div className="border border-ink-600 rounded-xl bg-ink-800/60 p-3 space-y-2">
          <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-400 px-1">
            Start a new estimate
          </div>
          <Link
            to="/project/brick"
            className="block px-3 py-2.5 rounded-lg bg-ink-900 border border-ink-600 hover:border-beme-500 hover:bg-ink-800 transition-colors group"
            title="Start a new brick estimate"
          >
            <div className="font-bold text-sm text-beme-400 group-hover:text-beme-300">
              + Brick estimate
            </div>
            <div className="text-[11px] text-ink-400 group-hover:text-ink-300 mt-0.5">
              Trace brick walls over a plan
            </div>
          </Link>
          <Link
            to="/project/block"
            className="block px-3 py-2.5 rounded-lg bg-ink-900 border border-ink-600 hover:border-beme-500 hover:bg-ink-800 transition-colors group"
            title="Start a new block estimate"
          >
            <div className="font-bold text-sm text-beme-400 group-hover:text-beme-300">
              + Block estimate
            </div>
            <div className="text-[11px] text-ink-400 group-hover:text-ink-300 mt-0.5">
              Draw walls, piers, openings
            </div>
          </Link>
        </div>
      )}

      {/* Material library — the next-most-frequent destination from the
          dashboard (users tune blocks, bricks, and supply items between
          projects). On the org dashboard it sits below the estimate-start
          card so the create actions get the prime spot. On the personal
          dashboard it's the top-of-rail card since estimate-start is
          already in the body. "+ New request" stays under it for org
          users — the only org-specific creation action that doesn't
          surface elsewhere in the rail. */}
      <div className="border border-ink-600 rounded-xl bg-ink-800/60 p-3">
        <Link
          to="/library"
          title={healthSummary?.tooltip}
          className="px-3 py-3 rounded-lg bg-ink-900 border-2 border-beme-500 shadow-md shadow-beme-500/20 hover:bg-ink-800 hover:shadow-beme-500/40 transition-all group flex items-center gap-3"
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
          <span className="text-beme-400 group-hover:text-beme-300">→</span>
        </Link>
        {isOrgUser && (
          <Link
            to="/requests/new"
            className="mt-3 block px-3 py-2 rounded-lg border border-ink-600 bg-ink-800/40 text-ink-200 text-xs hover:bg-ink-700 hover:border-beme-500/50 hover:text-beme-300 transition-colors text-center"
          >
            + New request for a teammate
          </Link>
        )}
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
          {isOrgUser && (
            <SidebarLink to="/requests" title="All requests" desc="Every estimate across the team" />
          )}
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
      const url =
        hit.type === 'brick'
          ? `/project/brick?id=${hit.id}`
          : `/project/block?id=${hit.id}`
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
          className="flex-1 min-w-0 px-2 py-1.5 rounded-r-md border border-ink-600 bg-ink-900 text-ink-50 text-sm tabular-nums focus:outline-none focus:border-beme-400"
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
          className="text-[11px] text-beme-400 hover:text-beme-300 hover:underline"
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
        <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-beme-300">
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
        <div className="text-sm font-medium text-ink-100 group-hover:text-beme-300 transition-colors">
          {title}
        </div>
        <div className="text-xs text-ink-400 mt-0.5">{desc}</div>
      </div>
      <span className="text-ink-500 group-hover:text-beme-300 transition-colors">→</span>
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
 * Org-aware dashboard. Inbox-led: the most important thing on the page is
 * "what work has been sent to me and what is the team currently working on,"
 * not "how many of my personal estimates have I won."
 *
 * Layout:
 *   - Title row + actions ("+ New request" is the primary action; brick / block
 *     workspaces are secondary because in an org you usually arrive at a
 *     project via a request, not by starting one cold).
 *   - Stats row: pending / in-progress / completed this week / average
 *     turnaround. All org-scoped, all relevant to a supplier's takeoff service.
 *   - "Your inbox" — pending and in-progress requests assigned to the current
 *     user, with an empty-state nudge when there's nothing waiting.
 *   - "Team inbox" — active requests assigned to other people, so an admin
 *     can see the team's load at a glance. Hidden when nothing's there.
 *   - "Recently completed" — last few requests that have been finished, with
 *     a link through to the linked project.
 */
function OrgDashboard({ org, userId }: { org: Organisation; userId: string | null }) {
  const navigate = useNavigate()
  const [requests, setRequests] = useState<EstimateRequest[]>([])
  const [members, setMembers] = useState<OrgMember[]>([])
  // All projects visible to the user — both org-scoped (everyone on the team
  // sees them) and personal (their own). Used to surface in-progress
  // projects on the dashboard, since direct '+ Brick / + Block' creates
  // don't go through the estimate-request inbox.
  const [projects, setProjects] = useState<SavedProject[]>([])
  const [loading, setLoading] = useState(true)
  // Which request the user is currently picking up (drives the row's
  // disabled state + button label). One at a time — the user can't sensibly
  // claim two requests in parallel and the request-side update isn't
  // batched.
  const [pickingUpId, setPickingUpId] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    Promise.all([
      listEstimateRequests(org.id),
      listOrgMembers(org.id),
      // listProjects returns every project this user can see (their own +
      // any org-scoped project where they're a member). Cloud RLS does
      // the filtering server-side so anyone in the org sees the same set.
      listProjects(),
    ])
      .then(([reqs, mems, projs]) => {
        if (cancelled) return
        setRequests(reqs)
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

  // Inline pickup straight from a dashboard row: creates the linked project,
  // flips the request to in_progress, then navigates the user into the
  // workspace. Used by the Pick up button on pending rows in 'Action needed'.
  const handlePickUp = useCallback(
    async (request: EstimateRequest) => {
      if (pickingUpId) return
      setPickingUpId(request.id)
      try {
        const newProjectId = await pickUpEstimateRequest(request)
        const path =
          request.type === 'brick'
            ? `/project/brick?id=${newProjectId}`
            : `/project/block?id=${newProjectId}`
        navigate(path)
      } catch (err) {
        window.alert(`Couldn't pick up: ${(err as Error).message ?? 'unknown error'}`)
        setPickingUpId(null)
      }
    },
    [pickingUpId, navigate]
  )

  // Member lookup for assignee / creator name display on request rows.
  const memberById = useMemo(() => {
    const m = new Map<string, OrgMember>()
    for (const x of members) m.set(x.userId, x)
    return m
  }, [members])

  // Stats: pending count, in-progress count, completed-this-week count.
  // The fourth tile in the row is the InboxTile, which derives its number
  // from myActionItems below (myPending + myInProgress) — not part of the
  // stats memo because it's user-specific rather than org-wide.
  const stats = useMemo(() => {
    const pending = requests.filter((r) => r.status === 'pending').length
    const inProgress = requests.filter((r) => r.status === 'in_progress').length
    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000
    const completedThisWeek = requests.filter(
      (r) =>
        r.status === 'completed' &&
        r.completedAt &&
        new Date(r.completedAt).getTime() >= weekAgo
    ).length
    return { pending, inProgress, completedThisWeek }
  }, [requests])

  // Split the in-progress projects into 'mine' (above) and 'team' (below) so
  // the user's own work is the FIRST thing they see in the project list.
  //
  // 'mine' = projects where the user is the OWNER (i.e. they created the
  //          underlying estimate request, or they started a direct '+ Brick /
  //          + Block' project) OR they're the current assignee of the linked
  //          estimate request (i.e. they were allocated to work on it,
  //          regardless of who created it).
  //
  // Two buckets exist because the project lifecycle now separates creator and
  // worker: a sales person creates the request and stays the owner; the
  // estimator picks it up and is the assignee. Both should see the project
  // under 'Your projects' on their respective dashboards.
  //
  // Most recent first within each bucket.
  const { myProjects, teamProjects } = useMemo(() => {
    const sortRecent = (a: SavedProject, b: SavedProject) =>
      new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    // Set of project ids the current user is assigned to via an estimate
    // request — derived from the requests list we already loaded. Includes
    // requests in any status (the project sticks with the assignee even
    // after the request itself is completed, until it's cleaned up).
    const myAssignedProjectIds = new Set(
      requests
        .filter((r) => r.assignedToUserId === userId && r.projectId)
        .map((r) => r.projectId as string)
    )
    const all = projects.filter((p) => p.status === 'in-progress')
    const mine: SavedProject[] = []
    const team: SavedProject[] = []
    for (const p of all) {
      const owner = p.ownerUserId ?? p.createdByUserId ?? null
      const isOwner = !!userId && owner === userId
      const isAssignee = myAssignedProjectIds.has(p.id)
      if (isOwner || isAssignee) mine.push(p)
      else team.push(p)
    }
    return { myProjects: mine.sort(sortRecent), teamProjects: team.sort(sortRecent) }
  }, [projects, requests, userId])

  const { myPending, myInProgress, recentlyCompleted } = useMemo(() => {
    const active = requests.filter(
      (r) => r.status === 'pending' || r.status === 'in_progress'
    )
    const byOldestUpdated = (a: EstimateRequest, b: EstimateRequest) =>
      a.updatedAt.localeCompare(b.updatedAt)
    const myPending = active
      .filter((r) => r.status === 'pending' && r.assignedToUserId === userId)
      .sort(byOldestUpdated)
    const myInProgress = active
      .filter((r) => r.status === 'in_progress' && r.assignedToUserId === userId)
      .sort(byOldestUpdated)
    // Recently-completed is now TEAM-WIDE within the past 7 days — the
    // dashboard surfaces what the whole org has shipped recently, not just
    // what the current user finished. Older work (or work an org member
    // wants to audit by specific person) still lives on the /requests page
    // behind filters.
    //
    // Two sources merged into one list:
    //   1. Estimate requests with status === 'completed' completed in the
    //      past week (any assignee).
    //   2. Projects with status === 'completed' that DON'T have a linked
    //      request — direct '+ Block' / '+ Brick' creates the user
    //      finished. Same 7-day window.
    //
    // De-duplicates by projectId: if a completed project's id appears in
    // both lists (request flow) we keep the REQUEST entry because the
    // CompletedCard renders the customer-name header better than the
    // project's projectDetails.
    const weekAgoMs = Date.now() - 7 * 24 * 60 * 60 * 1000
    const withinPastWeek = (iso: string | undefined) => {
      if (!iso) return false
      const t = new Date(iso).getTime()
      return Number.isFinite(t) && t >= weekAgoMs
    }
    const completedRequests = requests.filter(
      (r) =>
        r.status === 'completed' && withinPastWeek(r.completedAt ?? r.updatedAt)
    )
    const requestProjectIds = new Set(
      completedRequests.map((r) => r.projectId).filter(Boolean)
    )
    const orphanCompletedProjects = projects.filter(
      (p) =>
        p.status === 'completed' &&
        !requestProjectIds.has(p.id) &&
        withinPastWeek(p.completedAt ?? p.updatedAt)
    )
    type CompletedItem =
      | { kind: 'request'; request: EstimateRequest; completedAt: string }
      | { kind: 'project'; project: SavedProject; completedAt: string }
    const merged: CompletedItem[] = [
      ...completedRequests.map((r) => ({
        kind: 'request' as const,
        request: r,
        completedAt: r.completedAt ?? r.updatedAt,
      })),
      ...orphanCompletedProjects.map((p) => ({
        kind: 'project' as const,
        project: p,
        completedAt: p.completedAt ?? p.updatedAt,
      })),
    ]
    const completed = merged
      .sort(
        (a, b) =>
          new Date(b.completedAt).getTime() - new Date(a.completedAt).getTime()
      )
      // Cap at the 5 most-recently-completed so the band reads as a quick
      // glance at "what just shipped", not a full archive. The 'View all
      // →' link on the section header points at /requests?status=completed
      // for the unbounded list.
      .slice(0, 5)
    return {
      myPending,
      myInProgress,
      recentlyCompleted: completed,
    }
  }, [requests, projects, userId])

  // Quick lookup from request → linked project so the Recently Completed
  // cards can show the project's reference number (and any other
  // project-only fields) alongside the request's customer data.
  const projectById = useMemo(() => {
    const m = new Map<string, SavedProject>()
    for (const p of projects) m.set(p.id, p)
    return m
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
  // "Inbox" is now strictly pending requests — things waiting on the user
  // to pick up. Picked-up (in-progress) requests live in the In-progress
  // projects section below, so counting them in the inbox tile too would
  // double-surface the same work and make a finished pickup feel like
  // nothing happened ('still 3 in my inbox after I claimed one'). Keep
  // myInProgress around as a local so the welcome strip can still mention
  // it if needed, but the headline tile only counts pending.
  const myActionItems = myPending.length
  void myInProgress

  return (
    <>
      <div className="flex items-end justify-between flex-wrap gap-4 mb-2">
        <div>
          <h2 className="text-3xl font-extrabold tracking-tight text-ink-50">
            Team dashboard
          </h2>
          <p className="text-ink-300 text-sm mt-1">
            Requests, in-progress jobs, and recent wins across {org.name}.
          </p>
        </div>
        <WelcomeStrip
          name={userDisplayName}
          actionItems={myActionItems}
          actionLabel={
            myActionItems === 1 ? 'request waiting for you' : 'requests waiting for you'
          }
        />
      </div>

      {/* ── Stats row ── */}
      <section className="mt-6 grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatTile
          label="Pending"
          value={stats.pending}
          accent={stats.pending > 0 ? 'amber' : undefined}
        />
        <StatTile label="In progress" value={stats.inProgress} accent="beme" />
        <StatTile
          label="Completed this week"
          value={stats.completedThisWeek}
          accent="emerald"
        />
        {/* Inbox jump-tile. Replaces the old 'Avg turnaround' stat — that
            number wasn't actionable, just a vanity metric. This tile is a
            clickable shortcut to the requests page filtered to 'assigned
            to me + pending'. Shows the live count of PENDING requests
            (i.e. things waiting on this user to pick up). Once a request
            is picked up, it leaves the inbox and surfaces in the
            In-progress projects section instead. */}
        <InboxTile count={myActionItems} />
      </section>

      {/* "Your inbox" used to live here as a two-column 'Needs you to pick
          up' + 'Currently working on' grid. Replaced by the My Inbox tile
          in the stats row above, which links to /requests?scope=mine —
          one source of truth for personal queue instead of two surfaces
          on the same page showing the same data. */}

      {/* ── Your projects ──
          The current user's own active projects — anything they started or
          got allocated. Sits above the team's in-progress list so a user's
          first glance at the dashboard is their own work. Same 5-cap +
          View all affordance as the other lists. */}
      {myProjects.length > 0 && (
        <section className="mt-8">
          <div className="flex items-center justify-between mb-3">
            <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-ink-400">
              <span className="inline-block w-1 h-1 rounded-full bg-beme-500/80" aria-hidden="true" />
              Your projects
            </h3>
            <div className="flex items-center gap-3">
              <span className="text-xs text-ink-400">
                {myProjects.length}{' '}
                {myProjects.length === 1 ? 'project' : 'projects'} on the go
              </span>
              {myProjects.length > 5 && (
                <Link
                  to={`/projects?status=in-progress${userId ? `&owner=${userId}` : ''}`}
                  className="text-xs text-beme-300 hover:text-beme-200"
                >
                  View all →
                </Link>
              )}
            </div>
          </div>
          <ul className="space-y-2">
            {myProjects.slice(0, 5).map((p) => (
              <ProjectInProgressRow
                key={p.id}
                project={p}
                members={members}
                currentUserId={userId}
              />
            ))}
          </ul>
        </section>
      )}

      {/* ── In-progress projects ──
          Active projects owned by other org members — the 'by Sarah'
          label calls out whose each one is so the user can spot who's
          working on what at a glance. */}
      {teamProjects.length > 0 && (
        <section className="mt-8">
          <div className="flex items-center justify-between mb-3">
            <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-ink-400">
              <span className="inline-block w-1 h-1 rounded-full bg-beme-500/80" aria-hidden="true" />
              In-progress projects
            </h3>
            <div className="flex items-center gap-3">
              <span className="text-xs text-ink-400">
                {teamProjects.length}{' '}
                {teamProjects.length === 1 ? 'project' : 'projects'} on the go
              </span>
              {teamProjects.length > 5 && (
                <Link
                  to="/projects?status=in-progress"
                  className="text-xs text-beme-300 hover:text-beme-200"
                >
                  View all →
                </Link>
              )}
            </div>
          </div>
          <ul className="space-y-2">
            {teamProjects.slice(0, 5).map((p) => (
              <ProjectInProgressRow
                key={p.id}
                project={p}
                members={members}
                currentUserId={userId}
              />
            ))}
          </ul>
        </section>
      )}

      {/* Team inbox removed: the In-progress projects section above already
          shows every teammate's active work (the 'by Sarah' label calls
          out whose it is), so a separate Team inbox just duplicated the
          same rows. The /requests page is one click from the InboxTile
          for anyone who wants the full estimate-request audit view. */}

      {/* ── Recently completed (team, past 7 days) ──
          Team-wide scope: shows every estimate the org has finished in the
          last week so anyone walking up to the dashboard can see what's
          shipped. Older completed work lives behind the View all link on
          the /requests page. Always-on band — empty state placeholder
          keeps the dashboard layout consistent week to week. */}
      <section className="mt-8">
        <div className="flex items-center justify-between mb-3">
          <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-ink-400">
            <span className="inline-block w-1 h-1 rounded-full bg-beme-500/80" aria-hidden="true" />
            Team — recently completed
          </h3>
          <Link
            to="/projects?status=completed"
            className="text-xs text-beme-300 hover:text-beme-200"
          >
            View all →
          </Link>
        </div>
        {recentlyCompleted.length === 0 ? (
          <div className="border border-dashed border-ink-600 rounded-xl bg-ink-800/40 p-6 text-center">
            <div className="text-sm text-ink-300">
              Nothing finished by the team this week
            </div>
            <p className="text-xs text-ink-500 mt-1 max-w-md mx-auto">
              Completed estimates from the past 7 days show up here. Older
              work is one click away under View all.
            </p>
          </div>
        ) : (
          // Auto-fit + 1fr: cards stretch to fill the row evenly no matter
          // how many there are. 1 card spans the full row, 2 split 50/50,
          // 3 split 33/33/33, 4+ wrap to a new row at the min width.
          <div className="grid gap-3 grid-cols-[repeat(auto-fit,minmax(260px,1fr))]">
            {recentlyCompleted.map((item) =>
              item.kind === 'request' ? (
                <CompletedCard
                  key={`req-${item.request.id}`}
                  request={item.request}
                  assignee={
                    item.request.assignedToUserId
                      ? memberById.get(item.request.assignedToUserId)
                      : undefined
                  }
                  referenceNumber={
                    item.request.projectId
                      ? projectById.get(item.request.projectId)?.referenceNumber
                      : undefined
                  }
                />
              ) : (
                <CompletedProjectCard
                  key={`proj-${item.project.id}`}
                  project={item.project}
                />
              )
            )}
          </div>
        )}
      </section>

      {/* Material library and Beme guide tiles have been promoted to the
          dashboard sidebar (right rail). They were big banner cards down
          here; relocating them frees vertical space and gives them a
          permanent, always-visible spot. */}
    </>
  )
}

/**
 * Single column inside the 'Your inbox' two-up grid. The header carries a
 * small coloured dot matching the section's status (amber = pending, blue
 * = in-progress) so the columns read distinctly even when the user's eyes
 * blur past the heading text. Empty columns show a dashed placeholder so
 * the side-by-side proportions stay visually balanced when one side has
 * nothing in it.
 */
function InboxColumn({
  title,
  accent,
  count,
  empty,
  children,
}: {
  title: string
  accent: 'amber' | 'blue'
  count: number
  empty: string
  children: React.ReactNode
}) {
  const dotClass = accent === 'amber' ? 'bg-amber-400' : 'bg-blue-400'
  const hasContent = Array.isArray(children) ? children.length > 0 : !!children
  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-2 mb-2 px-1">
        <span className={`w-2 h-2 rounded-full ${dotClass}`} />
        <span className="text-sm font-semibold text-ink-100">{title}</span>
        <span className="text-xs text-ink-400 ml-auto tabular-nums">{count}</span>
      </div>
      {hasContent ? (
        <ul className="space-y-2 flex-1">{children}</ul>
      ) : (
        // Compact one-line empty state — keeps the column slim so it doesn't
        // look "tall and lonely" when only one side has items.
        <div className="border border-dashed border-ink-600 rounded-lg px-3 py-2 bg-ink-800/30">
          <p className="text-ink-500 text-xs italic">{empty}</p>
        </div>
      )}
    </div>
  )
}

/**
 * Compact card for the Recently Completed 3-up grid. Surfaces the three
 * things a teammate actually wants from this view: the customer's name,
 * who closed it out, and how long it took (turnaround). Click-through
 * lands on the request detail page so the project can be reopened from
 * there if needed.
 */
/**
 * Single row in the 'In-progress projects' dashboard section. Lighter than
 * an estimate-request InboxRow because there's less status to convey — the
 * project's just sitting there waiting to be worked on. Click anywhere on
 * the row to open the workspace; brick / block decides the URL path.
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
  const href =
    project.type === 'brick'
      ? `/project/brick?id=${project.id}`
      : `/project/block?id=${project.id}`

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

  return (
    <li>
      <Link
        to={href}
        className="block border border-ink-600 rounded-lg bg-ink-800 px-4 py-3 hover:border-beme-500/40 hover:bg-ink-700/40 transition-colors"
      >
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-semibold text-ink-50 truncate">
                {name}
              </span>
              {typeof project.referenceNumber === 'number' && (
                <span
                  className="text-[11px] tabular-nums font-semibold text-beme-400/80"
                  title="Reference number — quote this when looking the project up."
                >
                  #{formatRef(project.referenceNumber)}
                </span>
              )}
              <span
                className={`text-[10px] px-1.5 py-0.5 rounded uppercase tracking-wider font-semibold ${
                  project.type === 'brick'
                    ? 'bg-amber-500/15 text-amber-300 border border-amber-500/30'
                    : 'bg-beme-500/15 text-beme-300 border border-beme-500/30'
                }`}
              >
                {project.type === 'brick' ? 'Brick' : 'Block'}
              </span>
              {ownerName && !isMyProject && (
                <span className="text-[11px] text-ink-400">
                  by <span className="text-ink-300">{ownerName}</span>
                </span>
              )}
            </div>
            {subtitle && (
              <div className="text-sm text-ink-300 mt-0.5 truncate">
                {subtitle}
              </div>
            )}
            <div className="text-xs text-ink-400 mt-1">
              Updated {formatRelative(project.updatedAt)}
            </div>
          </div>
        </div>
      </Link>
    </li>
  )
}

function CompletedCard({
  request,
  assignee,
  referenceNumber,
}: {
  request: EstimateRequest
  assignee: OrgMember | undefined
  /** Reference number of the linked project, if there is one. */
  referenceNumber?: number | null
}) {
  // Turnaround = completedAt − createdAt. Defaults to updatedAt for safety
  // if completedAt is missing (shouldn't happen on completed rows but
  // tolerate older data).
  const created = new Date(request.createdAt).getTime()
  const completedIso = request.completedAt ?? request.updatedAt
  const completed = new Date(completedIso).getTime()
  const turnaroundDays = (completed - created) / (1000 * 60 * 60 * 24)
  const turnaroundLabel = formatTurnaround(turnaroundDays)

  return (
    <Link
      to={`/requests/${request.id}`}
      className="block border border-ink-600 rounded-xl bg-ink-800 p-4 hover:border-emerald-500/40 hover:bg-ink-700/40 transition-colors group"
    >
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-ink-50 truncate group-hover:text-emerald-300 transition-colors">
              {request.customerName}
            </span>
            {typeof referenceNumber === 'number' && (
              <span className="text-[11px] tabular-nums font-semibold text-ink-300">
                #{formatRef(referenceNumber)}
              </span>
            )}
          </div>
          {request.customerCompany && (
            <div className="text-xs text-ink-400 truncate">{request.customerCompany}</div>
          )}
        </div>
        <span className="shrink-0 text-[10px] uppercase tracking-wider text-ink-400">
          {request.type === 'brick' ? 'Brick' : 'Block'}
        </span>
      </div>
      <div className="flex items-center justify-between text-xs text-ink-400 gap-2 flex-wrap">
        <span className="truncate">
          By{' '}
          <span className="text-ink-200">
            {assignee?.displayName || assignee?.email || 'team'}
          </span>
        </span>
        <span
          className="inline-flex items-center px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/40 font-medium tabular-nums"
          title={`Turnaround: ${turnaroundLabel}`}
        >
          ⏱ {turnaroundLabel}
        </span>
      </div>
      <div className="text-[11px] text-ink-500 mt-2">
        Completed {formatRelative(completedIso)}
      </div>
    </Link>
  )
}

/**
 * Recently-completed card for a direct project (one not created from an
 * estimate request). Same visual shape as CompletedCard but pulls the
 * customer / site fields from projectDetails instead of the request's
 * own customer columns, and links back to the project workspace rather
 * than the request page.
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
  const href =
    project.type === 'brick'
      ? `/project/brick?id=${project.id}`
      : `/project/block?id=${project.id}`

  return (
    <Link
      to={href}
      className="block border border-ink-600 rounded-xl bg-ink-800 p-4 hover:border-emerald-500/40 hover:bg-ink-700/40 transition-colors group"
    >
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-ink-50 truncate group-hover:text-emerald-300 transition-colors">
              {title}
            </span>
            {typeof project.referenceNumber === 'number' && (
              <span className="text-[11px] tabular-nums font-semibold text-beme-400/80">
                #{formatRef(project.referenceNumber)}
              </span>
            )}
          </div>
          {sub && sub !== title && (
            <div className="text-xs text-ink-400 truncate">{sub}</div>
          )}
        </div>
        <span
          className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded uppercase tracking-wider font-semibold ${
            project.type === 'brick'
              ? 'bg-amber-500/15 text-amber-300 border border-amber-500/30'
              : 'bg-beme-500/15 text-beme-300 border border-beme-500/30'
          }`}
        >
          {project.type === 'brick' ? 'Brick' : 'Block'}
        </span>
      </div>
      <div className="flex items-center justify-between text-xs text-ink-400 gap-2 flex-wrap">
        <span className="truncate">Direct estimate</span>
        <span
          className="inline-flex items-center px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/40 font-medium tabular-nums"
          title={`Turnaround: ${turnaroundLabel}`}
        >
          ⏱ {turnaroundLabel}
        </span>
      </div>
      <div className="text-[11px] text-ink-500 mt-2">
        Completed {formatRelative(completedIso)}
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

/**
 * Compact request row tuned for the dashboard. Smaller than the full row on
 * /requests so a list of 5–10 fits comfortably on the home page. Same data
 * — customer name, status, assignee, last update — different density.
 *
 * Optional `onPickUp` adds a 'Pick up' button to the right of the row that
 * stops the surrounding Link from navigating to the detail page; instead it
 * creates the project + flips the request straight from the dashboard. Used
 * on pending rows in 'Needs you to pick up' so the user can claim a request
 * in one click.
 */
function InboxRow({
  request,
  assignee,
  creator,
  muted,
  onPickUp,
  pickingUp,
  disablePickUp,
}: {
  request: EstimateRequest
  assignee: OrgMember | undefined
  creator: OrgMember | undefined
  muted?: boolean
  onPickUp?: () => void
  pickingUp?: boolean
  disablePickUp?: boolean
}) {
  const statusBadgeClass =
    request.status === 'pending'
      ? 'bg-amber-500/15 text-amber-200 border border-amber-500/40'
      : request.status === 'in_progress'
        ? 'bg-blue-500/15 text-blue-200 border border-blue-500/40'
        : request.status === 'completed'
          ? 'bg-emerald-500/15 text-emerald-200 border border-emerald-500/40'
          : 'bg-ink-700 text-ink-300 border border-ink-600'

  // Wrap the Pick up handler so a click on it never navigates the Link.
  function handlePickUpClick(e: React.MouseEvent) {
    e.preventDefault()
    e.stopPropagation()
    if (!onPickUp || pickingUp || disablePickUp) return
    onPickUp()
  }

  return (
    <li>
      <Link
        to={`/requests/${request.id}`}
        className={`block border border-ink-600 rounded-lg bg-ink-800 px-4 py-3 hover:border-beme-500/40 hover:bg-ink-700/40 transition-colors ${
          muted ? 'opacity-90' : ''
        }`}
      >
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-semibold text-ink-50 truncate">
                {request.customerName}
                {request.customerCompany && (
                  <span className="text-ink-400 font-normal ml-1.5 text-sm">
                    — {request.customerCompany}
                  </span>
                )}
              </span>
              <span
                className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium ${statusBadgeClass}`}
              >
                {estimateRequestStatusLabel(request.status)}
              </span>
              <span className="text-[10px] uppercase tracking-wider text-ink-400">
                {request.type === 'brick' ? 'Brick' : 'Block'}
              </span>
            </div>
            <div className="flex items-center gap-2 text-xs text-ink-400 mt-1 flex-wrap">
              {creator && (
                <span>
                  From <span className="text-ink-200">{creator.displayName || creator.email || 'team'}</span>
                </span>
              )}
              {assignee ? (
                <>
                  <span>·</span>
                  <span>
                    To <span className="text-ink-200">{assignee.displayName || assignee.email || 'a teammate'}</span>
                  </span>
                </>
              ) : (
                request.assignedToUserId === null && (
                  <>
                    <span>·</span>
                    <span className="text-ink-300">Unassigned</span>
                  </>
                )
              )}
              <span>·</span>
              <span>{formatRelative(request.updatedAt)}</span>
            </div>
          </div>
          {onPickUp && (
            <button
              type="button"
              onClick={handlePickUpClick}
              disabled={pickingUp || disablePickUp}
              className="shrink-0 px-3 py-1.5 rounded-lg bg-beme-500 text-black text-sm font-semibold hover:bg-beme-400 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {pickingUp ? 'Picking up…' : 'Pick up'}
            </button>
          )}
        </div>
      </Link>
    </li>
  )
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
  const { settings } = useUserSettings()
  const primaryProjectType = settings.preferences.defaultProjectType

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
      const route = project.type === 'brick' ? `/project/brick?id=${newId}` : `/project/block?id=${newId}`
      navigate(route)
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

      {/* Primary actions: two equal-weight cards. Used to share the row
          with an Outcomes donut at col-span-1, but the donut was mostly
          empty for new users and stole real estate from the actions that
          actually start an estimate. Donut moved into the Win-rate stat
          tile above so it still tells the story when data exists. */}
      <section className="mt-6 grid grid-cols-1 md:grid-cols-2 gap-4 items-stretch">
        <Link
          to="/project/brick"
          className="border border-ink-600 rounded-xl bg-ink-800 hover:border-beme-500 hover:bg-ink-700 transition-all p-5 flex flex-col group"
        >
          <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-400">
            Start a new estimate
          </div>
          <h4 className="text-xl font-bold text-beme-400 group-hover:text-beme-300 mt-1 mb-1">
            Brick estimate
          </h4>
          <p className="text-sm text-ink-300">
            Trace brick walls over a plan. Calculates area × bricks/m², plus ties, plascourse,
            and lintels.
          </p>
          <div className="mt-auto pt-3 text-xs text-ink-400 group-hover:text-beme-300 transition-colors">
            Open the brick workspace →
          </div>
        </Link>

        <Link
          to="/project/block"
          className="border border-ink-600 rounded-xl bg-ink-800 hover:border-beme-500 hover:bg-ink-700 transition-all p-5 flex flex-col group"
        >
          <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-400">
            Start a new estimate
          </div>
          <h4 className="text-xl font-bold text-beme-400 group-hover:text-beme-300 mt-1 mb-1">
            Block estimate
          </h4>
          <p className="text-sm text-ink-300">
            Define wall and pier types, draw walls over a plan, auto-tally blocks by code
            with corners and openings.
          </p>
          <div className="mt-auto pt-3 text-xs text-ink-400 group-hover:text-beme-300 transition-colors">
            Open the block workspace →
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
              <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-500 text-xs">
                🔍
              </span>
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
                No saved projects yet. Click <strong>+ Block estimate</strong> or{' '}
                <strong>+ Brick estimate</strong> above to start one.
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
 * Click-through tile for the user's own inbox. Visually consistent with
 * StatTile (border, padding, label / value typography) so the stats row
 * still reads as a four-tile grid, but the whole card is a Link that
 * lands the user on /requests filtered to 'assigned to me'. Replaces the
 * old Avg-turnaround stat because that number wasn't actionable —
 * jumping straight to your own queue is.
 *
 * Count accent: beme orange when there's something waiting, ink-50 when
 * the queue is empty.
 */
function InboxTile({ count }: { count: number }) {
  const accentClass = count > 0 ? 'text-beme-300' : 'text-ink-50'
  return (
    <Link
      to="/requests?scope=mine&status=pending"
      className="block border border-ink-600 rounded-xl bg-ink-800 px-4 py-3.5 hover:border-beme-500/60 hover:bg-ink-700/40 transition-colors group"
    >
      <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-400 flex items-center justify-between gap-2">
        <span>My inbox</span>
        <span className="text-ink-500 group-hover:text-beme-300 transition-colors">→</span>
      </div>
      <div className={`text-2xl font-extrabold tracking-tight tabular-nums mt-1 ${accentClass}`}>
        {count}
      </div>
      <div className="text-xs text-ink-400 mt-0.5">
        {count === 0
          ? 'Nothing assigned to you'
          : `${count === 1 ? 'request waiting' : 'requests waiting'} for you`}
      </div>
    </Link>
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
  const accentClass =
    accent === 'beme'
      ? 'text-beme-300'
      : accent === 'emerald'
        ? 'text-emerald-300'
        : accent === 'amber'
          ? 'text-amber-300'
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
