import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import Header from '../components/Header'
import { useAuth } from '../lib/auth'
import { useOrganisations, listOrgMembers } from '../lib/organisations'
import { listEstimateRequests } from '../lib/estimateRequests'
import type {
  EstimateRequest,
  EstimateRequestStatus,
} from '../types/estimateRequests'
import { estimateRequestStatusLabel } from '../types/estimateRequests'
import type { OrgMember } from '../types/organisations'

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
  const [requests, setRequests] = useState<EstimateRequest[]>([])
  const [loading, setLoading] = useState(true)
  const [statusFilter, setStatusFilter] = useState<EstimateRequestStatus | 'all'>(
    'all'
  )
  const [scope, setScope] = useState<'mine' | 'all'>('all')
  const [members, setMembers] = useState<OrgMember[]>([])

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

  // Apply scope + status filtering client-side. The data set per org is small
  // enough that a round-trip per filter change isn't worth the network cost.
  const filteredRequests = useMemo(() => {
    return requests.filter((r) => {
      if (scope === 'mine' && r.assignedToUserId !== user?.id) return false
      if (statusFilter !== 'all' && r.status !== statusFilter) return false
      return true
    })
  }, [requests, scope, statusFilter, user?.id])

  // Counts shown next to each filter pill — match the filtering above so they
  // stay in sync with what the user is actually about to see.
  const counts = useMemo(() => {
    const base = requests.filter((r) => {
      if (scope === 'mine' && r.assignedToUserId !== user?.id) return false
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
  }, [requests, scope, user?.id])

  if (!orgLoading && !currentOrg) {
    return (
      <div className="min-h-screen bg-ink-900 text-ink-50">
        <Header />
        <main className="max-w-[1000px] mx-auto px-6 py-10">
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

      <main className="max-w-[1200px] mx-auto px-6 py-10">
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
            onClick={() => setScope('all')}
          />
          <ScopePill
            active={scope === 'mine'}
            label="Assigned to me"
            onClick={() => setScope('mine')}
          />
        </div>

        {/* Status filter pills with counts */}
        <div className="flex flex-wrap items-center gap-2 mb-6 text-sm">
          <span className="text-xs uppercase tracking-wider text-ink-400 mr-1">
            Status
          </span>
          <StatusPill
            active={statusFilter === 'all'}
            label="All"
            count={counts.all}
            onClick={() => setStatusFilter('all')}
          />
          <StatusPill
            active={statusFilter === 'pending'}
            label="Pending"
            count={counts.pending}
            onClick={() => setStatusFilter('pending')}
          />
          <StatusPill
            active={statusFilter === 'in_progress'}
            label="In progress"
            count={counts.in_progress}
            onClick={() => setStatusFilter('in_progress')}
          />
          <StatusPill
            active={statusFilter === 'completed'}
            label="Completed"
            count={counts.completed}
            onClick={() => setStatusFilter('completed')}
          />
          <StatusPill
            active={statusFilter === 'cancelled'}
            label="Cancelled"
            count={counts.cancelled}
            onClick={() => setStatusFilter('cancelled')}
          />
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
}: {
  request: EstimateRequest
  assignee: OrgMember | undefined
  creator: OrgMember | undefined
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
                  (request.assignedToUserId ? 'estimator' : 'Unassigned')}
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
      </div>
    </Link>
  )
}
