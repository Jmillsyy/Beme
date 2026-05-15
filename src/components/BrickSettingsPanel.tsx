import { useState } from 'react'
import type { BrickSettings } from '../types/walls'

interface BrickSettingsPanelProps {
  settings: BrickSettings
  onChange: (settings: BrickSettings) => void
}

export default function BrickSettingsPanel({ settings, onChange }: BrickSettingsPanelProps) {
  const [expanded, setExpanded] = useState(true)

  function patch(p: Partial<BrickSettings>) {
    onChange({ ...settings, ...p })
  }

  return (
    <div className="my-4 border border-neutral-200 rounded-xl bg-white p-4">
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <div className="flex items-center gap-3">
          <h3 className="text-sm font-semibold text-neutral-700">Brick settings</h3>
          {!expanded && (
            <span className="text-xs text-neutral-500">
              {settings.defaultWallHeightMm}mm walls · {settings.bricksPerSquareMetre} bricks/m²
              {settings.ties.enabled && ` · ${settings.ties.perSquareMetre} ties/m²`}
              {settings.plascourse.enabled &&
                ` · plascourse 1/${settings.plascourse.metresPerUnit}m`}
            </span>
          )}
        </div>
        <button
          onClick={() => setExpanded((v) => !v)}
          className="text-sm text-beme-600 hover:text-beme-700 hover:underline"
        >
          {expanded ? '− Hide' : '+ Show'}
        </button>
      </div>

      {expanded && (
        <>
      {/* General */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
        <label className="text-sm">
          <span className="block text-neutral-600 mb-1">Default wall height (mm)</span>
          <input
            type="number"
            min="200"
            step="50"
            value={settings.defaultWallHeightMm}
            onChange={(e) => patch({ defaultWallHeightMm: parseInt(e.target.value || '0', 10) })}
            className="w-full px-3 py-1.5 border border-neutral-300 rounded-lg text-sm focus:outline-none focus:border-beme-500"
          />
        </label>

        <label className="text-sm">
          <span className="block text-neutral-600 mb-1">Bricks per m²</span>
          <input
            type="number"
            min="1"
            step="1"
            value={settings.bricksPerSquareMetre}
            onChange={(e) =>
              patch({ bricksPerSquareMetre: parseFloat(e.target.value || '0') || 0 })
            }
            className="w-full px-3 py-1.5 border border-neutral-300 rounded-lg text-sm focus:outline-none focus:border-beme-500"
          />
        </label>
      </div>

      {/* Brick ties */}
      <div className="mb-4 p-3 border border-neutral-200 rounded-lg bg-neutral-50">
        <label className="flex items-center gap-2 text-sm font-medium text-neutral-700 cursor-pointer">
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
              <span className="text-neutral-600">Rate:</span>
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
                className="px-2 py-1 border border-neutral-300 rounded text-sm bg-white"
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
      <div className="p-3 border border-neutral-200 rounded-lg bg-neutral-50">
        <label className="flex items-center gap-2 text-sm font-medium text-neutral-700 cursor-pointer">
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
            <span className="text-neutral-600">1 plascourse per</span>
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
              className="px-2 py-1 border border-neutral-300 rounded text-sm bg-white w-20"
            />
            <span className="text-neutral-600">metres of brickwork</span>
          </div>
        )}
      </div>
        </>
      )}
    </div>
  )
}
