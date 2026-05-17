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
import type { ProjectType } from './projectStorage'
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
  }

  const { data, error } = await client
    .from('estimate_requests')
    .insert(insertRow)
    .select()
    .single()
  if (error) {
    // Roll back the storage upload if the row insert failed so we don't leave
    // orphaned PDFs in the bucket.
    if (planPath) {
      await client.storage.from(PLANS_BUCKET).remove([planPath]).catch(() => {})
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
