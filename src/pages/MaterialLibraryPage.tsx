import { useMemo, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import Header from '../components/Header'
import BlockLibraryPanel from '../components/BlockLibraryPanel'
import BrickLibraryPanel from '../components/BrickLibraryPanel'
import LibraryHealthBanner from '../components/LibraryHealthBanner'
import { useAuth } from '../lib/auth'
import { useOrganisations, listOrgMembers } from '../lib/organisations'
import { updateUserSettings, useUserSettings } from '../lib/userSettings'
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
  const { user } = useAuth()
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

  // SPA navigation doesn't auto-scroll to a URL fragment the way a full
  // page load does, so we do it ourselves: when the location hash changes
  // (or on first mount with a hash present), find the matching element
  // and scroll it into view. The `scroll-mt-24` utility on each Section
  // leaves room for the sticky header so the heading isn't tucked under
  // it after the scroll lands.
  const location = useLocation()
  useEffect(() => {
    if (!location.hash) return
    const id = location.hash.slice(1)
    // Wait one frame so the Sections have laid out before we measure.
    const raf = requestAnimationFrame(() => {
      const el = document.getElementById(id)
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
    return () => cancelAnimationFrame(raf)
  }, [location.hash])

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

  // Resolve admin status. While members are still loading we OPTIMISTICALLY
  // assume admin so the page renders editable from the first paint — a
  // non-admin only sees the lock once we've actually confirmed their role.
  // This trades a tiny "edit briefly visible then disappears" flicker for
  // non-admins against admins getting permanently locked out by a slow or
  // failed member fetch (the previous bug — admins couldn't edit because
  // the RPC failed or hadn't resolved yet).
  const isAdmin = currentOrg
    ? !membersLoaded
      ? true
      : members.find((m) => m.userId === user?.id)?.role === 'admin'
    : true
  const readOnly = !isAdmin

  return (
    <div className="min-h-screen bg-ink-900 text-ink-50">
      <Header />
      <main className="max-w-[1600px] mx-auto px-6 py-10">
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

        <div className="space-y-8 mt-8">
          {/* Blocks */}
          <Section
            title="Blocks"
            description="Concrete blocks you supply. Code, dimensions, and what each block is used for (body, end, corner, fraction, lintel, pier, etc.). The wall-type editor pulls from this list."
          >
            {/* Library health: flags missing required + advisory roles
                so the user knows their library is set up correctly
                before the calc engine surprises them with a fallback
                or a missing block. Auto-hides when everything's green. */}
            <LibraryHealthBanner />
            <BlockLibraryPanel defaultExpanded hideChrome readOnly={readOnly} />
          </Section>

          {/* Bricks */}
          <Section
            title="Bricks"
            description="Brick types you supply. Dimensions, mortar joint, and the auto-calculated bricks-per-square-metre rate."
          >
            <BrickLibraryPanel defaultExpanded hideChrome readOnly={readOnly} />
          </Section>

          {/* Supply items */}
          <Section
            id="supply-items"
            title="Supply items"
            description="Anything you add to estimates by rate — cement, ties, rebar, flashings, sealants, etc. Pick a unit (per block, per m², per lineal m…), set a rate, and we'll add the count to every applicable estimate."
          >
            <SupplyItemsEditor readOnly={readOnly} />
          </Section>
        </div>
      </main>
    </div>
  )
}

function Section({
  title,
  description,
  children,
  id,
}: {
  title: string
  description?: string
  children: React.ReactNode
  id?: string
}) {
  return (
    <section id={id} className="scroll-mt-24">
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
]

function unitLabelOf(unit: SupplyItemUnit): string {
  return UNIT_OPTIONS.find((u) => u.value === unit)?.label ?? unit
}

function SupplyItemsEditor({ readOnly }: { readOnly: boolean }) {
  const { settings } = useUserSettings()
  const items = settings.supplyItems ?? []
  const [editingId, setEditingId] = useState<string | 'new' | null>(null)

  const editing =
    editingId && editingId !== 'new' ? items.find((i) => i.id === editingId) : null

  function saveItem(item: SupplyItem) {
    const existing = items.filter((i) => i.id !== item.id)
    updateUserSettings({ supplyItems: [...existing, item] })
    setEditingId(null)
  }

  function deleteItem(id: string) {
    const item = items.find((i) => i.id === id)
    if (!item) return
    if (!window.confirm(`Remove "${item.name}" from your supply items?`)) return
    updateUserSettings({ supplyItems: items.filter((i) => i.id !== id) })
  }

  return (
    <div className="space-y-3">
      {items.length === 0 && (
        <p className="text-sm text-ink-400 italic">
          No supply items yet. Click <strong>+ Add item</strong> to add the
          first one — e.g. brick ties at 2 per m², cement at 0.3 bags per m²,
          or rebar at 1 bar per 20 blocks.
        </p>
      )}

      {items
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

      {!readOnly && editingId === null && (
        <button
          onClick={() => setEditingId('new')}
          className="px-3 py-1.5 rounded-lg bg-beme-500 text-black text-sm font-medium hover:bg-beme-400 transition-colors"
        >
          + Add item
        </button>
      )}

      {editingId !== null && !readOnly && (
        <SupplyItemForm
          existing={editing}
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
  onSave,
  onCancel,
}: {
  existing: SupplyItem | null
  onSave: (item: SupplyItem) => void
  onCancel: () => void
}) {
  const [name, setName] = useState(existing?.name ?? '')
  const [description, setDescription] = useState(existing?.description ?? '')
  const [unit, setUnit] = useState<SupplyItemUnit>(existing?.unit ?? 'per-m2')
  const [rate, setRate] = useState<number>(existing?.rate ?? 1)
  const [appliesToBlock, setAppliesToBlock] = useState(
    existing ? existing.appliesTo.includes('block') : true
  )
  const [appliesToBrick, setAppliesToBrick] = useState(
    existing ? existing.appliesTo.includes('brick') : true
  )
  const [enabledByDefault, setEnabledByDefault] = useState(
    existing?.enabledByDefault ?? true
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
    onSave({
      id: existing?.id ?? generateId(),
      name: name.trim(),
      description: description.trim() || undefined,
      unit,
      rate,
      appliesTo,
      enabledByDefault,
    })
  }

  return (
    <div className="mt-3 p-4 border border-ink-600 rounded-lg bg-ink-700/40">
      <h4 className="text-sm font-semibold mb-3 text-ink-200">
        {existing ? `Edit "${existing.name}"` : 'New supply item'}
      </h4>

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

        <label className="text-sm md:col-span-2">
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

      <div className="flex gap-2 mt-4">
        <button
          onClick={handleSave}
          disabled={!canSave}
          className="px-4 py-1.5 rounded-lg bg-beme-500 text-black text-sm font-medium hover:bg-beme-400 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {existing ? 'Save changes' : 'Add item'}
        </button>
        <button
          onClick={onCancel}
          className="px-4 py-1.5 rounded-lg border border-ink-600 text-sm hover:bg-ink-700 transition-colors"
        >
          Cancel
        </button>
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
