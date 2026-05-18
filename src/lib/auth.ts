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
 * Sign up a new user with email + password. Used by the /accept-invite flow:
 * an admin pre-approves an email by creating an invitation row; the invitee
 * sets their password via this function, then the SECURITY DEFINER
 * `accept_invitation` RPC adds them to the org.
 *
 * `displayName` is stored in auth.users.raw_user_meta_data so the UI can
 * surface it via displayNameOf() without a separate profile table.
 *
 * If Supabase has email confirmation enabled the user will need to click a
 * confirmation link before they can sign in — turn it off in the Auth
 * settings if you want the invite link to be the only confirmation step.
 */
export async function signUpWithPassword(
  email: string,
  password: string,
  displayName?: string
): Promise<{ error: Error | null }> {
  if (!isSupabaseConfigured) {
    return { error: new Error('Supabase is not configured. See SETUP.md.') }
  }
  const { error } = await supabase().auth.signUp({
    email: email.trim(),
    password,
    options: {
      data: displayName ? { full_name: displayName.trim() } : undefined,
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
