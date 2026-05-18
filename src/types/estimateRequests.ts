/**
 * Estimate Request — the multi-user workflow primitive.
 *
 * An *estimate request* is the bridge between a sales rep and an estimator
 * inside an organisation. The rep creates one when a customer asks for a
 * takeoff ("plans + 'include ties + plascourse, garage lintel only'"); the
 * estimator picks it up, completes the work in Beme (a normal Project gets
 * linked to the request), and returns it. Status flows from `pending` →
 * `in_progress` → `completed`, with `cancelled` as an escape hatch.
 *
 * Personal / single-user accounts (supply-and-lay bricklayers without an org)
 * don't use this at all — they just create Projects directly. The org layer
 * is additive.
 */
import type { ProjectType } from '../lib/projectStorage'

/**
 * Lifecycle of an estimate request.
 *
 * - **pending**: created by sales, not yet picked up by an estimator. Sits
 *   in the assigned estimator's inbox.
 * - **in_progress**: estimator has opened the request and started work
 *   (linked Project exists). The original PDF is loaded into the workspace.
 * - **completed**: estimator marked it done; the linked project's tally
 *   and exported PDF are the deliverable back to sales.
 * - **cancelled**: customer pulled the job, or the request was a mistake.
 *   Soft-deleted: row stays for audit, but it drops out of active queues.
 */
export type EstimateRequestStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled'

export function estimateRequestStatusLabel(s: EstimateRequestStatus): string {
  switch (s) {
    case 'pending':
      return 'Pending'
    case 'in_progress':
      return 'In progress'
    case 'completed':
      return 'Completed'
    case 'cancelled':
      return 'Cancelled'
  }
}

export interface EstimateRequest {
  id: string
  organisationId: string
  /** User id of the sales rep / admin who created the request. */
  createdByUserId: string
  /** User id of the estimator assigned to the request. Null = unassigned. */
  assignedToUserId: string | null
  /**
   * Project id created when the estimator picks up the request. Null while
   * the request is still pending. When the project is completed, this row's
   * status moves to 'completed'.
   */
  projectId: string | null
  type: ProjectType
  status: EstimateRequestStatus

  customerName: string
  customerEmail?: string
  customerPhone?: string
  customerCompany?: string

  /**
   * Free-text from the sales rep describing what the customer wants in the
   * estimate — e.g. "Brick veneer 230mm, include ties + plascourse, only the
   * garage lintel needs sizing, exclude piers." This becomes the estimator's
   * spec when they pick up the request.
   */
  inclusionNotes?: string

  /** Storage path of the PRIMARY plan PDF the customer supplied (the
   *  architectural — the one walls get drawn against on pickup). Null if no
   *  plan was attached yet. */
  planPdfPath?: string
  planPdfFileName?: string
  /**
   * Additional PDFs attached to the request (engineering specs, notes,
   * etc.). On pickup they become the project's referencePdfs — the
   * estimator can flip to them in the workspace but walls are still drawn
   * only on the primary plan above. Empty / undefined when the request
   * was created with a single file (or none).
   */
  additionalPdfs?: { path: string; fileName: string }[]

  createdAt: string
  updatedAt: string
  completedAt?: string
}

/** What the create-request form supplies. Server fills in the rest. */
export interface EstimateRequestDraft {
  type: ProjectType
  assignedToUserId: string | null
  customerName: string
  customerEmail?: string
  customerPhone?: string
  customerCompany?: string
  inclusionNotes?: string
  /** Primary plan (architectural — the one walls will be drawn on). */
  planFile?: File
  /** Reference PDFs (engineering specs etc.) — view-only after pickup. */
  additionalFiles?: File[]
}
