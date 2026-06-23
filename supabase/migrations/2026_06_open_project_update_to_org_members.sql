-- ============================================================
-- Re-open `projects` UPDATE to any active member of the project's org.
--
-- Why
--   The previous policy (from SETUP.md section 11/12) restricted
--   UPDATE on org-scoped projects to:
--       owner, project_collaborators row, or org admin.
--
--   That was set up alongside the estimate-request inbox flow, which
--   had a "pickup" action that transferred ownership. With the inbox
--   flow removed and the workspace now correctly preserving the
--   original owner_user_id on every save, staff who open a teammate's
--   project hit the policy and saves fail with:
--
--     "new row violates row-level security policy (USING expression)
--      for table 'projects'"
--
--   Earlier the bug masked this: the save layer silently overwrote
--   owner_user_id with the saving user's id, which made the policy
--   pass at the cost of stealing ownership. Now that we preserve the
--   owner, the restrictive policy blocks legitimate collaboration.
--
--   Product decision: any org member can edit any project in their
--   org. Ownership is purely a DASHBOARD-DISPLAY attribute (drives
--   the "Your projects" vs "Your team's projects" split); it does
--   NOT gate edit rights. This matches the SELECT policy and the
--   way the team actually works - multiple staff dipping in and out
--   of each other's takeoffs.
--
-- What it does
--   - Drops every prior UPDATE policy name we've shipped under, to
--     keep this migration safe to re-run against any historic state.
--   - Recreates "Project update" with one rule: personal projects
--     stay author-only; org-scoped projects open to any current
--     member of the org (admin or staff).
--   - Includes a matching `with check` so an update can't escape org
--     scope (e.g. rewrite organisation_id to a different org the
--     caller doesn't belong to).
--
-- Safety
--   - Doesn't touch personal-project access.
--   - Doesn't loosen DELETE - section 12's "Project delete" stays as
--     owner-or-admin.
--   - is_org_member() already excludes removed users so leaving the
--     org instantly revokes edit rights on the org's projects.
--   - Idempotent (drop-if-exists then create).
-- ============================================================

drop policy if exists "Project update" on public.projects;
drop policy if exists "Editor can update project" on public.projects;
drop policy if exists "Owner or org member update project" on public.projects;
drop policy if exists "Users update own projects" on public.projects;

create policy "Project update"
  on public.projects for update
  using (
    -- Personal projects: author only.
    (organisation_id is null and user_id = auth.uid())
    or
    -- Org-scoped projects: any current member of that org. is_org_member
    -- returns false the moment the user leaves / is removed, so this
    -- naturally locks ex-members out.
    (organisation_id is not null and public.is_org_member(organisation_id))
  )
  with check (
    -- Mirror the USING clause on the post-update row so an UPDATE can't
    -- be used to migrate a row out of its current scope (e.g. change
    -- organisation_id to another org the caller can edit, then keep
    -- editing). Without with-check this would silently succeed.
    (organisation_id is null and user_id = auth.uid())
    or
    (organisation_id is not null and public.is_org_member(organisation_id))
  );
