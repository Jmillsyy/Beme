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
      <span className="text-xs px-2 py-0.5 rounded-full border bg-green-100 text-green-800 border-green-300">
        Completed
      </span>
    )
  }
  return (
    <span className="text-xs px-2 py-0.5 rounded-full border bg-amber-100 text-amber-800 border-amber-300">
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
    <div className="min-h-screen bg-white text-neutral-900">
      <Header />

      <main className="max-w-[1500px] mx-auto px-6 py-16">
        <h2 className="text-5xl font-bold mb-4">Welcome to beme</h2>
        <p className="text-lg text-neutral-600 max-w-2xl">
          Import a building plan, draw or trace walls, and produce an itemised masonry takeoff in minutes.
        </p>

        {/* New estimate cards */}
        <div className="mt-12">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-neutral-500 mb-3">
            Start a new estimate
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Link
              to="/project/brick"
              className="border border-neutral-200 rounded-xl p-6 hover:border-beme-500 hover:shadow-lg transition-all"
            >
              <h4 className="text-xl font-bold text-beme-600 mb-1">Brick Estimate</h4>
              <p className="text-sm text-neutral-600">
                Trace brick walls over a plan, set heights, subtract openings, auto-add lintels and ties.
              </p>
            </Link>

            <Link
              to="/project/block"
              className="border border-neutral-200 rounded-xl p-6 hover:border-beme-500 hover:shadow-lg transition-all"
            >
              <h4 className="text-xl font-bold text-beme-600 mb-1">Block Estimate</h4>
              <p className="text-sm text-neutral-600">
                Define wall makeups, draw walls over a plan, auto-tally blocks by code with corners,
                fractions, and openings.
              </p>
            </Link>
          </div>
        </div>

        {/* Saved projects */}
        <div className="mt-16">
          <div className="flex items-center justify-between flex-wrap gap-3 mb-3">
            <h3 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">
              Projects
            </h3>
            <div className="flex items-center gap-1 border border-neutral-200 rounded-lg p-1">
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

          {loading && <div className="text-sm text-neutral-500">Loading…</div>}

          {!loading && filtered.length === 0 && (
            <div className="border border-dashed border-neutral-300 rounded-xl p-12 text-center text-neutral-500">
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
          ? 'bg-beme-600 text-white'
          : 'text-neutral-600 hover:bg-neutral-100'
      }`}
    >
      {label} <span className={active ? 'opacity-70' : 'text-neutral-400'}>{count}</span>
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
    <li className="border border-neutral-200 rounded-xl bg-white hover:border-beme-400 transition-colors">
      <div className="flex items-center justify-between flex-wrap gap-3 p-4">
        <Link
          to={`/project/${project.type}?id=${project.id}`}
          className="flex-1 min-w-0 group"
        >
          <div className="flex items-center gap-3 flex-wrap">
            <span className="text-base font-semibold text-neutral-800 group-hover:text-beme-700">
              {name}
            </span>
            {statusBadge(project.status)}
            <span className="text-xs px-2 py-0.5 rounded-full border bg-neutral-100 text-neutral-600 border-neutral-300">
              {typeLabel}
            </span>
          </div>
          {subtitle && <div className="text-sm text-neutral-500 mt-0.5">{subtitle}</div>}
          <div className="text-xs text-neutral-500 mt-1">
            Updated {formatRelative(project.updatedAt)}
            {project.completedAt && (
              <span> · Completed {formatRelative(project.completedAt)}</span>
            )}
          </div>
        </Link>
        <div className="flex items-center gap-2">
          <Link
            to={`/project/${project.type}?id=${project.id}`}
            className="px-3 py-1.5 rounded-lg bg-beme-600 text-white text-sm hover:bg-beme-700 transition-colors"
          >
            Open
          </Link>
          <button
            onClick={onDelete}
            className="px-3 py-1.5 rounded-lg border border-red-300 text-red-600 text-sm hover:bg-red-50 transition-colors"
          >
            Delete
          </button>
        </div>
      </div>
    </li>
  )
}
