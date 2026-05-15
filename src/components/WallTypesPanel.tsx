import { useState } from 'react'
import type { WallMakeup, BondType, CourseOverride } from '../types/walls'
import type { BlockCode } from '../types/blocks'
import { BLOCK_LIBRARY } from '../data/blockLibrary'

interface WallTypesPanelProps {
  makeups: WallMakeup[]
  activeMakeupId: string
  wallCountsByMakeupId: Record<string, number>
  onSetActive: (id: string) => void
  onAddMakeup: (makeup: WallMakeup) => void
  onUpdateMakeup: (makeup: WallMakeup) => void
  onDeleteMakeup: (id: string) => void
}

function generateMakeupId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** All block codes available in dropdowns. Excludes the cleanout tile (it's only valid in the tile slot). */
const SELECTABLE_BLOCKS: BlockCode[] = Object.values(BLOCK_LIBRARY)
  .filter((b) => b.code !== '50.45')
  .map((b) => b.code)
  .sort()

const TILE_BLOCKS: BlockCode[] = ['50.45']

function blockLabel(code: BlockCode): string {
  const b = BLOCK_LIBRARY[code]
  return b ? `${code} — ${b.name}` : code
}

export default function WallTypesPanel({
  makeups,
  activeMakeupId,
  wallCountsByMakeupId,
  onSetActive,
  onAddMakeup,
  onUpdateMakeup,
  onDeleteMakeup,
}: WallTypesPanelProps) {
  /** null = no form; 'new' = adding; otherwise = editing makeup with this id */
  const [editingId, setEditingId] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(true)

  const editingMakeup =
    editingId && editingId !== 'new' ? makeups.find((m) => m.id === editingId) : null

  const activeMakeup = makeups.find((m) => m.id === activeMakeupId)

  return (
    <div className="my-4 border border-neutral-200 rounded-xl bg-white p-4">
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <div className="flex items-center gap-3">
          <h3 className="text-sm font-semibold text-neutral-700">Wall types</h3>
          {!expanded && activeMakeup && (
            <span className="text-xs text-neutral-500">
              Active: <span className="font-medium text-neutral-700">{activeMakeup.name}</span> ·{' '}
              {makeups.length} total
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          {expanded && (
            <button
              onClick={() => setEditingId('new')}
              className="text-sm px-3 py-1 rounded-lg bg-beme-600 text-white hover:bg-beme-700 transition-colors"
            >
              + Add wall type
            </button>
          )}
          <button
            onClick={() => setExpanded((v) => !v)}
            className="text-sm text-beme-600 hover:text-beme-700 hover:underline"
          >
            {expanded ? '− Hide' : '+ Show'}
          </button>
        </div>
      </div>

      {expanded && (
        <>
      <div className="flex gap-3 overflow-x-auto pb-2">
        {makeups.map((m) => {
          const isActive = m.id === activeMakeupId
          const wallCount = wallCountsByMakeupId[m.id] ?? 0
          const canDelete = makeups.length > 1 && wallCount === 0
          return (
            <button
              key={m.id}
              onClick={() => onSetActive(m.id)}
              className={`relative flex-shrink-0 w-64 p-3 rounded-lg border text-left transition-colors ${
                isActive
                  ? 'border-blue-500 ring-2 ring-blue-200 bg-blue-50'
                  : 'border-neutral-200 hover:border-blue-300 bg-white'
              }`}
            >
              {isActive && (
                <span className="absolute top-2 right-2 text-xs px-2 py-0.5 rounded bg-blue-600 text-white font-medium">
                  Active
                </span>
              )}
              <div className="text-sm font-medium text-neutral-800 mb-1 pr-12 truncate">{m.name}</div>
              <div className="text-xs text-neutral-500">
                {m.bondType} bond · {m.heightMm}mm ·{' '}
                {m.cornerBlockCode === '20.21' ? 'knockout corners' : 'standard corners'} ·{' '}
                fractions {m.useFractions ? 'on' : 'off'}
              </div>
              <div className="text-xs text-neutral-500 mt-1 font-mono">
                Base {m.baseCourseBlockCode}
                {m.baseCourseTileCode ? `+${m.baseCourseTileCode}` : ''} · Body {m.bodyBlockCode} · Top{' '}
                {m.topCourseBlockCode}
              </div>
              {m.courseOverrides && m.courseOverrides.length > 0 && (
                <div className="text-xs text-neutral-500 mt-1">
                  {m.courseOverrides.length} course override
                  {m.courseOverrides.length === 1 ? '' : 's'}
                </div>
              )}
              <div className="text-xs text-neutral-400 mt-2">
                {wallCount} wall{wallCount === 1 ? '' : 's'} using this
              </div>
              <div className="flex gap-3 mt-2">
                <span
                  role="button"
                  tabIndex={0}
                  onClick={(e) => {
                    e.stopPropagation()
                    setEditingId(m.id)
                  }}
                  className="text-xs text-beme-600 hover:text-beme-700 hover:underline cursor-pointer"
                >
                  Edit
                </span>
                {canDelete && (
                  <span
                    role="button"
                    tabIndex={0}
                    onClick={(e) => {
                      e.stopPropagation()
                      if (window.confirm(`Delete wall type "${m.name}"?`)) {
                        onDeleteMakeup(m.id)
                      }
                    }}
                    className="text-xs text-red-600 hover:text-red-700 hover:underline cursor-pointer"
                  >
                    Delete
                  </span>
                )}
              </div>
            </button>
          )
        })}
      </div>

      {editingId !== null && (
        <WallTypeForm
          existing={editingMakeup}
          onSave={(makeup) => {
            if (editingId === 'new') onAddMakeup(makeup)
            else onUpdateMakeup(makeup)
            setEditingId(null)
          }}
          onCancel={() => setEditingId(null)}
        />
      )}
        </>
      )}
    </div>
  )
}

// ---------- Internal: WallTypeForm ----------

interface WallTypeFormProps {
  existing: WallMakeup | null
  onSave: (makeup: WallMakeup) => void
  onCancel: () => void
}

function WallTypeForm({ existing, onSave, onCancel }: WallTypeFormProps) {
  const [name, setName] = useState(existing?.name ?? 'New wall type')
  const [bondType, setBondType] = useState<BondType>(existing?.bondType ?? 'stretcher')
  const [heightMm, setHeightMm] = useState<number>(existing?.heightMm ?? 2400)
  const [knockoutCorners, setKnockoutCorners] = useState(existing?.cornerBlockCode === '20.21')
  const [useFractions, setUseFractions] = useState(existing?.useFractions ?? true)

  const [baseCourseBlockCode, setBaseCourseBlockCode] = useState<BlockCode>(
    existing?.baseCourseBlockCode ?? '20.45'
  )
  const [baseCourseTileCode, setBaseCourseTileCode] = useState<BlockCode | ''>(
    existing?.baseCourseTileCode ?? '50.45'
  )
  const [bodyBlockCode, setBodyBlockCode] = useState<BlockCode>(
    existing?.bodyBlockCode ?? '20.48'
  )
  const [topCourseBlockCode, setTopCourseBlockCode] = useState<BlockCode>(
    existing?.topCourseBlockCode ?? '20.48'
  )

  const [courseOverrides, setCourseOverrides] = useState<CourseOverride[]>(
    existing?.courseOverrides ?? []
  )
  const [showOverrides, setShowOverrides] = useState(
    (existing?.courseOverrides ?? []).length > 0
  )

  function addOverride() {
    setCourseOverrides((prev) => [...prev, { courseNumber: 2, blockCode: '20.48' }])
    setShowOverrides(true)
  }

  function updateOverride(index: number, patch: Partial<CourseOverride>) {
    setCourseOverrides((prev) => prev.map((o, i) => (i === index ? { ...o, ...patch } : o)))
  }

  function removeOverride(index: number) {
    setCourseOverrides((prev) => prev.filter((_, i) => i !== index))
  }

  function handleSave() {
    const id = existing?.id ?? generateMakeupId()
    const updated: WallMakeup = {
      id,
      name: name.trim() || 'New wall type',
      bondType,
      heightMm,
      baseCourseBlockCode,
      baseCourseTileCode: baseCourseTileCode || undefined,
      bodyBlockCode,
      topCourseBlockCode,
      cornerBlockCode: knockoutCorners ? '20.21' : '20.01',
      useFractions,
      courseOverrides: courseOverrides.length > 0 ? courseOverrides : undefined,
    }
    onSave(updated)
  }

  const canSave = name.trim().length > 0 && heightMm >= 200

  return (
    <div className="mt-4 p-4 border border-neutral-200 rounded-lg bg-neutral-50">
      <h4 className="text-sm font-semibold mb-3 text-neutral-700">
        {existing ? `Edit "${existing.name}"` : 'New wall type'}
      </h4>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <label className="text-sm">
          <span className="block text-neutral-600 mb-1">Name</span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full px-3 py-1.5 border border-neutral-300 rounded-lg text-sm focus:outline-none focus:border-beme-500"
          />
        </label>

        <label className="text-sm">
          <span className="block text-neutral-600 mb-1">Height (mm)</span>
          <input
            type="number"
            min="200"
            step="50"
            value={heightMm}
            onChange={(e) => setHeightMm(parseInt(e.target.value || '0', 10))}
            className="w-full px-3 py-1.5 border border-neutral-300 rounded-lg text-sm focus:outline-none focus:border-beme-500"
          />
        </label>

        <div className="text-sm">
          <span className="block text-neutral-600 mb-1">Bond type</span>
          <div className="flex gap-3">
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input
                type="radio"
                checked={bondType === 'stretcher'}
                onChange={() => setBondType('stretcher')}
              />
              <span>Stretcher</span>
            </label>
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input
                type="radio"
                checked={bondType === 'stack'}
                onChange={() => setBondType('stack')}
              />
              <span>Stack</span>
            </label>
          </div>
        </div>

        <div className="text-sm">
          <span className="block text-neutral-600 mb-1">Options</span>
          <div className="flex flex-col gap-1">
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input
                type="checkbox"
                checked={useFractions}
                onChange={(e) => setUseFractions(e.target.checked)}
              />
              <span>Use fractions (20.02 / 20.22)</span>
            </label>
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input
                type="checkbox"
                checked={knockoutCorners}
                onChange={(e) => setKnockoutCorners(e.target.checked)}
              />
              <span>Knockout corners (20.21)</span>
            </label>
          </div>
        </div>
      </div>

      {/* Block composition */}
      <div className="mt-5">
        <div className="text-xs font-semibold uppercase tracking-wide text-neutral-500 mb-2">
          Block composition
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="text-sm">
            <span className="block text-neutral-600 mb-1">Base course block</span>
            <select
              value={baseCourseBlockCode}
              onChange={(e) => setBaseCourseBlockCode(e.target.value as BlockCode)}
              className="w-full px-3 py-1.5 border border-neutral-300 rounded-lg text-sm bg-white focus:outline-none focus:border-beme-500"
            >
              {SELECTABLE_BLOCKS.map((code) => (
                <option key={code} value={code}>
                  {blockLabel(code)}
                </option>
              ))}
            </select>
          </label>

          <label className="text-sm">
            <span className="block text-neutral-600 mb-1">Base course tile (paired)</span>
            <select
              value={baseCourseTileCode}
              onChange={(e) => setBaseCourseTileCode(e.target.value as BlockCode | '')}
              className="w-full px-3 py-1.5 border border-neutral-300 rounded-lg text-sm bg-white focus:outline-none focus:border-beme-500"
            >
              <option value="">None</option>
              {TILE_BLOCKS.map((code) => (
                <option key={code} value={code}>
                  {blockLabel(code)}
                </option>
              ))}
            </select>
          </label>

          <label className="text-sm">
            <span className="block text-neutral-600 mb-1">Body course block</span>
            <select
              value={bodyBlockCode}
              onChange={(e) => setBodyBlockCode(e.target.value as BlockCode)}
              className="w-full px-3 py-1.5 border border-neutral-300 rounded-lg text-sm bg-white focus:outline-none focus:border-beme-500"
            >
              {SELECTABLE_BLOCKS.map((code) => (
                <option key={code} value={code}>
                  {blockLabel(code)}
                </option>
              ))}
            </select>
          </label>

          <label className="text-sm">
            <span className="block text-neutral-600 mb-1">Top course block</span>
            <select
              value={topCourseBlockCode}
              onChange={(e) => setTopCourseBlockCode(e.target.value as BlockCode)}
              className="w-full px-3 py-1.5 border border-neutral-300 rounded-lg text-sm bg-white focus:outline-none focus:border-beme-500"
            >
              {SELECTABLE_BLOCKS.map((code) => (
                <option key={code} value={code}>
                  {blockLabel(code)}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {/* Per-course overrides */}
      <div className="mt-5">
        <button
          onClick={() => setShowOverrides((v) => !v)}
          className="text-sm text-beme-600 hover:text-beme-700 hover:underline"
        >
          {showOverrides ? '−' : '+'} Customise specific courses
          {courseOverrides.length > 0 && ` (${courseOverrides.length})`}
        </button>

        {showOverrides && (
          <div className="mt-2 p-3 border border-neutral-200 rounded-lg bg-white">
            {courseOverrides.length === 0 && (
              <p className="text-xs text-neutral-500 mb-2">
                Override the block used on a specific course (e.g. a 20.140 row mid-wall for height makeup,
                or an intermediate 20.20 bond beam).
              </p>
            )}
            {courseOverrides.map((override, i) => (
              <div key={i} className="flex items-center gap-2 mb-2 text-sm flex-wrap">
                <span className="text-neutral-600">Course</span>
                <input
                  type="number"
                  min="1"
                  value={override.courseNumber}
                  onChange={(e) =>
                    updateOverride(i, { courseNumber: parseInt(e.target.value || '1', 10) })
                  }
                  className="w-16 px-2 py-1 border border-neutral-300 rounded text-sm"
                />
                <span className="text-neutral-600">uses block</span>
                <select
                  value={override.blockCode}
                  onChange={(e) => updateOverride(i, { blockCode: e.target.value as BlockCode })}
                  className="px-2 py-1 border border-neutral-300 rounded text-sm bg-white"
                >
                  {SELECTABLE_BLOCKS.map((code) => (
                    <option key={code} value={code}>
                      {blockLabel(code)}
                    </option>
                  ))}
                </select>
                <button
                  onClick={() => removeOverride(i)}
                  className="text-red-600 hover:text-red-700 text-sm px-2"
                  aria-label="Remove override"
                >
                  ×
                </button>
              </div>
            ))}
            <button
              onClick={addOverride}
              className="text-sm text-beme-600 hover:text-beme-700 hover:underline"
            >
              + Add course override
            </button>
          </div>
        )}
      </div>

      <div className="flex gap-2 mt-5">
        <button
          onClick={handleSave}
          disabled={!canSave}
          className="px-4 py-1.5 rounded-lg bg-beme-600 text-white text-sm hover:bg-beme-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors font-medium"
        >
          {existing ? 'Save changes' : 'Create wall type'}
        </button>
        <button
          onClick={onCancel}
          className="px-4 py-1.5 rounded-lg border border-neutral-300 text-sm hover:bg-neutral-100 transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}
