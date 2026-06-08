// Supabase Edge Function: create-checkout-session
//
// POST endpoint called by the marketing site's "Start free" buttons.
// Creates a Stripe Checkout session for the requested plan, returns
// the redirect URL. Marketing JS opens the URL in the same tab.
//
// Trial: 14 days, card required upfront.
// Tax: collected automatically via Stripe Tax (configure in dashboard).
// Currency: AUD.
//
// Env vars required:
//   STRIPE_SECRET_KEY              — sk_test_... / sk_live_...
//   STRIPE_PRICE_INDIVIDUAL        — price_... ($79/mo Individual)
//   STRIPE_PRICE_ORG               — price_... ($299/mo Organisation, 5 seats)
//   STRIPE_PRICE_EXTRA_SEAT        — price_... ($49/mo extra seat — used later
//                                     for the org "Add seat" flow, not here)
//   APP_URL                        — https://app.beme.com.au  (success/cancel base)
//
// Deploy: supabase functions deploy create-checkout-session --no-verify-jwt
//   (--no-verify-jwt because this is called from the marketing site by
//   anonymous visitors who haven't signed in yet.)

import Stripe from 'npm:stripe@17'

const STRIPE_SECRET_KEY = Deno.env.get('STRIPE_SECRET_KEY')
const PRICE_INDIVIDUAL = Deno.env.get('STRIPE_PRICE_INDIVIDUAL')
const PRICE_ORG = Deno.env.get('STRIPE_PRICE_ORG')
const APP_URL = Deno.env.get('APP_URL') ?? 'https://app.beme.com.au'

if (!STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY env var missing')
if (!PRICE_INDIVIDUAL) throw new Error('STRIPE_PRICE_INDIVIDUAL env var missing')
if (!PRICE_ORG) throw new Error('STRIPE_PRICE_ORG env var missing')

const stripe = new Stripe(STRIPE_SECRET_KEY, {
  apiVersion: '2024-12-18.acacia',
  httpClient: Stripe.createFetchHttpClient(),
})

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

interface CheckoutRequest {
  /** Which plan the visitor picked on the marketing site. */
  plan: 'individual' | 'organisation'
  /** Optional — pre-fills the Stripe Checkout email field. */
  email?: string
  /** Where the visitor came from (e.g. 'hero', 'pricing-individual'). */
  source?: string
}

Deno.serve(async (req) => {
  // Browser preflight for CORS.
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405)
  }

  let body: CheckoutRequest
  try {
    body = await req.json()
  } catch {
    return jsonResponse({ error: 'Invalid JSON' }, 400)
  }

  if (body.plan !== 'individual' && body.plan !== 'organisation') {
    return jsonResponse({ error: 'plan must be "individual" or "organisation"' }, 400)
  }

  const priceId = body.plan === 'individual' ? PRICE_INDIVIDUAL : PRICE_ORG
  const sourceTag = body.source ?? 'unknown'

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],

      // 14-day free trial, card required upfront. After day 14 Stripe
      // charges automatically unless the customer cancels in the portal.
      subscription_data: {
        trial_period_days: 14,
        // Tag the subscription with the marketing source for analytics.
        metadata: {
          plan: body.plan,
          source: sourceTag,
        },
      },

      // Customer email pre-fill (skipped if not supplied — Stripe asks).
      customer_email: body.email,

      // Stripe Tax handles AU GST if enabled in dashboard. Safe to leave
      // on always — Stripe no-ops if Tax is not configured.
      automatic_tax: { enabled: true },

      // Allow promotion codes — useful for launch promos / friends-and-family.
      allow_promotion_codes: true,

      // Where Stripe sends the customer after success / cancel. /welcome
      // is a public page on the app that shows the "sign-in link sent"
      // message; /pricing is the marketing fallback if they bail out.
      success_url: `${APP_URL}/welcome?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: 'https://beme.com.au/pricing?cancelled=true',
    })

    return jsonResponse({ url: session.url }, 200)
  } catch (err) {
    console.error('Stripe checkout session error:', err)
    return jsonResponse(
      { error: 'Could not create checkout session', detail: String(err) },
      500
    )
  }
})

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders,
    },
  })
}
