/**
 * Per-trade storage / state key helpers.
 *
 * Beme is a multi-trade estimator (block + brick today; potentially
 * cladding, render, plaster etc. in the future). Anything that stores
 * trade-specific state — localStorage queues, sessionStorage flags,
 * IndexedDB shards — should run its key through {@link tradeKey} so
 * the block trade and brick trade can't see each other's data.
 *
 * Convention: `<base>:<projectId | 'no-project'>:<trade | 'no-trade'>`
 * The legacy `'no-trade'` segment is reserved for keys written before
 * a feature became trade-aware, so back-compat reads can fall back
 * to it without colliding with future trades.
 *
 * Use the {@link readWithLegacyFallback} helper when migrating an
 * existing key to the new schema — it reads the new key first, then
 * the legacy un-namespaced key, returning whichever has data.
 */

export type TradeId = 'block' | 'brick'

/**
 * Build a storage key namespaced by the active trade (and optionally
 * the active project). The returned string is stable and safe to use
 * as a localStorage / sessionStorage key.
 *
 * Examples:
 *   tradeKey('beme:3d-export-snapshots', 'proj-123', 'block')
 *     → 'beme:3d-export-snapshots:proj-123:block'
 *   tradeKey('beme:settings:match-exact-length', null, 'brick')
 *     → 'beme:settings:match-exact-length:no-project:brick'
 *   tradeKey('beme:palette', 'proj-123', undefined)
 *     → 'beme:palette:proj-123:no-trade'
 */
export function tradeKey(
  base: string,
  projectId: string | null | undefined,
  trade: TradeId | undefined
): string {
  const project = projectId ?? 'no-project'
  const tradeSeg = trade ?? 'no-trade'
  return `${base}:${project}:${tradeSeg}`
}

/**
 * Read a value from localStorage, falling back to a legacy key if the
 * new key is empty. Useful when a key has just been migrated to a
 * trade-namespaced form and pre-existing data is still in the old key.
 *
 * Returns `null` if neither key has data.
 */
export function readWithLegacyFallback(
  newKey: string,
  legacyKey: string
): string | null {
  try {
    const fresh = window.localStorage.getItem(newKey)
    if (fresh !== null) return fresh
    return window.localStorage.getItem(legacyKey)
  } catch {
    return null
  }
}
