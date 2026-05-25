import { useMemo, useState } from 'react'
import type { Block, BlockCode, BlockRole } from '../types/blocks'
import {
  PROTECTED_BLOCK_CODES,
  removeBlock,
  resetBlockLibrary,
  upsertBlock,
  useBlockLibrary,
} from '../data/blockLibrary'
import { updateUserSettings, useUserSettings } from '../lib/userSettings'

/**
 * The user's editable block library. Add, edit, or delete blocks.
 *
 * Protected blocks (the SEQ QLD codes the calc engine reaches for by name —
 * 20.48, 20.01, 20.03, 20.45 + tile, fractions, height-makeup blocks) can be
 * renamed and re-dimensioned but not deleted. Custom blocks have no
 * restrictions.
 *
 * Changes persist to IndexedDB and live-update every dependent panel
 * (wall types, pier types, block tally) via the useBlockLibrary subscription.
 */

const ROLE_OPTIONS: { value: BlockRole; label: string }[] = [
  { value: 'body', label: 'Body (main course)' },
  { value: 'end-termination', label: 'End termination' },
  { value: 'corner', label: 'Corner' },
  { value: 'fraction', label: 'Fraction (length makeup)' },
  { value: 'height-makeup', label: 'Height makeup' },
  { value: 'base-course', label: 'Base course' },
  { value: 'base-tile', label: 'Base tile (paired with cleanout)' },
  { value: 'top-course', label: 'Top course (bond beam)' },
  { value: 'pier', label: 'Pier' },
  { value: 'lintel', label: 'Lintel' },
  { value: 'curve-tight', label: 'Tight-curve wedge' },
  { value: 'legacy', label: 'Legacy / rarely used' },
]

interface BlockLibraryPanelProps {
  /**
   * If provided, only blocks usable by this scope are shown by default
   * (the user can switch to "All blocks"). Otherwise shows all blocks.
   */
  scope?: 'block' | 'brick'
  /**
   * When true, the panel renders the block list in view-only mode — no
   * + Add button, no Edit / Delete on rows, no Reset link. Used on the
   * dashboard for non-admin org members.
   */
  readOnly?: boolean
  /**
   * Start expanded instead of collapsed. Useful on the dashboard where
   * the library IS the main content of its section.
   */
  defaultExpanded?: boolean
  /**
   * Whether to render the panel chrome (border, expand toggle, header).
   * Set to false when the parent already provides its own header.
   */
  hideChrome?: boolean
}

export default function BlockLibraryPanel({
  scope: _scope,
  readOnly = false,
  defaultExpanded = false,
  hideChrome = false,
}: BlockLibraryPanelProps = {}) {
  void _scope // reserved for future filtering
  // BLOCK_LIBRARY is a stable singleton mutated in place — the only thing
  // that signals "library changed" is `version` from useBlockLibrary. We
  // MUST pass it into every useMemo that derives from `library`, otherwise
  // edits look like they revert: the singleton updates, the component
  // re-renders, but the memoised arrays still reference the pre-edit
  // values because `library === library` evaluates true and useMemo
  // short-circuits. This was the cause of the "name changes save but
  // disappear" bug — the BLOCK_LIBRARY had the new value, but the
  // rendered list was reading from a stale memo.
  const { library, version: libraryVersion } = useBlockLibrary()
  const { settings } = useUserSettings()
  const [expanded, setExpanded] = useState(defaultExpanded)
  const [editingCode, setEditingCode] = useState<BlockCode | 'new' | null>(null)
  const [filter, setFilter] = useState<'all' | BlockRole>('all')
  // Pre-seed the editor with role: 'lintel' when the user adds a new lintel
  // block via the dedicated Lintel section's button. The editor itself reads
  // this on mount; clears back to null after save / cancel.
  const [newBlockRoleSeed, setNewBlockRoleSeed] = useState<BlockRole | null>(null)

  const blocks = useMemo(() => {
    const all = Object.values(library)
    if (filter === 'all') return all.sort((a, b) => a.code.localeCompare(b.code))
    return all.filter((b) => b.roles.includes(filter)).sort((a, b) => a.code.localeCompare(b.code))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [library, libraryVersion, filter])

  // Lintel blocks sorted shortest first — matches the selection order
  // `pickLintelBlockIn` uses at calc time: it walks the list ascending and
  // picks the first lintel tall enough to cover the head. Users see the
  // same priority order the engine sees.
  const lintelBlocks = useMemo(
    () =>
      Object.values(library)
        .filter((b) => b.roles.includes('lintel'))
        .sort((a, b) => a.dimensions.heightMm - b.dimensions.heightMm),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [library, libraryVersion]
  )
  const useLintels = settings.preferences.regionalFeatures.lintels

  function setUseLintels(next: boolean) {
    updateUserSettings({
      preferences: {
        regionalFeatures: {
          ...settings.preferences.regionalFeatures,
          lintels: next,
        },
      },
    })
  }

  const showAddButton = expanded && !readOnly

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
              Block library
            </h3>
            <span className="text-xs text-ink-400 truncate">
              · {Object.keys(library).length} blocks
            </span>
          </button>
          {showAddButton && (
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
        <div className="flex justify-end mb-2">
          <button
            onClick={() => setEditingCode('new')}
            className="text-sm px-2.5 py-1 rounded-lg bg-beme-500 text-black font-medium hover:bg-beme-400 transition-colors"
          >
            + Add block
          </button>
        </div>
      )}

      {(expanded || hideChrome) && (
        <div className="flex flex-col gap-2">
          {/* Lintel blocks — a dedicated section because "what lintel do I
              put above an opening" is a how-you-build decision that varies
              by region and stays put per user. Toggle controls whether
              Beme supplies any lintel block at all; the list shows the
              user's lintel blocks (the calc engine picks the tallest one
              that fits each opening's head). */}
          {!readOnly && (
            <div className="rounded-md border border-ink-600/60 bg-ink-900/40 p-2.5 mb-1">
              <label className="flex items-start gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={useLintels}
                  onChange={(e) => setUseLintels(e.target.checked)}
                  className="mt-0.5 accent-beme-500"
                />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-ink-100">
                    Supply lintel blocks above openings
                  </div>
                  <div className="text-[11px] text-ink-400 mt-0.5">
                    When on, Beme picks the tallest lintel that fits each
                    opening's head and adds it to the schedule. Off → no
                    lintel blocks are supplied; the head is left open in
                    the tally and export (use this if your region bridges
                    openings with a structural lintel beam supplied
                    separately).
                  </div>
                </div>
              </label>
              {useLintels && (
                <div className="mt-2.5 pt-2.5 border-t border-ink-600/60">
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-400">
                      Your lintel blocks
                    </span>
                    <button
                      onClick={() => {
                        setNewBlockRoleSeed('lintel')
                        setEditingCode('new')
                      }}
                      className="text-xs px-2 py-0.5 rounded border border-ink-600 text-beme-300 hover:border-beme-500/60 hover:bg-ink-700 transition-colors"
                    >
                      + Add lintel block
                    </button>
                  </div>
                  {lintelBlocks.length === 0 ? (
                    <p className="text-xs text-ink-400 italic px-1 py-1">
                      No lintel blocks yet — add at least one with its
                      width × height × depth so Beme has something to
                      supply for openings.
                    </p>
                  ) : (
                    <div className="flex flex-col gap-1">
                      {lintelBlocks.map((block) => (
                        <BlockRow
                          key={block.code}
                          block={block}
                          readOnly={readOnly}
                          onEdit={() => setEditingCode(block.code)}
                          onDelete={() => {
                            if (PROTECTED_BLOCK_CODES.has(block.code)) return
                            if (
                              window.confirm(
                                `Delete lintel block "${block.code} — ${block.name}"?`
                              )
                            ) {
                              removeBlock(block.code)
                            }
                          }}
                        />
                      ))}
                    </div>
                  )}
                  <p className="text-[11px] text-ink-500 mt-2 px-1">
                    For each opening Beme picks the SMALLEST lintel whose
                    height ≥ the opening's head height — the lintel has to
                    fully bridge the head, so a 290 mm block can't be used
                    over a 310 mm head (it'd need the 390 mm instead). If
                    the head is taller than any lintel you've added, Beme
                    stacks the tallest one vertically as many times as
                    needed.
                  </p>
                </div>
              )}
            </div>
          )}

          {/* Filter row */}
          <div className="flex items-center gap-2 text-xs text-ink-300">
            <label htmlFor="block-library-filter" className="flex-shrink-0">
              Show:
            </label>
            <select
              id="block-library-filter"
              value={filter}
              onChange={(e) => setFilter(e.target.value as 'all' | BlockRole)}
              className="flex-1 px-2 py-1 border border-ink-600 rounded text-xs bg-ink-900 text-ink-50"
            >
              <option value="all">All blocks</option>
              {ROLE_OPTIONS.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
          </div>

          {/* List */}
          <div className="flex flex-col gap-1">
            {blocks.map((block) => (
              <BlockRow
                key={block.code}
                block={block}
                readOnly={readOnly}
                onEdit={() => setEditingCode(block.code)}
                onDelete={() => {
                  if (PROTECTED_BLOCK_CODES.has(block.code)) return
                  if (window.confirm(`Delete block "${block.code} — ${block.name}"?`)) {
                    removeBlock(block.code)
                  }
                }}
              />
            ))}
          </div>

          {/* Reset to defaults — admins only. */}
          {!readOnly && (
            <button
              onClick={() => {
                if (
                  window.confirm(
                    'Reset the entire block library to SEQ QLD defaults? Custom blocks will be removed and renames lost.'
                  )
                ) {
                  resetBlockLibrary()
                }
              }}
              className="self-start mt-2 text-xs text-ink-400 hover:text-rose-300 transition-colors"
            >
              ↺ Reset to defaults
            </button>
          )}
        </div>
      )}

      {/* Editor modal — both for adding new and editing existing. Hidden in
          read-only mode (the buttons that would open it aren't rendered).
          `roleSeed` pre-selects the role when the user came in via the
          dedicated Lintel "+ Add lintel block" button, so they don't have
          to manually tick the role checkbox after typing dimensions. */}
      {!readOnly && editingCode !== null && (
        <BlockEditor
          existing={editingCode === 'new' ? null : library[editingCode] ?? null}
          existingCodes={Object.keys(library)}
          roleSeed={editingCode === 'new' ? newBlockRoleSeed : null}
          onSave={(block) => {
            upsertBlock(block)
            setEditingCode(null)
            setNewBlockRoleSeed(null)
          }}
          onCancel={() => {
            setEditingCode(null)
            setNewBlockRoleSeed(null)
          }}
        />
      )}
    </div>
  )
}

// ─── Row ────────────────────────────────────────────────────────────────────

function BlockRow({
  block,
  onEdit,
  onDelete,
  readOnly = false,
}: {
  block: Block
  onEdit: () => void
  onDelete: () => void
  readOnly?: boolean
}) {
  const protectedBlock = PROTECTED_BLOCK_CODES.has(block.code)
  const dims = `${block.dimensions.widthMm}×${block.dimensions.heightMm}×${block.dimensions.depthMm}mm`
  return (
    <div className="flex items-center gap-2 py-1.5 px-2 rounded-md border border-ink-600/40 hover:border-ink-600 hover:bg-ink-700/40 group">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-mono text-xs text-beme-300 font-medium">{block.code}</span>
          <span className="text-sm text-ink-100 truncate">{block.name}</span>
          {protectedBlock && (
            <span
              className="text-[10px] uppercase tracking-wider text-ink-400 border border-ink-600 rounded px-1.5 py-0.5"
              title="Calc engine depends on this block — can be renamed but not deleted"
            >
              built-in
            </span>
          )}
        </div>
        <div className="text-[11px] text-ink-400 font-mono">
          {dims}
          {block.fraction !== undefined && <span> · {block.fraction}× fraction</span>}
          {block.roles.length > 0 && <span> · {block.roles.join(', ')}</span>}
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
            disabled={protectedBlock}
            title={protectedBlock ? 'Built-in blocks can be renamed but not deleted' : 'Delete this block'}
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

interface BlockEditorProps {
  existing: Block | null
  existingCodes: string[]
  /** Pre-select a role when the editor opens for a new block. Used by the
   *  "+ Add lintel block" shortcut so the lintel role is ticked from the
   *  start (rather than the default 'body'). Ignored when editing an
   *  existing block. */
  roleSeed?: BlockRole | null
  onSave: (block: Block) => void
  onCancel: () => void
}

function BlockEditor({ existing, existingCodes, roleSeed, onSave, onCancel }: BlockEditorProps) {
  const isNew = existing === null
  const [code, setCode] = useState(existing?.code ?? '')
  const [name, setName] = useState(existing?.name ?? '')
  const [description, setDescription] = useState(existing?.description ?? '')
  const [widthMm, setWidthMm] = useState<number>(existing?.dimensions.widthMm ?? 390)
  const [heightMm, setHeightMm] = useState<number>(existing?.dimensions.heightMm ?? 190)
  const [depthMm, setDepthMm] = useState<number>(existing?.dimensions.depthMm ?? 190)
  const [rearWidthMm, setRearWidthMm] = useState<number | ''>(
    existing?.dimensions.rearWidthMm ?? ''
  )
  const [roles, setRoles] = useState<BlockRole[]>(
    existing?.roles ?? (roleSeed ? [roleSeed] : ['body'])
  )
  const [fraction, setFraction] = useState<number | ''>(existing?.fraction ?? '')
  // Pairing fields — any block can be paired with another so the calc
  // engine automatically tallies the partner block. Drives the AU
  // 20.45 ↔ 50.45 cleanout-tile pairing without hardcoding it; other
  // regions can pair their own blocks the same way (e.g. CMU cap
  // blocks, header courses, etc.).
  const [pairedWith, setPairedWith] = useState<BlockCode | ''>(
    existing?.pairedWith ?? ''
  )
  const [pairedPer, setPairedPer] = useState<number>(existing?.pairedPer ?? 1)

  // Block built-in code rename to avoid breaking the calc engine. Built-in
  // block codes are fixed; only their name / description / dimensions are editable.
  const codeLocked = !!existing && PROTECTED_BLOCK_CODES.has(existing.code)

  const trimmedCode = code.trim()
  const codeClash =
    isNew &&
    trimmedCode.length > 0 &&
    existingCodes.includes(trimmedCode)
  const canSave =
    trimmedCode.length > 0 && name.trim().length > 0 && !codeClash && roles.length > 0

  function toggleRole(r: BlockRole) {
    setRoles((prev) => (prev.includes(r) ? prev.filter((x) => x !== r) : [...prev, r]))
  }

  function handleSave() {
    const block: Block = {
      code: codeLocked ? existing!.code : trimmedCode,
      name: name.trim(),
      description: description.trim(),
      dimensions: {
        widthMm,
        heightMm,
        depthMm,
        ...(rearWidthMm !== '' ? { rearWidthMm } : {}),
      },
      roles,
      ...(fraction !== '' ? { fraction } : {}),
      ...(pairedWith ? { pairedWith, pairedPer } : {}),
      ...(existing?.lintelMinHeadHeightMm !== undefined
        ? { lintelMinHeadHeightMm: existing.lintelMinHeadHeightMm }
        : {}),
      ...(existing?.lintelMaxHeadHeightMm !== undefined
        ? { lintelMaxHeadHeightMm: existing.lintelMaxHeadHeightMm }
        : {}),
    }
    onSave(block)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-md bg-ink-800 border border-ink-600 rounded-xl shadow-xl shadow-black/40 overflow-hidden flex flex-col max-h-[90vh]">
        <header className="px-5 py-3 border-b border-ink-600 flex items-center justify-between">
          <h3 className="font-semibold text-ink-50">{isNew ? 'Add a block' : `Edit ${existing.code}`}</h3>
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
                placeholder="e.g. 20.48 or BR-CC-90"
                className="w-full px-3 py-1.5 border border-ink-600 rounded-lg text-sm font-mono bg-ink-900 text-ink-50 focus:outline-none focus:border-beme-400 disabled:opacity-60"
              />
              {codeLocked && (
                <span className="text-[11px] text-ink-400">Built-in code — name / dimensions only.</span>
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
                placeholder="e.g. H Block"
                className="w-full px-3 py-1.5 border border-ink-600 rounded-lg text-sm bg-ink-900 text-ink-50 focus:outline-none focus:border-beme-400"
              />
            </label>
          </div>

          <label className="block">
            <span className="block text-ink-300 text-xs mb-1">Description</span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              placeholder="Where this block is used / what it's for"
              className="w-full px-3 py-1.5 border border-ink-600 rounded-lg text-sm bg-ink-900 text-ink-50 focus:outline-none focus:border-beme-400"
            />
          </label>

          <div className="grid grid-cols-3 gap-2">
            <label className="block">
              <span className="block text-ink-300 text-xs mb-1">Width (mm)</span>
              <input
                type="number"
                min={50}
                step={10}
                value={widthMm}
                onChange={(e) => setWidthMm(parseInt(e.target.value || '0', 10))}
                className="w-full px-2 py-1.5 border border-ink-600 rounded-lg text-sm bg-ink-900 text-ink-50 focus:outline-none focus:border-beme-400"
              />
            </label>
            <label className="block">
              <span className="block text-ink-300 text-xs mb-1">Height (mm)</span>
              <input
                type="number"
                min={30}
                step={10}
                value={heightMm}
                onChange={(e) => setHeightMm(parseInt(e.target.value || '0', 10))}
                className="w-full px-2 py-1.5 border border-ink-600 rounded-lg text-sm bg-ink-900 text-ink-50 focus:outline-none focus:border-beme-400"
              />
            </label>
            <label className="block">
              <span className="block text-ink-300 text-xs mb-1">Depth (mm)</span>
              <input
                type="number"
                min={50}
                step={10}
                value={depthMm}
                onChange={(e) => setDepthMm(parseInt(e.target.value || '0', 10))}
                className="w-full px-2 py-1.5 border border-ink-600 rounded-lg text-sm bg-ink-900 text-ink-50 focus:outline-none focus:border-beme-400"
              />
            </label>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="block text-ink-300 text-xs mb-1">
                Rear width (mm)
                <span className="text-ink-500"> · only for tapered/curve blocks</span>
              </span>
              <input
                type="number"
                min={0}
                step={10}
                value={rearWidthMm}
                onChange={(e) => {
                  const v = e.target.value
                  setRearWidthMm(v === '' ? '' : parseInt(v, 10))
                }}
                placeholder="—"
                className="w-full px-3 py-1.5 border border-ink-600 rounded-lg text-sm bg-ink-900 text-ink-50 focus:outline-none focus:border-beme-400"
              />
            </label>

            <label className="block">
              <span className="block text-ink-300 text-xs mb-1">
                Fraction <span className="text-ink-500">· e.g. 0.75 for 3/4</span>
              </span>
              <input
                type="number"
                min={0.05}
                max={1}
                step={0.05}
                value={fraction}
                onChange={(e) => {
                  const v = e.target.value
                  setFraction(v === '' ? '' : parseFloat(v))
                }}
                placeholder="—"
                className="w-full px-3 py-1.5 border border-ink-600 rounded-lg text-sm bg-ink-900 text-ink-50 focus:outline-none focus:border-beme-400"
              />
            </label>
          </div>

          {/* Pairing — any block can be paired with another so the calc
              engine adds the partner to the tally whenever this block
              appears. Replaces the old hardcoded base-course-tile
              setup; works for any pairing (e.g. CMU + cap block,
              base block + cleanout tile, brick header + bedding). */}
          <fieldset className="rounded-lg border border-ink-700 bg-ink-900/40 p-3">
            <legend className="px-1 text-ink-300 text-xs">Paired block (optional)</legend>
            <p className="text-[11px] text-ink-500 leading-snug mb-2">
              When this block is tallied, the paired block is added at
              the chosen ratio. Use this for blocks that always ship
              together — e.g. AU 20.45 cleanout + 50.45 tile (1:1).
            </p>
            <div className="grid grid-cols-[1fr_auto] gap-2 items-end">
              <label className="block">
                <span className="block text-ink-400 text-[11px] mb-1">Pairs with</span>
                <select
                  value={pairedWith}
                  onChange={(e) => setPairedWith(e.target.value as BlockCode | '')}
                  className="w-full px-2 py-1.5 border border-ink-600 rounded text-xs bg-ink-900 text-ink-50 font-mono"
                >
                  <option value="">— None —</option>
                  {existingCodes
                    .filter((c) => c !== (existing?.code ?? trimmedCode))
                    .sort()
                    .map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                </select>
              </label>
              <label className="block">
                <span className="block text-ink-400 text-[11px] mb-1">Ratio (1 paired per)</span>
                <select
                  value={pairedPer}
                  onChange={(e) => setPairedPer(parseInt(e.target.value, 10))}
                  disabled={!pairedWith}
                  className="w-full px-2 py-1.5 border border-ink-600 rounded text-xs bg-ink-900 text-ink-50 disabled:opacity-50"
                >
                  <option value={1}>1:1</option>
                  <option value={2}>1:2</option>
                  <option value={3}>1:3</option>
                  <option value={4}>1:4</option>
                </select>
              </label>
            </div>
          </fieldset>

          <fieldset>
            <legend className="block text-ink-300 text-xs mb-2">Roles</legend>
            <div className="grid grid-cols-2 gap-1.5">
              {ROLE_OPTIONS.map((r) => (
                <label key={r.value} className="flex items-center gap-2 text-xs text-ink-200">
                  <input
                    type="checkbox"
                    checked={roles.includes(r.value)}
                    onChange={() => toggleRole(r.value)}
                    className="rounded"
                  />
                  <span>{r.label}</span>
                </label>
              ))}
            </div>
          </fieldset>
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
            {isNew ? 'Add block' : 'Save'}
          </button>
        </footer>
      </div>
    </div>
  )
}
