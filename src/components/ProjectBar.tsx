import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import type { ProjectDetails } from '../types/walls'
import type { ProjectStatus } from '../lib/projectStorage'

/**
 * Minimal shape we need from an EstimateRequest to render the "← Request
 * from {customer}" pill on the right side of the bar. Kept local so the
 * component doesn't depend on the full EstimateRequest type / its lib chain.
 */
interface RequestBreadcrumbInfo {
  id: string
  customerName: string
  customerCompany?: string | null
}

interface ProjectBarProps {
  details: ProjectDetails
  isSaved: boolean
  status: ProjectStatus
  lastSavedAt: string | null
  canSave: boolean
  saveBlockedReason: string | null
  /**
   * The estimate type for this workspace — shown as a small chip in the bar
   * so we don't need a separate page heading underneath. Optional so the bar
   * still renders for older flows that don't pass it.
   */
  mode?: 'block' | 'brick'
  /**
   * The originating estimate request, when the project was created from one.
   * Rendered as a button on the right so the user can pop back to the
   * request without losing their place in the workspace.
   */
  sourceRequest?: RequestBreadcrumbInfo | null
  /**
   * Display name of whoever first saved this project. Surfaced as a "Started
   * by {name}" pill on the right side of the bar so teammates can see at a
   * glance who picked up an estimate. Null hides the pill (unsaved project
   * or unknown author).
   */
  createdByDisplayName?: string | null
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
  mode,
  sourceRequest,
  createdByDisplayName,
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

  // Status dot replaces the chip — same colour story, far less visual noise
  // when paired with the mode chip on the left.
  const statusLabel = !isSaved ? 'Unsaved' : status === 'completed' ? 'Completed' : 'In progress'
  const statusDotClass = !isSaved
    ? 'bg-ink-500'
    : status === 'completed'
      ? 'bg-emerald-400'
      : 'bg-beme-400'

  // Save button gets the "saved Xm ago" info as a tooltip — it's the same
  // button you'd hit if it needed re-saving, so the timestamp belongs there.
  const saveTitle = (() => {
    if (!canSave) return saveBlockedReason ?? 'Cannot save yet'
    if (lastSavedAt) return `Last saved ${formatRelativeTime(lastSavedAt)}`
    return undefined
  })()

  return (
    // Full-width bar with px-20 so the back-to-dashboard pill, breadcrumb,
    // project identity, and save actions line up with the workspace columns
    // below and the Beme logo + org/user pills in the header above. Matches
    // the estimate workspace's px-20 outer padding.
    <div className="bg-ink-800/60 border-b border-ink-600 px-20 py-2 flex items-center gap-3 flex-wrap">
      {/* LEFT — always a back-to-dashboard pill so the user can hop out of
          a project from anywhere. Followed by an optional request pill when
          the project came from an estimate request, so the breadcrumb reads
          Dashboard ← Request ← Project naturally from left to right. */}
      <Link
        to="/"
        className="inline-flex items-center gap-2 px-3.5 py-2 rounded-md border border-ink-600 bg-ink-800/60 text-sm text-ink-200 hover:bg-ink-700 hover:border-beme-500/50 hover:text-beme-300 transition-colors flex-shrink-0"
        title="Back to dashboard"
      >
        <span className="text-base leading-none">←</span>
        <span className="hidden md:inline">Dashboard</span>
      </Link>
      {sourceRequest ? (
        <Link
          to={`/requests/${sourceRequest.id}`}
          className="inline-flex items-center gap-2 px-3.5 py-2 rounded-md border border-ink-600 bg-ink-800/60 text-sm text-ink-200 hover:bg-ink-700 hover:border-beme-500/50 hover:text-beme-300 transition-colors flex-shrink-0"
        >
          <span className="text-base leading-none">←</span>
          <span>
            <span className="hidden md:inline">Request from </span>
            <span className="font-medium text-ink-50">{sourceRequest.customerName}</span>
            {sourceRequest.customerCompany && (
              <span className="text-ink-400"> · {sourceRequest.customerCompany}</span>
            )}
          </span>
        </Link>
      ) : null}

      {/* SPACER — pushes the project identity + actions to the right. */}
      <div className="flex-1" />

      {/* RIGHT — project identity + actions, all matching pill sizes so the
          right side reads as one cohesive control cluster. */}
      <div className="flex items-center gap-2 flex-shrink-0 flex-wrap">
        {createdByDisplayName && (
          <span
            className="hidden lg:inline-flex items-center gap-1.5 px-3.5 py-2 rounded-md border border-ink-600 bg-ink-800/60 text-sm text-ink-300"
            title="Estimator who started this project"
          >
            <span className="text-ink-500 text-xs uppercase tracking-wider">Started by</span>
            <span className="font-medium text-ink-100">{createdByDisplayName}</span>
          </span>
        )}
        <button
          onClick={onOpenDetails}
          className="inline-flex items-center gap-2 px-3.5 py-2 rounded-md border border-ink-600 bg-ink-800/60 group text-left text-sm hover:bg-ink-700 hover:border-beme-500/50 transition-colors"
          title={`${statusLabel} · click to edit project details`}
        >
          {mode && (
            <span
              className={`text-[10px] px-1.5 py-0.5 rounded uppercase tracking-wider font-semibold ${
                mode === 'block'
                  ? 'bg-beme-500/15 text-beme-300 border border-beme-500/30'
                  : 'bg-amber-500/15 text-amber-300 border border-amber-500/30'
              }`}
            >
              {mode}
            </span>
          )}
          <span
            className={`inline-block w-2 h-2 rounded-full ${statusDotClass}`}
            aria-label={statusLabel}
          />
          <span className="font-semibold text-ink-50 group-hover:text-beme-300 truncate transition-colors max-w-[260px]">
            {displayName}
          </span>
          {subtitle && (
            <span className="text-ink-400 text-xs hidden lg:inline truncate max-w-[200px]">
              · {subtitle}
            </span>
          )}
        </button>
        <button
          onClick={onSave}
          disabled={!canSave}
          title={saveTitle}
          className="px-3.5 py-2 rounded-md bg-beme-500 text-black text-sm hover:bg-beme-400 disabled:opacity-40 disabled:cursor-not-allowed transition-colors font-semibold"
        >
          {isSaved ? 'Save changes' : 'Save'}
        </button>

        {/* Top-level shortcut to flip the project status. Only shown once the
            project's actually been saved — there's nothing to mark complete
            before then. Green when moving in-progress → completed (the
            positive primary action). Muted when reverting completed → in
            progress so it doesn't visually shout for the less-common path.
            The same action also lives in the overflow menu for discovery. */}
        {isSaved && (
          <button
            onClick={onToggleStatus}
            title={
              status === 'completed'
                ? 'Reopen this project — moves it back to in progress.'
                : 'Mark this project complete — it moves to Recently Completed on the dashboard.'
            }
            className={
              status === 'completed'
                ? 'px-3.5 py-2 rounded-md border border-ink-600 text-ink-200 text-sm hover:bg-ink-700 hover:text-ink-50 transition-colors'
                : 'px-3.5 py-2 rounded-md bg-emerald-500 text-black text-sm hover:bg-emerald-400 transition-colors font-semibold'
            }
          >
            {status === 'completed' ? 'Mark as in progress' : 'Mark as completed'}
          </button>
        )}

        <div className="relative" ref={menuRef}>
          <button
            onClick={() => setMenuOpen((v) => !v)}
            className="px-3 py-2 rounded-md border border-ink-600 text-ink-200 text-sm hover:bg-ink-700 hover:text-ink-50 transition-colors"
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
                  onOpenDetails()
                }}
                className="w-full text-left px-3 py-2 text-ink-100 hover:bg-ink-700 transition-colors"
              >
                Project details…
              </button>
              {isSaved && (
                <>
                  <div className="border-t border-ink-600 my-1" />
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
                </>
              )}
              {lastSavedAt && (
                <div className="border-t border-ink-600 mt-1 px-3 py-2 text-[11px] text-ink-500">
                  Last saved {formatRelativeTime(lastSavedAt)}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
