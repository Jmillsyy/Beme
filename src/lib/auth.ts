/**
 * Auth utilities — sign in with Microsoft, sign out, and a React hook for the
 * current user.
 *
 * Microsoft accounts work via Supabase's "azure" OAuth provider, which we
 * configure with the Microsoft Entra app's client ID + secret in the Supabase
 * dashboard. From the client's POV it's just a redirect:
 *
 *    signInWithMicrosoft() → login.microsoftonline.com → back to /auth/callback
 *
 * Supabase then exchanges the OAuth code for a session, persists it in
 * localStorage, and emits an `onAuthStateChange` event the hook listens for.
 */

import { useEffect, useState } from 'react'
import type { Session, User } from '@supabase/supabase-js'
import { isSupabaseConfigured, supabase } from './supabase'

export interface AuthState {
  /** True until the initial session load has resolved. */
  loading: boolean
  /** The current Supabase user, or null when signed out / not configured. */
  user: User | null
  /** Convenience flag: configured AND signed in. */
  signedIn: boolean
}

/**
 * Subscribe to the current auth session. Re-renders when the user signs in /
 * out, or when the session is refreshed in the background.
 */
export function useAuth(): AuthState {
  const [state, setState] = useState<AuthState>({
    loading: true,
    user: null,
    signedIn: false,
  })

  useEffect(() => {
    // Supabase isn't configured → run in offline-only mode. The hook reports
    // "loading: false, user: null" so callers can decide what to render.
    if (!isSupabaseConfigured) {
      setState({ loading: false, user: null, signedIn: false })
      return
    }

    let cancelled = false
    const client = supabase()

    client.auth.getSession().then(({ data }: { data: { session: Session | null } }) => {
      if (cancelled) return
      setState({
        loading: false,
        user: data.session?.user ?? null,
        signedIn: !!data.session,
      })
    })

    const { data: sub } = client.auth.onAuthStateChange((_event, session) => {
      setState({
        loading: false,
        user: session?.user ?? null,
        signedIn: !!session,
      })
    })

    return () => {
      cancelled = true
      sub.subscription.unsubscribe()
    }
  }, [])

  return state
}

/**
 * Kick off the Microsoft OAuth flow. The browser redirects to
 * login.microsoftonline.com and (on success) back to our app's origin —
 * Supabase picks up the `#access_token=…` fragment automatically and stores
 * a session.
 */
export async function signInWithMicrosoft(): Promise<{ error: Error | null }> {
  if (!isSupabaseConfigured) {
    return {
      error: new Error('Supabase is not configured. See SETUP.md.'),
    }
  }
  const { error } = await supabase().auth.signInWithOAuth({
    provider: 'azure',
    options: {
      // Scopes: "email" is needed to receive the user's email back in the JWT.
      // "openid" + "profile" are standard. "offline_access" lets Supabase
      // refresh the token in the background.
      scopes: 'email openid profile offline_access',
      redirectTo: `${window.location.origin}/`,
    },
  })
  return { error }
}

/**
 * Send a one-time magic-link sign-in to the given email address.
 *
 * Supabase emails the user a link; clicking it lands them back at the app
 * origin with an active session attached. No password required, no separate
 * sign-up step — the first time a given email signs in, Supabase creates
 * an auth.users row for them automatically.
 *
 * This is the lowest-friction sign-in path; useful for dogfooding and for
 * users whose company hasn't registered a Microsoft Entra app for Beme yet.
 * Sits alongside `signInWithMicrosoft` rather than replacing it.
 */
export async function signInWithMagicLink(
  email: string
): Promise<{ error: Error | null }> {
  if (!isSupabaseConfigured) {
    return {
      error: new Error('Supabase is not configured. See SETUP.md.'),
    }
  }
  const { error } = await supabase().auth.signInWithOtp({
    email: email.trim(),
    options: {
      emailRedirectTo: `${window.location.origin}/`,
      shouldCreateUser: true,
    },
  })
  return { error }
}

/**
 * High-level account category for a Supabase user. Stored in
 * auth.users.raw_user_meta_data.account_type at sign-up time; never changes
 * over the user's lifetime.
 *
 * - `org-invited`: signed up by accepting an invitation link. These users
 *   are exclusively organisation members — even if they're not currently in
 *   any org (because they were removed, or their invite hasn't been claimed
 *   on the new org yet), the UI shows an org-aware empty state, not the
 *   personal "win-rate donut" dashboard. They live in a different product
 *   space than a bricklayer doing supply-and-lay quotes.
 *
 * - `personal`: signed up directly, lives in the personal projects flow.
 *   Can still be added to organisations later (legacy admins fall into
 *   this bucket because they signed themselves up before the invite flow
 *   existed) — when they are, they see the OrgDashboard for their active
 *   org and PersonalDashboard when no org is selected. Default for any
 *   user whose metadata doesn't have an account_type field.
 */
export type AccountType = 'personal' | 'org-invited'

/**
 * Read the account type off a user. Defaults to 'personal' so legacy users
 * (signed up before this field existed) keep their original behaviour.
 */
export function accountTypeOf(user: User | null): AccountType {
  if (!user) return 'personal'
  const t = (user.user_metadata ?? {}).account_type
  return t === 'org-invited' ? 'org-invited' : 'personal'
}

/**
 * Sign up a new user with email + password. Used by the /accept-invite flow:
 * an admin pre-approves an email by creating an invitation row; the invitee
 * sets their password via this function, then the SECURITY DEFINER
 * `accept_invitation` RPC adds them to the org.
 *
 * `displayName` is stored in auth.users.raw_user_meta_data so the UI can
 * surface it via displayNameOf() without a separate profile table.
 *
 * `accountType` defaults to 'personal' but the accept-invite flow passes
 * 'org-invited' so the dashboard knows never to show that user a personal
 * fallback even if they're temporarily not in any org.
 *
 * If Supabase has email confirmation enabled the user will need to click a
 * confirmation link before they can sign in — turn it off in the Auth
 * settings if you want the invite link to be the only confirmation step.
 */
export async function signUpWithPassword(
  email: string,
  password: string,
  displayName?: string,
  accountType: AccountType = 'personal'
): Promise<{ error: Error | null }> {
  if (!isSupabaseConfigured) {
    return { error: new Error('Supabase is not configured. See SETUP.md.') }
  }
  const data: Record<string, unknown> = { account_type: accountType }
  if (displayName?.trim()) data.full_name = displayName.trim()
  const { error } = await supabase().auth.signUp({
    email: email.trim(),
    password,
    options: {
      data,
      emailRedirectTo: `${window.location.origin}/`,
    },
  })
  return { error }
}

/**
 * Sign in with email + password. Counterpart to signUpWithPassword for
 * users who already have an account — works after they set their password
 * via the invite flow. Falls back to magic link from the sign-in page if
 * Supabase email confirmation is on and they haven't confirmed yet.
 */
export async function signInWithPassword(
  email: string,
  password: string
): Promise<{ error: Error | null }> {
  if (!isSupabaseConfigured) {
    return { error: new Error('Supabase is not configured. See SETUP.md.') }
  }
  const { error } = await supabase().auth.signInWithPassword({
    email: email.trim(),
    password,
  })
  return { error }
}

/**
 * Set or change the current user's password. Works for any signed-in user,
 * including ones who originally signed up via magic link / OAuth and never
 * picked a password. After this succeeds the user can sign in with email
 * + password going forward, in addition to whatever auth method they used
 * to create the account.
 *
 * Supabase doesn't require the existing password to update — auth.updateUser
 * trusts the active session. The signed-in user is the only one who can
 * call this for their own account, so accidental changes by a third party
 * are gated by session ownership, not password knowledge. If you ever want
 * to require the old password as an extra safety net, add an explicit
 * signInWithPassword check first.
 */
export async function updatePassword(
  newPassword: string
): Promise<{ error: Error | null }> {
  if (!isSupabaseConfigured) {
    return { error: new Error('Supabase is not configured. See SETUP.md.') }
  }
  const { error } = await supabase().auth.updateUser({ password: newPassword })
  return { error }
}

/**
 * Sign the user out everywhere. Clears the Supabase session and forces a
 * re-render of components subscribed to `useAuth`.
 */
export async function signOut(): Promise<void> {
  if (!isSupabaseConfigured) return
  await supabase().auth.signOut()
}

/**
 * Best-effort display name for the user — Microsoft puts the full name in
 * either `user_metadata.full_name` or `name`. Falls back to the email.
 */
export function displayNameOf(user: User | null): string {
  if (!user) return ''
  const meta = user.user_metadata ?? {}
  return (meta.full_name as string) || (meta.name as string) || user.email || 'Signed in'
}

/** First-letter avatar fallback. */
export function initialsOf(user: User | null): string {
  if (!user) return '?'
  const name = displayNameOf(user)
  const parts = name.split(/\s+/).filter(Boolean)
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
  return (parts[0]?.[0] ?? '?').toUpperCase()
}
