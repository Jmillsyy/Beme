/**
 * User settings store — singleton-with-hook pattern, mirrors blockLibrary /
 * brickLibrary architecture. Persists to the same IndexedDB `userData` store.
 *
 *   useUserSettings() → { settings, version }
 *   updateUserSettings(partial) → merge + persist + notify
 *   replaceUserSettings(next)   → overwrite + persist + notify
 *   resetUserSettings()         → restore defaults
 *
 * Bootstrap from main.tsx via initUserSettings() so the first paint already
 * reflects the user's stored preferences.
 */

import { useEffect, useReducer } from 'react'
import { createDefaultUserSettings, type UserSettings } from '../types/userSettings'

// ─── Mutable singleton ──────────────────────────────────────────────────────

let _settings: UserSettings = createDefaultUserSettings()
let _version = 0
const listeners = new Set<() => void>()

function notifyChange() {
  _version++
  listeners.forEach((l) => l())
}

export function getUserSettings(): UserSettings {
  return _settings
}

/**
 * Replace the entire settings object. Used after loading from IndexedDB and
 * for full resets.
 */
export function replaceUserSettings(next: UserSettings): void {
  _settings = next
  notifyChange()
  void persistSettings(_settings)
}

/**
 * Shallow-merge a partial update into the current settings. Nested objects
 * (profile / business / preferences / defaults) are merged a level deep, so
 * `updateUserSettings({ profile: { phone: '…' } })` only patches the phone
 * without zeroing out the rest of the profile.
 */
export function updateUserSettings(partial: DeepPartial<UserSettings>): void {
  _settings = {
    profile: { ..._settings.profile, ...(partial.profile ?? {}) },
    business: { ..._settings.business, ...(partial.business ?? {}) },
    preferences: { ..._settings.preferences, ...(partial.preferences ?? {}) },
    defaults: { ..._settings.defaults, ...(partial.defaults ?? {}) },
  }
  notifyChange()
  void persistSettings(_settings)
}

/** Restore the factory defaults. */
export function resetUserSettings(): void {
  replaceUserSettings(createDefaultUserSettings())
}

// ─── React hook ─────────────────────────────────────────────────────────────

export function useUserSettings(): { settings: UserSettings; version: number } {
  const [, force] = useReducer((x: number) => x + 1, 0)
  useEffect(() => {
    listeners.add(force)
    return () => {
      listeners.delete(force)
    }
  }, [])
  return { settings: _settings, version: _version }
}

// ─── Persistence (IndexedDB) ────────────────────────────────────────────────

const DB_NAME = 'beme'
const DB_VERSION = 2 // shared with blockLibrary / brickLibrary / projectStorage
const USER_DATA_STORE = 'userData'
const SETTINGS_KEY = 'userSettings'

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

async function loadSettings(): Promise<UserSettings | null> {
  try {
    const db = await openDb()
    return await new Promise<UserSettings | null>((resolve, reject) => {
      const tx = db.transaction(USER_DATA_STORE, 'readonly')
      const store = tx.objectStore(USER_DATA_STORE)
      const req = store.get(SETTINGS_KEY)
      req.onsuccess = () => resolve((req.result as UserSettings | undefined) ?? null)
      req.onerror = () => reject(req.error)
    })
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[beme] Failed to load user settings:', err)
    return null
  }
}

async function persistSettings(s: UserSettings): Promise<void> {
  try {
    const db = await openDb()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(USER_DATA_STORE, 'readwrite')
      const store = tx.objectStore(USER_DATA_STORE)
      store.put({ ...s }, SETTINGS_KEY)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[beme] Failed to persist user settings:', err)
  }
}

export async function initUserSettings(): Promise<void> {
  const saved = await loadSettings()
  if (saved) {
    // Merge with defaults so new fields added in future versions don't end
    // up undefined for users who saved older payloads.
    const defaults = createDefaultUserSettings()
    _settings = {
      profile: { ...defaults.profile, ...(saved.profile ?? {}) },
      business: { ...defaults.business, ...(saved.business ?? {}) },
      preferences: { ...defaults.preferences, ...(saved.preferences ?? {}) },
      defaults: { ...defaults.defaults, ...(saved.defaults ?? {}) },
    }
    notifyChange()
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

type DeepPartial<T> = T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T
