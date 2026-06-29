import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useIsMobile } from '../lib/useIsMobile'
import type { ProjectDetails } from '../types/walls'
import type { ProjectStatus } from '../lib/projectStorage'

interface ProjectBarProps {
  details: ProjectDetails
  isSaved: boolean
  status: ProjectStatus
  lastSavedAt: string | null
  canSave: boolean
  saveBlockedReason: string | null
  /**
   * The estimate type for this workspace - shown as a small chip in the bar
   * so we don't need a separate page heading underneath. Optional so the bar
   * still renders for older flows that don't pass it.
   */
  mode?: 'block' | 'brick'
  /**
   * Display name of whoever first saved this project. Surfaced as a "Started
   * by {name}" pill on the right side of the bar so teammates can see at a
   * glance who picked up an estimate. Null hides the pill (unsaved project
   * or unknown author).
   */
  createdByDisplayName?: string | null
  /**
   * Six-digit reference number allocated server-side. Surfaced as a small
   * "#NNNNNN" pill next to the project title so it's at-hand for quoting
   * over the phone, copying into emails, or looking up later. Null hides
   * the pill (pre-save drafts that haven't been allocated a number yet).
   */
  referenceNumber?: number | null
  /** True while a save is in flight - drives the visible Saving… pill. */
  isSaving?: boolean
  onSave: () => void
  onToggleStatus: () => void
  onDelete: () => void
  onOpenDetails: () => void
  /**
   * Opens the export-estimate modal. Surfaces as a compact "Export"
   * button next to Save changes / Mark as completed so the user
   * doesn't have to scroll the right rail to find the export trigger.
   * Optional so callers that don't have an export flow (or are
   * rendering the bar pre-PDF-load) can omit it; the button hides
   * when the callback is missing.
   */
  onExport?: () => void
  /** Whether export is currently allowed (false → button disabled). */
  canExport?: boolean
}

/**
 * Render a 6-digit reference number as a zero-padded string. Used by the
 * pill in the bar and any tooltip / aria label. Bigger-than-6-digit values
 * (we won't hit this for a long time) just print as-is rather than
 * silently truncating.
 */
function formatReferenceNumber(n: number): string {
  return n >= 100000 ? `${n}` : n.toString().padStart(6, '0')
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
 * Compact dark top bar - the Studio Black theme header.
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
  // `createdByDisplayName` prop intentionally not destructured -
  // the "Started by <user>" pill it fed was removed from the bar
  // to keep the row single-line on narrow workspace columns.
  // Kept in the props interface so callers don't have to change.
  referenceNumber,
  isSaving = false,
  onSave,
  onToggleStatus,
  onDelete,
  onOpenDetails,
  onExport,
  canExport = false,
}: ProjectBarProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  // Brief celebratory "just saved" state. We watch lastSavedAt for a
  // change to a new non-null value - that's the most reliable signal
  // that a save actually succeeded (as opposed to isSaving going
  // false because the request errored out, which we don't want to
  // celebrate). On detection we flip justSaved to true, render a
  // green-pulse pill with a checkmark, then clear it 1.5s later so
  // the bar settles back into its neutral "Saved · 2m ago" timestamp
  // state. First render is a no-op: useRef seeds prev = lastSavedAt
  // so re-mounting on an already-saved project doesn't fire the
  // celebration.
  const prevLastSavedAt = useRef<string | null>(lastSavedAt)
  const [justSaved, setJustSaved] = useState(false)
  useEffect(() => {
    const prev = prevLastSavedAt.current
    prevLastSavedAt.current = lastSavedAt
    if (!lastSavedAt || lastSavedAt === prev) return
    setJustSaved(true)
    const timeout = setTimeout(() => setJustSaved(false), 1500)
    return () => clearTimeout(timeout)
  }, [lastSavedAt])

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

  // Status dot replaces the chip - same colour story, far less visual noise
  // when paired with the mode chip on the left.
  // Read-only mobile mode: hide the save + status-change actions on phones
  // (Export and back-to-dashboard stay, so it reads as a viewer).
  const isMobile = useIsMobile()
  const statusLabel = !isSaved ? 'Unsaved' : status === 'completed' ? 'Completed' : 'In progress'
  const statusDotClass = !isSaved
    ? 'bg-ink-500'
    : status === 'completed'
      ? 'bg-emerald-400'
      : 'bg-beme-400'

  // Save button gets the "saved Xm ago" info as a tooltip - it's the same
  // button you'd hit if it needed re-saving, so the timestamp belongs there.
  const saveTitle = (() => {
    if (!canSave) return saveBlockedReason ?? 'Cannot save yet'
    if (lastSavedAt) return `Last saved ${formatRelativeTime(lastSavedAt)}`
    return undefined
  })()

  return (
    // Full-width bar with px-4 so the back-to-dashboard pill, project
    // identity, and save actions sit with a small breathing gutter
    // from the workspace edges. Matches the workspace sticky
    // container below (px-4) so this bar and the canvas line up
    // edge-to-edge with the same gutter.
    // Wrapper is intentionally transparent + borderless so the bar
    // dissolves into the page background. Per-pill borders still give
    // each control a tappable shape, but there's no slab wash to
    // separate the bar from the workspace below.
    // Single-row layout: `flex-wrap` removed so the bar stays on one
    // line even when the expanded LeftNav has eaten into the main
    // column. The project identity button has its own max-w +
    // truncate so it shrinks gracefully when there isn't room for
    // every pill at full width.
    <div className="px-4 py-2 flex items-center gap-3 min-w-0">
      {/* LEFT - back-to-dashboard pill so the user can hop out of the
          workspace from anywhere. Request-breadcrumb is gone with the
          inbox flow; sharing a project is now a reference-number copy
          paste away. */}
      <Link
        to="/"
        className="inline-flex items-center gap-2 px-3.5 py-2 rounded-md border border-ink-600 text-sm text-ink-200 hover:bg-ink-700/40 hover:border-beme-500/50 hover:text-beme-300 transition-colors flex-shrink-0"
        title="Back to dashboard"
      >
        <span className="text-base leading-none">←</span>
        <span className="hidden md:inline">Dashboard</span>
      </Link>

      {/* SPACER - pushes the project identity + actions to the right. */}
      <div className="flex-1" />

      {/* RIGHT - project identity + actions, all matching pill sizes so the
          right side reads as one cohesive control cluster. The
          "Started by <user>" pill was dropped from this row - it was
          the first thing pushing the bar onto a second line when the
          LeftNav opened. Creator info still surfaces inside the
          project details drawer (click the project identity pill). */}
      <div className="flex items-center gap-2 flex-shrink min-w-0">
        <button
          onClick={onOpenDetails}
          className="inline-flex items-center gap-2 px-3.5 py-2 rounded-md border border-ink-600 group text-left text-sm hover:bg-ink-700/40 hover:border-beme-500/50 transition-colors min-w-0 flex-shrink"
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
          {typeof referenceNumber === 'number' && (
            <span
              className="text-[10px] px-1.5 py-0.5 rounded tabular-nums font-semibold text-ink-300 border border-ink-600"
              title={`Reference number - quote this when looking the project up. #${formatReferenceNumber(referenceNumber)}`}
            >
              #{formatReferenceNumber(referenceNumber)}
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
            <span className="text-ink-400 text-xs hidden xl:inline truncate max-w-[200px]">
              · {subtitle}
            </span>
          )}
        </button>
        {/* Save-status pill - visible at-a-glance feedback so the user
            doesn't have to hover the Save button or open the menu to see
            when the project last persisted. "Saving…" wins over a stale
            "Saved Xm ago" while the in-flight save is happening. */}
        {(isSaving || lastSavedAt) && (
          <span
            className={`hidden sm:inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] transition-colors duration-300 ${
              isSaving
                ? 'bg-beme-500/15 text-beme-300 border border-beme-500/30'
                : justSaved
                  ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/40'
                  : 'text-ink-400 border border-transparent'
            }`}
            aria-live="polite"
          >
            {isSaving && (
              <span
                className="inline-block w-1.5 h-1.5 rounded-full bg-beme-400 animate-pulse"
                aria-hidden
              />
            )}
            {!isSaving && justSaved && (
              // Animated checkmark - draws in over 350ms with a slight
              // scale pop so it reads as a beat of confirmation rather
              // than a static glyph that was always there.
              <svg
                width="11"
                height="11"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="beme-check-pop"
                aria-hidden
              >
                <path d="M3 8.5 L7 12.5 L13.5 4" />
              </svg>
            )}
            {isSaving
              ? 'Saving…'
              : justSaved
                ? 'Saved'
                : lastSavedAt
                  ? `Saved · ${formatRelativeTime(lastSavedAt)}`
                  : null}
          </span>
        )}
        {/* Wrapped in a span so the block reason still shows on hover when
            the button is DISABLED - browsers suppress `title` (and all
            pointer events) on disabled buttons, so without this the user
            gets a not-allowed cursor and no explanation of WHY they can't
            save. The span receives the hover instead and surfaces the
            saveBlockedReason. */}
        {!isMobile && (
        <span title={!canSave ? saveTitle : undefined} className="inline-flex">
          <button
            onClick={onSave}
            disabled={!canSave || isSaving}
            title={saveTitle}
            className="px-3.5 py-2 rounded-md bg-beme-500 text-black text-sm hover:bg-beme-400 disabled:opacity-40 disabled:cursor-not-allowed transition-colors font-semibold"
          >
            {isSaving ? 'Saving…' : isSaved ? 'Save changes' : 'Save'}
          </button>
        </span>
        )}

        {/* Top-level shortcut to flip the project status. Only shown once the
            project's actually been saved - there's nothing to mark complete
            before then. Green when moving in-progress → completed (the
            positive primary action). Muted when reverting completed → in
            progress so it doesn't visually shout for the less-common path.
            The same action also lives in the overflow menu for discovery. */}
        {!isMobile && isSaved && (
          <button
            onClick={onToggleStatus}
            title={
              status === 'completed'
                ? 'Reopen this project - moves it back to in progress.'
                : 'Mark this project complete - it moves to Recently Completed on the dashboard.'
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

        {/* Compact Export trigger. Sits to the right of Mark as
            completed so the row reads "write → status → export" -
            the export pill closes out the action cluster and is the
            user's last step before sending the estimate. Same modal
            as ever, controlled-open from PdfWorkspace. Hidden when
            no onExport is wired; disabled when there are no walls. */}
        {onExport && (
          <button
            onClick={onExport}
            disabled={!canExport}
            title={
              canExport
                ? 'Open the export estimate modal'
                : 'Draw at least one wall to enable export'
            }
            className="px-3.5 py-2 rounded-md bg-beme-500 text-black text-sm hover:bg-beme-400 disabled:opacity-40 disabled:cursor-not-allowed transition-colors font-semibold"
          >
            Export
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
