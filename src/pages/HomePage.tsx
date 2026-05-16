import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import Header from '../components/Header'
import {
  type ProjectStatus,
  type SavedProject,
  deleteProject,
  listProjects,
} from '../lib/projectStorage'

type Filter = 'all' | ProjectStatus

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

export default function HomePage() {
  const [projects, setProjects] = useState<SavedProject[]>([])
  const [filter, setFilter] = useState<Filter>('all')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    listProjects()
      .then((list) => setProjects(list))
      .catch((err) => console.error('Failed to list projects', err))
      .finally(() => setLoading(false))
  }, [])

  const filtered = useMemo(() => {
    if (filter === 'all') return projects
    return projects.filter((p) => p.status === filter)
  }, [projects, filter])

  const counts = useMemo(
    () => ({
      all: projects.length,
      'in-progress': projects.filter((p) => p.status === 'in-progress').length,
      completed: projects.filter((p) => p.status === 'completed').length,
    }),
    [projects]
  )

  async function handleDelete(id: string) {
    if (!window.confirm('Delete this project? This cannot be undone.')) return
    try {
      await deleteProject(id)
      setProjects((prev) => prev.filter((p) => p.id !== id))
    } catch (err) {
      console.error('Failed to delete', err)
    }
  }

  return (
    <div className="min-h-screen bg-ink-900 text-ink-50">
      <Header />

      <main className="max-w-[1500px] mx-auto px-6 py-16">
        <h2 className="text-5xl font-extrabold tracking-tight mb-4 text-ink-50">
          Welcome to Beme
        </h2>
        <p className="text-lg text-ink-300 max-w-2xl">
          Import a building plan, draw or trace walls, and produce an itemised masonry takeoff in minutes.
        </p>

        {/* New estimate cards */}
        <div className="mt-12">
          <h3 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-400 mb-3">
            Start a new estimate
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Link
              to="/project/brick"
              className="border border-ink-600 rounded-xl p-6 bg-ink-800 hover:border-beme-500 hover:bg-ink-700 transition-all group"
            >
              <h4 className="text-xl font-bold text-beme-400 group-hover:text-beme-300 mb-1">Brick Estimate</h4>
              <p className="text-sm text-ink-300">
                Trace brick walls over a plan, set heights, subtract openings, auto-add lintels and ties.
              </p>
            </Link>

            <Link
              to="/project/block"
              className="border border-ink-600 rounded-xl p-6 bg-ink-800 hover:border-beme-500 hover:bg-ink-700 transition-all group"
            >
              <h4 className="text-xl font-bold text-beme-400 group-hover:text-beme-300 mb-1">Block Estimate</h4>
              <p className="text-sm text-ink-300">
                Define wall makeups, draw walls over a plan, auto-tally blocks by code with corners,
                fractions, and openings.
              </p>
            </Link>
          </div>
        </div>

        {/* Saved projects */}
        <div className="mt-16">
          <div className="flex items-center justify-between flex-wrap gap-3 mb-3">
            <h3 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-400">
              Projects
            </h3>
            <div className="flex items-center gap-1 border border-ink-600 rounded-lg p-1 bg-ink-800">
              <FilterTab
                label="All"
                count={counts.all}
                active={filter === 'all'}
                onClick={() => setFilter('all')}
              />
              <FilterTab
                label="In progress"
                count={counts['in-progress']}
                active={filter === 'in-progress'}
                onClick={() => setFilter('in-progress')}
              />
              <FilterTab
                label="Completed"
                count={counts.completed}
                active={filter === 'completed'}
                onClick={() => setFilter('completed')}
              />
            </div>
          </div>

          {loading && <div className="text-sm text-ink-400">Loading…</div>}

          {!loading && filtered.length === 0 && (
            <div className="border border-dashed border-ink-600 rounded-xl p-12 text-center text-ink-400 bg-ink-800/50">
              {projects.length === 0 ? (
                <span>
                  No saved projects yet. Start a new estimate above — save it once you've added the
                  PDF and project details.
                </span>
              ) : (
                <span>No projects with this status.</span>
              )}
            </div>
          )}

          {!loading && filtered.length > 0 && (
            <ul className="space-y-2">
              {filtered.map((p) => (
                <ProjectRow key={p.id} project={p} onDelete={() => handleDelete(p.id)} />
              ))}
            </ul>
          )}
        </div>
      </main>
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

function ProjectRow({
  project,
  onDelete,
}: {
  project: SavedProject
  onDelete: () => void
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
