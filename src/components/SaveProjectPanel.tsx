import type { ProjectStatus } from '../lib/projectStorage'

interface SaveProjectPanelProps {
  /** Whether this estimate has been saved yet. */
  isSaved: boolean
  status: ProjectStatus
  /** ISO datetime of the last save (null if never saved). */
  lastSavedAt: string | null
  /** Whether save is currently allowed. */
  canSave: boolean
  /** Human-readable reason save is blocked (e.g. "Add a project name + PDF"). */
  saveBlockedReason: string | null
  onSave: () => void
  onToggleStatus: () => void
  onDelete: () => void
}

function formatRelativeTime(iso: string): string {
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

export default function SaveProjectPanel({
  isSaved,
  status,
  lastSavedAt,
  canSave,
  saveBlockedReason,
  onSave,
  onToggleStatus,
  onDelete,
}: SaveProjectPanelProps) {
  const statusLabel = status === 'completed' ? 'Completed' : 'In progress'
  const statusColor =
    status === 'completed'
      ? 'bg-green-100 text-green-800 border-green-300'
      : 'bg-amber-100 text-amber-800 border-amber-300'

  return (
    <div className="my-4 border border-neutral-200 rounded-xl bg-white p-4 flex items-center justify-between flex-wrap gap-3">
      <div className="flex items-center gap-3 flex-wrap">
        <h3 className="text-sm font-semibold text-neutral-700">Project status</h3>
        {isSaved ? (
          <span
            className={`text-xs px-2 py-0.5 rounded-full border font-medium ${statusColor}`}
          >
            {statusLabel}
          </span>
        ) : (
          <span className="text-xs px-2 py-0.5 rounded-full border bg-neutral-100 text-neutral-600 border-neutral-300">
            Unsaved
          </span>
        )}
        {lastSavedAt && (
          <span className="text-xs text-neutral-500">
            Last saved {formatRelativeTime(lastSavedAt)}
          </span>
        )}
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <button
          onClick={onSave}
          disabled={!canSave}
          title={canSave ? undefined : saveBlockedReason ?? 'Cannot save yet'}
          className="px-4 py-1.5 rounded-lg bg-beme-600 text-white text-sm hover:bg-beme-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors font-medium"
        >
          {isSaved ? 'Save changes' : 'Save project'}
        </button>
        {isSaved && (
          <>
            <button
              onClick={onToggleStatus}
              className="px-3 py-1.5 rounded-lg border border-neutral-300 text-sm hover:bg-neutral-100 transition-colors"
            >
              {status === 'completed' ? 'Mark as in progress' : 'Mark as completed'}
            </button>
            <button
              onClick={onDelete}
              className="px-3 py-1.5 rounded-lg border border-red-300 text-red-600 text-sm hover:bg-red-50 transition-colors"
            >
              Delete project
            </button>
          </>
        )}
      </div>

      {!canSave && saveBlockedReason && (
        <p className="text-xs text-neutral-500 w-full">
          {saveBlockedReason}
        </p>
      )}
    </div>
  )
}
