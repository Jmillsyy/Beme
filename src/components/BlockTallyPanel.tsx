import { useMemo } from 'react'
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
      <div className="mt-6 border border-dashed border-neutral-300 rounded-xl p-8 text-center text-neutral-500 text-sm">
        Draw your first wall to see the block tally.
      </div>
    )
  }

  return (
    <div className="mt-6 border border-neutral-200 rounded-xl bg-white overflow-hidden">
      <div className="bg-beme-50 px-5 py-3 border-b border-beme-200 flex items-center justify-between flex-wrap gap-2">
        <div>
          <h3 className="text-lg font-bold text-beme-700">Block tally</h3>
          <p className="text-xs text-beme-600">
            Across {makeupCount} wall type{makeupCount === 1 ? '' : 's'} · corners deduplicated
            {openings.length > 0 && ` · ${openings.length} opening${openings.length === 1 ? '' : 's'} subtracted`}
          </p>
        </div>
        <div className="text-right text-xs text-neutral-600">
          <div>
            <span className="font-semibold tabular-nums">{walls.length}</span>{' '}
            wall{walls.length === 1 ? '' : 's'} drawn
          </div>
          <div>
            <span className="font-semibold tabular-nums">{Math.round(totalLengthMm)}</span> mm
            total length
          </div>
          <div>
            <span className="font-semibold tabular-nums">{totalBlocks.toLocaleString()}</span>{' '}
            blocks total
          </div>
        </div>
      </div>

      <table className="w-full text-sm">
        <thead className="text-xs uppercase text-neutral-500 bg-neutral-50">
          <tr>
            <th className="text-left px-5 py-2 w-24">Code</th>
            <th className="text-left px-5 py-2">Block</th>
            <th className="text-right px-5 py-2 w-24">Count</th>
          </tr>
        </thead>
        <tbody>
          {entries.map(([code, count]) => {
            const block = BLOCK_LIBRARY[code]
            return (
              <tr key={code} className="border-t border-neutral-100">
                <td className="px-5 py-2 font-mono text-neutral-700">{code}</td>
                <td className="px-5 py-2 text-neutral-700">{block?.name ?? code}</td>
                <td className="px-5 py-2 text-right font-semibold tabular-nums">
                  {count.toLocaleString()}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
