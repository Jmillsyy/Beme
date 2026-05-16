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

export default function HomePage() {
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

  // ---------- Derived stats ----------
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
    return projects.filter((p) => !p.outcome) // pending
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

  /**
   * Cycle the outcome of a project: pending → won → lost → pending. Persists
   * via saveProject() and updates local state optimistically.
   */
  async function handleCycleOutcome(project: SavedProject) {
    const next = nextOutcome(project.outcome)
    // Optimistic update.
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
      // Roll back on error.
      setProjects((prev) =>
        prev.map((p) => (p.id === project.id ? project : p))
      )
    }
  }

  return (
    <div className="min-h-screen bg-ink-900 text-ink-50">
      <Header />

      <main className="max-w-[1500px] mx-auto px-6 py-12">
        {signedIn && <LocalMigrationBanner onMigrated={refreshProjects} />}

        <div className="flex items-end justify-between flex-wrap gap-4 mb-2">
          <div>
            <h2 className="text-4xl font-extrabold tracking-tight text-ink-50">Dashboard</h2>
            <p className="text-ink-300 text-sm mt-1">
              Your estimates, win rate, and current jobs at a glance.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {/* Primary button (orange) is the user's default project type — swap to match. */}
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

        {/* ── Stats row ── */}
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

        {/* ── Donut + onboarding cards row ── */}
        <section className="mt-6 grid grid-cols-1 lg:grid-cols-3 gap-4 items-stretch">
          {/* Donut card */}
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

          {/* Two onboarding "Start" cards */}
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

        {/* ── Projects list ── */}
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
      </main>
    </div>
  )
}

// ---------- Sub-components ----------

function StatTile({
  label,
  value,
  sub,
  accent,
}: {
  label: string
  value: string | number
  sub?: string
  accent?: 'beme' | 'emerald'
}) {
  const accentClass =
    accent === 'beme'
      ? 'text-beme-300'
      : accent === 'emerald'
        ? 'text-emerald-300'
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

/**
 * Clickable outcome pill: pending → won → lost → pending.
 * Stops link navigation when clicked.
 */
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
