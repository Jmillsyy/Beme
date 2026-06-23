import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link, useNavigate } from 'react-router-dom'
import DonutChart from '../components/DonutChart'
import LocalMigrationBanner from '../components/LocalMigrationBanner'
import LoadingScreen from '../components/LoadingScreen'
import {
  type ProjectOutcome,
  type ProjectStatus,
  type SavedProject,
  backfillMissingMetrics,
  deleteProject,
  duplicateProject,
  getProject,
  listProjects,
  saveProject,
} from '../lib/projectStorage'
import { accountTypeOf, signOut, useAuth } from '../lib/auth'
import { useUserSettings } from '../lib/userSettings'
import { formatLengthMm } from '../lib/units'
import { confirm } from '../lib/confirm'
import { toast } from '../lib/toast'
import { listOrgMembers, useOrganisations } from '../lib/organisations'
import type { OrgMember, Organisation } from '../types/organisations'


/**
 * Which trades have content in this project. Wraps the post-migration
 * `trades` field with a fallback to the legacy `type` for any project
 * the migration somehow missed (defensive - shouldn't happen). If
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
 * both block and brick projects open the same `PdfWorkspace` - the
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
 * - Single trade (just block OR just brick) → coloured pill with
 * that trade's name.
 * - Both trades → ONE neutral-colour pill labelled "Brick and Block".
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
 * "size" beyond name + date - a 200-block apartment job should look
 * meaningfully different from a 12-block fence quote even before the
 * user opens it. Computed off `wallsByPage` (whatever's saved on the
 * project) without touching the calc engine.
 */
function projectMetrics(project: {
  metrics?: { wallCount: number; runMm: number }
  wallsByPage?: Record<number, Array<{
    startX: number
    startY: number
    endX: number
    endY: number
  }>>
}): { wallCount: number; runMetres: number } {
  // Prefer the precomputed summary stamped at save time - the dashboard's slim
  // list returns this instead of the full wall geometry, which is what keeps
  // the list fast as the project count grows. Fall back to computing from
  // wallsByPage when it's present (local projects, a full getProject payload,
  // or a project not yet covered by the one-time backfill).
  if (project.metrics) {
    return {
      wallCount: project.metrics.wallCount,
      runMetres: project.metrics.runMm / 1000,
    }
  }
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
 * Compact owner-initial pip - round avatar with the user's display
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
      {initials || '-'}
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
 * Splitting the two layouts at the component boundary keeps each one simple -
 * trying to merge them led to a bunch of "this stat is only meaningful for
 * X" branches that obscured the actual UI.
 */
export default function HomePage() {
  const { signedIn, user, loading: authLoading } = useAuth()
  const { currentOrg, loading: orgsLoading } = useOrganisations()
  // Region picker used to auto-pop on the dashboard every signin when
  // no libraryTemplateKey was set, which doubled as a "refresh nag" -
  // the modal came back every reload until the user picked a template.
  // It's now only reachable via Settings → Switch template, so refresh
  // is silent and users opt in when they're ready.

  // Wait for both auth and org info to resolve before deciding which dashboard
  // to render. Otherwise the personal dashboard flashes on first paint for org
  // members (signedIn starts as false → personal-dashboard renders → auth and
  // orgs resolve → org-dashboard takes over a moment later).
  const stillResolving = authLoading || orgsLoading

  // 'org-invited' users (signed up via /accept-invite) never see the personal
  // dashboard - even when they're temporarily not in any org (just removed,
  // or invited to a new org but haven't accepted yet). They live in a
  // different product space than self-served personal users. 'personal'
  // users (legacy admins who signed themselves up before the invite flow
  // existed) keep the existing dual-mode behaviour: OrgDashboard when in an
  // org, PersonalDashboard when not.
  const accountType = accountTypeOf(user)
  const isOrgInvited = accountType === 'org-invited'

  return (
    <>
      {/* Main dashboard column - full width inside the AppShell now
          that the right-rail DashboardSidebar is gone. Navigation
          lives in LeftNav; quick actions and primary CTAs sit
          inline in the dashboard's own hero (see Personal/Org
          dashboard). px-12 instead of the old px-20 since the left
          rail eats some of the page-edge space already. */}
      <div className="px-12 py-10">
        {signedIn && <LocalMigrationBanner />}
        {stillResolving ? (
          <div className="flex items-center justify-center py-24">
            <LoadingScreen
              message="Your workspace is loading"
              steps={[
                'Loading your dashboard…',
                'Fetching your projects…',
                'Crunching the numbers…',
              ]}
            />
          </div>
        ) : (
          <div className="flex flex-col">
            {currentOrg ? (
              <OrgDashboard org={currentOrg} userId={user?.id ?? null} />
            ) : isOrgInvited ? (
              <NoOrgEmptyState />
            ) : (
              <PersonalDashboard />
            )}
          </div>
        )}
      </div>
    </>
  )
}


/**
 * Shown to an 'org-invited' user when they're not currently a member of any
 * organisation - either because they were removed, or their invitation to
 * a new org is still pending. Deliberately doesn't fall through to the
 * personal-projects flow because that's a different product entirely
 * (separate billing track in the longer term).
 */
function NoOrgEmptyState() {
  return (
    <div className="max-w-xl mx-auto py-12">
      <div className="border border-ink-600 rounded-2xl bg-ink-800 p-8 text-center">
        <div className="mx-auto w-14 h-14 rounded-xl bg-beme-500/15 border border-beme-500/40 flex items-center justify-center mb-4" />
        <h2 className="text-2xl font-extrabold tracking-tight text-ink-50 mb-2">
          You're not in any organisation
        </h2>
        <p className="text-sm text-ink-300 mb-6">
          Your account was set up via an invitation, so you'll see work
          here once an admin adds you to an organisation. If you were
          recently removed or expected to be a member already, reach out
          to whoever runs your team - they can send a fresh invite link.
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
// Org dashboard - what an ABC employee sees
// ============================================================================

/**
 * Org-aware dashboard. Projects-led now that the estimate-request /
 * inbox flow has been removed - users share work by handing over a
 * 6-digit reference number, not by routing it through an inbox.
 *
 * Layout:
 * - Title row + actions ("+ New estimate" is the primary action;
 * no request-creation surface any more).
 * - Stats row: in-progress + completed-this-week. Both sourced from
 * PROJECTS.
 * - "Your projects" - projects this user started.
 * - "Team projects" - active projects belonging to other org members,
 * so an admin can see the team's load at a glance.
 * - "Completed" - every finished project across the team, most recent
 * first. (Was windowed to the last 7 days, but the column went empty
 * during slow weeks and made the dashboard feel barren.)
 */
function OrgDashboard({ org, userId }: { org: Organisation; userId: string | null }) {
  const [members, setMembers] = useState<OrgMember[]>([])
  // All projects visible to the user - both org-scoped (everyone on the team
  // sees them) and personal (their own).
  const [projects, setProjects] = useState<SavedProject[]>([])
  const [, setLoading] = useState(true)

  // Wrapped in useCallback so the focus / visibility listeners below
  // can reuse the same loader without re-creating it on every render.
  // The org id is the only dependency that determines what to fetch.
  const reloadDashboard = useCallback(() => {
    let cancelled = false
    setLoading(true)
    // allSettled instead of all so a failed listOrgMembers fetch doesn't
    // tank the project list (and vice versa). The previous Promise.all
    // had `.catch(() => setLoading(false))` with no logging - when one
    // of the two fetches rejected (e.g. transient network blip on
    // navigation back to the dashboard), BOTH state updates were
    // skipped and the user saw an empty dashboard with no surfaced
    // error. allSettled lets us apply whichever fetch succeeded and
    // log the one that didn't.
    //
    // listProjects returns every project this user can see (their own
    // + any org-scoped project where they're a member). Cloud RLS does
    // the filtering server-side so anyone in the org sees the same set.
    Promise.allSettled([listOrgMembers(org.id), listProjects()])
      .then(([memsResult, projsResult]) => {
        if (cancelled) return
        if (memsResult.status === 'fulfilled') {
          setMembers(memsResult.value)
        } else {
          // eslint-disable-next-line no-console
          console.error('Failed to load org members', memsResult.reason)
        }
        if (projsResult.status === 'fulfilled') {
          setProjects(projsResult.value)
          // One-time: projects saved before the metrics field carry no size
          // line in the slim list. Backfill in the background and merge the
          // numbers in so the cards fill without a reload (next load is then
          // already fast). Guarded so it stops once every project has metrics.
          if (projsResult.value.some((p) => !p.metrics)) {
            void backfillMissingMetrics().then((patched) => {
              if (cancelled || patched.length === 0) return
              const byId = new Map(patched.map((p) => [p.id, p.metrics] as const))
              setProjects((prev) =>
                prev.map((p) => {
                  const m = byId.get(p.id)
                  return m ? { ...p, metrics: m } : p
                }),
              )
            })
          }
        } else {
          // eslint-disable-next-line no-console
          console.error('Failed to load projects', projsResult.reason)
        }
        setLoading(false)
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
  // dashboard - without this, the stats stayed stale until a hard
  // reload. Same handler covers the multi-device case: tab away to
  // a different machine, come back, see the up-to-date numbers.
  useEffect(() => {
    const refresh = () => {
      // Skip when the tab is hidden - no point fetching if the user
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


  // Stats: in-progress + completed-this-week, both sourced from
  // PROJECTS. Pending / inbox tiles are gone with the request system -
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
    // "Stale" - in-progress projects that haven't been touched in 5+
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
  // underlying estimate request, or they started a direct '+ Brick /
  // + Block' project) OR they're the current assignee of the linked
  // estimate request (i.e. they were allocated to work on it,
  // regardless of who created it).
  //
  // Split in-progress projects into 'mine' vs 'team'. With the inbox
  // flow gone, ownership is solely creator/owner - no assignee
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

  // Team-wide "shipped" feed - every completed project, most recent
  // first. Previously windowed to the last 7 days, but the column
  // was empty most of the time when nothing had shipped that week,
  // which made the dashboard feel barren. Now the column always has
  // something to show as long as the team has ever finished
  // anything; CompletedColumn handles slicing + overflow.
  const recentlyCompleted = useMemo(() => {
    return projects
      .filter((p) => p.status === 'completed')
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
        <div className="relative">
          {/* Orange accent bar to the left of the heading - gives the
              hero a confident brand anchor without the heading itself
              having to carry colour. Pairs with the AppShell's top
              gradient strip so the page reads as "branded". */}
          <span
            aria-hidden="true"
            className="absolute -left-3 top-1 bottom-1 w-1 rounded-full bg-gradient-to-b from-beme-400 to-beme-600"
          />
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
          so the row stays a clean glance - a "View all →" link surfaces
          below the column when there's more. Stacks vertically on
          narrow viewports so the rows don't squash. Hidden entirely
          when neither column has any work. */}
      {/* ── Project lists - three columns side by side ──
          Your projects · Your team's projects · Completed.
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
              emptyCopy="No personal projects on the go - kick one off above."
            />
            <ProjectsColumn
              title="Your team's projects"
              projects={teamProjects}
              viewAllHref="/projects?status=in-progress"
              members={members}
              currentUserId={userId}
              slotCount={slotCount}
              emptyCopy="Quiet over here - your team's caught up."
            />
            <CompletedColumn
              title="Completed"
              projects={recentlyCompleted}
              viewAllHref="/projects?status=completed"
              slotCount={slotCount}
              emptyCopy="No completed projects yet."
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
 * sides render the same number of slots - empty slots become dashed-
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
        <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-ink-200">
          <span className="inline-block w-2 h-2 rounded-full bg-beme-500 shadow-sm shadow-beme-500/40" aria-hidden="true" />
          {title}
          <span className="text-ink-500 normal-case tracking-normal font-normal">
            · {projects.length}
          </span>
        </h3>
        <span className="text-xs text-ink-400 whitespace-nowrap">
          {projects.length === 1 ? 'project on the go' : 'projects on the go'}
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
                vanishing into the page background - was almost
                invisible at ink-700/60 + ink-800/20. */}
            <div className="border border-dashed border-ink-500/70 rounded-lg bg-ink-800/60 px-4 py-3 min-h-[124px] flex items-center justify-center text-center">
              <span className="text-xs text-ink-300">
                {i === 0 && visible.length === 0 ? emptyCopy : '-'}
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
 * Recently-completed column - sister of {@link ProjectsColumn} that
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
        <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-ink-200">
          <span className="inline-block w-2 h-2 rounded-full bg-emerald-400 shadow-sm shadow-emerald-400/40" aria-hidden="true" />
          {title}
          <span className="text-ink-500 normal-case tracking-normal font-normal">
            · {projects.length}
          </span>
        </h3>
        <span className="text-xs text-ink-400 whitespace-nowrap">
          {projects.length === 1 ? 'project completed' : 'projects completed'}
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
                {i === 0 && visible.length === 0 ? emptyCopy : '-'}
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
 * a richer card because there's less status to convey - the project's just
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
  const { settings: rowSettings } = useUserSettings()
  const rowUnits = rowSettings.preferences.units
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

  // Resolve the owner ONLY to a real, named teammate (an org member we can
  // actually look up). We deliberately do NOT fall back to a generic
  // "a teammate" label for an unresolved ownerId: on a solo / individual
  // account the owner IS the current user (just not present in a members
  // list), and the row was wrongly reading "a teammate" for their own
  // projects. No resolved member -> no pip. The pip is also suppressed when
  // the project is the current user's (the column header already says
  // "Your projects").
  const ownerId = project.ownerUserId ?? project.createdByUserId ?? null
  const ownerMember = ownerId ? members.find((m) => m.userId === ownerId) : null
  const ownerName = ownerMember?.displayName || ownerMember?.email || null
  const isMyProject = ownerId && currentUserId && ownerId === currentUserId

  const trades = tradesOf(project)
  const metrics = projectMetrics(project)
  const sizeLine =
    metrics.wallCount > 0
      ? `${metrics.wallCount} wall${metrics.wallCount === 1 ? '' : 's'} · ${formatLengthMm(metrics.runMetres * 1000, rowUnits)} run`
      : 'No walls drawn yet'

  return (
    <li>
      <Link
        to={href}
        className="relative block border border-ink-600 rounded-lg bg-ink-800 pl-5 pr-4 py-3 min-h-[124px] hover:border-beme-500/50 hover:bg-ink-700/30 hover:shadow-lg hover:shadow-beme-500/5 hover:-translate-y-px transition-all duration-150 overflow-hidden"
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
          <div className="flex items-center gap-2 min-w-0">
            {/* Title takes the leftover space; truncates with
                ellipsis when the project name is longer than the
                row can fit. Removing flex-wrap means the reference
                and trade badges always stay on the top line beside
                the (possibly truncated) name. */}
            <span className="font-semibold text-ink-50 truncate flex-1 min-w-0">
              {name}
            </span>
            {typeof project.referenceNumber === 'number' && (
              <span
                className="inline-flex items-center px-1.5 py-0.5 rounded-md bg-beme-500/10 border border-beme-500/20 text-[10px] tabular-nums font-semibold text-beme-300 flex-shrink-0"
                title="Reference number - quote this when looking the project up."
              >
                #{formatRef(project.referenceNumber)}
              </span>
            )}
            <span className="flex-shrink-0">
              <TradeBadges trades={trades} />
            </span>
          </div>
          {/* Subtitle slot always rendered so rows of varying content
              (with/without an address line) keep an identical height.
              Empty when not present - gives the next line a stable
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
              the right (only when not the current user - owners of
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
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-semibold text-ink-50 truncate flex-1 min-w-0">
            {title}
          </span>
          {typeof project.referenceNumber === 'number' && (
            <span
              className="text-[11px] tabular-nums font-semibold text-beme-500 flex-shrink-0"
              title="Reference number - quote this when looking the project up."
            >
              #{formatRef(project.referenceNumber)}
            </span>
          )}
          <span className="flex-shrink-0">
            <TradeBadges trades={trades} />
          </span>
        </div>
        {/* Subtitle slot always rendered so rows of varying content
            (with/without a site-address line) keep an identical
            vertical footprint. */}
        <div className="text-sm text-ink-300 mt-0.5 truncate min-h-[20px]">
          {sub && sub !== title ? sub : ' '}
        </div>
        {/* Size line - same line the in-progress sibling shows. */}
        <div className="text-xs text-ink-300/80 mt-1 tabular-nums">
          {sizeLine}
        </div>
        {/* Footer row: completed-relative on the left, turnaround
            chip on the right - same shape as the in-progress card's
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
// Personal dashboard - what a supply-and-lay bricklayer sees
// ============================================================================

/**
 * Personal dashboard for users not signed in to any organisation. Same UI
 * we've had since the dashboard was first built - outcome donut, win-rate
 * stats, full projects list with won/lost filters. The metaphor here is a
 * subcontractor quoting their own jobs, so win rate is the headline metric.
 */
function PersonalDashboard() {
  const navigate = useNavigate()
  const [projects, setProjects] = useState<SavedProject[]>([])
  const [searchQuery, setSearchQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const { signedIn, user } = useAuth()

  const refreshProjects = useCallback(() => {
    setLoading(true)
    listProjects()
      .then((list) => {
        setProjects(list)
        // One-time backfill for projects saved before the metrics field (see
        // the org loader for the rationale). Background + guarded so it stops
        // once everything has metrics.
        if (list.some((p) => !p.metrics)) {
          void backfillMissingMetrics().then((patched) => {
            if (patched.length === 0) return
            const byId = new Map(patched.map((p) => [p.id, p.metrics] as const))
            setProjects((prev) =>
              prev.map((p) => {
                const m = byId.get(p.id)
                return m ? { ...p, metrics: m } : p
              }),
            )
          })
        }
      })
      .catch((err) => console.error('Failed to list projects', err))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    refreshProjects()
  }, [refreshProjects, signedIn])

  // Refresh whenever the window regains focus or the tab becomes
  // visible - mirrors OrgDashboard's behaviour so the personal
  // dashboard also catches the workflow where the user marks a
  // project done in the workspace, hops to another tab, then
  // returns. Without it the dashboard sat stale until a hard
  // reload. The mount-time effect above already covers fresh
  // navigation-back via React Router; this covers the rest.
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState !== 'visible') return
      refreshProjects()
    }
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [refreshProjects])

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


  /**
   * Splits projects into Current (in-progress) and Completed for
   * the side-by-side dashboard layout. Search applies to the
   * Current column only - Completed is a historical archive that
   * doesn't need to be hunted through; the user can flip a project
   * back to in-progress if they need to re-touch it.
   */
  const currentProjects = useMemo(() => {
    const base = projects.filter((p) => p.status !== 'completed')
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
  }, [projects, searchQuery])
  const completedProjects = useMemo(
    () => projects.filter((p) => p.status === 'completed'),
    [projects],
  )
  // Dashboard caps each column at 3 rows so the page stays scannable.
  // The "View all" link below routes to /projects with the matching
  // status filter pre-applied. Sorted most-recently-updated first so
  // the four rows are the freshest work, not the first 4 the API
  // returned.
  const DASHBOARD_PROJECTS_PER_COLUMN = 4
  const currentProjectsVisible = useMemo(
    () =>
      [...currentProjects]
        .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
        .slice(0, DASHBOARD_PROJECTS_PER_COLUMN),
    [currentProjects],
  )
  const completedProjectsVisible = useMemo(
    () =>
      [...completedProjects]
        .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
        .slice(0, DASHBOARD_PROJECTS_PER_COLUMN),
    [completedProjects],
  )
  const currentHasMore =
    currentProjects.length > DASHBOARD_PROJECTS_PER_COLUMN
  const completedHasMore =
    completedProjects.length > DASHBOARD_PROJECTS_PER_COLUMN

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
    // `projects` state lacks the blob payloads - listProjects() returns
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
        // Couldn't snapshot - degraded UX (no Undo) but the delete still
        // works. Surface the situation in the description so the user
        // isn't surprised.
        toast.success('Project deleted', {
          description: 'Undo not available - the project couldn\'t be snapshotted.',
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
   * wall types, brick settings, pier patterns etc. - but no walls, no PDFs.
   * The whole point is "start a new job from my last similar one in one click",
   * so we route the user straight into the new workspace afterwards.
   */
  async function handleDuplicate(project: SavedProject) {
    try {
      const newId = await duplicateProject(project.id)
      if (!newId) {
        toast.error('Could not duplicate that project.')
        return
      }
      // Push the new project into the list immediately so the user sees a
      // confirming entry before the route change kicks in. Then navigate.
      const refreshed = await listProjects()
      setProjects(refreshed)
      // Confirmation toast - the navigation that follows is fast enough
      // that the user sees this for a split second on the dashboard,
      // then it follows them into the new project. The "Stay here"
      // action lets a user who duplicated by accident bail out of the
      // route change before it commits.
      toast.success('Project duplicated', {
        description: 'A fresh copy is ready to edit. Walls and walls types carry over.',
      })
      navigate(projectUrl({ ...project, id: newId }))
    } catch (err) {
      console.error('Failed to duplicate', err)
      toast.error('Could not duplicate that project.', {
        description: (err as Error).message,
      })
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
      // Outcome cycling is a low-stakes label change - keep the toast
      // light (info, short) so it doesn't feel like a Major Event. The
      // colour ribbon on the project card moves immediately, which is
      // the main feedback; this toast just labels what changed for
      // users who didn't notice the colour shift.
      const label =
        next === 'won' ? 'Marked as won' :
        next === 'lost' ? 'Marked as lost' :
        'Outcome cleared'
      toast.info(label)
    } catch (err) {
      console.error('Failed to update outcome', err)
      setProjects((prev) => prev.map((p) => (p.id === project.id ? project : p)))
      toast.error('Could not update outcome', {
        description: (err as Error).message,
      })
    }
  }

  // Name for the hero greeting. Prefer the display name the user set in
  // Settings (read through the reactive settings hook so editing it updates
  // the greeting live), then fall back to the email local-part
  // ("joshmills03@hotmail.com" -> "joshmills03"), then null when signed out
  // so the greeting degrades gracefully.
  const { settings: dashboardSettings } = useUserSettings()
  const personalName =
    dashboardSettings.profile.displayName.trim() ||
    (user?.email ? user.email.split('@')[0] : null)

  // Greeting + date for the hero meta strip on the top right. Compact
  // 2-line read: greeting (with name when known) on top, date below.
  // Replaces the previous WelcomeStrip which carried an extra
  // amber "X projects on the go" pill that duplicated the stat
  // ribbon below.
  const hour = new Date().getHours()
  const greeting =
    hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'
  const today = new Date().toLocaleDateString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  })

  // No-projects state drives the big invitation hero instead of
  // showing two empty Current / Completed sections side by side.
  // The screenshot complaint that the dashboard "feels unorganised"
  // came from this case: skeleton rows + a quartet of dashed boxes
  // looked like broken UI rather than intentional zero-state.
  const hasAnyProjects = projects.length > 0

  return (
    // flex flex-col + flex-1 so PersonalDashboard fills the height
    // of its parent (which now stretches to match the sidebar).
    <div className="flex flex-col flex-1">
      {/* ── Hero ──
          Single bold heading + sublead on the left, compact date /
          greeting cluster on the right. Date sits in a quiet pill so
          it reads as metadata, not a competing headline. */}
      <div className="flex items-start justify-between flex-wrap gap-4">
        <div className="min-w-0 relative">
          {/* Brand accent bar to the left of the heading - pairs with
              the AppShell's top gradient strip so the page anchors
              orange on two axes (top + left) without going overboard. */}
          <span
            aria-hidden="true"
            className="absolute -left-3 top-1 bottom-1 w-1 rounded-full bg-gradient-to-b from-beme-400 to-beme-600"
          />
          <h2 className="text-3xl font-extrabold tracking-tight text-ink-50 leading-tight">
            Your dashboard
          </h2>
          <p className="text-ink-300 text-sm mt-1.5">
            Track your projects, win rate, and active jobs at a glance.
          </p>
        </div>
        <div className="text-right flex-shrink-0">
          <div className="text-sm text-ink-300">
            {greeting}
            {personalName && (
              <>
                , <span className="text-ink-50 font-semibold">{personalName}</span>
              </>
            )}
          </div>
          <div className="inline-flex items-center gap-1.5 mt-1.5 px-2.5 py-1 rounded-full bg-ink-800 border border-ink-600 text-[11px] text-ink-300 tabular-nums">
            <span className="w-1 h-1 rounded-full bg-beme-500" aria-hidden />
            {today}
          </div>
        </div>
      </div>

      {/* Primary CTA row - big confident "+ New estimate" button as
          the page's primary action, separated from the stats so the
          eye lands on it directly. Replaces the previous
          NewEstimateTile that sat awkwardly mixed in with the stat
          tiles. On wider screens, sits inline with a quick-scan
          summary line. */}
      <div className="mt-7 flex items-center gap-3 flex-wrap">
        <Link
          to="/project/block"
          className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-beme-500 text-black text-sm font-semibold hover:bg-beme-400 transition-colors shadow-lg shadow-beme-500/20"
        >
          <span className="text-lg leading-none">+</span>
          New estimate
        </Link>
        <span className="text-xs text-ink-400">
          Block, brick, or both - switch trades inside.
        </span>
      </div>

      {/* Stat ribbon - 4 equal tiles. Total / In progress / Won /
          Win rate. Win rate uses the WinRateTile (mini donut) so the
          row reads as a real metrics dashboard rather than four
          interchangeable cells. Keeps the same visual rhythm in any
          state (loading, no projects, full project list). */}
      <section className="mt-6 grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatTile
          label="Total projects"
          value={stats.total}
          sub={
            stats.total === 0
              ? 'No estimates yet'
              : stats.completed === 0
                ? `${stats.inProgress} in progress`
                : `${stats.completed} completed`
          }
        />
        <StatTile
          label="In progress"
          value={stats.inProgress}
          accent="beme"
          sub={
            stats.inProgress === 0
              ? 'Nothing on the go'
              : stats.inProgress === 1
                ? '1 active estimate'
                : `${stats.inProgress} active`
          }
        />
        <StatTile
          label="Won"
          value={stats.won}
          accent="emerald"
          sub={
            stats.won + stats.lost === 0
              ? 'No outcomes yet'
              : `${stats.lost} lost · ${stats.pending} pending`
          }
        />
        <WinRateTile
          winRate={stats.winRate}
          won={stats.won}
          lost={stats.lost}
          pending={stats.pending}
        />
      </section>

      {/* Loading state - first paint while listProjects resolves.
          Single skeleton row + one helper line so the user sees
          motion without a full faux UI flickering on top of itself.
          Hidden once `loading` flips, regardless of how many
          projects came back. */}
      {loading && (
        <div className="mt-8 flex items-center justify-center py-8">
          <LoadingScreen
            message="Loading your projects"
            steps={['Fetching your estimates…', 'Tallying it up…']}
          />
        </div>
      )}

      {/* Zero-project state - single confident hero card with a
          big CTA, instead of two separate dashed-border "Current"
          and "Completed" placeholders. Reads as "you're here to
          start something" rather than "the dashboard is broken /
          empty". Only shows after the loading flip - keeps the
          first paint from flashing two different empty states. */}
      {!loading && !hasAnyProjects && (
        <section className="mt-8 flex-1 flex items-center justify-center">
          <div className="w-full border border-ink-600 rounded-2xl bg-ink-800/60 px-8 py-12 text-center">
            <div className="mx-auto w-14 h-14 rounded-full bg-beme-500/15 border border-beme-500/40 flex items-center justify-center mb-5">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="w-7 h-7 text-beme-400"
                aria-hidden
              >
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
                <line x1="12" y1="18" x2="12" y2="12" />
                <line x1="9" y1="15" x2="15" y2="15" />
              </svg>
            </div>
            <h3 className="text-xl font-bold text-ink-50 tracking-tight">
              Start your first estimate
            </h3>
            <p className="text-sm text-ink-400 mt-2 leading-relaxed">
              Upload a plan or start with a blank workspace. Block, brick,
              or both - every project supports both trades.
            </p>
            <div className="mt-6 flex items-center justify-center gap-3 flex-wrap">
              <Link
                to="/project/block"
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-beme-500 text-black text-sm font-semibold hover:bg-beme-400 transition-colors shadow-lg shadow-beme-500/20"
              >
                <span className="text-lg leading-none">+</span>
                New estimate
              </Link>
              <Link
                to="/guide"
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-ink-300 text-sm hover:text-ink-100 hover:bg-ink-700/60 transition-colors"
              >
                View the guide
                <span className="text-ink-500">→</span>
              </Link>
            </div>
          </div>
        </section>
      )}

      {/* Project rail - only renders when the user has at least one
          project. Splits into Current (in-progress) and Completed
          stacked vertically. Completed hides entirely when empty
          (the zero-project block above handles the all-empty case,
          and showing a dashed "no completed" box on a project that's
          still in progress is more noise than help).
          Each section caps at 4 rows on the dashboard with a "View
          all" affordance below. */}
      {!loading && hasAnyProjects && (
      <section className="mt-8 flex-1 grid grid-cols-1 gap-y-8 items-start">
        {/* Current - single small-uppercase header matching the
            OrgDashboard ProjectsColumn pattern. No marketing-style
            eyebrow + large heading combo. The orange dot keeps a
            tiny brand touch without dominating. */}
        <div className="flex flex-col">
          <div className="flex items-center justify-between flex-wrap gap-3 mb-3">
            <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-ink-400">
              <span aria-hidden="true" className="inline-block w-1.5 h-1.5 rounded-full bg-beme-500" />
              Your projects
              <span className="text-ink-500 normal-case font-normal tracking-normal">
                · {currentProjects.length}
              </span>
            </h3>
            <div className="relative">
              <input
                type="search"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search…"
                className="pl-8 pr-3 py-1.5 w-44 rounded-lg border border-ink-600 bg-ink-800 text-sm text-ink-100 placeholder:text-ink-500 focus:outline-none focus:border-beme-400"
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
          </div>

          {/* Search-miss / all-completed states. Loading + first-
              project state are handled at the outer level so this
              section only renders Current when there's something
              to show OR when the user is actively searching and we
              need to tell them no matches. */}
          {currentProjects.length === 0 && (
            <div className="border border-dashed border-ink-600 rounded-xl bg-ink-800/40 text-ink-400 px-6 py-8 text-center flex flex-col items-center justify-center gap-2">
              <div className="text-sm">
                {searchQuery ? (
                  <>
                    <div className="text-ink-200 font-medium">No matches.</div>
                    <div className="text-xs text-ink-500 mt-1">
                      Nothing matches <strong>"{searchQuery}"</strong>.
                    </div>
                  </>
                ) : (
                  <>
                    <div className="text-ink-200 font-medium">All caught up.</div>
                    <div className="text-xs text-ink-500 mt-1">
                      Every project is filed under Completed.
                    </div>
                  </>
                )}
              </div>
            </div>
          )}

          {currentProjects.length > 0 && (
            <>
              <ul className="space-y-2">
                {currentProjectsVisible.map((p) => (
                  <ProjectRow
                    key={p.id}
                    project={p}
                    onDelete={() => handleDelete(p.id)}
                    onDuplicate={() => handleDuplicate(p)}
                    onCycleOutcome={() => handleCycleOutcome(p)}
                  />
                ))}
              </ul>
              {currentHasMore && (
                <div className="mt-3 flex justify-end">
                  <Link
                    to="/projects?status=in-progress"
                    className="inline-flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded-md border border-ink-600 text-ink-300 hover:border-beme-500/50 hover:text-beme-300 transition-colors"
                  >
                    View all
                    <span className="text-ink-500">
                      · {currentProjects.length}
                    </span>
                  </Link>
                </div>
              )}
              {/* Filler - keeps the column visually full when it
                  has fewer rows than the sidebar's height allows.
                  Doubles as a soft "start another" affordance so
                  the placeholder earns its space rather than just
                  being a blank box. flex-1 absorbs the leftover
                  vertical room; min-h sets a floor so it doesn't
                  collapse on a busy column. */}
              <Link
                to="/project/block"
                className="flex-1 mt-3 border border-dashed border-ink-600 hover:border-ink-500 rounded-xl bg-ink-800/30 hover:bg-ink-800/50 text-ink-400 hover:text-ink-200 transition-colors flex items-center justify-center min-h-[4rem] text-xs font-medium gap-1.5"
              >
                <span className="text-base">+</span>
                Start another estimate
              </Link>
            </>
          )}
        </div>

        {/* ── Completed ── flex column so the empty state can
            grow to fill the same height as the Current column on
            wide screens (items-stretch on the grid above gives the
            container the height; the inner flex grows the empty
            state into it). */}
        {/* Completed column - only renders when the user actually
            HAS completed projects. Empty completed state used to
            show a dashed-border "no completed" panel under every
            in-progress project, which made the dashboard look like
            it was missing content. Hidden entirely now until at
            least one project is closed out. */}
        {completedProjects.length > 0 && (
          <div className="flex flex-col">
            <div className="flex items-center justify-between flex-wrap gap-3 mb-3">
              <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-ink-400">
                <span aria-hidden="true" className="inline-block w-1.5 h-1.5 rounded-full bg-beme-500" />
                Completed projects
                <span className="text-ink-500 normal-case font-normal tracking-normal">
                  · {completedProjects.length}
                </span>
              </h3>
            </div>
            <ul className="space-y-2">
              {completedProjectsVisible.map((p) => (
                <ProjectRow
                  key={p.id}
                  project={p}
                  onDelete={() => handleDelete(p.id)}
                  onDuplicate={() => handleDuplicate(p)}
                  onCycleOutcome={() => handleCycleOutcome(p)}
                />
              ))}
            </ul>
            {completedHasMore && (
              <div className="mt-3 flex justify-end">
                <Link
                  to="/projects?status=completed"
                  className="inline-flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded-md border border-ink-600 text-ink-300 hover:border-beme-500/50 hover:text-beme-300 transition-colors"
                >
                  View all
                  <span className="text-ink-500">
                    · {completedProjects.length}
                  </span>
                </Link>
              </div>
            )}
          </div>
        )}
      </section>
      )}

      {/* Material library and Beme guide tiles moved to the dashboard
          sidebar (right rail) - see DashboardSidebar in HomePage. */}
    </div>
  )
}


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
 * Falls back to the standard "-" + sub-line treatment when no outcomes
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
        value="-"
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
  accent?: 'beme' | 'emerald' | 'amber' | 'sky'
}) {
  // Accent colours follow the marketing site's tri-colour palette
  // (beme / amber / sky) plus emerald for "won" - the dot next to the
  // eyebrow makes the row read like a real category strip rather
  // than a wall of numbers. Numbers tuned one step brighter than the
  // eyebrow so the value carries the brand colour strongly.
  const accentText =
    accent === 'beme'
      ? 'text-beme-500'
      : accent === 'emerald'
        ? 'text-emerald-400'
        : accent === 'amber'
          ? 'text-amber-400'
          : accent === 'sky'
            ? 'text-sky-400'
            : 'text-ink-50'
  const dotBg =
    accent === 'beme'
      ? 'bg-beme-500'
      : accent === 'emerald'
        ? 'bg-emerald-400'
        : accent === 'amber'
          ? 'bg-amber-400'
          : accent === 'sky'
            ? 'bg-sky-400'
            : 'bg-ink-500'
  // All tiles share the same flat panel chrome - plain bg, neutral
  // border, no gradient washes or atmospheric blobs. The previous
  // beme/emerald/amber tinted gradients muddied the dashboard with
  // four different tile flavours; user wanted them dropped. Accent
  // colour is still conveyed by the dot in the eyebrow and the
  // tinted number, which is the actual semantic signal - the rest
  // of the card stays calm white.
  return (
    <div className="border border-ink-600 rounded-2xl bg-ink-800 px-5 py-4 lift">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-400 flex items-center gap-2">
        {accent && (
          <span aria-hidden="true" className={`inline-block w-1.5 h-1.5 rounded-full ${dotBg}`} />
        )}
        {label}
      </div>
      <div className={`text-3xl font-bold tracking-tight tabular-nums mt-2 ${accentText}`}>
        {value}
      </div>
      {sub && <div className="text-xs text-ink-400 mt-1">{sub}</div>}
    </div>
  )
}

/**
 * "+ New estimate" tile that lives in the stats row to the right of
 * the read-only metrics. Matches StatTile's outer shape (border,
 * radius, padding) so the row reads as three equal cells, but the
 * whole thing is a Link with a beme-orange title + descriptive
 * sub-line - visually the primary CTA on the page.
 */
function NewEstimateTile() {
  return (
    <Link
      to="/project/block"
      title="Start a new masonry estimate - block, brick, or both"
      className="block border border-beme-500/40 rounded-2xl bg-ink-800 px-5 py-4 hover:border-beme-500/70 hover:bg-beme-500/5 transition-colors group lift"
    >
      <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-beme-500 flex items-center justify-between gap-2">
        <span>Start a new estimate</span>
        <span className="text-beme-500 group-hover:translate-x-0.5 transition-transform">→</span>
      </div>
      <div className="text-xl font-extrabold tracking-tight mt-1 text-beme-500 group-hover:text-beme-600">
        + New estimate
      </div>
      <div className="text-xs text-ink-400 mt-0.5">
        Block, brick, or both - switch trades inside
      </div>
    </Link>
  )
}


/**
 * Per-row overflow menu. Secondary / destructive actions (Duplicate,
 * Delete) live here so the row reads calm and Delete isn't a one-slip-
 * away button. The dropdown is portaled to <body> so it escapes the
 * row's `overflow-hidden` and never tucks behind the next row. Closes
 * on outside-click, scroll, or resize.
 */
function RowActionsMenu({
  onDuplicate,
  onDelete,
}: {
  onDuplicate: () => void
  onDelete: () => void
}) {
  const [open, setOpen] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)
  const [pos, setPos] = useState<{ top: number; right: number }>({ top: 0, right: 0 })
  useEffect(() => {
    if (!open) return
    const close = () => setOpen(false)
    window.addEventListener('click', close)
    window.addEventListener('resize', close)
    window.addEventListener('scroll', close, true)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('resize', close)
      window.removeEventListener('scroll', close, true)
    }
  }, [open])
  return (
    <>
      <button
        ref={btnRef}
        type="button"
        aria-label="More actions"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          e.preventDefault()
          e.stopPropagation()
          if (open) {
            setOpen(false)
            return
          }
          const r = btnRef.current?.getBoundingClientRect()
          if (r) setPos({ top: r.bottom + 4, right: Math.max(8, window.innerWidth - r.right) })
          setOpen(true)
        }}
        className="absolute top-2.5 right-2.5 w-7 h-7 flex items-center justify-center rounded-md text-ink-400 hover:text-ink-100 hover:bg-ink-700 transition-colors"
      >
        <span className="text-lg leading-none">⋯</span>
      </button>
      {open &&
        createPortal(
          <div
            role="menu"
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
            }}
            style={{ position: 'fixed', top: pos.top, right: pos.right }}
            className="w-40 rounded-lg border border-ink-600 bg-ink-800 shadow-xl py-1 z-50"
          >
            <button
              type="button"
              role="menuitem"
              onClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                setOpen(false)
                onDuplicate()
              }}
              className="w-full text-left px-3 py-2 text-sm text-ink-200 hover:bg-beme-500/10 hover:text-beme-300 transition-colors"
            >
              Duplicate
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                setOpen(false)
                onDelete()
              }}
              className="w-full text-left px-3 py-2 text-sm text-rose-300 hover:bg-rose-500/10 transition-colors"
            >
              Delete
            </button>
          </div>,
          document.body,
        )}
    </>
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
  const { settings: rowSettings } = useUserSettings()
  const rowUnits = rowSettings.preferences.units
  // Trade(s) on this project drive the left-edge stripe AND the badge.
  // Using `trades` (not the legacy single `type`) so a block+brick job
  // reads "Brick and Block" and opens on its real first trade.
  const trades = tradesOf(project)
  // Glanceable job "size" - wall count + total run - so a 200-block
  // apartment looks different from a 6-block fence before you open it.
  // Reads off the saved wallsByPage (present in the slim list query).
  const metrics = projectMetrics(project)
  const sizeLine =
    metrics.wallCount > 0
      ? `${metrics.wallCount} wall${metrics.wallCount === 1 ? '' : 's'} · ${formatLengthMm(metrics.runMetres * 1000, rowUnits)} run`
      : 'No walls drawn yet'

  return (
    <li className="relative border border-ink-600 rounded-xl bg-ink-800 hover:border-beme-500/50 hover:shadow-lg hover:shadow-beme-500/5 hover:-translate-y-px transition-all duration-150 overflow-hidden">
      {/* Trade stripe - matches the org dashboard project rows so the
          eye can pick block vs brick at a glance across both
          dashboards without having to read the badge. */}
      <span
        aria-hidden="true"
        className={`absolute left-0 top-0 bottom-0 w-1 ${tradeStripeClass(trades)}`}
      />
      {/* The whole card opens the project - one obvious primary action,
          no redundant "Open" button. The won/lost pill (inline) and the
          ⋯ menu both stop propagation so they never trigger navigation.
          pr-11 reserves room for the ⋯ button in the top-right corner. */}
      <Link
        to={projectUrl(project)}
        className="block p-4 pl-5 pr-11 group"
      >
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-base font-semibold text-ink-50 group-hover:text-beme-300 transition-colors">
            {name}
          </span>
          {typeof project.referenceNumber === 'number' && (
            <span
              className="inline-flex items-center px-1.5 py-0.5 rounded-md bg-beme-500/10 border border-beme-500/20 text-[10px] tabular-nums font-semibold text-beme-300"
              title="Reference number - quote this when looking the project up."
            >
              #{formatRef(project.referenceNumber)}
            </span>
          )}
          {statusBadge(project.status)}
          <OutcomePill outcome={project.outcome} onClick={onCycleOutcome} />
          <TradeBadges trades={trades} />
        </div>
        {subtitle && <div className="text-sm text-ink-300 mt-0.5">{subtitle}</div>}
        {/* Size line - gives each row weight beyond name + date.
            tabular-nums so counts don't shimmy the column alignment. */}
        <div className="text-xs text-ink-300/80 mt-1 tabular-nums">{sizeLine}</div>
        <div className="text-xs text-ink-400 mt-1">
          Updated {formatRelative(project.updatedAt)}
          {project.completedAt && (
            <span> · Completed {formatRelative(project.completedAt)}</span>
          )}
        </div>
      </Link>
      <RowActionsMenu onDuplicate={onDuplicate} onDelete={onDelete} />
    </li>
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
