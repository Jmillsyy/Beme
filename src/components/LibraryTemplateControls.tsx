import { useState } from 'react'
import { setBlockLibrary, useBlockLibrary } from '../data/blockLibrary'
import { LIBRARY_TEMPLATES, getLibraryTemplate } from '../data/libraryTemplates'
import { updateUserSettings, useUserSettings } from '../lib/userSettings'
import RegionPicker from './RegionPicker'

interface LibraryTemplateControlsProps {
  /** Hide destructive controls for non-admin viewers. */
  readOnly?: boolean
  /** Optional callback when the user clicks "+ Add block manually" in
   *  the empty state. Wires into the block editor host. */
  onAddBlockManually?: () => void
}

/**
 * Material library template controls. Renders one of two states:
 *
 *  EMPTY  — library has no blocks (or only the user explicitly cleared).
 *           Big hero card with two paths: pick a regional preset, or
 *           add a block manually. Designed to make the next step
 *           obvious — there's no point staring at an empty grid.
 *
 *  POPULATED — compact bar at the top showing the active template name
 *           + block count, with Switch template and Clear all blocks
 *           buttons. Same data as before, less prominent so the actual
 *           block grid stays the focus.
 *
 * Switch template opens the same RegionPicker used on first signin
 * (merge semantics: custom blocks preserved).
 *
 * Clear all blocks wipes the library + clears the saved template key
 * so the next pick is treated as a fresh seed. Heavy confirm because
 * it's destructive and cloud-syncs.
 */
export default function LibraryTemplateControls({
  readOnly = false,
  onAddBlockManually,
}: LibraryTemplateControlsProps) {
  const { settings } = useUserSettings()
  const { library, version } = useBlockLibrary()
  void version
  const [showPicker, setShowPicker] = useState(false)

  const currentKey = settings.preferences.libraryTemplateKey
  const currentTemplate = currentKey ? getLibraryTemplate(currentKey) : undefined
  const blockCount = Object.keys(library).length

  function handleClear() {
    const ok = window.confirm(
      `Clear all ${blockCount} block${blockCount === 1 ? '' : 's'} from your library?\n\n` +
        'This is destructive — it wipes the library wholesale and syncs the empty state ' +
        "to the cloud. You'll be able to pick a new template or add blocks manually after.\n\n" +
        'Cancel if you just want to switch templates — that keeps your custom blocks.'
    )
    if (!ok) return
    // Wipe library + clear the saved template key so the next region
    // pick is treated as a fresh seed (no "you have custom blocks"
    // merge prompt for a blank library).
    setBlockLibrary({})
    updateUserSettings({
      preferences: { libraryTemplateKey: undefined },
    })
  }

  // ───────── EMPTY STATE ─────────
  // No blocks AND the user can edit. Show the two-path hero so the
  // next action is obvious. Read-only viewers see a thin placeholder
  // instead so they're not nudged to do something they can't do.
  if (blockCount === 0) {
    if (readOnly) {
      return (
        <div className="mb-4 p-6 rounded-xl border-2 border-dashed border-ink-700 bg-ink-900/30 text-center text-sm text-ink-500">
          This library is empty. The org admin can pick a regional template
          or add blocks manually.
        </div>
      )
    }
    return (
      <>
        <div className="mb-6 p-6 rounded-xl border-2 border-dashed border-beme-500/40 bg-beme-500/5 text-center">
          <div className="text-2xl mb-2 select-none">▦</div>
          <h3 className="text-base font-semibold text-ink-100 mb-1">
            Your block library is empty
          </h3>
          <p className="text-sm text-ink-400 max-w-md mx-auto mb-5 leading-relaxed">
            Beme needs at least one body, corner, and half block to estimate
            walls. Pick a regional preset to get a working library in one
            click, or start from scratch and add your own blocks.
          </p>
          <div className="flex justify-center gap-2 flex-wrap mb-4">
            <button
              onClick={() => setShowPicker(true)}
              className="text-sm px-4 py-2 rounded-lg bg-beme-500 text-black font-medium hover:bg-beme-400 transition-colors"
            >
              Pick a regional preset →
            </button>
            {onAddBlockManually && (
              <button
                onClick={onAddBlockManually}
                className="text-sm px-4 py-2 rounded-lg border border-ink-600 text-ink-200 hover:bg-ink-700 transition-colors"
              >
                + Add a block manually
              </button>
            )}
          </div>
          {/* Quick template preview row — small chips with the regional
              options. Clicking a chip pre-selects + opens the picker
              on that template's card so the user can confirm before
              applying. */}
          <div className="flex justify-center gap-1.5 flex-wrap pt-3 border-t border-ink-700">
            <span className="text-[10px] uppercase tracking-wide text-ink-500 self-center mr-1">
              Presets:
            </span>
            {LIBRARY_TEMPLATES.filter((t) => t.key !== 'blank').map((t) => (
              <button
                key={t.key}
                onClick={() => setShowPicker(true)}
                className="text-xs px-2.5 py-1 rounded-full border border-ink-600 text-ink-300 hover:border-beme-500/50 hover:text-beme-300 transition-colors"
                title={t.description}
              >
                {t.displayName}
              </button>
            ))}
          </div>
        </div>

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

  // ───────── POPULATED STATE ─────────
  return (
    <>
      <div className="mb-4 flex items-center justify-between gap-3 p-3 rounded-xl border border-ink-600 bg-ink-800/60 flex-wrap">
        <div className="min-w-0">
          <div className="text-[10px] uppercase tracking-wide text-ink-500 font-semibold">
            Library template
          </div>
          <div className="text-sm font-medium text-ink-100 mt-0.5">
            {currentTemplate ? (
              <>
                {currentTemplate.displayName}{' '}
                <span className="text-ink-500 font-mono font-normal">
                  · {blockCount} block{blockCount === 1 ? '' : 's'}
                </span>
              </>
            ) : (
              <span>
                Custom library{' '}
                <span className="text-ink-500 font-mono font-normal">
                  · {blockCount} block{blockCount === 1 ? '' : 's'}
                </span>
              </span>
            )}
          </div>
        </div>
        {!readOnly && (
          <div className="flex gap-2 flex-shrink-0">
            <button
              onClick={() => setShowPicker(true)}
              className="text-sm px-3 py-1.5 rounded-lg bg-beme-500 text-black font-medium hover:bg-beme-400 transition-colors"
            >
              {currentTemplate ? 'Switch template' : 'Pick a template'}
            </button>
            <button
              onClick={handleClear}
              className="text-sm px-3 py-1.5 rounded-lg border border-rose-500/50 text-rose-300 hover:bg-rose-500/10 transition-colors"
            >
              Reset library
            </button>
          </div>
        )}
      </div>

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
