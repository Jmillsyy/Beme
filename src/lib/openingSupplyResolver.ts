/**
 * Resolves which supply items get charged for a single opening + scope.
 *
 * Centralised here because four call sites need the same answer:
 *   - SupplyItemsPanel (live workspace tally)
 *   - PdfWorkspace.supplyMetrics (right-rail counts)
 *   - UnifiedExportPanel.autoQtyFor (export modal preview)
 *   - blockExport / brickExport (the printed schedule)
 *
 * Resolution rules (per opening + per scope):
 *
 *   1. **Explicit per-opening override** (`Opening.supplyOverrides[scope]`)
 *      wins outright. A supply item id charges that item; the literal
 *      string `'none'` skips the scope.
 *   2. Otherwise, build the set of library items that MATCH the opening
 *      by unit + kind + width range.
 *   3. If any matching item is `isProjectDefault`, only the defaults
 *      count — non-default matches are suppressed.
 *   4. Otherwise (no override, no default) every matching item counts —
 *      the legacy behaviour, preserved so existing libraries don't
 *      shift until the user opts in by marking a default.
 *
 * Side note on scope semantics:
 *   - `opening` covers every opening (doors + windows).
 *   - `head` covers every opening — every doorway / window has a head.
 *   - `sill` covers WINDOWS only — doors have no sill. Overrides on
 *     doors for the sill scope are ignored at resolution time.
 */
import type { SupplyItem, SupplyItemUnit } from '../types/userSettings'

/** Which of the three opening-scoped units this is. */
export type OpeningScope = 'opening' | 'head' | 'sill'

/** Map between the three scope tags and the matching SupplyItem.unit. */
const SCOPE_UNIT: Record<OpeningScope, SupplyItemUnit> = {
  opening: 'per-opening',
  head: 'per-opening-head',
  sill: 'per-opening-sill',
}

/** A lightweight opening shape — the resolver only cares about width,
 *  kind, and the overrides map, so callers can pass whatever they have
 *  without massaging it into the full Opening type. */
export interface ResolverOpening {
  widthMm: number
  kind?: 'window' | 'door'
  supplyOverrides?: {
    opening?: string | 'none'
    head?: string | 'none'
    sill?: string | 'none'
  }
}

/**
 * Decide which supply items count for ONE opening on ONE scope.
 * Returns the items to charge — empty array means nothing counts.
 * Each item is charged at rate × 1 by the caller.
 */
export function resolveOpeningSupplyItems(
  opening: ResolverOpening,
  scope: OpeningScope,
  libraryItems: SupplyItem[],
): SupplyItem[] {
  // Sills don't apply to doors regardless of override / default.
  if (scope === 'sill' && opening.kind === 'door') return []

  const scopeUnit = SCOPE_UNIT[scope]
  const override = opening.supplyOverrides?.[scope]

  // 1. Explicit override.
  if (override === 'none') return []
  if (typeof override === 'string') {
    const picked = libraryItems.find((it) => it.id === override)
    // Validate the override still matches the scope's unit so a
    // mis-saved id (e.g. user changed an item's unit later) doesn't
    // double up the count. Fall through to auto if the picked item
    // no longer fits.
    if (picked && picked.unit === scopeUnit) return [picked]
  }

  // 2. Build the auto-match set: same unit, opening kind ok, width in
  //    range. Same width-range semantics as the existing per-opening
  //    code (both bounds inclusive; either undefined = open).
  const matches = libraryItems.filter((it) => {
    if (it.unit !== scopeUnit) return false
    const min = it.openingWidthMinMm
    const max = it.openingWidthMaxMm
    if (min !== undefined && opening.widthMm < min) return false
    if (max !== undefined && opening.widthMm > max) return false
    return true
  })

  if (matches.length === 0) return []

  // 3. If any match is a project default, narrow to defaults only.
  const defaults = matches.filter((it) => it.isProjectDefault)
  if (defaults.length > 0) return defaults

  // 4. Legacy fallback: every match counts.
  return matches
}

/**
 * Inverse helper: given one library item, count how many openings on
 * the plan charge it. Used by the supply-tally + PDF exporters which
 * iterate over items rather than openings (the panel renders one row
 * per library item). For non-opening-scoped items returns 0 — caller
 * should branch on `item.unit` first.
 */
export function countOpeningsForSupplyItem(
  item: SupplyItem,
  openings: ResolverOpening[],
  libraryItems: SupplyItem[],
): number {
  let scope: OpeningScope | null = null
  if (item.unit === 'per-opening') scope = 'opening'
  else if (item.unit === 'per-opening-head') scope = 'head'
  else if (item.unit === 'per-opening-sill') scope = 'sill'
  if (scope === null) return 0

  let count = 0
  for (const o of openings) {
    const charged = resolveOpeningSupplyItems(o, scope, libraryItems)
    if (charged.some((it) => it.id === item.id)) count++
  }
  return count
}
