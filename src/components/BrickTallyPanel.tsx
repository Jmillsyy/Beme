import { memo, useMemo, useState } from 'react'
import type { BrickSettings, Opening, Wall } from '../types/walls'
import { calculateBrickTally } from '../lib/brickCalc'

interface BrickTallyPanelProps {
  walls: Wall[]
  openings: Opening[]
  settings: BrickSettings
}

/**
 * Right-rail tally for brick estimates — wall count, total length,
 * total brickwork area, brick count. Supply items (ties, plascourse,
 * lintels, flashings, etc.) live in the SupplyItemsPanel and are
 * managed via the material library.
 *
 * Lintels used to live here as a dedicated section with a hardcoded
 * AU Galintel catalogue. They've moved to per-opening supply items
 * with optional opening-width ranges (see SupplyItem.openingWidthMinMm).
 *
 * Memoised so re-renders driven by zoom / pan don't recompute the tally.
 */
function BrickTallyPanelImpl({ walls, openings, settings }: BrickTallyPanelProps) {
  const [expanded, setExpanded] = useState(true)

  const tally = useMemo(
    () => calculateBrickTally(walls, openings, settings),
    [walls, openings, settings]
  )

  if (walls.length === 0) {
    return (
      <div className="my-4 border border-dashed border-ink-600 rounded-xl p-6 text-center text-ink-400 text-sm">
        Draw your first wall to see the brick tally.
      </div>
    )
  }

  const areaSqM = tally.totalAreaSqMm / 1_000_000
  const lengthM = tally.totalLinealMm / 1000

  return (
    <div className="my-4 border border-ink-600 rounded-xl bg-ink-800 overflow-hidden">
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
            · {tally.brickCount.toLocaleString()} bricks
          </span>
        </div>
        <span className="text-xs text-beme-300 tabular-nums flex-shrink-0">
          {tally.wallCount} wall{tally.wallCount === 1 ? '' : 's'}
        </span>
      </button>

      {expanded && (
        <table className="w-full text-sm">
          <tbody>
            <tr className="border-b border-ink-700/60">
              <td className="px-3 py-1.5 text-ink-300">Total length</td>
              <td className="px-3 py-1.5 text-right font-semibold tabular-nums">
                {lengthM.toFixed(2)} m
              </td>
            </tr>
            <tr className="border-b border-ink-700/60">
              <td className="px-3 py-1.5 text-ink-300">Brickwork area</td>
              <td className="px-3 py-1.5 text-right font-semibold tabular-nums">
                {areaSqM.toFixed(2)} m²
              </td>
            </tr>
            <tr className="border-b border-ink-700/60">
              <td className="px-3 py-1.5 text-ink-300">Openings</td>
              <td className="px-3 py-1.5 text-right font-semibold tabular-nums">
                {tally.openingCount}
              </td>
            </tr>
            <tr className="bg-ink-700/30">
              <td className="px-3 py-1.5 text-ink-200 font-medium">
                Bricks{' '}
                <span className="text-xs text-ink-400">
                  ({settings.bricksPerSquareMetre}/m²)
                </span>
              </td>
              <td className="px-3 py-1.5 text-right font-semibold tabular-nums text-beme-300">
                {tally.brickCount.toLocaleString()}
              </td>
            </tr>
          </tbody>
        </table>
      )}
    </div>
  )
}

const BrickTallyPanel = memo(BrickTallyPanelImpl)
export default BrickTallyPanel
