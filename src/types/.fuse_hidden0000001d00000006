/**
 * Organisation & member types.
 *
 * An *organisation* is a workspace shared by multiple Beme users — typically a
 * masonry supplier or reseller (e.g. ABC Building Products). Members have a
 * role that determines what they can do:
 *
 * - **admin**: full control, including managing other members + org branding,
 *   editing every project in the org (regardless of who owns it), deleting
 *   anyone's project, and granting access on anyone's project.
 * - **staff**: can create estimate requests, see all org requests + projects,
 *   can edit projects they own or have been granted access to, read-only on
 *   everyone else's work. Can grant access on their own projects.
 *
 * `sales` and `estimator` were merged into `staff` in the role-rename
 * migration — they were functionally equivalent in the product. The DB
 * check constraint enforces ('admin', 'staff'); existing rows were updated
 * in-place so no app code needs to handle the legacy values.
 *
 * Single-user (supply-and-lay bricklayer) accounts don't need an organisation
 * at all — those users still have personal projects scoped to their user id,
 * unaffected by anything here. The org context is purely additive.
 */

export type OrgRole = 'admin' | 'staff'

/** Human-readable label for a role — used in the UI. */
export function orgRoleLabel(role: OrgRole): string {
  switch (role) {
    case 'admin':
      return 'Admin'
    case 'staff':
      return 'Staff'
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
