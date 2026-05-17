/**
 * Organisation context — which org the current user is acting inside.
 *
 * Mirrors the singleton-with-hook pattern used by blockLibrary, brickLibrary,
 * and userSettings: a mutable in-memory singleton plus a listener set plus a
 * `useOrganisations()` hook that re-renders subscribers when the state
 * changes. The singleton holds:
 *
 *   - the list of organisations the signed-in user belongs to
 *   - the currently active organisation id (chosen by the user, or defaulted
 *     to the first org on sign-in)
 *
 * Anything else — members list, RLS-scoped queries — is fetched from Supabase
 * on demand by callers and not cached here, to keep the singleton small.
 *
 * Offline / no-Supabase mode: the singleton stays empty. Personal-project
 * users (supply-and-lay bricklayers without an org) see no org UI; the rest
 * of the app works exactly as before.
 */

import { useEffect, useReducer } from 'react'
import type { OrgMember, OrgRole, Organisation } from '../types/organisations'
import { displayNameOf } from './auth'
import { isSupabaseConfigured, supabase } from './supabase'

interface OrgState {
  /** All orgs the current user is a member of. */
  organisations: Organisation[]
  /** The org the user is currently working inside, or null for personal/no-org mode. */
  currentOrgId: string | null
  /** True until the first fetch has completed (so consumers can show a loader). */
  loading: boolean
}

const LOCAL_STORAGE_KEY = 'beme-current-org-id'

let state: OrgState = {
  organisations: [],
  currentOrgId: null,
  loading: true,
}

const listeners = new Set<() => void>()

function notify() {
  for (const l of listeners) l()
}

function subscribe(l: () => void) {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

/**
 * Synchronously read the current state. Useful from non-React contexts (e.g.
 * project saves that need to stamp the active org on the row). Components
 * should prefer `useOrganisations()` so they re-render on changes.
 */
export function getOrgState(): OrgState {
  return state
}

/** The current org id, or null. Synchronous read. */
export function getCurrentOrgId(): string | null {
  return state.currentOrgId
}

/** The current org object, or null. Synchronous read. */
export function getCurrentOrg(): Organisation | null {
  if (!state.currentOrgId) return null
  return state.organisations.find((o) => o.id === state.currentOrgId) ?? null
}

/**
 * Set the active org. Persisted to localStorage so a refresh restores the
 * choice. Pass null to drop back to personal mode (no org). No-op if the
 * id isn't one of the user's orgs — silently corrected to the first
 * available org or null.
 */
export function setCurrentOrg(orgId: string | null): void {
  let next: string | null
  if (!orgId) {
    next = null
  } else if (state.organisations.some((o) => o.id === orgId)) {
    next = orgId
  } else {
    next = state.organisations[0]?.id ?? null
  }
  if (next === state.currentOrgId) return
  state = { ...state, currentOrgId: next }
  try {
    if (next) localStorage.setItem(LOCAL_STORAGE_KEY, next)
    else localStorage.removeItem(LOCAL_STORAGE_KEY)
  } catch {
    // localStorage can throw in private modes — non-fatal, the session just
    // doesn't remember the choice after refresh.
  }
  notify()
}

/**
 * Fetch the signed-in user's orgs from Supabase and seed the singleton.
 *
 * Called on app boot and whenever auth state changes. If Supabase isn't
 * configured (env vars missing), or no user is signed in, the singleton
 * gets reset to empty. The default current org is whichever was last
 * selected (from localStorage), otherwise the first org the user is in.
 */
export async function refreshOrganisations(): Promise<void> {
  if (!isSupabaseConfigured) {
    state = { organisations: [], currentOrgId: null, loading: false }
    notify()
    return
  }
  const client = supabase()
  const {
    data: { user },
  } = await client.auth.getUser()
  if (!user) {
    state = { organisations: [], currentOrgId: null, loading: false }
    notify()
    return
  }

  // Join organisation_members with organisations so one query returns the user's
  // org list. RLS scopes the rows to memberships the user can see anyway.
  const { data, error } = await client
    .from('organisation_members')
    .select('organisation_id, organisations:organisation_id ( id, name, slug, logo_url, created_at )')
    .eq('user_id', user.id)
  if (error) {
    // eslint-disable-next-line no-console
    console.error('Failed to load organisations', error.message)
    state = { ...state, loading: false }
    notify()
    return
  }

  type Row = {
    organisation_id: string
    organisations:
      | { id: string; name: string; slug: string; logo_url: string | null; created_at: string }
      | null
  }
  const orgs: Organisation[] = []
  for (const row of (data ?? []) as Row[]) {
    if (!row.organisations) continue
    orgs.push({
      id: row.organisations.id,
      name: row.organisations.name,
      slug: row.organisations.slug,
      logoUrl: row.organisations.logo_url ?? undefined,
      createdAt: row.organisations.created_at,
    })
  }

  // Restore the previously-active org if it's still in the list; otherwise
  // pick the first org so an org-only user lands inside their org by default.
  let storedId: string | null = null
  try {
    storedId = localStorage.getItem(LOCAL_STORAGE_KEY)
  } catch {
    // ignore — localStorage may be disabled
  }
  const restored =
    (storedId && orgs.find((o) => o.id === storedId)?.id) || orgs[0]?.id || null

  state = {
    organisations: orgs,
    currentOrgId: restored,
    loading: false,
  }
  notify()
}

/** Called once at app boot to wire the singleton up to auth state changes. */
export function initOrganisations(): void {
  if (!isSupabaseConfigured) {
    state = { organisations: [], currentOrgId: null, loading: false }
    return
  }
  // Initial fetch — fire and forget; consumers see `loading: true` until done.
  void refreshOrganisations()
  // And re-fetch whenever the user signs in / out so the org list reflects
  // the current identity. We don't unsubscribe (this is a singleton for the
  // lifetime of the page).
  supabase().auth.onAuthStateChange(() => {
    void refreshOrganisations()
  })
}

/**
 * React hook. Returns the current org state and a couple of action helpers.
 * Re-renders the component whenever the singleton changes.
 */
export function useOrganisations() {
  const [, force] = useReducer((x: number) => x + 1, 0)
  useEffect(() => subscribe(() => force()), [])
  return {
    organisations: state.organisations,
    currentOrg: getCurrentOrg(),
    currentOrgId: state.currentOrgId,
    loading: state.loading,
    setCurrentOrg,
    refresh: refreshOrganisations,
  }
}

// ---------- Members ----------

/**
 * Fetch the members of an organisation, hydrated with display name / email
 * where available. Not cached — call directly from the Settings page.
 *
 * Caller must already have a Supabase session and be a member of `orgId`;
 * otherwise RLS returns an empty list.
 */
export async function listOrgMembers(orgId: string): Promise<OrgMember[]> {
  if (!isSupabaseConfigured) return []
  const client = supabase()
  const { data, error } = await client
    .from('organisation_members')
    .select('id, organisation_id, user_id, role, created_at')
    .eq('organisation_id', orgId)
    .order('created_at', { ascending: true })
  if (error) {
    // eslint-disable-next-line no-console
    console.error('Failed to load org members', error.message)
    return []
  }

  // Resolve identity for the current user via auth — Supabase's anon key can't
  // see other users' auth records, so other members come back without an email
  // until we add a `profiles` table or an RPC. The Settings UI shows them by
  // role + creation date in that case.
  const {
    data: { user },
  } = await client.auth.getUser()
  const selfId = user?.id ?? null
  const selfEmail = user?.email ?? undefined
  const selfDisplay = user ? displayNameOf(user) ?? undefined : undefined

  type Row = {
    id: string
    organisation_id: string
    user_id: string
    role: OrgRole
    created_at: string
  }
  return (data as Row[]).map((row) => ({
    id: row.id,
    organisationId: row.organisation_id,
    userId: row.user_id,
    role: row.role,
    createdAt: row.created_at,
    email: row.user_id === selfId ? selfEmail : undefined,
    displayName: row.user_id === selfId ? selfDisplay : undefined,
  }))
}

/**
 * Is the signed-in user an admin of the given org? Reads the cached membership
 * list — call after the org context has loaded. Returns false in offline mode
 * or when the user isn't a member of the org.
 */
export async function isCurrentUserOrgAdmin(orgId: string): Promise<boolean> {
  if (!isSupabaseConfigured) return false
  const client = supabase()
  const {
    data: { user },
  } = await client.auth.getUser()
  if (!user) return false
  const { data, error } = await client
    .from('organisation_members')
    .select('role')
    .eq('organisation_id', orgId)
    .eq('user_id', user.id)
    .maybeSingle()
  if (error || !data) return false
  return (data as { role: OrgRole }).role === 'admin'
}
