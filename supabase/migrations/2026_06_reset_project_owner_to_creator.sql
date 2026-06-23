-- ============================================================
-- Reset projects.owner_user_id to the original creator.
--
-- Why
--   Earlier versions of PdfWorkspace dropped owner_user_id from the
--   save payload. projectStorage.projectToCloudRow falls back to
--   `owner_user_id ?? userId`, which meant whoever saved a project
--   last (e.g. a teammate who opened it briefly) had their user id
--   written to owner_user_id - silently migrating the project out
--   of the original owner's "Your team's projects" column and into
--   the saver's "Your projects" column on the dashboard.
--
--   The app-side fix (PdfWorkspace now tracks + persists
--   ownerUserId) prevents new mis-assignments. This migration
--   repairs the historic data that already drifted.
--
-- What it does
--   For every project that carries a `createdByUserId` inside its
--   `data` JSONB blob, set `owner_user_id` back to that value when
--   they currently differ. createdByUserId is the original
--   estimator who first saved the project - preserved by the
--   author-stamp code on every save - and is the right owner now
--   that the estimate-request pickup / ownership-transfer flow has
--   been removed.
--
--   Rows whose `data` blob predates the createdByUserId field (very
--   old / partially-migrated projects) are left alone - their
--   owner_user_id falls back to user_id via the existing row-to-
--   project mapper, which is still a sensible owner.
--
-- Safety
--   - Only writes when the two values differ, so re-running is a
--     no-op once the data is consistent.
--   - Doesn't touch user_id (the original inserter, used by RLS).
--   - Doesn't bump updated_at - the data hasn't logically changed,
--     just the ownership pointer.
--   - Idempotent: safe to run repeatedly.
-- ============================================================

UPDATE projects
SET owner_user_id = (data->>'createdByUserId')::uuid
WHERE data ? 'createdByUserId'
  AND data->>'createdByUserId' IS NOT NULL
  AND data->>'createdByUserId' <> ''
  AND (
    owner_user_id IS NULL
    OR owner_user_id::text <> (data->>'createdByUserId')
  );
