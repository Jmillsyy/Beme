import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import Header from '../components/Header'
import DonutChart from '../components/DonutChart'
import LocalMigrationBanner from '../components/LocalMigrationBanner'
import {
  type ProjectOutcome,
  type ProjectStatus,
  type SavedProject,
  deleteProject,
  listProjects,
  saveProject,
} from '../lib/projectStorage'
import { useAuth } from '../lib/auth'
import { useUserSettings } from '../lib/userSettings'
import { listOrgMembers, useOrganisations } from '../lib/organisations'
import { listEstimateRequests } from '../lib/estimateRequests'
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
  const { signedIn, user } = useAuth()
  const { currentOrg } = useOrganisations()

  return (
    <div className="min-h-screen bg-ink-900 text-ink-50">
      <Header />
      <main className="max-w-[1600px] mx-auto px-6 py-12">
        {signedIn && <LocalMigrationBanner />}
        {currentOrg ? (
          <OrgDashboard org={currentOrg} userId={user?.id ?? null} />
        ) : (
          <PersonalDashboard />
        )}
      </main>
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
  const [requests, setRequests] = useState<EstimateRequest[]>([])
  const [members, setMembers] = useState<OrgMember[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    Promise.all([listEstimateRequests(org.id), listOrgMembers(org.id)])
      .then(([reqs, mems]) => {
        if (cancelled) return
        setRequests(reqs)
        setMembers(mems)
        setLoading(false)
      })
      .catch(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [org.id])

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

  // Split active (pending + in_progress) requests by mine / theirs so each
  // can render in its own clearly labelled section.
  const { myActive, teamActive, recentlyCompleted } = useMemo(() => {
    const active = requests.filter(
      (r) => r.status === 'pending' || r.status === 'in_progress'
    )
    const sortActive = (a: EstimateRequest, b: EstimateRequest) => {
      // Pending before in-progress (pending = needs attention sooner).
      if (a.status !== b.status) return a.status === 'pending' ? -1 : 1
      // Then most recently updated first.
      return b.updatedAt.localeCompare(a.updatedAt)
    }
    const mine = active
      .filter((r) => r.assignedToUserId === userId)
      .sort(sortActive)
    const team = active
      .filter((r) => r.assignedToUserId !== userId)
      .sort(sortActive)
    const completed = requests
      .filter((r) => r.status === 'completed')
      .sort(
        (a, b) =>
          new Date(b.completedAt ?? b.updatedAt).getTime() -
          new Date(a.completedAt ?? a.updatedAt).getTime()
      )
      .slice(0, 5)
    return { myActive: mine, teamActive: team, recentlyCompleted: completed }
  }, [requests, userId])

  return (
    <>
      <div className="flex items-end justify-between flex-wrap gap-4 mb-2">
        <div>
          <h2 className="text-4xl font-extrabold tracking-tight text-ink-50">
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

      {/* ── Your inbox ── */}
      <section className="mt-8">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-xs font-semibold uppercase tracking-[0.12em] text-ink-400">
            Your inbox
          </h3>
          {myActive.length > 0 && (
            <span className="text-xs text-ink-400">
              {myActive.length} {myActive.length === 1 ? 'request' : 'requests'} assigned to you
            </span>
          )}
        </div>
        {loading ? (
          <div className="text-sm text-ink-400">Loading…</div>
        ) : myActive.length === 0 ? (
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
          <ul className="space-y-2">
            {myActive.map((r) => (
              <InboxRow
                key={r.id}
                request={r}
                assignee={r.assignedToUserId ? memberById.get(r.assignedToUserId) : undefined}
                creator={memberById.get(r.createdByUserId)}
              />
            ))}
          </ul>
        )}
      </section>

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

      {/* ── Recently completed ── */}
      {recentlyCompleted.length > 0 && (
        <section className="mt-8">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-xs font-semibold uppercase tracking-[0.12em] text-ink-400">
              Recently completed
            </h3>
            <Link
              to="/requests"
              className="text-xs text-beme-300 hover:text-beme-200"
            >
              View all →
            </Link>
          </div>
          <ul className="space-y-2">
            {recentlyCompleted.map((r) => (
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
    </>
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
 */
function InboxRow({
  request,
  assignee,
  creator,
  muted,
}: {
  request: EstimateRequest
  assignee: OrgMember | undefined
  creator: OrgMember | undefined
  muted?: boolean
}) {
  const statusBadgeClass =
    request.status === 'pending'
      ? 'bg-amber-500/15 text-amber-200 border border-amber-500/40'
      : request.status === 'in_progress'
        ? 'bg-blue-500/15 text-blue-200 border border-blue-500/40'
        : request.status === 'completed'
          ? 'bg-emerald-500/15 text-emerald-200 border border-emerald-500/40'
          : 'bg-ink-700 text-ink-300 border border-ink-600'

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
    if (filter === 'all') return projects
    if (filter === 'in-progress' || filter === 'completed')
      return projects.filter((p) => p.status === filter)
    if (filter === 'won') return projects.filter((p) => p.outcome === 'won')
    if (filter === 'lost') return projects.filter((p) => p.outcome === 'lost')
    return projects.filter((p) => !p.outcome)
  }, [projects, filter])

  async function handleDelete(id: string) {
    if (!window.confirm('Delete this project? This cannot be undone.')) return
    try {
      await deleteProject(id)
      setProjects((prev) => prev.filter((p) => p.id !== id))
    } catch (err) {
      console.error('Failed to delete', err)
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
          <h2 className="text-4xl font-extrabold tracking-tight text-ink-50">Dashboard</h2>
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
          <div className="flex items-center gap-1 border border-ink-600 rounded-lg p-1 bg-ink-800 flex-wrap">
            <FilterTab label="All" count={stats.total} active={filter === 'all'} onClick={() => setFilter('all')} />
            <FilterTab label="In progress" count={stats.inProgress} active={filter === 'in-progress'} onClick={() => setFilter('in-progress')} />
            <FilterTab label="Completed" count={stats.completed} active={filter === 'completed'} onClick={() => setFilter('completed')} />
            <FilterTab label="Won" count={stats.won} active={filter === 'won'} onClick={() => setFilter('won')} />
            <FilterTab label="Lost" count={stats.lost} active={filter === 'lost'} onClick={() => setFilter('lost')} />
            <FilterTab label="Pending" count={stats.pending} active={filter === 'pending'} onClick={() => setFilter('pending')} />
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
                onCycleOutcome={() => handleCycleOutcome(p)}
              />
            ))}
          </ul>
        )}
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
      <div className={`text-3xl font-extrabold tracking-tight tabular-nums mt-1 ${accentClass}`}>
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
  onCycleOutcome,
}: {
  project: SavedProject
  onDelete: () => void
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
