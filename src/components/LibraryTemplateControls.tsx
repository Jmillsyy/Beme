import { useState } from 'react'
import { setBlockLibrary, useBlockLibrary } from '../data/blockLibrary'
import { getLibraryTemplate } from '../data/libraryTemplates'
import { updateUserSettings, useUserSettings } from '../lib/userSettings'
import RegionPicker from './RegionPicker'

interface LibraryTemplateControlsProps {
  /** Hide destructive controls for non-admin viewers. */
  readOnly?: boolean
}

/**
 * Small bar at the top of the Blocks section in /library. Two actions:
 *
 *   - "Switch template" — opens the RegionPicker modal. Same modal used
 *     on first signin + in Settings → Preferences → Library template.
 *     Merges template blocks with any custom ones the user added.
 *   - "Clear all blocks" — wipes the block library wholesale. Useful
 *     when the user wants to start from a clean slate before picking a
 *     different template, or before building their own custom library.
 *     Heavy confirm dialog because it's destructive + cloud-syncs.
 *
 * The bar also surfaces the current template name + block count so the
 * user knows what they're looking at without diving into Settings.
 */
export default function LibraryTemplateControls({
  readOnly = false,
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
            ) : blockCount === 0 ? (
              <span className="text-ink-400">Empty — no template picked</span>
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
            {blockCount > 0 && (
              <button
                onClick={handleClear}
                className="text-sm px-3 py-1.5 rounded-lg border border-rose-500/50 text-rose-300 hover:bg-rose-500/10 transition-colors"
              >
                Clear all blocks
              </button>
            )}
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
