import { memo, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import type { SupplyItem, SupplyItemUnit } from '../types/userSettings'
import { formatSupplyQuantity } from '../types/userSettings'
import { useUserSettings } from '../lib/userSettings'
import { useOrgSupplyItems } from '../lib/orgSupplyItems'
import { useOrganisations } from '../lib/organisations'

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
  /** Width in mm of every opening drawn on the project. Used by
   *  per-opening supply items with openingWidthMin/Max ranges so
   *  e.g. a "Galintel 1500" item only counts openings whose width
   *  falls in its range. Length should match openingCount; callers
   *  may pass [] when widths aren't available (the range filter
   *  will fall back to counting all openings). */
  openingWidthsMm: number[]
  /** Per-opening kind so the per-opening-sill unit can exclude doors.
   *  Length matches openingWidthsMm. Each entry is 'door' or 'window'
   *  (the calc treats undefined as 'window' to match the rest of the
   *  app's defaults). */
  openingKinds: Array<'window' | 'door'>
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
  'per-opening-head': 'per opening head',
  'per-opening-sill': 'per opening sill',
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
    case 'per-opening': {
      // Width-range-aware: an item with openingWidthMinMm /
      // openingWidthMaxMm only counts openings whose width falls
      // within its range. Items with NEITHER bound (the legacy /
      // ties-and-flashings case) keep applying to every opening.
      const min = item.openingWidthMinMm
      const max = item.openingWidthMaxMm
      if (min === undefined && max === undefined) {
        return rate * m.openingCount
      }
      // No widths provided → fall back to the unfiltered count so a
      // caller that didn't pass widths doesn't silently zero out the
      // item.
      if (m.openingWidthsMm.length === 0) {
        return rate * m.openingCount
      }
      const matching = m.openingWidthsMm.filter(
        (w) =>
          (min === undefined || w >= min) &&
          (max === undefined || w <= max)
      ).length
      return rate * matching
    }
    case 'per-opening-head':
    case 'per-opening-sill': {
      // Same width-range filter as per-opening, plus an extra kind
      // filter: heads count EVERY opening (doors + windows), sills
      // count windows only (doors don't have sills). Items without
      // a bound apply to every in-scope opening / window.
      const min = item.openingWidthMinMm
      const max = item.openingWidthMaxMm
      const isSill = item.unit === 'per-opening-sill'
      // Defensive: if openingKinds wasn't passed, assume every
      // opening is a window so the caller doesn't silently zero
      // out a sill rate when the metrics dropped the kinds list.
      const kinds =
        m.openingKinds.length === m.openingWidthsMm.length
          ? m.openingKinds
          : m.openingWidthsMm.map(() => 'window' as const)
      let count = 0
      for (let i = 0; i < m.openingWidthsMm.length; i++) {
        const w = m.openingWidthsMm[i]
        const k = kinds[i] ?? 'window'
        if (isSill && k === 'door') continue
        if (min !== undefined && w < min) continue
        if (max !== undefined && w > max) continue
        count++
      }
      return rate * count
    }
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
  // onRateChange is no longer consumed in this panel — the rate is
  // library-controlled now, not editable per-project. Prop kept in
  // the interface so existing callers don't break; mark as used so
  // tsc doesn't complain about the unused arg.
  void onRateChange
  const [expanded, setExpanded] = useState(true)
  // Per-category collapse state. Keyed by category label (or
  // 'Uncategorised'). Categories default to expanded; collapsing one
  // only hides its items in this session — not persisted because
  // category collapse is a UI affordance, not a project setting.
  const [categoryCollapsed, setCategoryCollapsed] = useState<Record<string, boolean>>(
    {}
  )
  const { settings } = useUserSettings()
  const { currentOrgId } = useOrganisations()
  const { items: orgItems } = useOrgSupplyItems()
  // Source of truth: org-synced items when an org is active, otherwise
  // the IndexedDB-backed userSettings list (personal / offline mode).
  // The same UI works for both.
  const items = currentOrgId ? orgItems : settings.supplyItems ?? []

  const applicableItems = useMemo(
    () =>
      items
        .filter((i) => i.appliesTo.includes(metrics.mode))
        // Hide rows that compute to 0 quantity — they aren't used on
        // this estimate so they'd just be visual noise. A width-ranged
        // Galintel whose range no opening falls into vanishes;
        // per-m² / per-block items show only when there's actual
        // wall area / block count.
        .filter((i) => {
          const r = effectiveRate(i, rateOverrides)
          return quantityFor(i, r, metrics) > 0
        }),
    [items, metrics, rateOverrides]
  )

  // Group items by category, preserving the user's order within each
  // group. Items without a category go under 'Uncategorised'. The
  // outer Map preserves insertion order so groups appear in the order
  // they first show in the items list.
  const UNCATEGORISED = 'Uncategorised'

  // Per-project include/exclude moved to the export modal — this
  // panel is now read-only. The `selections` prop is still honoured
  // (existing exclusions stay out of the auto-tally for back-compat)
  // but rows of excluded items aren't rendered here. Users adjust
  // any item's quantity from the Export estimate modal.
  void onToggle
  const visibleApplicableItems = useMemo(
    () => applicableItems.filter((i) => selections[i.id] !== false),
    [applicableItems, selections]
  )

  const groupedItems = useMemo(() => {
    const groups = new Map<string, SupplyItem[]>()
    for (const item of visibleApplicableItems) {
      const key = item.category?.trim() || UNCATEGORISED
      const existing = groups.get(key)
      if (existing) existing.push(item)
      else groups.set(key, [item])
    }
    return Array.from(groups.entries())
  }, [visibleApplicableItems])

  return (
    <div className="border border-ink-600 rounded-lg bg-ink-800 p-2">
      <div className="flex items-center gap-2 mb-2 min-w-0">
        <button
          onClick={() => setExpanded((v) => !v)}
          className="flex items-center gap-2 text-left group flex-1 min-w-0 whitespace-nowrap"
        >
          <span className="text-ink-500 group-hover:text-ink-300 text-xs flex-shrink-0">
            {expanded ? '▾' : '▸'}
          </span>
          <h3 className="text-sm font-semibold text-ink-200 group-hover:text-beme-300 flex-shrink-0">
            Supply items
          </h3>
          <span className="text-xs text-ink-400 truncate min-w-0">
            {visibleApplicableItems.length === 0
              ? '· none'
              : `· ${visibleApplicableItems.length}`}
          </span>
        </button>
        <Link
          to="/library#supply-items"
          className="text-xs px-2 py-1 rounded bg-beme-500 text-black font-medium hover:bg-beme-400 transition-colors whitespace-nowrap flex-shrink-0"
          title="Open the Material library, scrolled to Supply items"
        >
          + Add
        </Link>
      </div>

      {expanded && (
        <>
          {visibleApplicableItems.length === 0 ? (
            <p className="text-xs text-ink-400 italic mt-2">
              Add supply items in the Material library — they'll appear here
              for every {metrics.mode} estimate.
            </p>
          ) : (
            <div className="space-y-3">
              {groupedItems.map(([category, categoryItems]) => {
                // If there's only ONE group AND it's Uncategorised, skip
                // the section header entirely — same visual as the
                // pre-categories flat list. Users who haven't categorised
                // anything see no extra chrome.
                const showHeader =
                  groupedItems.length > 1 || category !== UNCATEGORISED
                const groupCollapsed = !!categoryCollapsed[category]
                return (
                  <div key={category} className="space-y-2">
                    {showHeader && (
                      <button
                        type="button"
                        onClick={() =>
                          setCategoryCollapsed((s) => ({
                            ...s,
                            [category]: !groupCollapsed,
                          }))
                        }
                        className="flex items-center gap-2 w-full text-left group"
                      >
                        <span className="text-ink-500 group-hover:text-ink-300 text-[10px]">
                          {groupCollapsed ? '▸' : '▾'}
                        </span>
                        <span className="text-xs font-semibold uppercase tracking-wide text-ink-300 group-hover:text-beme-300">
                          {category}
                        </span>
                        <span className="text-[11px] text-ink-500">
                          · {categoryItems.length}
                        </span>
                      </button>
                    )}
                    {!groupCollapsed && (
                      <div className="space-y-2">
                        {categoryItems.map((item) => {
                          // Rate sourced from the library — effectiveRate
                          // honours any legacy per-project override stored
                          // in rateOverrides for back-compat. Quantity is
                          // the auto-calc; per-export quantity overrides
                          // live in the Export estimate modal.
                          const rate = effectiveRate(item, rateOverrides)
                          const qty = quantityFor(item, rate, metrics)
                          // formatSupplyQuantity handles both the ceil
                          // rounding AND the toFixed formatting at the
                          // item's chosen precision so "0 decimals"
                          // items still ceil to whole units the same
                          // way the export does.
                          const display = formatSupplyQuantity(Math.max(0, qty), item)
                          return (
                            <div
                              key={item.id}
                              className="p-2 border rounded-md border-ink-600 bg-ink-700/40"
                            >
                              <div className="flex items-center gap-2 text-sm font-medium">
                                <span className="text-ink-100 truncate">
                                  {item.name}
                                </span>
                                <span className="ml-auto text-xs tabular-nums font-semibold text-beme-300">
                                  {display}
                                </span>
                              </div>
                              <div className="mt-1 text-xs text-ink-400">
                                {rate} {UNIT_SUFFIX[item.unit]}
                              </div>
                            </div>
                          )
                        })}
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
