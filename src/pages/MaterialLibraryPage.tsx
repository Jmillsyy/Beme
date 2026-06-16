import { useMemo, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import BlockLibraryPanel from '../components/BlockLibraryPanel'
import { WallTypeTemplatesSection } from '../components/WallTypesPanel'
import LibraryHealthBanner from '../components/LibraryHealthBanner'
import LibraryTemplateControls from '../components/LibraryTemplateControls'
import LibrarySectionControls from '../components/LibrarySectionControls'
import { useAuth } from '../lib/auth'
import { confirm } from '../lib/confirm'
import { toast } from '../lib/toast'
import { useOrganisations, listOrgMembers } from '../lib/organisations'
import { updateUserSettings, useUserSettings } from '../lib/userSettings'
import {
  saveOrgSupplyItem,
  deleteOrgSupplyItem,
  refreshOrgSupplyItems,
  useOrgSupplyItems,
} from '../lib/orgSupplyItems'
import type { SupplyItem, SupplyItemUnit } from '../types/userSettings'
import type { OrgMember } from '../types/organisations'
import { useEffect } from 'react'

/**
 * The user's material library, separated out of the dashboard so it has
 * room to grow. Three concerns live here:
 *
 *   1. Blocks — the block catalogue used by block estimates.
 *   2. Bricks — the brick catalogue used by brick estimates.
 *   3. Supply items — user-defined additions priced per project (ties,
 *      cement, rebar, sundries, etc.). Replaces the legacy hardcoded
 *      ties / plascourse mechanism with a generic "add anything, set a
 *      rate basis" model.
 *
 * Admin gating: single-user accounts edit freely. Org members can VIEW
 * everything; only the org admin can edit.
 */
export default function MaterialLibraryPage() {
  const { user, loading: authLoading } = useAuth()
  const { currentOrg } = useOrganisations()
  const [members, setMembers] = useState<OrgMember[]>([])
  /**
   * Whether we've actually finished trying to load org members. Distinguishes
   * the genuine "no admin role here" case from the "still loading / load
   * failed" case — without it, the page rendered read-only during the async
   * fetch, and any RPC failure would keep an admin locked out forever.
   * Default null means "not started or in-flight"; only flips to true once
   * the fetch resolves (success OR error). For solo accounts we mark it
   * loaded immediately since there's nothing to fetch.
   */
  const [membersLoaded, setMembersLoaded] = useState<boolean>(!currentOrg)

  // Tab routing: a URL hash (#blocks, #bricks, #supply-items) selects
  // the active tab. Falls back to 'blocks' when no hash is set.
  // Legacy deep links from before the tab refactor (#supply-items)
  // keep working unchanged — the hash is the source of truth.
  const location = useLocation()
  const navigate = useNavigate()
  const activeTabId: LibraryTabId = useMemo(() => {
    const hash = location.hash.slice(1)
    const tab = LIBRARY_TABS.find((t) => t.id === hash)
    return tab ? tab.id : 'blocks'
  }, [location.hash])
  function setActiveTab(id: LibraryTabId) {
    // Replace (not push) so the back button doesn't have to undo every
    // tab toggle the user did while exploring.
    navigate({ hash: `#${id}` }, { replace: true })
  }

  // Load members so we can resolve the current user's role inside the org.
  // No-op for personal accounts.
  useEffect(() => {
    let cancelled = false
    if (!currentOrg) {
      setMembers([])
      setMembersLoaded(true)
      return
    }
    setMembersLoaded(false)
    listOrgMembers(currentOrg.id)
      .then((m) => {
        if (cancelled) return
        setMembers(m)
        setMembersLoaded(true)
      })
      .catch(() => {
        if (cancelled) return
        setMembers([])
        setMembersLoaded(true)
      })
    return () => {
      cancelled = true
    }
  }, [currentOrg])

  // Resolve admin status. We assume admin OPTIMISTICALLY while ANY of the
  // gating data is still in flight so the page renders editable from the
  // first paint — a non-admin only sees the lock once we've confirmed
  // their role. Trades a tiny "edit briefly visible then disappears"
  // flicker for non-admins against admins getting permanently locked
  // out by a slow auth resolution or a failed member fetch.
  //
  // Three things must all be ready before we can decide:
  //   1. authLoading === false (we know who the user is)
  //   2. user?.id defined     (signed in at all)
  //   3. membersLoaded === true (member list has settled, even if empty)
  //
  // The previous bug: members loaded before useAuth resolved `user`, so
  // `user?.id` was undefined and the find() returned nothing → admin
  // got locked out until something else triggered a re-render.
  const ready = !authLoading && membersLoaded && !!user?.id
  const isAdmin = currentOrg
    ? !ready
      ? true
      : members.find((m) => m.userId === user?.id)?.role === 'admin'
    : true
  const readOnly = !isAdmin

  return (
    <>
      <div className="px-12 py-10">
        <div className="flex items-end justify-between flex-wrap gap-3 mb-2">
          <div>
            <Link
              to="/"
              className="inline-flex items-center gap-1.5 text-sm text-ink-400 hover:text-beme-300 transition-colors mb-2"
            >
              <span>←</span>
              <span>Back to dashboard</span>
            </Link>
            <h2 className="text-3xl font-extrabold tracking-tight text-ink-50">
              Material library
            </h2>
            <p className="text-sm text-ink-400 mt-1 max-w-2xl">
              Every block, brick, and supply item you price into estimates.
              {currentOrg ? (
                <> Shared across your organisation; only the admin can edit.</>
              ) : (
                <> Editable any time.</>
              )}
            </p>
          </div>
          {readOnly && (
            <span className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded border border-ink-600 text-ink-400">
              Read-only · admin to edit
            </span>
          )}
        </div>

        {/* Section selector — sits immediately under the page header so
            the active scope (Blocks / Wall types / Supply items) is the
            first thing the user sees. Each card carries its CATEGORY as
            the small overline (Catalogue / Your builds / Rates &
            extras) so the page reads as grouped sections — block
            catalogue data, your reusable builds, and cross-trade rates
            — rather than a flat everything-at-once list. Bricks no
            longer have a library: brick walls count one standard brick
            and the look is uniform. Card style: each trade is a
            full-width clickable card with title + kindLabel, active
            card lights up with the brand border + background tint
            and a left accent stripe. Reads as "pick a section" rather
            than a row of tabs. Adding a new trade is a matter of
            appending to LIBRARY_TABS below; this grid responds to the
            count automatically (auto-fit columns). */}
        <div
          className="mt-6 grid gap-3"
          style={{
            gridTemplateColumns: `repeat(${LIBRARY_TABS.length}, minmax(0, 1fr))`,
          }}
          role="tablist"
          aria-label="Material library section"
        >
          {LIBRARY_TABS.map((tab) => {
            const isActive = tab.id === activeTabId
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={`relative text-left rounded-xl border p-4 transition-colors ${
                  isActive
                    ? 'border-beme-500 bg-beme-500/10 ring-2 ring-beme-500/30'
                    : 'border-ink-600 bg-ink-800/60 hover:border-ink-500 hover:bg-ink-700/60'
                }`}
                aria-selected={isActive}
                role="tab"
              >
                {/* Left accent stripe — only on the active card. Gives
                    the selection a strong visual anchor without
                    needing colour-only contrast (works in colourblind
                    cases too). */}
                {isActive && (
                  <span
                    aria-hidden="true"
                    className="absolute left-0 top-3 bottom-3 w-1 bg-beme-500 rounded-r"
                  />
                )}
                <div
                  className={`text-[10px] uppercase tracking-wider font-medium ${
                    isActive ? 'text-beme-300' : 'text-ink-500'
                  }`}
                >
                  {tab.kindLabel}
                </div>
                <div
                  className={`mt-1 text-base font-semibold ${
                    isActive ? 'text-ink-50' : 'text-ink-200'
                  }`}
                >
                  {tab.label}
                </div>
              </button>
            )
          })}
        </div>

        {/* Library-wide template controls — picking a regional preset
            seeds BOTH the block and brick libraries in one go. Sits
            below the trade selector so it reads as "context for the
            selected trade" rather than a separate competing control.
            Hidden on the Supply items tab (templates don't seed
            supply items). */}
        {activeTabId === 'blocks' && (
          <div className="mt-4">
            <LibraryTemplateControls readOnly={readOnly} />
          </div>
        )}

        {/* Active tab content. Each tab renders its own section header
            + per-section controls + body. */}
        <div className="mt-5">
          {activeTabId === 'blocks' && (
            <TabSection
              title="Blocks"
              description="Concrete blocks you supply. Code, dimensions, and what each block is used for (body, end, corner, fraction, lintel, pier, etc.). The wall-type editor pulls from this list."
            >
              <LibrarySectionControls kind="block" readOnly={readOnly} />
              <LibraryHealthBanner />
              <BlockLibraryPanel defaultExpanded hideChrome readOnly={readOnly} />
            </TabSection>
          )}

          {activeTabId === 'wall-types' && (
            <TabSection
              title="Wall types"
              description="Your named wall type templates — full compositions (height, bond, blocks, course pattern) reusable across every project. Build them here, or save one from any project's wall type card. The new-wall-type modal offers these as starting points."
            >
              <WallTypeTemplatesSection readOnly={readOnly} />
            </TabSection>
          )}

          {activeTabId === 'supply-items' && (
            <TabSection
              title="Supply items"
              description="Cross-trade items you add to estimates by rate — cement, ties, rebar, flashings, sealants, etc. Pick a unit (per block, per m², per lineal m…), set a rate, and we'll add the count to every applicable estimate, regardless of trade."
            >
              <LibrarySectionControls kind="supply" readOnly={readOnly} />
              <SupplyItemsEditor readOnly={readOnly} />
            </TabSection>
          )}
        </div>
      </div>
    </>
  )
}

/**
 * Registry of tabs the material library exposes. Trade-specific tabs
 * come first; the cross-trade Supply items tab sits at the end with a
 * separator hint so it reads as the catch-all bucket.
 *
 * To add a new trade (e.g. cladding):
 *   1. Append `{ id: 'cladding', label: 'Cladding', kindLabel: 'Trade' }`.
 *   2. Add a matching `activeTabId === 'cladding' && <TabSection …>`
 *      branch in the render above.
 *   3. Add a new `kind: 'cladding'` to LibrarySectionControls if you
 *      want a per-tab reset/empty-state.
 *
 * No other call site iterates this list — it's purely the tab UI's
 * driver — but keeping it a const array makes "what's a trade tab vs
 * a cross-trade tab" inspectable in one place.
 */
const LIBRARY_TABS = [
  { id: 'blocks' as const, label: 'Blocks', kindLabel: 'Catalogue' },
  { id: 'wall-types' as const, label: 'Wall types', kindLabel: 'Your builds' },
  { id: 'supply-items' as const, label: 'Supply items', kindLabel: 'Rates & extras' },
]
type LibraryTabId = (typeof LIBRARY_TABS)[number]['id']

/**
 * Inner section wrapper used by each tab — gives every panel the same
 * heading + description + container chrome without forcing scroll
 * anchors (the tab is the anchor now, via the URL hash).
 */
function TabSection({
  title,
  description,
  children,
}: {
  title: string
  description?: string
  children: React.ReactNode
}) {
  return (
    <section>
      <div className="mb-3">
        <h3 className="text-sm font-semibold text-ink-100">{title}</h3>
        {description && (
          <p className="text-xs text-ink-400 mt-1 max-w-2xl">{description}</p>
        )}
      </div>
      <div className="border border-ink-600 rounded-xl bg-ink-800 p-4">
        {children}
      </div>
    </section>
  )
}

// ============================================================================
// Supply items
// ============================================================================

/** Display labels + descriptions for each unit option. */
const UNIT_OPTIONS: Array<{ value: SupplyItemUnit; label: string; hint: string }> = [
  { value: 'each', label: 'Each (flat count)', hint: 'A fixed number entered per project — for one-off items.' },
  { value: 'per-block', label: 'Per block', hint: 'Rate × total block count. e.g. "rebar bars per block laid".' },
  { value: 'per-brick', label: 'Per brick', hint: 'Rate × total brick count.' },
  { value: 'per-m2', label: 'Per m² of wall', hint: 'Rate × total brickwork or blockwork area.' },
  { value: 'per-m-lineal', label: 'Per lineal m', hint: 'Rate × total wall run.' },
  { value: 'per-opening', label: 'Per opening', hint: 'Rate × number of openings.' },
  {
    value: 'per-opening-head',
    label: 'Per opening head',
    hint: 'Rate × number of opening heads. Counts every opening (doors + windows). Optional width range narrows it.',
  },
  {
    value: 'per-opening-sill',
    label: 'Per opening sill',
    hint: 'Rate × number of window sills. Doors are excluded automatically — no sill on a doorway.',
  },
]

function unitLabelOf(unit: SupplyItemUnit): string {
  return UNIT_OPTIONS.find((u) => u.value === unit)?.label ?? unit
}

function SupplyItemsEditor({ readOnly }: { readOnly: boolean }) {
  const { settings } = useUserSettings()
  const { currentOrgId, loading: orgsLoading } = useOrganisations()
  const { items: orgItems, loading: orgLoading, orgId: orgItemsOrgId } =
    useOrgSupplyItems()

  // On mount, force-refresh the org supply items so the editor always
  // shows fresh data — not the singleton's last cached state from a
  // previous visit. Without this, navigating between dashboard and
  // material library could surface stale items that were briefly
  // shown during a load race and then committed to the cache.
  useEffect(() => {
    if (currentOrgId) {
      void refreshOrgSupplyItems()
    }
  }, [currentOrgId])

  // Pick the items source carefully. Three cases:
  //   1. Orgs are still loading — don't render anything yet (the
  //      loading branch below). Falling through to settings.supplyItems
  //      would briefly show the local IndexedDB list, which often
  //      contains a stale subset (block-only or brick-only depending on
  //      what was last synced) — this is the "sometimes only block,
  //      sometimes only brick" bug.
  //   2. Org is active — use orgItems, but only after the singleton's
  //      orgId matches the current org so we don't show items belonging
  //      to a different org during a switch race.
  //   3. No org (personal mode) — local IndexedDB list.
  const itemsLoading =
    orgsLoading || (!!currentOrgId && (orgLoading || orgItemsOrgId !== currentOrgId))
  const items: SupplyItem[] = itemsLoading
    ? []
    : currentOrgId
      ? orgItems
      : settings.supplyItems ?? []
  const [editingId, setEditingId] = useState<string | 'new' | null>(null)
  // Per-category collapse state in the editor, keyed by category
  // label (or 'Uncategorised'). Mirrors the workspace SupplyItemsPanel
  // collapse — defaults to expanded, not persisted (UI affordance).
  const [collapsedCategories, setCollapsedCategories] = useState<
    Record<string, boolean>
  >({})

  const editing =
    editingId && editingId !== 'new' ? items.find((i) => i.id === editingId) : null

  // Unique category labels currently in use, sorted alphabetically.
  // Powers the category-input datalist autocomplete in SupplyItemForm.
  const existingCategories = useMemo(() => {
    const set = new Set<string>()
    for (const it of items) {
      if (it.category && it.category.trim()) set.add(it.category.trim())
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b))
  }, [items])

  async function saveItem(item: SupplyItem) {
    const isNew = !items.some((i) => i.id === item.id)
    if (currentOrgId) {
      // Org mode — upsert to Supabase. The org-items singleton
      // optimistically updates so the UI re-renders before the
      // network round-trip completes.
      try {
        await saveOrgSupplyItem(item)
      } catch (err) {
        // Error already logged inside saveOrgSupplyItem. Surface it to
        // the user and leave the editor open so they can retry.
        toast.error('Could not save supply item', {
          description: (err as Error)?.message ?? 'See the console for details.',
        })
        return
      }
    } else {
      // Personal mode — local IndexedDB.
      const existing = items.filter((i) => i.id !== item.id)
      updateUserSettings({ supplyItems: [...existing, item] })
    }
    setEditingId(null)
    toast.success(
      isNew ? `Supply item "${item.name}" added` : `Supply item "${item.name}" updated`
    )
  }

  async function deleteItem(id: string) {
    const item = items.find((i) => i.id === id)
    if (!item) return
    const ok = await confirm({
      title: `Remove "${item.name}"?`,
      message: 'The supply item will be removed from your library.',
      confirmLabel: 'Remove',
      variant: 'destructive',
    })
    if (!ok) return
    if (currentOrgId) {
      try {
        await deleteOrgSupplyItem(id)
      } catch (err) {
        toast.error('Could not remove supply item', {
          description: (err as Error)?.message ?? 'See the console for details.',
        })
        return
      }
    } else {
      updateUserSettings({ supplyItems: items.filter((i) => i.id !== id) })
    }
    toast.success(`"${item.name}" removed`)
  }

  return (
    <div className="space-y-3">
      {/* Prominent add row — pinned to the top of the panel so the
          primary action (add a supply item) is always one glance away.
          Mirrors BlockLibraryPanel and BrickLibraryPanel so every
          material-library tab opens with the same "+ Add" affordance
          in the same place. Hidden while the form is open below so
          two adds can't race. */}
      {!readOnly && editingId === null && !itemsLoading && (
        <div className="flex items-center justify-between gap-3 mb-1 pb-3 border-b border-ink-700">
          <div className="text-xs text-ink-400">
            <span className="font-semibold text-ink-200">{items.length}</span>{' '}
            supply item{items.length === 1 ? '' : 's'} in your library
          </div>
          <button
            onClick={() => setEditingId('new')}
            className="px-4 py-2 rounded-lg bg-beme-500 text-black text-sm font-semibold hover:bg-beme-400 transition-colors shadow-sm whitespace-nowrap"
          >
            + Add item
          </button>
        </div>
      )}
      {itemsLoading && (
        <p className="text-sm text-ink-400 italic">Loading supply items…</p>
      )}
      {!itemsLoading && items.length === 0 && (
        <p className="text-sm text-ink-400 italic">
          No supply items yet. Click <strong>+ Add item</strong> above to add
          the first one — e.g. brick ties at 2 per m², cement at 0.3 bags per
          m², or rebar at 1 bar per 20 blocks.
        </p>
      )}

      {/* Group items by category for the editor list — same grouping
          the workspace SupplyItemsPanel uses. Inside each group items
          stay sorted by name. Uncategorised group rendered last. */}
      {(() => {
        const UNCAT = 'Uncategorised'
        const groups = new Map<string, SupplyItem[]>()
        for (const it of items) {
          const key = it.category?.trim() || UNCAT
          const arr = groups.get(key)
          if (arr) arr.push(it)
          else groups.set(key, [it])
        }
        // Stable sort: named categories alphabetically first,
        // Uncategorised last. Within each group, sort by name.
        const entries = Array.from(groups.entries()).sort(([a], [b]) => {
          if (a === UNCAT) return 1
          if (b === UNCAT) return -1
          return a.localeCompare(b)
        })
        return entries.map(([category, list]) => {
          const showHeader = entries.length > 1 || category !== UNCAT
          const collapsed = !!collapsedCategories[category]
          return (
            <div key={category} className="space-y-2">
              {showHeader && (
                <button
                  type="button"
                  onClick={() =>
                    setCollapsedCategories((s) => ({
                      ...s,
                      [category]: !collapsed,
                    }))
                  }
                  className="flex items-center gap-2 w-full text-left group mt-2"
                >
                  <span className="text-ink-500 group-hover:text-ink-300 text-[11px]">
                    {collapsed ? '▸' : '▾'}
                  </span>
                  <h4 className="text-xs font-semibold uppercase tracking-wide text-ink-300 group-hover:text-beme-300">
                    {category}{' '}
                    <span className="text-ink-500 font-normal normal-case tracking-normal">
                      · {list.length}
                    </span>
                  </h4>
                </button>
              )}
              {!collapsed &&
                list
                  .slice()
                  .sort((a, b) => a.name.localeCompare(b.name))
                  .map((item) => (
                    <SupplyItemRow
                      key={item.id}
                      item={item}
                      readOnly={readOnly}
                      onEdit={() => setEditingId(item.id)}
                      onDelete={() => deleteItem(item.id)}
                    />
                  ))}
            </div>
          )
        })
      })()}

      {editingId !== null && !readOnly && (
        <SupplyItemForm
          existing={editing ?? null}
          existingCategories={existingCategories}
          onSave={saveItem}
          onCancel={() => setEditingId(null)}
        />
      )}
    </div>
  )
}

function SupplyItemRow({
  item,
  readOnly,
  onEdit,
  onDelete,
}: {
  item: SupplyItem
  readOnly: boolean
  onEdit: () => void
  onDelete: () => void
}) {
  const applies =
    item.appliesTo.length === 2
      ? 'Block + Brick'
      : item.appliesTo[0] === 'block'
        ? 'Block only'
        : item.appliesTo[0] === 'brick'
          ? 'Brick only'
          : '—'
  return (
    <div className="flex items-center gap-3 py-2 px-3 rounded-md border border-ink-600/40 hover:border-ink-600 hover:bg-ink-700/40">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium text-ink-100 truncate">{item.name}</span>
          <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border border-ink-600 text-ink-400">
            {applies}
          </span>
        </div>
        <div className="text-xs text-ink-400 mt-0.5">
          <span className="font-mono text-ink-300">{item.rate}</span>{' '}
          {unitLabelOf(item.unit).toLowerCase()}
          {item.description && <> · {item.description}</>}
        </div>
      </div>
      {!readOnly && (
        <>
          <button
            onClick={onEdit}
            className="px-2 py-1 rounded border border-ink-600 text-xs text-ink-300 hover:bg-ink-700 transition-colors"
          >
            Edit
          </button>
          <button
            onClick={onDelete}
            className="px-2 py-1 rounded border border-ink-600 text-xs text-ink-300 hover:bg-rose-500/10 hover:border-rose-500/40 hover:text-rose-300 transition-colors"
          >
            Delete
          </button>
        </>
      )}
    </div>
  )
}

function SupplyItemForm({
  existing,
  existingCategories,
  onSave,
  onCancel,
}: {
  existing: SupplyItem | null
  /** Unique category labels already in use across the org's supply
   *  items, used to populate the category input's datalist for
   *  autocomplete. Sorted by the parent. */
  existingCategories: string[]
  onSave: (item: SupplyItem) => void
  onCancel: () => void
}) {
  const [name, setName] = useState(existing?.name ?? '')
  const [category, setCategory] = useState(existing?.category ?? '')
  const [description, setDescription] = useState(existing?.description ?? '')
  const [unit, setUnit] = useState<SupplyItemUnit>(existing?.unit ?? 'per-m2')
  const [rate, setRate] = useState<number>(existing?.rate ?? 1)
  const [appliesToBlock, setAppliesToBlock] = useState(
    existing ? existing.appliesTo.includes('block') : true
  )
  const [appliesToBrick, setAppliesToBrick] = useState(
    existing ? existing.appliesTo.includes('brick') : true
  )
  const [enabledByDefault] = useState(
    existing?.enabledByDefault ?? true
  )
  // Opening-width range — only meaningful for unit: 'per-opening'.
  // Empty string = unbounded on that side. Stored as numbers on save.
  const [openingWidthMin, setOpeningWidthMin] = useState<number | ''>(
    existing?.openingWidthMinMm ?? ''
  )
  const [openingWidthMax, setOpeningWidthMax] = useState<number | ''>(
    existing?.openingWidthMaxMm ?? ''
  )
  // Display decimals — drives the rounding precision in the panel +
  // export. Default 0 (whole units) so brick / block / lintel counts
  // round up to a whole unit as before; users can pick 1–3 for things
  // like cement bags, sand m³, flashing m where decimals matter.
  const [decimalPlaces, setDecimalPlaces] = useState<number>(
    existing?.decimalPlaces ?? 0
  )

  const canSave =
    name.trim().length > 0 && rate > 0 && (appliesToBlock || appliesToBrick)

  const unitHint = useMemo(
    () => UNIT_OPTIONS.find((u) => u.value === unit)?.hint ?? '',
    [unit]
  )

  function handleSave() {
    const appliesTo: ('block' | 'brick')[] = []
    if (appliesToBlock) appliesTo.push('block')
    if (appliesToBrick) appliesTo.push('brick')
    // Only persist opening-width range for per-opening / per-opening-
    // head / per-opening-sill supplies — the fields are hidden for
    // other units, and storing them would just confuse the next
    // editor open.
    const isPerOpening =
      unit === 'per-opening' ||
      unit === 'per-opening-head' ||
      unit === 'per-opening-sill'
    onSave({
      id: existing?.id ?? generateId(),
      name: name.trim(),
      description: description.trim() || undefined,
      unit,
      rate,
      appliesTo,
      enabledByDefault,
      // Only persist category when non-empty after trim — undefined
      // groups the item under 'Uncategorised' in the panel.
      ...(category.trim() ? { category: category.trim() } : {}),
      ...(isPerOpening && openingWidthMin !== ''
        ? { openingWidthMinMm: openingWidthMin }
        : {}),
      ...(isPerOpening && openingWidthMax !== ''
        ? { openingWidthMaxMm: openingWidthMax }
        : {}),
      // Only persist decimalPlaces when non-zero — keeps the legacy
      // (no field) and "0 decimals" cases on the same shape so
      // existing serialised libraries don't gain a trailing 0.
      ...(decimalPlaces > 0 ? { decimalPlaces } : {}),
    })
  }

  // Esc closes the modal — matches the block / brick editor pattern.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onCancel()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onCancel])

  return (
    // Backdrop. Click-outside dismisses (stopPropagation on the inner
    // card prevents form clicks from closing).
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onCancel}
      role="dialog"
      aria-modal="true"
      aria-label={existing ? `Edit ${existing.name}` : 'New supply item'}
    >
      <div
        className="w-full max-w-2xl bg-ink-800 border border-ink-600 rounded-xl shadow-xl shadow-black/40 overflow-hidden flex flex-col max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="px-6 py-3.5 border-b border-ink-600 flex items-center justify-between">
          <h3 className="font-semibold text-ink-50">
            {existing ? `Edit "${existing.name}"` : 'Add a supply item'}
          </h3>
          <button
            onClick={onCancel}
            className="text-ink-400 hover:text-ink-100 text-xl leading-none"
            aria-label="Close"
          >
            ×
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4 text-sm">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <label className="text-sm">
          <span className="block text-ink-300 mb-1">Name</span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Brick ties, Cement, N12 rebar"
            className="w-full px-3 py-1.5 border border-ink-600 rounded-lg text-sm bg-ink-900 text-ink-50 focus:outline-none focus:border-beme-400"
          />
        </label>

        <label className="text-sm">
          <span className="block text-ink-300 mb-1">Category (optional)</span>
          <input
            type="text"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            placeholder="e.g. Galintel, Ties, Cement"
            list="supply-item-categories"
            className="w-full px-3 py-1.5 border border-ink-600 rounded-lg text-sm bg-ink-900 text-ink-50 focus:outline-none focus:border-beme-400"
          />
          {/* datalist gives a native HTML autocomplete from already-used
              categories — typing 'Gal' surfaces 'Galintel' as a
              suggestion if any other item uses it. Free-text otherwise,
              so users can introduce new categories any time. */}
          <datalist id="supply-item-categories">
            {existingCategories.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        </label>

        <label className="text-sm">
          <span className="block text-ink-300 mb-1">Rate</span>
          <input
            type="number"
            value={rate}
            min="0"
            step="0.01"
            onChange={(e) => setRate(parseFloat(e.target.value) || 0)}
            className="w-full px-3 py-1.5 border border-ink-600 rounded-lg text-sm bg-ink-900 text-ink-50 focus:outline-none focus:border-beme-400"
          />
        </label>

        <label className="text-sm">
          <span className="block text-ink-300 mb-1">Unit</span>
          <select
            value={unit}
            onChange={(e) => setUnit(e.target.value as SupplyItemUnit)}
            className="w-full px-3 py-1.5 border border-ink-600 rounded-lg text-sm bg-ink-900 text-ink-50 focus:outline-none focus:border-beme-400"
          >
            {UNIT_OPTIONS.map((u) => (
              <option key={u.value} value={u.value}>
                {u.label}
              </option>
            ))}
          </select>
          {unitHint && <p className="text-xs text-ink-400 mt-1">{unitHint}</p>}
        </label>

        <label className="text-sm">
          <span className="block text-ink-300 mb-1">Decimals on quantity</span>
          <select
            value={decimalPlaces}
            onChange={(e) => setDecimalPlaces(parseInt(e.target.value, 10) || 0)}
            className="w-full px-3 py-1.5 border border-ink-600 rounded-lg text-sm bg-ink-900 text-ink-50 focus:outline-none focus:border-beme-400"
          >
            <option value={0}>0 — whole units (12)</option>
            <option value={1}>1 decimal (1.2)</option>
            <option value={2}>2 decimals (0.12)</option>
            <option value={3}>3 decimals (0.123)</option>
          </select>
          <p className="text-xs text-ink-400 mt-1">
            How fine the quantity prints in the panel and on the export
            schedule. Higher precision suits consumables (cement, sand,
            flashing); leave at 0 for whole-unit items (bricks, blocks,
            lintels, ties).
          </p>
        </label>

        {/* Opening-width range — shown for per-opening / per-opening-
            head / per-opening-sill supplies. Used for lintels / sills /
            heads where the item depends on the opening's width (e.g.
            Galintel 100×100 for 1200–1800mm openings, steel angle for
            >1800mm). Leave both blank to apply to every in-scope
            opening (every opening for per-opening + per-opening-head;
            every window for per-opening-sill). */}
        {(unit === 'per-opening' ||
          unit === 'per-opening-head' ||
          unit === 'per-opening-sill') && (
          <div className="md:col-span-2 p-3 rounded-lg border border-ink-700 bg-ink-900/40">
            <div className="text-xs font-semibold text-ink-300 mb-1">
              Opening width range (optional)
            </div>
            <p className="text-[11px] text-ink-500 mb-3 leading-snug">
              Limit this supply to openings whose width sits within the
              range. Use it for lintels (e.g. one Galintel 100×100 per
              opening between 1200mm and 1800mm wide). Min and Max are
              both <em>inclusive</em>. Leave both blank to apply to
              every opening.
            </p>
            <div className="grid grid-cols-2 gap-3">
              <label className="text-xs">
                <span className="block text-ink-400 mb-1">Min width (mm)</span>
                <input
                  type="number"
                  value={openingWidthMin}
                  min="0"
                  step="50"
                  onChange={(e) =>
                    setOpeningWidthMin(
                      e.target.value === '' ? '' : Math.max(0, parseInt(e.target.value, 10))
                    )
                  }
                  placeholder="any"
                  className="w-full px-2 py-1 border border-ink-600 rounded text-xs bg-ink-900 text-ink-50"
                />
              </label>
              <label className="text-xs">
                <span className="block text-ink-400 mb-1">Max width (mm)</span>
                <input
                  type="number"
                  value={openingWidthMax}
                  min="0"
                  step="50"
                  onChange={(e) =>
                    setOpeningWidthMax(
                      e.target.value === '' ? '' : Math.max(0, parseInt(e.target.value, 10))
                    )
                  }
                  placeholder="any"
                  className="w-full px-2 py-1 border border-ink-600 rounded text-xs bg-ink-900 text-ink-50"
                />
              </label>
            </div>
          </div>
        )}

        <label className="text-sm md:col-span-2">
          <span className="block text-ink-300 mb-1">Description (optional)</span>
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Supplier note, code, anything that helps you remember what this is"
            className="w-full px-3 py-1.5 border border-ink-600 rounded-lg text-sm bg-ink-900 text-ink-50 focus:outline-none focus:border-beme-400"
          />
        </label>

        <div className="text-sm md:col-span-2">
          <span className="block text-ink-300 mb-1">Applies to</span>
          <div className="flex gap-4 flex-wrap">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={appliesToBlock}
                onChange={(e) => setAppliesToBlock(e.target.checked)}
                className="w-4 h-4 accent-beme-500"
              />
              <span className="text-ink-100">Block estimates</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={appliesToBrick}
                onChange={(e) => setAppliesToBrick(e.target.checked)}
                className="w-4 h-4 accent-beme-500"
              />
              <span className="text-ink-100">Brick estimates</span>
            </label>
          </div>
        </div>

        {/* The 'Add to new projects by default' toggle was here. It now
            does nothing — every supply item in the library is included on
            every applicable estimate regardless. Kept the state above so
            existing items deserialise without TypeScript complaints; will
            wire it back up when per-project opt-in lands. */}
      </div>

        </div>

        <footer className="px-5 py-3 border-t border-ink-600 flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 rounded-md border border-ink-600 text-sm text-ink-200 hover:bg-ink-700 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={!canSave}
            className="px-3 py-1.5 rounded-md bg-beme-500 text-black text-sm hover:bg-beme-400 disabled:opacity-40 disabled:cursor-not-allowed transition-colors font-semibold"
          >
            {existing ? 'Save changes' : 'Add item'}
          </button>
        </footer>
      </div>
    </div>
  )
}

function generateId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}
