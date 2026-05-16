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
 * Compact dark top bar — the Studio Black theme header.
 *
 * Left: brand mark + breadcrumb-style project identity (clickable → edit details drawer).
 * Right: save / status menu actions.
 *
 * Sits flush with the workspace below (no margin) and spans full width.
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
    <span className="text-[11px] px-2 py-0.5 rounded-full bg-ink-700 text-ink-200 border border-ink-600 font-medium">
      Unsaved
    </span>
  ) : status === 'completed' ? (
    <span className="text-[11px] px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/40 font-medium">
      Completed
    </span>
  ) : (
    <span className="text-[11px] px-2 py-0.5 rounded-full bg-beme-500/15 text-beme-300 border border-beme-500/40 font-medium">
      In progress
    </span>
  )

  return (
    <div className="bg-ink-800/60 border-b border-ink-600 px-6 py-2.5 flex items-center gap-4 flex-wrap">
      {/* Project identity */}
      <button
        onClick={onOpenDetails}
        className="flex items-center gap-2.5 min-w-0 group text-left flex-1"
        title="Edit project details"
      >
        <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-400">
          Project
        </span>
        <span className="font-semibold text-[15px] text-ink-50 group-hover:text-beme-300 truncate transition-colors">
          {displayName}
        </span>
        {subtitle && (
          <span className="text-ink-400 text-xs hidden md:inline truncate">
            · {subtitle}
          </span>
        )}
        {statusBadge}
        {lastSavedAt && (
          <span className="text-ink-500 text-xs hidden lg:inline">
            · saved {formatRelativeTime(lastSavedAt)}
          </span>
        )}
      </button>

      {/* Action cell */}
      <div className="flex items-center gap-2 flex-shrink-0">
        <button
          onClick={onOpenDetails}
          className="px-3 py-1.5 rounded-md border border-ink-600 text-ink-200 text-[13px] hover:bg-ink-700 hover:text-ink-50 transition-colors"
        >
          Details
        </button>
        <button
          onClick={onSave}
          disabled={!canSave}
          title={canSave ? undefined : saveBlockedReason ?? 'Cannot save yet'}
          className="px-3 py-1.5 rounded-md bg-beme-500 text-black text-[13px] hover:bg-beme-400 disabled:opacity-40 disabled:cursor-not-allowed transition-colors font-semibold"
        >
          {isSaved ? 'Save changes' : 'Save'}
        </button>

        {isSaved && (
          <div className="relative" ref={menuRef}>
            <button
              onClick={() => setMenuOpen((v) => !v)}
              className="px-2 py-1.5 rounded-md border border-ink-600 text-ink-200 text-[13px] hover:bg-ink-700 hover:text-ink-50 transition-colors"
              aria-label="More project actions"
              aria-expanded={menuOpen}
            >
              ⋯
            </button>
            {menuOpen && (
              <div className="absolute right-0 mt-1 w-56 rounded-lg border border-ink-600 bg-ink-800 shadow-xl shadow-black/40 z-30 py-1 text-[13px]">
                <button
                  onClick={() => {
                    setMenuOpen(false)
                    onToggleStatus()
                  }}
                  className="w-full text-left px-3 py-2 text-ink-100 hover:bg-ink-700 transition-colors"
                >
                  {status === 'completed' ? 'Mark as in progress' : 'Mark as completed'}
                </button>
                <button
                  onClick={() => {
                    setMenuOpen(false)
                    onDelete()
                  }}
                  className="w-full text-left px-3 py-2 text-rose-400 hover:bg-rose-500/10 transition-colors"
                >
                  Delete project
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
