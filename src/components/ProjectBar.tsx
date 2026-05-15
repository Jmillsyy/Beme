import { useEffect, useRef, useState } from 'react'
import type { ProjectDetails } from '../types/walls'
import type { ProjectStatus } from '../lib/projectStorage'

interface ProjectBarProps {
  details: ProjectDetails
  isSaved: boolean
  status: ProjectStatus
  lastSavedAt: string | null
  canSave: boolean
  saveBlockedReason: string | null
  onSave: () => void
  onToggleStatus: () => void
  onDelete: () => void
  onOpenDetails: () => void
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

/**
 * Slim single-row strip at the top of an estimate page. Shows project name,
 * status badge, last-saved time, and Save / ⋯ menu actions. Editing the full
 * project details (client, estimator, date, notes) is hidden behind the
 * "Edit details" button which opens a drawer — these are filled in once and
 * rarely revisited, so they shouldn't take permanent vertical space.
 */
export default function ProjectBar({
  details,
  isSaved,
  status,
  lastSavedAt,
  canSave,
  saveBlockedReason,
  onSave,
  onToggleStatus,
  onDelete,
  onOpenDetails,
}: ProjectBarProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  // Close the menu on outside click / Escape
  useEffect(() => {
    if (!menuOpen) return
    function handleClick(e: MouseEvent) {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false)
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setMenuOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handleClick)
      document.removeEventListener('keydown', handleKey)
    }
  }, [menuOpen])

  const displayName =
    details.projectName.trim() || details.siteAddress.trim() || 'Untitled project'
  const subtitle =
    details.projectName.trim() && details.siteAddress.trim() ? details.siteAddress : ''

  const statusBadge = !isSaved ? (
    <span className="text-xs px-2 py-0.5 rounded-full border bg-neutral-100 text-neutral-600 border-neutral-300">
      Unsaved
    </span>
  ) : status === 'completed' ? (
    <span className="text-xs px-2 py-0.5 rounded-full border bg-green-100 text-green-800 border-green-300 font-medium">
      Completed
    </span>
  ) : (
    <span className="text-xs px-2 py-0.5 rounded-full border bg-amber-100 text-amber-800 border-amber-300 font-medium">
      In progress
    </span>
  )

  return (
    <div className="my-4 border border-neutral-200 rounded-xl bg-white px-4 py-2 flex items-center justify-between flex-wrap gap-3">
      {/* Left: project identity */}
      <button
        onClick={onOpenDetails}
        className="flex items-center gap-3 min-w-0 group text-left"
        title="Edit project details"
      >
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-base font-semibold text-neutral-800 group-hover:text-beme-700 truncate">
              {displayName}
            </span>
            {statusBadge}
          </div>
          {(subtitle || lastSavedAt) && (
            <div className="text-xs text-neutral-500 mt-0.5 truncate">
              {subtitle}
              {subtitle && lastSavedAt && ' · '}
              {lastSavedAt && <>Saved {formatRelativeTime(lastSavedAt)}</>}
            </div>
          )}
        </div>
      </button>

      {/* Right: actions */}
      <div className="flex items-center gap-2 flex-wrap">
        <button
          onClick={onOpenDetails}
          className="px-3 py-1.5 rounded-lg border border-neutral-300 text-sm hover:bg-neutral-100 transition-colors"
        >
          Edit details
        </button>
        <button
          onClick={onSave}
          disabled={!canSave}
          title={canSave ? undefined : saveBlockedReason ?? 'Cannot save yet'}
          className="px-4 py-1.5 rounded-lg bg-beme-600 text-white text-sm hover:bg-beme-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors font-medium"
        >
          {isSaved ? 'Save changes' : 'Save project'}
        </button>

        {isSaved && (
          <div className="relative" ref={menuRef}>
            <button
              onClick={() => setMenuOpen((v) => !v)}
              className="px-2.5 py-1.5 rounded-lg border border-neutral-300 text-sm hover:bg-neutral-100 transition-colors"
              aria-label="More project actions"
              aria-expanded={menuOpen}
            >
              ⋯
            </button>
            {menuOpen && (
              <div className="absolute right-0 mt-1 w-56 rounded-lg border border-neutral-200 bg-white shadow-lg z-30 py-1 text-sm">
                <button
                  onClick={() => {
                    setMenuOpen(false)
                    onToggleStatus()
                  }}
                  className="w-full text-left px-3 py-2 hover:bg-neutral-100 transition-colors"
                >
                  {status === 'completed' ? 'Mark as in progress' : 'Mark as completed'}
                </button>
                <button
                  onClick={() => {
                    setMenuOpen(false)
                    onDelete()
                  }}
                  className="w-full text-left px-3 py-2 text-red-600 hover:bg-red-50 transition-colors"
                >
                  Delete project
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {!canSave && saveBlockedReason && !isSaved && (
        <p className="text-xs text-neutral-500 w-full -mt-1">⚠ {saveBlockedReason}</p>
      )}
    </div>
  )
}
