import { useState } from 'react'
import type {
  BlockExportInclusions,
  Opening,
  ProjectDetails,
  Wall,
  WallMakeup,
} from '../types/walls'
import { exportBlockEstimate } from '../lib/blockExport'

interface BlockExportPanelProps {
  projectDetails: ProjectDetails
  inclusions: BlockExportInclusions
  onChangeInclusions: (inclusions: BlockExportInclusions) => void
  walls: Wall[]
  makeups: WallMakeup[]
  openings: Opening[]
}

export default function BlockExportPanel({
  projectDetails,
  inclusions,
  onChangeInclusions,
  walls,
  makeups,
  openings,
}: BlockExportPanelProps) {
  // Collapsed by default in the rail — export is end-of-workflow.
  const [expanded, setExpanded] = useState(false)

  function patch(p: Partial<BlockExportInclusions>) {
    onChangeInclusions({ ...inclusions, ...p })
  }

  function handleExport() {
    exportBlockEstimate({
      projectDetails,
      inclusions,
      walls,
      makeups,
      openings,
    })
  }

  const canExport = walls.length > 0

  return (
    <div className="my-4 border border-neutral-200 rounded-xl bg-white p-3">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-2 text-left group mb-2"
      >
        <span className="text-neutral-400 group-hover:text-neutral-600 text-xs">
          {expanded ? '▾' : '▸'}
        </span>
        <h3 className="text-sm font-semibold text-neutral-700 group-hover:text-beme-700">
          Export estimate
        </h3>
        {!expanded && (
          <span className="text-xs text-neutral-500 truncate">
            · {Object.values(inclusions).filter(Boolean).length} sections selected
          </span>
        )}
      </button>

      {!expanded && (
        <button
          onClick={handleExport}
          disabled={!canExport}
          className="w-full px-3 py-1.5 rounded-lg bg-beme-600 text-white text-sm hover:bg-beme-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors font-medium"
        >
          Export estimate →
        </button>
      )}

      {expanded && (
        <>
          <p className="text-xs text-neutral-500 mb-2">
            Tick what you want in the document, then click Export. A printable page opens in a
            new tab — use your browser's <em>Print → Save as PDF</em> to save it.
          </p>

          <div className="grid grid-cols-1 gap-1.5 text-sm mb-3">
            <Toggle
              label="Assumptions page"
              checked={inclusions.assumptions}
              onChange={(v) => patch({ assumptions: v })}
            />
            <Toggle
              label="Block schedule"
              checked={inclusions.blockSchedule}
              onChange={(v) => patch({ blockSchedule: v })}
            />
            <Toggle
              label="Breakdown by wall type"
              checked={inclusions.wallTypeBreakdown}
              onChange={(v) => patch({ wallTypeBreakdown: v })}
              disabled={makeups.length === 0}
              disabledHint="Define at least one wall type first"
            />
            <Toggle
              label="Openings & lintels"
              checked={inclusions.openingsList}
              onChange={(v) => patch({ openingsList: v })}
              disabled={openings.length === 0}
              disabledHint="Add at least one opening first"
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
            className="w-full px-3 py-1.5 rounded-lg bg-beme-600 text-white text-sm hover:bg-beme-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors font-medium"
          >
            Export estimate →
          </button>

          {!canExport && (
            <p className="text-xs text-neutral-500 mt-2">
              Draw at least one wall before exporting.
            </p>
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
    </label>
  )
}
