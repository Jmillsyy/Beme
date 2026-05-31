import { forwardRef, useEffect, useState } from 'react'
import type { ProjectArea } from '../lib/projectStorage'

/**
 * Area tabs — a horizontal strip of named buckets the estimator uses to
 * organise their work inside a single project. Sits above the
 * WallTypesPanel in the right rail.
 *
 * Tabs visible from left to right:
 *   - **All** — always present, never deletable. Shows every wall in
 *     the project regardless of `areaId`. The active state when
 *     `activeAreaId` is null.
 *   - One tab per area in `areas`
 *   - **+ New area** at the end — opens an inline name input
 *
 * Pure presentation — owns no persistent state. The workspace controls
 * `activeAreaId` (transient UI state) and `areas` (saved on the
 * project). This component just renders + dispatches.
 *
 * Inline name editing: double-click an area tab to rename in place,
 * Enter to commit, Esc to cancel.
 */
export default function AreaTabs({
  areas,
  activeAreaId,
  onSelect,
  onCreate,
  onRename,
  onDelete,
}: {
  areas: ProjectArea[]
  /** null = the "All" tab is active. */
  activeAreaId: string | null
  onSelect: (areaId: string | null) => void
  /** Called with the new area's display name. Workspace generates the id,
   *  pushes onto `areas`, and switches activeAreaId to the new id. */
  onCreate: (name: string) => void
  onRename: (areaId: string, newName: string) => void
  /** Optional — when omitted, the per-tab × close button is hidden. */
  onDelete?: (areaId: string) => void
}) {
  const [creating, setCreating] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)

  const handleCreate = (name: string) => {
    const trimmed = name.trim()
    if (trimmed) onCreate(trimmed)
    setCreating(false)
  }

  return (
    <div
      className="flex items-center gap-1 px-2 py-1.5 bg-ink-800 border border-ink-600 rounded-lg overflow-x-auto select-none"
      role="tablist"
      aria-label="Project areas"
    >
      <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-500 px-1 flex-shrink-0">
        Area
      </span>

      <AreaButton
        label="All"
        active={activeAreaId === null}
        onClick={() => onSelect(null)}
      />

      {areas.map((area) =>
        editingId === area.id ? (
          <InlineNameInput
            key={area.id}
            initial={area.name}
            onCommit={(name) => {
              const t = name.trim()
              if (t && t !== area.name) onRename(area.id, t)
              setEditingId(null)
            }}
            onCancel={() => setEditingId(null)}
          />
        ) : (
          <AreaButton
            key={area.id}
            label={area.name}
            colorHex={area.colorHex}
            active={activeAreaId === area.id}
            onClick={() => onSelect(area.id)}
            onDoubleClick={() => setEditingId(area.id)}
            onDelete={onDelete ? () => onDelete(area.id) : undefined}
          />
        )
      )}

      {/* Primary action — promoted to brand orange + bumped size so it
         reads as a real call-to-action rather than a tertiary
         dashed-outline link. Matches the "+ Add" button styling
         used in WallTypesPanel / BrickTypesPanel. Clicking pops a
         focused modal instead of an inline input so the user isn't
         crammed into a 40px-wide field next to existing pills. */}
      <button
        type="button"
        onClick={() => setCreating(true)}
        className="flex-shrink-0 ml-auto h-7 px-3 rounded-lg text-xs font-medium bg-beme-500 text-black hover:bg-beme-400 transition-colors"
        title="Create a new area (e.g. Balcony, Staircase, Level 1)"
      >
        + New area
      </button>

      {creating && (
        <NewAreaModal
          existingNames={areas.map((a) => a.name.toLowerCase())}
          onCreate={handleCreate}
          onCancel={() => setCreating(false)}
        />
      )}
    </div>
  )
}

// ---------- Internal: NewAreaModal ----------

interface NewAreaModalProps {
  existingNames: string[]
  onCreate: (name: string) => void
  onCancel: () => void
}

/**
 * Small focused modal for creating a new area. Mirrors the
 * BrickTypeEditorModal pattern (fixed inset overlay, backdrop dismiss,
 * Esc to close) so creation flows across the workspace feel uniform.
 *
 * Auto-focuses the input. Enter submits, Esc cancels, backdrop click
 * cancels. Duplicate-name guard is case-insensitive — areas with the
 * same display name as an existing one are blocked because the tabs
 * would be indistinguishable in the row.
 */
function NewAreaModal({ existingNames, onCreate, onCancel }: NewAreaModalProps) {
  const [name, setName] = useState('')

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault()
        onCancel()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  const trimmed = name.trim()
  const isDuplicate =
    trimmed.length > 0 && existingNames.includes(trimmed.toLowerCase())
  const canCreate = trimmed.length > 0 && !isDuplicate

  function handleSubmit() {
    if (!canCreate) return
    onCreate(trimmed)
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={onCancel}
      role="dialog"
      aria-modal="true"
      aria-label="Create new area"
    >
      <div
        className="bg-ink-800 border border-ink-600 rounded-2xl shadow-2xl w-full max-w-sm flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="px-5 py-3 border-b border-ink-600 flex items-center justify-between bg-ink-900/40">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-ink-100">
              New area
            </h2>
            <p className="text-[11px] text-ink-500 mt-0.5">
              Group walls into named buckets — Balcony, Staircase, Level 1,
              Front facade. Walls drawn while an area is active get
              stamped with it.
            </p>
          </div>
          <button
            onClick={onCancel}
            className="text-ink-400 hover:text-ink-100 text-2xl leading-none px-2"
            aria-label="Close"
          >
            ×
          </button>
        </header>

        <div className="p-5">
          <label className="text-sm block">
            <span className="block text-ink-300 mb-1">Area name</span>
            <input
              type="text"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  handleSubmit()
                }
              }}
              placeholder="e.g. Balcony"
              className="w-full px-3 py-1.5 border border-ink-600 rounded-lg text-sm bg-ink-900 text-ink-50 focus:outline-none focus:border-beme-400"
            />
          </label>
          {isDuplicate && (
            <p className="text-[11px] text-rose-300 mt-2">
              An area called "{trimmed}" already exists. Pick a different
              name.
            </p>
          )}
        </div>

        <footer className="px-5 py-3 border-t border-ink-600 bg-ink-900/40 flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="px-4 py-1.5 rounded-lg border border-ink-600 text-ink-200 text-sm hover:bg-ink-700 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={!canCreate}
            className="px-4 py-1.5 rounded-lg bg-beme-500 text-black text-sm font-medium hover:bg-beme-400 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            Create area
          </button>
        </footer>
      </div>
    </div>
  )
}

/**
 * Single area chip. Active state mirrors the trade-rail chip styling so
 * the two control bars sit visually together. A small × button appears
 * when hovered (when delete handler provided) for non-All tabs.
 */
function AreaButton({
  label,
  colorHex,
  active,
  onClick,
  onDoubleClick,
  onDelete,
}: {
  label: string
  colorHex?: string
  active: boolean
  onClick: () => void
  onDoubleClick?: () => void
  onDelete?: () => void
}) {
  return (
    <span
      className="relative inline-flex items-center group flex-shrink-0"
    >
      <button
        type="button"
        role="tab"
        aria-selected={active}
        onClick={onClick}
        onDoubleClick={onDoubleClick}
        title={onDoubleClick ? `${label} · double-click to rename` : label}
        className={`flex items-center gap-1.5 h-6 px-2 rounded-md text-xs font-medium transition-colors ${
          active
            ? 'bg-beme-500/20 text-beme-300 ring-1 ring-beme-400'
            : 'text-ink-300 hover:bg-ink-700 hover:text-ink-100'
        }`}
      >
        {colorHex && (
          <span
            className="inline-block w-1.5 h-1.5 rounded-full flex-shrink-0"
            style={{ backgroundColor: colorHex }}
            aria-hidden
          />
        )}
        <span className="truncate max-w-[120px]">{label}</span>
      </button>
      {onDelete && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            if (window.confirm(`Delete area "${label}"? Walls in it become unassigned (still visible in All).`)) {
              onDelete()
            }
          }}
          title={`Delete ${label}`}
          aria-label={`Delete area ${label}`}
          className="ml-0.5 w-4 h-4 rounded text-ink-500 hover:bg-ink-700 hover:text-rose-300 opacity-0 group-hover:opacity-100 transition-opacity text-[11px] leading-none flex items-center justify-center"
        >
          ×
        </button>
      )}
    </span>
  )
}

/**
 * Inline-rename / inline-create input. Enter commits, Esc cancels,
 * blur commits. Re-uses the chip-sized footprint so the row height
 * doesn't jump when entering edit mode. forwardRef so the parent can
 * focus the create input the moment it appears.
 */
const InlineNameInput = forwardRef<
  HTMLInputElement,
  {
    initial: string
    placeholder?: string
    onCommit: (name: string) => void
    onCancel: () => void
  }
>(function InlineNameInput({ initial, placeholder, onCommit, onCancel }, ref) {
  const [value, setValue] = useState(initial)
  return (
    <input
      ref={ref}
      type="text"
      value={value}
      autoFocus
      placeholder={placeholder}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => onCommit(value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onCommit(value)
        else if (e.key === 'Escape') onCancel()
      }}
      className="h-6 px-2 rounded-md text-xs bg-ink-900 border border-beme-400 text-ink-50 focus:outline-none w-32 flex-shrink-0"
    />
  )
})
