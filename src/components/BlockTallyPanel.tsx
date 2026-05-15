import { useMemo, useState } from 'react'
import type { BlockTally, Opening, Wall, WallMakeup } from '../types/walls'
import type { BlockCode } from '../types/blocks'
import { BLOCK_LIBRARY } from '../data/blockLibrary'
import { calculateProjectTally } from '../lib/blockCalc'

interface BlockTallyPanelProps {
  walls: Wall[]
  makeupsById: Record<string, WallMakeup>
  openings: Opening[]
}

export default function BlockTallyPanel({ walls, makeupsById, openings }: BlockTallyPanelProps) {
  const [expanded, setExpanded] = useState(true)

  const tally: BlockTally = useMemo(
    () => calculateProjectTally(walls, makeupsById, openings),
    [walls, makeupsById, openings]
  )

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

  if (walls.length === 0) {
    return (
      <div className="my-4 border border-dashed border-neutral-300 rounded-xl p-6 text-center text-neutral-500 text-sm">
        Draw your first wall to see the block tally.
      </div>
    )
  }

  return (
    <div className="my-4 border border-neutral-200 rounded-xl bg-white overflow-hidden">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full bg-beme-50 px-3 py-2 border-b border-beme-200 flex items-center justify-between gap-2 text-left group"
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-beme-500 group-hover:text-beme-700 text-xs">
            {expanded ? '▾' : '▸'}
          </span>
          <h3 className="text-sm font-bold text-beme-700">Block tally</h3>
          <span className="text-xs text-beme-600 tabular-nums truncate">
            · {totalBlocks.toLocaleString()} blocks
          </span>
        </div>
        <span className="text-xs text-beme-600 tabular-nums flex-shrink-0">
          {walls.length} wall{walls.length === 1 ? '' : 's'}
        </span>
      </button>

      {expanded && (
        <>
          <div className="px-3 py-2 text-xs text-neutral-600 border-b border-neutral-100 flex justify-between gap-2 flex-wrap">
            <span>
              {makeupCount} wall type{makeupCount === 1 ? '' : 's'} · corners dedup'd
              {openings.length > 0 && ` · ${openings.length} opening${openings.length === 1 ? '' : 's'}`}
            </span>
            <span className="tabular-nums">{Math.round(totalLengthMm)} mm total</span>
          </div>

          <table className="w-full text-sm">
            <thead className="text-xs uppercase text-neutral-500 bg-neutral-50">
              <tr>
                <th className="text-left px-3 py-1.5 w-20">Code</th>
                <th className="text-left px-2 py-1.5">Block</th>
                <th className="text-right px-3 py-1.5 w-16">Count</th>
              </tr>
            </thead>
            <tbody>
              {entries.map(([code, count]) => {
                const block = BLOCK_LIBRARY[code]
                return (
                  <tr key={code} className="border-t border-neutral-100">
                    <td className="px-3 py-1.5 font-mono text-neutral-700 text-xs">{code}</td>
                    <td className="px-2 py-1.5 text-neutral-700 text-xs">{block?.name ?? code}</td>
                    <td className="px-3 py-1.5 text-right font-semibold tabular-nums">
                      {count.toLocaleString()}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </>
      )}
    </div>
  )
}
