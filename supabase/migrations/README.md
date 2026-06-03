# Supabase migrations

The Beme app stores some data in Supabase (organisations, members, projects,
and from `2026_06_org_supply_items.sql` onward, supply items).

There's no migration runner wired up — these SQL files are a record of
what's been applied to the live `bemeapp.app` database. To apply a new
migration:

1. Open the Supabase dashboard for the project.
2. Go to **SQL Editor** → **New query**.
3. Paste the entire contents of the latest migration file.
4. Click **Run**.

Migrations are written idempotently (every `create table` is `if not
exists`, every policy is dropped before being recreated) so it's safe to
re-run any of them.

## Files

- `2026_06_org_supply_items.sql` — adds `org_supply_items` table with
  per-organisation supply items, RLS policies for org members,
  `updated_at` trigger, and `created_by` / `updated_by` audit columns.
  Required for cross-device supply-item sync.
- `2026_06_seed_galintel_supply_items.sql` — seeds a starter set of
  Galintel supply items for new organisations.
- `2026_06_reset_project_owner_to_creator.sql` — one-shot repair for
  projects whose `owner_user_id` drifted from the original creator
  because of the pre-fix save bug. Reads `data->>'createdByUserId'`
  and writes it back to `owner_user_id` when the two differ.
- `2026_06_open_project_update_to_org_members.sql` — replaces the
  restrictive UPDATE policy (owner / admin / collaborator only) with
  an open one: any active member of the project's org can save. Now
  that ownership is sticky for display, edit rights need to stay open
  so staff can keep helping on each other's takeoffs without an
  explicit share step. DELETE remains owner-or-admin.
