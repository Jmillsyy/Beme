import { useState, useMemo, useEffect } from 'react'
import type { BrickMakeup } from '../types/walls'
import { wallTypeColor } from '../lib/wallTypeColors'
import { confirm } from '../lib/confirm'

function generateMakeupId(): string {
  if (
    typeof crypto !== 'undefined' &&
    typeof crypto.randomUUID === 'function'
  ) {
    return crypto.randomUUID()
  }
  return `bm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Simplified brick wall types panel.
 *
 * Replaces the legacy BrickTypesPanel + BrickTypeEditorModal which
 * carried a stack of fields the product no longer surfaces (brick type
 * code, course composition, sill / head brick codes + orientations,
 * curved-radius pickers, etc.). The simplified shape is:
 *
 *   - Each wall type is just **name + height + straight/curved**.
 *   - No visual selection — every brick wall on the plan renders flat
 *     warm terracotta in 3D, the export shows area + lineal m only.
 *   - Cards show the colour the live canvas / 3D will use (palette-
 *     cycled per type so the user can tell different sections apart on
 *     the plan), but the colour is auto-assigned, not user-chosen.
 *
 * Per-area scoping mirrors the block side: the parent passes the area-
 * filtered makeups; the panel doesn't know about areas itself.
 */

const DEFAULT_BRICK_HEIGHT_MM = 2400

export default function BrickWallSettingsPanel({
  makeups,
  paletteMakeups,
  activeMakeupId,
  wallCountsByMakeupId,
  onSetActive,
  onAddMakeup,
  onUpdateMakeup,
  onDeleteMakeup,
}: {
  /** Area-scoped list of brick wall types to show as cards. */
  makeups: BrickMakeup[]
  /** Full project list — drives stable swatch colours across area
   *  filters so a wall type's colour doesn't change when the user
   *  switches between areas. */
  paletteMakeups: BrickMakeup[]
  activeMakeupId: string
  wallCountsByMakeupId: Record<string, number>
  onSetActive: (id: string) => void
  onAddMakeup: (makeup: BrickMakeup) => void
  onUpdateMakeup: (makeup: BrickMakeup) => void
  onDeleteMakeup: (id: string) => void
}) {
  const [expanded, setExpanded] = useState(true)
  const [editingId, setEditingId] = useState<string | null>(null)

  // Defensive: route every list read through these so a parent that
  // hands us undefined during a mid-load render doesn't crash the
  // workspace. Bug we hit during the wall-types rollout: brickMakeups
  // briefly read as undefined on the very first paint after project
  // load, taking the whole canvas down with a "Cannot read properties
  // of undefined (reading 'find')" error.
  const safeMakeups = makeups ?? []
  const safePalette = paletteMakeups ?? safeMakeups
  const safeCounts = wallCountsByMakeupId ?? {}

  const activeMakeup = useMemo(
    () => safeMakeups.find((m) => m.id === activeMakeupId),
    [safeMakeups, activeMakeupId],
  )
  const editingMakeup =
    editingId && editingId !== 'new'
      ? safeMakeups.find((m) => m.id === editingId) ?? null
      : null

  return (
    <div className="border border-ink-600 rounded-lg bg-ink-800 p-2">
      <div className="flex items-center justify-between mb-2 gap-2">
        <button
          onClick={() => setExpanded((v) => !v)}
          className="flex items-center gap-2 text-left flex-1 min-w-0 group"
        >
          <span className="text-ink-500 group-hover:text-ink-300 text-xs">
            {expanded ? '▾' : '▸'}
          </span>
          <h3 className="text-sm font-semibold text-ink-200 group-hover:text-beme-300">
            Brick wall types
          </h3>
          <span className="text-xs text-ink-400 truncate">
            {!expanded && activeMakeup ? (
              <>· {activeMakeup.name}</>
            ) : (
              <>· {safeMakeups.length}</>
            )}
          </span>
        </button>
        {expanded && (
          <button
            onClick={() => setEditingId('new')}
            className="text-xs px-2 py-1 rounded bg-beme-500 text-black font-medium hover:bg-beme-400 transition-colors flex-shrink-0"
          >
            + Add
          </button>
        )}
      </div>

      {expanded && (
        <div className="flex flex-col gap-1.5 pb-0.5">
          {safeMakeups.map((m) => {
            const isActive = m.id === activeMakeupId
            const wallCount = safeCounts[m.id] ?? 0
            const canDelete = safeMakeups.length > 1
            return (
              <button
                key={m.id}
                onClick={() => onSetActive(m.id)}
                className={`group/wt relative w-full p-2 rounded-md border text-left transition-colors ${
                  isActive
                    ? 'border-beme-500 ring-1 ring-beme-500/30 bg-beme-500/10'
                    : 'border-ink-600 hover:border-beme-500/50 bg-ink-700/40'
                }`}
              >
                {isActive && (
                  <span className="absolute top-1.5 right-1.5 text-[10px] px-1.5 py-0 rounded bg-beme-500 text-black font-medium leading-tight">
                    Active
                  </span>
                )}
                <div className="flex items-start gap-2 pr-12">
                  <span
                    className="inline-block text-[10px] px-1.5 py-0.5 rounded uppercase tracking-wider font-semibold flex-shrink-0 text-white ring-1 ring-black/30 leading-tight"
                    style={{
                      backgroundColor: wallTypeColor(m.id, safePalette),
                    }}
                    title="Plan colour for this wall type"
                  >
                    {m.kind === 'curved' ? 'Curved' : 'Wall'}
                  </span>
                  <div className="text-sm font-medium text-ink-100 break-words flex-1 min-w-0 leading-snug">
                    {m.name}
                  </div>
                </div>
                <div className="text-xs text-ink-400 mt-1 leading-tight">
                  {m.heightMm}mm · {wallCount} wall{wallCount === 1 ? '' : 's'}
                </div>
                <div
                  className={`flex gap-3 mt-1.5 transition-opacity ${
                    isActive
                      ? 'opacity-100'
                      : 'opacity-0 group-hover/wt:opacity-100'
                  }`}
                >
                  <span
                    role="button"
                    tabIndex={0}
                    onClick={(e) => {
                      e.stopPropagation()
                      setEditingId(m.id)
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        setEditingId(m.id)
                      }
                    }}
                    className="text-xs text-ink-300 hover:text-ink-100 hover:underline cursor-pointer"
                  >
                    Edit
                  </span>
                  <span
                    role="button"
                    tabIndex={0}
                    onClick={(e) => {
                      e.stopPropagation()
                      onAddMakeup({
                        ...m,
                        id: generateMakeupId(),
                        name: `${m.name} (copy)`,
                      })
                    }}
                    className="text-xs text-ink-300 hover:text-ink-100 hover:underline cursor-pointer"
                  >
                    Duplicate
                  </span>
                  {canDelete && (
                    <span
                      role="button"
                      tabIndex={0}
                      onClick={async (e) => {
                        e.stopPropagation()
                        const ok = await confirm({
                          title: `Delete brick wall type "${m.name}"?`,
                          message:
                            wallCount > 0
                              ? `${wallCount} wall${wallCount === 1 ? '' : 's'} on the plan will be removed with it.`
                              : 'This wall type isn\'t used by any walls.',
                          confirmLabel: 'Delete',
                          variant: 'destructive',
                        })
                        if (ok) onDeleteMakeup(m.id)
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          ;(e.currentTarget as HTMLElement).click()
                        }
                      }}
                      className="text-xs text-rose-400 hover:text-rose-300 hover:underline cursor-pointer ml-auto"
                    >
                      Delete
                    </span>
                  )}
                </div>
              </button>
            )
          })}
          {safeMakeups.length === 0 && (
            <p className="text-xs text-ink-400 italic px-1 py-2">
              No brick wall types yet — click <strong>+ Add</strong> to make
              one.
            </p>
          )}
        </div>
      )}

      {(editingId === 'new' || editingMakeup) && (
        <BrickWallTypeEditorModal
          existing={editingMakeup}
          onCancel={() => setEditingId(null)}
          onSave={(m) => {
            if (editingMakeup) onUpdateMakeup(m)
            else onAddMakeup(m)
            setEditingId(null)
          }}
        />
      )}
    </div>
  )
}

/**
 * Minimal brick wall type editor — name, height, straight/curved.
 *
 * That's intentionally everything. The old modal had three tabs
 * (Basics / Composition / Openings) carrying brick type codes, course
 * ranges, sill / head bricks and orientations — none of which survive
 * the simplification. Save returns a clean BrickMakeup with only the
 * fields the new model actually uses; legacy fields like
 * `brickTypeCode` are explicitly EMPTIED rather than carried through.
 */
function BrickWallTypeEditorModal({
  existing,
  onSave,
  onCancel,
}: {
  existing: BrickMakeup | null
  onSave: (makeup: BrickMakeup) => void
  onCancel: () => void
}) {
  const [name, setName] = useState(existing?.name ?? 'New brick wall type')
  const [heightMm, setHeightMm] = useState<number>(
    existing?.heightMm ?? DEFAULT_BRICK_HEIGHT_MM,
  )
  const [heightDraft, setHeightDraft] = useState<string>(String(heightMm))
  const [kind, setKind] = useState<'wall' | 'curved'>(existing?.kind ?? 'wall')

  // Esc to cancel.
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

  const commit = () => {
    const cleanName = name.trim() || 'New brick wall type'
    onSave({
      id: existing?.id ?? generateMakeupId(),
      name: cleanName,
      heightMm,
      kind,
      // Preserve the area scope so an edited type doesn't jump areas.
      // New types are stamped by the parent's handleAddBrickMakeup.
      areaId: existing?.areaId,
      // Single-spec brick model — no brick type, no composition, no
      // sill / head. Empty string keeps the field type-compatible
      // with the existing BrickMakeup shape until the type itself is
      // pruned in a later commit.
      brickTypeCode: '',
    })
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={onCancel}
      role="dialog"
      aria-modal="true"
      aria-label={existing ? 'Edit brick wall type' : 'New brick wall type'}
    >
      <div
        className="bg-ink-800 border border-ink-600 rounded-2xl shadow-2xl w-full max-w-sm flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="px-5 py-3 border-b border-ink-600 flex items-center justify-between bg-ink-900/40">
          <h2 className="text-base font-semibold text-ink-100">
            {existing ? 'Edit brick wall type' : 'New brick wall type'}
          </h2>
          <button
            onClick={onCancel}
            className="text-ink-400 hover:text-ink-100 text-2xl leading-none px-2"
            aria-label="Close"
          >
            ×
          </button>
        </header>

        <div className="px-5 py-4 space-y-3">
          <label className="block text-sm">
            <span className="block text-ink-300 mb-1">Name</span>
            <input
              type="text"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-3 py-1.5 border border-ink-600 rounded-lg text-sm bg-ink-900 text-ink-50 focus:outline-none focus:border-beme-400"
            />
          </label>

          <label className="block text-sm">
            <span className="block text-ink-300 mb-1">Height (mm)</span>
            <input
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              value={heightDraft}
              onChange={(e) => setHeightDraft(e.target.value)}
              onBlur={() => {
                const parsed = Number.parseInt(heightDraft, 10)
                if (Number.isFinite(parsed) && parsed > 0) {
                  setHeightMm(parsed)
                  setHeightDraft(String(parsed))
                } else {
                  setHeightDraft(String(heightMm))
                }
              }}
              className="w-full px-3 py-1.5 border border-ink-600 rounded-lg text-sm bg-ink-900 text-ink-50 focus:outline-none focus:border-beme-400"
            />
          </label>

          <fieldset className="block text-sm">
            <legend className="block text-ink-300 mb-1">Shape</legend>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setKind('wall')}
                className={`px-3 py-2 rounded-lg border text-sm transition-colors ${
                  kind === 'wall'
                    ? 'border-beme-500 bg-beme-500/10 text-ink-50'
                    : 'border-ink-600 bg-ink-900/40 text-ink-300 hover:border-ink-500'
                }`}
              >
                Straight
              </button>
              <button
                type="button"
                onClick={() => setKind('curved')}
                className={`px-3 py-2 rounded-lg border text-sm transition-colors ${
                  kind === 'curved'
                    ? 'border-beme-500 bg-beme-500/10 text-ink-50'
                    : 'border-ink-600 bg-ink-900/40 text-ink-300 hover:border-ink-500'
                }`}
              >
                Curved
              </button>
            </div>
          </fieldset>
        </div>

        <div className="px-5 py-3 border-t border-ink-600 flex items-center justify-end gap-2 bg-ink-900/40">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 rounded-lg border border-ink-600 text-sm text-ink-200 hover:bg-ink-700"
          >
            Cancel
          </button>
          <button
            onClick={commit}
            className="px-4 py-1.5 rounded-lg bg-beme-500 text-black text-sm font-medium hover:bg-beme-400"
          >
            {existing ? 'Save' : 'Add wall type'}
          </button>
        </div>
      </div>
    </div>
  )
}
