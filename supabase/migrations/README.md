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
