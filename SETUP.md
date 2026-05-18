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
