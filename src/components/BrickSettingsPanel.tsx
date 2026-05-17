import { memo, useMemo, useState } from 'react'
import type { BrickSettings } from '../types/walls'
import { bricksPerSquareMetreOf } from '../types/bricks'
import { useBrickLibrary } from '../data/brickLibrary'

interface BrickSettingsPanelProps {
  settings: BrickSettings
  onChange: (settings: BrickSettings) => void
}

/**
 * Memoised so that re-renders of PdfWorkspace driven by zoom or pan don't
 * trigger a re-render here. The panel's content only changes when the user
 * edits brick settings or the brick library, neither of which fires during
 * a zoom gesture.
 */
function BrickSettingsPanelImpl({ settings, onChange }: BrickSettingsPanelProps) {
  const [expanded, setExpanded] = useState(true)
  const { library: brickLibrary } = useBrickLibrary()

  // Sorted list for the dropdown: smallest face area first.
  const brickTypes = useMemo(
    () => Object.values(brickLibrary).sort((a, b) => a.heightMm - b.heightMm),
    [brickLibrary]
  )

  /** Derived rate from the active brick type — or null if no type selected / found. */
  const derivedRate = useMemo(() => {
    if (!settings.brickTypeCode) return null
    const type = brickLibrary[settings.brickTypeCode]
    if (!type) return null
    return bricksPerSquareMetreOf(type)
  }, [settings.brickTypeCode, brickLibrary])

  const usingDerived =
    derivedRate !== null && derivedRate === settings.bricksPerSquareMetre

  function patch(p: Partial<BrickSettings>) {
    onChange({ ...settings, ...p })
  }

  function handleBrickTypeChange(code: string) {
    const type = brickLibrary[code]
    if (!type) {
      patch({ brickTypeCode: code })
      return
    }
    // When the user picks a type, snap bricks/m² to the auto-derived rate.
    // They can still tweak it manually below.
    patch({
      brickTypeCode: code,
      bricksPerSquareMetre: bricksPerSquareMetreOf(type),
    })
  }

  return (
    <div className="my-4 border border-ink-600 rounded-xl bg-ink-800 p-3">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-2 text-left group mb-2"
      >
        <span className="text-ink-500 group-hover:text-ink-300 text-xs">
          {expanded ? '▾' : '▸'}
        </span>
        <h3 className="text-sm font-semibold text-ink-200 group-hover:text-beme-300">
          Brick settings
        </h3>
        {!expanded && (
          <span className="text-xs text-ink-400 truncate min-w-0">
            · {settings.defaultWallHeightMm}mm · {settings.bricksPerSquareMetre}/m²
            {settings.ties.enabled && ` · ties`}
            {settings.plascourse.enabled && ` · plascourse`}
          </span>
        )}
      </button>

      {expanded && (
        <>
      {/* General */}
      <div className="grid grid-cols-1 gap-3 mb-3">
        <label className="text-sm">
          <span className="block text-ink-300 mb-1">Default wall height (mm)</span>
          <input
            type="number"
            min="200"
            step="50"
            value={settings.defaultWallHeightMm}
            onChange={(e) => patch({ defaultWallHeightMm: parseInt(e.target.value || '0', 10) })}
            className="w-full px-3 py-1.5 border border-ink-600 rounded-lg text-sm bg-ink-900 text-ink-50 focus:outline-none focus:border-beme-400"
          />
        </label>

        <label className="text-sm">
          <span className="block text-ink-300 mb-1">Brick type</span>
          <select
            value={settings.brickTypeCode ?? ''}
            onChange={(e) => handleBrickTypeChange(e.target.value)}
            className="w-full px-3 py-1.5 border border-ink-600 rounded-lg text-sm bg-ink-900 text-ink-50 focus:outline-none focus:border-beme-400"
          >
            <option value="">— Manual rate only —</option>
            {brickTypes.map((t) => (
              <option key={t.code} value={t.code}>
                {t.name} · {bricksPerSquareMetreOf(t)}/m²
              </option>
            ))}
          </select>
          <span className="text-[11px] text-ink-400 mt-1 block">
            Set up brick types in the Brick library panel below.
          </span>
        </label>

        <label className="text-sm">
          <span className="block text-ink-300 mb-1">
            Bricks per m²
            {usingDerived && (
              <span className="text-beme-300 text-xs"> · auto from brick type</span>
            )}
            {!usingDerived && derivedRate !== null && (
              <button
                type="button"
                onClick={() => patch({ bricksPerSquareMetre: derivedRate })}
                className="text-beme-400 hover:text-beme-300 text-xs ml-2 underline"
                title="Snap back to the auto-derived rate"
              >
                · reset to auto ({derivedRate}/m²)
              </button>
            )}
          </span>
          <input
            type="number"
            min="1"
            step="1"
            value={settings.bricksPerSquareMetre}
            onChange={(e) =>
              patch({ bricksPerSquareMetre: parseFloat(e.target.value || '0') || 0 })
            }
            className="w-full px-3 py-1.5 border border-ink-600 rounded-lg text-sm bg-ink-900 text-ink-50 focus:outline-none focus:border-beme-400"
          />
        </label>
      </div>

      {/* Brick ties */}
      <div className="mb-4 p-3 border border-ink-600 rounded-lg bg-ink-700/40">
        <label className="flex items-center gap-2 text-sm font-medium text-ink-200 cursor-pointer">
          <input
            type="checkbox"
            checked={settings.ties.enabled}
            onChange={(e) =>
              patch({ ties: { ...settings.ties, enabled: e.target.checked } })
            }
          />
          <span>Include brick ties</span>
        </label>
        {settings.ties.enabled && (
          <div className="mt-2 ml-6 flex items-center gap-2 text-sm">
            <label className="flex items-center gap-2">
              <span className="text-ink-300">Rate:</span>
              <select
                value={settings.ties.perSquareMetre}
                onChange={(e) =>
                  patch({
                    ties: {
                      ...settings.ties,
                      perSquareMetre: parseInt(e.target.value, 10),
                    },
                  })
                }
                className="px-2 py-1 border border-ink-600 rounded text-sm bg-ink-800"
              >
                <option value={1}>1 per m²</option>
                <option value={2}>2 per m²</option>
                <option value={3}>3 per m²</option>
                <option value={4}>4 per m²</option>
              </select>
            </label>
          </div>
        )}
      </div>

      {/* Plascourse */}
      <div className="p-3 border border-ink-600 rounded-lg bg-ink-700/40">
        <label className="flex items-center gap-2 text-sm font-medium text-ink-200 cursor-pointer">
          <input
            type="checkbox"
            checked={settings.plascourse.enabled}
            onChange={(e) =>
              patch({
                plascourse: { ...settings.plascourse, enabled: e.target.checked },
              })
            }
          />
          <span>Include plascourse</span>
        </label>
        {settings.plascourse.enabled && (
          <div className="mt-2 ml-6 flex items-center gap-2 text-sm">
            <span className="text-ink-300">1 plascourse per</span>
            <input
              type="number"
              min="1"
              step="1"
              value={settings.plascourse.metresPerUnit}
              onChange={(e) =>
                patch({
                  plascourse: {
                    ...settings.plascourse,
                    metresPerUnit: parseFloat(e.target.value || '0') || 0,
                  },
                })
              }
              className="px-2 py-1 border border-ink-600 rounded text-sm bg-ink-800 w-20"
            />
            <span className="text-ink-300">metres of brickwork</span>
          </div>
        )}
      </div>
        </>
      )}
    </div>
  )
}

const BrickSettingsPanel = memo(BrickSettingsPanelImpl)
export default BrickSettingsPanel
