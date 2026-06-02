import { useEffect, useRef, useState } from 'react'
import type { ProjectArea } from '../lib/projectStorage'

/**
 * Area selector — single 'Area: <name> ▾' button that opens a dropdown
 * menu listing every area on the project. Replaces the older horizontal
 * tabs strip; same external props so callers (PdfWorkspace) don't have
 * to change.
 *
 * Menu contents:
 *   - **All** — always at the top, never deletable. Active state when
 *     activeAreaId is null.
 *   - One row per area (with its colour dot, name, hover-revealed
 *     rename ✎ and delete × buttons).
 *   - A divider, then **+ New area** at the bottom.
 *
 * Rationale for the change:
 *   - Projects routinely have 5+ areas (Front, Back, Garage, Alfresco,
 *     Granny flat, …). The pills strip overflowed and made selection
 *     mouseable but not great with a long list.
 *   - A dropdown keeps the chrome tiny, surfaces every area in a
 *     single scrollable column, and the rename / delete affordances
 *     stay one click away on hover.
 *
 * Pure presentation — owns no persistent state. The workspace owns
 * `activeAreaId` (per-session) and `areas` (project-persisted); this
 * component just renders + dispatches.
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
  /** null = the "All" view. */
  activeAreaId: string | null
  onSelect: (areaId: string | null) => void
  /** Called with the new area's display name. Workspace generates the id,
   *  pushes onto `areas`, and switches activeAreaId to the new id. */
  onCreate: (name: string) => void
  onRename: (areaId: string, newName: string) => void
  /** Optional — when omitted, the per-row × delete button is hidden. */
  onDelete?: (areaId: string) => void
}) {
  // open = dropdown visible; creating = New area modal; editingId = Edit
  // area modal pre-filled with that area's name.
  const [open, setOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const editingArea = editingId
    ? areas.find((a) => a.id === editingId) ?? null
    : null

  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)

  // Close on outside click + Escape — same pattern as project menus
  // elsewhere in the workspace. Modals (rename / new) stop propagation
  // so the menu doesn't close from under them.
  useEffect(() => {
    if (!open) return
    function onPointer(e: MouseEvent) {
      const t = e.target as Node
      if (
        buttonRef.current?.contains(t) ||
        menuRef.current?.contains(t)
      ) {
        return
      }
      setOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onPointer)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onPointer)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  const handleCreate = (name: string) => {
    const trimmed = name.trim()
    if (trimmed) onCreate(trimmed)
    setCreating(false)
    setOpen(false)
  }

  const handleRename = (id: string, name: string) => {
    const trimmed = name.trim()
    const existing = areas.find((a) => a.id === id)
    if (trimmed && existing && trimmed !== existing.name) {
      onRename(id, trimmed)
    }
    setEditingId(null)
  }

  const existingNamesFor = (excludeId: string | null) =>
    areas
      .filter((a) => a.id !== excludeId)
      .map((a) => a.name.toLowerCase())

  const activeArea = activeAreaId
    ? areas.find((a) => a.id === activeAreaId) ?? null
    : null
  const activeLabel = activeArea?.name ?? 'All areas'

  return (
    <div className="relative inline-block">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        // Match the canvas-side toolbar buttons (px-3 py-1.5 text-sm
        // rounded-lg) so the area selector sits flush with them on the
        // same horizontal line.
        className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-ink-800 border border-ink-600 text-sm text-ink-100 hover:bg-ink-700 transition-colors min-w-[180px]"
      >
        <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-500">
          Area
        </span>
        {activeArea?.colorHex && (
          <span
            className="inline-block w-2 h-2 rounded-full"
            style={{ backgroundColor: activeArea.colorHex }}
            aria-hidden
          />
        )}
        <span className="truncate flex-1 text-left">{activeLabel}</span>
        <span className="text-ink-500 text-xs">▾</span>
      </button>

      {open && (
        <div
          ref={menuRef}
          role="listbox"
          aria-label="Project areas"
          className="absolute z-40 mt-1 w-64 max-h-[60vh] overflow-y-auto rounded-lg border border-ink-600 bg-ink-800 shadow-xl shadow-black/40 py-1 text-sm"
        >
          <AreaMenuRow
            label="All areas"
            active={activeAreaId === null}
            onSelect={() => {
              onSelect(null)
              setOpen(false)
            }}
          />
          {areas.length > 0 && (
            <div className="border-t border-ink-700 my-1" />
          )}
          {areas.map((area) => (
            <AreaMenuRow
              key={area.id}
              label={area.name}
              colorHex={area.colorHex}
              active={activeAreaId === area.id}
              onSelect={() => {
                onSelect(area.id)
                setOpen(false)
              }}
              onRename={() => {
                setEditingId(area.id)
              }}
              onDelete={
                onDelete
                  ? () => {
                      if (
                        window.confirm(
                          `Delete area "${area.name}"? Walls in it become unassigned (still visible in All).`
                        )
                      ) {
                        onDelete(area.id)
                      }
                    }
                  : undefined
              }
            />
          ))}
          <div className="border-t border-ink-700 my-1" />
          <button
            type="button"
            onClick={() => {
              setCreating(true)
            }}
            className="w-full text-left px-3 py-1.5 text-xs font-medium text-beme-300 hover:bg-ink-700 transition-colors"
          >
            + New area
          </button>
        </div>
      )}

      {creating && (
        <AreaNameModal
          mode="create"
          initialName=""
          existingNames={existingNamesFor(null)}
          onSubmit={handleCreate}
          onCancel={() => setCreating(false)}
        />
      )}
      {editingArea && (
        <AreaNameModal
          mode="edit"
          initialName={editingArea.name}
          existingNames={existingNamesFor(editingArea.id)}
          onSubmit={(name) => handleRename(editingArea.id, name)}
          onCancel={() => setEditingId(null)}
        />
      )}
    </div>
  )
}

// ---------- Internal: dropdown row with rename / delete affordances ----

function AreaMenuRow({
  label,
  colorHex,
  active,
  onSelect,
  onRename,
  onDelete,
}: {
  label: string
  colorHex?: string
  active: boolean
  onSelect: () => void
  onRename?: () => void
  onDelete?: () => void
}) {
  return (
    <div
      className={`group relative flex items-center gap-2 px-3 py-1.5 text-xs cursor-pointer ${
        active
          ? 'bg-beme-500/15 text-beme-300'
          : 'text-ink-100 hover:bg-ink-700'
      }`}
      onClick={onSelect}
      role="option"
      aria-selected={active}
    >
      {colorHex ? (
        <span
          className="inline-block w-1.5 h-1.5 rounded-full flex-shrink-0"
          style={{ backgroundColor: colorHex }}
          aria-hidden
        />
      ) : (
        <span className="inline-block w-1.5 h-1.5 flex-shrink-0" />
      )}
      <span className="flex-1 truncate">{label}</span>
      {onRename && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onRename()
          }}
          title={`Rename ${label}`}
          aria-label={`Rename area ${label}`}
          className="w-5 h-5 rounded text-ink-500 hover:bg-ink-600 hover:text-beme-300 opacity-0 group-hover:opacity-100 transition-opacity text-[11px] leading-none flex items-center justify-center"
        >
          ✎
        </button>
      )}
      {onDelete && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onDelete()
          }}
          title={`Delete ${label}`}
          aria-label={`Delete area ${label}`}
          className="w-5 h-5 rounded text-ink-500 hover:bg-ink-600 hover:text-rose-300 opacity-0 group-hover:opacity-100 transition-opacity text-[11px] leading-none flex items-center justify-center"
        >
          ×
        </button>
      )}
    </div>
  )
}

// ---------- Internal: AreaNameModal (create + edit) ----------

interface AreaNameModalProps {
  mode: 'create' | 'edit'
  initialName: string
  existingNames: string[]
  onSubmit: (name: string) => void
  onCancel: () => void
}

/**
 * Small focused modal used for both creating and renaming an area.
 * Mirrors the WallTypeEditorModal / BrickTypeEditorModal pattern
 * (fixed inset overlay, backdrop dismiss, Esc to close) so naming
 * flows across the workspace feel uniform.
 *
 * Duplicate-name guard is case-insensitive. In edit mode the area's
 * OWN current name is excluded from the duplicate check so saving an
 * unchanged name isn't blocked.
 */
function AreaNameModal({
  mode,
  initialName,
  existingNames,
  onSubmit,
  onCancel,
}: AreaNameModalProps) {
  const [name, setName] = useState(initialName)

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
  const isUnchanged = mode === 'edit' && trimmed === initialName.trim()
  const canSubmit = trimmed.length > 0 && !isDuplicate && !isUnchanged

  function handleSubmit() {
    if (!canSubmit) return
    onSubmit(trimmed)
  }

  const title = mode === 'create' ? 'New area' : 'Edit area'
  const explainer =
    mode === 'create'
      ? 'Group walls into named buckets — Balcony, Staircase, Level 1, Front facade. Walls drawn while an area is active get stamped with it.'
      : 'Rename this area. Walls assigned to it stay assigned — only the label changes.'
  const submitLabel = mode === 'create' ? 'Create area' : 'Save changes'

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={onCancel}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div
        className="bg-ink-800 border border-ink-600 rounded-2xl shadow-2xl w-full max-w-sm flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="px-5 py-3 border-b border-ink-600 flex items-center justify-between bg-ink-900/40">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-ink-100">{title}</h2>
            <p className="text-[11px] text-ink-500 mt-0.5">{explainer}</p>
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
            disabled={!canSubmit}
            className="px-4 py-1.5 rounded-lg bg-beme-500 text-black text-sm font-medium hover:bg-beme-400 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {submitLabel}
          </button>
        </footer>
      </div>
    </div>
  )
}
