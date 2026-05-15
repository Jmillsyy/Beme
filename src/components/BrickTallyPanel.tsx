import { useMemo } from 'react'
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

export default function BrickTallyPanel({ walls, openings, settings }: BrickTallyPanelProps) {
  const tally = useMemo(
    () => calculateBrickTally(walls, openings, settings),
    [walls, openings, settings]
  )

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
      <div className="mt-6 border border-dashed border-neutral-300 rounded-xl p-8 text-center text-neutral-500 text-sm">
        Draw your first wall to see the brick tally.
      </div>
    )
  }

  const areaSqM = tally.totalAreaSqMm / 1_000_000
  const lengthM = tally.totalLinealMm / 1000
  const lintelLengthM = tally.totalLintelLengthMm / 1000

  return (
    <div className="mt-6 border border-neutral-200 rounded-xl bg-white overflow-hidden">
      <div className="bg-beme-50 px-5 py-3 border-b border-beme-200 flex items-center justify-between flex-wrap gap-2">
        <div>
          <h3 className="text-lg font-bold text-beme-700">Brick tally</h3>
          <p className="text-xs text-beme-600">
            {tally.wallCount} wall{tally.wallCount === 1 ? '' : 's'}
            {tally.openingCount > 0 &&
              ` · ${tally.openingCount} opening${tally.openingCount === 1 ? '' : 's'} subtracted`}
          </p>
        </div>
      </div>

      <table className="w-full text-sm">
        <tbody>
          <tr className="border-b border-neutral-100">
            <td className="px-5 py-2 text-neutral-600">Total length</td>
            <td className="px-5 py-2 text-right font-semibold tabular-nums">
              {lengthM.toFixed(2)} m
            </td>
          </tr>
          <tr className="border-b border-neutral-100">
            <td className="px-5 py-2 text-neutral-600">Total brickwork area</td>
            <td className="px-5 py-2 text-right font-semibold tabular-nums">
              {areaSqM.toFixed(2)} m²
            </td>
          </tr>
          <tr className="border-b border-neutral-100 bg-beme-50/30">
            <td className="px-5 py-2 text-neutral-700 font-medium">
              Bricks (at {settings.bricksPerSquareMetre} per m²)
            </td>
            <td className="px-5 py-2 text-right font-semibold tabular-nums text-beme-700">
              {tally.brickCount.toLocaleString()}
            </td>
          </tr>
          {settings.ties.enabled && (
            <tr className="border-b border-neutral-100">
              <td className="px-5 py-2 text-neutral-600">
                Brick ties (at {settings.ties.perSquareMetre} per m²)
              </td>
              <td className="px-5 py-2 text-right font-semibold tabular-nums">
                {tally.tiesCount.toLocaleString()}
              </td>
            </tr>
          )}
          {settings.plascourse.enabled && (
            <tr className="border-b border-neutral-100">
              <td className="px-5 py-2 text-neutral-600">
                Plascourse (1 per {settings.plascourse.metresPerUnit} m)
              </td>
              <td className="px-5 py-2 text-right font-semibold tabular-nums">
                {tally.plascourseCount}
              </td>
            </tr>
          )}
          {tally.lintels.length > 0 && (
            <tr className="border-b border-neutral-100">
              <td className="px-5 py-2 text-neutral-600">Total lintel length</td>
              <td className="px-5 py-2 text-right font-semibold tabular-nums">
                {lintelLengthM.toFixed(2)} m
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {/* Lintel order summary */}
      {lintelGroups.length > 0 && (
        <div className="border-t border-neutral-200">
          <div className="px-5 py-2 bg-neutral-50 text-xs uppercase text-neutral-500 font-semibold">
            Lintels to order
          </div>
          <table className="w-full text-sm">
            <thead className="text-xs uppercase text-neutral-500 bg-neutral-50">
              <tr>
                <th className="text-left px-5 py-1.5 w-20">Qty</th>
                <th className="text-left px-5 py-1.5">Lintel</th>
                <th className="text-right px-5 py-1.5">For openings</th>
              </tr>
            </thead>
            <tbody>
              {lintelGroups.map((g) => (
                <tr key={g.key} className="border-t border-neutral-100">
                  <td className="px-5 py-1.5 font-semibold tabular-nums">{g.count}</td>
                  <td className="px-5 py-1.5">
                    {g.lengthMm}mm <span className="text-neutral-500">{g.profile}</span>
                  </td>
                  <td className="px-5 py-1.5 text-right text-neutral-500 text-xs">
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
        <div className="border-t border-neutral-200 bg-red-50">
          <div className="px-5 py-2 text-xs uppercase text-red-700 font-semibold">
            Custom lintels required — opening too wide for stock sizes
          </div>
          <ul className="px-5 pb-3 text-xs text-red-700 space-y-1">
            {oversized.map(({ entry, index }) => (
              <li key={entry.openingId}>
                Opening #{index}: {Math.round(entry.openingWidthMm)}mm wide → need{' '}
                {Math.round(entry.requiredLengthMm)}mm lintel (max stock is 6000mm)
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Per-opening detail */}
      {tally.lintels.length > 0 && (
        <div className="border-t border-neutral-200">
          <div className="px-5 py-2 bg-neutral-50 text-xs uppercase text-neutral-500 font-semibold">
            Per-opening detail
          </div>
          <table className="w-full text-sm">
            <thead className="text-xs uppercase text-neutral-500 bg-neutral-50">
              <tr>
                <th className="text-left px-5 py-1.5 w-16">#</th>
                <th className="text-left px-5 py-1.5">Opening</th>
                <th className="text-left px-5 py-1.5">Bearing</th>
                <th className="text-left px-5 py-1.5">Required</th>
                <th className="text-right px-5 py-1.5">Supplied</th>
              </tr>
            </thead>
            <tbody>
              {tally.lintels.map((l, i) => (
                <tr key={l.openingId} className="border-t border-neutral-100">
                  <td className="px-5 py-1.5 text-neutral-500">#{i + 1}</td>
                  <td className="px-5 py-1.5">{Math.round(l.openingWidthMm)} mm</td>
                  <td className="px-5 py-1.5 text-neutral-600 text-xs">
                    {l.bearingEachSideMm} mm
                  </td>
                  <td className="px-5 py-1.5 text-neutral-600 text-xs">
                    {Math.round(l.requiredLengthMm)} mm
                  </td>
                  <td className="px-5 py-1.5 text-right">
                    {l.selectedLintel ? (
                      <span>
                        <span className="font-semibold tabular-nums">{l.selectedLintel.lengthMm} mm</span>
                        <span className="text-neutral-500 text-xs ml-1">{l.selectedLintel.profile}</span>
                      </span>
                    ) : (
                      <span className="text-red-600 text-xs">custom</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
