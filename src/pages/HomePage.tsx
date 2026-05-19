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
  listProjects,
  saveProject,
} from '../lib/projectStorage'
import { accountTypeOf, signOut, useAuth } from '../lib/auth'
import { useUserSettings } from '../lib/userSettings'
import { listOrgMembers, useOrganisations } from '../lib/organisations'
import {
  listEstimateRequests,
  pickUpEstimateRequest,
} from '../lib/estimateRequests'
import type { EstimateRequest } from '../types/estimateRequests'
import { estimateRequestStatusLabel } from '../types/estimateRequests'
import type { OrgMember, Organisation } from '../types/organisations'

type Filter = 'all' | 'in-progress' | 'completed' | 'won' | 'lost' | 'pending'

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
      <main className="max-w-[1600px] mx-auto px-6 py-12">
        {signedIn && <LocalMigrationBanner />}
        {stillResolving ? (
          <div className="text-sm text-ink-400 py-16 text-center">Loading…</div>
        ) : currentOrg ? (
          <OrgDashboard org={currentOrg} userId={user?.id ?? null} />
        ) : isOrgInvited ? (
          <NoOrgEmptyState />
        ) : (
          <PersonalDashboard />
        )}
      </main>
    </div>
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

  // Stats: pending count, in-progress count, completed-this-week count, and
  // average turnaround in days for completed requests. Turnaround is
  // (completedAt − createdAt); we average the last 20 completions so the
  // metric responds to recent changes in pace rather than dragging on
  // historical data forever.
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
    const recentCompletions = requests
      .filter((r) => r.completedAt)
      .sort(
        (a, b) =>
          new Date(b.completedAt!).getTime() - new Date(a.completedAt!).getTime()
      )
      .slice(0, 20)
    const turnaroundDays = recentCompletions.map((r) => {
      const created = new Date(r.createdAt).getTime()
      const completed = new Date(r.completedAt!).getTime()
      return (completed - created) / (1000 * 60 * 60 * 24)
    })
    const avgTurnaround =
      turnaroundDays.length === 0
        ? null
        : turnaroundDays.reduce((a, b) => a + b, 0) / turnaroundDays.length
    return { pending, inProgress, completedThisWeek, avgTurnaround }
  }, [requests])

  // Split the active requests three ways:
  //   - myPending    → 'Needs you to pick up'   (left column of Your inbox)
  //   - myInProgress → 'Currently working on'   (right column of Your inbox)
  //   - teamActive   → 'Team inbox'             (collapsed-ish section below)
  //
  // The two 'mine' columns sort by oldest-pending-first because that's the
  // one that's been waiting longest and most likely to need attention.
  // In-progress projects on this org that aren't tied to an estimate
  // request — these are the ones created via '+ Brick / + Block estimate'
  // on the dashboard rather than picked up from a request. The inbox grid
  // above already covers request-driven work; this section surfaces the
  // free-standing projects so they have somewhere to live on the
  // dashboard. Most recent first.
  const inProgressProjects = useMemo(() => {
    const linkedProjectIds = new Set(
      requests.map((r) => r.projectId).filter((id): id is string => !!id)
    )
    return projects
      .filter((p) => p.status === 'in-progress' && !linkedProjectIds.has(p.id))
      .sort(
        (a, b) =>
          new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
      )
  }, [projects, requests])

  const { myPending, myInProgress, teamActive, recentlyCompleted } = useMemo(() => {
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
    const team = active
      .filter((r) => r.assignedToUserId !== userId)
      .sort((a, b) => {
        if (a.status !== b.status) return a.status === 'pending' ? -1 : 1
        return b.updatedAt.localeCompare(a.updatedAt)
      })
    // Recently-completed is personal: only requests the current user was
    // assigned to AND projects the current user owns. Org-wide completed
    // work lives behind a filter on the /requests page.
    //
    // Two sources merged into one list:
    //   1. Estimate requests with status === 'completed' (the workspace's
    //      status toggle propagates to the linked request now, so a project
    //      that originated from a request shows up here).
    //   2. Projects with status === 'completed' that DON'T have a linked
    //      request — direct '+ Block' / '+ Brick' creates that the user
    //      finished. Without this, those just disappear after completion.
    //
    // De-duplicates by projectId: if a completed project's id appears in
    // both lists (request flow) we keep the REQUEST entry because the
    // CompletedCard renders the customer-name header better than the
    // project's projectDetails.
    const completedRequests = requests.filter(
      (r) => r.status === 'completed' && r.assignedToUserId === userId
    )
    const requestProjectIds = new Set(
      completedRequests.map((r) => r.projectId).filter(Boolean)
    )
    const orphanCompletedProjects = projects.filter(
      (p) => p.status === 'completed' && !requestProjectIds.has(p.id)
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
      // Cap at 4 so the row fills cleanly on common viewport widths without
      // orphans. "View all →" link surfaces the rest.
      .slice(0, 4)
    return {
      myPending,
      myInProgress,
      teamActive: team,
      recentlyCompleted: completed,
    }
  }, [requests, projects, userId])

  return (
    <>
      <div className="flex items-end justify-between flex-wrap gap-4 mb-2">
        <div>
          <h2 className="text-3xl font-extrabold tracking-tight text-ink-50">
            Dashboard
          </h2>
          <p className="text-ink-300 text-sm mt-1">
            Estimate requests and recent activity for {org.name}.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Link
            to="/requests"
            className="px-3 py-1.5 rounded-lg border border-ink-600 text-ink-100 text-sm hover:bg-ink-700 transition-colors font-medium"
          >
            All requests
          </Link>
          <Link
            to="/project/brick"
            className="px-3 py-1.5 rounded-lg border border-ink-600 text-ink-100 text-sm hover:bg-ink-700 transition-colors font-medium"
          >
            + Brick
          </Link>
          <Link
            to="/project/block"
            className="px-3 py-1.5 rounded-lg border border-ink-600 text-ink-100 text-sm hover:bg-ink-700 transition-colors font-medium"
          >
            + Block
          </Link>
          <Link
            to="/requests/new"
            className="px-3 py-1.5 rounded-lg bg-beme-500 text-black text-sm hover:bg-beme-400 transition-colors font-semibold"
          >
            + New request
          </Link>
        </div>
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
        <StatTile
          label="Avg turnaround"
          value={
            stats.avgTurnaround === null
              ? '—'
              : formatTurnaround(stats.avgTurnaround)
          }
          sub={stats.avgTurnaround === null ? 'No completed requests yet' : 'Recent jobs'}
        />
      </section>

      {/* ── Your inbox ──
          Two side-by-side columns so the distinction between 'still needs
          to be picked up' (urgent / blocking) and 'I've started, finish it'
          (continue) is obvious without scanning status badges. Each column
          has its own count + empty state. Stacks to one column under md so
          the dashboard stays usable on narrower viewports. */}
      <section className="mt-8">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-xs font-semibold uppercase tracking-[0.12em] text-ink-400">
            Your inbox
          </h3>
          {(myPending.length + myInProgress.length) > 0 && (
            <span className="text-xs text-ink-400">
              {myPending.length + myInProgress.length}{' '}
              {myPending.length + myInProgress.length === 1 ? 'request' : 'requests'} assigned to you
            </span>
          )}
        </div>
        {loading ? (
          <div className="text-sm text-ink-400">Loading…</div>
        ) : myPending.length === 0 && myInProgress.length === 0 ? (
          <div className="border border-dashed border-ink-600 rounded-xl p-8 text-center bg-ink-800/40">
            <p className="text-ink-100 text-sm mb-1">Nothing waiting for you right now.</p>
            <p className="text-ink-400 text-xs">
              When sales sends you an estimate it'll show up here. You can also{' '}
              <Link to="/requests/new" className="text-beme-300 hover:text-beme-200 underline">
                send one yourself
              </Link>
              .
            </p>
          </div>
        ) : (
          // Self-balancing layout: when BOTH columns have items, split 50/50.
          // When only one side has items, that side takes the full row so we
          // never show a thin empty stripe next to a tall populated card.
          // No lopsidedness — the row width is always evenly consumed.
          (() => {
            const bothHaveItems = myPending.length > 0 && myInProgress.length > 0
            const cols = bothHaveItems ? 'md:grid-cols-2' : 'md:grid-cols-1'
            return (
              <div className={`grid grid-cols-1 ${cols} gap-4 items-stretch`}>
                {myPending.length > 0 && (
                  <InboxColumn
                    title="Needs you to pick up"
                    accent="amber"
                    count={myPending.length}
                    empty="Nothing pending in your queue."
                  >
                    {myPending.map((r) => (
                      <InboxRow
                        key={r.id}
                        request={r}
                        assignee={r.assignedToUserId ? memberById.get(r.assignedToUserId) : undefined}
                        creator={memberById.get(r.createdByUserId)}
                        onPickUp={() => handlePickUp(r)}
                        pickingUp={pickingUpId === r.id}
                        disablePickUp={!!pickingUpId && pickingUpId !== r.id}
                      />
                    ))}
                  </InboxColumn>
                )}
                {myInProgress.length > 0 && (
                  <InboxColumn
                    title="Currently working on"
                    accent="blue"
                    count={myInProgress.length}
                    empty="You haven't started any requests yet."
                  >
                    {myInProgress.map((r) => (
                      <InboxRow
                        key={r.id}
                        request={r}
                        assignee={r.assignedToUserId ? memberById.get(r.assignedToUserId) : undefined}
                        creator={memberById.get(r.createdByUserId)}
                      />
                    ))}
                  </InboxColumn>
                )}
              </div>
            )
          })()
        )}
      </section>

      {/* ── In-progress projects (not from a request) ──
          Direct '+ Brick / + Block' creates bypass the estimate-request
          inbox entirely — they need somewhere to surface on the dashboard
          so the user doesn't lose them. Show every in-progress project on
          this org that ISN'T already shown above as a request, sorted by
          most recently updated. */}
      {inProgressProjects.length > 0 && (
        <section className="mt-8">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-xs font-semibold uppercase tracking-[0.12em] text-ink-400">
              In-progress projects
            </h3>
            <span className="text-xs text-ink-400">
              {inProgressProjects.length}{' '}
              {inProgressProjects.length === 1 ? 'project' : 'projects'} on
              the go
            </span>
          </div>
          <ul className="space-y-2">
            {inProgressProjects.map((p) => (
              <ProjectInProgressRow key={p.id} project={p} />
            ))}
          </ul>
        </section>
      )}

      {/* ── Team inbox ── */}
      {teamActive.length > 0 && (
        <section className="mt-8">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-xs font-semibold uppercase tracking-[0.12em] text-ink-400">
              Team inbox
            </h3>
            <span className="text-xs text-ink-400">
              {teamActive.length} {teamActive.length === 1 ? 'request' : 'requests'} with teammates
            </span>
          </div>
          <ul className="space-y-2">
            {teamActive.map((r) => (
              <InboxRow
                key={r.id}
                request={r}
                assignee={r.assignedToUserId ? memberById.get(r.assignedToUserId) : undefined}
                creator={memberById.get(r.createdByUserId)}
                muted
              />
            ))}
          </ul>
        </section>
      )}

      {/* ── Recently completed (yours) ──
          Personal-only: shows requests YOU finished. Org-wide completed
          work lives on /requests (filter by person + date) so a teammate
          can audit anyone's recent throughput without it bloating the
          home page. */}
      {/* Always-on Recently Completed band. We show a placeholder card when
          the user hasn't finished anything yet so the dashboard layout is
          consistent for new and returning users — there's no jarring "where
          did that section go" once a project gets reopened or deleted. */}
      <section className="mt-8">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-xs font-semibold uppercase tracking-[0.12em] text-ink-400">
            Your recently completed
          </h3>
          <Link
            to="/requests?scope=all&status=completed"
            className="text-xs text-beme-300 hover:text-beme-200"
          >
            View team activity →
          </Link>
        </div>
        {recentlyCompleted.length === 0 ? (
          <div className="border border-dashed border-ink-600 rounded-xl bg-ink-800/40 p-6 text-center">
            <div className="text-sm text-ink-300">
              Nothing finished yet
            </div>
            <p className="text-xs text-ink-500 mt-1 max-w-md mx-auto">
              When you mark an estimate request as completed, it shows up here so you can find it again without digging.
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

      {/* Material library tile — full management UI lives at /library, with
          org-admin gating for edits enforced inside that page. Section
          heading matches the "Recently completed" pattern so the dashboard
          reads as a consistent stack of titled bands. */}
      <section className="mt-10">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-xs font-semibold uppercase tracking-[0.12em] text-ink-400">
            Material library
          </h3>
          <Link
            to="/library"
            className="text-xs text-beme-300 hover:text-beme-200"
          >
            Open →
          </Link>
        </div>
        <Link
          to="/library"
          className="block border border-ink-600 rounded-xl bg-ink-800 p-5 hover:border-beme-500/60 hover:bg-ink-700/40 transition-colors group mb-10"
        >
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div>
              <div className="text-base font-semibold text-ink-50 group-hover:text-beme-300 transition-colors">
                Manage blocks, bricks &amp; supply items →
              </div>
              <p className="text-sm text-ink-400 mt-2 max-w-2xl">
                Your team's catalogue: block types, brick types, and supply
                items priced per block / brick / m² / lineal m. Only an org
                admin can edit; everyone can view.
              </p>
            </div>
          </div>
        </Link>
      </section>

      {/* Beme guide tile — link to /guide for the full walkthrough. */}
      <section className="mt-10">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-xs font-semibold uppercase tracking-[0.12em] text-ink-400">
            Beme guide
          </h3>
          <Link
            to="/guide"
            className="text-xs text-beme-300 hover:text-beme-200"
          >
            Open →
          </Link>
        </div>
        <Link
          to="/guide"
          className="block border border-ink-600 rounded-xl bg-ink-800 p-5 hover:border-beme-500/60 hover:bg-ink-700/40 transition-colors group"
        >
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div>
              <div className="text-base font-semibold text-ink-50 group-hover:text-beme-300 transition-colors">
                Full walkthrough &amp; shortcuts →
              </div>
              <p className="text-sm text-ink-400 mt-2 max-w-2xl">
                Setup your library, draw walls, place openings, export an
                estimate — step-by-step with tips and shortcuts. Region-
                agnostic; works no matter where in the world you're laying.
              </p>
            </div>
          </div>
        </Link>
      </section>
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
function ProjectInProgressRow({ project }: { project: SavedProject }) {
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
              <span className="text-[10px] uppercase tracking-wider text-ink-400">
                {project.type === 'brick' ? 'Brick' : 'Block'}
              </span>
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
}: {
  request: EstimateRequest
  assignee: OrgMember | undefined
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
          <div className="font-semibold text-ink-50 truncate group-hover:text-emerald-300 transition-colors">
            {request.customerName}
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
          <div className="font-semibold text-ink-50 truncate group-hover:text-emerald-300 transition-colors">
            {title}
          </div>
          {sub && sub !== title && (
            <div className="text-xs text-ink-400 truncate">{sub}</div>
          )}
        </div>
        <span className="shrink-0 text-[10px] uppercase tracking-wider text-ink-400">
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
                    To <span className="text-ink-200">{assignee.displayName || assignee.email || 'estimator'}</span>
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
  const [projects, setProjects] = useState<SavedProject[]>([])
  const [filter, setFilter] = useState<Filter>('all')
  const [searchQuery, setSearchQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const { signedIn } = useAuth()
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
    if (!window.confirm('Delete this project? This cannot be undone.')) return
    try {
      await deleteProject(id)
      setProjects((prev) => prev.filter((p) => p.id !== id))
    } catch (err) {
      console.error('Failed to delete', err)
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

  return (
    <>
      <div className="flex items-end justify-between flex-wrap gap-4 mb-2">
        <div>
          <h2 className="text-3xl font-extrabold tracking-tight text-ink-50">Dashboard</h2>
          <p className="text-ink-300 text-sm mt-1">
            Your estimates, win rate, and current jobs at a glance.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {primaryProjectType === 'brick' ? (
            <>
              <Link
                to="/project/block"
                className="px-3 py-1.5 rounded-lg border border-ink-600 text-ink-100 text-sm hover:bg-ink-700 transition-colors font-medium"
              >
                + Block estimate
              </Link>
              <Link
                to="/project/brick"
                className="px-3 py-1.5 rounded-lg bg-beme-500 text-black text-sm hover:bg-beme-400 transition-colors font-semibold"
              >
                + Brick estimate
              </Link>
            </>
          ) : (
            <>
              <Link
                to="/project/brick"
                className="px-3 py-1.5 rounded-lg border border-ink-600 text-ink-100 text-sm hover:bg-ink-700 transition-colors font-medium"
              >
                + Brick estimate
              </Link>
              <Link
                to="/project/block"
                className="px-3 py-1.5 rounded-lg bg-beme-500 text-black text-sm hover:bg-beme-400 transition-colors font-semibold"
              >
                + Block estimate
              </Link>
            </>
          )}
        </div>
      </div>

      <section className="mt-6 grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatTile label="Total projects" value={stats.total} />
        <StatTile label="In progress" value={stats.inProgress} accent="beme" />
        <StatTile label="Won" value={stats.won} accent="emerald" />
        <StatTile
          label="Win rate"
          value={stats.winRate === null ? '—' : `${stats.winRate}%`}
          sub={
            stats.winRate === null
              ? 'No outcomes yet'
              : `${stats.won} won · ${stats.lost} lost`
          }
        />
      </section>

      <section className="mt-6 grid grid-cols-1 lg:grid-cols-3 gap-4 items-stretch">
        <div className="lg:col-span-1 border border-ink-600 rounded-xl bg-ink-800 p-5 flex flex-col items-center justify-center gap-3">
          <h3 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-400 self-start">
            Outcomes
          </h3>
          <DonutChart
            size={180}
            thickness={22}
            centreLabel={stats.winRate === null ? undefined : 'Win rate'}
            centreValue={stats.winRate === null ? undefined : `${stats.winRate}%`}
            emptyHint="Mark a project Won or Lost to see your win rate."
            slices={[
              { label: 'Won', value: stats.won, color: 'var(--color-beme-500)' },
              { label: 'Lost', value: stats.lost, color: 'var(--color-ink-500)' },
              { label: 'Pending', value: stats.pending, color: 'var(--color-ink-600)' },
            ]}
          />
        </div>

        <Link
          to="/project/brick"
          className="lg:col-span-1 border border-ink-600 rounded-xl bg-ink-800 hover:border-beme-500 hover:bg-ink-700 transition-all p-5 flex flex-col group"
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
          className="lg:col-span-1 border border-ink-600 rounded-xl bg-ink-800 hover:border-beme-500 hover:bg-ink-700 transition-all p-5 flex flex-col group"
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

        {loading && <div className="text-sm text-ink-400">Loading…</div>}

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

      {/* Material library tile — links to the dedicated /library page where
          blocks, bricks, and supply items are all managed. Heading matches
          the other dashboard bands for consistent rhythm. */}
      <section className="mt-10">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-xs font-semibold uppercase tracking-[0.12em] text-ink-400">
            Material library
          </h3>
          <Link
            to="/library"
            className="text-xs text-beme-300 hover:text-beme-200"
          >
            Open →
          </Link>
        </div>
        <Link
          to="/library"
          className="block border border-ink-600 rounded-xl bg-ink-800 p-5 hover:border-beme-500/60 hover:bg-ink-700/40 transition-colors group"
        >
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div>
              <div className="text-base font-semibold text-ink-50 group-hover:text-beme-300 transition-colors">
                Manage blocks, bricks &amp; supply items →
              </div>
              <p className="text-sm text-ink-400 mt-2 max-w-2xl">
                Your full catalogue: block types, brick types, and any custom
                supply items priced by the block / brick / m² / lineal m.
                Edits flow straight into every project.
              </p>
            </div>
          </div>
        </Link>
      </section>

      {/* Beme guide tile — link to /guide for the full walkthrough. */}
      <section className="mt-10">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-xs font-semibold uppercase tracking-[0.12em] text-ink-400">
            Beme guide
          </h3>
          <Link
            to="/guide"
            className="text-xs text-beme-300 hover:text-beme-200"
          >
            Open →
          </Link>
        </div>
        <Link
          to="/guide"
          className="block border border-ink-600 rounded-xl bg-ink-800 p-5 hover:border-beme-500/60 hover:bg-ink-700/40 transition-colors group"
        >
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div>
              <div className="text-base font-semibold text-ink-50 group-hover:text-beme-300 transition-colors">
                Full walkthrough &amp; shortcuts →
              </div>
              <p className="text-sm text-ink-400 mt-2 max-w-2xl">
                Setup your library, draw walls, place openings, export an
                estimate — step-by-step with tips and shortcuts. Region-
                agnostic; works no matter where in the world you're laying.
              </p>
            </div>
          </div>
        </Link>
      </section>
    </>
  )
}

// ---------- Shared sub-components ----------

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
