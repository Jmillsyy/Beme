import { memo, useMemo, useState } from 'react'
import type { BrickCode, BrickType } from '../types/bricks'
import { bricksPerSquareMetreOf, DEFAULT_BRICK_MORTAR_MM } from '../types/bricks'
import {
  PROTECTED_BRICK_CODES,
  removeBrickType,
  resetBrickLibrary,
  upsertBrickType,
  useBrickLibrary,
} from '../data/brickLibrary'

/**
 * User's editable brick library. Add, edit, or delete brick types.
 *
 * The bricks-per-m² figure on each row is auto-derived from the face dimensions
 * + mortar joint, unless the user has set a manual override on the type.
 *
 * Memoised so zoom/pan re-renders of PdfWorkspace don't ripple here. The
 * component takes no props so once mounted it only re-renders when the brick
 * library singleton emits a change (via useBrickLibrary's listener set).
 */
interface BrickLibraryPanelProps {
  readOnly?: boolean
  defaultExpanded?: boolean
  hideChrome?: boolean
}

function BrickLibraryPanelImpl({
  readOnly = false,
  defaultExpanded = false,
  hideChrome = false,
}: BrickLibraryPanelProps = {}) {
  // BRICK_LIBRARY is a stable singleton mutated in place — `version` is the
  // change signal. Pass it into the bricks useMemo so the rendered list
  // updates after edits (same bug we just fixed on the block side).
  const { library, version: libraryVersion } = useBrickLibrary()
  const [expanded, setExpanded] = useState(defaultExpanded)
  const [editingCode, setEditingCode] = useState<BrickCode | 'new' | null>(null)

  const bricks = useMemo(
    () => Object.values(library).sort((a, b) => a.heightMm - b.heightMm),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [library, libraryVersion]
  )

  return (
    <div className={hideChrome ? '' : 'my-4 border border-ink-600 rounded-xl bg-ink-800 p-3'}>
      {!hideChrome && (
        <div className="flex items-center justify-between gap-2 mb-2">
          <button
            onClick={() => setExpanded((v) => !v)}
            className="flex items-center gap-2 text-left flex-1 min-w-0 group"
          >
            <span className="text-ink-400 group-hover:text-ink-200 text-xs">
              {expanded ? '▾' : '▸'}
            </span>
            <h3 className="text-sm font-semibold text-ink-50 group-hover:text-beme-300">
              Brick library
            </h3>
            <span className="text-xs text-ink-400 truncate">
              · {Object.keys(library).length} types
            </span>
          </button>
          {expanded && !readOnly && (
            <button
              onClick={() => setEditingCode('new')}
              className="text-sm px-2.5 py-1 rounded-lg bg-beme-500 text-black font-medium hover:bg-beme-400 transition-colors flex-shrink-0"
            >
              + Add
            </button>
          )}
        </div>
      )}
      {hideChrome && !readOnly && (
        // Prominent add row — mirrors BlockLibraryPanel and the
        // supply-items editor so every material-library tab opens
        // with the "+ Add" button in the same place.
        <div className="flex items-center justify-between gap-3 mb-3 pb-3 border-b border-ink-700">
          <div className="text-xs text-ink-400">
            <span className="font-semibold text-ink-200">{bricks.length}</span>{' '}
            brick type{bricks.length === 1 ? '' : 's'} in your library
          </div>
          <button
            onClick={() => setEditingCode('new')}
            className="px-4 py-2 rounded-lg bg-beme-500 text-black text-sm font-semibold hover:bg-beme-400 transition-colors shadow-sm whitespace-nowrap"
          >
            + Add brick
          </button>
        </div>
      )}

      {(expanded || hideChrome) && (
        <div className="flex flex-col gap-1">
          {bricks.map((brick) => (
            <BrickRow
              key={brick.code}
              brick={brick}
              readOnly={readOnly}
              onEdit={() => setEditingCode(brick.code)}
              onDelete={() => {
                if (PROTECTED_BRICK_CODES.has(brick.code)) return
                if (window.confirm(`Delete brick type "${brick.name}"?`)) {
                  removeBrickType(brick.code)
                }
              }}
            />
          ))}

          {!readOnly && (
            <button
              onClick={() => {
                if (
                  window.confirm(
                    'Reset the brick library to defaults? Any custom brick types will be removed.'
                  )
                ) {
                  resetBrickLibrary()
                }
              }}
              className="self-start mt-2 text-xs text-ink-400 hover:text-rose-300 transition-colors"
            >
              ↺ Reset to defaults
            </button>
          )}
        </div>
      )}

      {!readOnly && editingCode !== null && (
        <BrickEditor
          existing={editingCode === 'new' ? null : library[editingCode] ?? null}
          existingCodes={Object.keys(library)}
          onSave={(brick) => {
            upsertBrickType(brick)
            setEditingCode(null)
          }}
          onCancel={() => setEditingCode(null)}
        />
      )}
    </div>
  )
}

const BrickLibraryPanel = memo(BrickLibraryPanelImpl)
export default BrickLibraryPanel

// ─── Row ────────────────────────────────────────────────────────────────────

function BrickRow({
  brick,
  onEdit,
  onDelete,
  readOnly = false,
}: {
  brick: BrickType
  onEdit: () => void
  onDelete: () => void
  readOnly?: boolean
}) {
  const isProtected = PROTECTED_BRICK_CODES.has(brick.code)
  const dims = `${brick.widthMm}×${brick.heightMm}×${brick.depthMm}mm`
  const rate = bricksPerSquareMetreOf(brick)
  const rateLabel =
    brick.bricksPerSquareMetreOverride !== undefined
      ? `${rate}/m² (manual)`
      : `${rate}/m² · ${brick.mortarJointMm ?? DEFAULT_BRICK_MORTAR_MM}mm joint`

  return (
    <div className="flex items-center gap-2 py-1.5 px-2 rounded-md border border-ink-600/40 hover:border-ink-600 hover:bg-ink-700/40">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-mono text-xs text-beme-300 font-medium">{brick.code}</span>
          <span className="text-sm text-ink-100 truncate">{brick.name}</span>
          {isProtected && (
            <span
              className="text-[10px] uppercase tracking-wider text-ink-400 border border-ink-600 rounded px-1.5 py-0.5"
              title="Default brick type — can be renamed but not deleted"
            >
              default
            </span>
          )}
        </div>
        <div className="text-[11px] text-ink-400 font-mono">
          {dims} · {rateLabel}
          {brick.description && (
            <span className="text-ink-500"> · {brick.description}</span>
          )}
        </div>
      </div>
      {!readOnly && (
        <>
          <button
            onClick={onEdit}
            className="px-2 py-1 rounded border border-ink-600 text-xs text-ink-300 hover:bg-ink-700 transition-colors"
          >
            Edit
          </button>
          <button
            onClick={onDelete}
            disabled={isProtected}
            title={isProtected ? 'Default brick type can be renamed but not deleted' : 'Delete this brick type'}
            className="px-2 py-1 rounded border border-ink-600 text-xs text-ink-300 hover:bg-rose-500/10 hover:border-rose-500/40 hover:text-rose-300 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            Delete
          </button>
        </>
      )}
    </div>
  )
}

// ─── Editor ─────────────────────────────────────────────────────────────────

interface BrickEditorProps {
  existing: BrickType | null
  existingCodes: string[]
  onSave: (brick: BrickType) => void
  onCancel: () => void
}

function BrickEditor({ existing, existingCodes, onSave, onCancel }: BrickEditorProps) {
  const isNew = existing === null
  const codeLocked = !!existing && PROTECTED_BRICK_CODES.has(existing.code)

  const [code, setCode] = useState(existing?.code ?? '')
  const [name, setName] = useState(existing?.name ?? '')
  const [description, setDescription] = useState(existing?.description ?? '')
  const [widthMm, setWidthMm] = useState<number>(existing?.widthMm ?? 230)
  const [heightMm, setHeightMm] = useState<number>(existing?.heightMm ?? 76)
  const [depthMm, setDepthMm] = useState<number>(existing?.depthMm ?? 110)
  const [mortarJointMm, setMortarJointMm] = useState<number>(
    existing?.mortarJointMm ?? DEFAULT_BRICK_MORTAR_MM
  )
  const [overrideRate, setOverrideRate] = useState<number | ''>(
    existing?.bricksPerSquareMetreOverride ?? ''
  )

  const trimmedCode = code.trim()
  const codeClash = isNew && trimmedCode.length > 0 && existingCodes.includes(trimmedCode)
  const canSave = trimmedCode.length > 0 && name.trim().length > 0 && !codeClash

  // Live preview of the derived rate.
  const derivedRate = useMemo(() => {
    const widthWithMortar = widthMm + mortarJointMm
    const heightWithMortar = heightMm + mortarJointMm
    const area = (widthWithMortar * heightWithMortar) / 1_000_000
    if (area <= 0) return 0
    return Math.round(1 / area)
  }, [widthMm, heightMm, mortarJointMm])

  function handleSave() {
    const brick: BrickType = {
      code: codeLocked ? existing!.code : trimmedCode,
      name: name.trim(),
      description: description.trim() || undefined,
      widthMm,
      heightMm,
      depthMm,
      mortarJointMm,
      ...(overrideRate !== '' ? { bricksPerSquareMetreOverride: overrideRate } : {}),
    }
    onSave(brick)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-md bg-ink-800 border border-ink-600 rounded-xl shadow-xl shadow-black/40 overflow-hidden flex flex-col max-h-[90vh]">
        <header className="px-5 py-3 border-b border-ink-600 flex items-center justify-between">
          <h3 className="font-semibold text-ink-50">
            {isNew ? 'Add a brick type' : `Edit ${existing.code}`}
          </h3>
          <button
            onClick={onCancel}
            className="text-ink-400 hover:text-ink-100 text-xl leading-none"
            aria-label="Close"
          >
            ×
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3 text-sm">
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="block text-ink-300 text-xs mb-1">Code</span>
              <input
                type="text"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                disabled={codeLocked}
                placeholder="e.g. standard or MY-90"
                className="w-full px-3 py-1.5 border border-ink-600 rounded-lg text-sm font-mono bg-ink-900 text-ink-50 focus:outline-none focus:border-beme-400 disabled:opacity-60"
              />
              {codeLocked && (
                <span className="text-[11px] text-ink-400">Default code — name / dimensions only.</span>
              )}
              {codeClash && (
                <span className="text-[11px] text-rose-400">That code already exists.</span>
              )}
            </label>

            <label className="block">
              <span className="block text-ink-300 text-xs mb-1">Name</span>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Standard 230×76"
                className="w-full px-3 py-1.5 border border-ink-600 rounded-lg text-sm bg-ink-900 text-ink-50 focus:outline-none focus:border-beme-400"
              />
            </label>
          </div>

          <label className="block">
            <span className="block text-ink-300 text-xs mb-1">Description (optional)</span>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="e.g. Double-height brick for feature courses"
              className="w-full px-3 py-1.5 border border-ink-600 rounded-lg text-sm bg-ink-900 text-ink-50 focus:outline-none focus:border-beme-400"
            />
          </label>

          <div className="grid grid-cols-3 gap-2">
            <label className="block">
              <span className="block text-ink-300 text-xs mb-1">Face width (mm)</span>
              <input
                type="number"
                min={50}
                step={5}
                value={widthMm}
                onChange={(e) => setWidthMm(parseInt(e.target.value || '0', 10))}
                className="w-full px-2 py-1.5 border border-ink-600 rounded-lg text-sm bg-ink-900 text-ink-50 focus:outline-none focus:border-beme-400"
              />
            </label>
            <label className="block">
              <span className="block text-ink-300 text-xs mb-1">Face height (mm)</span>
              <input
                type="number"
                min={20}
                step={5}
                value={heightMm}
                onChange={(e) => setHeightMm(parseInt(e.target.value || '0', 10))}
                className="w-full px-2 py-1.5 border border-ink-600 rounded-lg text-sm bg-ink-900 text-ink-50 focus:outline-none focus:border-beme-400"
              />
            </label>
            <label className="block">
              <span className="block text-ink-300 text-xs mb-1">Wall depth (mm)</span>
              <input
                type="number"
                min={50}
                step={5}
                value={depthMm}
                onChange={(e) => setDepthMm(parseInt(e.target.value || '0', 10))}
                className="w-full px-2 py-1.5 border border-ink-600 rounded-lg text-sm bg-ink-900 text-ink-50 focus:outline-none focus:border-beme-400"
              />
            </label>
          </div>

          <label className="block">
            <span className="block text-ink-300 text-xs mb-1">
              Mortar joint (mm) <span className="text-ink-500">· typically 10</span>
            </span>
            <input
              type="number"
              min={0}
              max={30}
              step={1}
              value={mortarJointMm}
              onChange={(e) => setMortarJointMm(parseInt(e.target.value || '0', 10))}
              className="w-full px-3 py-1.5 border border-ink-600 rounded-lg text-sm bg-ink-900 text-ink-50 focus:outline-none focus:border-beme-400"
            />
          </label>

          {/* Derived rate preview */}
          <div className="px-3 py-2 rounded-lg border border-ink-600 bg-ink-700/40 flex items-center justify-between gap-3">
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-400">
                Auto-derived rate
              </div>
              <div className="font-mono text-base text-ink-50">
                {derivedRate} <span className="text-ink-400 text-xs">bricks/m²</span>
              </div>
            </div>
            <div className="text-xs text-ink-400 text-right max-w-[200px]">
              From face {widthMm + mortarJointMm}×{heightMm + mortarJointMm}mm including mortar.
            </div>
          </div>

          <label className="block">
            <span className="block text-ink-300 text-xs mb-1">
              Manual override (bricks/m²) <span className="text-ink-500">· optional</span>
            </span>
            <input
              type="number"
              min={1}
              step={1}
              value={overrideRate}
              onChange={(e) => {
                const v = e.target.value
                setOverrideRate(v === '' ? '' : parseInt(v, 10))
              }}
              placeholder={`Leave blank to use auto (${derivedRate})`}
              className="w-full px-3 py-1.5 border border-ink-600 rounded-lg text-sm bg-ink-900 text-ink-50 focus:outline-none focus:border-beme-400"
            />
            <span className="text-[11px] text-ink-400">
              Use when your measured rate differs from the geometric calculation.
            </span>
          </label>
        </div>

        <footer className="px-5 py-3 border-t border-ink-600 flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 rounded-md border border-ink-600 text-sm text-ink-200 hover:bg-ink-700 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={!canSave}
            className="px-3 py-1.5 rounded-md bg-beme-500 text-black text-sm hover:bg-beme-400 disabled:opacity-40 disabled:cursor-not-allowed transition-colors font-semibold"
          >
            {isNew ? 'Add brick' : 'Save'}
          </button>
        </footer>
      </div>
    </div>
  )
}
