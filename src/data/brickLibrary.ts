/**
 * The beme brick library — user-editable, persisted to IndexedDB.
 *
 * Same architecture as the block library: stable singleton, `useBrickLibrary`
 * hook for React subscription, `initBrickLibrary()` for app-startup hydration.
 *
 * Seeded with common Australian brick sizes; users in other regions can edit
 * names / dimensions or add new types via BrickLibraryPanel.
 */

import { useEffect, useReducer } from 'react'
import type { BrickCode, BrickType } from '../types/bricks'

// ─── Seed library ───────────────────────────────────────────────────────────

/**
 * Default brick library — common Australian sizes. The codes are short
 * machine-friendly strings; the human name carries the dimensions for clarity
 * in dropdowns.
 */
export const DEFAULT_BRICK_LIBRARY: Record<BrickCode, BrickType> = {
  standard: {
    code: 'standard',
    name: 'Standard 230×76',
    description: 'The default Australian face brick. ~48 bricks/m².',
    widthMm: 230,
    heightMm: 76,
    depthMm: 110,
  },
  maxi: {
    code: 'maxi',
    name: 'Maxi 290×90',
    description: 'Larger format — wider and slightly taller. ~33 bricks/m².',
    widthMm: 290,
    heightMm: 90,
    depthMm: 110,
  },
  'double-height': {
    code: 'double-height',
    name: 'Double-height 230×162',
    description: 'Twice the height of a standard. ~24 bricks/m².',
    widthMm: 230,
    heightMm: 162,
    depthMm: 110,
  },
  'double-skin': {
    code: 'double-skin',
    name: 'Double-skin 230×76×230',
    description: 'Full-depth brick (cavity inner skin or solid wall). Same face but 230mm deep.',
    widthMm: 230,
    heightMm: 76,
    depthMm: 230,
  },
  'half-height': {
    code: 'half-height',
    name: 'Half-height 230×38',
    description: 'Half-height brick — used for trim courses or matching odd dimensions.',
    widthMm: 230,
    heightMm: 38,
    depthMm: 110,
  },
}

/** Codes the calc engine relies on by name (none currently — bricks are purely data-driven). */
export const PROTECTED_BRICK_CODES = new Set<BrickCode>(['standard'])

// ─── Mutable singleton ──────────────────────────────────────────────────────

export const BRICK_LIBRARY: Record<BrickCode, BrickType> = { ...DEFAULT_BRICK_LIBRARY }

let _version = 0
const listeners = new Set<() => void>()

function notifyChange() {
  _version++
  listeners.forEach((l) => l())
}

function replaceLibraryContents(next: Record<BrickCode, BrickType>) {
  for (const key of Object.keys(BRICK_LIBRARY)) {
    delete BRICK_LIBRARY[key]
  }
  Object.assign(BRICK_LIBRARY, next)
}

export function getBrickLibrary(): Record<BrickCode, BrickType> {
  return BRICK_LIBRARY
}

export function setBrickLibrary(next: Record<BrickCode, BrickType>): void {
  replaceLibraryContents(next)
  notifyChange()
  void persistLibrary(BRICK_LIBRARY)
}

export function upsertBrickType(type: BrickType): void {
  BRICK_LIBRARY[type.code] = type
  notifyChange()
  void persistLibrary(BRICK_LIBRARY)
}

export function removeBrickType(code: BrickCode): void {
  if (PROTECTED_BRICK_CODES.has(code)) return
  if (!(code in BRICK_LIBRARY)) return
  delete BRICK_LIBRARY[code]
  notifyChange()
  void persistLibrary(BRICK_LIBRARY)
}

export function resetBrickLibrary(): void {
  setBrickLibrary({ ...DEFAULT_BRICK_LIBRARY })
}

// ─── React hook ─────────────────────────────────────────────────────────────

export function useBrickLibrary(): { library: Record<BrickCode, BrickType>; version: number } {
  const [, force] = useReducer((x: number) => x + 1, 0)
  useEffect(() => {
    listeners.add(force)
    return () => {
      listeners.delete(force)
    }
  }, [])
  return { library: BRICK_LIBRARY, version: _version }
}

// ─── Persistence (IndexedDB) ────────────────────────────────────────────────

const DB_NAME = 'beme'
const DB_VERSION = 2 // keep in sync with blockLibrary + projectStorage
const USER_DATA_STORE = 'userData'
const LIBRARY_KEY = 'brickLibrary'

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

async function loadLibrary(): Promise<Record<BrickCode, BrickType> | null> {
  try {
    const db = await openDb()
    return await new Promise<Record<BrickCode, BrickType> | null>((resolve, reject) => {
      const tx = db.transaction(USER_DATA_STORE, 'readonly')
      const store = tx.objectStore(USER_DATA_STORE)
      const req = store.get(LIBRARY_KEY)
      req.onsuccess = () => resolve((req.result as Record<BrickCode, BrickType> | undefined) ?? null)
      req.onerror = () => reject(req.error)
    })
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[beme] Failed to load brick library from IndexedDB:', err)
    return null
  }
}

async function persistLibrary(lib: Record<BrickCode, BrickType>): Promise<void> {
  try {
    const db = await openDb()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(USER_DATA_STORE, 'readwrite')
      const store = tx.objectStore(USER_DATA_STORE)
      store.put({ ...lib }, LIBRARY_KEY)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[beme] Failed to persist brick library:', err)
  }
}

export async function initBrickLibrary(): Promise<void> {
  const saved = await loadLibrary()
  if (saved && Object.keys(saved).length > 0) {
    replaceLibraryContents(saved)
    notifyChange()
  }
}
