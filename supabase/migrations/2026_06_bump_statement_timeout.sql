-- Bump statement_timeout for authenticated users.
--
-- Default Supabase value is 8s for the `authenticated` role. Project
-- saves on large projects (many areas / walls / wall types) are
-- writing a big JSONB blob in `projects.data` and occasionally
-- exceed 8s during the upsert - surfaces as "canceling statement
-- due to statement timeout" toasts in the app.
--
-- 30s gives plenty of head-room without letting genuinely runaway
-- queries hang the connection forever. App-side retry-on-timeout
-- (projectStorage.ts) handles the remaining transient cases.
--
-- Run this in the Supabase SQL editor (one-off). No app deploy
-- needed for the change to take effect; the next query the role
-- runs will pick up the new timeout.

alter role authenticated set statement_timeout = '30s';

-- Verify with:
--   select rolname, rolconfig from pg_roles where rolname = 'authenticated';
-- Should include "statement_timeout=30s" in rolconfig.
