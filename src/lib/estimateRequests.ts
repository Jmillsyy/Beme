/**
 * Estimate request storage — cloud-only.
 *
 * Unlike Projects (which fall back to IndexedDB when offline), estimate
 * requests only make sense in a multi-user / org context, so they require
 * Supabase to be configured and the user to be signed in. The schema is in
 * SETUP.md section 7. Path layout for uploaded plan PDFs is
 * `<organisation_id>/<request_id>.pdf` in the `estimate-request-plans`
 * bucket; RLS scopes both rows and storage objects to org members.
 */

import type {
  EstimateRequest,
  EstimateRequestDraft,
  EstimateRequestStatus,
} from '../types/estimateRequests'
import type { ProjectType, SavedProject } from './projectStorage'
import { generateProjectId, saveProject } from './projectStorage'
import { createDefaultProjectDetails, createDefaultExportInclusions } from './brickExport'
import { createDefaultBlockExportInclusions } from './blockExport'
import { createDefaultBrickSettings } from './brickCalc'
import { createDefaultWallMakeup, createDefaultPierMakeups } from './makeups'
import { isSupabaseConfigured, supabase } from './supabase'

const PLANS_BUCKET = 'estimate-request-plans'

/**
 * Shape of a row coming back from Supabase. Snake-case column names, plus
 * the loose object shape that lets us add fields without changing the
 * conversion code immediately.
 */
interface RequestRow {
  id: string
  organisation_id: string
  created_by_user_id: string
  assigned_to_user_id: string | null
  project_id: string | null
  type: ProjectType
  status: EstimateRequestStatus
  customer_name: string
  customer_email: string | null
  customer_phone: string | null
  customer_company: string | null
  inclusion_notes: string | null
  plan_pdf_path: string | null
  plan_pdf_file_name: string | null
  /**
   * Stored as a JSONB column. Old requests created before multi-file
   * support don't have this — read as undefined → no additional PDFs.
   * Schema migration in SETUP.md.
   */
  additional_pdfs: { path: string; fileName: string }[] | null
  created_at: string
  updated_at: string
  completed_at: string | null
}

function rowToRequest(row: RequestRow): EstimateRequest {
  return {
    id: row.id,
    organisationId: row.organisation_id,
    createdByUserId: row.created_by_user_id,
    assignedToUserId: row.assigned_to_user_id,
    projectId: row.project_id,
    type: row.type,
    status: row.status,
    customerName: row.customer_name,
    customerEmail: row.customer_email ?? undefined,
    customerPhone: row.customer_phone ?? undefined,
    customerCompany: row.customer_company ?? undefined,
    inclusionNotes: row.inclusion_notes ?? undefined,
    planPdfPath: row.plan_pdf_path ?? undefined,
    planPdfFileName: row.plan_pdf_file_name ?? undefined,
    additionalPdfs: row.additional_pdfs ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at ?? undefined,
  }
}

/**
 * Create a new estimate request inside the given org. Uploads the plan PDF
 * (if supplied) to Supabase Storage first, then inserts the row with a
 * matching `plan_pdf_path`. Returns the saved request.
 *
 * Caller must have a Supabase session and be a member of `orgId` (RLS will
 * reject the insert otherwise).
 */
export async function createEstimateRequest(
  orgId: string,
  draft: EstimateRequestDraft
): Promise<EstimateRequest> {
  if (!isSupabaseConfigured) {
    throw new Error('Estimate requests require Supabase to be configured.')
  }
  const client = supabase()
  const {
    data: { user },
  } = await client.auth.getUser()
  if (!user) throw new Error('You need to be signed in to create estimate requests.')

  // Generate the row id up front so we can name the PDF after it. Insert
  // the row second, after the (optional) PDF upload — that way if the upload
  // fails we don't leave a dangling row pointing at storage that doesn't
  // exist. crypto.randomUUID is available in every browser we support.
  const requestId =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `er-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`

  let planPath: string | null = null
  let planFileName: string | null = null
  if (draft.planFile) {
    planPath = `${orgId}/${requestId}.pdf`
    planFileName = draft.planFile.name
    const { error: uploadErr } = await client.storage
      .from(PLANS_BUCKET)
      .upload(planPath, draft.planFile, {
        contentType: draft.planFile.type || 'application/pdf',
        upsert: false,
      })
    if (uploadErr) {
      throw new Error(`Plan upload failed: ${uploadErr.message}`)
    }
  }

  // Additional PDFs (engineering, etc.) — uploaded after the primary so we
  // can include their paths on the row insert below. Each file gets a
  // sequential suffix under the same RLS scope as the primary, so they
  // share the row's permissions and clean up as a unit when the request is
  // deleted.
  const additionalUploaded: { path: string; fileName: string }[] = []
  const uploadedPaths: string[] = []
  for (let i = 0; i < (draft.additionalFiles ?? []).length; i++) {
    const file = draft.additionalFiles![i]
    const path = `${orgId}/${requestId}-ref-${i}.pdf`
    const { error: refErr } = await client.storage
      .from(PLANS_BUCKET)
      .upload(path, file, {
        contentType: file.type || 'application/pdf',
        upsert: false,
      })
    if (refErr) {
      // Roll back everything uploaded so far so we never leave orphans.
      const allPaths = [...uploadedPaths, ...(planPath ? [planPath] : [])]
      if (allPaths.length > 0) {
        await client.storage.from(PLANS_BUCKET).remove(allPaths).catch(() => {})
      }
      throw new Error(`Reference PDF upload failed (${file.name}): ${refErr.message}`)
    }
    uploadedPaths.push(path)
    additionalUploaded.push({ path, fileName: file.name })
  }

  const insertRow = {
    id: requestId,
    organisation_id: orgId,
    created_by_user_id: user.id,
    assigned_to_user_id: draft.assignedToUserId ?? null,
    type: draft.type,
    status: 'pending' as EstimateRequestStatus,
    customer_name: draft.customerName,
    customer_email: draft.customerEmail ?? null,
    customer_phone: draft.customerPhone ?? null,
    customer_company: draft.customerCompany ?? null,
    inclusion_notes: draft.inclusionNotes ?? null,
    plan_pdf_path: planPath,
    plan_pdf_file_name: planFileName,
    additional_pdfs: additionalUploaded.length > 0 ? additionalUploaded : null,
  }

  const { data, error } = await client
    .from('estimate_requests')
    .insert(insertRow)
    .select()
    .single()
  if (error) {
    // Roll back every storage upload if the row insert failed so we don't
    // leave orphaned PDFs in the bucket.
    const allPaths = [...uploadedPaths, ...(planPath ? [planPath] : [])]
    if (allPaths.length > 0) {
      await client.storage.from(PLANS_BUCKET).remove(allPaths).catch(() => {})
    }
    throw new Error(`Couldn't create request: ${error.message}`)
  }
  return rowToRequest(data as RequestRow)
}

/**
 * List estimate requests for the current org. RLS filters to ones the user
 * can see (all members can see all org requests for now).
 *
 * `filter` lets the inbox UI scope to "assigned to me" or by status without
 * round-tripping every member's worth of rows.
 */
export async function listEstimateRequests(
  orgId: string,
  filter: {
    status?: EstimateRequestStatus | EstimateRequestStatus[]
    assignedToUserId?: string
  } = {}
): Promise<EstimateRequest[]> {
  if (!isSupabaseConfigured) return []
  const client = supabase()
  let q = client
    .from('estimate_requests')
    .select('*')
    .eq('organisation_id', orgId)
    .order('updated_at', { ascending: false })
  if (filter.status) {
    if (Array.isArray(filter.status)) q = q.in('status', filter.status)
    else q = q.eq('status', filter.status)
  }
  if (filter.assignedToUserId) {
    q = q.eq('assigned_to_user_id', filter.assignedToUserId)
  }
  const { data, error } = await q
  if (error) {
    // eslint-disable-next-line no-console
    console.error('Failed to list estimate requests', error.message)
    return []
  }
  return (data as RequestRow[]).map(rowToRequest)
}

/**
 * Look up the estimate request that produced a given project, if any.
 * Used by the project workspace to surface a "← Request from {customer}"
 * breadcrumb so the estimator can flip back to the spec without losing
 * their place. Returns null for personal projects or any project not
 * created via the pick-up flow.
 */
export async function getEstimateRequestByProjectId(
  projectId: string
): Promise<EstimateRequest | null> {
  if (!isSupabaseConfigured) return null
  const client = supabase()
  const { data, error } = await client
    .from('estimate_requests')
    .select('*')
    .eq('project_id', projectId)
    .maybeSingle()
  if (error || !data) return null
  return rowToRequest(data as RequestRow)
}

/** Single-request fetch. Used by the request detail / claim page. */
export async function getEstimateRequest(
  id: string
): Promise<EstimateRequest | undefined> {
  if (!isSupabaseConfigured) return undefined
  const client = supabase()
  const { data, error } = await client
    .from('estimate_requests')
    .select('*')
    .eq('id', id)
    .maybeSingle()
  if (error) {
    // eslint-disable-next-line no-console
    console.error('Failed to load estimate request', error.message)
    return undefined
  }
  if (!data) return undefined
  return rowToRequest(data as RequestRow)
}

/**
 * Update one or more fields on an estimate request. Returns the updated
 * row. Common transitions:
 *
 *   - Assign / reassign: `{ assignedToUserId: '<uid>' }`
 *   - Pick up: `{ status: 'in_progress', projectId: '<pid>' }` — the
 *     estimator's "claim" action creates a Project and links it here.
 *   - Complete: `{ status: 'completed', completedAt: now }`
 *   - Cancel: `{ status: 'cancelled' }`
 */
export async function updateEstimateRequest(
  id: string,
  patch: Partial<{
    assignedToUserId: string | null
    projectId: string | null
    status: EstimateRequestStatus
    inclusionNotes: string
    customerName: string
    customerEmail: string | null
    customerPhone: string | null
    customerCompany: string | null
  }>
): Promise<EstimateRequest> {
  if (!isSupabaseConfigured) {
    throw new Error('Estimate requests require Supabase to be configured.')
  }
  const client = supabase()
  const row: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if ('assignedToUserId' in patch) row.assigned_to_user_id = patch.assignedToUserId ?? null
  if ('projectId' in patch) row.project_id = patch.projectId ?? null
  if ('status' in patch) {
    row.status = patch.status
    if (patch.status === 'completed') row.completed_at = new Date().toISOString()
    if (patch.status === 'pending' || patch.status === 'in_progress') row.completed_at = null
  }
  if ('inclusionNotes' in patch) row.inclusion_notes = patch.inclusionNotes ?? null
  if ('customerName' in patch) row.customer_name = patch.customerName
  if ('customerEmail' in patch) row.customer_email = patch.customerEmail
  if ('customerPhone' in patch) row.customer_phone = patch.customerPhone
  if ('customerCompany' in patch) row.customer_company = patch.customerCompany

  const { data, error } = await client
    .from('estimate_requests')
    .update(row)
    .eq('id', id)
    .select()
    .single()
  if (error) throw new Error(`Couldn't update request: ${error.message}`)
  return rowToRequest(data as RequestRow)
}

/**
 * Permanently delete an estimate request from the org's workflow — row +
 * the attached plan PDF in storage. Use this for cancelled / completed
 * rows the user wants to clean up out of their inbox.
 *
 * If the request has a linked Project (because the estimator picked it up
 * and worked on it), that project stays — it has its own copy of the
 * plan PDF in `project-pdfs`. Deleting the request only severs the
 * "sales → estimator" breadcrumb; the takeoff itself is untouched and
 * reachable from the dashboard / projects list.
 *
 * Callers should typically gate this behind a confirm dialog because it's
 * not reversible. Soft-delete via `status: 'cancelled'` exists for the
 * audit-trail case (`updateEstimateRequest({status: 'cancelled'})`).
 */
export async function deleteEstimateRequest(id: string): Promise<void> {
  if (!isSupabaseConfigured) {
    throw new Error('Estimate requests require Supabase to be configured.')
  }
  const client = supabase()

  // Look up the row first so we can remove its plan PDF + any additional
  // attachments from storage alongside the row delete. Reading the row also
  // gives RLS a chance to reject early when the caller can't see this
  // request — better error than a silent no-op on the delete.
  const { data, error: fetchErr } = await client
    .from('estimate_requests')
    .select('plan_pdf_path, additional_pdfs')
    .eq('id', id)
    .maybeSingle()
  if (fetchErr) {
    throw new Error(`Couldn't load request to delete: ${fetchErr.message}`)
  }
  const row = data as {
    plan_pdf_path: string | null
    additional_pdfs: { path: string; fileName: string }[] | null
  } | null
  const pathsToRemove: string[] = []
  if (row?.plan_pdf_path) pathsToRemove.push(row.plan_pdf_path)
  for (const a of row?.additional_pdfs ?? []) {
    if (a.path) pathsToRemove.push(a.path)
  }

  // Remove the plan PDFs first. If the storage call fails (e.g. files are
  // already gone) we still want to drop the row, so swallow non-fatal
  // errors and surface only the row-delete failure to the caller.
  if (pathsToRemove.length > 0) {
    await client.storage.from(PLANS_BUCKET).remove(pathsToRemove).catch(() => {})
  }

  const { error: deleteErr } = await client
    .from('estimate_requests')
    .delete()
    .eq('id', id)
  if (deleteErr) {
    throw new Error(`Couldn't delete request: ${deleteErr.message}`)
  }
}

/**
 * Download the plan PDF attached to a request. Returns a Blob the caller can
 * pass to `new File([blob], filename)` to feed into the existing
 * PdfWorkspace. Returns null if the request has no plan attached.
 */
export async function downloadRequestPlan(
  request: EstimateRequest
): Promise<Blob | null> {
  if (!isSupabaseConfigured || !request.planPdfPath) return null
  const client = supabase()
  const { data, error } = await client.storage
    .from(PLANS_BUCKET)
    .download(request.planPdfPath)
  if (error) {
    // eslint-disable-next-line no-console
    console.error('Failed to download request plan', error.message)
    return null
  }
  return data ?? null
}

/**
 * Pick up an estimate request and turn it into a Project the estimator can
 * work on inside the existing PdfWorkspace.
 *
 * Atomic from the user's POV — a single button click; underneath it:
 *
 *   1. Downloads the customer's plan PDF from the estimate-request-plans
 *      bucket (if there is one).
 *   2. Builds a fresh SavedProject seeded with the customer's name (so the
 *      project bar shows useful context), the PDF blob, and the org id.
 *   3. Saves the project (which uploads the PDF to project-pdfs and inserts
 *      the row scoped to the org via RLS).
 *   4. Updates the request to status='in_progress' and links it to the new
 *      project id.
 *
 * Returns the new project id so the caller can navigate the estimator
 * straight into the workspace.
 */
export async function pickUpEstimateRequest(request: EstimateRequest): Promise<string> {
  if (!isSupabaseConfigured) {
    throw new Error('Estimate requests require Supabase to be configured.')
  }

  // Download the plan PDF first — without it the estimator opens an empty
  // workspace, which is fine for requests that came in without an attachment.
  let planBlob: Blob | null = null
  if (request.planPdfPath) {
    planBlob = await downloadRequestPlan(request)
  }

  // Download any additional reference PDFs (engineering specs etc.) so the
  // estimator can flip to them in the workspace. Failures here are
  // non-fatal — the corresponding entry on the project will have no blob,
  // and the workspace tab can show "(file unavailable)" rather than
  // blocking the whole pickup.
  const client = supabase()
  const referencePdfBlobs: { fileName: string; blob?: Blob }[] = []
  for (const ref of request.additionalPdfs ?? []) {
    try {
      const { data: blob, error } = await client.storage
        .from(PLANS_BUCKET)
        .download(ref.path)
      if (error || !blob) {
        // eslint-disable-next-line no-console
        console.warn(`Failed to download additional PDF ${ref.fileName}:`, error?.message)
        referencePdfBlobs.push({ fileName: ref.fileName })
      } else {
        referencePdfBlobs.push({ fileName: ref.fileName, blob })
      }
    } catch {
      referencePdfBlobs.push({ fileName: ref.fileName })
    }
  }

  const projectId = generateProjectId()
  const nowIso = new Date().toISOString()

  // Seed the project with the customer's name so the dashboard and project
  // bar immediately show useful context — the estimator doesn't have to
  // retype "Smith Construction — 14 Mothership Drive" before they start.
  const projectDetails = createDefaultProjectDetails()
  projectDetails.projectName = request.customerCompany || request.customerName
  if (request.customerName && request.customerCompany) {
    projectDetails.clientName = request.customerName
  }

  const baseProject: SavedProject = {
    id: projectId,
    type: request.type,
    status: 'in-progress',
    organisationId: request.organisationId,
    createdAt: nowIso,
    updatedAt: nowIso,
    // Ownership of a request-driven project sticks with whoever CREATED
    // the estimate request — i.e. the sales person who originated the
    // job. The picker is the estimator working on it but doesn't 'own'
    // it. Stamping both fields here means the resulting projects.row
    // shows the creator on read, even though the row is inserted by the
    // picker (RLS allows org members to insert org-scoped rows).
    createdByUserId: request.createdByUserId,
    ownerUserId: request.createdByUserId,
    projectDetails,
    pdfBlob: planBlob
      ? new File(
          [planBlob],
          request.planPdfFileName || `${request.customerName}.pdf`,
          { type: 'application/pdf' }
        )
      : undefined,
    pdfFileName: request.planPdfFileName,
    referencePdfs: referencePdfBlobs.length > 0 ? referencePdfBlobs : undefined,
    pagesData: {},
    wallsByPage: {},
    openingsByPage: {},
    piersByPage: {},
    pierMakeups: createDefaultPierMakeups(),
    currentPage: 1,
    ...(request.type === 'block'
      ? {
          makeups: [createDefaultWallMakeup({ name: 'External 2400mm stretcher' })],
          blockExportInclusions: createDefaultBlockExportInclusions(),
        }
      : {
          brickSettings: createDefaultBrickSettings(),
          exportInclusions: createDefaultExportInclusions(),
        }),
  }

  // saveProject takes care of uploading the PDF to project-pdfs and inserting
  // the row. RLS allows org members to insert rows for projects they own.
  await saveProject(baseProject)

  // Link the request to the new project + flip status.
  await updateEstimateRequest(request.id, {
    status: 'in_progress',
    projectId,
  })

  return projectId
}
