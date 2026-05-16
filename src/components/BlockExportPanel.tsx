import { useState } from 'react'
import type {
  BlockExportInclusions,
  Opening,
  Pier,
  PierMakeup,
  ProjectDetails,
  Wall,
  WallMakeup,
} from '../types/walls'
import { exportBlockEstimate } from '../lib/blockExport'
import { useUserSettings } from '../lib/userSettings'

interface BlockExportPanelProps {
  projectDetails: ProjectDetails
  inclusions: BlockExportInclusions
  onChangeInclusions: (inclusions: BlockExportInclusions) => void
  walls: Wall[]
  makeups: WallMakeup[]
  openings: Opening[]
  piers?: Pier[]
  pierMakeups?: PierMakeup[]
}

export default function BlockExportPanel({
  projectDetails,
  inclusions,
  onChangeInclusions,
  walls,
  makeups,
  openings,
  piers = [],
  pierMakeups = [],
}: BlockExportPanelProps) {
  // Collapsed by default in the rail — export is end-of-workflow.
  const [expanded, setExpanded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { settings: userSettings } = useUserSettings()

  function patch(p: Partial<BlockExportInclusions>) {
    onChangeInclusions({ ...inclusions, ...p })
  }

  async function handleExport() {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await exportBlockEstimate({
        projectDetails,
        inclusions,
        walls,
        makeups,
        openings,
        piers,
        pierMakeups,
        // Pass the user's business identity through so exports become branded.
        business: {
          companyName: userSettings.business.companyName,
          abn: userSettings.business.abn,
          phone: userSettings.business.phone,
          website: userSettings.business.website,
          addressLine1: userSettings.business.addressLine1,
          addressLine2: userSettings.business.addressLine2,
          suburb: userSettings.business.suburb,
          state: userSettings.business.state,
          postcode: userSettings.business.postcode,
          logoUrl: userSettings.business.logoUrl,
        },
      })
    } catch (e) {
      setError((e as Error).message ?? 'Export failed')
    } finally {
      setBusy(false)
    }
  }

  const canExport = walls.length > 0 && !busy

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
          className="w-full px-3 py-1.5 rounded-lg bg-beme-500 text-black text-sm hover:bg-beme-400 disabled:opacity-40 disabled:cursor-not-allowed transition-colors font-medium"
        >
          {busy ? 'Opening print dialog…' : 'Save as PDF →'}
        </button>
      )}

      {expanded && (
        <>
          <p className="text-xs text-ink-400 mb-2">
            Tick what you want in the document, then click <em>Save as PDF</em>. The print
            dialog opens with your estimate already loaded — pick <em>Save as PDF</em> as
            the destination.
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
            className="w-full px-3 py-1.5 rounded-lg bg-beme-500 text-black text-sm hover:bg-beme-400 disabled:opacity-40 disabled:cursor-not-allowed transition-colors font-medium"
          >
            {busy ? 'Opening print dialog…' : 'Save as PDF →'}
          </button>

          {walls.length === 0 && (
            <p className="text-xs text-ink-400 mt-2">
              Draw at least one wall before exporting.
            </p>
          )}
          {error && (
            <p className="text-xs text-rose-300 mt-2">
              Couldn't build the PDF — {error}
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
