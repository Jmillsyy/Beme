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
    <div className="mt-6 border border-neutral-200 rounded-xl bg-white p-4">
      <div className="flex items-center justify-between mb-3 flex-wrap gap-3">
        <div>
          <h3 className="text-sm font-semibold text-neutral-700">Export estimate</h3>
          <p className="text-xs text-neutral-500">
            Tick what you want in the document, then click Export. A printable page opens in
            a new tab — use your browser's <em>Print → Save as PDF</em> to save it.
          </p>
        </div>
        <button
          onClick={handleExport}
          disabled={!canExport}
          className="px-4 py-2 rounded-lg bg-beme-600 text-white text-sm hover:bg-beme-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors font-medium"
        >
          Export estimate →
        </button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm">
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

      {!canExport && (
        <p className="text-xs text-neutral-500 mt-3">
          Draw at least one wall before exporting.
        </p>
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
        <span className="text-xs text-neutral-400 ml-1">— {disabledHint}</span>
      )}
    </label>
  )
}
