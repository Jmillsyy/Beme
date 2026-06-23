-- Org-scoped supply items
--
-- Until now supply items lived in each browser's IndexedDB, so adding an
-- item on one computer never appeared on another even within the same
-- organisation. This table moves them to Supabase, mirroring how projects
-- are already org-scoped.
--
-- Run this in the Supabase SQL editor (one-off). The TypeScript module
-- src/lib/orgSupplyItems.ts is the consumer.

create extension if not exists pgcrypto;

create table if not exists public.org_supply_items (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations(id) on delete cascade,

  name text not null,
  description text,
  -- One of: 'each', 'per-block', 'per-brick', 'per-m2', 'per-m-lineal', 'per-opening'
  unit text not null check (unit in (
    'each', 'per-block', 'per-brick', 'per-m2', 'per-m-lineal', 'per-opening'
  )),
  rate numeric not null check (rate >= 0),
  -- Array of 'block' / 'brick'.
  applies_to text[] not null default '{}',
  enabled_by_default boolean not null default true,
  category text,
  opening_width_min_mm integer,
  opening_width_max_mm integer,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id)
);

create index if not exists idx_org_supply_items_org
  on public.org_supply_items(organisation_id);

-- Keep updated_at fresh.
create or replace function public.org_supply_items_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end;
$$;

drop trigger if exists trg_org_supply_items_updated_at on public.org_supply_items;
create trigger trg_org_supply_items_updated_at
  before update on public.org_supply_items
  for each row execute function public.org_supply_items_touch_updated_at();

-- Stamp created_by automatically on insert.
create or replace function public.org_supply_items_stamp_created_by()
returns trigger
language plpgsql
as $$
begin
  new.created_by := coalesce(new.created_by, auth.uid());
  new.updated_by := coalesce(new.updated_by, auth.uid());
  return new;
end;
$$;

drop trigger if exists trg_org_supply_items_created_by on public.org_supply_items;
create trigger trg_org_supply_items_created_by
  before insert on public.org_supply_items
  for each row execute function public.org_supply_items_stamp_created_by();

-- Row-level security: anyone in the organisation can read AND write.
-- (Tighten to admins-only later if needed.)
alter table public.org_supply_items enable row level security;

drop policy if exists "Org members can read supply items" on public.org_supply_items;
create policy "Org members can read supply items"
  on public.org_supply_items
  for select
  using (
    exists (
      select 1
      from public.organisation_members om
      where om.organisation_id = org_supply_items.organisation_id
        and om.user_id = auth.uid()
    )
  );

drop policy if exists "Org members can write supply items" on public.org_supply_items;
create policy "Org members can write supply items"
  on public.org_supply_items
  for all
  using (
    exists (
      select 1
      from public.organisation_members om
      where om.organisation_id = org_supply_items.organisation_id
        and om.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1
      from public.organisation_members om
      where om.organisation_id = org_supply_items.organisation_id
        and om.user_id = auth.uid()
    )
  );
