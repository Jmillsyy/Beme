import { memo, useMemo, useState } from 'react'
import type { BrickMakeup, BrickSettings, Opening, Wall } from '../types/walls'
import { calculateBrickTally } from '../lib/brickCalc'
import { useBrickLibrary } from '../data/brickLibrary'
import { useUserSettings } from '../lib/userSettings'
import { brickLintelWarnings } from '../lib/lintelCoverage'
import LintelCoverageBand from './LintelCoverageBand'

interface BrickTallyPanelProps {
  walls: Wall[]
  openings: Opening[]
  settings: BrickSettings
  /** Brick wall types — needed for per-makeup course composition. */
  makeups?: BrickMakeup[]
}

/**
 * Right-rail tally for brick estimates — wall count, total length,
 * total brickwork area, brick count. Supply items (ties, plascourse,
 * lintels, flashings, etc.) live in the SupplyItemsPanel and are
 * managed via the material library.
 *
 * When at least one brick wall type uses `courseRanges`, the panel
 * shows a per-brick-type breakdown (e.g. "↳ Standard 230×76 — 540 /
 * ↳ Double-height 230×162 — 1,210") under the headline brick count so
 * the reader can see the mix at a glance. Single-brick projects keep
 * the old single-line look.
 *
 * Memoised so re-renders driven by zoom / pan don't recompute the tally.
 */
function BrickTallyPanelImpl({ walls, openings, settings, makeups }: BrickTallyPanelProps) {
  const [expanded, setExpanded] = useState(true)
  // Subscribe to brick-library version so a rate change on a library
  // brick re-tallies immediately (the per-band counts read the rate
  // off each band's brick type at calc time).
  const { version: brickLibraryVersion } = useBrickLibrary()
  const { settings: userSettings } = useUserSettings()

  const tally = useMemo(() => {
    void brickLibraryVersion
    return calculateBrickTally(walls, openings, settings, makeups)
  }, [walls, openings, settings, makeups, brickLibraryVersion])

  // Lintel coverage warnings — surfaces openings whose width doesn't
  // match any per-opening lintel supply item with a width range, and
  // overlapping ranges that would double-count. See lib/lintelCoverage.
  const lintelWarnings = useMemo(
    () => brickLintelWarnings(openings, userSettings.supplyItems),
    [openings, userSettings.supplyItems],
  )

  if (walls.length === 0) {
    return (
      <div className="border border-dashed border-ink-600 rounded-xl p-6 text-center text-ink-400 text-sm">
        Draw your first wall to see the brick tally.
      </div>
    )
  }

  const areaSqM = tally.totalAreaSqMm / 1_000_000
  const lengthM = tally.totalLinealMm / 1000
  // Lineal-metre figures the export relies on. Surface them in the
  // workspace tally too so the user sees the head / sill totals at
  // a glance without generating the PDF first. Course substitute
  // was removed in favour of the simpler "Total length" row above
  // — the per-course-pitch math was confusing the user and the
  // total wall lineal m gives them what they actually wanted.
  const headLinealM =
    Object.values(tally.headLinealMmByType).reduce((s, n) => s + n, 0) / 1000
  const sillLinealM =
    Object.values(tally.sillLinealMmByType).reduce((s, n) => s + n, 0) / 1000

  return (
    <div className="border border-ink-600 rounded-xl bg-ink-800 overflow-hidden">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full bg-ink-700 px-3 py-2 border-b border-ink-600 flex items-center justify-between gap-2 text-left group"
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-beme-400 group-hover:text-beme-300 text-xs">
            {expanded ? '▾' : '▸'}
          </span>
          <h3 className="text-sm font-bold text-beme-300">Brick tally</h3>
          <span className="text-xs text-beme-300 tabular-nums truncate">
            · {areaSqM.toFixed(2)} m²
          </span>
        </div>
        <span className="text-xs text-beme-300 tabular-nums flex-shrink-0">
          {tally.wallCount} wall{tally.wallCount === 1 ? '' : 's'}
        </span>
      </button>

      {expanded && lintelWarnings.length > 0 && (
        <div className="px-3 pt-3">
          <LintelCoverageBand warnings={lintelWarnings} />
        </div>
      )}

      {expanded && (
        <table className="w-full text-sm">
          <tbody>
            <tr className="border-b border-ink-700/60">
              <td className="px-3 py-1.5 text-ink-300">Total length</td>
              <td className="px-3 py-1.5 text-right font-semibold tabular-nums">
                {lengthM.toFixed(2)} m
              </td>
            </tr>
            <tr className="border-b border-ink-700/60 bg-ink-700/30">
              <td className="px-3 py-1.5 text-ink-200 font-medium">Brickwork area</td>
              <td className="px-3 py-1.5 text-right font-semibold tabular-nums text-beme-300">
                {areaSqM.toFixed(2)} m²
              </td>
            </tr>
            <tr className="border-b border-ink-700/60">
              <td className="px-3 py-1.5 text-ink-300">Openings</td>
              <td className="px-3 py-1.5 text-right font-semibold tabular-nums">
                {tally.openingCount}
              </td>
            </tr>
            {headLinealM > 0 && (
              <tr className="border-b border-ink-700/60">
                <td className="px-3 py-1.5 text-ink-300">Head courses</td>
                <td className="px-3 py-1.5 text-right font-semibold tabular-nums">
                  {headLinealM.toFixed(2)} m
                </td>
              </tr>
            )}
            {sillLinealM > 0 && (
              <tr>
                <td className="px-3 py-1.5 text-ink-300">Sill courses</td>
                <td className="px-3 py-1.5 text-right font-semibold tabular-nums">
                  {sillLinealM.toFixed(2)} m
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </div>
  )
}

const BrickTallyPanel = memo(BrickTallyPanelImpl)
export default BrickTallyPanel
