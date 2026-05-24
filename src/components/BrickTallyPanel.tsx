import { memo, useMemo, useState } from 'react'
import type { BrickSettings, Opening, Wall } from '../types/walls'
import { calculateBrickTally } from '../lib/brickCalc'

interface BrickTallyPanelProps {
  walls: Wall[]
  openings: Opening[]
  settings: BrickSettings
}

interface LintelGroup {
  key: string
  lengthMm: number
  profile: string
  count: number
  openings: number[]
}

/**
 * Memoised so that re-renders of PdfWorkspace driven by zoom or pan don't
 * trigger a tally recompute. The tally itself only changes when walls,
 * openings, or brick settings change — none of which happen during a zoom
 * gesture.
 */
function BrickTallyPanelImpl({ walls, openings, settings }: BrickTallyPanelProps) {
  const [expanded, setExpanded] = useState(true)
  const [detailExpanded, setDetailExpanded] = useState(false)

  const tally = useMemo(
    () => calculateBrickTally(walls, openings, settings),
    [walls, openings, settings]
  )

  // Supply items used to live as rows inside this panel; they've moved to
  // the dedicated SupplyItemsPanel in the right rail so the user can
  // configure rate + included/excluded in one place across brick + block.
  // The tally panel now only carries brick-counting facts.

  // Group lintels by (length, profile) for an order-style summary
  const lintelGroups = useMemo<LintelGroup[]>(() => {
    const map = new Map<string, LintelGroup>()
    tally.lintels.forEach((entry, i) => {
      if (!entry.selectedLintel) return
      const key = `${entry.selectedLintel.lengthMm}-${entry.selectedLintel.profile}`
      const existing = map.get(key)
      if (existing) {
        existing.count++
        existing.openings.push(i + 1)
      } else {
        map.set(key, {
          key,
          lengthMm: entry.selectedLintel.lengthMm,
          profile: entry.selectedLintel.profile,
          count: 1,
          openings: [i + 1],
        })
      }
    })
    return Array.from(map.values()).sort((a, b) => a.lengthMm - b.lengthMm)
  }, [tally.lintels])

  // Openings that exceed the available lintel catalogue (need a custom lintel)
  const oversized = useMemo(
    () =>
      tally.lintels
        .map((entry, i) => ({ entry, index: i + 1 }))
        .filter(({ entry }) => entry.selectedLintel === null),
    [tally.lintels]
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
  const lintelLengthM = tally.totalLintelLengthMm / 1000

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
        <>
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
              <tr className="border-b border-ink-700/60 bg-ink-700/30">
                <td className="px-3 py-1.5 text-ink-200 font-medium">
                  Bricks <span className="text-xs text-ink-400">({settings.bricksPerSquareMetre}/m²)</span>
                </td>
                <td className="px-3 py-1.5 text-right font-semibold tabular-nums text-beme-300">
                  {tally.brickCount.toLocaleString()}
                </td>
              </tr>
              {/* Supply items moved to SupplyItemsPanel — see PdfWorkspace
                  right rail. Keeping the tally panel focused on the brick-
                  level facts that are derived from drawn geometry. */}
              {tally.lintels.length > 0 && (
                <tr className="border-b border-ink-700/60">
                  <td className="px-3 py-1.5 text-ink-300">Total lintel length</td>
                  <td className="px-3 py-1.5 text-right font-semibold tabular-nums">
                    {lintelLengthM.toFixed(2)} m
                  </td>
                </tr>
              )}
            </tbody>
          </table>

          {/* Lintel order summary */}
          {lintelGroups.length > 0 && (
            <div className="border-t border-ink-600">
              <div className="px-3 py-1.5 bg-ink-700/40 text-xs uppercase text-ink-400 font-semibold">
                Lintels to order
              </div>
              <table className="w-full text-sm">
                <thead className="text-xs uppercase text-ink-400 bg-ink-700/40">
                  <tr>
                    <th className="text-left px-3 py-1 w-10">Qty</th>
                    <th className="text-left px-2 py-1">Lintel</th>
                    <th className="text-right px-3 py-1 text-[10px]">Openings</th>
                  </tr>
                </thead>
                <tbody>
                  {lintelGroups.map((g) => (
                    <tr key={g.key} className="border-t border-ink-700/60">
                      <td className="px-3 py-1 font-semibold tabular-nums">{g.count}</td>
                      <td className="px-2 py-1 text-xs">
                        <span className="font-medium">{g.lengthMm}mm</span>{' '}
                        <span className="text-ink-400">{g.profile}</span>
                      </td>
                      <td className="px-3 py-1 text-right text-ink-400 text-[10px]">
                        {g.openings.map((n) => `#${n}`).join(', ')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Custom lintels (oversized openings) */}
          {oversized.length > 0 && (
            <div className="border-t border-ink-600 bg-rose-500/10">
              <div className="px-3 py-1.5 text-xs uppercase text-rose-300 font-semibold">
                Custom lintels required
              </div>
              <ul className="px-3 pb-2 text-xs text-rose-300 space-y-1">
                {oversized.map(({ entry, index }) => (
                  <li key={entry.openingId}>
                    #{index}: {Math.round(entry.openingWidthMm)}mm wide → need{' '}
                    {Math.round(entry.requiredLengthMm)}mm (max stock 6000mm)
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Per-opening detail — collapsed by default in the rail (it's secondary) */}
          {tally.lintels.length > 0 && (
            <div className="border-t border-ink-600">
              <button
                onClick={() => setDetailExpanded((v) => !v)}
                className="w-full px-3 py-1.5 bg-ink-700/40 text-xs uppercase text-ink-400 font-semibold flex items-center gap-1.5 hover:text-ink-200 transition-colors text-left"
              >
                <span className="text-[10px]">{detailExpanded ? '▾' : '▸'}</span>
                Per-opening detail
              </button>
              {detailExpanded && (
                <table className="w-full text-sm">
                  <thead className="text-xs uppercase text-ink-400 bg-ink-700/40">
                    <tr>
                      <th className="text-left px-3 py-1 w-8">#</th>
                      <th className="text-left px-2 py-1">Need</th>
                      <th className="text-right px-3 py-1">Supplied</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tally.lintels.map((l, i) => (
                      <tr key={l.openingId} className="border-t border-ink-700/60">
                        <td className="px-3 py-1 text-ink-400 text-xs">#{i + 1}</td>
                        <td className="px-2 py-1 text-xs text-ink-200 tabular-nums">
                          {Math.round(l.openingWidthMm)} → {Math.round(l.requiredLengthMm)} mm
                        </td>
                        <td className="px-3 py-1 text-right text-xs">
                          {l.selectedLintel ? (
                            <span>
                              <span className="font-semibold tabular-nums">
                                {l.selectedLintel.lengthMm}mm
                              </span>
                              <span className="text-ink-400 ml-1">
                                {l.selectedLintel.profile}
                              </span>
                            </span>
                          ) : (
                            <span className="text-rose-400">custom</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}

const BrickTallyPanel = memo(BrickTallyPanelImpl)
export default BrickTallyPanel
