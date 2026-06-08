-- Subscriptions table — links Supabase users / organisations to Stripe.
--
-- Every paying account (Individual or Organisation) gets a row here.
-- The Stripe webhook (supabase/functions/stripe-webhook/) is the only
-- thing that writes to this table; the app reads from it via
-- useSubscription() to gate access to paid features and show trial
-- countdowns.
--
-- Run this in the Supabase SQL editor (one-off). After it lands,
-- deploy the stripe-webhook Edge Function and point Stripe's webhook
-- endpoint at it.

create extension if not exists pgcrypto;

-- ── Subscriptions table ────────────────────────────────────────────
create table if not exists public.subscriptions (
  id uuid primary key default gen_random_uuid(),

  -- Exactly one of these is set:
  -- user_id for an Individual subscription,
  -- organisation_id for an Organisation subscription (org owner pays).
  user_id uuid references auth.users(id) on delete cascade,
  organisation_id uuid references public.organisations(id) on delete cascade,

  -- Stripe identifiers — populated by the webhook on
  -- checkout.session.completed.
  stripe_customer_id text not null unique,
  stripe_subscription_id text unique,

  -- 'individual' | 'organisation'
  plan text not null check (plan in ('individual', 'organisation')),

  -- Stripe subscription status mirror:
  -- 'trialing' | 'active' | 'past_due' | 'canceled' | 'incomplete' | 'unpaid'
  status text not null,

  -- Used by the app to show trial countdown + gate access when the
  -- subscription is canceled / past_due past grace.
  current_period_end timestamptz,
  trial_ends_at timestamptz,
  cancel_at_period_end boolean not null default false,

  -- Organisation seat count (NULL for Individual). Synced from Stripe
  -- when extra seats are added via the customer portal or our own
  -- "Add seats" flow.
  seat_count integer,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Enforce the "one of user/org" rule.
  constraint subscriptions_user_xor_org check (
    (user_id is not null and organisation_id is null) or
    (user_id is null and organisation_id is not null)
  )
);

-- Lookup indexes for the read paths the app uses:
-- by current user (Individual), by current org (Organisation), and by
-- stripe customer id (webhook handler).
create index if not exists idx_subscriptions_user
  on public.subscriptions (user_id) where user_id is not null;
create index if not exists idx_subscriptions_org
  on public.subscriptions (organisation_id) where organisation_id is not null;
create index if not exists idx_subscriptions_stripe_customer
  on public.subscriptions (stripe_customer_id);

-- ── updated_at trigger ─────────────────────────────────────────────
create or replace function public.touch_subscriptions_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists subscriptions_updated_at on public.subscriptions;
create trigger subscriptions_updated_at
  before update on public.subscriptions
  for each row execute function public.touch_subscriptions_updated_at();

-- ── RLS ────────────────────────────────────────────────────────────
-- Users can read their own subscription. Org members can read their
-- org's subscription (so the trial banner + plan info show up for
-- everyone on the team). Writes go through the service-role webhook
-- only — no client-side writes allowed.
alter table public.subscriptions enable row level security;

drop policy if exists "users read own subscription" on public.subscriptions;
create policy "users read own subscription"
  on public.subscriptions for select
  using (user_id = auth.uid());

drop policy if exists "org members read org subscription" on public.subscriptions;
create policy "org members read org subscription"
  on public.subscriptions for select
  using (
    organisation_id in (
      select organisation_id
      from public.organisation_members
      where user_id = auth.uid()
    )
  );

-- No insert/update/delete policies for the anon/authenticated roles.
-- Only the service role (used by the Edge Function webhook) can write.

-- ── Comment ────────────────────────────────────────────────────────
comment on table public.subscriptions is
  'Stripe subscription mirror. Webhook (stripe-webhook Edge Function) is the only writer.';
