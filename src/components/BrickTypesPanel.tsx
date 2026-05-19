import { useMemo, useState } from 'react'
import type { BrickMakeup } from '../types/walls'
import { useBrickLibrary } from '../data/brickLibrary'
import { wallTypeColor } from '../lib/wallTypeColors'

interface BrickTypesPanelProps {
  makeups: BrickMakeup[]
  activeMakeupId: string
  wallCountsByMakeupId: Record<string, number>
  onSetActive: (id: string) => void
  onAddMakeup: (makeup: BrickMakeup) => void
  onUpdateMakeup: (makeup: BrickMakeup) => void
  onDeleteMakeup: (id: string) => void
}

function generateMakeupId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `bm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Mirrors WallTypesPanel but with the smaller field set brick walls need:
 * just a name, a brick type, and a default height. Brick ties and plascourse
 * are job-wide and stay in BrickSettingsPanel.
 *
 * Selecting a wall type sets it as active (drives newly-drawn brick walls)
 * and highlights every wall of that type on the page — same affordance as
 * the block wall types panel.
 */
export default function BrickTypesPanel({
  makeups,
  activeMakeupId,
  wallCountsByMakeupId,
  onSetActive,
  onAddMakeup,
  onUpdateMakeup,
  onDeleteMakeup,
}: BrickTypesPanelProps) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(true)
  const editingMakeup =
    editingId && editingId !== 'new' ? makeups.find((m) => m.id === editingId) : null
  const activeMakeup = makeups.find((m) => m.id === activeMakeupId)
  const orderedMakeups = useMemo(() => {
    if (!activeMakeup) return makeups
    return [activeMakeup, ...makeups.filter((m) => m.id !== activeMakeup.id)]
  }, [makeups, activeMakeup])

  return (
    <div className="my-4 border border-ink-600 rounded-xl bg-ink-800 p-3">
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
              <>· {makeups.length}</>
            )}
          </span>
        </button>
        {expanded && (
          <button
            onClick={() => setEditingId('new')}
            className="text-sm px-2.5 py-1 rounded-lg bg-beme-500 text-black font-medium hover:bg-beme-400 transition-colors flex-shrink-0"
          >
            + Add
          </button>
        )}
      </div>

      {expanded && (
        <div className="flex flex-col gap-2 pb-1">
          {editingId === 'new' && (
            <BrickTypeForm
              existing={null}
              onSave={(makeup) => {
                onAddMakeup(makeup)
                setEditingId(null)
              }}
              onCancel={() => setEditingId(null)}
            />
          )}
          {orderedMakeups.map((m) => {
            const isActive = m.id === activeMakeupId
            const wallCount = wallCountsByMakeupId[m.id] ?? 0
            const canDelete = makeups.length > 1 && wallCount === 0
            const isEditingThis = editingId === m.id
            return (
              <div key={m.id} className="flex flex-col gap-2">
                <button
                  onClick={() => onSetActive(m.id)}
                  className={`relative w-full p-2.5 rounded-lg border text-left transition-colors ${
                    isActive
                      ? 'border-beme-500 ring-2 ring-beme-500/20 bg-beme-500/10'
                      : 'border-ink-600 hover:border-beme-500/50 bg-ink-700/40'
                  }`}
                >
                  {isActive && (
                    <span className="absolute top-2 right-2 text-[11px] px-2 py-0.5 rounded bg-beme-500 text-black font-medium">
                      Active
                    </span>
                  )}
                  <div className="flex items-start gap-2 mb-1 pr-12">
                    <span
                      className="inline-block w-3 h-3 rounded-sm flex-shrink-0 ring-1 ring-black/30 mt-0.5"
                      style={{ backgroundColor: wallTypeColor(m.id, makeups) }}
                      aria-hidden
                    />
                    {/* Wrap the name onto multiple lines rather than truncate —
                        the name is the identity of this entry, so the user
                        always wants it in full even if the card grows taller. */}
                    <div className="text-sm font-medium text-ink-100 break-words flex-1 min-w-0">
                      {m.name}
                    </div>
                  </div>
                  <div className="text-xs text-ink-400">
                    {m.heightMm}mm · brick {m.brickTypeCode || 'project default'}
                  </div>
                  <div className="text-xs text-ink-500 mt-2">
                    {wallCount} wall{wallCount === 1 ? '' : 's'} using this
                  </div>
                  <div className="flex gap-3 mt-2">
                    <span
                      role="button"
                      tabIndex={0}
                      onClick={(e) => {
                        e.stopPropagation()
                        setEditingId(isEditingThis ? null : m.id)
                      }}
                      className="text-xs text-beme-400 hover:text-beme-300 hover:underline cursor-pointer"
                    >
                      {isEditingThis ? 'Close' : 'Edit'}
                    </span>
                    {canDelete && (
                      <span
                        role="button"
                        tabIndex={0}
                        onClick={(e) => {
                          e.stopPropagation()
                          if (window.confirm(`Delete brick wall type "${m.name}"?`)) {
                            onDeleteMakeup(m.id)
                          }
                        }}
                        className="text-xs text-rose-400 hover:text-rose-300 hover:underline cursor-pointer"
                      >
                        Delete
                      </span>
                    )}
                  </div>
                </button>
                {isEditingThis && (
                  <BrickTypeForm
                    existing={editingMakeup}
                    onSave={(makeup) => {
                      onUpdateMakeup(makeup)
                      setEditingId(null)
                    }}
                    onCancel={() => setEditingId(null)}
                  />
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ---------- Internal: BrickTypeForm ----------

interface BrickTypeFormProps {
  existing: BrickMakeup | null
  onSave: (makeup: BrickMakeup) => void
  onCancel: () => void
}

function BrickTypeForm({ existing, onSave, onCancel }: BrickTypeFormProps) {
  const { library } = useBrickLibrary()
  const brickTypes = useMemo(
    () => Object.values(library).sort((a, b) => a.heightMm - b.heightMm),
    [library]
  )

  const [name, setName] = useState(existing?.name ?? 'New brick type')
  const [heightMm, setHeightMm] = useState<number>(existing?.heightMm ?? 2400)
  const [brickTypeCode, setBrickTypeCode] = useState<string>(existing?.brickTypeCode ?? '')

  function handleSave() {
    const id = existing?.id ?? generateMakeupId()
    onSave({
      id,
      name: name.trim() || 'New brick type',
      heightMm,
      brickTypeCode,
    })
  }

  const canSave = name.trim().length > 0 && heightMm >= 200

  return (
    <div className="mt-4 p-4 border border-ink-600 rounded-lg bg-ink-700/40">
      <h4 className="text-sm font-semibold mb-3 text-ink-200">
        {existing ? `Edit "${existing.name}"` : 'New brick wall type'}
      </h4>
      <div className="grid grid-cols-1 gap-4">
        <label className="text-sm">
          <span className="block text-ink-300 mb-1">Name</span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Facework, Rendered"
            className="w-full px-3 py-1.5 border border-ink-600 rounded-lg text-sm focus:outline-none focus:border-beme-400"
          />
        </label>
        <label className="text-sm">
          <span className="block text-ink-300 mb-1">Height (mm)</span>
          <input
            type="number"
            min="200"
            step="50"
            value={heightMm}
            onChange={(e) => setHeightMm(parseInt(e.target.value || '0', 10))}
            className="w-full px-3 py-1.5 border border-ink-600 rounded-lg text-sm focus:outline-none focus:border-beme-400"
          />
        </label>
        <label className="text-sm">
          <span className="block text-ink-300 mb-1">Brick type</span>
          <select
            value={brickTypeCode}
            onChange={(e) => setBrickTypeCode(e.target.value)}
            className="w-full px-3 py-1.5 border border-ink-600 rounded-lg text-sm bg-ink-800 focus:outline-none focus:border-beme-400"
          >
            <option value="">Use project default</option>
            {brickTypes.map((t) => (
              <option key={t.code} value={t.code}>
                {t.name} ({t.heightMm}mm tall)
              </option>
            ))}
          </select>
          <span className="text-[11px] text-ink-400 mt-1 block">
            Override the project-level brick type for walls of this category, or leave blank to use
            the project default from Brick settings.
          </span>
        </label>
      </div>

      <div className="flex gap-2 mt-5">
        <button
          onClick={handleSave}
          disabled={!canSave}
          className="px-4 py-1.5 rounded-lg bg-beme-600 text-white text-sm hover:bg-beme-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors font-medium"
        >
          {existing ? 'Save changes' : 'Create brick wall type'}
        </button>
        <button
          onClick={onCancel}
          className="px-4 py-1.5 rounded-lg border border-ink-600 text-sm hover:bg-ink-700 transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}
