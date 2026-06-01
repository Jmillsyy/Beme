/**
 * Org-scoped supply items, synced via Supabase.
 *
 * Replaces the IndexedDB-only model that lived in userSettings.supplyItems.
 * Same singleton-with-hook pattern as organisations.ts / userSettings.ts:
 *
 *   useOrgSupplyItems() → { items, loading }
 *   listOrgSupplyItems(orgId) — one-shot fetch
 *   saveOrgSupplyItem(item) — insert-or-update by id
 *   deleteOrgSupplyItem(id)
 *   refreshOrgSupplyItems() — re-fetch for the current org
 *
 * Switches org → refetches automatically (subscribes to organisations
 * singleton's `subscribeToOrgState`). Sign-out → resets to empty.
 *
 * If Supabase isn't configured (personal / offline mode) or no org is
 * active, the singleton stays empty and callers should fall back to
 * userSettings.supplyItems (the legacy IndexedDB list).
 */

import { useEffect, useReducer } from 'react'
import type { SupplyItem, SupplyItemUnit } from '../types/userSettings'
import { isSupabaseConfigured, supabase } from './supabase'
import {
  getCurrentOrgId,
  subscribeToOrgState,
} from './organisations'

interface State {
  /** Items for the current org. Empty when no org is active or while loading. */
  items: SupplyItem[]
  /** The org id these items belong to (so re-renders after a switch don't
   *  show stale data tagged to the wrong org). */
  orgId: string | null
  /** True until the first fetch for the current org completes. */
  loading: boolean
}

let state: State = { items: [], orgId: null, loading: false }
const listeners = new Set<() => void>()
function notify() {
  for (const l of listeners) l()
}

// ---------- Row ↔ SupplyItem mappers ----------

interface Row {
  id: string
  organisation_id: string
  name: string
  description: string | null
  unit: string
  rate: number
  applies_to: string[]
  enabled_by_default: boolean
  category: string | null
  opening_width_min_mm: number | null
  opening_width_max_mm: number | null
}

function rowToItem(row: Row): SupplyItem {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    unit: row.unit as SupplyItemUnit,
    rate: row.rate,
    appliesTo: row.applies_to.filter(
      (a): a is 'block' | 'brick' => a === 'block' || a === 'brick'
    ),
    enabledByDefault: row.enabled_by_default,
    category: row.category ?? undefined,
    openingWidthMinMm: row.opening_width_min_mm ?? undefined,
    openingWidthMaxMm: row.opening_width_max_mm ?? undefined,
  }
}

function itemToRow(item: SupplyItem, orgId: string): Omit<Row, 'id'> & { id?: string } {
  return {
    id: item.id,
    organisation_id: orgId,
    name: item.name,
    description: item.description ?? null,
    unit: item.unit,
    rate: item.rate,
    applies_to: item.appliesTo,
    enabled_by_default: item.enabledByDefault,
    category: item.category ?? null,
    opening_width_min_mm: item.openingWidthMinMm ?? null,
    opening_width_max_mm: item.openingWidthMaxMm ?? null,
  }
}

// ---------- Public API ----------

/** Synchronous read from the singleton — useful for non-React consumers. */
export function getOrgSupplyItems(): SupplyItem[] {
  return state.items
}

/**
 * Fetch supply items for the given org. Returns an empty list if Supabase
 * isn't configured or the user isn't a member of the org (RLS hides the
 * rows). Used by refreshOrgSupplyItems and as a one-shot for callers that
 * want fresh data without disturbing the singleton.
 */
export async function listOrgSupplyItems(orgId: string): Promise<SupplyItem[]> {
  if (!isSupabaseConfigured) return []
  const client = supabase()
  const { data, error } = await client
    .from('org_supply_items')
    .select(
      'id, organisation_id, name, description, unit, rate, applies_to, enabled_by_default, category, opening_width_min_mm, opening_width_max_mm'
    )
    .eq('organisation_id', orgId)
    .order('created_at', { ascending: true })
  if (error) {
    // eslint-disable-next-line no-console
    console.error('Failed to load org supply items', error.message)
    return []
  }
  return (data as Row[]).map(rowToItem)
}

/**
 * Insert-or-update a supply item against the current org. Returns the
 * persisted item (with whatever the database wrote — e.g. updated_at).
 * Caller is responsible for providing the SupplyItem with a stable id
 * (use crypto.randomUUID() or the existing id when editing).
 *
 * No-op if Supabase isn't configured or no org is active — caller should
 * have checked `getCurrentOrgId()` before reaching here.
 */
export async function saveOrgSupplyItem(item: SupplyItem): Promise<void> {
  if (!isSupabaseConfigured) return
  const orgId = getCurrentOrgId()
  if (!orgId) return
  const client = supabase()
  const row = itemToRow(item, orgId)
  const { error } = await client.from('org_supply_items').upsert(row, {
    onConflict: 'id',
  })
  if (error) {
    // eslint-disable-next-line no-console
    console.error('Failed to save org supply item', error.message)
    throw new Error(error.message)
  }
  // Optimistically update the singleton so the UI re-renders before the
  // round-trip to refresh. Replace any existing item with the same id.
  const next = state.items.filter((i) => i.id !== item.id).concat(item)
  state = { ...state, items: next }
  notify()
}

/** Delete a supply item by id. */
export async function deleteOrgSupplyItem(itemId: string): Promise<void> {
  if (!isSupabaseConfigured) return
  const orgId = getCurrentOrgId()
  if (!orgId) return
  const client = supabase()
  const { error } = await client
    .from('org_supply_items')
    .delete()
    .eq('id', itemId)
    .eq('organisation_id', orgId)
  if (error) {
    // eslint-disable-next-line no-console
    console.error('Failed to delete org supply item', error.message)
    throw new Error(error.message)
  }
  state = { ...state, items: state.items.filter((i) => i.id !== itemId) }
  notify()
}

/** Refetch the items for the currently active org. */
export async function refreshOrgSupplyItems(): Promise<void> {
  const orgId = getCurrentOrgId()
  if (!orgId) {
    state = { items: [], orgId: null, loading: false }
    notify()
    return
  }
  state = { ...state, orgId, loading: true }
  notify()
  const items = await listOrgSupplyItems(orgId)
  // Guard against an org switch mid-fetch — only commit if the user is
  // still on the org we started for.
  if (getCurrentOrgId() !== orgId) return
  state = { items, orgId, loading: false }
  notify()
}

/**
 * Call once at app boot. Subscribes to org-state changes so the singleton
 * refetches whenever the user switches orgs (or signs in / out, which
 * resets the org to null).
 */
export function initOrgSupplyItems(): void {
  if (!isSupabaseConfigured) return
  // Initial fetch (org state may already be populated by initOrganisations).
  void refreshOrgSupplyItems()
  subscribeToOrgState(() => {
    const currentOrgId = getCurrentOrgId()
    if (currentOrgId !== state.orgId) {
      void refreshOrgSupplyItems()
    }
  })
}

/**
 * React hook. Returns the current org's supply items + loading state, and
 * re-renders the component whenever the singleton changes.
 */
export function useOrgSupplyItems() {
  const [, force] = useReducer((x: number) => x + 1, 0)
  useEffect(() => {
    const l = () => force()
    listeners.add(l)
    return () => {
      listeners.delete(l)
    }
  }, [])
  return {
    items: state.items,
    loading: state.loading,
    orgId: state.orgId,
  }
}
