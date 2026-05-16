/**
 * Project storage — cloud-first when Supabase is configured and the user is
 * signed in, otherwise falls back to local IndexedDB.
 *
 * The cloud schema is:
 *
 *   table `projects`:
 *     id           uuid  primary key
 *     user_id      uuid  references auth.users (RLS-scoped)
 *     type         text  'block' | 'brick'
 *     status       text  'in-progress' | 'completed'
 *     created_at, updated_at, completed_at  timestamptz
 *     data         jsonb (everything else on SavedProject minus the PDF)
 *     pdf_path     text  (path in supabase storage bucket project-pdfs)
 *     pdf_file_name text
 *
 *   storage bucket `project-pdfs`:
 *     path = `<user_id>/<project_id>.pdf` — RLS-scoped to owner
 *
 * Both have Row Level Security policies so each user only ever reads / writes
 * their own rows. See SETUP.md for the SQL.
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
import { isSupabaseConfigured, supabase } from './supabase'

export type ProjectType = 'block' | 'brick'
export type ProjectStatus = 'in-progress' | 'completed'
/**
 * Sales outcome for the project's quote.
 *
 * - 'won': customer accepted the quote → the bricklayer is doing / did the work
 * - 'lost': customer went elsewhere → quote was declined
 * - undefined: pending — no decision yet (still quoted, awaiting response, etc.)
 *
 * Independent of `status`: a 'won' project can be either in-progress or completed.
 * Drives the dashboard's win-rate donut.
 */
export type ProjectOutcome = 'won' | 'lost'

/** What we save per page about the PDF (e.g. scale calibration). */
export interface SavedPageData {
  /**
   * Real-world-mm per page-mm (e.g. 100 for a 1:100 plan). Window-independent —
   * the canvas pixel scale is derived at render time from this ratio + the PDF's
   * intrinsic `pageWidthMm` + the current canvas width. This is the canonical
   * scale field going forward.
   */
  pageScaleRatio?: number
  /**
   * @deprecated Pre-fix scale (canvas-pixel-relative). Retained so projects
   * saved before the page-ratio refactor still load — the workspace migrates
   * them to `pageScaleRatio` on first open and stops writing this field.
   */
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
  /** Sales outcome — undefined = pending. See {@link ProjectOutcome}. */
  outcome?: ProjectOutcome

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

export type SavedProjectSummary = Omit<SavedProject, 'pdfBlob'>

// ---------- Public API — dispatches between cloud and local ----------

export function generateProjectId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/** Insert or update a saved project. */
export async function saveProject(project: SavedProject): Promise<void> {
  const uid = await currentUserId()
  if (uid) return cloudSaveProject(project, uid)
  return localSaveProject(project)
}

/** Load a single project by id. Returns undefined if not found. */
export async function getProject(id: string): Promise<SavedProject | undefined> {
  const uid = await currentUserId()
  if (uid) return cloudGetProject(id, uid)
  return localGetProject(id)
}

/** List every saved project. Sorted by `updatedAt` descending. */
export async function listProjects(): Promise<SavedProject[]> {
  const uid = await currentUserId()
  if (uid) return cloudListProjects(uid)
  return localListProjects()
}

/** Delete a project by id. */
export async function deleteProject(id: string): Promise<void> {
  const uid = await currentUserId()
  if (uid) return cloudDeleteProject(id, uid)
  return localDeleteProject(id)
}

/**
 * Read the local (IndexedDB) project list without touching the cloud. Used by
 * the first-time-login migration prompt.
 */
export async function listLocalProjects(): Promise<SavedProject[]> {
  return localListProjects()
}

/**
 * Wipe the local IndexedDB project store. Used after a successful cloud
 * migration so the user isn't double-prompted on the next sign-in.
 */
export async function clearLocalProjects(): Promise<void> {
  await withLocalStore('readwrite', (s) => s.clear())
}

// ---------- Cloud (Supabase) ----------

const PDF_BUCKET = 'project-pdfs'

/** Resolve the currently signed-in Supabase user id, or null if signed out / not configured. */
async function currentUserId(): Promise<string | null> {
  if (!isSupabaseConfigured) return null
  const {
    data: { user },
  } = await supabase().auth.getUser()
  return user?.id ?? null
}

/** Strip the runtime-only fields out of SavedProject so the rest fits the `data` JSONB column. */
function projectToCloudRow(p: SavedProject, userId: string, pdfPath: string | null) {
  // Anything that isn't a top-level column lives inside `data`. We deliberately
  // exclude pdfBlob (binary, stored in Storage) and pdfFileName (separate column
  // so we can read it from the project list without parsing JSON).
  const {
    id,
    type,
    status,
    createdAt,
    updatedAt,
    completedAt,
    pdfBlob: _pdfBlob,
    pdfFileName,
    ...rest
  } = p
  void _pdfBlob
  return {
    id,
    user_id: userId,
    type,
    status,
    created_at: createdAt,
    updated_at: updatedAt,
    completed_at: completedAt ?? null,
    data: rest,
    pdf_path: pdfPath,
    pdf_file_name: pdfFileName ?? null,
  }
}

interface CloudProjectRow {
  id: string
  user_id: string
  type: ProjectType
  status: ProjectStatus
  created_at: string
  updated_at: string
  completed_at: string | null
  data: Omit<
    SavedProject,
    'id' | 'type' | 'status' | 'createdAt' | 'updatedAt' | 'completedAt' | 'pdfBlob' | 'pdfFileName'
  >
  pdf_path: string | null
  pdf_file_name: string | null
}

/** Hydrate a row from `projects` back into a SavedProject (without the PDF blob). */
function rowToProjectMeta(row: CloudProjectRow): SavedProject {
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at ?? undefined,
    pdfFileName: row.pdf_file_name ?? undefined,
    ...row.data,
  }
}

async function cloudSaveProject(p: SavedProject, userId: string): Promise<void> {
  const client = supabase()
  let pdfPath: string | null = null

  if (p.pdfBlob) {
    pdfPath = `${userId}/${p.id}.pdf`
    const { error: uploadErr } = await client.storage.from(PDF_BUCKET).upload(pdfPath, p.pdfBlob, {
      upsert: true,
      contentType: p.pdfBlob.type || 'application/pdf',
    })
    if (uploadErr) throw new Error(`PDF upload failed: ${uploadErr.message}`)
  }

  const row = projectToCloudRow(p, userId, pdfPath)
  const { error } = await client.from('projects').upsert(row, { onConflict: 'id' })
  if (error) throw new Error(`Project save failed: ${error.message}`)
}

async function cloudGetProject(id: string, _userId: string): Promise<SavedProject | undefined> {
  void _userId // RLS does the user filter for us
  const client = supabase()
  const { data, error } = await client
    .from('projects')
    .select('*')
    .eq('id', id)
    .maybeSingle()
  if (error) throw new Error(`Project fetch failed: ${error.message}`)
  if (!data) return undefined

  const row = data as CloudProjectRow
  const project = rowToProjectMeta(row)

  // Fetch the PDF blob if there is one.
  if (row.pdf_path) {
    const { data: blob, error: dlErr } = await client.storage.from(PDF_BUCKET).download(row.pdf_path)
    if (dlErr) {
      // Don't blow up the whole project load — the metadata is still useful.
      // eslint-disable-next-line no-console
      console.warn(`Failed to download PDF for project ${id}:`, dlErr.message)
    } else if (blob) {
      project.pdfBlob = blob
    }
  }

  return project
}

async function cloudListProjects(_userId: string): Promise<SavedProject[]> {
  void _userId // RLS scopes to the current user
  const client = supabase()
  const { data, error } = await client
    .from('projects')
    .select('*')
    .order('updated_at', { ascending: false })
  if (error) throw new Error(`Project list failed: ${error.message}`)
  return (data as CloudProjectRow[]).map(rowToProjectMeta)
}

async function cloudDeleteProject(id: string, userId: string): Promise<void> {
  const client = supabase()
  // Pull the row first so we know if there's a PDF to remove from storage.
  const { data, error: getErr } = await client
    .from('projects')
    .select('pdf_path')
    .eq('id', id)
    .maybeSingle()
  if (getErr) throw new Error(`Project lookup failed: ${getErr.message}`)

  const pdfPath = (data as { pdf_path: string | null } | null)?.pdf_path
  if (pdfPath) {
    const { error: rmErr } = await client.storage.from(PDF_BUCKET).remove([pdfPath])
    if (rmErr) {
      // eslint-disable-next-line no-console
      console.warn(`Failed to remove PDF for ${id}:`, rmErr.message)
    }
  }

  const { error: delErr } = await client.from('projects').delete().eq('id', id).eq('user_id', userId)
  if (delErr) throw new Error(`Project delete failed: ${delErr.message}`)
}

// ---------- Local (IndexedDB) ----------

const DB_NAME = 'beme'
const DB_VERSION = 2 // shared with blockLibrary.ts — bumped to add userData store
const STORE = 'projects'
const USER_DATA_STORE = 'userData'

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' })
      }
      // Keep in sync with the userData store created in blockLibrary.ts
      // (whichever module opens the DB first runs the upgrade).
      if (!db.objectStoreNames.contains(USER_DATA_STORE)) {
        db.createObjectStore(USER_DATA_STORE)
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function withLocalStore<T>(
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

async function localSaveProject(project: SavedProject): Promise<void> {
  await withLocalStore('readwrite', (s) => s.put(project))
}

async function localGetProject(id: string): Promise<SavedProject | undefined> {
  return withLocalStore('readonly', (s) => s.get(id) as IDBRequest<SavedProject | undefined>)
}

async function localListProjects(): Promise<SavedProject[]> {
  const all = await withLocalStore('readonly', (s) => s.getAll() as IDBRequest<SavedProject[]>)
  return all.sort((a, b) => (b.updatedAt > a.updatedAt ? 1 : -1))
}

async function localDeleteProject(id: string): Promise<void> {
  await withLocalStore('readwrite', (s) => s.delete(id))
}
