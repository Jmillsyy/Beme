import { useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import Header from '../components/Header'
import { useAuth } from '../lib/auth'
import { useOrganisations, listOrgMembers } from '../lib/organisations'
import { deleteEstimateRequest, listEstimateRequests } from '../lib/estimateRequests'
import type {
  EstimateRequest,
  EstimateRequestStatus,
} from '../types/estimateRequests'
import { estimateRequestStatusLabel } from '../types/estimateRequests'
import type { OrgMember } from '../types/organisations'

/** Date-range filter — keep it discrete + short so the dropdown stays simple. */
type PeriodFilter = 'all' | 'today' | 'week' | 'month'

/** Lower-bound timestamp for the given period, or null when no lower bound. */
function periodStart(period: PeriodFilter): number | null {
  const now = Date.now()
  if (period === 'today') return now - 24 * 60 * 60 * 1000
  if (period === 'week') return now - 7 * 24 * 60 * 60 * 1000
  if (period === 'month') return now - 30 * 24 * 60 * 60 * 1000
  return null
}

function periodLabel(period: PeriodFilter): string {
  switch (period) {
    case 'today': return 'Today'
    case 'week': return 'This week'
    case 'month': return 'This month'
    case 'all': return 'All time'
  }
}

/**
 * Estimate requests list — the inbox surface.
 *
 * One page, two views toggled by the "Scope" pill at the top:
 *
 *   - "Assigned to me" (default for estimators) — what's in MY queue.
 *   - "All requests" — everyone's queue across the org (sales sees status of
 *     work they've sent; admin can see the team's load).
 *
 * Each request shows the customer, the type, the assignee, the status, and a
 * short snippet of the inclusion notes so estimators can triage without
 * opening every card.
 */
export default function RequestsPage() {
  const { currentOrg, loading: orgLoading } = useOrganisations()
  const { user } = useAuth()
  // URL is the source of truth for filters so the page is shareable +
  // bookmarkable + linkable from the dashboard. The dashboard's 'View team
  // activity' link points at /requests?scope=all&status=completed and we
  // want those filters live on first render.
  const [searchParams, setSearchParams] = useSearchParams()

  const [requests, setRequests] = useState<EstimateRequest[]>([])
  const [loading, setLoading] = useState(true)
  const [members, setMembers] = useState<OrgMember[]>([])

  // Filters — initialised from the URL, written back to the URL on change.
  const scope: 'mine' | 'all' =
    searchParams.get('scope') === 'mine' ? 'mine' : 'all'
  const statusFilter: EstimateRequestStatus | 'all' = (() => {
    const s = searchParams.get('status')
    if (s === 'pending' || s === 'in_progress' || s === 'completed' || s === 'cancelled') return s
    return 'all'
  })()
  const personFilter: string =
    searchParams.get('person') ?? 'any'
  const period: PeriodFilter = (() => {
    const p = searchParams.get('period')
    if (p === 'today' || p === 'week' || p === 'month') return p
    return 'all'
  })()

  /** Update one filter without losing the others — small wrapper round
   *  setSearchParams so each onChange handler stays a one-liner. */
  function updateParam(key: string, value: string | null) {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      if (value === null || value === '' || value === 'all' || value === 'any') {
        next.delete(key)
      } else {
        next.set(key, value)
      }
      return next
    }, { replace: true })
  }

  // Load members alongside requests so we can show names instead of UUIDs on
  // the assigned-to badge. Members list is small (tens at most) so it's cheap.
  useEffect(() => {
    if (!currentOrg) return
    let cancelled = false
    setLoading(true)
    Promise.all([
      listEstimateRequests(currentOrg.id),
      listOrgMembers(currentOrg.id),
    ])
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
  }, [currentOrg])

  const memberById = useMemo(() => {
    const m = new Map<string, OrgMember>()
    for (const x of members) m.set(x.userId, x)
    return m
  }, [members])

  /** Date-range predicate for a request based on the current period filter.
   *  Uses completedAt for completed/cancelled rows (when it happened),
   *  otherwise updatedAt (when sales last touched it). Keeps the filter
   *  intuitive: "completed this week" means closed in the last 7 days. */
  function matchesPeriod(r: EstimateRequest): boolean {
    const start = periodStart(period)
    if (start === null) return true
    const ts =
      r.completedAt
        ? new Date(r.completedAt).getTime()
        : new Date(r.updatedAt).getTime()
    return ts >= start
  }

  // Apply scope + status + person + period filtering client-side. Per-org
  // request volume is small so a round-trip per filter change isn't worth
  // the network cost; just filter the in-memory list.
  const filteredRequests = useMemo(() => {
    return requests.filter((r) => {
      if (scope === 'mine' && r.assignedToUserId !== user?.id) return false
      if (statusFilter !== 'all' && r.status !== statusFilter) return false
      if (personFilter !== 'any' && r.assignedToUserId !== personFilter) return false
      if (!matchesPeriod(r)) return false
      return true
    })
    // matchesPeriod closes over `period`; spelling it out keeps the dep
    // explicit for the linter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requests, scope, statusFilter, personFilter, period, user?.id])

  // Counts shown next to each status pill. Match the OTHER filters (scope,
  // person, period) but NOT the status itself — pills should still show
  // 'Pending 5 / Completed 12' even when you're on 'Pending', otherwise
  // the user can't see how many of each there are.
  const counts = useMemo(() => {
    const base = requests.filter((r) => {
      if (scope === 'mine' && r.assignedToUserId !== user?.id) return false
      if (personFilter !== 'any' && r.assignedToUserId !== personFilter) return false
      if (!matchesPeriod(r)) return false
      return true
    })
    const acc: Record<EstimateRequestStatus | 'all', number> = {
      all: base.length,
      pending: 0,
      in_progress: 0,
      completed: 0,
      cancelled: 0,
    }
    for (const r of base) acc[r.status]++
    return acc
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requests, scope, personFilter, period, user?.id])

  if (!orgLoading && !currentOrg) {
    return (
      <div className="min-h-screen bg-ink-900 text-ink-50">
        <Header />
        <main className="max-w-[1600px] mx-auto px-6 py-10">
          <h2 className="text-3xl font-extrabold tracking-tight mb-2">
            Estimate requests
          </h2>
          <p className="text-ink-300 text-sm">
            Estimate requests live inside organisations — sales reps send them
            to estimators on the team. You'll need to be added to an org to see
            this surface; ask an admin to invite you, then come back.
          </p>
          <Link
            to="/"
            className="inline-block mt-6 text-sm text-beme-300 hover:text-beme-200"
          >
            ← Back to dashboard
          </Link>
        </main>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-ink-900 text-ink-50">
      <Header />

      <main className="max-w-[1600px] mx-auto px-6 py-10">
        <div className="flex items-end justify-between flex-wrap gap-4 mb-6">
          <div>
            <Link
              to="/"
              className="text-xs text-ink-400 hover:text-ink-100 transition-colors"
            >
              ← Back to dashboard
            </Link>
            <h2 className="text-4xl font-extrabold tracking-tight mt-2">
              Estimate requests
            </h2>
            <p className="text-ink-300 text-sm mt-1">
              {currentOrg
                ? `Incoming work for ${currentOrg.name}. Each request becomes a Project once an estimator picks it up.`
                : ''}
            </p>
          </div>
          <Link
            to="/requests/new"
            className="px-4 py-2 rounded-lg bg-beme-500 text-black text-sm font-medium hover:bg-beme-400 transition-colors"
          >
            + New request
          </Link>
        </div>

        {/* Scope toggle — "Mine" for estimators, "All" for sales / oversight */}
        <div className="flex items-center gap-2 mb-4 text-sm">
          <span className="text-xs uppercase tracking-wider text-ink-400 mr-1">
            Scope
          </span>
          <ScopePill
            active={scope === 'all'}
            label="All requests"
            onClick={() => updateParam('scope', 'all')}
          />
          <ScopePill
            active={scope === 'mine'}
            label="Assigned to me"
            onClick={() => updateParam('scope', 'mine')}
          />
        </div>

        {/* Status filter pills with counts */}
        <div className="flex flex-wrap items-center gap-2 mb-4 text-sm">
          <span className="text-xs uppercase tracking-wider text-ink-400 mr-1">
            Status
          </span>
          <StatusPill
            active={statusFilter === 'all'}
            label="All"
            count={counts.all}
            onClick={() => updateParam('status', 'all')}
          />
          <StatusPill
            active={statusFilter === 'pending'}
            label="Pending"
            count={counts.pending}
            onClick={() => updateParam('status', 'pending')}
          />
          <StatusPill
            active={statusFilter === 'in_progress'}
            label="In progress"
            count={counts.in_progress}
            onClick={() => updateParam('status', 'in_progress')}
          />
          <StatusPill
            active={statusFilter === 'completed'}
            label="Completed"
            count={counts.completed}
            onClick={() => updateParam('status', 'completed')}
          />
          <StatusPill
            active={statusFilter === 'cancelled'}
            label="Cancelled"
            count={counts.cancelled}
            onClick={() => updateParam('status', 'cancelled')}
          />
        </div>

        {/* By-person + period filters. Two dropdowns sit side-by-side. The
            person dropdown lets sales / admins audit one teammate's work
            ("show me everything Sarah finished this month"); period scopes
            the result by completion / update date.

            Both default to wide ("Anyone" / "All time"), so opening
            /requests without query params shows everything — the existing
            behaviour. Adding either filter narrows the list. */}
        <div className="flex items-end gap-4 mb-6 flex-wrap text-sm">
          <label className="block">
            <span className="text-xs uppercase tracking-wider text-ink-400 mb-1.5 inline-block">
              By person
            </span>
            <select
              value={personFilter}
              onChange={(e) => updateParam('person', e.target.value)}
              className="block min-w-[180px] px-3 py-1.5 rounded-lg border border-ink-600 bg-ink-800 text-ink-100 focus:outline-none focus:border-beme-400"
            >
              <option value="any">Anyone</option>
              {/* Sort by name so the dropdown reads consistently — the
                  /list_org_members RPC returns by joined date which isn't
                  useful here. */}
              {[...members]
                .sort((a, b) =>
                  (a.displayName || a.email || '').localeCompare(b.displayName || b.email || '')
                )
                .map((m) => (
                  <option key={m.userId} value={m.userId}>
                    {m.displayName || m.email || `Member ${m.userId.slice(0, 4)}`}
                  </option>
                ))}
            </select>
          </label>
          <label className="block">
            <span className="text-xs uppercase tracking-wider text-ink-400 mb-1.5 inline-block">
              Period
            </span>
            <select
              value={period}
              onChange={(e) => updateParam('period', e.target.value)}
              className="block min-w-[160px] px-3 py-1.5 rounded-lg border border-ink-600 bg-ink-800 text-ink-100 focus:outline-none focus:border-beme-400"
            >
              <option value="all">{periodLabel('all')}</option>
              <option value="today">{periodLabel('today')}</option>
              <option value="week">{periodLabel('week')}</option>
              <option value="month">{periodLabel('month')}</option>
            </select>
          </label>
          {/* Reset button only appears when any non-default filter is set,
              so it doesn't add noise when the page first loads. */}
          {(scope !== 'all' || statusFilter !== 'all' || personFilter !== 'any' || period !== 'all') && (
            <button
              type="button"
              onClick={() => setSearchParams(new URLSearchParams(), { replace: true })}
              className="px-3 py-1.5 rounded-lg border border-ink-600 text-ink-300 hover:bg-ink-700 text-xs"
            >
              Reset filters
            </button>
          )}
        </div>

        {/* Results */}
        {loading ? (
          <p className="text-sm text-ink-400">Loading requests…</p>
        ) : filteredRequests.length === 0 ? (
          <div className="border border-ink-600 rounded-xl bg-ink-800 p-10 text-center">
            <p className="text-ink-100 mb-1">
              {scope === 'mine'
                ? "Nothing in your inbox right now."
                : 'No requests match this filter.'}
            </p>
            <p className="text-sm text-ink-400">
              {scope === 'mine'
                ? "When sales sends you an estimate it'll show up here."
                : 'Hit "+ New request" above to send the first one.'}
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3">
            {filteredRequests.map((r) => (
              <RequestRow
                key={r.id}
                request={r}
                assignee={r.assignedToUserId ? memberById.get(r.assignedToUserId) : undefined}
                creator={memberById.get(r.createdByUserId)}
                onDelete={async () => {
                  // Optimistic remove from the list — re-fetching would
                  // also work, but a single row removal feels immediate
                  // and matches what the user just confirmed. If the
                  // server delete fails the catch below puts the row
                  // back.
                  const snapshot = requests
                  setRequests((prev) => prev.filter((x) => x.id !== r.id))
                  try {
                    await deleteEstimateRequest(r.id)
                  } catch (err) {
                    setRequests(snapshot)
                    window.alert(
                      `Couldn't delete request: ${(err as Error).message ?? 'unknown error'}`
                    )
                  }
                }}
              />
            ))}
          </div>
        )}
      </main>
    </div>
  )
}

function ScopePill({
  active,
  label,
  onClick,
}: {
  active: boolean
  label: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-3 py-1.5 rounded-full text-sm transition-colors ${
        active
          ? 'bg-beme-500/15 border border-beme-500/40 text-beme-300'
          : 'border border-ink-600 text-ink-200 hover:bg-ink-700'
      }`}
    >
      {label}
    </button>
  )
}

function StatusPill({
  active,
  label,
  count,
  onClick,
}: {
  active: boolean
  label: string
  count: number
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-3 py-1 rounded-full text-xs transition-colors flex items-center gap-1.5 ${
        active
          ? 'bg-beme-500/15 border border-beme-500/40 text-beme-300'
          : 'border border-ink-600 text-ink-300 hover:bg-ink-700'
      }`}
    >
      <span>{label}</span>
      <span className="text-ink-400 font-mono tabular-nums">{count}</span>
    </button>
  )
}

function RequestRow({
  request,
  assignee,
  creator,
  onDelete,
}: {
  request: EstimateRequest
  assignee: OrgMember | undefined
  creator: OrgMember | undefined
  onDelete: () => void
}) {
  const statusBadgeClass =
    request.status === 'pending'
      ? 'bg-amber-500/15 text-amber-200 border border-amber-500/40'
      : request.status === 'in_progress'
      ? 'bg-blue-500/15 text-blue-200 border border-blue-500/40'
      : request.status === 'completed'
      ? 'bg-emerald-500/15 text-emerald-200 border border-emerald-500/40'
      : 'bg-ink-700 text-ink-300 border border-ink-600'

  // Inline delete is offered for terminal-state rows so the user can clear
  // out their workflow without opening every card. Active rows (pending /
  // in_progress) need to go through the Cancel button on the detail page
  // first — that two-step keeps an accidental delete from tearing through
  // a live job.
  const canQuickDelete = request.status === 'cancelled' || request.status === 'completed'

  // Wrap the click handler in a custom confirm so the row's Link doesn't
  // navigate when the user clicks the trash button.
  function handleDeleteClick(e: React.MouseEvent) {
    e.preventDefault()
    e.stopPropagation()
    const hasProject = !!request.projectId
    const msg = hasProject
      ? `Permanently delete the request for "${request.customerName}"? The linked project stays — only the request row + customer PDF are removed.`
      : `Permanently delete the request for "${request.customerName}"? This can't be undone.`
    if (window.confirm(msg)) onDelete()
  }

  return (
    <div className="relative">
      <Link
        to={`/requests/${request.id}`}
        className="block border border-ink-600 rounded-xl bg-ink-800 p-4 hover:border-beme-500/40 hover:bg-ink-700/40 transition-colors"
      >
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap mb-1">
              <h3 className="text-base font-semibold text-ink-50 truncate">
                {request.customerName}
                {request.customerCompany && (
                  <span className="text-ink-400 font-normal ml-2">
                    — {request.customerCompany}
                  </span>
                )}
              </h3>
              <span
                className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${statusBadgeClass}`}
              >
                {estimateRequestStatusLabel(request.status)}
              </span>
              <span className="text-xs uppercase tracking-wider text-ink-400">
                {request.type === 'brick' ? 'Brick' : 'Block'}
              </span>
            </div>
            {request.inclusionNotes && (
              <p className="text-sm text-ink-300 line-clamp-2 mb-2">
                {request.inclusionNotes}
              </p>
            )}
            <div className="flex items-center gap-3 text-xs text-ink-400 flex-wrap">
              <span>
                From{' '}
                <span className="text-ink-200">
                  {creator?.displayName || creator?.email || 'team'}
                </span>
              </span>
              <span>·</span>
              <span>
                To{' '}
                <span className="text-ink-200">
                  {assignee?.displayName ||
                    assignee?.email ||
                    (request.assignedToUserId ? 'a teammate' : 'Unassigned')}
                </span>
              </span>
              <span>·</span>
              <span>{new Date(request.updatedAt).toLocaleDateString()}</span>
              {request.planPdfFileName && (
                <>
                  <span>·</span>
                  <span className="text-ink-300">📎 {request.planPdfFileName}</span>
                </>
              )}
            </div>
          </div>
          {canQuickDelete && (
            // Absolutely-positioned so it doesn't reflow the row content; sits
            // top-right of the card. Stops the Link click so it doesn't open
            // the detail page on the way to the confirm dialog.
            <button
              type="button"
              onClick={handleDeleteClick}
              title={`Delete this ${request.status} request`}
              aria-label="Delete request"
              className="shrink-0 px-2 py-1 rounded text-xs text-rose-300 hover:text-rose-100 hover:bg-rose-500/10 transition-colors"
            >
              Delete
            </button>
          )}
        </div>
      </Link>
    </div>
  )
}
