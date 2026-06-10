import { useState } from 'react'
import { setBlockLibrary, useBlockLibrary } from '../data/blockLibrary'
import { setBrickLibrary, useBrickLibrary } from '../data/brickLibrary'
import { getLibraryTemplate } from '../data/libraryTemplates'
import { confirm } from '../lib/confirm'
import { updateUserSettings, useUserSettings } from '../lib/userSettings'
import RegionPicker from './RegionPicker'

interface LibraryTemplateControlsProps {
  /** Hide destructive controls for non-admin viewers. */
  readOnly?: boolean
}

/**
 * TOP-LEVEL bar on /library showing the active library template and
 * the master controls:
 *
 *   - Switch template — opens the RegionPicker (seeds blocks AND
 *     bricks together; supply items remain a manual-only list).
 *   - Reset entire library — wipes blocks + bricks + supply items
 *     + the active template key, in one confirm. Heavy destructive
 *     action so the user gets a full breakdown of what's about to
 *     go.
 *
 * Per-section resets live on each section (Blocks / Bricks / Supply
 * items) — those let the user wipe one part without nuking everything.
 *
 * Read-only viewers see just the indicator, no buttons.
 */
export default function LibraryTemplateControls({
  readOnly = false,
}: LibraryTemplateControlsProps) {
  const { settings } = useUserSettings()
  const { library: blockLib } = useBlockLibrary()
  const { library: brickLib } = useBrickLibrary()
  const [showPicker, setShowPicker] = useState(false)

  const currentKey = settings.preferences.libraryTemplateKey
  const currentTemplate = currentKey ? getLibraryTemplate(currentKey) : undefined
  const blockCount = Object.keys(blockLib).length
  const brickCount = Object.keys(brickLib).length
  const supplyCount = settings.supplyItems?.length ?? 0

  async function handleResetAll() {
    const ok = await confirm({
      title: 'Reset entire library?',
      message:
        `Wipes everything in one go: ${blockCount} block` +
        `${blockCount === 1 ? '' : 's'}, ${brickCount} brick` +
        `${brickCount === 1 ? '' : 's'}, ${supplyCount} supply item` +
        `${supplyCount === 1 ? '' : 's'}, and the active template ` +
        "assignment. You'll be able to pick a new template or rebuild " +
        'manually. This action syncs to the cloud — there is no undo.',
      confirmLabel: 'Reset everything',
      variant: 'destructive',
    })
    if (!ok) return
    setBlockLibrary({})
    setBrickLibrary({})
    updateUserSettings({
      preferences: { libraryTemplateKey: undefined },
      supplyItems: [],
    })
  }

  return (
    <>
      <div className="mb-6 flex items-center justify-between gap-3 p-4 rounded-xl border border-ink-600 bg-ink-800/60 flex-wrap">
        <div className="min-w-0">
          <div className="text-[10px] uppercase tracking-wide text-ink-500 font-semibold">
            Library template
          </div>
          <div className="text-sm font-medium text-ink-100 mt-0.5">
            {currentTemplate ? (
              <>
                {currentTemplate.displayName}{' '}
                <span className="text-ink-500 font-mono font-normal">
                  · {blockCount} block{blockCount === 1 ? '' : 's'},{' '}
                  {brickCount} brick{brickCount === 1 ? '' : 's'},{' '}
                  {supplyCount} suppl{supplyCount === 1 ? 'y' : 'ies'}
                </span>
              </>
            ) : blockCount === 0 && brickCount === 0 ? (
              <span className="text-ink-400">
                Empty — pick a regional preset to get started
              </span>
            ) : (
              <span>
                Custom library{' '}
                <span className="text-ink-500 font-mono font-normal">
                  · {blockCount} block{blockCount === 1 ? '' : 's'},{' '}
                  {brickCount} brick{brickCount === 1 ? '' : 's'},{' '}
                  {supplyCount} suppl{supplyCount === 1 ? 'y' : 'ies'}
                </span>
              </span>
            )}
          </div>
        </div>
        {!readOnly && (
          <div className="flex gap-2 flex-shrink-0">
            <button
              onClick={() => setShowPicker(true)}
              className="text-sm px-4 py-2 rounded-lg bg-beme-500 text-black font-medium hover:bg-beme-400 transition-colors"
            >
              {currentTemplate ? 'Switch template' : 'Pick a regional preset'}
            </button>
            {(blockCount > 0 || brickCount > 0 || supplyCount > 0) && (
              <button
                onClick={handleResetAll}
                className="text-sm px-4 py-2 rounded-lg border border-rose-500/50 text-rose-300 hover:bg-rose-500/10 transition-colors"
              >
                Reset entire library
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
