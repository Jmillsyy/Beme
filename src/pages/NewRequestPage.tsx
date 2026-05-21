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
  // Multi-file upload — the first file is treated as the PRIMARY plan
  // (architectural, where walls get drawn). Anything after it is a reference
  // PDF (engineering specs etc.) the estimator can flip to in the workspace
  // but doesn't draw on. Ordered list because the order is meaningful
  // (whatever sits at index 0 is the primary).
  const [planFiles, setPlanFiles] = useState<File[]>([])
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
      // Default the assignee to the first non-admin staff member in the org
      // if any exists. Saves a click on the most common case ("send to our
      // team"). Admins can still be assigned manually if needed, but the
      // first-pick is staff so the request gets routed to a takeoff person
      // by default rather than to an admin who may not be doing estimates.
      const firstAssignable = list.find((m) => m.role === 'staff')
      if (firstAssignable) setAssignedToUserId(firstAssignable.userId)
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

  // Anyone in the org is a valid assignee — sales and estimator have
  // identical privileges in this product, and admins might pinch-hit on
  // takeoffs in smaller orgs. (If we ever want to gate sales out of the
  // takeoff workflow, this is the right place to add a role filter back.)
  const assignableMembers = members

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
        // First selected file is the primary plan (where walls go); the rest
        // travel as reference PDFs the estimator can flip to in the workspace.
        planFile: planFiles[0],
        additionalFiles: planFiles.length > 1 ? planFiles.slice(1) : undefined,
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
        {/* Breadcrumb pills — matches the back-to-dashboard styling on the
            ProjectBar so navigation feels consistent across the app. Two
            choices because users get here from either /requests (existing
            list) or / (dashboard sidebar's + New request shortcut). */}
        <div className="flex items-center gap-2 flex-wrap mb-6">
          <Link
            to="/"
            className="inline-flex items-center gap-2 px-3.5 py-2 rounded-md border border-ink-600 bg-ink-800/60 text-sm text-ink-200 hover:bg-ink-700 hover:border-beme-500/50 hover:text-beme-300 transition-colors"
            title="Back to dashboard"
          >
            <span className="text-base leading-none">←</span>
            <span>Dashboard</span>
          </Link>
          <Link
            to="/requests"
            className="inline-flex items-center gap-2 px-3.5 py-2 rounded-md border border-ink-600 bg-ink-800/60 text-sm text-ink-200 hover:bg-ink-700 hover:border-beme-500/50 hover:text-beme-300 transition-colors"
            title="Back to all requests"
          >
            <span className="text-base leading-none">←</span>
            <span>All requests</span>
          </Link>
        </div>
        <h2 className="text-4xl font-extrabold tracking-tight">
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

          {/* ── Plan PDFs ──
              Multi-file: the FIRST file becomes the primary plan (where
              walls are drawn), everything else travels along as reference
              PDFs (engineering specs etc.) the estimator can flip to in the
              workspace. The list below makes the primary explicit so the
              user knows which file the estimator will actually be working
              against — reorderable via the small Make primary action. */}
          <section className="border border-ink-600 rounded-xl bg-ink-800 p-5">
            <h3 className="text-sm font-semibold text-ink-50 mb-1">Plans</h3>
            <p className="text-xs text-ink-400 mb-3">
              Attach the architectural plan plus anything else useful —
              engineering specs, structural notes, the lot. The first file is
              the <span className="text-ink-100">primary</span> plan the
              estimator traces walls on; the rest are reference material they
              can flip to in the workspace.
            </p>
            <input
              type="file"
              accept="application/pdf"
              multiple
              onChange={(e) => {
                const newFiles = Array.from(e.target.files ?? [])
                if (newFiles.length === 0) return
                // Append rather than replace — clicking the file input
                // multiple times should accumulate so the user can pick
                // primary + reference in separate clicks if their file
                // dialog only lets them grab one folder at a time.
                setPlanFiles((prev) => [...prev, ...newFiles])
                // Clear the input so re-selecting the same file works.
                e.target.value = ''
              }}
              className="block w-full text-sm text-ink-200 file:mr-3 file:py-2 file:px-4 file:rounded-lg file:border-0 file:bg-beme-500 file:text-black file:font-medium file:cursor-pointer hover:file:bg-beme-400"
            />
            {planFiles.length > 0 && (
              <ul className="mt-3 space-y-2">
                {planFiles.map((f, idx) => (
                  <li
                    key={`${f.name}-${idx}`}
                    className="flex items-center gap-3 px-3 py-2 rounded-lg border border-ink-600 bg-ink-900/50"
                  >
                    <span
                      className={`text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full shrink-0 ${
                        idx === 0
                          ? 'bg-beme-500/15 text-beme-300 border border-beme-500/40'
                          : 'bg-ink-700 text-ink-300 border border-ink-600'
                      }`}
                    >
                      {idx === 0 ? 'Primary' : 'Reference'}
                    </span>
                    <span className="text-sm text-ink-100 flex-1 truncate" title={f.name}>
                      {f.name}
                    </span>
                    <span className="text-xs text-ink-400 shrink-0 tabular-nums">
                      {Math.round(f.size / 1024)} KB
                    </span>
                    {idx !== 0 && (
                      <button
                        type="button"
                        onClick={() => {
                          // Promote this file to primary: swap with index 0.
                          setPlanFiles((prev) => {
                            const next = [...prev]
                            const [chosen] = next.splice(idx, 1)
                            return [chosen, ...next]
                          })
                        }}
                        className="text-xs text-beme-300 hover:text-beme-200 shrink-0"
                      >
                        Make primary
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        setPlanFiles((prev) => prev.filter((_, i) => i !== idx))
                      }}
                      className="text-xs text-rose-300 hover:text-rose-200 shrink-0"
                      aria-label={`Remove ${f.name}`}
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
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
