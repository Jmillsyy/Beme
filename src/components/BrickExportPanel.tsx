import { useState } from 'react'
import type {
  BrickExportInclusions,
  BrickSettings,
  Opening,
  ProjectDetails,
  Wall,
} from '../types/walls'
import { exportBrickEstimate } from '../lib/brickExport'

interface BrickExportPanelProps {
  projectDetails: ProjectDetails
  inclusions: BrickExportInclusions
  onChangeInclusions: (inclusions: BrickExportInclusions) => void
  settings: BrickSettings
  walls: Wall[]
  openings: Opening[]
}

export default function BrickExportPanel({
  projectDetails,
  inclusions,
  onChangeInclusions,
  settings,
  walls,
  openings,
}: BrickExportPanelProps) {
  // Collapsed by default in the rail — export is end-of-workflow so it shouldn't
  // take space while you're drawing.
  const [expanded, setExpanded] = useState(false)

  function patch(p: Partial<BrickExportInclusions>) {
    onChangeInclusions({ ...inclusions, ...p })
  }

  function handleExport() {
    exportBrickEstimate({
      projectDetails,
      inclusions,
      walls,
      openings,
      settings,
    })
  }

  const canExport = walls.length > 0

  return (
    <div className="my-4 border border-ink-600 rounded-xl bg-ink-800 p-3">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-2 text-left group mb-2"
      >
        <span className="text-ink-500 group-hover:text-neutral-600 text-xs">
          {expanded ? '▾' : '▸'}
        </span>
        <h3 className="text-sm font-semibold text-ink-50 group-hover:text-beme-300">
          Export estimate
        </h3>
        {!expanded && (
          <span className="text-xs text-ink-400 truncate">
            · {Object.values(inclusions).filter(Boolean).length} sections selected
          </span>
        )}
      </button>

      {!expanded && (
        <button
          onClick={handleExport}
          disabled={!canExport}
          className="w-full px-3 py-1.5 rounded-lg bg-beme-500 text-black text-sm hover:bg-beme-400 font-medium disabled:opacity-40 disabled:cursor-not-allowed transition-colors font-medium"
        >
          Export estimate →
        </button>
      )}

      {expanded && (
        <>
      <p className="text-xs text-ink-400 mb-2">
        Tick what you want in the document, then click Export. A printable page opens in a new
        tab — use your browser's <em>Print → Save as PDF</em> to save it.
      </p>

      <div className="grid grid-cols-1 gap-1.5 text-sm mb-3">
        <Toggle
          label="Assumptions page"
          checked={inclusions.assumptions}
          onChange={(v) => patch({ assumptions: v })}
        />
        <Toggle
          label="Brick area summary"
          checked={inclusions.brickAreaSummary}
          onChange={(v) => patch({ brickAreaSummary: v })}
        />
        <Toggle
          label="Lintels"
          checked={inclusions.lintels}
          onChange={(v) => patch({ lintels: v })}
        />
        <Toggle
          label="Brick ties"
          checked={inclusions.brickTies}
          onChange={(v) => patch({ brickTies: v })}
          disabled={!settings.ties.enabled}
          disabledHint="Enable brick ties in Brick settings first"
        />
        <Toggle
          label="Plascourse"
          checked={inclusions.plascourse}
          onChange={(v) => patch({ plascourse: v })}
          disabled={!settings.plascourse.enabled}
          disabledHint="Enable plascourse in Brick settings first"
        />
        <Toggle
          label="Disclaimer page"
          checked={inclusions.disclaimer}
          onChange={(v) => patch({ disclaimer: v })}
        />
      </div>

      <button
        onClick={handleExport}
        disabled={!canExport}
        className="w-full px-3 py-1.5 rounded-lg bg-beme-500 text-black text-sm hover:bg-beme-400 font-medium disabled:opacity-40 disabled:cursor-not-allowed transition-colors font-medium"
      >
        Export estimate →
      </button>

      {!canExport && (
        <p className="text-xs text-ink-400 mt-2">Draw at least one wall before exporting.</p>
      )}
        </>
      )}
    </div>
  )
}

function Toggle({
  label,
  checked,
  onChange,
  disabled,
  disabledHint,
}: {
  label: string
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
  disabledHint?: string
}) {
  return (
    <label
      className={`flex items-center gap-2 cursor-pointer ${
        disabled ? 'opacity-50 cursor-not-allowed' : ''
      }`}
      title={disabled ? disabledHint : undefined}
    >
      <input
        type="checkbox"
        checked={checked && !disabled}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>{label}</span>
      {disabled && disabledHint && (
        <span className="text-xs text-ink-500 ml-1">— {disabledHint}</span>
      )}
    </label>
  )
}
