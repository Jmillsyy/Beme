/**
 * blockRoles.ts — central lookup helper for "which block plays role X
 * in this user's library?"
 *
 * Background: the calc engine has historically reached into the block
 * library directly and asked "find me a block tagged with role
 * 'corner'" via `block.roles.includes('corner')`. That works as long as
 * the library has well-tagged blocks, but it locks the engine into the
 * AU default library's role assignments. The role-elimination plan
 * (see notes in the conversation) wants to:
 *
 *   1. Make wall-type composition fully explicit (already done — the
 *      wall makeup carries bodyBlockCode / cornerBlockCode / etc.).
 *   2. Keep a small per-role "preferred block" map on user settings
 *      (DefaultsByRole) for the cases where the engine still has to
 *      pick on the user's behalf — auto-create defaults, lintel
 *      selection, height-makeup picks, stale-code healing.
 *   3. Eventually drop the `roles: BlockRole[]` field from individual
 *      blocks once nothing reads it.
 *
 * This module is the **single entry point** for those engine-side picks.
 * Every caller migrating off `b.roles.includes(...)` should route
 * through here. Once every old call site is migrated, the BlockRole
 * tagging can be removed from the block library schema.
 *
 * Resolution order (first hit wins):
 *
 *   1. The user's DefaultsByRole map — if they've explicitly named
 *      "this is my body block", that wins.
 *   2. Library-side legacy `roles` array — for blocks that still
 *      carry the tag, the first match in library iteration order.
 *      This is the bridge while the migration is in progress.
 *   3. `null` — caller decides what to do (often: fall back to a
 *      domain-specific literal, e.g. '20.48' for body in AU mode).
 *
 * Kept generic on the block shape so the helper is usable for both
 * BLOCK_LIBRARY (Record<BlockCode, Block>) and any subset library
 * the calc engine wants to scope to.
 */
import type { Block, BlockCode, BlockRole } from '../types/blocks'
import type { DefaultsByRole, UserSettings } from '../types/userSettings'

/**
 * Pairs a BlockRole (the legacy library tag) with the DefaultsByRole
 * key that supersedes it. Keeping this map here means every call site
 * can speak in either vocabulary and the helper unifies the lookup.
 *
 * Roles that don't have a 1:1 default key (e.g. 'fraction') resolve
 * to undefined — callers that need fractions still go through the
 * library + geometry path, not the defaults map.
 */
const ROLE_TO_DEFAULT_KEY: Partial<Record<BlockRole, keyof DefaultsByRole>> = {
  body: 'body',
  corner: 'corner',
  'end-termination': 'half', // closest semantic neighbour
  'base-course': 'base',
  'base-tile': 'baseTile',
  'top-course': 'top',
  pier: 'pier',
  lintel: 'lintel',
  'curve-tight': 'curveWedge',
  'height-makeup': 'heightMakeup90', // first preference; 140 is a separate slot
  'corner-lead-in': 'cornerLeadIn',
}

export interface ResolveByRoleOptions {
  /** Optional user settings — read `defaultsByRole` from here when
   *  provided, otherwise the helper relies solely on library tags. */
  settings?: Pick<UserSettings, 'defaultsByRole'>
}

/**
 * Find the user's preferred block for a given role.
 *
 * @returns the matching Block (with full library entry), or null if
 *          nothing matched at any step. Caller decides what to do
 *          with null — typically fall back to a domain literal.
 */
export function resolveBlockByRole(
  role: BlockRole,
  library: Record<BlockCode, Block>,
  opts: ResolveByRoleOptions = {}
): Block | null {
  // Step 1: explicit user default.
  const defaultsKey = ROLE_TO_DEFAULT_KEY[role]
  const defaultCode = defaultsKey
    ? opts.settings?.defaultsByRole?.[defaultsKey]
    : undefined
  if (defaultCode) {
    const explicit = library[defaultCode]
    if (explicit) return explicit
    // Default points at a deleted / renamed block — fall through to
    // the role-tag scan instead of returning null. Better to give the
    // user *some* sensible block than nothing.
  }

  // Step 2: library role tag (legacy bridge).
  for (const block of Object.values(library)) {
    if (block.roles.includes(role)) return block
  }

  return null
}

/**
 * Convenience: return just the block code (or null). Useful for call
 * sites that store the code rather than the full block.
 */
export function resolveBlockCodeByRole(
  role: BlockRole,
  library: Record<BlockCode, Block>,
  opts: ResolveByRoleOptions = {}
): BlockCode | null {
  const block = resolveBlockByRole(role, library, opts)
  return block ? block.code : null
}
