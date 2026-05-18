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
    description: 'Lintel block stacked vertically over openings with head heights greater than 300mm.',
    dimensions: { widthMm: 390, heightMm: 190, depthMm: 190 },
    roles: ['lintel'],
  },
  '20.25': {
    code: '20.25',
    name: '300mm Lintel Block',
    description:
      'Lintel for opening head heights between 200mm and 299mm. Stood upwards so the 290mm ' +
      'dimension is vertical (300mm modular height).',
    dimensions: { widthMm: 290, heightMm: 190, depthMm: 190 },
    roles: ['lintel'],
  },
  '20.13': {
    code: '20.13',
    name: 'Half Lintel Block',
    description:
      'Half-height lintel for opening head heights under 200mm. Stood upwards (200mm modular ' +
      'height). Cubic 190mm block.',
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
  void persistLibrary(BLOCK_LIBRARY)
}

/** Upsert a single block by code. Persists. */
export function upsertBlock(block: Block): void {
  BLOCK_LIBRARY[block.code] = block
  notifyChange()
  void persistLibrary(BLOCK_LIBRARY)
}

/** Remove a block from the library. No-op for protected codes. */
export function removeBlock(code: BlockCode): void {
  if (PROTECTED_BLOCK_CODES.has(code)) return
  if (!(code in BLOCK_LIBRARY)) return
  delete BLOCK_LIBRARY[code]
  notifyChange()
  void persistLibrary(BLOCK_LIBRARY)
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

// ─── Persistence (IndexedDB) ────────────────────────────────────────────────

const DB_NAME = 'beme'
const DB_VERSION = 2 // bumped from 1 to add the user-data store
const USER_DATA_STORE = 'userData'
const LIBRARY_KEY = 'blockLibrary'

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

async function loadLibrary(): Promise<Record<BlockCode, Block> | null> {
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

async function persistLibrary(lib: Record<BlockCode, Block>): Promise<void> {
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

/**
 * Bootstrap the library from IndexedDB. Call once at app startup (main.tsx)
 * BEFORE any components mount so the first paint already reflects the user's
 * customisations.
 */
export async function initBlockLibrary(): Promise<void> {
  const saved = await loadLibrary()
  if (saved && Object.keys(saved).length > 0) {
    replaceLibraryContents(saved)
    notifyChange()
  }
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
 * Excludes 20.03 — it's technically a 1/2 fraction but reserved for end terminations.
 */
export function getFractionBlocksForLengthMakeup(): Block[] {
  return Object.values(BLOCK_LIBRARY)
    .filter((b) => b.fraction !== undefined && b.code !== '20.03')
    .sort((a, b) => (a.fraction ?? 0) - (b.fraction ?? 0))
}
