// Supabase Edge Function: stripe-webhook
//
// Single endpoint that receives every Stripe webhook event we care
// about. Verifies the signature using STRIPE_WEBHOOK_SECRET, then
// dispatches to a handler per event type.
//
// Events handled:
// checkout.session.completed       - first checkout success; provisions
// the Supabase user, creates the
// subscriptions row, sends a magic
// link sign-in email.
// customer.subscription.updated    - plan change / status change /
// cancellation scheduled.
// customer.subscription.deleted    - full cancellation; access stops
// at current_period_end.
// invoice.payment_failed           - flag as past_due so the app shows
// a banner asking to update card.
//
// Env vars required:
// STRIPE_SECRET_KEY                - sk_test_... / sk_live_...
// STRIPE_WEBHOOK_SECRET            - whsec_... (from Stripe dashboard
// after registering the endpoint)
// SUPABASE_URL                     - auto-set by Supabase runtime
// SUPABASE_SERVICE_ROLE_KEY        - auto-set by Supabase runtime
//
// Deploy: supabase functions deploy stripe-webhook --no-verify-jwt
// (--no-verify-jwt because Stripe authenticates via its own signature,
// not via a Supabase JWT.)

import Stripe from 'npm:stripe@17'
import { createClient } from 'npm:@supabase/supabase-js@2'

const STRIPE_SECRET_KEY = Deno.env.get('STRIPE_SECRET_KEY')
const STRIPE_WEBHOOK_SECRET = Deno.env.get('STRIPE_WEBHOOK_SECRET')
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
const APP_URL = Deno.env.get('APP_URL') ?? 'https://app.beme.com.au'

if (!STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY env var missing')
if (!STRIPE_WEBHOOK_SECRET) throw new Error('STRIPE_WEBHOOK_SECRET env var missing')
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('Supabase env vars missing')
}

const stripe = new Stripe(STRIPE_SECRET_KEY, {
  apiVersion: '2024-12-18.acacia',
  httpClient: Stripe.createFetchHttpClient(),
})

// Service-role client bypasses RLS - needed because the webhook is the
// only writer to the subscriptions table and creates auth.users records.
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 })
  }

  const signature = req.headers.get('stripe-signature')
  if (!signature) {
    return new Response('Missing stripe-signature header', { status: 400 })
  }

  const rawBody = await req.text()

  let event: Stripe.Event
  try {
    event = await stripe.webhooks.constructEventAsync(
      rawBody,
      signature,
      STRIPE_WEBHOOK_SECRET
    )
  } catch (err) {
    console.error('Webhook signature verification failed:', err)
    return new Response(`Webhook Error: ${String(err)}`, { status: 400 })
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed':
        await handleCheckoutCompleted(event.data.object as Stripe.Checkout.Session)
        break
      case 'customer.subscription.updated':
        await handleSubscriptionUpdated(event.data.object as Stripe.Subscription)
        break
      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(event.data.object as Stripe.Subscription)
        break
      case 'invoice.payment_failed':
        await handlePaymentFailed(event.data.object as Stripe.Invoice)
        break
      default:
        // Stripe sends a lot of event types - we only care about a few.
        // Silent ignore for everything else.
        console.log(`Ignoring event type: ${event.type}`)
    }
    return new Response(JSON.stringify({ received: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (err) {
    console.error(`Handler error for ${event.type}:`, err)
    return new Response(`Handler error: ${String(err)}`, { status: 500 })
  }
})

/* ────────────────────────────────────────────────────────────────── */
/*  Event handlers                                                    */
/* ────────────────────────────────────────────────────────────────── */

/**
 * First checkout success. Stripe gives us the customer email; we
 * provision a Supabase user (or look up an existing one with the same
 * email), create the subscriptions row, and send a magic link sign-in
 * email so the user lands in the app.
 */
async function handleCheckoutCompleted(session: Stripe.Checkout.Session) {
  if (session.mode !== 'subscription') {
    console.log('Ignoring non-subscription checkout')
    return
  }
  if (!session.subscription || !session.customer) {
    console.warn('Checkout session missing subscription or customer')
    return
  }

  const customerEmail =
    session.customer_email ?? session.customer_details?.email
  if (!customerEmail) {
    console.warn('Checkout session has no customer email')
    return
  }

  const plan = (session.metadata?.plan ??
    session.subscription_details?.metadata?.plan) as
    | 'individual'
    | 'organisation'
    | undefined

  if (plan !== 'individual' && plan !== 'organisation') {
    console.warn('Checkout session missing plan metadata, defaulting to individual')
  }
  const resolvedPlan: 'individual' | 'organisation' = plan ?? 'individual'

  // Step 1 - find or create the Supabase auth user.
  const userId = await findOrCreateUser(customerEmail)

  // Step 2 - fetch the full subscription from Stripe so we have status,
  // trial end, current period end, etc.
  const subscription = await stripe.subscriptions.retrieve(
    typeof session.subscription === 'string'
      ? session.subscription
      : session.subscription.id
  )

  // Step 3 - for Organisation plan, create the org and link the user
  // as owner. For Individual, the subscription is linked directly to
  // the user (no org).
  let organisationId: string | null = null
  if (resolvedPlan === 'organisation') {
    organisationId = await createOrganisationForUser(userId, customerEmail)
  }

  // Step 4 - insert / upsert the subscriptions row.
  const stripeCustomerId =
    typeof session.customer === 'string' ? session.customer : session.customer.id

  const { error: upsertError } = await supabase
    .from('subscriptions')
    .upsert(
      {
        user_id: resolvedPlan === 'individual' ? userId : null,
        organisation_id: organisationId,
        stripe_customer_id: stripeCustomerId,
        stripe_subscription_id: subscription.id,
        plan: resolvedPlan,
        status: subscription.status,
        current_period_end: new Date(
          subscription.current_period_end * 1000
        ).toISOString(),
        trial_ends_at: subscription.trial_end
          ? new Date(subscription.trial_end * 1000).toISOString()
          : null,
        cancel_at_period_end: subscription.cancel_at_period_end,
        seat_count:
          resolvedPlan === 'organisation'
            ? subscription.items.data[0]?.quantity ?? 5
            : null,
      },
      { onConflict: 'stripe_customer_id' }
    )

  if (upsertError) {
    throw new Error(`Subscription upsert failed: ${upsertError.message}`)
  }

  // Step 5 - send the magic link so the customer can sign in.
  const { error: linkError } = await supabase.auth.admin.generateLink({
    type: 'magiclink',
    email: customerEmail,
    options: {
      redirectTo: `${APP_URL}/`,
    },
  })

  if (linkError) {
    console.error('Magic link generation failed:', linkError)
    // Don't throw - the subscription is provisioned. User can request
    // a sign-in link from the app's login page using the same email.
  }

  console.log(`Provisioned ${resolvedPlan} subscription for ${customerEmail}`)
}

/**
 * Subscription updated - plan change, trial ending, scheduled cancel,
 * etc. Mirror the new state into our table.
 */
async function handleSubscriptionUpdated(subscription: Stripe.Subscription) {
  const customerId =
    typeof subscription.customer === 'string'
      ? subscription.customer
      : subscription.customer.id

  const { error } = await supabase
    .from('subscriptions')
    .update({
      status: subscription.status,
      current_period_end: new Date(
        subscription.current_period_end * 1000
      ).toISOString(),
      trial_ends_at: subscription.trial_end
        ? new Date(subscription.trial_end * 1000).toISOString()
        : null,
      cancel_at_period_end: subscription.cancel_at_period_end,
      seat_count: subscription.items.data[0]?.quantity ?? null,
    })
    .eq('stripe_customer_id', customerId)

  if (error) throw new Error(`Subscription update failed: ${error.message}`)
}

/**
 * Subscription fully cancelled - Stripe stops billing, we leave the
 * row in place so the user retains read-only access to their projects
 * until current_period_end, then the app gates them.
 */
async function handleSubscriptionDeleted(subscription: Stripe.Subscription) {
  const customerId =
    typeof subscription.customer === 'string'
      ? subscription.customer
      : subscription.customer.id

  const { error } = await supabase
    .from('subscriptions')
    .update({
      status: 'canceled',
      cancel_at_period_end: true,
    })
    .eq('stripe_customer_id', customerId)

  if (error) throw new Error(`Subscription delete sync failed: ${error.message}`)
}

/**
 * Payment failed - flag as past_due so the app shows an "update card"
 * banner. Stripe retries automatically; if all retries fail Stripe
 * sends customer.subscription.deleted.
 */
async function handlePaymentFailed(invoice: Stripe.Invoice) {
  const customerId =
    typeof invoice.customer === 'string'
      ? invoice.customer
      : invoice.customer?.id
  if (!customerId) return

  const { error } = await supabase
    .from('subscriptions')
    .update({ status: 'past_due' })
    .eq('stripe_customer_id', customerId)

  if (error) throw new Error(`Payment failed sync failed: ${error.message}`)
}

/* ────────────────────────────────────────────────────────────────── */
/*  Helpers                                                           */
/* ────────────────────────────────────────────────────────────────── */

/**
 * Look up the auth.users row for `email`, or create one if it doesn't
 * exist. Returns the user UUID. Uses the admin API (service-role
 * client) so it works without an existing session.
 */
async function findOrCreateUser(email: string): Promise<string> {
  // Search by email - admin.listUsers with a filter is the supported
  // way to look up by email in Supabase v2.
  const { data: existing, error: listError } = await supabase.auth.admin.listUsers()
  if (listError) {
    throw new Error(`User lookup failed: ${listError.message}`)
  }
  const found = existing.users.find(
    (u) => u.email?.toLowerCase() === email.toLowerCase()
  )
  if (found) return found.id

  // Create with email_confirm: true since they've already proven email
  // ownership by completing Stripe Checkout to that address.
  const { data: created, error: createError } =
    await supabase.auth.admin.createUser({
      email,
      email_confirm: true,
    })
  if (createError || !created.user) {
    throw new Error(`User creation failed: ${createError?.message ?? 'no user'}`)
  }
  return created.user.id
}

/**
 * Create a new organisation owned by `userId`. Used when a user pays
 * for the Organisation plan. The organisation name defaults to the
 * email's domain (e.g. acmebricks.com.au → "acmebricks") - the user
 * can rename it in settings later.
 */
async function createOrganisationForUser(
  userId: string,
  email: string
): Promise<string> {
  const domain = email.split('@')[1] ?? 'organisation'
  const defaultName = domain.split('.')[0]
  const orgName =
    defaultName.charAt(0).toUpperCase() + defaultName.slice(1)

  const { data: org, error: orgError } = await supabase
    .from('organisations')
    .insert({ name: orgName, created_by: userId })
    .select('id')
    .single()
  if (orgError || !org) {
    throw new Error(
      `Organisation creation failed: ${orgError?.message ?? 'no org'}`
    )
  }

  const { error: memberError } = await supabase
    .from('organisation_members')
    .insert({ organisation_id: org.id, user_id: userId, role: 'owner' })
  if (memberError) {
    throw new Error(`Org member creation failed: ${memberError.message}`)
  }

  return org.id
}
