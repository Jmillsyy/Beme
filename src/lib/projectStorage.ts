/**
 * Local project storage using IndexedDB.
 *
 * Saves the entire estimate state (PDF blob + walls + openings + settings + makeups + project
 * details) in the browser. No backend required.
 *
 * When we add cloud sync later (Supabase + Microsoft auth per the brief), this module's
 * function signatures should stay roughly the same — the underlying store just changes.
 */

import type {
  BlockExportInclusions,
  BrickExportInclusions,
  BrickSettings,
  Opening,
  Pier,
  PierMakeup,
  ProjectDetails,
  Wall,
  WallMakeup,
} from '../types/walls'

export type ProjectType = 'block' | 'brick'
export type ProjectStatus = 'in-progress' | 'completed'

/** What we save per page about the PDF (e.g. scale calibration). */
export interface SavedPageData {
  scalePxPerMm?: number
  pageWidthMm?: number
  pageHeightMm?: number
}

/**
 * A full saved estimate. All fields needed to fully reconstruct the workspace.
 */
export interface SavedProject {
  id: string
  type: ProjectType
  status: ProjectStatus
  /** ISO datetime — when the project was first saved. */
  createdAt: string
  /** ISO datetime — most recent save. */
  updatedAt: string
  /** ISO datetime — when status was first set to 'completed'. */
  completedAt?: string

  projectDetails: ProjectDetails
  /** Optional — projects can be saved before a PDF is uploaded. */
  pdfBlob?: Blob
  pdfFileName?: string

  pagesData: Record<number, SavedPageData>
  wallsByPage: Record<number, Wall[]>
  openingsByPage: Record<number, Opening[]>
  /** Piers per page (block mode). Optional — older saved projects predate this field. */
  piersByPage?: Record<number, Pier[]>
  /** Pier makeups (block mode). Optional — older saved projects predate this field. */
  pierMakeups?: PierMakeup[]
  /** Last-viewed page number. */
  currentPage: number

  // Block-mode-specific
  makeups?: WallMakeup[]
  activeMakeupId?: string
  blockExportInclusions?: BlockExportInclusions

  // Brick-mode-specific
  brickSettings?: BrickSettings
  /** Brick export inclusion tickboxes. (Block has its own `blockExportInclusions`.) */
  exportInclusions?: BrickExportInclusions
}

/**
 * A lightweight summary used for listing projects on the dashboard without loading the full PDF.
 * Currently we return full SavedProjects (IndexedDB is fast on local reads); if performance
 * becomes an issue we can split into a separate "meta" store.
 */
export type SavedProjectSummary = Omit<SavedProject, 'pdfBlob'>

// ---------- IndexedDB plumbing ----------

const DB_NAME = 'beme'
const DB_VERSION = 1
const STORE = 'projects'

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function withStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T> | T
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE, mode)
        const store = tx.objectStore(STORE)
        const result = fn(store)
        tx.oncomplete = () => {
          if (result && typeof (result as IDBRequest).result !== 'undefined') {
            resolve((result as IDBRequest<T>).result)
          } else {
            resolve(result as T)
          }
        }
        tx.onerror = () => reject(tx.error)
        tx.onabort = () => reject(tx.error)
      })
  )
}

// ---------- Public API ----------

export function generateProjectId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/** Insert or update a saved project. */
export async function saveProject(project: SavedProject): Promise<void> {
  await withStore('readwrite', (s) => s.put(project))
}

/** Load a single project by id. Returns undefined if not found. */
export async function getProject(id: string): Promise<SavedProject | undefined> {
  return withStore('readonly', (s) => s.get(id) as IDBRequest<SavedProject | undefined>)
}

/** List every saved project. Sorted by `updatedAt` descending. */
export async function listProjects(): Promise<SavedProject[]> {
  const all = await withStore('readonly', (s) => s.getAll() as IDBRequest<SavedProject[]>)
  return all.sort((a, b) => (b.updatedAt > a.updatedAt ? 1 : -1))
}

/** Delete a project by id. */
export async function deleteProject(id: string): Promise<void> {
  await withStore('readwrite', (s) => s.delete(id))
}
