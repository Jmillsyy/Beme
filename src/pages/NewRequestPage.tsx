import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import Header from '../components/Header'
import { useOrganisations, listOrgMembers } from '../lib/organisations'
import type { OrgMember } from '../types/organisations'
import { createEstimateRequest } from '../lib/estimateRequests'
import type { EstimateRequestDraft } from '../types/estimateRequests'
import type { ProjectType } from '../lib/projectStorage'

/**
 * Create-Estimate-Request page. Sales rep fills in the customer info + what
 * the customer wants estimated + uploads the plan PDF + picks an estimator,
 * and submits. The request lands in the chosen estimator's inbox (`/requests`
 * filtered to their assigned list).
 *
 * Personal / single-user accounts don't have this surface — they create
 * projects directly from the dashboard. This page redirects out if the user
 * isn't currently in an org context.
 */
export default function NewRequestPage() {
  const { currentOrg, loading: orgLoading } = useOrganisations()
  const navigate = useNavigate()
  const [members, setMembers] = useState<OrgMember[]>([])
  const [membersLoading, setMembersLoading] = useState(true)

  // Form state — kept granular so we can validate per-field and offer per-field hints.
  const [type, setType] = useState<ProjectType>('brick')
  const [customerName, setCustomerName] = useState('')
  const [customerCompany, setCustomerCompany] = useState('')
  const [customerEmail, setCustomerEmail] = useState('')
  const [customerPhone, setCustomerPhone] = useState('')
  const [inclusionNotes, setInclusionNotes] = useState('')
  const [planFile, setPlanFile] = useState<File | null>(null)
  const [assignedToUserId, setAssignedToUserId] = useState<string>('')

  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!currentOrg) return
    let cancelled = false
    listOrgMembers(currentOrg.id).then((list) => {
      if (cancelled) return
      setMembers(list)
      setMembersLoading(false)
      // Default the assignee to the first estimator in the org if any exists.
      // Saves a click on the most common case ("send to our estimator team").
      const firstEstimator = list.find((m) => m.role === 'estimator')
      if (firstEstimator) setAssignedToUserId(firstEstimator.userId)
    })
    return () => {
      cancelled = true
    }
  }, [currentOrg])

  // Surface a friendly empty state for users not inside an org, rather than
  // letting them fill in a form they can't submit.
  if (!orgLoading && !currentOrg) {
    return (
      <div className="min-h-screen bg-ink-900 text-ink-50">
        <Header />
        <main className="max-w-[1600px] mx-auto px-6 py-10">
          <h2 className="text-3xl font-extrabold tracking-tight mb-2">
            New estimate request
          </h2>
          <p className="text-ink-300 text-sm">
            Estimate requests are an organisation feature — you'll need to be in
            an org to send one. Personal projects don't use requests; just open
            the brick or block workspace directly from the dashboard.
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

  // Only org members with 'estimator' or 'admin' role are valid assignees.
  // Sales reps don't receive their own work; admins might pinch-hit on
  // takeoffs in smaller orgs.
  const assignableMembers = members.filter(
    (m) => m.role === 'estimator' || m.role === 'admin'
  )

  const canSubmit =
    customerName.trim().length > 0 &&
    !submitting &&
    !!currentOrg

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!canSubmit || !currentOrg) return
    setSubmitting(true)
    setError(null)
    try {
      const draft: EstimateRequestDraft = {
        type,
        assignedToUserId: assignedToUserId || null,
        customerName: customerName.trim(),
        customerCompany: customerCompany.trim() || undefined,
        customerEmail: customerEmail.trim() || undefined,
        customerPhone: customerPhone.trim() || undefined,
        inclusionNotes: inclusionNotes.trim() || undefined,
        planFile: planFile ?? undefined,
      }
      const created = await createEstimateRequest(currentOrg.id, draft)
      navigate(`/requests/${created.id}`)
    } catch (err) {
      setError((err as Error).message ?? 'Submission failed')
      setSubmitting(false)
    }
  }

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
        <h2 className="text-4xl font-extrabold tracking-tight mt-2">
          New estimate request
        </h2>
        <p className="text-ink-300 text-sm mt-2 mb-8">
          Record what the customer is asking for, attach the plan, and pick an
          estimator. They'll see it in their inbox immediately.
        </p>

        <form onSubmit={handleSubmit} className="space-y-6">
          {/* ── Type ── */}
          <section className="border border-ink-600 rounded-xl bg-ink-800 p-5">
            <h3 className="text-sm font-semibold text-ink-50 mb-3">Estimate type</h3>
            <div className="flex gap-2">
              {(['brick', 'block'] as ProjectType[]).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setType(t)}
                  className={`flex-1 px-4 py-2.5 rounded-lg border transition-colors text-sm font-medium ${
                    type === t
                      ? 'bg-beme-500/15 border-beme-500/40 text-beme-300'
                      : 'border-ink-600 text-ink-200 hover:bg-ink-700'
                  }`}
                >
                  {t === 'brick' ? 'Brick takeoff' : 'Block takeoff'}
                </button>
              ))}
            </div>
          </section>

          {/* ── Customer ── */}
          <section className="border border-ink-600 rounded-xl bg-ink-800 p-5">
            <h3 className="text-sm font-semibold text-ink-50 mb-3">Customer</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Field label="Name" required>
                <Input
                  value={customerName}
                  onChange={setCustomerName}
                  placeholder="Jarrod from Smith Construction"
                  required
                />
              </Field>
              <Field label="Company">
                <Input
                  value={customerCompany}
                  onChange={setCustomerCompany}
                  placeholder="Smith Construction Pty Ltd"
                />
              </Field>
              <Field label="Email">
                <Input
                  value={customerEmail}
                  onChange={setCustomerEmail}
                  placeholder="jarrod@smithcon.com.au"
                  type="email"
                />
              </Field>
              <Field label="Phone">
                <Input
                  value={customerPhone}
                  onChange={setCustomerPhone}
                  placeholder="0400 000 000"
                  type="tel"
                />
              </Field>
            </div>
          </section>

          {/* ── Inclusion notes ── */}
          <section className="border border-ink-600 rounded-xl bg-ink-800 p-5">
            <h3 className="text-sm font-semibold text-ink-50 mb-1">
              What does the customer want?
            </h3>
            <p className="text-xs text-ink-400 mb-3">
              Be specific about inclusions and exclusions — "ties + plascourse,
              only the garage lintel, exclude piers". The estimator uses this
              as their spec.
            </p>
            <textarea
              value={inclusionNotes}
              onChange={(e) => setInclusionNotes(e.target.value)}
              rows={6}
              className="w-full px-3 py-2 rounded-lg border border-ink-600 bg-ink-900 text-ink-50 text-sm focus:outline-none focus:border-beme-400 resize-y"
              placeholder="230mm brick veneer to ground floor only. Include ties + plascourse. Lintel sizing on garage opening only. Exclude internal block walls (separate trade)."
            />
          </section>

          {/* ── Plan PDF ── */}
          <section className="border border-ink-600 rounded-xl bg-ink-800 p-5">
            <h3 className="text-sm font-semibold text-ink-50 mb-1">Plan</h3>
            <p className="text-xs text-ink-400 mb-3">
              Upload the customer's PDF of the plans. The estimator will trace
              over it inside Beme.
            </p>
            <input
              type="file"
              accept="application/pdf"
              onChange={(e) => setPlanFile(e.target.files?.[0] ?? null)}
              className="block w-full text-sm text-ink-200 file:mr-3 file:py-2 file:px-4 file:rounded-lg file:border-0 file:bg-beme-500 file:text-black file:font-medium file:cursor-pointer hover:file:bg-beme-400"
            />
            {planFile && (
              <p className="text-xs text-ink-300 mt-2">
                Selected: <span className="text-ink-50">{planFile.name}</span> (
                {Math.round(planFile.size / 1024)} KB)
              </p>
            )}
          </section>

          {/* ── Assignee ── */}
          <section className="border border-ink-600 rounded-xl bg-ink-800 p-5">
            <h3 className="text-sm font-semibold text-ink-50 mb-3">
              Send to estimator
            </h3>
            {membersLoading ? (
              <p className="text-sm text-ink-400">Loading team…</p>
            ) : assignableMembers.length === 0 ? (
              <p className="text-sm text-amber-300">
                Your organisation doesn't have any estimators yet. Ask an admin
                to add one (Settings → Organisation) before sending requests.
              </p>
            ) : (
              <select
                value={assignedToUserId}
                onChange={(e) => setAssignedToUserId(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-ink-600 bg-ink-900 text-ink-50 text-sm focus:outline-none focus:border-beme-400"
              >
                <option value="">Unassigned (anyone can pick up)</option>
                {assignableMembers.map((m) => (
                  <option key={m.userId} value={m.userId}>
                    {m.displayName || m.email || `Member (${m.role})`} —{' '}
                    {m.role}
                  </option>
                ))}
              </select>
            )}
          </section>

          {error && (
            <div className="border border-rose-500/40 bg-rose-500/10 rounded-lg p-3 text-sm text-rose-200">
              {error}
            </div>
          )}

          <div className="flex items-center justify-end gap-3">
            <Link
              to="/requests"
              className="px-4 py-2 rounded-lg border border-ink-600 text-ink-200 hover:bg-ink-700 text-sm"
            >
              Cancel
            </Link>
            <button
              type="submit"
              disabled={!canSubmit}
              className="px-5 py-2 rounded-lg bg-beme-500 text-black text-sm font-medium hover:bg-beme-400 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {submitting ? 'Sending…' : 'Send to estimator →'}
            </button>
          </div>
        </form>
      </main>
    </div>
  )
}

// ─── form primitives (kept local — these only exist on this page for now) ──

function Field({
  label,
  required,
  children,
}: {
  label: string
  required?: boolean
  children: React.ReactNode
}) {
  return (
    <label className="block">
      <span className="text-xs text-ink-300 mb-1.5 inline-block">
        {label}
        {required && <span className="text-rose-300 ml-1">*</span>}
      </span>
      {children}
    </label>
  )
}

function Input({
  value,
  onChange,
  placeholder,
  type = 'text',
  required,
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  type?: string
  required?: boolean
}) {
  return (
    <input
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      required={required}
      className="w-full px-3 py-2 rounded-lg border border-ink-600 bg-ink-900 text-ink-50 text-sm focus:outline-none focus:border-beme-400"
    />
  )
}
