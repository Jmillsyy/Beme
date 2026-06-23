/**
 * Lintel coverage diagnostics — surfaces silent failure modes in the
 * lintel selection rules:
 *
 *   1. An opening that no defined lintel item covers (block: head
 *      exceeds the tallest tagged lintel; brick: opening width outside
 *      every range-bounded supply item)
 *   2. Overlapping ranges that would either double-count (brick) or
 *      pick non-deterministically (block)
 *
 * Both modes share the same warning shape so the tally panels can
 * render them through one component. Per-mode helpers below compute
 * the actual warnings from each mode's data shape (block library role
 * tags vs supply item width ranges).
 *
 * Pure functions — fed straight into useMemo on the panel so warnings
 * recompute when their inputs change.
 */

import type { Block, BlockCode } from '../types/blocks'
import type { Opening } from '../types/walls'
import type { SupplyItem } from '../types/userSettings'

export type LintelWarning =
  | {
      kind: 'uncovered'
      /** Human-readable opening description for the warning row. */
      openingLabel: string
      /** The dimension that fell outside coverage (mm) plus its kind. */
      dimensionLabel: string
      /** Optional hint pointing the user at the fix. */
      hint?: string
    }
  | {
      kind: 'overlap'
      /** Pair of items / blocks whose ranges overlap. */
      a: string
      b: string
      /** mm range where they collide. */
      overlapLabel: string
      hint?: string
    }

// ─── Brick: per-opening supply items with width ranges ────────────────────

/**
 * Pull supply items that look like lintels — `per-opening` unit with at
 * least one width bound set. Items without any range apply to every
 * opening (ties / flashings / sealants) and aren't lintel-like.
 */
function rangedBrickLintelItems(supplyItems: SupplyItem[]): SupplyItem[] {
  return supplyItems.filter(
    (s) =>
      s.unit === 'per-opening' &&
      s.appliesTo.includes('brick') &&
      (s.openingWidthMinMm !== undefined || s.openingWidthMaxMm !== undefined),
  )
}

export function brickLintelWarnings(
  openings: Opening[],
  supplyItems: SupplyItem[],
): LintelWarning[] {
  const lintelItems = rangedBrickLintelItems(supplyItems)
  // No range-bounded items at all → the user isn't using width-based
  // lintel selection. Nothing to warn about.
  if (lintelItems.length === 0) return []

  const warnings: LintelWarning[] = []

  // 1. Uncovered openings — opening width outside every lintel item's range.
  for (const o of openings) {
    const matches = lintelItems.filter((it) => itemCoversOpening(it, o.widthMm))
    if (matches.length === 0) {
      warnings.push({
        kind: 'uncovered',
        openingLabel: `Opening ${Math.round(o.widthMm)} mm wide`,
        dimensionLabel: `${Math.round(o.widthMm)} mm opening width`,
        hint: `Add or widen a lintel supply item to cover ${Math.round(o.widthMm)} mm.`,
      })
    }
  }

  // 2. Overlapping ranges between lintel items. For each pair, compute
  //    the intersection (if any) and emit a warning. O(n²) over the
  //    typically small set of lintel items.
  for (let i = 0; i < lintelItems.length; i++) {
    for (let j = i + 1; j < lintelItems.length; j++) {
      const a = lintelItems[i]
      const b = lintelItems[j]
      const overlap = rangeOverlap(
        a.openingWidthMinMm,
        a.openingWidthMaxMm,
        b.openingWidthMinMm,
        b.openingWidthMaxMm,
      )
      if (overlap) {
        warnings.push({
          kind: 'overlap',
          a: a.name,
          b: b.name,
          overlapLabel: `${overlap.min}–${overlap.max} mm openings`,
          hint: 'Both items will be counted for openings in this range — adjust one to remove the overlap.',
        })
      }
    }
  }

  return warnings
}

function itemCoversOpening(item: SupplyItem, openingWidthMm: number): boolean {
  const min = item.openingWidthMinMm
  const max = item.openingWidthMaxMm
  // Match brickExport + block lintel: BOTH bounds inclusive. Catalogue
  // semantics — a "Galintel for 1200–1800mm openings" covers a 1800mm
  // opening (the label is the upper end of its range, not the start of
  // the next item's).
  return (
    (min === undefined || openingWidthMm >= min) &&
    (max === undefined || openingWidthMm <= max)
  )
}

/**
 * Range intersection helper. Returns the overlapping segment when two
 * `[min, max]` ranges share more than a single boundary point, or
 * null otherwise.
 *
 * Adjacent ranges that share exactly one edge value (e.g. block lintel
 * 20.25 with max=300 and 20.18 with min=300) are NOT flagged — that's
 * the standard masonry catalogue layout and the selector handles the
 * tie via "prefer smaller max" without ambiguity.
 *
 * `undefined` on either bound is treated as open (−∞ / +∞).
 */
function rangeOverlap(
  aMin: number | undefined,
  aMax: number | undefined,
  bMin: number | undefined,
  bMax: number | undefined,
): { min: number; max: number } | null {
  const lo = Math.max(aMin ?? -Infinity, bMin ?? -Infinity)
  const hi = Math.min(aMax ?? Infinity, bMax ?? Infinity)
  // Strict `<` (not `<=`) so single-point boundary touches don't fire.
  if (!(lo < hi)) return null
  return {
    min: lo === -Infinity ? 0 : lo,
    max: hi === Infinity ? Number.MAX_SAFE_INTEGER : hi,
  }
}

// ─── Block: lintel-tagged blocks ──────────────────────────────────────────

/**
 * Block-mode lintel warnings — historically flagged overlapping
 * head-height buckets between lintel-tagged blocks. That diagnostic
 * existed because the picker was bucket-based and overlaps led to
 * non-deterministic selection.
 *
 * The picker is now `pickLintelBlockIn` (modular-fit, smallest covering
 * lintel) which has no overlap ambiguity to resolve — it just picks
 * the closest block whose face height covers the head. So there's
 * nothing left to warn about: returns an empty list.
 *
 * Kept as a stable export with the same signature so any callers that
 * import it don't break, and so re-introducing block-side diagnostics
 * later has an obvious home.
 */
export function blockLintelWarnings(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _library: Record<BlockCode, Block>,
): LintelWarning[] {
  return []
}
