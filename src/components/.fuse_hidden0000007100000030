import { useMemo, useState } from 'react'
import type { BlockTally, Opening, Pier, PierMakeup, Wall, WallMakeup } from '../types/walls'
import type { BlockCode } from '../types/blocks'
import { BLOCK_LIBRARY, useBlockLibrary } from '../data/blockLibrary'
import { calculateProjectTally } from '../lib/blockCalc'
import { formatLengthMm } from '../lib/units'
import { useUserSettings } from '../lib/userSettings'
import AnimatedNumber from './AnimatedNumber'

interface BlockTallyPanelProps {
  walls: Wall[]
  makeupsById: Record<string, WallMakeup>
  openings: Opening[]
  piers?: Pier[]
  pierMakeupsById?: Record<string, PierMakeup>
}

export default function BlockTallyPanel({
  walls,
  makeupsById,
  openings,
  piers = [],
  pierMakeupsById = {},
}: BlockTallyPanelProps) {
  const [expanded, setExpanded] = useState(true)
  // Re-run the tally when the user edits the library (depth lookups, etc.)
  const { version: libVersion } = useBlockLibrary()
  const { settings: userSettings } = useUserSettings()

  const tally: BlockTally = useMemo(
    () => calculateProjectTally(walls, makeupsById, openings, piers, pierMakeupsById),
    // libVersion is the trigger — calc reaches into the live BLOCK_LIBRARY singleton
    [walls, makeupsById, openings, piers, pierMakeupsById, libVersion]
  )

  // Lintel coverage warnings used to surface here as overlapping
  // head-height buckets between lintel-tagged blocks. The picker is now
  // modular-fit (smallest covering lintel, no user-maintained ranges),
  // so there's no ambiguity to warn about. Block-tally has no lintel
  // warnings to render anymore — `blockLintelWarnings` returns [] and
  // the band has been removed from this panel entirely.

  const entries = useMemo(
    () =>
      (Object.entries(tally) as Array<[BlockCode, number]>)
        .filter(([, count]) => count > 0)
        .sort(([, a], [, b]) => b - a),
    [tally]
  )

  const totalBlocks = entries.reduce((sum, [, c]) => sum + c, 0)
  const totalLengthMm = walls.reduce((sum, wall) => {
    const dx = wall.endX - wall.startX
    const dy = wall.endY - wall.startY
    return sum + Math.sqrt(dx * dx + dy * dy)
  }, 0)
  const makeupCount = Object.keys(makeupsById).length

  // Supply items moved to the unified SupplyItemsPanel in the right rail
  // so brick + block share one configuration surface. This panel now only
  // shows the block-counting facts derived from drawn geometry.

  if (walls.length === 0) {
    return (
      <div className="border border-dashed border-ink-600 rounded-xl p-6 text-center text-ink-400 text-sm bg-ink-800/50">
        Draw your first wall to see the block tally.
      </div>
    )
  }

  return (
    <div className="border border-ink-600 rounded-lg bg-ink-800 overflow-hidden">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full bg-ink-700 px-3 py-2 border-b border-ink-600 flex items-center justify-between gap-2 text-left group"
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-ink-400 group-hover:text-ink-200 text-xs">
            {expanded ? '▾' : '▸'}
          </span>
          <h3 className="text-sm font-bold text-ink-50">Block tally</h3>
          <span className="text-xs text-beme-300 tabular-nums truncate">
            · <AnimatedNumber value={totalBlocks} /> blocks
          </span>
        </div>
        <span className="text-xs text-ink-400 tabular-nums flex-shrink-0">
          {walls.length} wall{walls.length === 1 ? '' : 's'}
        </span>
      </button>

      {expanded && (
        <>
          {/* Big total card — orange hero, matches Studio Black mockup */}
          <div className="px-3 py-3 bg-gradient-to-br from-beme-500 to-beme-600 text-ink-900">
            <div className="text-[11px] font-semibold uppercase tracking-[0.1em] opacity-85">
              Total blocks
            </div>
            <div className="text-3xl font-extrabold tracking-tight leading-none mt-1 tabular-nums">
              <AnimatedNumber value={totalBlocks} />
            </div>
            <div className="text-xs opacity-85 mt-1">
              {walls.length} wall{walls.length === 1 ? '' : 's'} ·{' '}
              {formatLengthMm(totalLengthMm, userSettings.preferences.units)} run
            </div>
          </div>

          <div className="px-3 py-1.5 text-xs text-ink-400 border-b border-ink-600 flex justify-between gap-2 flex-wrap">
            <span>
              {makeupCount} type{makeupCount === 1 ? '' : 's'}
              {openings.length > 0 && ` · ${openings.length} opening${openings.length === 1 ? '' : 's'}`}
              {piers.length > 0 && ` · ${piers.length} pier${piers.length === 1 ? '' : 's'}`}
            </span>
          </div>

          {/* table-fixed forces the column widths below to be respected
              instead of letting a long block name (e.g. "300-series
              Cleanout Block") balloon the middle column and shove the
              Count off the right edge — which is what was happening on
              the narrow 272px right rail. The Block column now truncates
              with ellipsis while Code + Count stay pinned at their
              configured widths. */}
          <table className="w-full text-sm table-fixed">
            <thead className="text-[11px] uppercase tracking-wider text-ink-400 bg-ink-700/40">
              <tr>
                <th className="text-left px-2.5 py-1.5 w-14 font-semibold">Code</th>
                <th className="text-left px-2 py-1.5 font-semibold">Block</th>
                <th className="text-right px-2.5 py-1.5 w-12 font-semibold">Count</th>
              </tr>
            </thead>
            <tbody>
              {entries.map(([code, count]) => {
                const block = BLOCK_LIBRARY[code]
                return (
                  <tr key={code} className="border-t border-ink-700/60">
                    <td className="px-2.5 py-1.5 font-mono text-beme-300 text-xs font-medium">
                      {code}
                    </td>
                    {/* truncate has to live on a block-level inner element —
                        TD with truncate doesn't apply text-overflow under
                        table-fixed; the inner div is the overflow container. */}
                    <td className="px-2 py-1.5 text-ink-200 text-xs">
                      <div className="truncate" title={block?.name ?? code}>
                        {block?.name ?? code}
                      </div>
                    </td>
                    <td className="px-2.5 py-1.5 text-right font-mono font-semibold tabular-nums text-ink-50 text-xs">
                      {count.toLocaleString()}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>

          {/* Supply items live in SupplyItemsPanel in the workspace's
              right rail. Keeping this panel focused on the block-by-code
              tally that comes from drawn geometry. */}
        </>
      )}
    </div>
  )
}
