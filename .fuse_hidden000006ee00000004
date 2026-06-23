# Beme — auth + cloud sync setup

One-time setup for **Supabase + Microsoft Entra (Outlook) sign-in**. Should
take roughly 15 minutes end-to-end. You'll bounce between three browser tabs:
your Supabase dashboard, the Microsoft Entra admin centre, and this repo on
your computer.

Anything in `<angle-brackets>` is a placeholder — you'll paste in real values
as you go.

---

## 1. Create the Supabase project

1. Sign in at https://app.supabase.com (use your Outlook account — fine).
2. **New project** → give it a name (e.g. `beme`), generate a strong DB password
   (save it in your password manager), pick a region close to you
   (Australia / Sydney is ideal for AU users), free tier is fine. Click
   **Create**.
3. Wait ~1 minute for provisioning.

When it's done, in **Project Settings → API** copy these two values somewhere
safe — you'll paste them into `.env.local` at step 4:

- **Project URL** → `VITE_SUPABASE_URL`
- **Project API key (anon, public)** → `VITE_SUPABASE_ANON_KEY`

The `anon` key is safe to ship in the browser. Row Level Security on the
database is what actually protects your data.

---

## 2. Run the database schema

In Supabase, **SQL Editor → New query**, paste the block below verbatim, and
click **Run**. It creates the `projects` table, the `project-pdfs` storage
bucket, and locks both with Row Level Security so each user only sees their
own rows.

```sql
-- ─── projects table ─────────────────────────────────────────────────────────
create table public.projects (
  id            uuid primary key,
  user_id       uuid not null references auth.users(id) on delete cascade,
  type          text not null check (type in ('block', 'brick')),
  status        text not null check (status in ('in-progress', 'completed')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  completed_at  timestamptz,
  data          jsonb not null,
  pdf_path      text,
  pdf_file_name text
);

create index projects_user_updated_idx
  on public.projects (user_id, updated_at desc);

alter table public.projects enable row level security;

create policy "Users select own projects"
  on public.projects for select
  using (auth.uid() = user_id);

create policy "Users insert own projects"
  on public.projects for insert
  with check (auth.uid() = user_id);

create policy "Users update own projects"
  on public.projects for update
  using (auth.uid() = user_id);

create policy "Users delete own projects"
  on public.projects for delete
  using (auth.uid() = user_id);

-- ─── project-pdfs storage bucket ────────────────────────────────────────────
insert into storage.buckets (id, name, public)
values ('project-pdfs', 'project-pdfs', false)
on conflict (id) do nothing;

-- Storage RLS — path layout is <user_id>/<project_id>.pdf
create policy "Users read own PDFs"
  on storage.objects for select
  using (
    bucket_id = 'project-pdfs'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "Users upload own PDFs"
  on storage.objects for insert
  with check (
    bucket_id = 'project-pdfs'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "Users update own PDFs"
  on storage.objects for update
  using (
    bucket_id = 'project-pdfs'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "Users delete own PDFs"
  on storage.objects for delete
  using (
    bucket_id = 'project-pdfs'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- Org-scoped projects: any org member can READ the project's PDFs (primary +
-- references). The path layout is still `<owner_user_id>/<project_id>.pdf`,
-- so this policy looks the row up via projects.pdf_path / referencePdfs to
-- find the project's organisation_id and check membership. Keeps the
-- existing user-scoped INSERT/UPDATE/DELETE in place — only the owner
-- uploads or replaces, teammates only read.
--
-- DROP-then-CREATE pattern so re-running this block on an already-migrated
-- deployment doesn't error with "policy already exists". Same applies to
-- any of the create-policy blocks below — guard them this way if you ever
-- need to re-run.
drop policy if exists "Org members read project PDFs" on storage.objects;
create policy "Org members read project PDFs"
  on storage.objects for select
  using (
    bucket_id = 'project-pdfs'
    and exists (
      select 1 from public.projects p
      where p.organisation_id is not null
        and public.is_org_member(p.organisation_id)
        and (
          p.pdf_path = name
          or exists (
            select 1
            from jsonb_array_elements(
              coalesce(p.data->'referencePdfs', '[]'::jsonb)
            ) ref
            where ref->>'path' = name
          )
        )
    )
  );
```

You should see "Success. No rows returned." If a policy already exists from a
re-run, comment that one line and re-run.

---

## 3. Register the Microsoft Entra (Azure AD) app

This is the bit that lets users sign in with their work Outlook account.

1. Go to https://entra.microsoft.com — sign in with a Microsoft work account
   that has **Application Administrator** role on your tenant.
2. **App registrations → New registration**.
3. Fill in:
   - **Name:** `Beme`
   - **Supported account types:** _Accounts in this organizational directory
     only (single tenant)_ — locks sign-in to your company's users.
   - **Redirect URI:** select **Web** and paste:
     `https://<YOUR-PROJECT-REF>.supabase.co/auth/v1/callback`
     (replace `<YOUR-PROJECT-REF>` with the bit between `https://` and
     `.supabase.co` from your project URL.)
   - Click **Register**.
4. On the app's **Overview** page, copy:
   - **Application (client) ID** → keep for step 4
   - **Directory (tenant) ID** → keep for step 4
5. **Certificates & secrets → Client secrets → New client secret**.
   - Description: `Supabase Beme`
   - Expires: 24 months (set a calendar reminder to rotate)
   - **Copy the secret VALUE immediately** — you can't see it again after
     leaving the page.

---

## 4. Wire Microsoft into Supabase

Back in your Supabase dashboard:

1. **Authentication → Providers → Azure** → toggle **Enable**.
2. Paste in:
   - **Azure Client ID** → from step 3.4 (Application ID)
   - **Azure Client Secret** → from step 3.5 (the value you just copied)
   - **Azure Tenant URL** →
     `https://login.microsoftonline.com/<YOUR-TENANT-ID>/v2.0`
     (replace `<YOUR-TENANT-ID>` with the Directory ID from step 3.4)
3. **Save**.

Also under **Authentication → URL Configuration**:

- **Site URL:** `http://localhost:5173` for dev, plus your production URL
  later.
- **Redirect URLs:** add `http://localhost:5173/**` (the `/**` is important).

---

## 5. Add the env vars locally

In the repo root, copy the template and fill it in:

```bash
cp .env.example .env.local
```

Then edit `.env.local`:

```
VITE_SUPABASE_URL=https://<YOUR-PROJECT-REF>.supabase.co
VITE_SUPABASE_ANON_KEY=<YOUR-ANON-KEY>
```

`.env.local` is in `.gitignore`, so it won't get committed.

---

## 6. Restart the dev server and sign in

```bash
npm run dev
```

Open http://localhost:5173 — you should see the **Sign in with Microsoft**
screen. Click it, sign in with your work Outlook, and you'll land on the
dashboard signed in.

If you already had local projects in the browser, you'll see a banner at the
top of the dashboard offering to sync them to your account.

---

## Troubleshooting

**"AADSTS50011: The redirect URI specified in the request does not match"**
The redirect URI registered in step 3.3 has to match what Supabase sends.
Re-check that it reads `https://<PROJECT-REF>.supabase.co/auth/v1/callback`
exactly — no trailing slash, correct project ref.

**"Provider not enabled"**
Check step 4: Azure provider must be **Enabled** (toggle on, green), and you
saved after pasting the credentials.

**Sign-in works but I land back on the sign-in page**
Check step 4 → **URL Configuration**: `http://localhost:5173/**` (with `/**`)
must be in **Redirect URLs**, otherwise Supabase strips the session token on
the bounce-back.

**"VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY not set" warning in console**
You're running in offline-only mode. Set `.env.local` and restart the dev
server (Vite doesn't pick up env changes hot).

---

## Production deployment

When you deploy to a real domain:

1. Add the production URL to **Site URL** and **Redirect URLs** in Supabase
   (step 4) — leave the localhost one in for dev.
2. Add the production callback to the Microsoft Entra app's **Redirect URIs**
   (step 3.3).
3. Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` in your hosting
   provider's env vars (Vercel, Netlify, Cloudflare Pages, etc.).

---

## 7. (Organisations) Org accounts, members, estimate requests

Run this once on top of the original schema to add organisational accounts —
the multi-user shape needed for sales reps assigning estimates to estimators.
Single-user / personal projects keep working exactly as before; the org layer
is additive.

In **SQL Editor → New query**, paste and run:

```sql
-- ─── organisations ──────────────────────────────────────────────────────────
create table public.organisations (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  slug        text not null unique,
  logo_url    text,
  created_at  timestamptz not null default now()
);

create table public.organisation_members (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations(id) on delete cascade,
  user_id         uuid not null references auth.users(id) on delete cascade,
  role            text not null check (role in ('admin', 'sales', 'estimator')),
  created_at      timestamptz not null default now(),
  unique (organisation_id, user_id)
);

create index org_members_user_idx on public.organisation_members(user_id);
create index org_members_org_idx on public.organisation_members(organisation_id);

-- Helpers used by RLS policies. `security definer` so they bypass RLS on the
-- members table itself (otherwise the membership check would recurse).
create or replace function public.is_org_member(target_org_id uuid)
returns boolean
language sql security definer set search_path = public
as $$
  select exists (
    select 1 from public.organisation_members
    where organisation_id = target_org_id
      and user_id = auth.uid()
  );
$$;

create or replace function public.is_org_admin(target_org_id uuid)
returns boolean
language sql security definer set search_path = public
as $$
  select exists (
    select 1 from public.organisation_members
    where organisation_id = target_org_id
      and user_id = auth.uid()
      and role = 'admin'
  );
$$;

alter table public.organisations enable row level security;
alter table public.organisation_members enable row level security;

create policy "Members select own org"
  on public.organisations for select
  using (public.is_org_member(id));

create policy "Admins update own org"
  on public.organisations for update
  using (public.is_org_admin(id));

create policy "Members see members"
  on public.organisation_members for select
  using (public.is_org_member(organisation_id));

create policy "Admins insert members"
  on public.organisation_members for insert
  with check (public.is_org_admin(organisation_id));

create policy "Admins update members"
  on public.organisation_members for update
  using (public.is_org_admin(organisation_id));

create policy "Admins delete members"
  on public.organisation_members for delete
  using (public.is_org_admin(organisation_id));

-- ─── projects: optional org ownership ──────────────────────────────────────
alter table public.projects
  add column if not exists organisation_id uuid
    references public.organisations(id) on delete set null;

create index if not exists projects_org_updated_idx
  on public.projects (organisation_id, updated_at desc)
  where organisation_id is not null;

-- Replace the user-only policies with policies that also let org members in.
drop policy if exists "Users select own projects" on public.projects;
drop policy if exists "Users update own projects" on public.projects;
drop policy if exists "Users delete own projects" on public.projects;

create policy "Owner or org member select project"
  on public.projects for select
  using (
    user_id = auth.uid()
    or (organisation_id is not null and public.is_org_member(organisation_id))
  );

create policy "Owner or org member update project"
  on public.projects for update
  using (
    user_id = auth.uid()
    or (organisation_id is not null and public.is_org_member(organisation_id))
  );

create policy "Owner or org admin delete project"
  on public.projects for delete
  using (
    user_id = auth.uid()
    or (organisation_id is not null and public.is_org_admin(organisation_id))
  );

-- ─── estimate_requests ──────────────────────────────────────────────────────
create table public.estimate_requests (
  id                     uuid primary key default gen_random_uuid(),
  organisation_id        uuid not null references public.organisations(id) on delete cascade,
  created_by_user_id     uuid not null references auth.users(id) on delete restrict,
  assigned_to_user_id    uuid references auth.users(id) on delete set null,
  project_id             uuid references public.projects(id) on delete set null,
  type                   text not null check (type in ('block', 'brick')),
  status                 text not null default 'pending'
                         check (status in ('pending', 'in_progress', 'completed', 'cancelled')),
  customer_name          text not null,
  customer_email         text,
  customer_phone         text,
  customer_company       text,
  inclusion_notes        text,
  plan_pdf_path          text,
  plan_pdf_file_name     text,
  -- Additional reference PDFs attached to the request (engineering specs etc.).
  -- Each entry: { path: string, fileName: string }. Walls only get drawn on
  -- the PRIMARY plan (plan_pdf_path); these are view-only attachments the
  -- estimator can flip to in the workspace.
  additional_pdfs        jsonb,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  completed_at           timestamptz
);

create index estimate_requests_org_status_idx
  on public.estimate_requests (organisation_id, status, updated_at desc);
create index estimate_requests_assignee_idx
  on public.estimate_requests (assigned_to_user_id, status)
  where assigned_to_user_id is not null;

alter table public.estimate_requests enable row level security;

create policy "Org members read requests"
  on public.estimate_requests for select
  using (public.is_org_member(organisation_id));

create policy "Org members insert requests"
  on public.estimate_requests for insert
  with check (
    public.is_org_member(organisation_id)
    and created_by_user_id = auth.uid()
  );

create policy "Org members update requests"
  on public.estimate_requests for update
  using (public.is_org_member(organisation_id));

create policy "Admins delete requests"
  on public.estimate_requests for delete
  using (public.is_org_admin(organisation_id));

-- ─── estimate-request-plans storage ─────────────────────────────────────────
insert into storage.buckets (id, name, public)
values ('estimate-request-plans', 'estimate-request-plans', false)
on conflict (id) do nothing;

-- Path layout: <organisation_id>/<request_id>.pdf
create policy "Org members read request plans"
  on storage.objects for select
  using (
    bucket_id = 'estimate-request-plans'
    and public.is_org_member(((storage.foldername(name))[1])::uuid)
  );

create policy "Org members upload request plans"
  on storage.objects for insert
  with check (
    bucket_id = 'estimate-request-plans'
    and public.is_org_member(((storage.foldername(name))[1])::uuid)
  );

create policy "Org members update request plans"
  on storage.objects for update
  using (
    bucket_id = 'estimate-request-plans'
    and public.is_org_member(((storage.foldername(name))[1])::uuid)
  );

create policy "Admins delete request plans"
  on storage.objects for delete
  using (
    bucket_id = 'estimate-request-plans'
    and public.is_org_admin(((storage.foldername(name))[1])::uuid)
  );

-- ─── multi-file uploads on estimate requests (existing deployments) ────────
-- Run this once on any deployment that was set up before the multi-PDF
-- feature landed. Fresh installs already get the column from the create
-- table above. The storage RLS policies don't need to change — reference
-- PDFs upload under the same <organisation_id>/... path scope as the
-- primary plan and inherit the existing org-member access rules.
alter table public.estimate_requests
  add column if not exists additional_pdfs jsonb;

-- ─── invitations ────────────────────────────────────────────────────────────
-- One row per "I sent X@company.com an invite link". The row id IS the
-- token — knowing the UUID is enough to claim the invite, so handle the
-- link the way you'd handle a password reset link (send via private
-- channel, don't post it publicly). Expires after 7 days by default.
create table if not exists public.invitations (
  id                     uuid primary key default gen_random_uuid(),
  organisation_id        uuid not null references public.organisations(id) on delete cascade,
  email                  text not null,
  role                   text not null default 'estimator'
                         check (role in ('admin', 'estimator', 'sales')),
  invited_by_user_id     uuid not null references auth.users(id) on delete restrict,
  expires_at             timestamptz not null default (now() + interval '7 days'),
  used_at                timestamptz,
  used_by_user_id        uuid references auth.users(id) on delete set null,
  created_at             timestamptz not null default now()
);

create index if not exists invitations_org_pending_idx
  on public.invitations (organisation_id, created_at desc)
  where used_at is null;

alter table public.invitations enable row level security;

-- Admins of the inviting org can create + list + revoke invites for THEIR
-- org. The recipient of an invite reads it via the SECURITY DEFINER RPC
-- below, NOT via direct SELECT — that's how we keep the token private to
-- whoever actually has the link, without making every unused row world-
-- readable.
create policy "Admins manage invitations"
  on public.invitations for all
  using (public.is_org_admin(organisation_id))
  with check (
    public.is_org_admin(organisation_id)
    and invited_by_user_id = auth.uid()
  );

-- ─── accept_invitation RPC ─────────────────────────────────────────────────
-- Called by the freshly-signed-up user from the /accept-invite page.
-- Validates the token (exists / not used / not expired / email matches),
-- inserts the user into organisation_members, and marks the invite used.
-- SECURITY DEFINER so the caller doesn't need INSERT privilege on
-- organisation_members directly — the function gates the insert behind
-- the token check.
create or replace function public.accept_invitation(invite_id uuid)
returns table (organisation_id uuid, role text)
language plpgsql
security definer
set search_path = public, auth
as $$
-- Tell plpgsql to prefer column names over OUT parameter / variable names
-- when there's a collision. The function's RETURNS TABLE declares OUT
-- params named `organisation_id` and `role`, which clash with the column
-- names of organisation_members used inside the INSERT + ON CONFLICT
-- below. Without this directive, Postgres throws
--   ERROR: column reference "organisation_id" is ambiguous
-- when the function is called.
#variable_conflict use_column
declare
  inv record;
  caller_id uuid := auth.uid();
  caller_email text;
begin
  if caller_id is null then
    raise exception 'Must be signed in to accept an invitation';
  end if;

  select au.email into caller_email
  from auth.users au where au.id = caller_id;

  select i.* into inv
  from public.invitations i
  where i.id = invite_id
    and i.used_at is null
    and i.expires_at > now();

  if not found then
    raise exception 'Invitation not found, already used, or expired';
  end if;

  -- Email match is case-insensitive (auth.users.email is stored lower-case
  -- by Supabase). Belt-and-braces both sides.
  if lower(inv.email) <> lower(caller_email) then
    raise exception 'This invitation was sent to a different email address';
  end if;

  -- Insert membership. ON CONFLICT in case the user was already added
  -- (manually, or via a previous successful accept) — idempotent.
  insert into public.organisation_members (organisation_id, user_id, role)
  values (inv.organisation_id, caller_id, inv.role)
  on conflict (organisation_id, user_id) do update set role = excluded.role;

  -- Mark the invite consumed.
  update public.invitations
    set used_at = now(), used_by_user_id = caller_id
    where id = invite_id;

  return query select inv.organisation_id, inv.role;
end;
$$;

-- Anyone authenticated can call the RPC — the function itself enforces
-- the token + email match.
grant execute on function public.accept_invitation(uuid) to authenticated;

-- ─── public lookup of an invite by id ───────────────────────────────────────
-- The /accept-invite page needs to show "you've been invited by X to Y"
-- BEFORE the user has signed in (so they know what they're accepting).
-- This SECURITY DEFINER function returns just the safe fields — never
-- the full row — so a stolen token reveals org name + inviter name but
-- not other invites or internal columns. Returns null if the token is
-- expired, used, or doesn't exist (caller can't distinguish).
create or replace function public.peek_invitation(invite_id uuid)
returns table (
  email text,
  organisation_id uuid,
  organisation_name text,
  role text,
  invited_by_display_name text,
  expires_at timestamptz
)
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  return query
  select
    i.email,
    i.organisation_id,
    o.name,
    i.role,
    coalesce(
      (au.raw_user_meta_data ->> 'full_name'),
      (au.raw_user_meta_data ->> 'name'),
      au.email
    ),
    i.expires_at
  from public.invitations i
    join public.organisations o on o.id = i.organisation_id
    left join auth.users au on au.id = i.invited_by_user_id
  where i.id = invite_id
    and i.used_at is null
    and i.expires_at > now();
end;
$$;

grant execute on function public.peek_invitation(uuid) to anon, authenticated;

-- ─── member management ──────────────────────────────────────────────────────
-- Org admins need to see who's in their org with full names + emails (the
-- Settings page can only show emails for the signed-in user via the
-- anonymous Supabase client — auth.users is locked down). These three
-- SECURITY DEFINER RPCs cover the read + the two destructive operations
-- with a built-in last-admin guard so an org can never end up with no
-- admin.

-- 1) Read: returns members of an org WITH email + display_name. Gated to
--    org members so a random signed-in user can't enumerate other orgs.
create or replace function public.list_org_members_with_identity(org_id uuid)
returns table (
  id uuid,
  organisation_id uuid,
  user_id uuid,
  role text,
  email text,
  display_name text,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  if not public.is_org_member(org_id) then
    raise exception 'Not a member of this organisation';
  end if;
  return query
  select
    m.id,
    m.organisation_id,
    m.user_id,
    m.role,
    au.email::text,
    coalesce(
      (au.raw_user_meta_data ->> 'full_name'),
      (au.raw_user_meta_data ->> 'name')
    )::text as display_name,
    m.created_at
  from public.organisation_members m
    left join auth.users au on au.id = m.user_id
  where m.organisation_id = org_id
  order by m.created_at asc;
end;
$$;

grant execute on function public.list_org_members_with_identity(uuid) to authenticated;

-- 2) Remove a member. Admins only. Blocks removing the last admin — every
--    org must have at least one. A member can remove themselves (leave
--    the org) as long as they're not the last admin.
create or replace function public.remove_org_member(member_id uuid)
returns void
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  target record;
  caller_id uuid := auth.uid();
  admin_count integer;
begin
  if caller_id is null then
    raise exception 'Must be signed in';
  end if;

  select * into target
  from public.organisation_members
  where id = member_id;

  if not found then
    raise exception 'Member not found';
  end if;

  -- Caller must be an admin of the target's org OR be removing themselves.
  if not public.is_org_admin(target.organisation_id)
     and target.user_id <> caller_id then
    raise exception 'Only admins can remove other members';
  end if;

  -- Last-admin guard. Count current admins; if removing this one would
  -- drop the count to zero, reject. Applies whether the caller is the
  -- admin themselves or someone else removing them.
  if target.role = 'admin' then
    select count(*) into admin_count
    from public.organisation_members
    where organisation_id = target.organisation_id and role = 'admin';
    if admin_count <= 1 then
      raise exception 'Cannot remove the last admin — promote someone else first';
    end if;
  end if;

  delete from public.organisation_members where id = member_id;
end;
$$;

grant execute on function public.remove_org_member(uuid) to authenticated;

-- 3) Change a member's role. Admins only. Last-admin guard applies when
--    demoting the current sole admin.
create or replace function public.update_org_member_role(
  member_id uuid,
  new_role text
) returns void
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  target record;
  admin_count integer;
begin
  if new_role not in ('admin', 'estimator', 'sales') then
    raise exception 'Invalid role: %', new_role;
  end if;

  select * into target
  from public.organisation_members
  where id = member_id;

  if not found then
    raise exception 'Member not found';
  end if;

  if not public.is_org_admin(target.organisation_id) then
    raise exception 'Only admins can change roles';
  end if;

  -- Demoting from admin → check that another admin exists.
  if target.role = 'admin' and new_role <> 'admin' then
    select count(*) into admin_count
    from public.organisation_members
    where organisation_id = target.organisation_id and role = 'admin';
    if admin_count <= 1 then
      raise exception 'Cannot demote the last admin — promote someone else first';
    end if;
  end if;

  update public.organisation_members
  set role = new_role
  where id = member_id;
end;
$$;

grant execute on function public.update_org_member_role(uuid, text) to authenticated;
```

---

## 8. Seed your first organisation

Self-serve org signup isn't built yet — we provision orgs by hand in the
Supabase dashboard until the company is ready for it. To get ABC (or
whatever your first org is) up:

1. **Authentication → Users** — find your own user id (the UUID in the
   `ID` column) and copy it. Same for any teammates you want to add.
2. **SQL Editor → New query** — run:

   ```sql
   -- 1) Create the org
   insert into public.organisations (name, slug)
     values ('ABC Building Products', 'abc')
     returning id;
   -- copy the returned id

   -- 2) Add yourself as admin (replace both UUIDs)
   insert into public.organisation_members (organisation_id, user_id, role)
     values ('<ORG-ID>', '<YOUR-USER-ID>', 'admin');

   -- 3) Add any teammates with their role
   insert into public.organisation_members (organisation_id, user_id, role)
     values ('<ORG-ID>', '<TEAMMATE-USER-ID>', 'sales');
   ```

3. Refresh Beme — your org name shows in the header next to the user menu,
   and the Settings → Organisation tab lists every member.

---

## 9. (Org-shared library) block + brick library tables

Custom block + brick library entries used to live in browser IndexedDB only,
which meant teammates in the same org never saw each other's additions. This
migration moves the libraries into Supabase so any block or brick added by
one org member shows up in the wall-type editor for every teammate.

Personal (no-org) accounts are unaffected — they continue to keep their
library in IndexedDB.

Run once per Supabase project:

```sql
-- ─── block_library_items ────────────────────────────────────────────────────
create table if not exists public.block_library_items (
  organisation_id  uuid not null references public.organisations(id) on delete cascade,
  code             text not null,
  data             jsonb not null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  primary key (organisation_id, code)
);

create index if not exists block_library_items_org_idx
  on public.block_library_items(organisation_id);

alter table public.block_library_items enable row level security;

-- Any member of the org can read.
create policy "Org members read block library"
  on public.block_library_items for select
  using (public.is_org_member(organisation_id));

-- Only admins can write. Mirrors the UI gating in the Material Library page,
-- which already hides edit affordances from non-admins.
create policy "Org admins insert block library"
  on public.block_library_items for insert
  with check (public.is_org_admin(organisation_id));

create policy "Org admins update block library"
  on public.block_library_items for update
  using (public.is_org_admin(organisation_id));

create policy "Org admins delete block library"
  on public.block_library_items for delete
  using (public.is_org_admin(organisation_id));

-- ─── brick_library_items ────────────────────────────────────────────────────
create table if not exists public.brick_library_items (
  organisation_id  uuid not null references public.organisations(id) on delete cascade,
  code             text not null,
  data             jsonb not null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  primary key (organisation_id, code)
);

create index if not exists brick_library_items_org_idx
  on public.brick_library_items(organisation_id);

alter table public.brick_library_items enable row level security;

create policy "Org members read brick library"
  on public.brick_library_items for select
  using (public.is_org_member(organisation_id));

create policy "Org admins insert brick library"
  on public.brick_library_items for insert
  with check (public.is_org_admin(organisation_id));

create policy "Org admins update brick library"
  on public.brick_library_items for update
  using (public.is_org_admin(organisation_id));

create policy "Org admins delete brick library"
  on public.brick_library_items for delete
  using (public.is_org_admin(organisation_id));
```

**Bootstrap behaviour.** The first time an org admin opens Beme after this
migration runs, the client checks the cloud table — if it's empty AND the
admin's local library has customisations, the local library is uploaded as
the org's starting set. After that, the cloud is the source of truth: every
edit replicates to all members on their next sign-in / refresh.

---

## 10. (Reference numbers) 6-digit IDs stamped on every project

Each project gets a human-readable 6-digit number that appears in the
workspace project bar, on every exported PDF, and works as the lookup key
for "find a project by its number." Allocated automatically by Postgres on
the first INSERT via a sequence + BEFORE INSERT trigger, then read back
through the upsert response so the workspace shows the real number from
the moment of save (no reload required).

Run once per Supabase project:

```sql
-- Sequence starts at 100000 so reference numbers are 6-digit out of the
-- gate (no awkward "1, 10, 100, 1000" mixed widths in the early days).
create sequence if not exists public.project_reference_seq
  start with 100000
  increment by 1
  no maxvalue
  cache 1;

-- Authenticated users need USAGE so the trigger's nextval() call succeeds
-- when an app-side insert runs as the signed-in user.
grant usage on sequence public.project_reference_seq to authenticated;

alter table public.projects
  add column if not exists reference_number bigint;

create unique index if not exists projects_reference_number_idx
  on public.projects(reference_number)
  where reference_number is not null;

-- Backfill any existing rows so old projects also get a number on next
-- view. (Re-running this is a no-op once every row has one.)
update public.projects
  set reference_number = nextval('public.project_reference_seq')
  where reference_number is null;

-- Trigger fills the column on INSERT when the client hasn't provided
-- one — which is always, in normal app flow. Updates don't touch the
-- column so the number is stable for the life of the project.
create or replace function public.assign_project_reference_number()
returns trigger
language plpgsql
as $$
begin
  if new.reference_number is null then
    new.reference_number := nextval('public.project_reference_seq');
  end if;
  return new;
end;
$$;

drop trigger if exists assign_project_reference_number on public.projects;
create trigger assign_project_reference_number
  before insert on public.projects
  for each row
  execute function public.assign_project_reference_number();
```

**Looking up a project by number from SQL:**

```sql
select id, type, organisation_id, owner_user_id, status, updated_at
from public.projects
where reference_number = 100123;
```

The dashboard rail has a Find-by-reference card that does the same lookup
without leaving the app — useful when a customer quotes a number over the
phone and you want to jump straight into the workspace.

---

## 11. (Per-project access control) ownership + sharing + role rename

Org-shared projects used to be fully editable by every member — anyone in
the org could open and modify anyone else's estimate. This migration locks
that down:

- Every project gets a single **owner**. Only the owner, an admin, or
  explicitly-invited collaborators can edit; everyone else sees the project
  read-only.
- A new **`project_collaborators`** table records explicit access grants
  (owner / admin invites a teammate to a specific project).
- The two non-admin roles (`sales`, `estimator`) collapse into a single
  **`staff`** role. They were functionally equivalent in the product and
  having both invited confusion.

Run once per Supabase project:

```sql
-- ─── projects: add owner column + backfill ─────────────────────────────────
alter table public.projects
  add column if not exists owner_user_id uuid
    references auth.users(id) on delete set null;

-- Backfill existing rows. Prefer the createdByUserId in the data JSONB
-- (that's the field the workspace already stamps when a request is picked
-- up); fall back to the row's user_id (the original inserter).
update public.projects
  set owner_user_id = coalesce((data->>'createdByUserId')::uuid, user_id)
  where owner_user_id is null;

-- Helps the dashboard / share queries that filter "projects where I'm
-- the owner".
create index if not exists projects_owner_idx
  on public.projects(owner_user_id);

-- ─── project_collaborators ─────────────────────────────────────────────────
create table if not exists public.project_collaborators (
  project_id  uuid not null references public.projects(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  granted_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  primary key (project_id, user_id)
);

create index if not exists project_collaborators_user_idx
  on public.project_collaborators(user_id);

alter table public.project_collaborators enable row level security;

-- Helper — is the caller the owner of the referenced project? security
-- definer so the RLS check below can read the row without recursing into
-- the projects RLS policy (which would fail when called from inside
-- another policy on the same row).
create or replace function public.is_project_owner(target_project_id uuid)
returns boolean
language sql security definer set search_path = public
as $$
  select exists (
    select 1 from public.projects
    where id = target_project_id
      and owner_user_id = auth.uid()
  );
$$;

-- Helper — does the caller hold an admin role in this project's org?
create or replace function public.is_project_org_admin(target_project_id uuid)
returns boolean
language sql security definer set search_path = public
as $$
  select exists (
    select 1
    from public.projects p
    join public.organisation_members m
      on m.organisation_id = p.organisation_id
    where p.id = target_project_id
      and m.user_id = auth.uid()
      and m.role = 'admin'
  );
$$;

-- Helper — is the caller a collaborator on this project?
create or replace function public.is_project_collaborator(target_project_id uuid)
returns boolean
language sql security definer set search_path = public
as $$
  select exists (
    select 1 from public.project_collaborators
    where project_id = target_project_id
      and user_id = auth.uid()
  );
$$;

-- Read: any org member of the project's org. (Visibility stays open so
-- everyone can SEE everyone else's work — locking is at write time.)
create policy "Org members read collaborators"
  on public.project_collaborators for select
  using (
    exists (
      select 1
      from public.projects p
      where p.id = project_id
        and (
          p.user_id = auth.uid()
          or (p.organisation_id is not null and public.is_org_member(p.organisation_id))
        )
    )
  );

-- Insert / delete: project owner OR admin of the project's org.
create policy "Owner or org admin grant collaborator"
  on public.project_collaborators for insert
  with check (
    public.is_project_owner(project_id)
    or public.is_project_org_admin(project_id)
  );

create policy "Owner or org admin revoke collaborator"
  on public.project_collaborators for delete
  using (
    public.is_project_owner(project_id)
    or public.is_project_org_admin(project_id)
  );

-- ─── projects: tighten UPDATE policy ────────────────────────────────────────
-- The previous policy let any org member update any org-scoped project.
-- Replace it with: personal owner OR project owner OR project collaborator
-- OR org admin.
drop policy if exists "Owner or org member update project" on public.projects;

create policy "Editor can update project"
  on public.projects for update
  using (
    user_id = auth.uid()
    or owner_user_id = auth.uid()
    or (
      organisation_id is not null
      and public.is_org_admin(organisation_id)
    )
    or exists (
      select 1 from public.project_collaborators c
      where c.project_id = projects.id
        and c.user_id = auth.uid()
    )
  );

-- ─── organisation_members: collapse roles to admin / staff ─────────────────
update public.organisation_members
  set role = 'staff'
  where role in ('sales', 'estimator');

alter table public.organisation_members
  drop constraint if exists organisation_members_role_check;

alter table public.organisation_members
  add constraint organisation_members_role_check
  check (role in ('admin', 'staff'));

-- ─── invitations: also tighten the role check (legacy values come back as staff) ──
update public.invitations
  set role = 'staff'
  where role in ('sales', 'estimator');

alter table public.invitations
  drop constraint if exists invitations_role_check;

alter table public.invitations
  add constraint invitations_role_check
  check (role in ('admin', 'staff'));
```

**Side effect on existing data.** Every project that was created before
this migration ran ends up owned by whoever first saved it (their user_id).
Estimate-request projects ended up owned by the picker because the app
already stamps `createdByUserId` on pickup. After running this once, the
client app starts enforcing the read-only rule on its next deploy.

## 12. Remove the user_id self-bypass on org-stamped projects

The earlier policies allowed a user to SELECT / UPDATE any row where
`user_id = auth.uid()`, regardless of the row's `organisation_id`. That
ran fine while a user stayed in their org, but if the org admin removed
the user (or they left), the row's `user_id` still matched and the user
could still see + edit their old org projects from their now-personal
account. Tighten by gating org-scoped projects behind ACTIVE membership;
keep the user_id self-match for personal projects only.

Run this once in the Supabase SQL editor. **Safe to run regardless of
whether section 11 has been applied** — the block below creates
`owner_user_id` and `project_collaborators` (with RLS) if they don't
already exist, so the tightened policies always have the prerequisites
they reference.

```sql
-- ─── Prereqs from section 11, idempotent ────────────────────────────────────
-- If you've already run section 11 these are all no-ops. If you haven't,
-- we create the owner column + the collaborators table here so the
-- policies below have something to reference.

alter table public.projects
  add column if not exists owner_user_id uuid
    references auth.users(id) on delete set null;

-- Backfill any rows that don't have an owner yet (prefer createdByUserId
-- stamped on the data JSONB; fall back to the original inserter).
update public.projects
  set owner_user_id = coalesce((data->>'createdByUserId')::uuid, user_id)
  where owner_user_id is null;

create index if not exists projects_owner_idx
  on public.projects(owner_user_id);

create table if not exists public.project_collaborators (
  project_id  uuid not null references public.projects(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  granted_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  primary key (project_id, user_id)
);

create index if not exists project_collaborators_user_idx
  on public.project_collaborators(user_id);

alter table public.project_collaborators enable row level security;

-- ─── projects: tighten SELECT ───────────────────────────────────────────────
drop policy if exists "Owner or org member select project" on public.projects;
drop policy if exists "Users select own projects" on public.projects;
drop policy if exists "Project select" on public.projects;

create policy "Project select"
  on public.projects for select
  using (
    -- Personal projects: the original author is the only viewer.
    (organisation_id is null and user_id = auth.uid())
    or
    -- Org-scoped projects: caller must currently be a member of THAT org.
    (organisation_id is not null and public.is_org_member(organisation_id))
  );

-- ─── projects: tighten UPDATE ───────────────────────────────────────────────
drop policy if exists "Editor can update project" on public.projects;
drop policy if exists "Owner or org member update project" on public.projects;
drop policy if exists "Users update own projects" on public.projects;
drop policy if exists "Project update" on public.projects;

create policy "Project update"
  on public.projects for update
  using (
    -- Personal: author only.
    (organisation_id is null and user_id = auth.uid())
    or
    -- Org: current member with edit rights (admin, project owner,
    -- or collaborator). Member check is intentionally OUTSIDE the
    -- inner OR so a removed user can't sneak through via owner_user_id.
    (
      organisation_id is not null
      and public.is_org_member(organisation_id)
      and (
        public.is_org_admin(organisation_id)
        or owner_user_id = auth.uid()
        or exists (
          select 1
          from public.project_collaborators c
          where c.project_id = projects.id
            and c.user_id = auth.uid()
        )
      )
    )
  );

-- ─── projects: tighten DELETE the same way ─────────────────────────────────
drop policy if exists "Owner or org admin delete project" on public.projects;
drop policy if exists "Owner or org member delete project" on public.projects;
drop policy if exists "Users delete own projects" on public.projects;
drop policy if exists "Project delete" on public.projects;

create policy "Project delete"
  on public.projects for delete
  using (
    (organisation_id is null and user_id = auth.uid())
    or
    (
      organisation_id is not null
      and public.is_org_member(organisation_id)
      and (
        public.is_org_admin(organisation_id)
        or owner_user_id = auth.uid()
      )
    )
  );
```

**What the migration fixes.** A user who was once in an organisation
but has since been removed can no longer SELECT, UPDATE or DELETE the
org's projects from their personal account — RLS rejects the row
because they're not in `organisation_members` for that org any more.
The personal projects they own (organisation_id IS NULL) still pass
through `user_id = auth.uid()` so their actual personal data stays
visible to them.

**Side effect on existing data.** Existing org projects are unaffected
in the database — the row still has organisation_id set. They simply
become invisible / read-only for removed users. If you want to give a
removed user a fresh personal copy of an org project they used to own,
the org admin can clone it locally and unstamp the organisation_id
(or build a 'project export' affordance later).

**Belt-and-braces.** The client app (since commit including
projectStorage.ts cloudListProjects) also filters out org-stamped
projects whose organisation_id isn't in the user's current org list.
That means even if you forget to run this SQL, removed users see a
clean personal dashboard — but the SQL still needs to run to block
mutations via the database directly.
