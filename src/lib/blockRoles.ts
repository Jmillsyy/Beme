/**
 * blockRoles.ts - central lookup helper for "which block plays role X
 * in this user's library?"
 *
 * Background: the calc engine has historically reached into the block
 * library directly and asked "find me a block tagged with role
 * 'corner'" via `block.roles.includes('corner')`. That works as long as
 * the library has well-tagged blocks, but it locks the engine into the
 * AU default library's role assignments. The role-elimination plan
 * (see notes in the conversation) wants to:
 *
 * 1. Make wall-type composition fully explicit (already done - the
 * wall makeup carries bodyBlockCode / cornerBlockCode / etc.).
 * 2. Keep a small per-role "preferred block" map on user settings
 * (DefaultsByRole) for the cases where the engine still has to
 * pick on the user's behalf - auto-create defaults, lintel
 * selection, height-makeup picks, stale-code healing.
 * 3. Eventually drop the `roles: BlockRole[]` field from individual
 * blocks once nothing reads it.
 *
 * This module is the **single entry point** for those engine-side picks.
 * Every caller migrating off `b.roles.includes(...)` should route
 * through here. Once every old call site is migrated, the BlockRole
 * tagging can be removed from the block library schema.
 *
 * Resolution order (first hit wins):
 *
 * 1. The user's DefaultsByRole map - if they've explicitly named
 * "this is my body block", that wins.
 * 2. Library-side legacy `roles` array - for blocks that still
 * carry the tag, the first match in library iteration order.
 * This is the bridge while the migration is in progress.
 * 3. `null` - caller decides what to do (often: fall back to a
 * domain-specific literal, e.g. '20.48' for body in AU mode).
 *
 * Kept generic on the block shape so the helper is usable for both
 * BLOCK_LIBRARY (Record<BlockCode, Block>) and any subset library
 * the calc engine wants to scope to.
 */
import type { Block, BlockCode, BlockRole } from '../types/blocks'
import type { DefaultsByRole, UserSettings } from '../types/userSettings'
import { getUserSettings } from './userSettings'

export interface ResolveByRoleOptions {
  /** Optional user settings - read `defaultsByRole` from here when
   * provided. When omitted the helper reads the live settings
   * singleton, so the user's per-role default block applies even at
   * the convenience `pickX()` call sites that pass nothing. */
  settings?: Pick<UserSettings, 'defaultsByRole'>
}

/**
 * Maps a functional BlockRole to its DefaultsByRole key. Only roles the
 * user can pin a preferred block for appear here; roles without a key
 * (fraction, height-makeup, legacy) resolve by library tag alone.
 */
const ROLE_TO_DEFAULT_KEY: Partial<Record<BlockRole, keyof DefaultsByRole>> = {
  body: 'body',
  corner: 'corner',
  'end-termination': 'half',
  'base-course': 'base',
  'top-course': 'top',
  cap: 'cap',
  pier: 'pier',
  lintel: 'lintel',
  'curve-tight': 'curveWedge',
  'corner-lead-in': 'cornerLeadIn',
  'control-joint-full': 'controlJointFull',
  'control-joint-half': 'controlJointHalf',
}

/**
 * Find the user's preferred block for a given role.
 *
 * @returns the matching Block (with full library entry), or null if
 * nothing matched at any step. Caller decides what to do
 * with null - typically fall back to a domain literal.
 */
export function resolveBlockByRole(
  role: BlockRole,
  library: Record<BlockCode, Block>,
  opts: ResolveByRoleOptions = {}
): Block | null {
  // Step 1: the user's per-role preferred block (Material Library →
  // Defaults). When they've pinned "this is my body block", that wins -
  // as long as the code still exists in the library being scoped to.
  const key = ROLE_TO_DEFAULT_KEY[role]
  if (key) {
    const settings = opts.settings ?? readSettingsSafely()
    const preferred = settings?.defaultsByRole?.[key]
    if (preferred && library[preferred]) return library[preferred]
  }

  // Step 2: library role-tag fallback. A US / UK / custom library brings
  // its own tagged blocks, so this stays region-correct when nothing is
  // pinned.
  for (const block of Object.values(library)) {
    if (block.roles.includes(role)) return block
  }

  return null
}

/**
 * Read the live settings singleton without throwing if it isn't ready
 * (e.g. very early module init). Returns undefined on any failure so
 * resolution falls through to the library-tag path.
 */
function readSettingsSafely(): Pick<UserSettings, 'defaultsByRole'> | undefined {
  try {
    return getUserSettings()
  } catch {
    return undefined
  }
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
