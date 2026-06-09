import { useEffect, useState } from 'react'
import type { ProjectArea } from '../lib/projectStorage'
import { confirm } from '../lib/confirm'

/**
 * Area selector — collapsible panel that matches the chrome of the
 * WallTypesPanel / SupplyItemsPanel directly below it. Same outer
 * container (border + rounded + padded), same header pattern (chevron
 * + title + active-name caption), same inline expansion (the list of
 * areas drops down INSIDE the panel rather than as a floating menu).
 *
 * Why panel-style instead of a dropdown:
 *   - Sits in the same column as Wall types / Supply items. A floating
 *     dropdown looked like a button rather than a section, so users
 *     didn't see it as part of the right-rail grouping.
 *   - Inline expansion stacks nicely with the panels below (no
 *     overlap, no z-index fights).
 *
 * Inside, when expanded:
 *   - **All areas** row at the top (selects null = show every area).
 *   - One row per area, with colour dot + hover-revealed rename ✎ /
 *     delete × buttons.
 *   - "+ New area" button at the bottom of the list.
 *
 * Pure presentation — workspace owns `activeAreaId` (per-session) and
 * `areas` (project-persisted); this component just renders + dispatches.
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
  /** Called with the new area's display name + a flag indicating whether
   *  to clone the walls from the current view into the new area.
   *  Workspace generates the id, pushes onto `areas`, and switches
   *  activeAreaId to the new id. When `copyWalls` is true the workspace
   *  also clones every wall currently visible (geometry only — new ids,
   *  new makeup) into the new area. */
  onCreate: (name: string, copyWalls: boolean) => void
  onRename: (areaId: string, newName: string) => void
  /** Optional — when omitted, the per-row × delete button is hidden. */
  onDelete?: (areaId: string) => void
}) {
  // expanded = panel body visible; editingId = Edit area modal pre-filled
  // with that area's name. Defaults to EXPANDED so the user sees the area
  // list on first load — same default as SupplyItemsPanel. The legacy
  // "creating" modal flow was retired in favour of one-click create with
  // an auto-numbered default name ("New Area 2", "New Area 3"…) — users
  // rename via the existing ✎ affordance if they want a custom label.
  const [expanded, setExpanded] = useState(true)
  const [editingId, setEditingId] = useState<string | null>(null)
  // creating = small modal asking whether to start fresh or clone the
  // existing walls into the new area. Holds the resolved default name
  // so it can be passed back to onCreate when the user picks.
  const [creating, setCreating] = useState<{ name: string } | null>(null)
  const editingArea = editingId
    ? areas.find((a) => a.id === editingId) ?? null
    : null

  // handleCreate retired with the create modal — "+ New area" now
  // calls onCreate(nextDefaultAreaName()) directly. Rename / edit
  // still flows through handleRename + the AreaNameModal in 'edit'
  // mode below.

  /**
   * Resolve the next default name for "+ New area".
   *
   *   - No existing area called "New Area" → use "New Area".
   *   - "New Area" exists, no "New Area 2" → use "New Area 2".
   *   - Highest suffix is N → use "New Area (N+1)".
   *
   * Comparison is case-insensitive against trimmed names so a manually-
   * renamed "new area" still collides cleanly. Gaps are allowed
   * (renaming "New Area 2" to "Balcony" leaves "New Area 3" as the
   * next slot, since N+1 anchors on the max suffix not the count).
   */
  const nextDefaultAreaName = () => {
    const norm = (s: string) => s.trim().toLowerCase()
    const names = areas.map((a) => norm(a.name))
    if (!names.includes('new area')) return 'New Area'
    let maxN = 1
    for (const n of names) {
      const m = n.match(/^new area\s+(\d+)$/)
      if (m) {
        const num = parseInt(m[1], 10)
        if (Number.isFinite(num) && num > maxN) maxN = num
      }
    }
    return `New Area ${maxN + 1}`
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
    <div className="border border-ink-600 rounded-xl bg-ink-800 p-3">
      <div className="flex items-center gap-2 min-w-0">
        <button
          onClick={() => setExpanded((v) => !v)}
          className="flex items-center gap-2 text-left group flex-1 min-w-0"
          aria-expanded={expanded}
        >
          <span className="text-ink-500 group-hover:text-ink-300 text-xs flex-shrink-0">
            {expanded ? '▾' : '▸'}
          </span>
          {expanded ? (
            // Expanded — small "Area · <name>" header, since the area
            // list below already shows the active row prominently. Keeps
            // the chrome compact and matches Wall Types / Supply Items.
            <>
              <h3 className="text-sm font-semibold text-ink-200 group-hover:text-beme-300 flex-shrink-0">
                Area
              </h3>
              {activeArea?.colorHex && (
                <span
                  className="inline-block w-2 h-2 rounded-full flex-shrink-0"
                  style={{ backgroundColor: activeArea.colorHex }}
                  aria-hidden
                />
              )}
              <span className="text-xs text-ink-400 truncate min-w-0">
                · {activeLabel}
              </span>
            </>
          ) : (
            // Collapsed — promote the area name to the title since this
            // is the only place it's visible. Tiny "Area" eyebrow above
            // keeps the section label without stealing weight from the
            // name. User asked specifically for a bigger title here so
            // they can tell at a glance which area they're working in.
            <>
              {activeArea?.colorHex && (
                <span
                  className="inline-block w-2.5 h-2.5 rounded-full flex-shrink-0"
                  style={{ backgroundColor: activeArea.colorHex }}
                  aria-hidden
                />
              )}
              <div className="flex flex-col min-w-0 leading-tight">
                <span className="text-[10px] uppercase tracking-wider text-ink-500 group-hover:text-ink-400">
                  Area
                </span>
                <span className="text-base font-semibold text-ink-100 group-hover:text-beme-300 truncate">
                  {activeLabel}
                </span>
              </div>
            </>
          )}
        </button>
      </div>

      {expanded && (
        <div
          role="listbox"
          aria-label="Project areas"
          className="mt-2 space-y-0.5"
        >
          {/* "All areas" pseudo-row only makes sense when there's more
              than one area to span — with a single area it's just a
              redundant duplicate of that one area's view. Hidden
              entirely (along with the divider that separates it from
              the area list) when areas.length < 2. */}
          {areas.length >= 2 && (
            <>
              <AreaMenuRow
                label="All areas"
                active={activeAreaId === null}
                onSelect={() => onSelect(null)}
              />
              <div className="border-t border-ink-700 my-1" />
            </>
          )}
          {areas.map((area) => (
            <AreaMenuRow
              key={area.id}
              label={area.name}
              colorHex={area.colorHex}
              active={activeAreaId === area.id}
              onSelect={() => onSelect(area.id)}
              onRename={() => setEditingId(area.id)}
              onDelete={
                onDelete
                  ? async () => {
                      const ok = await confirm({
                        title: `Delete area "${area.name}"?`,
                        message:
                          'Walls in this area become unassigned but stay ' +
                          'visible in the All tab. The area itself is removed.',
                        confirmLabel: 'Delete area',
                        variant: 'destructive',
                      })
                      if (ok) onDelete(area.id)
                    }
                  : undefined
              }
            />
          ))}
          <div className="border-t border-ink-700 my-1" />
          {/* One-click create: skips the modal and creates an area
              with the next auto-numbered "New Area N" name. Rename
              via the row's ✎ button if a custom label is wanted —
              the rename modal is still present below. */}
          <button
            type="button"
            onClick={() => setCreating({ name: nextDefaultAreaName() })}
            className="w-full text-left px-2 py-1.5 text-xs font-medium text-beme-300 hover:bg-ink-700 rounded-md transition-colors"
          >
            + New area
          </button>
        </div>
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
      {creating && (
        <AreaCreateChoiceModal
          name={creating.name}
          onChoose={(copyWalls) => {
            const pending = creating
            setCreating(null)
            onCreate(pending.name, copyWalls)
          }}
          onCancel={() => setCreating(null)}
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
      className={`group relative flex items-center gap-2 px-2 py-1.5 rounded-md text-xs cursor-pointer transition-colors ${
        active
          ? 'bg-beme-500/15 text-beme-300 ring-1 ring-beme-500/30'
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

// ---------- Internal: AreaCreateChoiceModal ----------

/**
 * Two-option dialog shown when the user adds a new area. Picks
 * whether the new area should:
 *   - Start fresh (empty — current behaviour, the canvas clears
 *     down to just the new area's walls which is zero).
 *   - Copy current walls — clones every wall currently visible in
 *     the active view (active-area or All) into the new area as a
 *     starting point. Geometry only; new ids, new makeup. Useful
 *     when a building plan repeats per-floor (Ground Floor → First
 *     Floor with the same layout).
 *
 * Mirrors the existing AreaNameModal shell so the area-creation
 * flows feel uniform. Esc / backdrop click cancels.
 */
function AreaCreateChoiceModal({
  name,
  onChoose,
  onCancel,
}: {
  name: string
  onChoose: (copyWalls: boolean) => void
  onCancel: () => void
}) {
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

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={onCancel}
      role="dialog"
      aria-modal="true"
      aria-label="New area"
    >
      <div
        className="bg-ink-800 border border-ink-600 rounded-2xl shadow-2xl w-full max-w-sm flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="px-5 py-3 border-b border-ink-600 flex items-center justify-between bg-ink-900/40">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-ink-100">New area</h2>
            <p className="text-[11px] text-ink-500 mt-0.5 truncate">
              Creating <span className="text-ink-300">{name}</span>
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

        <div className="p-5 space-y-3">
          <button
            type="button"
            onClick={() => onChoose(false)}
            className="w-full text-left rounded-lg border border-ink-600 hover:border-beme-500 bg-ink-900/40 hover:bg-ink-700/40 transition-colors px-4 py-3"
          >
            <div className="text-sm font-semibold text-ink-50">Start fresh</div>
            <div className="text-xs text-ink-400 mt-1 leading-relaxed">
              Empty canvas. Draw walls from scratch — none of your existing
              walls are copied over.
            </div>
          </button>
          <button
            type="button"
            onClick={() => onChoose(true)}
            className="w-full text-left rounded-lg border border-ink-600 hover:border-beme-500 bg-ink-900/40 hover:bg-ink-700/40 transition-colors px-4 py-3"
          >
            <div className="text-sm font-semibold text-ink-50">Copy existing walls</div>
            <div className="text-xs text-ink-400 mt-1 leading-relaxed">
              Clone every wall currently on screen into this new area. Same
              geometry, fresh wall types. Useful when the layout repeats
              (e.g. ground floor → first floor).
            </div>
          </button>
        </div>
      </div>
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
