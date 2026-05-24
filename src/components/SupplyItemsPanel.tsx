import { memo, useMemo, useState } from 'react'
import type { SupplyItem, SupplyItemUnit } from '../types/userSettings'
import { useUserSettings } from '../lib/userSettings'

/**
 * Per-mode brick/block tally inputs that drive the supply-item rate maths.
 * Live values come from the workspace's existing tally — we don't recompute
 * them here, the panel is purely a configuration surface for picking which
 * library items count and at what rate.
 */
interface ProjectMetrics {
  /** Active estimate mode — drives which library items show up. */
  mode: 'brick' | 'block'
  /** Total face / wall area in m². */
  areaSqM: number
  /** Total wall run in lineal m. */
  lengthM: number
  /** Whole-brick count (only used when mode is brick). */
  brickCount: number
  /** Whole-block count (only used when mode is block). */
  blockCount: number
  /** Number of openings drawn on the project. */
  openingCount: number
}

interface SupplyItemsPanelProps {
  metrics: ProjectMetrics
  /** Per-project ticked/unticked state, keyed by supply item id. */
  selections: Record<string, boolean>
  /** Per-project rate overrides, keyed by supply item id. */
  rateOverrides: Record<string, number>
  /** Toggle a single item's included flag. */
  onToggle: (itemId: string, included: boolean) => void
  /** Set a rate override; pass undefined to clear back to the library default. */
  onRateChange: (itemId: string, rate: number | undefined) => void
}

const UNIT_SUFFIX: Record<SupplyItemUnit, string> = {
  each: 'per project',
  'per-block': 'per block',
  'per-brick': 'per brick',
  'per-m2': 'per m²',
  'per-m-lineal': 'per lineal m',
  'per-opening': 'per opening',
}

/**
 * Resolve a supply item's per-project rate. Returns the override when one
 * exists for this item id, otherwise the library default. Exposed as a
 * helper so the same precedence rule reads identically in the panel, the
 * tally, and the export.
 */
function effectiveRate(item: SupplyItem, overrides: Record<string, number>): number {
  const override = overrides[item.id]
  return override !== undefined && Number.isFinite(override) ? override : item.rate
}

/**
 * Compute the per-item quantity for the given project metrics + rate. Same
 * rules brick/block exports use; returns 0 (and the caller treats it as a
 * "nothing to add" row) for unit/mode mismatches.
 */
function quantityFor(item: SupplyItem, rate: number, m: ProjectMetrics): number {
  switch (item.unit) {
    case 'each':
      return rate
    case 'per-brick':
      return m.mode === 'brick' ? rate * m.brickCount : 0
    case 'per-block':
      return m.mode === 'block' ? rate * m.blockCount : 0
    case 'per-m2':
      return rate * m.areaSqM
    case 'per-m-lineal':
      return rate * m.lengthM
    case 'per-opening':
      return rate * m.openingCount
  }
}

/**
 * Workspace right-rail panel for picking which Material-library supply
 * items count on this estimate and at what rate. Same component in both
 * brick and block mode — only the metrics + library filter change.
 *
 * Per row:
 *   - Checkbox: included y/n. Default included (missing key = included)
 *     so brand-new library items show up on every existing project.
 *   - Name + unit label.
 *   - Editable rate input (per-project override). Library default shown
 *     as the input's placeholder; clearing the field falls back to it.
 *   - Computed quantity to the right, rounded UP to a whole unit so the
 *     number matches the exported PDF + tally panel.
 */
function SupplyItemsPanelImpl({
  metrics,
  selections,
  rateOverrides,
  onToggle,
  onRateChange,
}: SupplyItemsPanelProps) {
  const [expanded, setExpanded] = useState(true)
  const { settings } = useUserSettings()
  const items = settings.supplyItems ?? []

  const applicableItems = useMemo(
    () => items.filter((i) => i.appliesTo.includes(metrics.mode)),
    [items, metrics.mode]
  )

  const includedCount = applicableItems.filter(
    (i) => selections[i.id] !== false
  ).length

  return (
    <div className="my-4 border border-ink-600 rounded-xl bg-ink-800 p-3">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-2 text-left group mb-2"
      >
        <span className="text-ink-500 group-hover:text-ink-300 text-xs">
          {expanded ? '▾' : '▸'}
        </span>
        <h3 className="text-sm font-semibold text-ink-200 group-hover:text-beme-300">
          Supply items
        </h3>
        <span className="text-xs text-ink-400 truncate min-w-0">
          {applicableItems.length === 0
            ? '· nothing in your Material library'
            : `· ${includedCount} of ${applicableItems.length} included`}
        </span>
      </button>

      {expanded && (
        <>
          {applicableItems.length === 0 ? (
            <p className="text-xs text-ink-400 italic mt-2">
              Add supply items in the Material library — they'll appear here
              for every {metrics.mode} estimate.
            </p>
          ) : (
            <div className="space-y-2">
              {applicableItems.map((item) => {
                const included = selections[item.id] !== false
                const rate = effectiveRate(item, rateOverrides)
                const qty = quantityFor(item, rate, metrics)
                const rounded = Math.max(0, Math.ceil(qty))
                const hasOverride = rateOverrides[item.id] !== undefined
                return (
                  <div
                    key={item.id}
                    className={`p-3 border rounded-lg transition-colors ${
                      included
                        ? 'border-ink-600 bg-ink-700/40'
                        : 'border-ink-700 bg-ink-800/40'
                    }`}
                  >
                    <label className="flex items-center gap-2 text-sm font-medium cursor-pointer">
                      <input
                        type="checkbox"
                        checked={included}
                        onChange={(e) => onToggle(item.id, e.target.checked)}
                      />
                      <span
                        className={
                          included ? 'text-ink-100' : 'text-ink-400 line-through'
                        }
                      >
                        {item.name}
                      </span>
                      <span
                        className={`ml-auto text-xs tabular-nums font-semibold ${
                          included ? 'text-beme-300' : 'text-ink-500'
                        }`}
                      >
                        {included ? rounded.toLocaleString() : '—'}
                      </span>
                    </label>
                    {included && (
                      <div className="mt-2 ml-6 flex items-center gap-2 text-sm flex-wrap">
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          value={
                            hasOverride
                              ? rateOverrides[item.id]
                              : item.rate
                          }
                          onChange={(e) => {
                            const v = e.target.value
                            if (v === '') {
                              onRateChange(item.id, undefined)
                              return
                            }
                            const n = parseFloat(v)
                            if (Number.isFinite(n) && n >= 0) {
                              onRateChange(item.id, n)
                            }
                          }}
                          className="w-20 px-2 py-1 border border-ink-600 rounded text-sm bg-ink-900 text-ink-50 tabular-nums"
                          aria-label={`${item.name} rate`}
                        />
                        <span className="text-ink-300">
                          {UNIT_SUFFIX[item.unit]}
                        </span>
                        {hasOverride && (
                          <button
                            type="button"
                            onClick={() => onRateChange(item.id, undefined)}
                            className="text-xs text-ink-400 hover:text-beme-300 underline-offset-2 hover:underline"
                            title={`Reset to library default (${item.rate} ${UNIT_SUFFIX[item.unit]})`}
                          >
                            Reset
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </>
      )}
    </div>
  )
}

const SupplyItemsPanel = memo(SupplyItemsPanelImpl)
export default SupplyItemsPanel

export { effectiveRate, quantityFor }
