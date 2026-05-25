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
  BrickMakeup,
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

/**
 * A reference PDF attached to a project — view-only material the estimator
 * flips to while working (e.g. engineering specs). `blob` is the runtime
 * file used by the workspace; `path` is the storage key in the
 * `project-pdfs` bucket so the row knows where to re-download the bytes on
 * the next load. Both are optional so a freshly-attached file (blob set,
 * path not yet known) round-trips through saveProject() cleanly.
 */
export interface ReferencePdf {
  fileName: string
  blob?: Blob
  /** Storage path inside the project-pdfs bucket. Populated by saveProject. */
  path?: string
}

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
  /**
   * Six-digit human-readable reference number, allocated by Postgres at
   * insert time (sequence + trigger). Stable across renames + updates;
   * unique per project; surfaced in the project bar, in every exported
   * PDF, and as the lookup key for "find a job by its ref". Optional on
   * the SavedProject so a fresh in-memory project before its first save
   * doesn't have to know it yet — the trigger fills it on insert and the
   * client reads it back on next load.
   */
  referenceNumber?: number
  /**
   * Organisation that owns this project. Null/undefined for personal
   * (single-user) projects. When set, RLS permits any member of the org
   * to see/edit the project, which is how estimate-request work gets
   * shared between sales and estimators inside the same org.
   */
  organisationId?: string
  /** ISO datetime — when the project was first saved. */
  createdAt: string
  /** ISO datetime — most recent save. */
  updatedAt: string
  /** ISO datetime — when status was first set to 'completed'. */
  completedAt?: string
  /**
   * User id of whoever first saved this project — the estimator who started
   * the estimate. Set once at create time and preserved through every
   * subsequent save (including by other org members). Used to surface
   * "Started by {name}" in the project bar so teammates can see who picked
   * up an estimate without having to dig into the row's audit data.
   *
   * Optional + missing on saves predating this field — the project-bar
   * resolver falls back to the cloud row's user_id (the original inserter
   * by RLS) so older projects still show an author.
   */
  createdByUserId?: string
  /**
   * User id of the current "owner" — the person with edit rights on this
   * project (in addition to the org admin and anyone they explicitly
   * shared it with). Starts equal to `createdByUserId` on new projects but
   * TRANSFERS on estimate-request pickup so the picker becomes the editor
   * and the original creator drops back to read-only.
   *
   * Optional + missing on saves predating the read-only feature — the
   * server-side migration backfills it to `coalesce(createdByUserId, user_id)`,
   * so older rows always end up with a sensible owner once the SQL has run.
   *
   * `null` is legal for legacy rows where neither field is set; UI treats
   * that as "fall back to row.user_id (the original inserter)".
   */
  ownerUserId?: string
  /** Sales outcome — undefined = pending. See {@link ProjectOutcome}. */
  outcome?: ProjectOutcome

  projectDetails: ProjectDetails
  /**
   * Project started without a PDF — the user is drawing on a blank canvas at
   * a fixed ratio (defaults to 1:100 metric). The drawing surface is a virtual
   * page seeded into `pagesData[1]`. `pdfBlob` is left undefined and the
   * upload zone is bypassed on reload because of this flag.
   */
  emptyWorkspace?: boolean
  /** Optional — projects can be saved before a PDF is uploaded.
   *  This is the PRIMARY PDF — the one walls / openings / piers are drawn on
   *  (usually the architectural). Reference PDFs (engineering specs etc.)
   *  go on `referencePdfs` below. */
  pdfBlob?: Blob
  pdfFileName?: string
  /**
   * Extra PDFs the estimator can flip to while working on this project —
   * typically engineering specs or notes that inform wall types but aren't
   * drawn on. Walls, openings, and piers all live against the primary PDF
   * above; reference PDFs are view-only. Ordering reflects the order they
   * were attached to the originating estimate request.
   *
   * Optional + defaulted-empty so projects saved before multi-file support
   * still load cleanly.
   */
  referencePdfs?: ReferencePdf[]

  pagesData: Record<number, SavedPageData>
  wallsByPage: Record<number, Wall[]>
  openingsByPage: Record<number, Opening[]>
  /** Piers per page (block mode). Optional — older saved projects predate this field. */
  piersByPage?: Record<number, Pier[]>
  /** Pier makeups (block mode). Optional — older saved projects predate this field. */
  pierMakeups?: PierMakeup[]
  /** Currently-active pier makeup id, if any. Used to seed the next-placed
   *  pier's makeup. Optional + nullable for projects saved before the
   *  panel-level active-pier-makeup state existed. */
  activePierMakeupId?: string | null
  /** Last-viewed page number. */
  currentPage: number

  /**
   * Per-project opt-in/opt-out for supply items defined in the user's
   * Material library. Keys are the supply item's `id`, values are
   * booleans:
   *   - `true`  → include in tally + export for this project
   *   - `false` → exclude from tally + export
   *   - missing → default to included
   *
   * The map only stores explicit decisions; unknown ids default to
   * included so adding a new item to the library shows up on every
   * existing project automatically. Estimators tick / untick per project
   * via the Supply items panel.
   */
  supplyItemSelections?: Record<string, boolean>
  /**
   * Per-project rate overrides for supply items. Keys are the supply
   * item's `id`, values are the rate (in the item's own unit — e.g. 2 for
   * "2 ties per m²"). Lets an estimator dial the rate up or down for an
   * unusual project without editing the library catalogue. Missing keys
   * fall back to the library's default rate, so the override is purely
   * additive — leaving everything blank reproduces library behaviour.
   */
  supplyItemRateOverrides?: Record<string, number>

  // Block-mode-specific
  makeups?: WallMakeup[]
  activeMakeupId?: string
  blockExportInclusions?: BlockExportInclusions

  // Brick-mode-specific
  brickSettings?: BrickSettings
  /**
   * Brick wall makeups — named categories with their own brick type +
   * height (e.g. "Facework", "Rendered"). Parallel to `makeups` on block.
   * Optional + defaulted-empty so projects saved before brick wall types
   * existed still load cleanly (a default makeup is seeded on hydrate).
   */
  brickMakeups?: BrickMakeup[]
  activeBrickMakeupId?: string
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

/**
 * Insert or update a saved project. Returns the persisted SavedProject so
 * callers can pick up server-assigned fields — chiefly `referenceNumber`,
 * which Postgres allocates on first INSERT via a sequence + trigger.
 */
export async function saveProject(project: SavedProject): Promise<SavedProject> {
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

/**
 * Look up a project by its 6-digit reference number. Returns the project's
 * id + type so the caller can navigate directly into the workspace, or null
 * when no project with that reference number is visible to the user.
 *
 * Cloud-only: personal / offline projects don't carry reference numbers.
 * Falls back to a flat scan of the local store for offline users so the
 * helper doesn't error in that mode.
 */
export async function findProjectByReferenceNumber(
  referenceNumber: number
): Promise<{ id: string; type: ProjectType } | null> {
  if (!isSupabaseConfigured) {
    const all = await localListProjects()
    const match = all.find((p) => p.referenceNumber === referenceNumber)
    return match ? { id: match.id, type: match.type } : null
  }
  const uid = await currentUserId()
  if (!uid) return null
  const { data, error } = await supabase()
    .from('projects')
    .select('id, type')
    .eq('reference_number', referenceNumber)
    .maybeSingle()
  if (error) {
    // eslint-disable-next-line no-console
    console.warn('Failed to look up project by reference:', error.message)
    return null
  }
  if (!data) return null
  return { id: data.id as string, type: data.type as ProjectType }
}

/** Delete a project by id. */
export async function deleteProject(id: string): Promise<void> {
  const uid = await currentUserId()
  if (uid) return cloudDeleteProject(id, uid)
  return localDeleteProject(id)
}

/**
 * Duplicate an existing project as a new in-progress project. Copies wall types,
 * brick settings, pier patterns, export inclusions — the full "this is how I
 * estimate" boilerplate — but starts with no walls / openings / piers / PDFs
 * and a fresh project name. The user's typical workflow ("same client, new
 * job, same wall types") becomes one click instead of recreating setup.
 *
 * Returns the new project's id so the caller can route the user into it.
 */
export async function duplicateProject(sourceId: string): Promise<string | null> {
  const source = await getProject(sourceId)
  if (!source) return null
  const now = new Date().toISOString()
  const newId = generateProjectId()
  const baseName = source.projectDetails.projectName?.trim() || 'Untitled project'
  const copy: SavedProject = {
    id: newId,
    type: source.type,
    status: 'in-progress',
    organisationId: source.organisationId,
    createdAt: now,
    updatedAt: now,
    // Drop completedAt / outcome — the new project hasn't been won/lost yet.
    projectDetails: {
      ...source.projectDetails,
      projectName: `${baseName} (copy)`,
      // Reset siteAddress + date — usually different per job. Estimator name
      // + client name often stay the same so we keep those, and the user can
      // edit them in the side panel anyway.
      siteAddress: '',
      date: now.slice(0, 10),
      notes: '',
    },
    // PDFs are NOT copied — a new job has a new plan. Estimator uploads it.
    pdfBlob: undefined,
    pdfFileName: undefined,
    referencePdfs: undefined,
    // Drawn data is also NOT copied — the whole point is a clean canvas with
    // the user's preferred setup pre-loaded.
    pagesData: {},
    wallsByPage: {},
    openingsByPage: {},
    piersByPage: {},
    currentPage: 1,
    // Preserve the user's setup work — wall types, pier makeups, export prefs.
    makeups: source.makeups,
    activeMakeupId: source.activeMakeupId,
    pierMakeups: source.pierMakeups,
    blockExportInclusions: source.blockExportInclusions,
    brickSettings: source.brickSettings,
    brickMakeups: source.brickMakeups,
    activeBrickMakeupId: source.activeBrickMakeupId,
    exportInclusions: source.exportInclusions,
  }
  await saveProject(copy)
  return newId
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
  //
  // Reference PDFs go into `data` as { fileName, path } pairs — the blob lives
  // in storage at `path`, we don't serialise the bytes into JSONB.
  const {
    id,
    type,
    status,
    organisationId,
    createdAt,
    updatedAt,
    completedAt,
    ownerUserId,
    referenceNumber,
    pdfBlob: _pdfBlob,
    pdfFileName,
    referencePdfs,
    ...rest
  } = p
  void _pdfBlob
  const referencePdfMeta = referencePdfs?.map((r) => ({ fileName: r.fileName, path: r.path }))
  // Default owner to the inserting user on first save — the SQL migration
  // backfills existing rows, but new inserts from app code need to fill
  // the column themselves. Subsequent saves preserve whatever owner the
  // pickup flow or share UI set it to.
  //
  // referenceNumber is intentionally NOT sent on save — the DB allocates
  // it via a trigger on INSERT and the client reads it back on next load.
  // Sending it would risk clobbering an existing row's number on update.
  void referenceNumber
  return {
    id,
    user_id: userId,
    organisation_id: organisationId ?? null,
    owner_user_id: ownerUserId ?? userId,
    type,
    status,
    created_at: createdAt,
    updated_at: updatedAt,
    completed_at: completedAt ?? null,
    data: { ...rest, referencePdfs: referencePdfMeta },
    pdf_path: pdfPath,
    pdf_file_name: pdfFileName ?? null,
  }
}

interface CloudProjectRow {
  id: string
  user_id: string
  organisation_id: string | null
  owner_user_id: string | null
  reference_number: number | null
  type: ProjectType
  status: ProjectStatus
  created_at: string
  updated_at: string
  completed_at: string | null
  data: Omit<
    SavedProject,
    | 'id'
    | 'type'
    | 'status'
    | 'organisationId'
    | 'ownerUserId'
    | 'referenceNumber'
    | 'createdAt'
    | 'updatedAt'
    | 'completedAt'
    | 'pdfBlob'
    | 'pdfFileName'
  >
  pdf_path: string | null
  pdf_file_name: string | null
}

/** Hydrate a row from `projects` back into a SavedProject (without the PDF blob). */
function rowToProjectMeta(row: CloudProjectRow): SavedProject {
  // Resolve ownerUserId with a fallback chain. New rows always have
  // owner_user_id set, but defensively fall back to user_id (the original
  // inserter) so older / partially-migrated rows still produce a sensible
  // owner for the permission check.
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    organisationId: row.organisation_id ?? undefined,
    ownerUserId: row.owner_user_id ?? row.user_id,
    referenceNumber: row.reference_number ?? undefined,
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

  // Reference PDFs (engineering specs etc.) — upload any whose blob hasn't yet
  // been persisted (path missing) and record their storage path back on the
  // SavedProject before serialising the row. Path scheme:
  //   `${userId}/${projectId}-ref-${index}.pdf`
  // keeps them under the same RLS scope as the primary PDF and trivially
  // collectable on delete.
  const refUploaded: ReferencePdf[] = []
  if (p.referencePdfs && p.referencePdfs.length > 0) {
    for (let i = 0; i < p.referencePdfs.length; i++) {
      const ref = p.referencePdfs[i]
      let path = ref.path
      if (ref.blob && !path) {
        path = `${userId}/${p.id}-ref-${i}.pdf`
        const { error: refErr } = await client.storage.from(PDF_BUCKET).upload(path, ref.blob, {
          upsert: true,
          contentType: ref.blob.type || 'application/pdf',
        })
        if (refErr) throw new Error(`Reference PDF upload failed (${ref.fileName}): ${refErr.message}`)
      }
      refUploaded.push({ fileName: ref.fileName, blob: ref.blob, path })
    }
  }

  const projectForRow: SavedProject = { ...p, referencePdfs: refUploaded }
  const row = projectToCloudRow(projectForRow, userId, pdfPath)
  // Ask Supabase to return the saved row so we can pick up server-allocated
  // fields (referenceNumber, primarily). The .select().single() chain keeps
  // the upsert atomic and avoids a follow-up SELECT round-trip.
  const { data, error } = await client
    .from('projects')
    .upsert(row, { onConflict: 'id' })
    .select()
    .single()
  if (error) throw new Error(`Project save failed: ${error.message}`)
  const persisted = rowToProjectMeta(data as CloudProjectRow)
  // Re-attach the in-memory blobs (the cloud row doesn't carry pdfBlob /
  // referencePdfs.blob), so the caller gets a complete SavedProject with
  // the new referenceNumber AND its existing file objects.
  return {
    ...persisted,
    pdfBlob: p.pdfBlob,
    referencePdfs: refUploaded,
  }
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

  // Reference PDFs — download each one so the workspace can switch to it.
  // A failed download on a single reference doesn't block the project load;
  // the entry stays in the array without a blob and the workspace shows a
  // "(file unavailable)" hint on that tab.
  if (project.referencePdfs && project.referencePdfs.length > 0) {
    const downloaded: ReferencePdf[] = []
    for (const ref of project.referencePdfs) {
      if (!ref.path) {
        downloaded.push(ref)
        continue
      }
      const { data: refBlob, error: refErr } = await client.storage
        .from(PDF_BUCKET)
        .download(ref.path)
      if (refErr) {
        // eslint-disable-next-line no-console
        console.warn(`Failed to download reference PDF ${ref.fileName}:`, refErr.message)
        downloaded.push({ ...ref, blob: undefined })
      } else {
        downloaded.push({ ...ref, blob: refBlob ?? undefined })
      }
    }
    project.referencePdfs = downloaded
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
  // Pull the row first so we know what to remove from storage — both the
  // primary PDF and any reference PDFs (engineering specs etc.) attached to
  // the project. Reference paths live inside the `data` JSON column.
  const { data, error: getErr } = await client
    .from('projects')
    .select('pdf_path, data')
    .eq('id', id)
    .maybeSingle()
  if (getErr) throw new Error(`Project lookup failed: ${getErr.message}`)

  const row = data as { pdf_path: string | null; data: { referencePdfs?: { path?: string }[] } } | null
  const toRemove: string[] = []
  if (row?.pdf_path) toRemove.push(row.pdf_path)
  for (const ref of row?.data?.referencePdfs ?? []) {
    if (ref.path) toRemove.push(ref.path)
  }
  if (toRemove.length > 0) {
    const { error: rmErr } = await client.storage.from(PDF_BUCKET).remove(toRemove)
    if (rmErr) {
      // eslint-disable-next-line no-console
      console.warn(`Failed to remove PDFs for ${id}:`, rmErr.message)
    }
  }

  // Delete the row, gated by RLS. Earlier this also had `.eq('user_id', userId)`,
  // which silently no-op'd for org-shared projects whose original creator
  // wasn't the current user — anyone but the project's creator clicked
  // Delete and nothing happened. RLS ('Owner or org admin delete project')
  // is the right gate: it lets the owner OR any org admin delete, and
  // rejects everyone else with a clear error.
  //
  // We also ask Supabase to return the deleted row(s) and check the count,
  // because PostgREST returns success with zero rows when RLS quietly
  // filters the row out — a silent no-op feels broken to the user. Throwing
  // surfaces the failure so the UI can show a sensible message.
  void userId
  const { data: deleted, error: delErr } = await client
    .from('projects')
    .delete()
    .eq('id', id)
    .select('id')
  if (delErr) throw new Error(`Project delete failed: ${delErr.message}`)
  if (!deleted || deleted.length === 0) {
    throw new Error(
      'Project not deleted — you may not have permission. Org admins can delete shared projects; otherwise only the owner can.'
    )
  }
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

async function localSaveProject(project: SavedProject): Promise<SavedProject> {
  await withLocalStore('readwrite', (s) => s.put(project))
  return project
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

// ---------- Per-project collaborators ----------
//
// An org member who's neither the owner nor an admin can still be granted
// edit access on a specific project by the owner (or by an admin acting on
// the owner's behalf). The grants are stored in a small `project_collaborators`
// junction table:
//
//   project_id  uuid not null references projects(id) on delete cascade
//   user_id     uuid not null references auth.users(id) on delete cascade
//   granted_by  uuid (audit only)
//   created_at  timestamptz
//   primary key (project_id, user_id)
//
// RLS:
//   - read: any org member of the project's org (so the UI can show a
//     project's collaborator list to anyone who can see the project).
//   - insert / delete: owner of the project, or admin of the project's
//     org. Collaborators themselves CANNOT add other collaborators —
//     re-share is owner+admin only by product decision.
//
// The helpers below are no-ops in offline mode (no Supabase). Local-only
// users don't have a multi-user concept so collaboration doesn't apply.

export interface ProjectCollaborator {
  projectId: string
  userId: string
  grantedByUserId?: string
  createdAt: string
}

/** Fetch the collaborator user ids for a project. Returns [] when offline. */
export async function listProjectCollaborators(
  projectId: string
): Promise<ProjectCollaborator[]> {
  if (!isSupabaseConfigured) return []
  const client = supabase()
  const { data, error } = await client
    .from('project_collaborators')
    .select('project_id, user_id, granted_by, created_at')
    .eq('project_id', projectId)
  if (error) {
    // eslint-disable-next-line no-console
    console.warn('Failed to list project collaborators:', error.message)
    return []
  }
  type Row = {
    project_id: string
    user_id: string
    granted_by: string | null
    created_at: string
  }
  return (data as Row[]).map((r) => ({
    projectId: r.project_id,
    userId: r.user_id,
    grantedByUserId: r.granted_by ?? undefined,
    createdAt: r.created_at,
  }))
}

/** Grant a teammate edit access on a project. */
export async function addProjectCollaborator(
  projectId: string,
  userId: string
): Promise<void> {
  if (!isSupabaseConfigured) {
    throw new Error('Sharing requires the cloud — not available offline.')
  }
  const client = supabase()
  const {
    data: { user },
  } = await client.auth.getUser()
  const grantedBy = user?.id ?? null
  const { error } = await client
    .from('project_collaborators')
    .upsert(
      { project_id: projectId, user_id: userId, granted_by: grantedBy },
      { onConflict: 'project_id,user_id' }
    )
  if (error) throw new Error(`Failed to add collaborator: ${error.message}`)
}

/** Revoke a teammate's edit access. */
export async function removeProjectCollaborator(
  projectId: string,
  userId: string
): Promise<void> {
  if (!isSupabaseConfigured) {
    throw new Error('Sharing requires the cloud — not available offline.')
  }
  const client = supabase()
  const { error } = await client
    .from('project_collaborators')
    .delete()
    .eq('project_id', projectId)
    .eq('user_id', userId)
  if (error) throw new Error(`Failed to remove collaborator: ${error.message}`)
}

// ---------- Permission helper ----------

/**
 * Centralised "can this user edit this project?" check. Used by the
 * workspace, the project bar, and anywhere else that needs to gate a
 * mutation. Encodes the permission model from the brief:
 *
 *   1. Personal (no-org) project + you're the user_id author → edit.
 *   2. Admin in this project's org → edit anything.
 *   3. ownerUserId matches you → edit your own.
 *   4. You're listed in `collaboratorUserIds` → edit (granted).
 *   5. Otherwise → read-only.
 *
 * Pass `collaboratorUserIds` from a prior call to listProjectCollaborators
 * — the helper is pure (no I/O) so it stays cheap to call on every render.
 */
export function canEditProject(opts: {
  project: SavedProject
  currentUserId: string | null
  isAdminOfOrg: boolean
  collaboratorUserIds: string[]
}): boolean {
  const { project, currentUserId, isAdminOfOrg, collaboratorUserIds } = opts
  if (!currentUserId) return false
  // Personal project (no org) — the original author is the only editor.
  // Fall back to ownerUserId, then createdByUserId, since older personal
  // saves never had those set.
  if (!project.organisationId) {
    const author = project.ownerUserId ?? project.createdByUserId
    if (!author) return true // legacy local-only project, no recorded author
    return author === currentUserId
  }
  // Org project — apply the full ladder.
  if (isAdminOfOrg) return true
  const owner = project.ownerUserId ?? project.createdByUserId
  if (owner && owner === currentUserId) return true
  if (collaboratorUserIds.includes(currentUserId)) return true
  return false
}
