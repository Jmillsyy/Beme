import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import Header from '../components/Header'
import { useAuth } from '../lib/auth'
import { useOrganisations, listOrgMembers } from '../lib/organisations'
import {
  deleteEstimateRequest,
  getEstimateRequest,
  pickUpEstimateRequest,
  updateEstimateRequest,
} from '../lib/estimateRequests'
import type { EstimateRequest } from '../types/estimateRequests'
import { estimateRequestStatusLabel } from '../types/estimateRequests'
import type { OrgMember } from '../types/organisations'

/**
 * Detail view of a single estimate request, plus the buttons that drive its
 * lifecycle:
 *
 *   - **Pending** → "Pick up" creates a linked project and moves the request to
 *     `in_progress`; the estimator lands in the brick / block workspace.
 *   - **In progress** → "Open project" reopens the linked workspace; "Mark
 *     complete" hands it back to the sales rep.
 *   - **Completed** → read-only summary with a link back to the project so
 *     anyone in the org can pull up the takeoff.
 *
 * Cancellation is available from any non-completed state for admins / the
 * creating sales rep, to handle "customer pulled the job" cases.
 */
export default function RequestDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { user } = useAuth()
  const { currentOrg } = useOrganisations()
  const [request, setRequest] = useState<EstimateRequest | null>(null)
  const [members, setMembers] = useState<OrgMember[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!id) return
    let cancelled = false
    setLoading(true)
    getEstimateRequest(id).then(async (r) => {
      if (cancelled) return
      setRequest(r ?? null)
      if (r) {
        const ms = await listOrgMembers(r.organisationId)
        if (!cancelled) setMembers(ms)
      }
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [id])

  if (loading) {
    return (
      <div className="min-h-screen bg-ink-900 text-ink-50">
        <Header />
        <main className="max-w-[1600px] mx-auto px-6 py-10">
          <p className="text-sm text-ink-400">Loading request…</p>
        </main>
      </div>
    )
  }
  if (!request) {
    return (
      <div className="min-h-screen bg-ink-900 text-ink-50">
        <Header />
        <main className="max-w-[1600px] mx-auto px-6 py-10">
          <h2 className="text-3xl font-extrabold tracking-tight mb-2">
            Request not found
          </h2>
          <p className="text-ink-300 text-sm">
            It might have been cancelled, or you may not have permission to view
            it. Head back to the inbox and pick another.
          </p>
          <Link
            to="/requests"
            className="inline-block mt-6 text-sm text-beme-300 hover:text-beme-200"
          >
            ← Back to requests
          </Link>
        </main>
      </div>
    )
  }

  const assignee = members.find((m) => m.userId === request.assignedToUserId)
  const creator = members.find((m) => m.userId === request.createdByUserId)
  const isAssignee = user?.id === request.assignedToUserId
  const isCreator = user?.id === request.createdByUserId
  // We don't have role granularity wired into request-level permission yet;
  // for now anyone in the org can act on a request. Authorization is enforced
  // by Supabase RLS so a member of a different org can't reach this page at all.

  const projectPath =
    request.projectId &&
    (request.type === 'brick'
      ? `/project/brick?id=${request.projectId}`
      : `/project/block?id=${request.projectId}`)

  async function handlePickUp() {
    if (!request || busy) return
    setBusy(true)
    setError(null)
    try {
      const newProjectId = await pickUpEstimateRequest(request)
      navigate(
        request.type === 'brick'
          ? `/project/brick?id=${newProjectId}`
          : `/project/block?id=${newProjectId}`
      )
    } catch (e) {
      setError((e as Error).message ?? 'Pick-up failed')
      setBusy(false)
    }
  }

  async function handleComplete() {
    if (!request || busy) return
    setBusy(true)
    setError(null)
    try {
      const updated = await updateEstimateRequest(request.id, {
        status: 'completed',
      })
      setRequest(updated)
    } catch (e) {
      setError((e as Error).message ?? 'Could not mark complete')
    } finally {
      setBusy(false)
    }
  }

  async function handleCancel() {
    if (!request || busy) return
    if (!window.confirm('Cancel this estimate request? It stays in the audit log but disappears from active queues.')) return
    setBusy(true)
    setError(null)
    try {
      const updated = await updateEstimateRequest(request.id, {
        status: 'cancelled',
      })
      setRequest(updated)
    } catch (e) {
      setError((e as Error).message ?? 'Could not cancel')
    } finally {
      setBusy(false)
    }
  }

  async function handleDelete() {
    if (!request || busy) return
    // Stronger confirmation than cancel — this is destructive and includes
    // the plan PDF in storage. Highlight that any linked project stays so
    // the user understands what they're keeping.
    const hasProject = !!request.projectId
    const message = hasProject
      ? "Permanently delete this estimate request? The linked project stays — it has its own copy of the plan and will still be reachable from the dashboard. Only the request row + the customer-supplied PDF in this workflow are removed."
      : 'Permanently delete this estimate request? This removes the row + its plan PDF and can\'t be undone.'
    if (!window.confirm(message)) return
    setBusy(true)
    setError(null)
    try {
      await deleteEstimateRequest(request.id)
      // Drop the user back to the inbox once the row is gone — staying on a
      // detail page that no longer has a row would just dead-end.
      navigate('/requests')
    } catch (e) {
      setError((e as Error).message ?? 'Could not delete')
      setBusy(false)
    }
  }

  const statusBadgeClass =
    request.status === 'pending'
      ? 'bg-amber-500/15 text-amber-200 border border-amber-500/40'
      : request.status === 'in_progress'
      ? 'bg-blue-500/15 text-blue-200 border border-blue-500/40'
      : request.status === 'completed'
      ? 'bg-emerald-500/15 text-emerald-200 border border-emerald-500/40'
      : 'bg-ink-700 text-ink-300 border border-ink-600'

  return (
    <div className="min-h-screen bg-ink-900 text-ink-50">
      <Header />

      <main className="max-w-[1600px] mx-auto px-6 py-10">
        <Link
          to="/requests"
          className="text-xs text-ink-400 hover:text-ink-100 transition-colors"
        >
          ← Back to requests
        </Link>

        <div className="flex items-start justify-between gap-4 flex-wrap mt-2 mb-2">
          <div className="min-w-0">
            <h2 className="text-3xl font-extrabold tracking-tight">
              {request.customerName}
              {request.customerCompany && (
                <span className="text-ink-400 font-normal ml-2">
                  — {request.customerCompany}
                </span>
              )}
            </h2>
            <p className="text-sm text-ink-300 mt-1">
              {request.type === 'brick' ? 'Brick' : 'Block'} estimate request ·
              created {new Date(request.createdAt).toLocaleString()}
            </p>
          </div>
          <span
            className={`inline-flex items-center px-3 py-1 rounded-full text-sm font-medium shrink-0 ${statusBadgeClass}`}
          >
            {estimateRequestStatusLabel(request.status)}
          </span>
        </div>

        {currentOrg && currentOrg.id !== request.organisationId && (
          <div className="my-4 border border-amber-500/40 bg-amber-500/10 rounded-lg p-3 text-sm text-amber-200">
            You're viewing a request from a different organisation than the one
            currently selected. Switch organisation in the header to access the
            linked project.
          </div>
        )}

        {/* Actions */}
        <div className="flex flex-wrap items-center gap-2 my-6">
          {request.status === 'pending' && (
            <button
              onClick={handlePickUp}
              disabled={busy}
              className="px-4 py-2 rounded-lg bg-beme-500 text-black text-sm font-medium hover:bg-beme-400 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {busy ? 'Picking up…' : isAssignee ? 'Pick up & start' : 'Pick up this estimate'}
            </button>
          )}
          {request.status === 'in_progress' && projectPath && (
            <Link
              to={projectPath}
              className="px-4 py-2 rounded-lg bg-beme-500 text-black text-sm font-medium hover:bg-beme-400 transition-colors"
            >
              Open project →
            </Link>
          )}
          {request.status === 'in_progress' && (
            <button
              onClick={handleComplete}
              disabled={busy}
              className="px-4 py-2 rounded-lg border border-emerald-500/40 bg-emerald-500/10 text-emerald-200 text-sm hover:bg-emerald-500/20 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {busy ? 'Saving…' : 'Mark complete & return to sales'}
            </button>
          )}
          {request.status === 'completed' && projectPath && (
            <Link
              to={projectPath}
              className="px-4 py-2 rounded-lg border border-ink-600 text-ink-100 hover:bg-ink-700 text-sm"
            >
              View completed project →
            </Link>
          )}
          {(request.status === 'pending' || request.status === 'in_progress') &&
            (isCreator || isAssignee) && (
              <button
                onClick={handleCancel}
                disabled={busy}
                className="px-4 py-2 rounded-lg border border-rose-500/40 bg-rose-500/10 text-rose-200 text-sm hover:bg-rose-500/20 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                Cancel request
              </button>
            )}
          {/* Terminal-state delete: only on cancelled / completed rows so the
              user can clean their workflow without touching active jobs.
              Pending / in-progress should be cancelled first (the row stays in
              the audit log) — that two-step keeps an accidental delete from
              tearing through a live job. */}
          {(request.status === 'cancelled' || request.status === 'completed') && (
            <button
              onClick={handleDelete}
              disabled={busy}
              className="px-4 py-2 rounded-lg border border-rose-500/40 bg-rose-500/10 text-rose-200 text-sm hover:bg-rose-500/20 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {busy ? 'Deleting…' : 'Delete request'}
            </button>
          )}
        </div>

        {error && (
          <div className="border border-rose-500/40 bg-rose-500/10 rounded-lg p-3 text-sm text-rose-200 mb-4">
            {error}
          </div>
        )}

        {/* Detail cards */}
        <div className="grid grid-cols-1 gap-4">
          <Card title="Customer">
            <Row label="Name" value={request.customerName} />
            {request.customerCompany && (
              <Row label="Company" value={request.customerCompany} />
            )}
            {request.customerEmail && (
              <Row label="Email" value={request.customerEmail} />
            )}
            {request.customerPhone && (
              <Row label="Phone" value={request.customerPhone} />
            )}
          </Card>

          <Card title="Spec from sales">
            {request.inclusionNotes ? (
              <p className="text-sm text-ink-100 whitespace-pre-wrap">
                {request.inclusionNotes}
              </p>
            ) : (
              <p className="text-sm text-ink-400 italic">
                No notes — ask sales for clarification before starting.
              </p>
            )}
          </Card>

          <Card title="Plans">
            {request.planPdfFileName || (request.additionalPdfs?.length ?? 0) > 0 ? (
              <ul className="space-y-2">
                {/* Primary first — the file walls actually get drawn on after
                    pickup. Reference PDFs follow underneath in attach order. */}
                {request.planPdfFileName && (
                  <li className="flex items-center gap-3">
                    <span className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full bg-beme-500/15 text-beme-300 border border-beme-500/40 shrink-0">
                      Primary
                    </span>
                    <span className="text-sm text-ink-100 truncate" title={request.planPdfFileName}>
                      📎 {request.planPdfFileName}
                    </span>
                  </li>
                )}
                {request.additionalPdfs?.map((p, i) => (
                  <li key={i} className="flex items-center gap-3">
                    <span className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full bg-ink-700 text-ink-300 border border-ink-600 shrink-0">
                      Reference
                    </span>
                    <span className="text-sm text-ink-100 truncate" title={p.fileName}>
                      📎 {p.fileName}
                    </span>
                  </li>
                ))}
                <li className="text-xs text-ink-400 pt-1">
                  All files load automatically when the estimator picks up the
                  request.
                </li>
              </ul>
            ) : (
              <p className="text-sm text-ink-400 italic">
                No plans attached. You'll need to upload one inside the project
                once you've picked it up.
              </p>
            )}
          </Card>

          <Card title="Team">
            <Row
              label="Created by"
              value={creator?.displayName || creator?.email || 'Team member'}
            />
            <Row
              label="Assigned to"
              value={
                assignee?.displayName ||
                assignee?.email ||
                (request.assignedToUserId ? 'Estimator' : 'Unassigned')
              }
            />
            <Row
              label="Last update"
              value={new Date(request.updatedAt).toLocaleString()}
            />
            {request.completedAt && (
              <Row
                label="Completed"
                value={new Date(request.completedAt).toLocaleString()}
              />
            )}
          </Card>
        </div>
      </main>
    </div>
  )
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border border-ink-600 rounded-xl bg-ink-800 p-5">
      <h3 className="text-xs uppercase tracking-wider text-ink-400 mb-3">{title}</h3>
      <div className="space-y-2">{children}</div>
    </section>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-3 text-sm">
      <span className="text-ink-400 w-28 shrink-0">{label}</span>
      <span className="text-ink-100">{value}</span>
    </div>
  )
}
