-- Per-user wall type templates ("Your Library" → Wall types)
--
-- Until now wall type templates lived in each browser's IndexedDB
-- (userSettings.wallTypeTemplates), so a template saved on one computer
-- never appeared on another — even for the same signed-in user. This
-- table moves them to Supabase, scoped to the user (NOT the org —
-- deliberate: templates are personal; org sharing is a possible later
-- step on top of this).
--
-- The WallMakeup payload is stored as JSONB rather than columns: it's a
-- rich nested shape (course pattern, overrides, end terminations, curve
-- params…) that the client owns and evolves; the database only needs to
-- store, list and delete it. `name` is duplicated out of the payload for
-- listing/ordering without parsing JSON.
--
-- Run this in the Supabase SQL editor (one-off). The TypeScript module
-- src/lib/userWallTypeTemplates.ts is the consumer.

create extension if not exists pgcrypto;

create table if not exists public.user_wall_type_templates (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,

  name text not null,
  -- Full WallMakeup object as the client serialises it. The client
  -- re-stamps `id` on insert-to-project, so the id inside the payload is
  -- only a template identity, never a live project reference.
  makeup jsonb not null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_user_wall_type_templates_user
  on public.user_wall_type_templates(user_id);

-- Keep updated_at fresh.
create or replace function public.user_wall_type_templates_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_user_wall_type_templates_updated_at
  on public.user_wall_type_templates;
create trigger trg_user_wall_type_templates_updated_at
  before update on public.user_wall_type_templates
  for each row execute function public.user_wall_type_templates_touch_updated_at();

-- RLS: strictly per-user. No org visibility.
alter table public.user_wall_type_templates enable row level security;

drop policy if exists "user_wall_type_templates_select_own"
  on public.user_wall_type_templates;
create policy "user_wall_type_templates_select_own"
  on public.user_wall_type_templates
  for select using (user_id = auth.uid());

drop policy if exists "user_wall_type_templates_insert_own"
  on public.user_wall_type_templates;
create policy "user_wall_type_templates_insert_own"
  on public.user_wall_type_templates
  for insert with check (user_id = auth.uid());

drop policy if exists "user_wall_type_templates_update_own"
  on public.user_wall_type_templates;
create policy "user_wall_type_templates_update_own"
  on public.user_wall_type_templates
  for update using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists "user_wall_type_templates_delete_own"
  on public.user_wall_type_templates;
create policy "user_wall_type_templates_delete_own"
  on public.user_wall_type_templates
  for delete using (user_id = auth.uid());
