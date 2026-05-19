import { memo, useState } from 'react'
import type { BrickSettings } from '../types/walls'

interface BrickAdditionsPanelProps {
  settings: BrickSettings
  onChange: (settings: BrickSettings) => void
}

/**
 * Brick "supplied additions" — items that ride along with brickwork at a
 * defined rate. Today that's brick ties (per m² of brickwork) and
 * plascourse (per lineal m of brickwork). Each item is independently
 * toggleable and carries its own quantity per unit.
 *
 * This panel replaces the old BrickSettingsPanel for ties + plascourse;
 * default wall height and brick type now live on each individual
 * BrickMakeup in the Brick wall types panel.
 */
function BrickAdditionsPanelImpl({ settings, onChange }: BrickAdditionsPanelProps) {
  const [expanded, setExpanded] = useState(true)

  function patch(p: Partial<BrickSettings>) {
    onChange({ ...settings, ...p })
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
          Supplied additions
        </h3>
        <span className="text-xs text-ink-400 truncate min-w-0">
          {settings.ties.enabled && `· ${settings.ties.perSquareMetre}/m² ties`}
          {settings.plascourse.enabled &&
            ` · 1 plascourse / ${settings.plascourse.metresPerUnit} m`}
          {!settings.ties.enabled && !settings.plascourse.enabled && '· none'}
        </span>
      </button>

      {expanded && (
        <>
          {/* Brick ties — quantity per square metre */}
          <div className="mb-3 p-3 border border-ink-600 rounded-lg bg-ink-700/40">
            <label className="flex items-center gap-2 text-sm font-medium text-ink-200 cursor-pointer">
              <input
                type="checkbox"
                checked={settings.ties.enabled}
                onChange={(e) =>
                  patch({ ties: { ...settings.ties, enabled: e.target.checked } })
                }
              />
              <span>Brick ties</span>
            </label>
            {settings.ties.enabled && (
              <div className="mt-2 ml-6 flex items-center gap-2 text-sm flex-wrap">
                <input
                  type="number"
                  min="0"
                  step="0.1"
                  value={settings.ties.perSquareMetre}
                  onChange={(e) =>
                    patch({
                      ties: {
                        ...settings.ties,
                        perSquareMetre: parseFloat(e.target.value || '0') || 0,
                      },
                    })
                  }
                  className="w-20 px-2 py-1 border border-ink-600 rounded text-sm bg-ink-900 text-ink-50"
                />
                <span className="text-ink-300">ties per m² of brickwork</span>
              </div>
            )}
          </div>

          {/* Plascourse — one unit per N lineal metres */}
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
              <span>Plascourse</span>
            </label>
            {settings.plascourse.enabled && (
              <div className="mt-2 ml-6 flex items-center gap-2 text-sm flex-wrap">
                <span className="text-ink-300">1 unit per</span>
                <input
                  type="number"
                  min="0"
                  step="0.5"
                  value={settings.plascourse.metresPerUnit}
                  onChange={(e) =>
                    patch({
                      plascourse: {
                        ...settings.plascourse,
                        metresPerUnit: parseFloat(e.target.value || '0') || 0,
                      },
                    })
                  }
                  className="w-20 px-2 py-1 border border-ink-600 rounded text-sm bg-ink-900 text-ink-50"
                />
                <span className="text-ink-300">lineal metres of brickwork</span>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}

const BrickAdditionsPanel = memo(BrickAdditionsPanelImpl)
export default BrickAdditionsPanel
