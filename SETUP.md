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
