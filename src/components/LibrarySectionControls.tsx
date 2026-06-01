import { useState } from 'react'
import { setBlockLibrary, useBlockLibrary } from '../data/blockLibrary'
import { setBrickLibrary, useBrickLibrary } from '../data/brickLibrary'
import { LIBRARY_TEMPLATES } from '../data/libraryTemplates'
import { updateUserSettings, useUserSettings } from '../lib/userSettings'
import { useOrganisations } from '../lib/organisations'
import {
  deleteOrgSupplyItem,
  useOrgSupplyItems,
} from '../lib/orgSupplyItems'
import RegionPicker from './RegionPicker'

export type LibrarySectionKind = 'block' | 'brick' | 'supply'

interface LibrarySectionControlsProps {
  kind: LibrarySectionKind
  /** Hide destructive controls for non-admin viewers. */
  readOnly?: boolean
}

/**
 * Per-section controls on /library — shows:
 *
 *   - An EMPTY-STATE HERO when the section is empty (with regional
 *     preset chips for blocks / bricks, manual-add hint for supplies).
 *   - A small RESET button when the section has items, so the user
 *     can wipe just this section without nuking the others.
 *
 * The kind prop drives the copy + the wipe action. The component is
 * controlled — it doesn't open a block / brick editor itself; the
 * surrounding panel (BlockLibraryPanel / BrickLibraryPanel) provides
 * the manual-add controls.
 *
 * Read-only viewers never see the buttons, just the placeholder.
 */
export default function LibrarySectionControls({
  kind,
  readOnly = false,
}: LibrarySectionControlsProps) {
  const { settings } = useUserSettings()
  const { library: blockLib } = useBlockLibrary()
  const { library: brickLib } = useBrickLibrary()
  const { currentOrgId } = useOrganisations()
  const { items: orgSupplyItems } = useOrgSupplyItems()
  const [showPicker, setShowPicker] = useState(false)

  // Supply count comes from Supabase when an org is active (the
  // canonical org-scoped list); otherwise from the local IndexedDB
  // list. Without this guard, a second device that's never had local
  // items would show the empty-state above the synced items below.
  const supplyCount = currentOrgId
    ? orgSupplyItems.length
    : settings.supplyItems?.length ?? 0
  // Pull the right count + reset action for this section kind.
  const count =
    kind === 'block'
      ? Object.keys(blockLib).length
      : kind === 'brick'
      ? Object.keys(brickLib).length
      : supplyCount

  async function handleReset() {
    const label =
      kind === 'block' ? 'blocks' : kind === 'brick' ? 'bricks' : 'supply items'
    const ok = window.confirm(
      `Reset ${label}?\n\n` +
        `This wipes all ${count} ${label.slice(0, -1)}${count === 1 ? '' : 's'} in this section ` +
        'and syncs to the cloud. The other library sections stay untouched. There is no undo.'
    )
    if (!ok) return
    if (kind === 'block') setBlockLibrary({})
    else if (kind === 'brick') setBrickLibrary({})
    else if (kind === 'supply') {
      if (currentOrgId) {
        // Delete each org item from Supabase. The optimistic update
        // inside deleteOrgSupplyItem keeps the singleton in sync as
        // each row removes.
        for (const item of orgSupplyItems) {
          try {
            await deleteOrgSupplyItem(item.id)
          } catch {
            // Failure is logged inside the helper; keep going so a
            // partial reset still removes what it can.
          }
        }
      } else {
        updateUserSettings({ supplyItems: [] })
      }
    }
  }

  // ───────── EMPTY STATE ─────────
  if (count === 0) {
    if (readOnly) {
      return (
        <div className="mb-4 p-6 rounded-xl border-2 border-dashed border-ink-700 bg-ink-900/30 text-center text-sm text-ink-500">
          This section is empty. The org admin can pick a regional template
          or add items manually.
        </div>
      )
    }
    return (
      <>
        <EmptyHero kind={kind} onPickPreset={() => setShowPicker(true)} />
        {showPicker && (
          <RegionPicker
            allowSkip
            onPicked={() => setShowPicker(false)}
            onCancel={() => setShowPicker(false)}
          />
        )}
      </>
    )
  }

  // ───────── POPULATED — small reset chip ─────────
  if (readOnly) return null
  return (
    <div className="mb-3 flex justify-end">
      <button
        onClick={handleReset}
        className="text-xs px-2.5 py-1 rounded-lg border border-rose-500/40 text-rose-300/90 hover:bg-rose-500/10 transition-colors"
      >
        Reset {kind === 'block' ? 'blocks' : kind === 'brick' ? 'bricks' : 'supply items'}
      </button>
    </div>
  )
}

// ─── Empty-state hero ──────────────────────────────────────────────────────

function EmptyHero({
  kind,
  onPickPreset,
}: {
  kind: LibrarySectionKind
  onPickPreset: () => void
}) {
  if (kind === 'supply') {
    return (
      <div className="mb-4 p-6 rounded-xl border-2 border-dashed border-ink-700 bg-ink-900/30 text-center">
        <div className="text-2xl mb-2 select-none">+</div>
        <h3 className="text-sm font-semibold text-ink-100 mb-1">
          No supply items yet
        </h3>
        <p className="text-xs text-ink-400 max-w-md mx-auto leading-relaxed">
          Supply items are extras you add to estimates beyond the masonry —
          ties, plascourse, cement bags, rebar, etc. They're manual-add and
          fully user-defined; add the ones you actually price into your
          estimates using the + button below.
        </p>
      </div>
    )
  }

  const label = kind === 'block' ? 'block' : 'brick'
  const intro =
    kind === 'block'
      ? 'Beme needs at least one body, corner, and half block to estimate ' +
        'walls. Pick a regional preset to get a working library in one click, ' +
        'or start from scratch and add your own blocks below.'
      : 'Beme uses brick dimensions to compute bricks-per-m² and price each ' +
        'wall. Pick a regional preset for the standard face sizes in your ' +
        'market, or add bricks manually below.'

  return (
    <div className="mb-6 p-6 rounded-xl border-2 border-dashed border-beme-500/40 bg-beme-500/5 text-center">
      <div className="text-2xl mb-2 select-none">▦</div>
      <h3 className="text-base font-semibold text-ink-100 mb-1">
        Your {label} library is empty
      </h3>
      <p className="text-sm text-ink-400 max-w-md mx-auto mb-5 leading-relaxed">
        {intro}
      </p>
      <div className="flex justify-center gap-2 flex-wrap mb-4">
        <button
          onClick={onPickPreset}
          className="text-sm px-4 py-2 rounded-lg bg-beme-500 text-black font-medium hover:bg-beme-400 transition-colors"
        >
          Pick a regional preset →
        </button>
      </div>
      <div className="flex justify-center gap-1.5 flex-wrap pt-3 border-t border-ink-700">
        <span className="text-[10px] uppercase tracking-wide text-ink-500 self-center mr-1">
          Presets:
        </span>
        {LIBRARY_TEMPLATES.filter((t) => t.key !== 'blank').map((t) => (
          <button
            key={t.key}
            onClick={onPickPreset}
            className="text-xs px-2.5 py-1 rounded-full border border-ink-600 text-ink-300 hover:border-beme-500/50 hover:text-beme-300 transition-colors"
            title={t.description}
          >
            {t.displayName}
          </button>
        ))}
      </div>
    </div>
  )
}
