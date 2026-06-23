import { useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import LoadingScreen from '../components/LoadingScreen'
import { useAuth } from '../lib/auth'
import { listOrgMembers, useOrganisations } from '../lib/organisations'
import { listProjects, type ProjectStatus, type SavedProject } from '../lib/projectStorage'
import type { OrgMember } from '../types/organisations'

/**
 * /projects - master list of every project the user can see. The
 * dashboard's "View all →" links jump here with pre-filled URL filters.
 *
 * Filters:
 * - status:  all / in-progress / completed
 * - type:    all / block / brick
 * - owner:   any / specific person (resolves to ownerUserId)
 * - period:  all / today / this week / this month  (by updatedAt /
 * completedAt depending on status)
 *
 * Filters are URL-encoded so the page is shareable + bookmarkable + linkable
 * from the dashboard.
 */
export default function ProjectsPage() {
  const { currentOrg, loading: orgLoading } = useOrganisations()
  const { user } = useAuth()
  const [searchParams, setSearchParams] = useSearchParams()

  const [projects, setProjects] = useState<SavedProject[]>([])
  const [members, setMembers] = useState<OrgMember[]>([])
  const [loading, setLoading] = useState(true)
  // Local mirror of the `q` search param so the input stays responsive.
  // A URL-param-controlled input drops characters under fast typing because
  // every keystroke round-trips through setSearchParams before the value
  // comes back. We hold the text locally (instant) and sync the URL (which
  // drives the actual filtering) in the same handler.
  const [searchInput, setSearchInput] = useState(() => searchParams.get('q') ?? '')

  // Filters read from URL with sensible fallbacks.
  const statusFilter: 'all' | ProjectStatus = (() => {
    const s = searchParams.get('status')
    if (s === 'in-progress' || s === 'completed') return s
    return 'all'
  })()
  const typeFilter: 'all' | 'block' | 'brick' = (() => {
    const t = searchParams.get('type')
    if (t === 'block' || t === 'brick') return t
    return 'all'
  })()
  const ownerFilter: string = searchParams.get('owner') ?? 'any'
  const period: 'all' | 'today' | 'week' | 'month' = (() => {
    const p = searchParams.get('period')
    if (p === 'today' || p === 'week' || p === 'month') return p
    return 'all'
  })()
  // Reference number filter. Whatever the user types is kept as a string
  // and matched with a substring contains check against the project's
  // reference number (also stringified), so partial digits like '1234'
  // narrow to every project whose number includes that run of digits.
  // We strip leading '#' so paste-from-PDF works.
  const refFilter: string = (() => {
    const raw = searchParams.get('ref') ?? ''
    return raw.replace(/^#/, '').replace(/\s+/g, '')
  })()

  // Free-text search across project name / address / client / estimator.
  const searchFilter: string = (searchParams.get('q') ?? '').trim()

  /** Update one filter without losing the others - keeps each onChange one-line. */
  function updateParam(key: string, value: string | null) {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        if (value === null || value === '' || value === 'all' || value === 'any') {
          next.delete(key)
        } else {
          next.set(key, value)
        }
        return next
      },
      { replace: true }
    )
  }

  // Load projects + members. Re-runs when org changes so a user switching
  // orgs sees the right scope. We don't gate on the auth state explicitly -
  // if user is null the page is still rendered (org membership is the gate
  // and listProjects bails locally for offline mode).
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void (async () => {
      try {
        const [projs, mems] = await Promise.all([
          listProjects(),
          currentOrg ? listOrgMembers(currentOrg.id) : Promise.resolve<OrgMember[]>([]),
        ])
        if (cancelled) return
        setProjects(projs)
        setMembers(mems)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [currentOrg])

  const memberById = useMemo(() => {
    const m = new Map<string, OrgMember>()
    for (const x of members) m.set(x.userId, x)
    return m
  }, [members])

  // Date predicate - picks updatedAt for in-progress, completedAt for
  // completed (falling back to updatedAt). 'all' means no bound.
  const filtered = useMemo(() => {
    const lowerBound = (() => {
      const now = Date.now()
      if (period === 'today') return now - 24 * 60 * 60 * 1000
      if (period === 'week') return now - 7 * 24 * 60 * 60 * 1000
      if (period === 'month') return now - 30 * 24 * 60 * 60 * 1000
      return null
    })()
    return projects.filter((p) => {
      if (statusFilter !== 'all' && p.status !== statusFilter) return false
      if (typeFilter !== 'all' && p.type !== typeFilter) return false
      if (ownerFilter !== 'any') {
        const owner = p.ownerUserId ?? p.createdByUserId ?? null
        if (owner !== ownerFilter) return false
      }
      if (refFilter.length > 0) {
        // Substring contains. The ref column is a number - stringify with
        // 6-digit padding so "100" matches "100123" AND "000100", which
        // matches the formatting the user sees on PDFs + the project bar.
        if (typeof p.referenceNumber !== 'number') return false
        const padded =
          p.referenceNumber >= 100000
            ? `${p.referenceNumber}`
            : String(p.referenceNumber).padStart(6, '0')
        if (!padded.includes(refFilter)) return false
      }
      if (searchFilter) {
        const q = searchFilter.toLowerCase()
        const d = p.projectDetails
        const hay = `${d.projectName} ${d.siteAddress} ${d.clientName} ${d.estimatorName}`.toLowerCase()
        if (!hay.includes(q)) return false
      }
      if (lowerBound !== null) {
        const iso =
          p.status === 'completed'
            ? p.completedAt ?? p.updatedAt
            : p.updatedAt
        const t = new Date(iso).getTime()
        if (!Number.isFinite(t) || t < lowerBound) return false
      }
      return true
    })
  }, [projects, statusFilter, typeFilter, ownerFilter, refFilter, searchFilter, period])

  // Sort: completed by completedAt desc; in-progress + all by updatedAt desc.
  const sorted = useMemo(() => {
    const sortIso = (p: SavedProject) =>
      (p.status === 'completed' ? p.completedAt ?? p.updatedAt : p.updatedAt) ?? p.updatedAt
    return [...filtered].sort(
      (a, b) => new Date(sortIso(b)).getTime() - new Date(sortIso(a)).getTime()
    )
  }, [filtered])

  // Status pill counts: same filters EXCEPT status itself, so each pill
  // shows how many would be visible under that status.
  const counts = useMemo(() => {
    const acc: Record<'all' | ProjectStatus, number> = {
      'all': 0,
      'in-progress': 0,
      'completed': 0,
    }
    const lowerBound = (() => {
      const now = Date.now()
      if (period === 'today') return now - 24 * 60 * 60 * 1000
      if (period === 'week') return now - 7 * 24 * 60 * 60 * 1000
      if (period === 'month') return now - 30 * 24 * 60 * 60 * 1000
      return null
    })()
    for (const p of projects) {
      if (typeFilter !== 'all' && p.type !== typeFilter) continue
      if (ownerFilter !== 'any') {
        const owner = p.ownerUserId ?? p.createdByUserId ?? null
        if (owner !== ownerFilter) continue
      }
      if (refFilter.length > 0) {
        if (typeof p.referenceNumber !== 'number') continue
        const padded =
          p.referenceNumber >= 100000
            ? `${p.referenceNumber}`
            : String(p.referenceNumber).padStart(6, '0')
        if (!padded.includes(refFilter)) continue
      }
      if (searchFilter) {
        const q = searchFilter.toLowerCase()
        const d = p.projectDetails
        const hay = `${d.projectName} ${d.siteAddress} ${d.clientName} ${d.estimatorName}`.toLowerCase()
        if (!hay.includes(q)) continue
      }
      if (lowerBound !== null) {
        const iso =
          p.status === 'completed'
            ? p.completedAt ?? p.updatedAt
            : p.updatedAt
        const t = new Date(iso).getTime()
        if (!Number.isFinite(t) || t < lowerBound) continue
      }
      acc.all++
      if (p.status === 'in-progress') acc['in-progress']++
      if (p.status === 'completed') acc.completed++
    }
    return acc
  }, [projects, typeFilter, ownerFilter, refFilter, searchFilter, period])

  return (
    <>
      <div className="px-12 py-10">
        <Link
          to="/"
          className="inline-flex items-center gap-1.5 text-sm text-ink-400 hover:text-beme-300 transition-colors mb-3"
        >
          <span>←</span>
          <span>Back to dashboard</span>
        </Link>

        <div className="flex items-end justify-between flex-wrap gap-3 mb-4">
          <div>
            <h2 className="text-3xl font-extrabold tracking-tight text-ink-50">
              Projects
            </h2>
            <p className="text-sm text-ink-400 mt-1">
              Every estimate {currentOrg ? `for ${currentOrg.name}` : 'in your account'} - filter by status, type, person, or time.
            </p>
          </div>
          <Link
            to="/project/block"
            className="px-3.5 py-2 rounded-lg bg-beme-500 text-black text-sm font-semibold hover:bg-beme-400 transition-colors"
          >
            + New estimate
          </Link>
        </div>

        {/* Filter row */}
        <div className="border border-ink-600 rounded-xl bg-ink-800/60 p-4 mb-4">
          <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
            <div>
              <div className="text-[10px] uppercase tracking-wider text-ink-400 mb-1.5">
                Search
              </div>
              <div className="relative">
                <input
                  type="search"
                  value={searchInput}
                  onChange={(e) => {
                    setSearchInput(e.target.value)
                    updateParam('q', e.target.value)
                  }}
                  placeholder="Name, address, client…"
                  className="pl-8 pr-3 py-1.5 w-56 rounded-md border border-ink-600 bg-ink-900 text-ink-50 text-sm placeholder:text-ink-500 focus:outline-none focus:border-beme-400"
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
              </div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wider text-ink-400 mb-1.5">
                Status
              </div>
              <div className="flex flex-wrap gap-1.5">
                <StatusPill
                  active={statusFilter === 'all'}
                  label="All"
                  count={counts.all}
                  onClick={() => updateParam('status', null)}
                />
                <StatusPill
                  active={statusFilter === 'in-progress'}
                  label="In progress"
                  count={counts['in-progress']}
                  onClick={() => updateParam('status', 'in-progress')}
                />
                <StatusPill
                  active={statusFilter === 'completed'}
                  label="Completed"
                  count={counts.completed}
                  onClick={() => updateParam('status', 'completed')}
                />
              </div>
            </div>

            <div>
              <div className="text-[10px] uppercase tracking-wider text-ink-400 mb-1.5">
                Type
              </div>
              <select
                value={typeFilter}
                onChange={(e) => updateParam('type', e.target.value)}
                className="px-3 py-1.5 rounded-md border border-ink-600 bg-ink-900 text-ink-50 text-sm focus:outline-none focus:border-beme-400"
              >
                <option value="all">All types</option>
                <option value="block">Block</option>
                <option value="brick">Brick</option>
              </select>
            </div>

            {currentOrg && (
              <div>
                <div className="text-[10px] uppercase tracking-wider text-ink-400 mb-1.5">
                  Owner
                </div>
                <select
                  value={ownerFilter}
                  onChange={(e) => updateParam('owner', e.target.value)}
                  className="px-3 py-1.5 rounded-md border border-ink-600 bg-ink-900 text-ink-50 text-sm focus:outline-none focus:border-beme-400"
                >
                  <option value="any">Anyone</option>
                  {user?.id && <option value={user.id}>Me</option>}
                  {members
                    .filter((m) => m.userId !== user?.id)
                    .map((m) => (
                      <option key={m.userId} value={m.userId}>
                        {m.displayName || m.email || 'Member'}
                      </option>
                    ))}
                </select>
              </div>
            )}

            <div>
              <div className="text-[10px] uppercase tracking-wider text-ink-400 mb-1.5">
                Period
              </div>
              <select
                value={period}
                onChange={(e) => updateParam('period', e.target.value)}
                className="px-3 py-1.5 rounded-md border border-ink-600 bg-ink-900 text-ink-50 text-sm focus:outline-none focus:border-beme-400"
              >
                <option value="all">All time</option>
                <option value="today">Today</option>
                <option value="week">This week</option>
                <option value="month">This month</option>
              </select>
            </div>

            <div>
              <div className="text-[10px] uppercase tracking-wider text-ink-400 mb-1.5">
                Reference
              </div>
              <div className="flex items-stretch">
                <div className="flex items-center px-2 rounded-l-md border border-ink-600 border-r-0 bg-ink-800 text-ink-400 text-sm">
                  #
                </div>
                <input
                  value={refFilter}
                  onChange={(e) =>
                    updateParam(
                      'ref',
                      e.target.value.replace(/^#/, '').replace(/\s+/g, '')
                    )
                  }
                  placeholder="100123"
                  inputMode="numeric"
                  className="w-32 px-2 py-1.5 rounded-r-md border border-ink-600 bg-ink-900 text-ink-50 text-sm tabular-nums focus:outline-none focus:border-beme-400"
                />
              </div>
            </div>

            {(statusFilter !== 'all' ||
              typeFilter !== 'all' ||
              ownerFilter !== 'any' ||
              period !== 'all' ||
              refFilter !== '' ||
              searchFilter !== '') && (
              <button
                onClick={() => {
                  setSearchInput('')
                  setSearchParams({}, { replace: true })
                }}
                className="text-xs text-ink-400 hover:text-beme-300 ml-auto"
              >
                Reset filters
              </button>
            )}
          </div>
        </div>

        {/* List */}
        {loading || orgLoading ? (
          <div className="py-16 flex justify-center">
            <LoadingScreen
              message="Loading your projects"
              steps={['Fetching your estimates…', 'Tallying it up…']}
            />
          </div>
        ) : sorted.length === 0 ? (
          <div className="border border-dashed border-ink-600 rounded-xl bg-ink-800/40 p-8 text-center">
            <div className="text-sm text-ink-300">No projects match these filters.</div>
            <p className="text-xs text-ink-500 mt-1">
              Try widening the time range or clearing the owner filter.
            </p>
          </div>
        ) : (
          <ul className="space-y-2">
            {sorted.map((p) => (
              <ProjectRow key={p.id} project={p} memberById={memberById} currentUserId={user?.id ?? null} />
            ))}
          </ul>
        )}
      </div>
    </>
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
      onClick={onClick}
      className={`px-3 py-1 rounded-full border text-sm transition-colors ${
        active
          ? 'bg-beme-500/20 border-beme-500/40 text-beme-200 font-semibold'
          : 'border-ink-600 text-ink-300 hover:bg-ink-700 hover:border-beme-500/40'
      }`}
    >
      {label} <span className="ml-1 tabular-nums text-ink-400">{count}</span>
    </button>
  )
}

function ProjectRow({
  project,
  memberById,
  currentUserId,
}: {
  project: SavedProject
  memberById: Map<string, OrgMember>
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
  const ownerId = project.ownerUserId ?? project.createdByUserId ?? null
  const owner = ownerId ? memberById.get(ownerId) : null
  // Only label a project with a REAL, named teammate. No generic "a teammate"
  // fallback for an unresolved owner (on a solo / individual account that
  // owner is the user themselves, just absent from a members list), and never
  // label the current user's own projects "by ...".
  const isMyProject = !!ownerId && !!currentUserId && ownerId === currentUserId
  const ownerName = isMyProject
    ? null
    : owner?.displayName || owner?.email || null
  const refLabel =
    typeof project.referenceNumber === 'number'
      ? project.referenceNumber >= 100000
        ? `${project.referenceNumber}`
        : project.referenceNumber.toString().padStart(6, '0')
      : null
  const dateLabel = (() => {
    const iso =
      project.status === 'completed'
        ? project.completedAt ?? project.updatedAt
        : project.updatedAt
    const d = new Date(iso)
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString()
  })()
  return (
    <li>
      <Link
        to={href}
        className="block border border-ink-600 rounded-lg bg-ink-800 px-4 py-3 hover:border-beme-500/40 hover:bg-ink-700/40 transition-colors"
      >
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-semibold text-ink-50 truncate">{name}</span>
              {refLabel && (
                <span className="text-[11px] tabular-nums font-semibold text-ink-300">
                  #{refLabel}
                </span>
              )}
              <span className="text-[10px] uppercase tracking-wider text-ink-400">
                {project.type === 'brick' ? 'Brick' : 'Block'}
              </span>
              {project.status === 'completed' ? (
                <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 font-semibold">
                  Completed
                </span>
              ) : (
                <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded-full bg-beme-500/15 text-beme-300 border border-beme-500/30 font-semibold">
                  In progress
                </span>
              )}
              {ownerName && (
                <span className="text-[11px] text-ink-400">
                  by <span className="text-ink-300">{ownerName}</span>
                </span>
              )}
            </div>
            {subtitle && (
              <div className="text-sm text-ink-300 mt-0.5 truncate">{subtitle}</div>
            )}
            <div className="text-xs text-ink-400 mt-1">
              {project.status === 'completed' ? 'Completed' : 'Updated'} {dateLabel}
            </div>
          </div>
        </div>
      </Link>
    </li>
  )
}
