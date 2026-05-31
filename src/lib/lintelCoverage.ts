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

// ─── Block: lintel-tagged blocks with head-height buckets ─────────────────

/**
 * Block-mode lintel warnings — currently just overlapping bucket
 * ranges between lintel-tagged blocks. There's no "uncovered openings"
 * warning here because, unlike brick, block lintels never fail to
 * span: when an opening's head height exceeds the tallest lintel,
 * the lintel spans the opening and body blocks fill the remaining
 * head area as normal masonry. That's correct behaviour, not a defect
 * — so flagging it would just be noise.
 *
 * Signature kept narrow (only the library) so callers don't have to
 * thread walls / openings / makeups they don't need. If a future
 * warning genuinely needs the geometry, widen the signature then.
 */
export function blockLintelWarnings(
  library: Record<BlockCode, Block>,
): LintelWarning[] {
  const lintels = Object.values(library).filter((b) => b.roles.includes('lintel'))
  if (lintels.length === 0) return []

  const warnings: LintelWarning[] = []

  // Overlapping head-height bucket ranges.
  for (let i = 0; i < lintels.length; i++) {
    for (let j = i + 1; j < lintels.length; j++) {
      const a = lintels[i]
      const b = lintels[j]
      // Only blocks with at least one bucket bound participate — blocks
      // without bucket metadata fall through to the height-based path
      // and don't claim a range.
      if (
        a.lintelMinHeadHeightMm === undefined &&
        a.lintelMaxHeadHeightMm === undefined
      )
        continue
      if (
        b.lintelMinHeadHeightMm === undefined &&
        b.lintelMaxHeadHeightMm === undefined
      )
        continue
      const overlap = rangeOverlap(
        a.lintelMinHeadHeightMm,
        a.lintelMaxHeadHeightMm,
        b.lintelMinHeadHeightMm,
        b.lintelMaxHeadHeightMm,
      )
      if (overlap) {
        warnings.push({
          kind: 'overlap',
          a: `${a.code} (${a.name})`,
          b: `${b.code} (${b.name})`,
          overlapLabel: `${overlap.min}–${overlap.max} mm head heights`,
          hint: 'Bucket-based selection will pick whichever block comes first — adjust one range to remove the ambiguity.',
        })
      }
    }
  }

  return warnings
}
