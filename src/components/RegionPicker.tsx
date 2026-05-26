import { useEffect, useState } from 'react'
import {
  LIBRARY_TEMPLATES,
  getLibraryTemplate,
  type LibraryTemplateKey,
} from '../data/libraryTemplates'
import { getBlockLibrary, setBlockLibrary } from '../data/blockLibrary'
import { BRICK_LIBRARY, setBrickLibrary } from '../data/brickLibrary'
import { updateUserSettings, getUserSettings } from '../lib/userSettings'

interface RegionPickerProps {
  /** Show a "Skip" option so the user can dismiss without picking — used
   *  on opt-in surfaces (Settings → switch template). For onboarding
   *  surfaces where a pick is required, set this false. */
  allowSkip?: boolean
  /**
   * Called after the user successfully picks a template AND the library
   * has been seeded. The chosen key is also persisted into
   * userSettings.preferences.libraryTemplateKey.
   */
  onPicked: (key: LibraryTemplateKey) => void
  /**
   * Called when the user dismisses the modal without picking. Only fires
   * when `allowSkip` is true.
   */
  onCancel?: () => void
}

/**
 * Modal that asks the user to pick a regional library template. Each
 * template is rendered as a card with its name, region, mortar joint,
 * description, and a per-card "Use this template" button.
 *
 * Behaviour when picked:
 *   - If the library is currently empty OR matches the AU-SEQ default
 *     verbatim → seed it with the chosen template wholesale
 *   - If the library has CUSTOM blocks (user added their own) → ask the
 *     user whether to merge (keep custom blocks AND add template blocks)
 *     or replace (drop everything, seed fresh from template).
 *
 * In all cases the chosen key is stored on userSettings so future
 * sessions can show the active template name + a "Switch template"
 * affordance without re-prompting.
 */
export default function RegionPicker({
  allowSkip = true,
  onPicked,
  onCancel,
}: RegionPickerProps) {
  const settings = getUserSettings()
  const currentKey = settings.preferences.libraryTemplateKey
  const [highlightKey, setHighlightKey] = useState<LibraryTemplateKey>(
    currentKey ?? 'au-seq'
  )

  // Escape closes when allowed — same UX as the other modals in the app.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && allowSkip && onCancel) onCancel()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [allowSkip, onCancel])

  function applyTemplate(key: LibraryTemplateKey) {
    const template = getLibraryTemplate(key)
    if (!template) return
    const currentBlocks = getBlockLibrary()
    const currentBlockCodes = Object.keys(currentBlocks)
    const currentBricks = BRICK_LIBRARY
    const currentBrickCodes = Object.keys(currentBricks)

    // If the user already has items in their library, switching is
    // destructive — confirm before wiping. Items in the OLD library
    // that aren't in the new template are lost; items already in the
    // new template come back fresh. The whole library is overwritten
    // wholesale (no merge) so the user always ends up with exactly
    // the new template's content + nothing else.
    const isAlreadyClean =
      currentBlockCodes.length === 0 && currentBrickCodes.length === 0
    const isSameTemplate = settings.preferences.libraryTemplateKey === key

    if (!isAlreadyClean && !isSameTemplate) {
      const lossParts = [
        currentBlockCodes.length > 0
          ? `${currentBlockCodes.length} block${currentBlockCodes.length === 1 ? '' : 's'}`
          : '',
        currentBrickCodes.length > 0
          ? `${currentBrickCodes.length} brick${currentBrickCodes.length === 1 ? '' : 's'}`
          : '',
      ]
        .filter(Boolean)
        .join(' + ')
      const ok = window.confirm(
        `Switch to ${template.displayName}?\n\n` +
          `This will REPLACE your current library — your ${lossParts} ` +
          'will be deleted, and the new template will be loaded fresh.\n\n' +
          'Any custom blocks or bricks you added will be lost. Cancel ' +
          'if you want to keep them.'
      )
      if (!ok) return
    }

    setBlockLibrary({ ...template.blocks })
    setBrickLibrary({ ...template.bricks })
    updateUserSettings({
      preferences: { libraryTemplateKey: key },
    })
    onPicked(key)
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={allowSkip ? onCancel : undefined}
      role="dialog"
      aria-modal="true"
      aria-label="Pick a regional library template"
    >
      <div
        className="bg-ink-800 border border-ink-600 rounded-2xl shadow-2xl w-full max-w-3xl max-h-[88vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <header className="px-5 py-4 border-b border-ink-600 bg-ink-900/40">
          <h2 className="text-base font-semibold text-ink-100">
            Pick your region
          </h2>
          <p className="text-xs text-ink-400 mt-1">
            Beme seeds your block library with a regional set so the calc
            engine knows what blocks you use. You can edit / add / remove
            blocks any time from the material library.
          </p>
        </header>

        {/* Templates */}
        <div className="flex-1 overflow-y-auto p-5 space-y-3">
          {LIBRARY_TEMPLATES.map((t) => {
            const isActive = t.key === currentKey
            const isHighlight = t.key === highlightKey
            return (
              <button
                key={t.key}
                onClick={() => setHighlightKey(t.key)}
                onDoubleClick={() => applyTemplate(t.key)}
                className={`block w-full text-left rounded-xl border p-4 transition-colors ${
                  isHighlight
                    ? 'border-beme-500 bg-beme-500/10 ring-2 ring-beme-500/20'
                    : 'border-ink-600 hover:border-beme-500/50 bg-ink-700/40'
                }`}
              >
                <div className="flex items-start justify-between gap-3 mb-1">
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-ink-100">
                      {t.displayName}
                    </div>
                    <div className="text-[11px] text-ink-500 font-mono mt-0.5">
                      {t.region} · {Object.keys(t.blocks).length} blocks ·{' '}
                      mortar joint {t.mortarJointMm} mm
                    </div>
                  </div>
                  {isActive && (
                    <span className="text-[10px] px-2 py-0.5 rounded bg-beme-500 text-black font-medium flex-shrink-0">
                      Current
                    </span>
                  )}
                </div>
                <p className="text-xs text-ink-300 leading-relaxed">
                  {t.description}
                </p>
              </button>
            )
          })}
        </div>

        {/* Footer */}
        <footer className="px-5 py-3 border-t border-ink-600 bg-ink-900/40 flex items-center justify-end gap-2">
          {allowSkip && onCancel && (
            <button
              onClick={onCancel}
              className="px-4 py-1.5 rounded-lg border border-ink-600 text-sm text-ink-200 hover:bg-ink-700 transition-colors"
            >
              Cancel
            </button>
          )}
          <button
            onClick={() => applyTemplate(highlightKey)}
            className="px-4 py-1.5 rounded-lg bg-beme-500 text-black text-sm font-medium hover:bg-beme-400 transition-colors"
          >
            Use {getLibraryTemplate(highlightKey)?.displayName ?? 'this template'}
          </button>
        </footer>
      </div>
    </div>
  )
}
