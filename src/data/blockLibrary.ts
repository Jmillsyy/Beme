/**
 * The beme block library — user-editable.
 *
 * `DEFAULT_BLOCK_LIBRARY` is the seed (SEQ QLD codes from the project brief).
 * `BLOCK_LIBRARY` is the **current** library — a stable singleton object whose
 * contents change when the user edits their library via the BlockLibraryPanel.
 *
 * Reactivity: components that want to re-render when the library changes call
 * `useBlockLibrary()`, which subscribes to the singleton and returns
 * `{ library, version }`. Pass `version` into `useMemo` deps so dependent
 * calcs re-run after edits.
 *
 * Persistence: changes are written to IndexedDB and reloaded on app startup
 * via `initBlockLibrary()` (called from main.tsx). Until that resolves the
 * default library is in place, so the app boots usefully even on first run.
 *
 * All dimensions are in mm and refer to the block face viewed from the wall front.
 */

import { useEffect, useReducer } from 'react'
import type { Block, BlockCode, BlockRole } from '../types/blocks'
import { getOrgState, subscribeToOrgState } from '../lib/organisations'
import { isSupabaseConfigured, supabase } from '../lib/supabase'

// ─── Seed library ───────────────────────────────────────────────────────────

/**
 * Default ("seed") library — SEQ QLD masonry codes per the project brief.
 * Users in other regions can clone, rename, or delete these via the library
 * panel; this constant is only the starting point for fresh installs.
 */
export const DEFAULT_BLOCK_LIBRARY: Record<BlockCode, Block> = {
  '20.48': {
    code: '20.48',
    name: 'H Block',
    description:
      'Main body block used through the middle of most courses. Open ends allow full corefill ' +
      'top-to-bottom through the wall.',
    dimensions: { widthMm: 390, heightMm: 190, depthMm: 190 },
    roles: ['body'],
  },
  '20.01': {
    code: '20.01',
    name: 'Standard Block',
    description:
      'Standard end-termination block. Used at the ends of walls and at corners. In stretcher ' +
      'bond, alternates with 20.03 per course on free ends. In stack bond, may stack the full ' +
      'height of an end column.',
    dimensions: { widthMm: 390, heightMm: 190, depthMm: 190 },
    roles: ['end-termination', 'corner'],
  },
  '20.03': {
    code: '20.03',
    name: 'Half Block',
    description:
      'Half-length block. Primarily used at end terminations on alternating courses in ' +
      'stretcher bond to maintain the half-block offset. Technically also a 1/2 fraction but ' +
      'reserved for end terminations except where deliberately specified.',
    dimensions: { widthMm: 190, heightMm: 190, depthMm: 190 },
    roles: ['end-termination', 'fraction'],
    fraction: 0.5,
  },
  '20.03CW': {
    code: '20.03CW',
    name: 'Curved-Wall Half Block',
    description:
      'Tapered half block for tight-radius curved walls. Face is 190mm wide and the rear is ' +
      '140mm wide, allowing the blocks to nest around small radii.',
    dimensions: { widthMm: 190, heightMm: 190, depthMm: 190, rearWidthMm: 140 },
    roles: ['curve-tight'],
  },
  '20.71': {
    code: '20.71',
    name: 'Half-Height Block (90mm)',
    description:
      'Half-height block. Used to make up wall heights that are not multiples of 200mm. ' +
      'Typically placed second from the top course (e.g. for a 3100mm wall).',
    dimensions: { widthMm: 390, heightMm: 90, depthMm: 190 },
    roles: ['height-makeup'],
  },
  '20.140': {
    code: '20.140',
    name: '140mm-High Block',
    description:
      '140mm-high block. Used for 50mm height denominations (e.g. a 3150mm wall). Typically ' +
      'placed second from the top in place of a 20.48.',
    dimensions: { widthMm: 390, heightMm: 140, depthMm: 190 },
    roles: ['height-makeup'],
  },
  '20.45': {
    code: '20.45',
    name: 'Cleanout Block',
    description:
      'Base course block with a knockout for cleaning out core debris before grouting. Runs ' +
      'the entirety of the base course except at the ends.',
    dimensions: { widthMm: 390, heightMm: 190, depthMm: 190 },
    roles: ['base-course'],
    pairedWith: '50.45',
  },
  '50.45': {
    code: '50.45',
    name: 'Cleanout Tile',
    description: 'Cleanout tile, paired with every 20.45 in the base course.',
    dimensions: { widthMm: 390, heightMm: 190, depthMm: 190 },
    roles: ['base-tile'],
    pairedWith: '20.45',
  },
  '20.02': {
    code: '20.02',
    name: 'Three Quarter (3/4 Fraction)',
    description:
      '3/4-length fraction block used to absorb leftover wall length when "Fractions" is ' +
      'enabled, avoiding cuts. 290mm face width.',
    dimensions: { widthMm: 290, heightMm: 190, depthMm: 190 },
    roles: ['fraction'],
    fraction: 0.75,
  },
  '20.22': {
    code: '20.22',
    name: 'Seven Eighths (7/8 Fraction)',
    description:
      '7/8-length fraction block. Finer length makeup than 20.02 — combined with 20.02 on ' +
      'either end of a wall, the program can usually land within a few mm of the actual wall ' +
      'length without cuts.',
    dimensions: { widthMm: 340, heightMm: 190, depthMm: 190 },
    roles: ['fraction'],
    fraction: 0.875,
  },
  '20.42': {
    code: '20.42',
    name: 'Channel Block',
    description: 'Channel block, legacy. Superseded in most applications by the 20.48 H block.',
    dimensions: { widthMm: 390, heightMm: 190, depthMm: 190 },
    roles: ['legacy'],
  },
  '20.21': {
    code: '20.21',
    name: 'Knockout Corner Block',
    description:
      'Alternative to 20.01 at corners. Provides better corefill where extra reinforcement is ' +
      'required.',
    dimensions: { widthMm: 390, heightMm: 190, depthMm: 190 },
    roles: ['corner', 'end-termination'],
  },
  '20.20': {
    code: '20.20',
    name: 'Knockout Block',
    description:
      'Knockout block used on the top course to form a bond beam. Typically used when a slab ' +
      'is poured above for additional structural integrity.',
    dimensions: { widthMm: 390, heightMm: 190, depthMm: 190 },
    roles: ['top-course'],
  },
  '40.925': {
    code: '40.925',
    name: '400mm Pier Block',
    description:
      'Pier block. For tied piers (built into a wall) used every second course with 20.01 on ' +
      'alternating courses. For freestanding piers, stacked every course.',
    dimensions: { widthMm: 390, heightMm: 190, depthMm: 390 },
    roles: ['pier'],
  },
  '20.18': {
    code: '20.18',
    name: '400mm Lintel Block',
    description:
      'Lintel block for opening head heights ≥ 300mm. 400mm modular height (190 + 10 mortar = 200 ' +
      'horizontal, 390 + 10 = 400 vertical). Dimensions are the as-used dimensions — Beme places ' +
      'them straight as stored, no rotation.',
    dimensions: { widthMm: 190, heightMm: 390, depthMm: 190 },
    roles: ['lintel'],
  },
  '20.25': {
    code: '20.25',
    name: '300mm Lintel Block',
    description:
      'Lintel for opening head heights between 200mm and 299mm. 300mm modular height (190 face × ' +
      '290 tall). Dimensions are the as-used dimensions — no rotation.',
    dimensions: { widthMm: 190, heightMm: 290, depthMm: 190 },
    roles: ['lintel'],
  },
  '20.13': {
    code: '20.13',
    name: 'Half Lintel Block',
    description:
      'Half-height lintel for opening head heights under 200mm. Cubic 190mm block (200mm modular ' +
      'each side).',
    dimensions: { widthMm: 190, heightMm: 190, depthMm: 190 },
    roles: ['lintel'],
  },
  '20.12': {
    code: '20.12',
    name: 'Standard Lintel Block',
    description:
      'Lintel stacked normally across the head at ~200mm. Less common than 20.18 / 20.25.',
    dimensions: { widthMm: 390, heightMm: 190, depthMm: 190 },
    roles: ['lintel'],
  },

  // ── 300 series ─────────────────────────────────────────────────────────────
  // Wider (290mm-deep) versions of the core 200 series blocks. Used on the
  // base courses of a wall where engineering calls for a thicker footing —
  // typically the bottom 4–6 courses run 300 series and the rest of the wall
  // steps down to standard 200 series above. Face widths and heights match
  // the 200 series so the courses still sit on the 200mm modular grid and
  // alternate the same way (20.01 / 20.03 → 30.01 / 30.03).
  '30.48': {
    code: '30.48',
    name: '300-series H Block',
    description:
      '290mm-deep H block used for the body of 300-series courses. Same face dimensions ' +
      'as 20.48 (390×190mm) — only the wall thickness differs.',
    dimensions: { widthMm: 390, heightMm: 190, depthMm: 290 },
    roles: ['body'],
  },
  '30.01': {
    code: '30.01',
    name: '300-series Standard Block',
    description:
      '290mm-deep end-termination / corner block. Used at ends of 300-series courses, ' +
      'alternating with 30.03 in stretcher bond the same way 20.01 alternates with 20.03 in ' +
      '200 series.',
    dimensions: { widthMm: 390, heightMm: 190, depthMm: 290 },
    roles: ['end-termination', 'corner'],
  },
  '30.03': {
    code: '30.03',
    name: '300-series Half Block',
    description:
      '290mm-deep half block. End termination on alternating courses in stretcher bond, ' +
      'and the 1/2 fraction equivalent for 300-series courses.',
    dimensions: { widthMm: 190, heightMm: 190, depthMm: 290 },
    roles: ['end-termination', 'fraction'],
    fraction: 0.5,
  },
  '30.02': {
    code: '30.02',
    name: '300-series Cube Block',
    description:
      '290mm cube-faced block (290 wide × 190 high × 290 deep) used to get back on bond ' +
      "after a 300-series corner. Two are laid in succession between the 30.01 corner " +
      "block and the regular body — the corner block's deeper footprint would otherwise " +
      'leave the next 30.48 off the stretcher offset. Not used at free / T-junction / ' +
      'control-joint ends; those still take 30.01 / 30.03 alternation.',
    dimensions: { widthMm: 290, heightMm: 190, depthMm: 290 },
    roles: ['corner-lead-in'],
  },
  '30.45': {
    code: '30.45',
    name: '300-series Cleanout Block',
    description:
      '290mm-deep base-course cleanout block, paired with 50.45 tiles. Used when the base ' +
      'course of the wall is 300 series.',
    dimensions: { widthMm: 390, heightMm: 190, depthMm: 290 },
    roles: ['base-course'],
    pairedWith: '50.45',
  },
  '30.71': {
    code: '30.71',
    name: '300-series Half-Height Block (90mm)',
    description:
      '290mm-deep half-height block for height makeup on 300-series courses (the 30 equivalent ' +
      'of 20.71). Typically placed second from the top of the 300-series section.',
    dimensions: { widthMm: 390, heightMm: 90, depthMm: 290 },
    roles: ['height-makeup'],
  },
}

/** Codes from the seed library that should never be deletable — the calc engine depends on them. */
export const PROTECTED_BLOCK_CODES = new Set<BlockCode>([
  '20.48',
  '20.01',
  '20.03',
  '20.45',
  '50.45',
  '20.02',
  '20.22',
  '20.71',
  '20.140',
  // 300-series core codes — once a wall makeup references a course range that
  // uses these, deleting them would break the tally. Protect for the same
  // reason the 200-series core codes are protected.
  '30.48',
  '30.01',
  '30.02',
  '30.03',
  '30.45',
  '30.71',
])

// ─── Mutable singleton ──────────────────────────────────────────────────────

/**
 * The current library. Same object reference is preserved across edits — only
 * the keys / values inside change. This means existing imports (`BLOCK_LIBRARY`)
 * keep working without any code changes; reactivity is opt-in via
 * `useBlockLibrary()`.
 */
export const BLOCK_LIBRARY: Record<BlockCode, Block> = { ...DEFAULT_BLOCK_LIBRARY }

let _version = 0
const listeners = new Set<() => void>()

function notifyChange() {
  _version++
  listeners.forEach((l) => l())
}

function replaceLibraryContents(next: Record<BlockCode, Block>) {
  for (const key of Object.keys(BLOCK_LIBRARY)) {
    delete BLOCK_LIBRARY[key]
  }
  Object.assign(BLOCK_LIBRARY, next)
}

/** Snapshot of the current library (for export / save). */
export function getBlockLibrary(): Record<BlockCode, Block> {
  return BLOCK_LIBRARY
}

/** Replace the entire library wholesale. Persists. */
export function setBlockLibrary(next: Record<BlockCode, Block>): void {
  replaceLibraryContents(next)
  notifyChange()
  void persistLibraryEverywhere(BLOCK_LIBRARY, { full: true })
}

/** Upsert a single block by code. Persists. */
export function upsertBlock(block: Block): void {
  BLOCK_LIBRARY[block.code] = block
  notifyChange()
  void persistLibraryEverywhere(BLOCK_LIBRARY, { upsertedCodes: [block.code] })
}

/** Remove a block from the library. No-op for protected codes. */
export function removeBlock(code: BlockCode): void {
  if (PROTECTED_BLOCK_CODES.has(code)) return
  if (!(code in BLOCK_LIBRARY)) return
  delete BLOCK_LIBRARY[code]
  notifyChange()
  void persistLibraryEverywhere(BLOCK_LIBRARY, { removedCodes: [code] })
}

/** Reset the library to the SEQ QLD defaults. Useful "start over" affordance. */
export function resetBlockLibrary(): void {
  setBlockLibrary({ ...DEFAULT_BLOCK_LIBRARY })
}

// ─── React hook ─────────────────────────────────────────────────────────────

/**
 * Subscribe to library changes. Returns the library (same stable reference)
 * and a version number. Pass the version into `useMemo` deps where you want
 * dependent calcs to re-run after the user edits the library.
 */
export function useBlockLibrary(): { library: Record<BlockCode, Block>; version: number } {
  const [, force] = useReducer((x: number) => x + 1, 0)
  useEffect(() => {
    listeners.add(force)
    return () => {
      listeners.delete(force)
    }
  }, [])
  return { library: BLOCK_LIBRARY, version: _version }
}

// ─── Persistence ────────────────────────────────────────────────────────────
//
// Two backing stores: IndexedDB (browser) and Supabase (cloud, org-scoped).
//
//   - Personal / offline users: writes go to IndexedDB only. The library is
//     "my private library on this browser" — same behaviour as before cloud
//     sync shipped.
//   - Org users: writes go to Supabase (table `block_library_items`,
//     primary-keyed by organisation_id + code) AND to IndexedDB. The
//     IndexedDB copy is a cache so the next page load can paint immediately
//     while we re-fetch the cloud rows in the background.
//
// The org membership is read at write time from the organisations singleton,
// so a user who joins an org mid-session immediately starts publishing to
// cloud without an explicit re-init. A user who switches orgs (via the org
// indicator in the header) triggers `syncWithOrg(newOrgId)`, which pulls
// the new org's library down and replaces the in-memory contents.
//
// First-time bootstrap: if a user signs in to an empty org library AND
// their local library has user-added blocks (i.e. differs from the seed
// library), we PUSH the local library up so their existing customisations
// become the org's shared library. After that the cloud is the source of
// truth and the local IndexedDB acts purely as an offline cache.

const DB_NAME = 'beme'
const DB_VERSION = 2 // bumped from 1 to add the user-data store
const USER_DATA_STORE = 'userData'
const LIBRARY_KEY = 'blockLibrary'
const CLOUD_TABLE = 'block_library_items'

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains('projects')) {
        db.createObjectStore('projects', { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains(USER_DATA_STORE)) {
        db.createObjectStore(USER_DATA_STORE)
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function loadLibraryLocal(): Promise<Record<BlockCode, Block> | null> {
  try {
    const db = await openDb()
    return await new Promise<Record<BlockCode, Block> | null>((resolve, reject) => {
      const tx = db.transaction(USER_DATA_STORE, 'readonly')
      const store = tx.objectStore(USER_DATA_STORE)
      const req = store.get(LIBRARY_KEY)
      req.onsuccess = () => resolve((req.result as Record<BlockCode, Block> | undefined) ?? null)
      req.onerror = () => reject(req.error)
    })
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[beme] Failed to load block library from IndexedDB:', err)
    return null
  }
}

async function persistLibraryLocal(lib: Record<BlockCode, Block>): Promise<void> {
  try {
    const db = await openDb()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(USER_DATA_STORE, 'readwrite')
      const store = tx.objectStore(USER_DATA_STORE)
      // Clone to a plain object (the singleton is plain, but be safe).
      store.put({ ...lib }, LIBRARY_KEY)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[beme] Failed to persist block library:', err)
  }
}

// ---------- Cloud (Supabase) ----------

interface CloudBlockRow {
  organisation_id: string
  code: string
  data: Block
}

/** Fetch all rows for an org, hydrated as `Record<code, Block>`. */
async function loadLibraryCloud(orgId: string): Promise<Record<BlockCode, Block> | null> {
  if (!isSupabaseConfigured) return null
  try {
    const { data, error } = await supabase()
      .from(CLOUD_TABLE)
      .select('organisation_id, code, data')
      .eq('organisation_id', orgId)
    if (error) {
      // eslint-disable-next-line no-console
      console.warn('[beme] Failed to load block library from cloud:', error.message)
      return null
    }
    const out: Record<BlockCode, Block> = {}
    for (const row of (data ?? []) as CloudBlockRow[]) {
      out[row.code] = row.data
    }
    return out
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[beme] Failed to load block library from cloud:', err)
    return null
  }
}

/**
 * Replace the cloud-side library for `orgId` with `lib`. Implemented as
 * "delete all rows for this org, then upsert every code". Used by
 * setBlockLibrary / resetBlockLibrary and by the first-time bootstrap.
 */
async function persistLibraryCloudFull(
  lib: Record<BlockCode, Block>,
  orgId: string
): Promise<void> {
  if (!isSupabaseConfigured) return
  try {
    const client = supabase()
    // Wipe everything for this org first — keeps the cloud in lock-step with
    // the in-memory library even after deletes. (Upsert alone would leave
    // stale rows behind for codes the user removed.)
    const { error: delErr } = await client.from(CLOUD_TABLE).delete().eq('organisation_id', orgId)
    if (delErr) throw new Error(delErr.message)
    const rows = Object.values(lib).map((b) => ({
      organisation_id: orgId,
      code: b.code,
      data: b,
    }))
    if (rows.length > 0) {
      const { error: upErr } = await client.from(CLOUD_TABLE).upsert(rows, {
        onConflict: 'organisation_id,code',
      })
      if (upErr) throw new Error(upErr.message)
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[beme] Failed to persist block library to cloud:', err)
  }
}

/** Upsert one or more blocks into the cloud library. */
async function persistBlocksCloudUpsert(
  blocks: Block[],
  orgId: string
): Promise<void> {
  if (!isSupabaseConfigured || blocks.length === 0) return
  try {
    const rows = blocks.map((b) => ({ organisation_id: orgId, code: b.code, data: b }))
    const { error } = await supabase()
      .from(CLOUD_TABLE)
      .upsert(rows, { onConflict: 'organisation_id,code' })
    if (error) throw new Error(error.message)
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[beme] Failed to upsert block(s) to cloud:', err)
  }
}

/** Delete one or more block codes from the cloud library. */
async function persistBlocksCloudDelete(
  codes: BlockCode[],
  orgId: string
): Promise<void> {
  if (!isSupabaseConfigured || codes.length === 0) return
  try {
    const { error } = await supabase()
      .from(CLOUD_TABLE)
      .delete()
      .eq('organisation_id', orgId)
      .in('code', codes)
    if (error) throw new Error(error.message)
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[beme] Failed to delete block(s) from cloud:', err)
  }
}

// ---------- Unified persistence dispatcher ----------

interface PersistOptions {
  /** When true, persist the whole library (used by setBlockLibrary / reset). */
  full?: boolean
  /** Codes that were just upserted — written as targeted cloud upserts. */
  upsertedCodes?: BlockCode[]
  /** Codes that were just removed — written as targeted cloud deletes. */
  removedCodes?: BlockCode[]
}

/**
 * Persist the current library to whichever stores are active:
 *
 *   - Always to IndexedDB (so the local snapshot stays fresh; serves as the
 *     first-paint cache on next load and as the offline fallback).
 *   - If the user is in an org, also to Supabase. Surgical upserts /
 *     deletes are preferred when the caller knows which codes changed
 *     (cheaper round-trip + less to race against other writers); the `full`
 *     option falls back to delete-then-upsert-all for setBlockLibrary calls.
 */
async function persistLibraryEverywhere(
  lib: Record<BlockCode, Block>,
  opts: PersistOptions
): Promise<void> {
  // Local write — always, regardless of cloud state. Keeps the IndexedDB
  // copy in sync so a reload-while-offline still shows the latest edits.
  void persistLibraryLocal(lib)

  const orgId = getOrgState().currentOrgId
  if (!orgId) return

  if (opts.full) {
    void persistLibraryCloudFull(lib, orgId)
    return
  }
  if (opts.upsertedCodes && opts.upsertedCodes.length > 0) {
    const blocks = opts.upsertedCodes
      .map((code) => lib[code])
      .filter((b): b is Block => Boolean(b))
    void persistBlocksCloudUpsert(blocks, orgId)
  }
  if (opts.removedCodes && opts.removedCodes.length > 0) {
    void persistBlocksCloudDelete(opts.removedCodes, orgId)
  }
}

// ---------- Sync coordinator ----------

/**
 * Tracks which org we last synced from. Null = personal / no org. Used to
 * detect org changes and avoid redundant reloads.
 */
let lastSyncedOrgId: string | null = null
/** Set true once we've completed any sync at least once; gates the bootstrap
 *  upload so a logged-out app at boot doesn't accidentally wipe a new org's
 *  cloud library on first sign-in. */
let initialLocalLoadComplete = false

/**
 * Compare the current in-memory library against `DEFAULT_BLOCK_LIBRARY` to
 * decide whether the user has customisations worth uploading on first
 * bootstrap into an empty org.
 *
 * Considered "non-default" if:
 *   - any key is present in the library but missing from defaults (user added a block), OR
 *   - any key is missing from the library that exists in defaults (user removed a default), OR
 *   - any shared key's value differs (user edited a default).
 */
function isLibraryCustomised(lib: Record<BlockCode, Block>): boolean {
  const defaultKeys = Object.keys(DEFAULT_BLOCK_LIBRARY)
  const libKeys = Object.keys(lib)
  if (defaultKeys.length !== libKeys.length) return true
  for (const k of defaultKeys) {
    if (!(k in lib)) return true
    if (JSON.stringify(lib[k]) !== JSON.stringify(DEFAULT_BLOCK_LIBRARY[k])) return true
  }
  return false
}

/**
 * Reload the in-memory library to match a new org context. Called on app
 * boot (after the org list has loaded) and whenever the user switches orgs.
 *
 *   - orgId === null → load from IndexedDB (personal mode)
 *   - orgId !== null → load from cloud. If the cloud library is empty AND
 *     the local library has user customisations, bootstrap-upload local to
 *     cloud so the user doesn't silently lose their existing setup.
 */
async function syncWithOrg(orgId: string | null): Promise<void> {
  if (orgId === lastSyncedOrgId && initialLocalLoadComplete) return

  if (!orgId) {
    // Personal / offline mode.
    const saved = await loadLibraryLocal()
    if (saved && Object.keys(saved).length > 0) {
      replaceLibraryContents(saved)
    } else {
      // First-time user with no saved library — keep defaults already in place.
    }
    notifyChange()
    lastSyncedOrgId = null
    initialLocalLoadComplete = true
    return
  }

  // Org mode.
  const cloud = await loadLibraryCloud(orgId)
  if (cloud && Object.keys(cloud).length > 0) {
    // Cloud has data — that wins. Replace in-memory + sync the local cache.
    replaceLibraryContents(cloud)
    void persistLibraryLocal(cloud)
    notifyChange()
  } else {
    // Cloud is empty for this org. Two sub-cases:
    //   (a) The current in-memory library is the user's customised local
    //       setup — push it up so their team inherits it (one-time bootstrap).
    //   (b) It's just the seed defaults — leave cloud empty and proceed.
    // Either way, the in-memory library stays where it is.
    if (isLibraryCustomised(BLOCK_LIBRARY)) {
      void persistLibraryCloudFull(BLOCK_LIBRARY, orgId)
    }
    notifyChange() // sync the version even when contents didn't change so
    // useMemo deps tied to libraryVersion re-run after an org switch.
  }
  lastSyncedOrgId = orgId
  initialLocalLoadComplete = true
}

/**
 * Bootstrap the library. Call once at app startup (main.tsx) BEFORE any
 * components mount so the first paint already reflects the user's
 * customisations.
 *
 * Phase 1 — synchronous-ish: read the IndexedDB snapshot so first paint has
 *   the user's last-known library. Cheap (single key read).
 * Phase 2 — when the org context resolves: re-sync from cloud if the user
 *   is in an org. Subscribes to org-state changes so subsequent org
 *   switches reload the library automatically.
 */
export async function initBlockLibrary(): Promise<void> {
  const saved = await loadLibraryLocal()
  if (saved && Object.keys(saved).length > 0) {
    replaceLibraryContents(saved)
    notifyChange()
  }
  initialLocalLoadComplete = true

  // If org state is already resolved at this point (e.g. fast refresh), do
  // the initial sync now. Otherwise the subscription below picks it up.
  const initialOrg = getOrgState()
  if (!initialOrg.loading) {
    void syncWithOrg(initialOrg.currentOrgId)
  }

  // Re-sync whenever the active org changes (sign-in, sign-out, switch).
  subscribeToOrgState(() => {
    const s = getOrgState()
    if (s.loading) return // wait for the fetch to settle
    void syncWithOrg(s.currentOrgId)
  })
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Look up a single block by code. */
export function getBlock(code: BlockCode): Block | undefined {
  return BLOCK_LIBRARY[code]
}

/** All blocks that can play a given role. */
export function getBlocksByRole(role: BlockRole): Block[] {
  return Object.values(BLOCK_LIBRARY).filter((b) => b.roles.includes(role))
}

/**
 * Fraction blocks available for length makeup, in ascending order of fraction.
 * Excludes blocks ALSO tagged `end-termination` — those (like the SEQ 20.03)
 * are technically half blocks but reserved for end-termination duty, not
 * length packing.
 */
export function getFractionBlocksForLengthMakeup(): Block[] {
  return Object.values(BLOCK_LIBRARY)
    .filter(
      (b) =>
        b.fraction !== undefined &&
        b.roles.includes('fraction') &&
        !b.roles.includes('end-termination')
    )
    .sort((a, b) => (a.fraction ?? 0) - (b.fraction ?? 0))
}

// ─── Role-based resolvers ───────────────────────────────────────────────────
//
// Region-agnostic picks for slots the calc engine needs to fill. Each
// resolver searches the live library by role + dimensions instead of by
// hardcoded code, so the engine works for any user-defined library:
//
//   - AU users get their existing 20.XX blocks (already role-tagged in the
//     seed library, so behaviour is unchanged).
//   - US / UK / EU users tag their own blocks with the same roles and the
//     engine finds them automatically.
//
// All resolvers come in two flavours:
//   - `pickXxxIn(library)` — pure form that takes a library reference.
//     Useful when the caller already has the library via useBlockLibrary
//     or in tests.
//   - `pickXxx()` — convenience that reads from the BLOCK_LIBRARY
//     singleton.

/**
 * The "half block" used at end terminations on alternating courses in
 * stretcher bond. Role `end-termination` with `fraction: 0.5`.
 */
export function pickHalfBlockIn(
  library: Record<BlockCode, Block>
): Block | undefined {
  return Object.values(library).find(
    (b) => b.roles.includes('end-termination') && b.fraction === 0.5
  )
}
export function pickHalfBlock(): Block | undefined {
  return pickHalfBlockIn(BLOCK_LIBRARY)
}

/**
 * Fraction blocks available for length makeup. Excludes end-termination
 * blocks (those are reserved). Sorted by face width descending so a packer
 * tries the biggest piece first.
 */
export function pickFractionBlocksIn(
  library: Record<BlockCode, Block>
): Block[] {
  return Object.values(library)
    .filter(
      (b) =>
        b.roles.includes('fraction') &&
        !b.roles.includes('end-termination') &&
        b.fraction !== undefined
    )
    .sort((a, b) => b.dimensions.widthMm - a.dimensions.widthMm)
}
export function pickFractionBlocks(): Block[] {
  return pickFractionBlocksIn(BLOCK_LIBRARY)
}

/**
 * Height-makeup block whose height exactly equals `targetHeightMm`, or the
 * closest under it if no exact match exists. Returns undefined if no
 * height-makeup blocks are defined.
 */
export function pickHeightMakeupBlockIn(
  library: Record<BlockCode, Block>,
  targetHeightMm: number
): Block | undefined {
  const candidates = Object.values(library)
    .filter((b) => b.roles.includes('height-makeup'))
    .sort((a, b) => b.dimensions.heightMm - a.dimensions.heightMm)
  return (
    candidates.find((b) => b.dimensions.heightMm === targetHeightMm) ??
    candidates.find((b) => b.dimensions.heightMm <= targetHeightMm)
  )
}
export function pickHeightMakeupBlock(targetHeightMm: number): Block | undefined {
  return pickHeightMakeupBlockIn(BLOCK_LIBRARY, targetHeightMm)
}

/**
 * Curve-wedge block — tapered face for tight-radius curved walls. Single
 * match expected; returns undefined if none defined.
 */
export function pickCurveWedgeIn(
  library: Record<BlockCode, Block>
): Block | undefined {
  return Object.values(library).find((b) => b.roles.includes('curve-tight'))
}
export function pickCurveWedge(): Block | undefined {
  return pickCurveWedgeIn(BLOCK_LIBRARY)
}

/**
 * Pier block — the column block used in tied and freestanding piers.
 * Single match expected; returns undefined if none defined.
 */
export function pickPierBlockIn(
  library: Record<BlockCode, Block>
): Block | undefined {
  return Object.values(library).find((b) => b.roles.includes('pier'))
}
export function pickPierBlock(): Block | undefined {
  return pickPierBlockIn(BLOCK_LIBRARY)
}

/**
 * Lintel block sized to cover a given head height. Picks the SMALLEST
 * lintel whose heightMm ≥ the head height — the lintel has to fully bridge
 * the head course, so a 290 mm lintel can't be used for a 310 mm head even
 * though it's the closest in size; you need the 390 instead.
 *
 * If no lintel in the library is tall enough on its own, returns the
 * tallest one so the calc engine can stack multiple vertically to reach
 * the head height. Returns undefined only if there are no lintel blocks
 * in the library at all.
 *
 * The "vertical module" is derived from the block's heightMm — a 200 mm
 * lintel block lives on a 200 mm vertical module, a 300 mm block on 300,
 * etc. Callers needing the precise module read it from the returned block.
 */
export function pickLintelBlockIn(
  library: Record<BlockCode, Block>,
  openingHeightMm: number
): Block | undefined {
  const candidates = Object.values(library)
    .filter((b) => b.roles.includes('lintel'))
    .sort((a, b) => a.dimensions.heightMm - b.dimensions.heightMm)
  // First lintel ≥ head height. If none, fall back to the tallest — the
  // calc engine will stack it as many times as needed to span the head.
  return (
    candidates.find((b) => b.dimensions.heightMm >= openingHeightMm) ??
    candidates[candidates.length - 1]
  )
}
export function pickLintelBlock(openingHeightMm: number): Block | undefined {
  return pickLintelBlockIn(BLOCK_LIBRARY, openingHeightMm)
}
