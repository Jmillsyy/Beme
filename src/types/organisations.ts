/**
 * Organisation & member types.
 *
 * An *organisation* is a workspace shared by multiple Beme users — typically a
 * masonry supplier or reseller (e.g. ABC Building Products). Members have a
 * role that determines what they can do:
 *
 * - **admin**: full control, including managing other members and org branding.
 * - **sales**: can create estimate requests, see all org requests, can't manage
 *   members or org settings. Sends work to estimators.
 * - **estimator**: receives estimate requests, completes them in Beme, returns
 *   them to sales. Can see all org requests.
 *
 * Single-user (supply-and-lay bricklayer) accounts don't need an organisation
 * at all — those users still have personal projects scoped to their user id,
 * unaffected by anything here. The org context is purely additive.
 */

export type OrgRole = 'admin' | 'sales' | 'estimator'

/** Human-readable label for a role — used in the UI. */
export function orgRoleLabel(role: OrgRole): string {
  switch (role) {
    case 'admin':
      return 'Admin'
    case 'sales':
      return 'Sales'
    case 'estimator':
      return 'Estimator'
  }
}

export interface Organisation {
  id: string
  name: string
  /** URL-safe, unique across the platform. Reserved for future routing (e.g. `/abc/...`). */
  slug: string
  /** Optional logo. Replaces the generic "Beme" wordmark on org-branded outputs. */
  logoUrl?: string
  createdAt: string
}

export interface OrgMember {
  id: string
  organisationId: string
  userId: string
  role: OrgRole
  createdAt: string
  /** Hydrated from auth.users when available — convenient for the members list UI. */
  email?: string
  /** Hydrated from the user's OAuth profile (full_name / name) when available. */
  displayName?: string
}
