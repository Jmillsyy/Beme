import { useMemo, useState } from 'react'
import type { BlockTally, Opening, Pier, PierMakeup, Wall, WallMakeup } from '../types/walls'
import type { BlockCode } from '../types/blocks'
import { BLOCK_LIBRARY, useBlockLibrary } from '../data/blockLibrary'
import { calculateProjectTally } from '../lib/blockCalc'
import { formatLengthMm } from '../lib/units'
import { useUserSettings } from '../lib/userSettings'

interface BlockTallyPanelProps {
  walls: Wall[]
  makeupsById: Record<string, WallMakeup>
  openings: Opening[]
  piers?: Pier[]
  pierMakeupsById?: Record<string, PierMakeup>
  /** Per-project supply-item include/exclude map. See BrickTallyPanel. */
  supplyItemSelections?: Record<string, boolean>
  onSupplyItemToggle?: (itemId: string, included: boolean) => void
}

export default function BlockTallyPanel({
  walls,
  makeupsById,
  openings,
  piers = [],
  pierMakeupsById = {},
  supplyItemSelections,
  onSupplyItemToggle,
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

  /**
   * Net wallwork area in mm² across the project. Each wall contributes
   * length × wall height (per-wall override → makeup default). Openings
   * are subtracted as gross voids. Used by supply-item rate-per-m² rows.
   */
  const totalAreaSqMm = useMemo(() => {
    let gross = 0
    for (const w of walls) {
      const dx = w.endX - w.startX
      const dy = w.endY - w.startY
      const lenMm = Math.sqrt(dx * dx + dy * dy)
      const h = w.heightMmOverride ?? makeupsById[w.makeupId]?.heightMm ?? 0
      gross += lenMm * h
    }
    let voids = 0
    for (const o of openings) voids += o.widthMm * o.heightMm
    return Math.max(0, gross - voids)
  }, [walls, openings, makeupsById])

  /**
   * Per-supply-item rows pulled from the user's Material library catalogue.
   * Same math + rendering as the brick tally panel; rows for items that
   * apply to block AND are enabled by default. per-brick items skipped
   * (irrelevant on a block estimate). Quantity rounds UP to whole units;
   * zero-qty rows are dropped.
   */
  const supplyRows = useMemo(() => {
    const items = userSettings.supplyItems ?? []
    const areaSqM = totalAreaSqMm / 1_000_000
    const lengthM = totalLengthMm / 1000
    const rows: {
      id: string
      name: string
      qty: number
      rateLabel: string
      included: boolean
    }[] = []
    for (const item of items) {
      if (!item.appliesTo.includes('block')) continue
      let qty = 0
      let rateLabel = ''
      switch (item.unit) {
        case 'each':
          qty = item.rate
          rateLabel = `${item.rate}/project`
          break
        case 'per-block':
          qty = item.rate * totalBlocks
          rateLabel = `${item.rate}/block`
          break
        case 'per-m2':
          qty = item.rate * areaSqM
          rateLabel = `${item.rate}/m²`
          break
        case 'per-m-lineal':
          qty = item.rate * lengthM
          rateLabel = `${item.rate}/m`
          break
        case 'per-opening':
          qty = item.rate * openings.length
          rateLabel = `${item.rate}/opening`
          break
        case 'per-brick':
          continue
      }
      const rounded = Math.max(0, Math.ceil(qty))
      const included = supplyItemSelections?.[item.id] !== false
      rows.push({ id: item.id, name: item.name, qty: rounded, rateLabel, included })
    }
    return rows
  }, [
    userSettings.supplyItems,
    totalAreaSqMm,
    totalLengthMm,
    totalBlocks,
    openings.length,
    supplyItemSelections,
  ])

  if (walls.length === 0) {
    return (
      <div className="my-4 border border-dashed border-ink-600 rounded-xl p-6 text-center text-ink-400 text-sm bg-ink-800/50">
        Draw your first wall to see the block tally.
      </div>
    )
  }

  return (
    <div className="my-4 border border-ink-600 rounded-xl bg-ink-800 overflow-hidden">
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
            · {totalBlocks.toLocaleString()} blocks
          </span>
        </div>
        <span className="text-xs text-ink-400 tabular-nums flex-shrink-0">
          {walls.length} wall{walls.length === 1 ? '' : 's'}
        </span>
      </button>

      {expanded && (
        <>
          {/* Big total card — orange hero, matches Studio Black mockup */}
          <div className="px-4 py-4 bg-gradient-to-br from-beme-500 to-beme-600 text-ink-900">
            <div className="text-[11px] font-semibold uppercase tracking-[0.1em] opacity-85">
              Total blocks
            </div>
            <div className="text-3xl font-extrabold tracking-tight leading-none mt-1">
              {totalBlocks.toLocaleString()}
            </div>
            <div className="text-xs opacity-85 mt-1">
              {walls.length} wall{walls.length === 1 ? '' : 's'} ·{' '}
              {formatLengthMm(totalLengthMm, userSettings.preferences.units)} run
            </div>
          </div>

          <div className="px-3 py-2 text-xs text-ink-400 border-b border-ink-600 flex justify-between gap-2 flex-wrap">
            <span>
              {makeupCount} wall type{makeupCount === 1 ? '' : 's'} · corners dedup'd
              {openings.length > 0 && ` · ${openings.length} opening${openings.length === 1 ? '' : 's'}`}
              {piers.length > 0 && ` · ${piers.length} pier${piers.length === 1 ? '' : 's'}`}
            </span>
          </div>

          <table className="w-full text-sm">
            <thead className="text-[11px] uppercase tracking-wider text-ink-400 bg-ink-700/40">
              <tr>
                <th className="text-left px-3 py-1.5 w-20 font-semibold">Code</th>
                <th className="text-left px-2 py-1.5 font-semibold">Block</th>
                <th className="text-right px-3 py-1.5 w-16 font-semibold">Count</th>
              </tr>
            </thead>
            <tbody>
              {entries.map(([code, count]) => {
                const block = BLOCK_LIBRARY[code]
                return (
                  <tr key={code} className="border-t border-ink-700/60">
                    <td className="px-3 py-1.5 font-mono text-beme-300 text-xs font-medium">{code}</td>
                    <td className="px-2 py-1.5 text-ink-200 text-xs">{block?.name ?? code}</td>
                    <td className="px-3 py-1.5 text-right font-mono font-semibold tabular-nums text-ink-50">
                      {count.toLocaleString()}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>

          {/* Supply items from the user's Material library that apply to
              block estimates. Rendered as a separate sub-section so the
              block-by-code table above stays clean. Numbers are pre-rounded
              to whole units and match what the exported PDF will show. */}
          {supplyRows.length > 0 && (
            <table className="w-full text-sm border-t border-ink-600">
              <thead className="text-[11px] uppercase tracking-wider text-ink-400 bg-ink-700/40">
                <tr>
                  <th className="text-left px-3 py-1.5 font-semibold" colSpan={2}>
                    Supply items
                  </th>
                  <th className="text-right px-3 py-1.5 w-16 font-semibold">Count</th>
                </tr>
              </thead>
              <tbody>
                {supplyRows.map((r) => (
                  <tr key={r.id} className="border-t border-ink-700/60">
                    <td className="px-3 py-1.5 text-xs" colSpan={2}>
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={r.included}
                          onChange={(e) =>
                            onSupplyItemToggle?.(r.id, e.target.checked)
                          }
                          className="w-3.5 h-3.5 accent-beme-500"
                        />
                        <span
                          className={
                            r.included ? 'text-ink-200' : 'text-ink-500 line-through'
                          }
                        >
                          {r.name}{' '}
                          <span className="text-ink-400">({r.rateLabel})</span>
                        </span>
                      </label>
                    </td>
                    <td
                      className={`px-3 py-1.5 text-right font-mono font-semibold tabular-nums ${
                        r.included ? 'text-ink-50' : 'text-ink-500'
                      }`}
                    >
                      {r.included ? r.qty.toLocaleString() : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </div>
  )
}
