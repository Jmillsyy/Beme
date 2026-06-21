import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useUserSettings } from '../lib/userSettings'
import { toast } from '../lib/toast'
import {
  useUserWallTypeTemplates,
  getUserWallTypeTemplates,
  saveUserWallTypeTemplate,
  deleteUserWallTypeTemplate,
} from '../lib/userWallTypeTemplates'
import { confirm } from '../lib/confirm'
import type {
  Pier,
  PierMakeup,
  WallMakeup,
  BondType,
  CourseBand,
  CourseOverride,
  CourseSeriesRange,
} from '../types/walls'
import type { BlockCode } from '../types/blocks'
import {
  BLOCK_LIBRARY,
  pickBaseCourse,
  pickBodyDefault,
  pickCornerBlock,
  pickCurveWedge,
  pickHalfBlock,
  pickTopCourse,
  useBlockLibrary,
} from '../data/blockLibrary'
import { masonryTypeColor } from '../lib/wallTypeColors'
import {
  CURVED_WALL_WEDGE_RADIUS_MM,
  CURVED_WALL_MIN_FEASIBLE_RADIUS_MM,
  curveZoneForRadius,
} from '../lib/blockCalc'
import {
  convertMakeupToBands,
  findSeriesRangeForCourse,
  getMakeupHeightMm,
  moduleHeightForBand,
  resolveCourseBlocks,
} from '../lib/makeups'
import { bandColor } from '../lib/blockColors'
import LengthInput from './LengthInput'
import LibraryGuidance from './LibraryGuidance'

// ─── Role colours ────────────────────────────────────────────────────
// Stable role → colour mapping used by the wall preview, the slot
// picker dots, and the legend. Role identity is fixed; whatever block
// CODE the user picks for that slot inherits the role's colour in the
// preview. Lets a user glance at the preview and know "the red blocks
// are corners" regardless of which code they put in the corner slot.
//
// Distinct vivid hues — each ~60° apart on the wheel so they read as
// six clearly different roles even at a glance. Pulled from Tailwind's
// 500-ish range so they sit well on the dark ink background.
type SlotRole = 'body' | 'corner' | 'half' | 'base' | 'top' | 'cap'
const ROLE_COLORS: Record<SlotRole, string> = {
  body: '#3B82F6',   // blue-500
  corner: '#EF4444', // red-500
  half: '#10B981',   // emerald-500
  base: '#F59E0B',   // amber-500
  top: '#8B5CF6',    // violet-500
  cap: '#EC4899',    // pink-500
}
const ROLE_LABELS: Record<SlotRole, string> = {
  body: 'Body',
  corner: 'Full end',
  half: 'Half end',
  base: 'Base',
  top: 'Top',
  cap: 'Cap',
}

interface WallTypesPanelProps {
  makeups: WallMakeup[]
  /**
   * Full project-wide wall makeups list — used SOLELY to compute the
   * palette slot for each type's colour swatch, so the same wall
   * type lights up the same colour regardless of which area filter
   * is active. Without this, switching from "All areas" to a
   * specific floor would reshuffle the filtered list and repaint
   * existing walls with different colours.
   *
   * Defaults to {@link makeups} when not provided — keeps the
   * single-area case working without callers having to pass the
   * list twice.
   */
  paletteMakeups?: WallMakeup[]
  activeMakeupId: string
  wallCountsByMakeupId: Record<string, number>
  onSetActive: (id: string) => void
  onAddMakeup: (makeup: WallMakeup) => void
  onUpdateMakeup: (makeup: WallMakeup) => void
  onDeleteMakeup: (id: string) => void

  /** Pier types live in this panel as a separate card group below wall
   *  types. Click a card to activate the type used when placing piers. */
  pierMakeups: PierMakeup[]
  /**
   * Full project-wide pier makeups list — see {@link paletteMakeups}.
   * Used for the same reason: pier swatch colours should be stable
   * across area filters.
   */
  palettePierMakeups?: PierMakeup[]
  pierCountsByMakeupId: Record<string, number>
  activePierMakeupId: string | null
  onSetActivePier: (id: string) => void
  onAddPierMakeup: (makeup: PierMakeup) => void
  onUpdatePierMakeup: (makeup: PierMakeup) => void
  onDeletePierMakeup: (id: string) => void

  /** Selected pier on the canvas (or null). When set, the panel renders an
   *  inline "Selected pier" inspector under the matching pier-type card. */
  selectedPier?: Pier | null
  onReassignPierMakeup?: (pierId: string, pierMakeupId: string) => void
  onDeletePier?: (pierId: string) => void
  onDeselectPier?: () => void

  /**
   * Curved-wall mode toggle. Used by the modal's TYPE picker (Curved
   * is the 2nd option) — picking Curved closes the wall editor and
   * activates curve-draw mode for the currently-active wall type.
   * Optional; brick / pre-block contexts omit it and the picker
   * simply hides the Curved option.
   */
  onToggleCurvedWall?: () => void
  /**
   * Which kind of card is currently the "live" type — `'wall'` lights
   * up the active wall card and dims any pier card with a matching
   * activePierMakeupId, and vice versa for `'pier'`. Defaults to
   * 'wall' so older callers that don't thread the prop keep their
   * existing behaviour (wall is the default active kind on every
   * project load).
   */
  activeTypeKind?: 'wall' | 'pier'
}

function generateMakeupId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

// Tile codes were enumerated here as a literal list for the (now-
// removed) Composition tab tile picker. Pairing has lifted to the
// block library so this constant is no longer needed.

function blockLabel(code: BlockCode): string {
  const b = BLOCK_LIBRARY[code]
  return b ? `${code} — ${b.name}` : code
}

export default function WallTypesPanel({
  makeups,
  paletteMakeups,
  activeMakeupId,
  wallCountsByMakeupId,
  onSetActive,
  onAddMakeup,
  onUpdateMakeup,
  onDeleteMakeup,
  pierMakeups,
  palettePierMakeups,
  pierCountsByMakeupId,
  activePierMakeupId,
  onSetActivePier,
  onAddPierMakeup,
  onUpdatePierMakeup,
  onDeletePierMakeup,
  selectedPier = null,
  onReassignPierMakeup,
  onDeletePier,
  onDeselectPier,
  onToggleCurvedWall,
  activeTypeKind = 'wall',
}: WallTypesPanelProps) {
  // The colour palette is indexed by a type's position in the FULL
  // project list — falls back to the filtered list when no palette
  // arg was passed (single-area or legacy callers).
  const colorMakeups = paletteMakeups ?? makeups
  const colorPierMakeups = palettePierMakeups ?? pierMakeups
  // Library check so the empty-state messaging below can tell the user
  // exactly what's missing — "no wall types yet, hit + Add" vs "your
  // block library is empty, fix that first then come back".
  //
  // Also drives suppression: when the library is empty we hide existing
  // wall types from the list (they reference codes that no longer
  // exist, so showing them would let the user activate a wall type
  // that can't draw anything sensible). The makeups data is preserved
  // — adding blocks back re-surfaces them.
  const { library: blockLibrary, version: blockLibraryVersion } = useBlockLibrary()
  void blockLibraryVersion
  const blockLibraryEmpty = Object.keys(blockLibrary).length === 0
  // Saved wall type templates — synced per-user via Supabase when signed
  // in, local IndexedDB fallback otherwise. Subscribed so the add-chooser
  // re-renders when the cloud fetch lands.
  const { templates: libraryTemplates } = useUserWallTypeTemplates()
  // Effective lists shown in the panel. We don't mutate `makeups` /
  // `pierMakeups` so the parent's data stays intact; we just don't
  // render rows for them while the library is empty.
  const visibleMakeups = blockLibraryEmpty ? [] : makeups
  const visiblePierMakeups = blockLibraryEmpty ? [] : pierMakeups
  /** null = no form; 'new' = adding; otherwise = editing makeup with this id */
  const [showAddChooser, setShowAddChooser] = useState(false)
  /** Library template picked via "Customise first…" — seeds the blank editor. */
  const [addSeed, setAddSeed] = useState<WallMakeup | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  /** When the pier editor swaps over to the wall modal via the Curved
   *  kind option, this carries the intent — the wall modal opens with
   *  Curved already selected so the user goes straight into curved-
   *  wall configuration instead of seeing the modal default to Wall
   *  and having to click Curved again. Cleared on close. */
  const [editingSeedKind, setEditingSeedKind] = useState<
    'wall' | 'curved'
  >('wall')
  /** Outer-level pier editor state — drives the "+ Add pier" / "Edit pier"
   *  flow from the panel directly so the user path mirrors wall types. */
  const [pierEditingId, setPierEditingId] = useState<string | null>(null)
  /** When the wall editor's kind picker swaps to a pier kind, this
   *  remembers which placement (tied / freestanding) the user picked so
   *  the pier modal opens with the right kind already selected. Cleared
   *  when the editor closes. */
  const [pierEditingSeedPlacement, setPierEditingSeedPlacement] =
    useState<'tied' | 'freestanding' | undefined>(undefined)
  const editingPierMakeup =
    pierEditingId && pierEditingId !== 'new'
      ? pierMakeups.find((m) => m.id === pierEditingId) ?? null
      : null
  const [expanded, setExpanded] = useState(true)

  const editingMakeup =
    editingId && editingId !== 'new'
      ? makeups.find((m) => m.id === editingId) ?? null
      : null

  const activeMakeup = visibleMakeups.find((m) => m.id === activeMakeupId)

  // List order matches `visibleMakeups` exactly — no float-active-to-top
  // shuffle. The previous "active type pops to position 0" behaviour
  // moved cards under the cursor when the user picked one, which broke
  // muscle memory: the second card you wanted to try was now the third
  // (the freshly activated one took its slot). Keeping insertion order
  // means every click leaves the list still, and the active card stays
  // visible via the ring + Active badge rather than relocation.
  const orderedMakeups = visibleMakeups

  return (
    <div className="border border-ink-600 rounded-lg bg-ink-800 p-2">
      <div className="flex items-center justify-between mb-2 gap-2">
        <button
          onClick={() => setExpanded((v) => !v)}
          className="flex items-center gap-2 text-left flex-1 min-w-0 group"
        >
          <span className="text-ink-500 group-hover:text-ink-300 text-xs">
            {expanded ? '▾' : '▸'}
          </span>
          <h3 className="text-sm font-semibold text-ink-200 group-hover:text-beme-300">
            Wall types
          </h3>
          <span className="text-xs text-ink-400 truncate">
            {!expanded && activeMakeup ? (
              <>· {activeMakeup.name}</>
            ) : (
              <>· {visibleMakeups.length}</>
            )}
          </span>
        </button>
        {expanded && (
          <LibraryGuidance mode="block" actionLabel="Add wall type" position="left">
            <button
              onClick={() => {
                if (blockLibraryEmpty) return
                // With library templates available, + Add opens the
                // chooser first (one-click add of a saved wall type, or
                // customise / start blank). No templates -> straight to
                // the blank editor, exactly as before.
                const hasTemplates = getUserWallTypeTemplates().length > 0
                if (hasTemplates) setShowAddChooser(true)
                else setEditingId('new')
              }}
              disabled={blockLibraryEmpty}
              className="text-xs px-2 py-1 rounded bg-beme-500 text-black font-medium hover:bg-beme-400 disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex-shrink-0"
            >
              + Add
            </button>
          </LibraryGuidance>
        )}
      </div>

      {expanded && (
        <div className="flex flex-col gap-1.5 pb-0.5">
          {orderedMakeups.map((m) => {
            // Wall card only lights up when the live kind is 'wall'.
            // Without this gate, switching to a pier left the last
            // wall card glowing in parallel and the user couldn't
            // tell which type the toolbar's Draw / Place button
            // was actually going to use.
            const isActive = m.id === activeMakeupId && activeTypeKind === 'wall'
            const wallCount = wallCountsByMakeupId[m.id] ?? 0
            // Delete is always available when there's a fallback type
            // to land on. Used to additionally require wallCount === 0
            // but that left users stuck when two duplicate types each
            // held walls (e.g. corrupt state). The confirm dialog
            // below names the wall count explicitly so the user
            // knows they're losing those walls.
            const canDelete = makeups.length > 1
            return (
              <button
                key={m.id}
                onClick={() => onSetActive(m.id)}
                className={`group/wt relative w-full p-2 rounded-md border text-left transition-colors ${
                  isActive
                    ? 'border-beme-500 ring-1 ring-beme-500/30 bg-beme-500/10'
                    : 'border-ink-600 hover:border-beme-500/50 bg-ink-700/40'
                }`}
              >
                {isActive && (
                  <span className="absolute top-1.5 right-1.5 text-[10px] px-1.5 py-0 rounded bg-beme-500 text-black font-medium leading-tight">
                    Active
                  </span>
                )}
                <div className="flex items-start gap-2 pr-12">
                  {/* "Wall" chip painted with the type's own plan colour. */}
                  <span
                    className="inline-block text-[10px] px-1.5 py-0.5 rounded uppercase tracking-wider font-semibold flex-shrink-0 text-white ring-1 ring-black/30 leading-tight"
                    style={{
                      backgroundColor: masonryTypeColor(
                        m.id,
                        colorMakeups,
                        colorPierMakeups
                      ),
                    }}
                    title="Wall colour shown on the plan"
                  >
                    {m.kind === 'curved' ||
                    typeof m.curveRadiusMm === 'number'
                      ? 'Curved'
                      : 'Wall'}
                  </span>
                  <div className="text-sm font-medium text-ink-100 break-words flex-1 min-w-0 leading-snug">
                    {m.name}
                  </div>
                </div>
                <div className="text-xs text-ink-400 mt-1 leading-tight">
                  {m.bondType} bond · {getMakeupHeightMm(m)}mm · {wallCount} wall{wallCount === 1 ? '' : 's'}
                </div>
                {m.coursePattern && m.coursePattern.length > 0 && (
                  <div className="text-xs text-beme-300 mt-1 font-mono leading-tight truncate">
                    {m.coursePattern.map((b) => `${b.count}×${b.blockCode}`).join(' + ')}
                  </div>
                )}
                {m.courseOverrides && m.courseOverrides.length > 0 && (
                  <div className="text-xs text-ink-400 mt-1 leading-tight">
                    {m.courseOverrides.length} override
                    {m.courseOverrides.length === 1 ? '' : 's'}
                  </div>
                )}
                <div
                  className={`flex gap-3 mt-1.5 transition-opacity ${
                    isActive
                      ? 'opacity-100'
                      : 'opacity-0 group-hover/wt:opacity-100'
                  }`}
                >
                  <span
                    role="button"
                    tabIndex={0}
                    onClick={(e) => {
                      e.stopPropagation()
                      setEditingId(m.id)
                    }}
                    className="text-xs text-beme-400 hover:text-beme-300 hover:underline cursor-pointer"
                  >
                    Edit
                  </span>
                  {/* Duplicate — clones the wall type as a starting point
                      for a variant (e.g. "Block wall 2400mm" →
                      "Block wall 2700mm"). Fresh id so it lives
                      independently; name suffixed with " (copy)" so the
                      user can spot which is new and rename it. */}
                  <span
                    role="button"
                    tabIndex={0}
                    onClick={(e) => {
                      e.stopPropagation()
                      onAddMakeup({
                        ...m,
                        id: generateMakeupId(),
                        name: `${m.name} (copy)`,
                      })
                    }}
                    className="text-xs text-ink-300 hover:text-ink-100 hover:underline cursor-pointer"
                  >
                    Duplicate
                  </span>
                  {/* Save to library — snapshots this wall type into the
                      user's named template collection (Material Library →
                      Wall types). New wall types in ANY project can then
                      start from it via the modal's template picker. */}
                  <span
                    role="button"
                    tabIndex={0}
                    onClick={(e) => {
                      e.stopPropagation()
                      // Synced per-user when signed in (follows your login
                      // across devices); falls back to this browser's
                      // local store offline.
                      void saveUserWallTypeTemplate({
                        ...m,
                        id: generateMakeupId(),
                      })
                      toast.success(`"${m.name}" saved to your library`)
                    }}
                    className="text-xs text-ink-300 hover:text-ink-100 hover:underline cursor-pointer"
                  >
                    Save to library
                  </span>
                  {canDelete && (
                    <span
                      role="button"
                      tabIndex={0}
                      onClick={async (e) => {
                        e.stopPropagation()
                        const ok = await confirm({
                          title: `Delete wall type "${m.name}"?`,
                          message:
                            wallCount > 0
                              ? `This wall type has ${wallCount} wall${wallCount === 1 ? '' : 's'} drawn against it. Deleting the type will also delete ${wallCount === 1 ? 'that wall' : 'those walls'}.`
                              : 'No walls reference this wall type — deleting it is safe.',
                          confirmLabel:
                            wallCount > 0
                              ? `Delete type + ${wallCount} wall${wallCount === 1 ? '' : 's'}`
                              : 'Delete',
                          variant: 'destructive',
                        })
                        if (ok) onDeleteMakeup(m.id)
                      }}
                      className="text-xs text-rose-400 hover:text-rose-300 hover:underline cursor-pointer"
                    >
                      Delete
                    </span>
                  )}
                </div>
              </button>
            )
          })}

          {/* Empty state. Distinguishes the two reasons this list might
              be empty so the user knows which knob to turn: an empty
              block library (go fix that first) vs a populated library
              with no wall types yet (hit + Add). Hidden once any wall
              or pier card exists — those already self-explain. */}
          {orderedMakeups.length === 0 && visiblePierMakeups.length === 0 && (
            <div className="rounded-lg border border-dashed border-ink-600 bg-ink-900/40 px-3 py-4 text-center">
              {blockLibraryEmpty ? (
                <>
                  <p className="text-xs font-semibold text-ink-200">
                    No wall types yet
                  </p>
                  <p className="text-[11px] text-ink-400 mt-1 leading-relaxed">
                    Add at least one block to your Material Library, then come
                    back to create wall types here.
                  </p>
                  <Link
                    to="/library#blocks"
                    className="inline-flex items-center gap-1 mt-2 text-xs font-semibold text-beme-300 hover:text-beme-200"
                  >
                    Open Material Library
                    <span aria-hidden="true">→</span>
                  </Link>
                </>
              ) : (
                <>
                  <p className="text-xs font-semibold text-ink-200">
                    No wall types yet
                  </p>
                  <p className="text-[11px] text-ink-400 mt-1 leading-relaxed">
                    Hit <span className="font-semibold text-ink-200">+ Add</span>{' '}
                    above to set up your first wall — bond, height, body and
                    corner blocks.
                  </p>
                </>
              )}
            </div>
          )}

          {/* Pier types render inline with wall types — a pier is just
              another card in this list. Selecting one and pressing
              Draw wall on the toolbar drops the pier (single-click
              placement); selecting a wall card behaves exactly the
              same (two-click draw). The Tied / Free chip is the
              only visual hint that this card is a pier. */}
          {visiblePierMakeups.map((pm) => {
            // Pier card only lights up when the live kind is 'pier'.
            // Mirror of the wall-card guard a few lines above —
            // exactly one card across both kinds reads as Active at
            // any time, matching what Draw / Place will do next.
            const isActive =
              pm.id === activePierMakeupId && activeTypeKind === 'pier'
            const pierCount = pierCountsByMakeupId[pm.id] ?? 0
            const canDelete = pierMakeups.length > 1 && pierCount === 0
            const selectionBelongsHere =
              !!selectedPier && selectedPier.pierMakeupId === pm.id
            return (
              <div key={pm.id} className="flex flex-col">
                <button
                  onClick={() => onSetActivePier(pm.id)}
                  className={`relative w-full p-2.5 rounded-lg border text-left transition-colors ${
                    isActive
                      ? 'border-beme-500 ring-2 ring-beme-500/20 bg-beme-500/10'
                      : 'border-ink-600 hover:border-beme-500/50 bg-ink-700/40'
                  } ${selectionBelongsHere ? 'rounded-b-none border-b-0' : ''}`}
                >
                  {isActive && (
                    <span className="absolute top-2 right-2 text-[11px] px-2 py-0.5 rounded bg-beme-500 text-black font-medium">
                      Active
                    </span>
                  )}
                  <div className="flex items-start gap-2 mb-1 pr-12">
                    {/* Pier chip painted with the pier's own colour-id
                        (palette indexed by position within the
                        pierMakeups list — same WALL_TYPE_PALETTE the
                        wall chips draw from). Doubles as the colour
                        swatch and the kind chip in one element. */}
                    <span
                      className="inline-block text-[10px] px-1.5 py-0.5 rounded uppercase tracking-wider font-semibold flex-shrink-0 text-white ring-1 ring-black/30"
                      style={{
                        backgroundColor: masonryTypeColor(
                          pm.id,
                          colorMakeups,
                          colorPierMakeups
                        ),
                      }}
                      title={`${
                        pm.suggestedPlacement === 'tied' ? 'Tied' : 'Free'
                      } pier`}
                    >
                      {pm.suggestedPlacement === 'tied' ? 'Tied pier' : 'Free pier'}
                    </span>
                    <div className="text-sm font-medium text-ink-100 break-words flex-1 min-w-0">
                      {pm.name}
                    </div>
                  </div>
                  <div className="text-xs text-ink-400 font-mono break-words">
                    {pm.coursePattern.join(' · ')}
                  </div>
                  <div className="text-xs text-ink-500 mt-2">
                    {pierCount} pier{pierCount === 1 ? '' : 's'} using this
                  </div>
                  {/* Placement happens via the unified toolbar "Draw
                      wall" button now — when this pier card is the
                      active type, that button drops a pier instead
                      of drawing a wall. Removes the separate "+
                      Place" pill that used to live here. */}
                  <div className="flex gap-3 mt-2 items-center">
                    <span
                      role="button"
                      tabIndex={0}
                      onClick={(e) => {
                        e.stopPropagation()
                        setPierEditingId(pm.id)
                      }}
                      className="text-xs text-beme-400 hover:text-beme-300 hover:underline cursor-pointer"
                    >
                      Edit
                    </span>
                    {canDelete && (
                      <span
                        role="button"
                        tabIndex={0}
                        onClick={async (e) => {
                          e.stopPropagation()
                          const ok = await confirm({
                            title: `Delete pier type "${pm.name}"?`,
                            message:
                              'Piers currently using this type will fall ' +
                              'back to the default.',
                            confirmLabel: 'Delete',
                            variant: 'destructive',
                          })
                          if (ok) onDeletePierMakeup(pm.id)
                        }}
                        className="text-xs text-rose-400 hover:text-rose-300 hover:underline cursor-pointer"
                      >
                        Delete
                      </span>
                    )}
                  </div>
                </button>
                {selectionBelongsHere && (
                  <SelectedPierInspector
                    selectedPier={selectedPier}
                    pierMakeups={pierMakeups}
                    onReassign={onReassignPierMakeup}
                    onDelete={onDeletePier}
                    onDeselect={onDeselectPier}
                  />
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Add chooser — shown when the user has library wall types. One
          click adds a saved template to the project; "Customise first"
          opens the editor pre-filled; "Start blank" opens it empty. */}
      {showAddChooser && (
        <div
          className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4"
          onClick={() => setShowAddChooser(false)}
        >
          <div
            className="bg-ink-800 border border-ink-600 rounded-2xl shadow-2xl w-full max-w-xl p-5"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-label="Add wall type"
          >
            <div className="flex items-start justify-between mb-1">
              <h2 className="text-base font-semibold text-ink-100">
                Add wall type
              </h2>
              <button
                onClick={() => setShowAddChooser(false)}
                className="text-ink-400 hover:text-ink-100 text-lg leading-none"
                aria-label="Close"
              >
                ×
              </button>
            </div>
            <p className="text-[11px] text-ink-500 mb-4">
              One click adds it to this project — tweak it afterwards if
              needed.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 max-h-[50vh] overflow-y-auto pr-1">
              {libraryTemplates.map((t) => (
                <div
                  key={t.id}
                  className="border border-ink-600 rounded-xl p-3 hover:border-beme-400/60 transition-colors"
                >
                  <div className="flex gap-2.5 items-center">
                    <WallTypeStackPreview makeup={t} width={22} />
                    <div className="min-w-0">
                      <div className="text-sm text-ink-100 truncate">
                        {t.name}
                      </div>
                      <div className="text-[11px] text-ink-400 font-mono">
                        {wallTypeSpec(t)} · {t.bodyBlockCode}
                      </div>
                    </div>
                  </div>
                  <div className="flex gap-3 mt-2.5">
                    <button
                      onClick={() => {
                        onAddMakeup({ ...t, id: generateMakeupId() })
                        setShowAddChooser(false)
                        toast.success(`Wall type "${t.name}" added`)
                      }}
                      className="text-[11px] font-medium text-beme-400 hover:text-beme-300 hover:underline"
                    >
                      Add to project
                    </button>
                    <button
                      onClick={() => {
                        setAddSeed(t)
                        setShowAddChooser(false)
                        setEditingId('new')
                      }}
                      className="text-[11px] text-ink-400 hover:text-ink-200 hover:underline"
                    >
                      Customise first…
                    </button>
                  </div>
                </div>
              ))}
            </div>
            <button
              onClick={() => {
                setAddSeed(null)
                setShowAddChooser(false)
                setEditingId('new')
              }}
              className="mt-3 w-full border border-dashed border-ink-600 rounded-xl px-3 py-2.5 text-xs text-ink-400 hover:text-ink-200 hover:border-ink-500 transition-colors text-left flex items-center justify-between"
            >
              <span>+ Start blank — open the full editor</span>
              <span aria-hidden="true">→</span>
            </button>
            <p className="text-[10px] text-ink-500 mt-3">
              Manage your library in Material library → Wall types
            </p>
          </div>
        </div>
      )}

      {/* Wall-type editor modal. When creating new the kind picker at the
          top lets the user swap into the pier editor via onSwitchToPier
          (handled below — closes this modal, opens the pier modal with
          the right seed placement). When editing existing, no swap is
          possible — the makeup's kind is fixed. */}
      {editingId !== null && (
        <WallTypeEditorModal
          existing={editingId === 'new' ? null : editingMakeup}
          onSwitchToPier={
            editingId === 'new'
              ? (placement) => {
                  setEditingId(null)
                  setPierEditingSeedPlacement(placement)
                  setPierEditingId('new')
                }
              : undefined
          }
          // Curved option is available whenever the host has wired a
          // curve-draw toggle. Picking Curved no longer closes the
          // modal — the builder stays open with the same fields as a
          // straight wall, and on Save the parent uses the kind hint
          // (below) to activate curve-draw with the freshly saved
          // wall type.
          curvedAvailable={
            editingId === 'new' && Boolean(onToggleCurvedWall)
          }
          initialKind={editingSeedKind}
          seed={editingId === 'new' ? addSeed : null}
          onCancel={() => {
            setEditingId(null)
            setEditingSeedKind('wall')
            setAddSeed(null)
          }}
          onSave={(m) => {
            const isNew = editingId === 'new'
            if (isNew) onAddMakeup(m)
            else onUpdateMakeup(m)
            setEditingId(null)
            setEditingSeedKind('wall')
            setAddSeed(null)
            // Confirmation toast — the modal vanishes, the new type
            // appears in the wall-types panel, but the panel might be
            // long enough that the new entry is below the fold. Toast
            // makes the save explicit and labels the type by name.
            toast.success(
              isNew ? `Wall type "${m.name}" added` : `Wall type "${m.name}" updated`
            )
            // No auto curve-draw activation here. The saved wall type
            // sits in the panel labelled "Curved" (kind flag on the
            // makeup); the user selects it like any other type and
            // then hits Draw — the toolbar's draw routing checks the
            // active makeup's kind and routes to curve-draw or
            // straight-draw accordingly. Same flow as a normal wall.
          }}
        />
      )}

      {/* Pier type editor — same flow as wall-type "+ Add". onSwitchToWall
          lets the kind picker swap back to the wall editor without
          losing the user's place. */}
      {pierEditingId !== null && (
        <PierTypeEditorModal
          existing={pierEditingId === 'new' ? null : editingPierMakeup}
          seedPlacement={pierEditingSeedPlacement}
          onSwitchToWall={
            pierEditingId === 'new'
              ? () => {
                  setPierEditingId(null)
                  setPierEditingSeedPlacement(undefined)
                  setEditingId('new')
                }
              : undefined
          }
          // Curved option in the pier modal now hands control to the
          // WALL editor with Curved already selected, instead of
          // dismissing both modals and dropping the user straight
          // into curve-draw mode. The user fills out the wall
          // builder, saves, then curve-draw activates on the new
          // makeup — same flow as picking Curved directly from the
          // wall modal.
          onSwitchToCurved={
            pierEditingId === 'new' && onToggleCurvedWall
              ? () => {
                  setPierEditingId(null)
                  setPierEditingSeedPlacement(undefined)
                  setEditingSeedKind('curved')
                  setEditingId('new')
                }
              : undefined
          }
          onCancel={() => {
            setPierEditingId(null)
            setPierEditingSeedPlacement(undefined)
          }}
          onSave={(pm) => {
            const isNew = pierEditingId === 'new'
            if (isNew) {
              onAddPierMakeup(pm)
              onSetActivePier(pm.id)
            } else {
              onUpdatePierMakeup(pm)
            }
            setPierEditingId(null)
            setPierEditingSeedPlacement(undefined)
            toast.success(
              isNew ? `Pier type "${pm.name}" added` : `Pier type "${pm.name}" updated`
            )
          }}
        />
      )}
    </div>
  )
}

// ---------- Internal: WallTypeEditorModal ----------

type TabKey = 'basics' | 'composition' | 'pattern' | 'advanced'

/**
 * Three-way segmented picker at the top of the wall / pier editor modals.
 * Drives the kind being created — Wall / Tied pier / Freestanding pier.
 * Only rendered when creating a NEW makeup; editing existing skips it
 * because the kind is fixed by which makeup the user opened.
 *
 * In the wall modal: picking a pier kind calls onChange which the parent
 * intercepts to close this modal and open the pier modal with the right
 * seed placement.
 *
 * In the pier modal: picking the other pier kind just updates placement
 * in-place; picking Wall closes the pier modal and opens the wall modal.
 *
 * Lives at file scope (above the editors that consume it) so both modals
 * can render the same component.
 */
type MakeupKind = 'wall' | 'curved' | 'tied-pier' | 'freestanding-pier'
function KindPicker({
  current,
  onChange,
  hideCurved,
}: {
  current: MakeupKind
  onChange: (kind: MakeupKind) => void
  /** Hide the Curved option entirely (e.g. brick contexts where the
   *  curved-block math hasn't been built out). When false/undefined,
   *  Curved sits between Wall and the two pier kinds. */
  hideCurved?: boolean
}) {
  // Curved sits between Wall and the two pier kinds because it's a
  // wall-flavoured action — picking it tags the modal session as a
  // curved-wall configure so on Save the parent activates curve-
  // draw with the new makeup. The builder fields are otherwise
  // identical to Wall.
  const options: { value: MakeupKind; label: string }[] = [
    { value: 'wall', label: 'Wall' },
    ...(!hideCurved ? [{ value: 'curved' as const, label: 'Curved' }] : []),
    { value: 'tied-pier', label: 'Tied pier' },
    { value: 'freestanding-pier', label: 'Freestanding pier' },
  ]
  return (
    <div className="px-5 py-2.5 border-b border-ink-600 bg-ink-900/20">
      <div className="flex items-center gap-3">
        <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-400">
          Type
        </span>
        <div className="inline-flex border border-ink-600 rounded-lg overflow-hidden">
          {options.map((o, i) => {
            const isActive = o.value === current
            return (
              <button
                key={o.value}
                type="button"
                onClick={() => {
                  if (!isActive) onChange(o.value)
                }}
                className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                  isActive
                    ? 'bg-beme-500 text-black'
                    : 'bg-ink-800 text-ink-300 hover:bg-ink-700 hover:text-ink-100'
                } ${i > 0 ? 'border-l border-ink-600' : ''}`}
                aria-pressed={isActive}
              >
                {o.label}
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}

interface WallTypeEditorModalProps {
  existing: WallMakeup | null
  /** When creating a new makeup (existing === null), the user can switch
   *  between Wall / Tied pier / Freestanding pier via a picker at the
   *  top of the modal. Picking a pier kind closes this modal and opens
   *  the pier editor with the right seed placement — handled in the
   *  parent via `onSwitchToPier`. Ignored when editing existing. */
  onSwitchToPier?: (placement: 'tied' | 'freestanding') => void
  /** Whether the host context supports the Curved option in the kind
   *  picker at all. When `true`, picking Curved keeps the builder
   *  open (same tabs / same fields as Wall) and `onSave` fires with
   *  `kind: 'curved'` so the parent can activate curve-draw mode for
   *  the just-saved wall type. When falsy/undefined, the Curved
   *  option is hidden entirely. The legacy "close-and-toggle" flow
   *  (a separate `onSwitchToCurved` callback) was retired — curved
   *  walls now use the same wall type configuration as straight ones
   *  and the parent picks how to draw them. */
  curvedAvailable?: boolean
  /** Pre-seed the kind picker so the modal opens with Curved already
   *  selected (e.g. when the pier modal hands control back via its
   *  own Curved option). Defaults to 'wall'. */
  initialKind?: 'wall' | 'curved'
  /**
   * Library template to pre-fill a NEW wall type from ("Customise
   * first…" in the add chooser). Unlike `existing`, the modal still
   * behaves as CREATE — saving produces a fresh project wall type.
   */
  seed?: WallMakeup | null
  onSave: (makeup: WallMakeup, opts?: { kind?: 'wall' | 'curved' }) => void
  onCancel: () => void
}

/**
 * Full-screen editor for a wall type. Replaces the old inline side-panel
 * form — that form had too many fields (bond, height, composition, course
 * pattern, overrides, series ranges) to read cleanly in the narrow rail.
 *
 * Layout: backdrop overlay → centred dialog → header + left tab rail +
 * tabbed content area + footer with Cancel / Save. Escape closes, clicking
 * the backdrop closes. Save / Cancel are always visible in the footer so
 * the user never has to scroll to commit.
 *
 * Tabs:
 *   - Basics       : name, height, bond, options
 *   - Composition  : base / body / top / end-termination block pickers
 *                    (plus the curve wedge-vs-normal dual section)
 *   - Course Pattern: bands editor + live visual stack preview
 *   - Advanced     : per-course overrides + course-series ranges
 */
export function WallTypeEditorModal({
  existing,
  onSwitchToPier,
  curvedAvailable,
  initialKind,
  seed = null,
  onSave,
  onCancel,
}: WallTypeEditorModalProps) {
  // Field seeding: edits load the existing wall type; creates load the
  // chooser's template when one was picked. `existing` alone still
  // decides edit-vs-create semantics everywhere below.
  const init = existing ?? seed
  // Wall vs curved kind for THIS configure pass. Curved is just an
  // intent flag now — the builder shows the same tabs / fields as a
  // straight wall, and the calc engine adapts the chosen blocks to
  // the curve geometry on draw. On Save the parent reads this flag
  // and picks straight-draw or curve-draw mode with the new makeup.
  const [selectedKind, setSelectedKind] = useState<'wall' | 'curved'>(
    initialKind ?? 'wall'
  )
  const { library } = useBlockLibrary()
  // Selectable blocks for the wall composition dropdowns. Filters out
  // 'legacy'-tagged blocks (e.g. paired tiles like 50.45 that are
  // auto-tallied via Block.pairedWith and not user-picked).
  const selectableBlocks = useMemo<BlockCode[]>(
    () =>
      Object.values(library)
        .filter((b) => !b.roles.includes('legacy'))
        .map((b) => b.code)
        .sort(),
    [library]
  )

  const [activeTab, setActiveTab] = useState<TabKey>('basics')
  // Slot under the user's pointer / keyboard focus — drives the wall
  // preview's "highlight matching cells" effect. null when nothing is
  // active. Lives at the modal level because the preview is in the
  // right rail (sibling to the form), so the form's mouse/focus
  // signals have to reach across through a common ancestor.
  const [highlightedSlot, setHighlightedSlot] = useState<SlotRole | null>(null)
  // User-level defaults — when creating a NEW wall type, seed match-
  // exact-length and its scope from the user's Settings preferences so
  // the user only sets them once globally. Existing makeups keep their
  // own saved values. `useFractions` is per-makeup (toggleable in
  // Basics); `exactLengthCourses` (which course types it applies to)
  // is global-only and read straight from settings — there's no UI
  // for it on the per-makeup form.
  const { settings: userSettings } = useUserSettings()
  const settingsMatchExact =
    userSettings.defaults.defaultMatchExactLength ?? true
  const settingsExactLengthCourses =
    userSettings.defaults.defaultExactLengthCourses

  const [name, setName] = useState(init?.name ?? 'New wall type')
  const [bondType, setBondType] = useState<BondType>(
    init?.bondType ??
      (userSettings.defaults.defaultBondType as BondType) ??
      'stretcher'
  )
  const [heightMm, setHeightMm] = useState<number>(
    init?.heightMm ?? userSettings.defaults.defaultWallHeightMm ?? 2400
  )
  const [useFractions, setUseFractions] = useState(
    init?.useFractions ?? settingsMatchExact
  )
  // matchExactHeight defaults to true so legacy wall types (with
  // `undefined` on the field) keep emitting dedicated height-makeup
  // blocks. New wall types start with it on too — matches the AU
  // bricklaying default. US / UK estimators can flip it off per
  // wall type to switch to cut-body behaviour.
  const [matchExactHeight, setMatchExactHeight] = useState(
    init?.matchExactHeight ??
      userSettings.defaults.defaultMatchExactHeight ??
      true,
  )
  const exactLengthCourses = init?.exactLengthCourses ?? settingsExactLengthCourses

  // Defaults for new wall types come from the LIVE library via the role
  // pickers — so a US user creating their first wall type lands on
  // CMU8 / CMU8-C / CMU8-H instead of the AU SEQ codes. Existing wall
  // types keep the codes they were saved with.
  //
  // Each fallback chain ends in pickBodyDefault() before the hardcoded
  // SEQ code — so a region whose library doesn't tag (say) a top-course
  // or base-course block STILL gets a real code from the live library
  // (the body block) instead of an AU code that doesn't exist there.
  // The AU literals are last-resort only.
  // Passing userSettings activates defaultsByRole resolution — the
  // codes captured by "Set default" on a wall type card win over the
  // library's role tags, so new wall types seed from the user's chosen
  // exemplar rather than whatever the library tagged first.
  const roleOpts = { settings: userSettings }
  const bodyFallback = pickBodyDefault(roleOpts)?.code ?? '20.48'
  const [baseCourseBlockCode, setBaseCourseBlockCode] = useState<BlockCode>(
    init?.baseCourseBlockCode ?? pickBaseCourse(roleOpts)?.code ?? bodyFallback
  )
  const [bodyBlockCode, setBodyBlockCode] = useState<BlockCode>(
    init?.bodyBlockCode ?? bodyFallback
  )
  const [topCourseBlockCode, setTopCourseBlockCode] = useState<BlockCode>(
    init?.topCourseBlockCode ?? pickTopCourse(roleOpts)?.code ?? bodyFallback
  )
  const [cornerBlockCode, setCornerBlockCode] = useState<BlockCode>(
    init?.cornerBlockCode ?? pickCornerBlock(roleOpts)?.code ?? bodyFallback
  )
  const [halfBlockCode, setHalfBlockCode] = useState<BlockCode>(
    init?.halfBlockCode ?? pickHalfBlock(roleOpts)?.code ?? bodyFallback
  )
  // Capping tile — defaults to UNSET (empty string in the picker, no
  // cap on the wall). The user explicitly picks a cap-tagged block to
  // add one. Storage on the makeup is `capBlockCode?: BlockCode`, so
  // we serialise undefined when the picker is empty.
  const [capBlockCode, setCapBlockCode] = useState<BlockCode | ''>(
    init?.capBlockCode ??
      ((userSettings.defaultsByRole?.cap as BlockCode | undefined) || '')
  )

  const [courseOverrides, setCourseOverrides] = useState<CourseOverride[]>(
    init?.courseOverrides ?? []
  )

  // ---- Course pattern (bands) state ----
  const [coursePattern, setCoursePattern] = useState<CourseBand[]>(
    init?.coursePattern ?? []
  )
  const hasCoursePattern = coursePattern.length > 0
  const patternTotalHeight = useMemo(
    () =>
      coursePattern.reduce(
        (sum, b) => sum + (b.count > 0 ? b.count * moduleHeightForBand(b, library) : 0),
        0
      ),
    [coursePattern, library]
  )
  const patternTotalCourses = useMemo(
    () => coursePattern.reduce((sum, b) => sum + Math.max(0, b.count), 0),
    [coursePattern]
  )

  function addBand() {
    // Default new band to the current body block, then to the live
    // library's body-tagged block, then to the AU code as last resort.
    const defaultCode =
      bodyBlockCode || pickBodyDefault()?.code || '20.48'
    setCoursePattern((prev) => [
      ...prev,
      { blockCode: defaultCode, count: 1 },
    ])
  }
  function updateBand(index: number, patch: Partial<CourseBand>) {
    setCoursePattern((prev) => prev.map((b, i) => (i === index ? { ...b, ...patch } : b)))
  }
  function removeBand(index: number) {
    setCoursePattern((prev) => prev.filter((_, i) => i !== index))
  }
  function moveBand(index: number, direction: -1 | 1) {
    setCoursePattern((prev) => {
      const next = [...prev]
      const target = index + direction
      if (target < 0 || target >= next.length) return prev
      ;[next[index], next[target]] = [next[target], next[index]]
      return next
    })
  }

  async function convertCurrentToBands() {
    const draft: WallMakeup = {
      id: existing?.id ?? 'draft',
      name,
      bondType,
      heightMm,
      baseCourseBlockCode,
      bodyBlockCode,
      topCourseBlockCode,
      cornerBlockCode,
      halfBlockCode,
      useFractions,
      matchExactHeight,
      exactLengthCourses,
      courseOverrides,
    }
    // skipHeightMakeup: true keeps the preview faithful to the user's
    // configured composition. The calc engine still emits height-makeup
    // courses (20.71 / 20.140) in its tally where the wall height
    // calls for them — this just stops the preview surprising users
    // with blocks they didn't pick.
    const { bands, lossy } = convertMakeupToBands(draft, undefined, {
      skipHeightMakeup: true,
    })
    if (bands.length === 0) {
      toast.error('Wall is too short to convert (less than one course).')
      return
    }
    if (lossy) {
      const ok = await confirm({
        title: 'Convert to course pattern?',
        message:
          "This wall type has per-course overrides that can't be " +
          'translated band-for-band. The overrides will be cleared.',
        confirmLabel: 'Convert anyway',
        variant: 'destructive',
      })
      if (!ok) return
    }
    setCoursePattern(bands)
    if (lossy) setCourseOverrides([])
  }

  async function clearCoursePattern() {
    const ok = await confirm({
      title: 'Clear the course pattern?',
      message:
        'Reverts this wall type to the uniform-height makeup. ' +
        'The Height field will take over again.',
      confirmLabel: 'Clear pattern',
      variant: 'destructive',
    })
    if (!ok) {
      return
    }
    setCoursePattern([])
  }

  function addOverride() {
    // Override defaults to the current body block so a US user picking
    // 'add override' gets CMU8, not the AU 20.48.
    const defaultCode = bodyBlockCode || pickBodyDefault()?.code || '20.48'
    setCourseOverrides((prev) => [...prev, { courseNumber: 2, blockCode: defaultCode }])
  }
  function updateOverride(index: number, patch: Partial<CourseOverride>) {
    setCourseOverrides((prev) =>
      prev.map((o, i) => (i === index ? { ...o, ...patch } : o))
    )
  }
  function removeOverride(index: number) {
    setCourseOverrides((prev) => prev.filter((_, i) => i !== index))
  }

  const [seriesRanges, setSeriesRanges] = useState<CourseSeriesRange[]>(
    init?.courseSeriesRanges ?? []
  )

  function addSeriesRange() {
    // Seed a blank range — every field undefined so the user picks
    // their own codes from the live library via the RangeRow dropdowns.
    // Pre-filling 30-series AU codes was wrong outside AU (US/UK
    // libraries don't have 30.xx codes, so the user would see a list
    // of invalid blocks). The user picks their region's "secondary
    // series" blocks via the dropdowns instead.
    setSeriesRanges((prev) => [
      ...prev,
      {
        fromCourse: 1,
        toCourse: 5,
      },
    ])
  }
  function updateSeriesRange(index: number, patch: Partial<CourseSeriesRange>) {
    setSeriesRanges((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)))
  }
  function removeSeriesRange(index: number) {
    setSeriesRanges((prev) => prev.filter((_, i) => i !== index))
  }

  // ---- Curve-makeup state ----
  const curveRadiusMm = existing?.curveRadiusMm
  const isCurveMakeup = typeof curveRadiusMm === 'number' && isFinite(curveRadiusMm)
  const wedgeRequired = isCurveMakeup && curveRadiusMm < CURVED_WALL_WEDGE_RADIUS_MM
  const curveZone = isCurveMakeup ? curveZoneForRadius(curveRadiusMm) : null
  const wedgeFeasible = isCurveMakeup && curveRadiusMm >= CURVED_WALL_MIN_FEASIBLE_RADIUS_MM
  const [wedgeBodyBlockCode, setWedgeBodyBlockCode] = useState<BlockCode>(
    existing && wedgeRequired
      ? existing.bodyBlockCode
      : pickCurveWedge()?.code ?? '20.03CW'
  )
  const [normalBodyBlockCode, setNormalBodyBlockCode] = useState<BlockCode>(
    existing && !wedgeRequired && isCurveMakeup
      ? existing.bodyBlockCode
      : pickBodyDefault()?.code ?? '20.48'
  )
  // A wedge curve has no use for course-mixing fields — disable Pattern /
  // Advanced tabs and force back to Basics if the user lands there.
  const wedgeDisablesCourseMix = isCurveMakeup && wedgeRequired

  // ---- Preview bands (always-on visual stack) ----
  // When the user has an explicit course pattern, that's the source of
  // truth. Otherwise synthesise bands from the current form state via
  // convertMakeupToBands so the preview shows what a legacy uniform-height
  // wall looks like with its base/body/top stack and any height-makeup
  // courses derived from heightMm. courseOverrides are ignored in the
  // preview (the conversion is lossy with overrides); the preview is a
  // visual aid, not an authoritative render of the calc-engine output.
  const previewBands = useMemo<CourseBand[]>(() => {
    if (coursePattern.length > 0) return coursePattern
    const resolvedBodyForPreview: BlockCode = isCurveMakeup
      ? wedgeRequired
        ? wedgeBodyBlockCode
        : normalBodyBlockCode
      : bodyBlockCode
    const draft: WallMakeup = {
      id: existing?.id ?? 'preview',
      name,
      bondType,
      heightMm,
      baseCourseBlockCode,
      bodyBlockCode: resolvedBodyForPreview,
      topCourseBlockCode,
      cornerBlockCode,
      halfBlockCode,
      useFractions,
      matchExactHeight,
      exactLengthCourses,
    }
    return convertMakeupToBands(draft, undefined, { skipHeightMakeup: true }).bands
  }, [
    coursePattern,
    existing?.id,
    name,
    bondType,
    heightMm,
    baseCourseBlockCode,
    bodyBlockCode,
    topCourseBlockCode,
    cornerBlockCode,
    halfBlockCode,
    useFractions,
    matchExactHeight,
    isCurveMakeup,
    wedgeRequired,
    wedgeBodyBlockCode,
    normalBodyBlockCode,
  ])

  // ---- Per-course preview resolution ----
  // Builds an in-flight WallMakeup from the form state so the preview can
  // call resolveCourseBlocks per course — that way courseSeriesRanges
  // (e.g. 300 series on the base 5 courses) actually show up in the
  // preview's body/corner/half cells, and courseOverrides override the
  // body block on individual courses too.
  const previewMakeup = useMemo<WallMakeup>(() => {
    const resolvedBody: BlockCode = isCurveMakeup
      ? wedgeRequired
        ? wedgeBodyBlockCode
        : normalBodyBlockCode
      : bodyBlockCode
    return {
      id: existing?.id ?? 'preview',
      name,
      bondType,
      heightMm,
      baseCourseBlockCode,
      bodyBlockCode: resolvedBody,
      topCourseBlockCode,
      cornerBlockCode,
      halfBlockCode,
      useFractions,
      matchExactHeight,
      exactLengthCourses,
      courseOverrides,
      courseSeriesRanges: seriesRanges,
      coursePattern: coursePattern.length > 0 ? coursePattern : undefined,
    }
  }, [
    existing?.id,
    name,
    bondType,
    heightMm,
    baseCourseBlockCode,
    bodyBlockCode,
    topCourseBlockCode,
    cornerBlockCode,
    halfBlockCode,
    useFractions,
    matchExactHeight,
    courseOverrides,
    seriesRanges,
    coursePattern,
    isCurveMakeup,
    wedgeRequired,
    wedgeBodyBlockCode,
    normalBodyBlockCode,
  ])

  // Per-course resolver for the preview. Precedence (most specific wins):
  //   1. courseOverrides[courseNumber] → body
  //   2. courseSeriesRanges[range covers course].bodyBlockCode → body
  //   3. Band's blockCode at that course position → body
  //   4. makeup.bodyBlockCode (fallback)
  // Corner and half always come from resolveCourseBlocks() so series
  // ranges' cornerBlockCode / halfBlockCode are honoured for the
  // end-termination cells.
  const resolveForCourse = useMemo(() => {
    // Total visible courses across all bands — used to detect the top
    // course so a series range overlay doesn't accidentally swap its
    // top course block for the range's body code.
    const totalCourses = previewBands.reduce(
      (s, b) => s + Math.max(0, b.count),
      0
    )
    return (courseNumber: number) => {
      const resolved = resolveCourseBlocks(previewMakeup, courseNumber)
      // Find this course's band body (which course of which band?)
      let cursor = 0
      let bandBody: BlockCode = previewMakeup.bodyBlockCode
      for (const band of previewBands) {
        if (band.count <= 0) continue
        if (courseNumber <= cursor + band.count) {
          bandBody = band.blockCode
          break
        }
        cursor += band.count
      }
      const range = findSeriesRangeForCourse(previewMakeup, courseNumber)
      const override = courseOverrides.find((o) => o.courseNumber === courseNumber)
      // Series range field selection — different course "roles" pull
      // different override fields from the range so 300-series on the
      // bottom 5 courses correctly substitutes the BASE course block
      // (30.45) for course 1 instead of the body block (30.48).
      //
      //   Course 1                 → range.baseCourseBlockCode
      //   Height-makeup courses    → range.heightMakeup71BlockCode
      //     (detected via library: any band block whose face height is
      //      below the typical 190mm modular height is height-makeup)
      //   Top course               → keep band code (no range overlay)
      //     so a wall topped by a bond beam doesn't get overwritten by
      //     a 300-series body code
      //   Otherwise                → range.bodyBlockCode
      let rangeOverride: BlockCode | undefined
      if (range) {
        const blockHeight = library[bandBody]?.dimensions.heightMm ?? 190
        const isBase = courseNumber === 1
        const isTop = courseNumber === totalCourses && totalCourses >= 2
        const isHeightMakeup = blockHeight < 190
        if (isBase) {
          rangeOverride = range.baseCourseBlockCode
        } else if (isHeightMakeup) {
          rangeOverride = range.heightMakeup71BlockCode
        } else if (isTop) {
          rangeOverride = undefined
        } else {
          rangeOverride = range.bodyBlockCode
        }
      }
      const body =
        override?.blockCode ??
        rangeOverride ??
        bandBody

      // Stale-makeup guard. If a saved wall makeup references a code
      // that doesn't exist in the active library (e.g. a US user
      // opening a project saved on AU), swap to the library's body /
      // corner / half via the role pickers. This keeps the preview
      // legible AND keeps the tally tied to real codes in the user's
      // library.
      const heal = (code: BlockCode, fallback: () => BlockCode | undefined): BlockCode =>
        library[code] ? code : fallback() ?? code

      return {
        body: heal(body, () => pickBodyDefault()?.code),
        corner: heal(resolved.cornerBlockCode, () => pickCornerBlock()?.code),
        half: heal(resolved.halfBlockCode, () => pickHalfBlock()?.code),
      }
    }
  }, [previewMakeup, previewBands, courseOverrides, library])

  // ---- Colour map for the preview + legend ----
  // Maps each code via plain hash-based `bandColor`. We DELIBERATELY
  // don't use buildBlockColorMap (which dedupes slot collisions across
  // the codes in a set) — because the 3D view builds its colour map
  // from EVERY code across EVERY wall in the project, while this
  // panel only sees the current makeup. With buildBlockColorMap the
  // same `20.48` block landed on different palette slots in the two
  // scopes (different sort orders → different collision walks), and
  // the user saw the preview colour not match the 3D fill.
  //
  // bandColor() is a pure function of the code, so the same block code
  // resolves to the same colour everywhere. Two codes can collide on
  // a shared slot (~1/16), but the concrete-grey palette mostly
  // varies by lightness so the cost is minor next to the consistency
  // gain.
  const previewColorMap = useMemo<Map<string, string>>(() => {
    const codes = new Set<string>()
    for (const band of previewBands) {
      if (band.blockCode) codes.add(band.blockCode)
    }
    const totalCourses = previewBands.reduce(
      (s, b) => s + Math.max(0, b.count),
      0
    )
    for (let c = 1; c <= totalCourses; c++) {
      const r = resolveForCourse(c)
      if (r.body) codes.add(r.body)
      if (r.corner) codes.add(r.corner)
      if (r.half) codes.add(r.half)
    }
    const map = new Map<string, string>()
    for (const code of codes) map.set(code, bandColor(code))
    return map
  }, [previewBands, resolveForCourse])

  function handleSave() {
    const cleanedRanges = seriesRanges.filter((r) => {
      if (r.toCourse < r.fromCourse) return false
      const anyOverride =
        r.bodyBlockCode ||
        r.cornerBlockCode ||
        r.halfBlockCode ||
        r.baseCourseBlockCode ||
        r.heightMakeup71BlockCode ||
        r.cornerLeadInBlockCode
      return !!anyOverride
    })
    const resolvedBodyBlockCode: BlockCode = isCurveMakeup
      ? wedgeRequired
        ? wedgeBodyBlockCode
        : normalBodyBlockCode
      : bodyBlockCode
    const cleanedPattern = coursePattern.filter(
      (b) => b.count > 0 && !!BLOCK_LIBRARY[b.blockCode]
    )
    const finalHeightMm =
      cleanedPattern.length > 0
        ? cleanedPattern.reduce(
            (sum, b) => sum + b.count * moduleHeightForBand(b, library),
            0
          )
        : heightMm
    const updated: WallMakeup = {
      id: existing?.id ?? generateMakeupId(),
      name: name.trim() || 'New wall type',
      // Stamp the kind so the panel labels this row as Curved and the
      // drawing handler defaults to curve-draw when this type becomes
      // active. Existing makeups keep their previous kind (existing
      // wall types stay 'wall', existing curve makeups stay 'curved').
      kind:
        existing?.kind ??
        (selectedKind === 'curved' ? 'curved' : 'wall'),
      bondType,
      heightMm: finalHeightMm,
      baseCourseBlockCode,
      bodyBlockCode: resolvedBodyBlockCode,
      topCourseBlockCode,
      cornerBlockCode,
      halfBlockCode,
      useFractions,
      matchExactHeight,
      exactLengthCourses,
      courseOverrides: courseOverrides.length > 0 ? courseOverrides : undefined,
      courseSeriesRanges: cleanedRanges.length > 0 ? cleanedRanges : undefined,
      coursePattern: cleanedPattern.length > 0 ? cleanedPattern : undefined,
      curveRadiusMm: existing?.curveRadiusMm,
      // Cap tile — undefined when the picker is empty (no cap). When
      // set, downstream (3D + calc) appends one cap course per wall.
      ...(capBlockCode ? { capBlockCode } : {}),
      // Preserve the area assignment across edits. The editor doesn't
      // expose an area picker, so the only correct behaviour is to keep
      // whatever area the wall type was already bound to. Without this
      // round-trip, every edit dropped areaId → handleUpdateMakeup
      // replaced the makeup wholesale, the wall type was demoted to
      // "All areas only", and the user's per-area scoping silently
      // broke after each save.
      ...(existing?.areaId ? { areaId: existing.areaId } : {}),
    }
    onSave(updated, { kind: selectedKind })
  }

  const canSave =
    name.trim().length > 0 && (hasCoursePattern ? patternTotalHeight > 0 : heightMm >= 200)

  // Escape closes the dialog. Mirrors the platform-standard modal UX so
  // power users can dismiss without reaching for the mouse.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onCancel()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onCancel])

  // Disable the Composition tab when the user has switched to a course
  // pattern — the bands carry per-course block codes, so the legacy
  // per-role pickers (body / corner / base / top / half) are no longer
  // consulted. Showing them as editable would suggest they still matter
  // and confuse the user about which surface "wins". Same disabled-rail
  // pattern as wedgeDisablesCourseMix.
  const compositionDisabledByPattern = hasCoursePattern
  const tabs: { key: TabKey; label: string; badge?: string; disabled?: boolean; disabledReason?: string }[] = [
    { key: 'basics', label: 'Basics' },
    {
      key: 'composition',
      label: isCurveMakeup ? 'Composition (curve)' : 'Composition',
      disabled: compositionDisabledByPattern,
      disabledReason: compositionDisabledByPattern
        ? 'Replaced by Course pattern — clear the pattern to re-enable.'
        : undefined,
    },
    {
      key: 'pattern',
      label: 'Course pattern',
      badge: hasCoursePattern ? `${coursePattern.length}` : undefined,
      disabled: wedgeDisablesCourseMix,
      disabledReason: wedgeDisablesCourseMix ? 'Not applicable for wedge curves' : undefined,
    },
    {
      key: 'advanced',
      label: 'Advanced',
      badge:
        courseOverrides.length + seriesRanges.length > 0
          ? `${courseOverrides.length + seriesRanges.length}`
          : undefined,
      disabled: wedgeDisablesCourseMix,
      disabledReason: wedgeDisablesCourseMix ? 'Not applicable for wedge curves' : undefined,
    },
    // Piers used to live as a tab inside this modal. They now have their
    // own "+ Add" / "Edit" buttons in the Pier types section of the panel.
  ]

  // If the user just enabled course pattern (added the first band) while
  // sitting on the Composition tab, hop them to Course pattern so they
  // don't stare at a now-disabled tab with no content. One-shot effect
  // keyed off the disable flag flipping true.
  useEffect(() => {
    if (compositionDisabledByPattern && activeTab === 'composition') {
      setActiveTab('pattern')
    }
  }, [compositionDisabledByPattern, activeTab])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={onCancel}
      role="dialog"
      aria-modal="true"
      aria-label={existing ? `Edit wall type ${existing.name}` : 'New wall type'}
    >
      <div
        className="bg-ink-800 border border-ink-600 rounded-2xl shadow-2xl w-full max-w-6xl h-[90vh] max-h-[960px] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <header className="px-5 py-3 border-b border-ink-600 flex items-center justify-between bg-ink-900/40">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-ink-100 truncate">
              {existing ? 'Edit wall type' : 'New wall type'}
              {existing && (
                <span className="text-ink-400 font-normal"> — {existing.name}</span>
              )}
            </h2>
            <p className="text-[11px] text-ink-500 mt-0.5">
              {hasCoursePattern
                ? `Pattern-driven · ${patternTotalCourses} courses · ${patternTotalHeight} mm`
                : `${Math.round(heightMm / 200)} courses · ${heightMm} mm`}
            </p>
          </div>
          <button
            onClick={onCancel}
            className="text-ink-400 hover:text-ink-100 text-2xl leading-none px-2"
            aria-label="Close"
          >
            ×
          </button>
        </header>

        {/* Kind picker — only shown when creating a NEW makeup. Lets the
            user swap into the pier editor without going back to the
            panel. Hidden when editing existing (the kind is fixed by
            which makeup you opened — to convert a wall to a pier you'd
            delete and recreate). */}
        {!existing && (onSwitchToPier || curvedAvailable) && (
          <KindPicker
            current={selectedKind === 'curved' ? 'curved' : 'wall'}
            onChange={(kind) => {
              if (kind === 'tied-pier') onSwitchToPier?.('tied')
              else if (kind === 'freestanding-pier')
                onSwitchToPier?.('freestanding')
              else if (kind === 'curved' && curvedAvailable) setSelectedKind('curved')
              else if (kind === 'wall') setSelectedKind('wall')
            }}
            hideCurved={!curvedAvailable}
          />
        )}

        {/* Tabs + content */}
        <div className="flex flex-1 min-h-0">
          {/* Left tab rail */}
          <nav className="w-44 border-r border-ink-600 bg-ink-900/30 p-2 flex flex-col gap-1">
            {tabs.map((t) => {
              const isActive = activeTab === t.key
              return (
                <button
                  key={t.key}
                  onClick={() => !t.disabled && setActiveTab(t.key)}
                  disabled={t.disabled}
                  className={`text-left text-sm px-3 py-2 rounded-lg transition-colors flex items-center justify-between gap-2 ${
                    isActive
                      ? 'bg-beme-500/15 text-beme-200 border border-beme-500/40'
                      : t.disabled
                      ? 'text-ink-600 cursor-not-allowed'
                      : 'text-ink-300 hover:bg-ink-700/60 border border-transparent'
                  }`}
                  title={t.disabled ? t.disabledReason ?? 'Not applicable here' : undefined}
                >
                  <span>{t.label}</span>
                  {t.badge && (
                    <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-ink-700 text-ink-300">
                      {t.badge}
                    </span>
                  )}
                </button>
              )
            })}
          </nav>

          {/* Tab content */}
          <div className="flex-1 overflow-y-auto p-6 min-w-0">
            {activeTab === 'basics' && (
              <BasicsTab
                name={name}
                setName={setName}
                heightMm={heightMm}
                setHeightMm={setHeightMm}
                bondType={bondType}
                setBondType={setBondType}
                useFractions={useFractions}
                setUseFractions={setUseFractions}
                matchExactHeight={matchExactHeight}
                setMatchExactHeight={setMatchExactHeight}
                hasCoursePattern={hasCoursePattern}
                patternTotalHeight={patternTotalHeight}
                wedgeDisablesCourseMix={wedgeDisablesCourseMix}
                isCurveMakeup={isCurveMakeup}
                curveRadiusMm={curveRadiusMm}
                curveZone={curveZone}
                onJumpToPattern={() => setActiveTab('pattern')}
              />
            )}

            {activeTab === 'composition' && (
              <CompositionTab
                isCurveMakeup={isCurveMakeup}
                curveRadiusMm={curveRadiusMm}
                curveZone={curveZone}
                wedgeRequired={wedgeRequired}
                wedgeFeasible={wedgeFeasible}
                wedgeBodyBlockCode={wedgeBodyBlockCode}
                setWedgeBodyBlockCode={setWedgeBodyBlockCode}
                normalBodyBlockCode={normalBodyBlockCode}
                setNormalBodyBlockCode={setNormalBodyBlockCode}
                baseCourseBlockCode={baseCourseBlockCode}
                setBaseCourseBlockCode={setBaseCourseBlockCode}
                bodyBlockCode={bodyBlockCode}
                setBodyBlockCode={setBodyBlockCode}
                topCourseBlockCode={topCourseBlockCode}
                setTopCourseBlockCode={setTopCourseBlockCode}
                cornerBlockCode={cornerBlockCode}
                setCornerBlockCode={setCornerBlockCode}
                halfBlockCode={halfBlockCode}
                setHalfBlockCode={setHalfBlockCode}
                capBlockCode={capBlockCode}
                setCapBlockCode={setCapBlockCode}
                selectableBlocks={selectableBlocks}
                library={library}
                onHighlightSlot={setHighlightedSlot}
              />
            )}

            {activeTab === 'pattern' && (
              <PatternTab
                coursePattern={coursePattern}
                hasCoursePattern={hasCoursePattern}
                patternTotalHeight={patternTotalHeight}
                patternTotalCourses={patternTotalCourses}
                library={library}
                selectableBlocks={selectableBlocks}
                addBand={addBand}
                updateBand={updateBand}
                removeBand={removeBand}
                moveBand={moveBand}
                convertCurrentToBands={convertCurrentToBands}
                clearCoursePattern={clearCoursePattern}
                hasOverrides={courseOverrides.length > 0}
              />
            )}

            {activeTab === 'advanced' && (
              <AdvancedTab
                courseOverrides={courseOverrides}
                addOverride={addOverride}
                updateOverride={updateOverride}
                removeOverride={removeOverride}
                seriesRanges={seriesRanges}
                addSeriesRange={addSeriesRange}
                updateSeriesRange={updateSeriesRange}
                removeSeriesRange={removeSeriesRange}
                selectableBlocks={selectableBlocks}
              />
            )}

          </div>

          {/* Right rail: live visual stack preview. Shows on every tab so
              changes anywhere in the form (height, body block, pattern)
              produce immediate feedback. Hidden on narrow viewports to
              give the form room — kicks in at lg (1024px+). Wider rail
              (80 = 320px) gives the wall section room to render the
              bond pattern clearly on tall walls. */}
          <aside className="hidden lg:flex w-80 flex-shrink-0 border-l border-ink-600 bg-ink-900/30 flex-col p-4 min-h-0">
            <div className="flex items-baseline justify-between mb-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-400">
                Wall preview
              </h3>
              {hasCoursePattern ? (
                <span className="text-[10px] text-beme-300 font-mono">pattern</span>
              ) : (
                <span className="text-[10px] text-ink-500 font-mono">auto</span>
              )}
            </div>
            <p className="text-[10px] text-ink-500 mb-3 leading-snug">
              {hasCoursePattern
                ? 'From the bands you defined on the Course pattern tab.'
                : 'Derived from Basics + Composition. Switch to Course pattern for full control.'}
            </p>
            <div className="flex-1 min-h-0">
              <CoursePatternPreview
                bands={previewBands}
                library={library}
                bondType={bondType}
                resolveForCourse={resolveForCourse}
                colorMap={previewColorMap}
                highlightedSlot={highlightedSlot}
              />
            </div>
            {/* Tiny legend so the user can map cell colour → block code at
                a glance. Walks the same per-course resolver as the
                preview so series-range overrides and per-course
                overrides surface in the legend too. */}
            <PreviewLegend
              bands={previewBands}
              resolveForCourse={resolveForCourse}
              bondType={bondType}
              colorMap={previewColorMap}
            />
          </aside>
        </div>

        {/* Footer — Cancel + Save always visible */}
        <footer className="px-5 py-3 border-t border-ink-600 bg-ink-900/40 flex items-center justify-between gap-2">
          <p className="text-[11px] text-ink-500 hidden sm:block">
            {hasCoursePattern
              ? 'Height is computed from the course pattern.'
              : 'Use the Course pattern tab for walls with mixed-height courses.'}
          </p>
          <div className="flex gap-2 ml-auto">
            <button
              onClick={onCancel}
              className="px-4 py-1.5 rounded-lg border border-ink-600 text-sm text-ink-200 hover:bg-ink-700 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={!canSave}
              className="px-4 py-1.5 rounded-lg bg-beme-500 text-black text-sm font-medium hover:bg-beme-400 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {existing ? 'Save changes' : 'Create wall type'}
            </button>
          </div>
        </footer>
      </div>

    </div>
  )
}

// ---------- Tab: Basics ----------

interface BasicsTabProps {
  name: string
  setName: (v: string) => void
  heightMm: number
  setHeightMm: (v: number) => void
  bondType: BondType
  setBondType: (v: BondType) => void
  useFractions: boolean
  setUseFractions: (v: boolean) => void
  matchExactHeight: boolean
  setMatchExactHeight: (v: boolean) => void
  hasCoursePattern: boolean
  patternTotalHeight: number
  wedgeDisablesCourseMix: boolean
  isCurveMakeup: boolean
  curveRadiusMm: number | undefined
  curveZone: ReturnType<typeof curveZoneForRadius> | null
  onJumpToPattern: () => void
}

function BasicsTab({
  name,
  setName,
  heightMm,
  setHeightMm,
  bondType,
  setBondType,
  useFractions,
  setUseFractions,
  matchExactHeight,
  setMatchExactHeight,
  hasCoursePattern,
  patternTotalHeight,
  wedgeDisablesCourseMix,
  isCurveMakeup,
  curveRadiusMm,
  curveZone,
  onJumpToPattern,
}: BasicsTabProps) {
  return (
    <div className="max-w-2xl space-y-5">
      <label className="text-sm block">
        <span className="block text-ink-300 mb-1.5">Name</span>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-full px-3 py-2 border border-ink-600 rounded-lg text-sm bg-ink-900 focus:outline-none focus:border-beme-400"
        />
      </label>

      <label className="text-sm block">
        <span className="flex items-center justify-between text-ink-300 mb-1.5">
          <span>Height (mm)</span>
          {hasCoursePattern && (
            <span className="text-[11px] text-beme-300">
              Driven by course pattern · {patternTotalHeight} mm
            </span>
          )}
        </span>
        <LengthInput
          valueMm={hasCoursePattern ? patternTotalHeight : heightMm}
          onChangeMm={(mm) => setHeightMm(Math.round(mm))}
          minMm={200}
          disabled={hasCoursePattern}
          className="w-full"
        />
        {!hasCoursePattern && !wedgeDisablesCourseMix && (
          <p className="text-[11px] text-ink-500 mt-1.5">
            Mixed-height wall? Open the{' '}
            <button
              type="button"
              onClick={onJumpToPattern}
              className="text-beme-400 hover:text-beme-300 underline"
            >
              Course pattern
            </button>{' '}
            tab to spell out each band of courses (e.g. 4× 20.48 + 2× 20.71).
          </p>
        )}
      </label>

      <fieldset
        className={`text-sm ${
          wedgeDisablesCourseMix ? 'opacity-40 pointer-events-none' : ''
        }`}
        disabled={wedgeDisablesCourseMix}
      >
        <legend className="text-ink-300 mb-1.5">Bond type</legend>
        <div className="flex gap-4">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="radio"
              checked={bondType === 'stretcher'}
              onChange={() => setBondType('stretcher')}
            />
            <span>Stretcher</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="radio"
              checked={bondType === 'stack'}
              onChange={() => setBondType('stack')}
            />
            <span>Stack</span>
          </label>
        </div>
      </fieldset>

      <fieldset
        className={`text-sm ${
          wedgeDisablesCourseMix ? 'opacity-40 pointer-events-none' : ''
        }`}
        disabled={wedgeDisablesCourseMix}
      >
        <legend className="text-ink-300 mb-1.5">Options</legend>
        <label className="flex items-start gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={useFractions}
            onChange={(e) => setUseFractions(e.target.checked)}
            className="mt-0.5"
          />
          <span className="leading-snug">
            <span>Match exact wall length</span>
            <span className="block text-[11px] text-ink-400 mt-0.5">
              When on, the calc absorbs leftover length using
              fraction-tagged blocks from your library (e.g. AU 20.02 /
              20.22), or tallies cut blocks if your library has none.
              When off, walls round up to whole body blocks and the gap
              is ignored. WHICH course types this rule applies to is
              configured globally in{' '}
              <Link to="/settings" className="text-orange-400 underline">
                Settings → Wall defaults
              </Link>
              .
            </span>
          </span>
        </label>
        <label className="flex items-start gap-2 cursor-pointer mt-3">
          <input
            type="checkbox"
            checked={matchExactHeight}
            onChange={(e) => setMatchExactHeight(e.target.checked)}
            className="mt-0.5"
          />
          <span className="leading-snug">
            <span>Match exact wall height</span>
            <span className="block text-[11px] text-ink-400 mt-0.5">
              When on, the leftover between the requested height and the
              nearest 200mm course count is filled with a dedicated
              height-makeup block from your library (e.g. AU 20.71 /
              20.140). When off, the calc emits a cut body block at the
              required height instead — same body code as the rest of
              the wall, tallied as a full block (you'd order a full one
              and chop it).
            </span>
          </span>
        </label>
      </fieldset>

      {isCurveMakeup && (
        <div className="mt-4 p-4 border border-ink-600 rounded-lg bg-ink-900/60">
          <div className="text-xs font-semibold uppercase tracking-wide text-ink-400 mb-1.5">
            Curve geometry
          </div>
          <div className="text-sm text-ink-200">
            Centreline radius:{' '}
            <span className="font-mono">R{Math.round(curveRadiusMm!)}mm</span>
            <span className="text-ink-400 ml-2">
              ·{' '}
              {curveZone === 'standard'
                ? 'standard 20.48, no cuts'
                : curveZone === 'cut'
                ? 'standard 20.48 with rear-corner cuts'
                : curveZone === 'wedge'
                ? '20.03CW wedge band'
                : 'tighter than wedge — custom blocks required'}
            </span>
          </div>
          {curveZone === 'custom' && (
            <p className="mt-2 text-[11px] text-amber-400">
              This radius is below the wedge feasibility threshold (
              {CURVED_WALL_MIN_FEASIBLE_RADIUS_MM}mm). 20.03CW is the closest stock block
              but custom-cut blocks will be flagged in the estimate.
            </p>
          )}
        </div>
      )}
    </div>
  )
}

// ---------- Tab: Composition ----------

interface CompositionTabProps {
  isCurveMakeup: boolean
  curveRadiusMm: number | undefined
  curveZone: ReturnType<typeof curveZoneForRadius> | null
  wedgeRequired: boolean
  wedgeFeasible: boolean
  wedgeBodyBlockCode: BlockCode
  setWedgeBodyBlockCode: (v: BlockCode) => void
  normalBodyBlockCode: BlockCode
  setNormalBodyBlockCode: (v: BlockCode) => void
  baseCourseBlockCode: BlockCode
  setBaseCourseBlockCode: (v: BlockCode) => void
  bodyBlockCode: BlockCode
  setBodyBlockCode: (v: BlockCode) => void
  topCourseBlockCode: BlockCode
  setTopCourseBlockCode: (v: BlockCode) => void
  cornerBlockCode: BlockCode
  setCornerBlockCode: (v: BlockCode) => void
  halfBlockCode: BlockCode
  setHalfBlockCode: (v: BlockCode) => void
  /** Optional capping tile. Empty string = no cap. */
  capBlockCode: BlockCode | ''
  setCapBlockCode: (v: BlockCode | '') => void
  selectableBlocks: BlockCode[]
  /** Live library — used to read per-block depths for series-locking
   *  the non-body slot dropdowns to the body block's depth. */
  library: Record<BlockCode, { dimensions: { depthMm: number } }>
  /** Raise a "preview should highlight cells of this role" signal up
   *  to the modal so the right-rail preview can react. Pass null to
   *  clear. */
  onHighlightSlot?: (role: SlotRole | null) => void
}

function CompositionTab(props: CompositionTabProps) {
  const {
    isCurveMakeup,
    curveRadiusMm,
    curveZone,
    wedgeRequired,
    wedgeFeasible,
    wedgeBodyBlockCode,
    setWedgeBodyBlockCode,
    normalBodyBlockCode,
    setNormalBodyBlockCode,
    baseCourseBlockCode,
    setBaseCourseBlockCode,
    bodyBlockCode,
    setBodyBlockCode,
    topCourseBlockCode,
    setTopCourseBlockCode,
    cornerBlockCode,
    setCornerBlockCode,
    halfBlockCode,
    setHalfBlockCode,
    capBlockCode,
    setCapBlockCode,
    selectableBlocks,
    library,
    onHighlightSlot,
  } = props

  // Convenience: build a pair of handlers that raise / clear the
  // highlight signal for a given role. Each BlockSelect uses these to
  // tell the preview which cells to glow while the user is on it.
  const highlightHandlers = (role: SlotRole) => ({
    onHighlight: () => onHighlightSlot?.(role),
    onUnhighlight: () => onHighlightSlot?.(null),
  })

  // Series-lock: every slot (body included) is filtered to blocks
  // matching the active "wall depth". The body's depth IS the source
  // of truth — the explicit "Wall depth" picker just lets the user
  // change it without having to know that the body block secretly
  // controls the series of every other slot.
  const bodyDepthMm = library[bodyBlockCode]?.dimensions.depthMm
  const availableDepths = useMemo<number[]>(() => {
    const set = new Set<number>()
    for (const code of selectableBlocks) {
      const d = library[code]?.dimensions.depthMm
      if (typeof d === 'number') set.add(d)
    }
    return Array.from(set).sort((a, b) => a - b)
  }, [selectableBlocks, library])
  const slotSelectableBlocks = useMemo<BlockCode[]>(() => {
    if (bodyDepthMm === undefined) return selectableBlocks
    return selectableBlocks.filter(
      (code) => library[code]?.dimensions.depthMm === bodyDepthMm,
    )
  }, [selectableBlocks, bodyDepthMm, library])

  // Changing the wall depth: swap the body block to one at the new
  // depth. Prefers a block tagged with the 'body' role at that depth;
  // falls back to the first block at that depth. The downstream slot
  // pickers refilter automatically; the resolveCourseBlocks healer
  // depth-scopes any saved corner/half/base codes that no longer
  // match. Net effect: the user picks a depth, the wall composition
  // re-anchors to that series without manual fixups.
  const handleWallDepthChange = (depthMm: number) => {
    if (depthMm === bodyDepthMm) return
    const candidates = selectableBlocks.filter(
      (code) => library[code]?.dimensions.depthMm === depthMm,
    )
    if (candidates.length === 0) return
    // Anything in the library with a 'body' role at this depth is the
    // ideal pick; without a role-aware lookup at this layer we use the
    // first match, which is alphabetical-by-code (deterministic).
    setBodyBlockCode(candidates[0])
  }

  return (
    <div className="max-w-3xl space-y-5">
      {isCurveMakeup && (
        <section>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-400 mb-3">
            Curve body block
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div
              className={`p-3 border rounded-lg ${
                wedgeRequired
                  ? 'border-beme-500/60 bg-ink-900'
                  : 'border-ink-600 bg-ink-900/40 opacity-50'
              }`}
            >
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-semibold text-ink-200">Wedge (20.03CW)</span>
                <span
                  className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
                    wedgeRequired
                      ? 'bg-beme-500 text-black'
                      : 'bg-ink-700 text-ink-400'
                  }`}
                >
                  {wedgeRequired ? 'Active' : 'Disabled'}
                </span>
              </div>
              <BlockSelect
                value={wedgeBodyBlockCode}
                onChange={setWedgeBodyBlockCode}
                options={selectableBlocks}
                disabled={!wedgeRequired}
                label="Wedge body block"
              />
              <p className="mt-2 text-[11px] text-ink-400 leading-snug">
                {wedgeRequired
                  ? wedgeFeasible
                    ? `Required for R < ${CURVED_WALL_WEDGE_RADIUS_MM}mm — wedge taper absorbs the curve.`
                    : 'R is below the wedge feasibility floor — closest stock block selected; custom cuts will be flagged.'
                  : `Not applicable at R${Math.round(curveRadiusMm!)}mm — normal blocks fit.`}
              </p>
            </div>
            <div
              className={`p-3 border rounded-lg ${
                !wedgeRequired
                  ? 'border-beme-500/60 bg-ink-900'
                  : 'border-ink-600 bg-ink-900/40 opacity-50'
              }`}
            >
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-semibold text-ink-200">Normal (20.48)</span>
                <span
                  className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
                    !wedgeRequired
                      ? 'bg-beme-500 text-black'
                      : 'bg-ink-700 text-ink-400'
                  }`}
                >
                  {!wedgeRequired ? 'Active' : 'Disabled'}
                </span>
              </div>
              <BlockSelect
                value={normalBodyBlockCode}
                onChange={setNormalBodyBlockCode}
                options={selectableBlocks}
                disabled={wedgeRequired}
                label="Normal body block"
              />
              <p className="mt-2 text-[11px] text-ink-400 leading-snug">
                {!wedgeRequired
                  ? curveZone === 'cut'
                    ? `Active at R${Math.round(curveRadiusMm!)}mm — cut at the back of each block (called out in assumptions).`
                    : `Active at R${Math.round(curveRadiusMm!)}mm — stock blocks fit without cuts.`
                  : `Not applicable below R${CURVED_WALL_WEDGE_RADIUS_MM}mm — wedge required.`}
              </p>
            </div>
          </div>
        </section>
      )}

      {isCurveMakeup && wedgeRequired && (
        <div className="p-3 rounded-lg border border-amber-500/40 bg-amber-500/10 text-xs text-amber-200">
          Wedge walls (20.03CW) use a single stacked-wedge composition. Base / Top / End
          termination pickers below don't apply.
        </div>
      )}

      <div
        className={`space-y-4 ${
          isCurveMakeup && wedgeRequired
            ? 'opacity-40 pointer-events-none select-none'
            : ''
        }`}
      >
        {/* ── Wall depth ────────────────────────────────────────────
            Inline at the top — small dropdown + library link on one
            line. Sets the series for every slot below. */}
        {!isCurveMakeup && availableDepths.length > 0 && (
          <div className="flex items-center gap-3 flex-wrap">
            <label className="text-xs font-semibold uppercase tracking-wide text-ink-400">
              Wall depth
            </label>
            <select
              value={bodyDepthMm ?? ''}
              onChange={(e) => handleWallDepthChange(Number(e.target.value))}
              className="px-3 py-1.5 rounded-lg border border-ink-600 bg-ink-900 text-ink-50 text-sm"
            >
              {availableDepths.map((d) => (
                <option key={d} value={d}>
                  {d}mm
                </option>
              ))}
            </select>
            <Link
              to="/library"
              target="_blank"
              rel="noopener noreferrer"
              className="text-[11px] text-beme-400 hover:text-beme-300 underline ml-auto"
            >
              Manage depths ↗
            </Link>
          </div>
        )}

        {/* ── Block pickers ─────────────────────────────────────────
            Single 2-column grid, ordered bottom → top of wall on the
            left column, end terminations on the right. Reads as the
            wall's actual structure:
              Base    →   Full end
              Body    →   Half end
              Top     →   Cap (optional)
            Bottom-to-top on the left mirrors how a mason lays the
            courses; the right column groups the "horizontal" decisions
            (how ends terminate, what trim caps the wall). No section
            headers — labels carry the meaning, fewer rows to scroll. */}
        {!isCurveMakeup && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <BlockSelect
              label="Base course (bottom)"
              value={baseCourseBlockCode}
              onChange={setBaseCourseBlockCode}
              options={slotSelectableBlocks}
              roleColor={ROLE_COLORS.base}
              {...highlightHandlers('base')}
            />
            <BlockSelect
              label="Full end (corner)"
              value={cornerBlockCode}
              onChange={setCornerBlockCode}
              options={slotSelectableBlocks}
              roleColor={ROLE_COLORS.corner}
              {...highlightHandlers('corner')}
            />
            <BlockSelect
              label="Body course"
              value={bodyBlockCode}
              onChange={setBodyBlockCode}
              options={slotSelectableBlocks}
              roleColor={ROLE_COLORS.body}
              {...highlightHandlers('body')}
            />
            <BlockSelect
              label="Half end (free ends)"
              value={halfBlockCode}
              onChange={setHalfBlockCode}
              options={slotSelectableBlocks}
              roleColor={ROLE_COLORS.half}
              {...highlightHandlers('half')}
            />
            <BlockSelect
              label="Top course"
              value={topCourseBlockCode}
              onChange={setTopCourseBlockCode}
              options={slotSelectableBlocks}
              roleColor={ROLE_COLORS.top}
              {...highlightHandlers('top')}
            />
            <BlockSelect
              label="Cap tile (optional)"
              value={capBlockCode}
              onChange={setCapBlockCode}
              options={slotSelectableBlocks}
              allowEmpty
              roleColor={ROLE_COLORS.cap}
              {...highlightHandlers('cap')}
            />
          </div>
        )}

        {/* Curve makeups split Body into wedge/normal pickers above,
            so only Base / Top / Full end / Half end / Cap remain. */}
        {isCurveMakeup && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <BlockSelect
              label="Base course (bottom)"
              value={baseCourseBlockCode}
              onChange={setBaseCourseBlockCode}
              options={slotSelectableBlocks}
              roleColor={ROLE_COLORS.base}
              {...highlightHandlers('base')}
            />
            <BlockSelect
              label="Full end (corner)"
              value={cornerBlockCode}
              onChange={setCornerBlockCode}
              options={slotSelectableBlocks}
              roleColor={ROLE_COLORS.corner}
              {...highlightHandlers('corner')}
            />
            <BlockSelect
              label="Top course"
              value={topCourseBlockCode}
              onChange={setTopCourseBlockCode}
              options={slotSelectableBlocks}
              roleColor={ROLE_COLORS.top}
              {...highlightHandlers('top')}
            />
            <BlockSelect
              label="Half end (free ends)"
              value={halfBlockCode}
              onChange={setHalfBlockCode}
              options={slotSelectableBlocks}
              roleColor={ROLE_COLORS.half}
              {...highlightHandlers('half')}
            />
            <BlockSelect
              label="Cap tile (optional)"
              value={capBlockCode}
              onChange={setCapBlockCode}
              options={slotSelectableBlocks}
              allowEmpty
              roleColor={ROLE_COLORS.cap}
              {...highlightHandlers('cap')}
            />
          </div>
        )}
      </div>

      {/* Block-library shortcut. The workspace no longer carries a
          BlockLibraryPanel in the right rail; anyone who needs a block
          that isn't in the dropdowns above jumps to the material library
          page from here. Open in a new tab so the in-progress estimate
          doesn't get unloaded. */}
      <p className="text-[11px] text-ink-500 pt-1">
        Need a block that isn't listed?{' '}
        <Link
          to="/library"
          target="_blank"
          rel="noopener noreferrer"
          className="text-beme-400 hover:text-beme-300 underline"
        >
          Manage blocks in the material library ↗
        </Link>
      </p>
    </div>
  )
}

// ---------- Tab: Course Pattern ----------

interface PatternTabProps {
  coursePattern: CourseBand[]
  hasCoursePattern: boolean
  patternTotalHeight: number
  patternTotalCourses: number
  library: Record<BlockCode, { dimensions: { heightMm: number; widthMm: number; depthMm: number } }>
  selectableBlocks: BlockCode[]
  addBand: () => void
  updateBand: (i: number, patch: Partial<CourseBand>) => void
  removeBand: (i: number) => void
  moveBand: (i: number, dir: -1 | 1) => void
  convertCurrentToBands: () => void
  clearCoursePattern: () => void
  hasOverrides: boolean
}

function PatternTab(props: PatternTabProps) {
  const {
    coursePattern,
    hasCoursePattern,
    patternTotalHeight,
    patternTotalCourses,
    library,
    selectableBlocks,
    addBand,
    updateBand,
    removeBand,
    moveBand,
    convertCurrentToBands,
    clearCoursePattern,
    hasOverrides,
  } = props

  if (!hasCoursePattern) {
    return (
      <div className="max-w-2xl mx-auto py-12 text-center">
        <div className="text-5xl mb-4 select-none">▦</div>
        <h3 className="text-base font-semibold text-ink-100 mb-2">
          Build the wall as a stack of bands
        </h3>
        <p className="text-sm text-ink-400 mb-6 max-w-md mx-auto leading-relaxed">
          For walls with mixed-height courses — e.g.{' '}
          <span className="font-mono text-ink-200">4 × 20.48</span> then{' '}
          <span className="font-mono text-ink-200">2 × 20.71</span> repeating — the
          flat Height field can't hit the right wall height because 20.71 courses
          are only 100 mm tall (not 200 mm).
        </p>
        <p className="text-sm text-ink-400 mb-6 max-w-md mx-auto leading-relaxed">
          Spelling out bands fixes the math. The Height field on Basics will lock
          and show the summed pattern height.
        </p>
        <div className="flex justify-center gap-3 flex-wrap">
          <button
            onClick={convertCurrentToBands}
            className="px-4 py-2 rounded-lg bg-beme-500/15 border border-beme-500/40 text-beme-300 hover:bg-beme-500/25 text-sm font-medium transition-colors"
          >
            Convert this wall to a pattern
          </button>
          <button
            onClick={addBand}
            className="px-4 py-2 rounded-lg border border-ink-600 text-ink-200 hover:bg-ink-700 text-sm transition-colors"
          >
            + Add band from scratch
          </button>
        </div>
      </div>
    )
  }

  return (
    // The wall preview now lives in the modal's right rail (visible on
    // every tab), so this tab is the band editor only — it can use the
    // full content width without competing for space.
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <div>
          <h3 className="text-sm font-semibold text-ink-100">Bands (bottom → top)</h3>
          <p className="text-[11px] text-ink-400 mt-0.5 font-mono">
            {patternTotalCourses} courses · {patternTotalHeight} mm total
          </p>
        </div>
        <button
          onClick={clearCoursePattern}
          className="text-xs text-rose-400 hover:text-rose-300 hover:underline"
        >
          Clear pattern
        </button>
      </div>

      <div className="flex-1 overflow-y-auto space-y-2 pr-1">
        {coursePattern.map((band, i) => {
          const moduleH = moduleHeightForBand(band, library)
          return (
            <div
              key={i}
              className="flex items-center gap-2 p-2 rounded-lg border border-ink-600 bg-ink-900/60"
            >
                <span
                  className="inline-block w-3 h-3 rounded-sm flex-shrink-0 ring-1 ring-black/30"
                  style={{ backgroundColor: bandColor(band.blockCode) }}
                  aria-hidden
                />
                <span className="text-ink-500 font-mono text-xs w-6 text-right">
                  {i + 1}
                </span>
                <input
                  type="number"
                  min="1"
                  value={band.count}
                  onChange={(e) =>
                    updateBand(i, {
                      count: Math.max(1, parseInt(e.target.value || '1', 10)),
                    })
                  }
                  className="w-16 px-2 py-1 border border-ink-600 rounded text-sm bg-ink-900"
                />
                <span className="text-ink-500 text-xs">×</span>
                <select
                  value={band.blockCode}
                  onChange={(e) =>
                    updateBand(i, { blockCode: e.target.value as BlockCode })
                  }
                  className="px-2 py-1 border border-ink-600 rounded text-sm bg-ink-900 min-w-0 flex-1"
                >
                  {selectableBlocks.map((code) => (
                    <option key={code} value={code}>
                      {blockLabel(code)}
                    </option>
                  ))}
                </select>
                <span className="text-[11px] text-ink-400 font-mono w-16 text-right">
                  {band.count * moduleH}mm
                </span>
                <div className="flex items-center gap-0.5 ml-1">
                  <button
                    onClick={() => moveBand(i, -1)}
                    disabled={i === 0}
                    className="text-ink-400 hover:text-ink-200 disabled:opacity-30 disabled:cursor-not-allowed text-xs px-1"
                    aria-label="Move band up"
                  >
                    ▲
                  </button>
                  <button
                    onClick={() => moveBand(i, 1)}
                    disabled={i === coursePattern.length - 1}
                    className="text-ink-400 hover:text-ink-200 disabled:opacity-30 disabled:cursor-not-allowed text-xs px-1"
                    aria-label="Move band down"
                  >
                    ▼
                  </button>
                  <button
                    onClick={() => removeBand(i)}
                    className="text-rose-400 hover:text-rose-300 text-base px-2"
                    aria-label="Remove band"
                  >
                    ×
                  </button>
                </div>
              </div>
            )
          })}
        </div>

        <button
          onClick={addBand}
          className="mt-3 text-sm px-3 py-2 rounded-lg border border-dashed border-ink-600 text-beme-300 hover:bg-ink-700/50 transition-colors"
        >
          + Add band
        </button>

      {hasOverrides && (
        <p className="mt-3 text-[11px] text-amber-300 leading-snug">
          Note: per-course overrides on the Advanced tab still apply on top of this
          pattern. Clear them there if you don't want them.
        </p>
      )}
    </div>
  )
}

// ---------- Visual stack preview ----------
// Colour palette + bandColor + buildBlockColorMap moved to
// src/lib/blockColors.ts so the 3D view can use the same distinct-colour
// assignment as the 2D wall preview.

/**
 * Tiny legend under the preview that maps each colour swatch to its block
 * code. Walks the same per-course resolver as the preview so any
 * series-range or per-course overrides land in the legend too — the
 * legend always shows exactly the codes you can see in the preview.
 */
function PreviewLegend({
  bands,
  resolveForCourse,
  bondType,
  colorMap,
}: {
  bands: CourseBand[]
  resolveForCourse: (courseNumber: number) => {
    body: BlockCode
    corner: BlockCode
    half: BlockCode
  }
  bondType: BondType
  /** Distinct-colour-per-code map. When provided, codes get unique
   *  palette slots so the legend can't show two near-identical hues.
   *  Falls back to the standalone `bandColor()` if a code isn't in
   *  the map (shouldn't happen for the wall preview which collects
   *  the same codes the legend lists). */
  colorMap?: Map<string, string>
}) {
  // Walk every course in the preview, collect distinct body / corner /
  // half codes via the resolver. Role labels reflect the first time a
  // code appears (body wins over corner if the same code is used as
  // both, since that's the more common usage on the wall).
  const items: { code: BlockCode; role: string }[] = []
  const seen = new Set<BlockCode>()
  function push(code: BlockCode, role: string) {
    if (!code || seen.has(code)) return
    seen.add(code)
    items.push({ code, role })
  }
  let courseNum = 0
  for (const b of bands) {
    if (b.count <= 0) continue
    for (let i = 0; i < b.count; i++) {
      courseNum++
      const r = resolveForCourse(courseNum)
      push(r.body, 'body')
      push(r.corner, 'corner')
      if (bondType === 'stretcher') push(r.half, 'half end')
    }
  }

  if (items.length === 0) return null
  return (
    // flex-shrink-0 so this band always takes its natural height in the
    // aside's flex column — the preview above gets `flex-1` and would
    // otherwise compete with us and force overlap.
    <div className="mt-3 pt-3 border-t border-ink-700/60 flex-shrink-0">
      <div className="text-[10px] uppercase tracking-wide text-ink-500 mb-2 font-semibold">
        Legend
      </div>
      <div className="flex flex-col gap-1">
        {items.map((it) => (
          <div
            key={it.code}
            className="flex items-center gap-2 text-[11px] min-w-0"
          >
            <span
              className="inline-block w-3.5 h-3.5 rounded-sm flex-shrink-0 ring-1 ring-black/40"
              style={{ backgroundColor: colorMap?.get(it.code) ?? bandColor(it.code) }}
              aria-hidden
            />
            <span className="text-ink-200 font-mono truncate">{it.code}</span>
            <span className="text-ink-500 ml-auto text-[10px]">{it.role}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

interface CoursePatternPreviewProps {
  bands: CourseBand[]
  library: Record<BlockCode, { dimensions: { heightMm: number; widthMm: number; depthMm: number } }>
  bondType: BondType
  /** Resolves the body / corner / half block codes for a given 1-indexed
   *  course number. Lets the modal apply courseSeriesRanges and
   *  courseOverrides per course so the preview shows e.g. 30.48 in the
   *  base courses when those courses are series-overridden to 300. */
  resolveForCourse: (courseNumber: number) => {
    body: BlockCode
    corner: BlockCode
    half: BlockCode
  }
  /** Distinct-colour-per-code map shared with the legend so cells and
   *  swatches match. Falls back to the standalone `bandColor()` if a
   *  code is missing from the map. */
  colorMap?: Map<string, string>
  /** When set, cells whose role matches glow with a bright ring; cells
   *  of other roles dim to ~40% opacity so the highlighted role pops
   *  visually. Driven by the composition tab's slot-picker focus /
   *  hover state. */
  highlightedSlot?: SlotRole | null
}

/**
 * Renders a small wall-section diagram showing the actual bond pattern
 * (stretcher = even courses offset by half a block, stack = all courses
 * aligned) with each block tinted by its block code. Mortar joints are
 * rendered as thin dark lines between blocks and between courses.
 *
 * The diagram is a representative section ~4 full-block widths wide; the
 * exact wall length isn't shown because the preview lives in a narrow
 * rail. What matters here is the BOND pattern and the colour distribution
 * (where the height-makeup courses sit, etc.).
 */
function CoursePatternPreview({
  bands,
  library,
  bondType,
  resolveForCourse,
  colorMap,
  highlightedSlot,
}: CoursePatternPreviewProps) {
  // colorMap is no longer used for cell tinting — every cell now
  // takes its hue from its ROLE (body / corner / half / base / top /
  // cap) so the user can trace slot picker → role colour → preview
  // region. Kept on the prop bag for backwards compatibility with the
  // legend, which still maps code → swatch for code-by-code lookup.
  void colorMap
  void bandColor
  // Per-cell colour comes from the cell's role; per-cell highlight is
  // a brighter ring + full opacity when the user is focused on that
  // role's picker (the rest dim). Builds a small helper used by every
  // cell in the loop below.
  const styleFor = (role: SlotRole) => {
    const base = ROLE_COLORS[role]
    const isFocused = highlightedSlot === role
    const otherFocused = highlightedSlot !== null && !isFocused
    return {
      backgroundColor: base,
      opacity: otherFocused ? 0.35 : 1,
      // Ring sits inside the cell (boxShadow inset) so it never
      // bleeds into neighbours. ~2px bright ring is visible against
      // both light and dark cell hues.
      boxShadow: isFocused
        ? 'inset 0 0 0 2px #FDE68A, 0 0 8px rgba(253, 230, 138, 0.6)'
        : undefined,
      transition: 'opacity 120ms ease, box-shadow 120ms ease',
    }
  }
  const visible = bands.filter((b) => b.count > 0)
  // Expand the band list into a flat per-course block-code array so we
  // can lay out each course independently — needed because course N+1
  // might use a different block code from course N (e.g. 20.48 → 20.71).
  // Each course's body code starts from its band, but the eventual
  // rendered code comes from resolveForCourse() — which lets series
  // ranges and per-course overrides take effect.
  const courses: BlockCode[] = []
  for (const band of visible) {
    for (let i = 0; i < band.count; i++) {
      const courseNum = courses.length + 1
      const resolvedBody = resolveForCourse(courseNum).body
      courses.push(resolvedBody)
    }
  }
  const totalHeight = courses.reduce(
    (s, code) => s + ((library[code]?.dimensions.heightMm ?? 190) + 10),
    0
  )

  if (totalHeight === 0 || courses.length === 0) {
    return (
      <div className="flex items-center justify-center min-h-[300px] text-xs text-ink-500 italic border-2 border-dashed border-ink-700 rounded-lg p-6 text-center">
        Add a band to see the wall preview here.
      </div>
    )
  }

  // Course-height per code (block face height + 10mm mortar). Used both
  // for total-height math above and for the per-course row sizing below.
  const heightOf = (code: BlockCode) =>
    (library[code]?.dimensions.heightMm ?? 190) + 10
  // Course-width per code (block face width + 10mm mortar) — so 20.03CW
  // (190+10 = 200mm modular) renders half as wide as 20.48 (390+10 =
  // 400mm modular). Lets wedge curves draw with square faces instead of
  // the 2:1 horizontal rectangle 20.48 uses.
  const widthOf = (code: BlockCode) =>
    (library[code]?.dimensions.widthMm ?? 390) + 10

  // Representative number of BODY blocks across the wall section. The
  // end-termination columns sit either side. We compute each course's
  // actual modular width below (based on its body block code) and use
  // the MAX across all courses as the wall's representative width — so
  // a wall with wedge bodies renders narrower than one with standard
  // bodies, and the block faces always show at their real aspect.
  // Corner / half widths come per-course from resolveForCourse so a
  // series-range override (e.g. 30.01 corner) contributes its own
  // width rather than the makeup-level default.
  const BLOCKS_ACROSS = 4
  const bodyWidthOf = (code: BlockCode) => widthOf(code)

  // Per-course modular width: even (stretcher) rows = halfW + (n+1)·bodyW + halfW,
  // odd / stack rows = cornerW + n·bodyW + cornerW. We take the max so
  // the wall preview locks to the widest course's width.
  const courseModularWidths = courses.map((code, idx) => {
    const courseNum = idx + 1
    const res = resolveForCourse(courseNum)
    const isEven = courseNum % 2 === 0
    const bodyW = bodyWidthOf(code)
    if (bondType === 'stretcher' && isEven) {
      const halfW = widthOf(res.half)
      return halfW + (BLOCKS_ACROSS + 1) * bodyW + halfW
    }
    const cornerW = widthOf(res.corner)
    return cornerW + BLOCKS_ACROSS * bodyW + cornerW
  })
  const REPRESENTATIVE_WIDTH_MM = Math.max(...courseModularWidths, 1)
  const wallAspect = `${REPRESENTATIVE_WIDTH_MM} / ${totalHeight}`

  // Boundary labels for the side ruler — total mm at top, then the
  // running total at each band BOUNDARY (not each course, to avoid label
  // crowding on tall walls). Bottom is always 0.
  // labels[0] = totalHeight (top of wall)
  // labels[i+1] = bottom of the i-th band from the top (= top of the
  //               (i+1)-th band from the top), counting bands top-down.
  // labels[N] = 0 (bottom of wall)
  const topDownBands = [...visible].reverse()
  const labels: number[] = [totalHeight]
  let running = totalHeight
  for (const band of topDownBands) {
    running -= band.count * ((library[band.blockCode]?.dimensions.heightMm ?? 190) + 10)
    labels.push(running)
  }

  return (
    // h-full + min-h-[280px] sets the slot we can scale within;
    // items-center vertically centres the wall element so when its
    // aspect-ratio + maxWidth combo make it shorter than the slot
    // (common for curve walls with thin courses, or any wall with a
    // very tall slot), the empty space splits evenly above + below
    // rather than dumping the wall against the top edge and leaving
    // a phantom empty grid below it. justify-start keeps the wall +
    // labels grouped on the left so the legend below them aligns to
    // the same gutter.
    <div className="flex h-full min-h-[280px] items-center justify-start">
      {/* Wall section + absolute-positioned ruler labels.

          aspectRatio = REPRESENTATIVE_WIDTH_MM / totalHeight so the wall
          element scales uniformly within its container — a 4000mm wall
          looks taller than a 2400mm wall, and every 20.48 block face
          renders at its real 400:200 (2:1) proportion. maxH 100% caps
          tall walls to the parent slot; maxW 220px caps short/wide
          walls so they don't blow past the rail width.

          Ruler labels are absolutely positioned relative to this same
          element so they always sit at the right vertical position
          regardless of the wall's actual rendered height. */}
      <div
        style={{
          aspectRatio: wallAspect,
          width: '100%',
          maxWidth: '200px',
          maxHeight: '100%',
        }}
        className="relative shrink-0"
      >
        <div className="flex flex-col-reverse h-full w-full rounded-md overflow-hidden border-2 border-ink-600 bg-ink-950 shadow-inner">
        {courses.map((_code, courseIdx) => {
          // courseIdx 0 = bottom of wall (base). flex-col-reverse means
          // we render the array in normal order but DOM/visual order is
          // reversed so course[0] sits at the bottom of the column.
          const courseNum = courseIdx + 1 // 1-indexed
          // Resolve this course's actual body / corner / half codes —
          // honours courseSeriesRanges (300 series on bottom courses,
          // etc.) and courseOverrides per course. The band's own code
          // is the starting point; resolveForCourse may swap it.
          const resolved = resolveForCourse(courseNum)
          const bodyCode = resolved.body
          const cornerCode = resolved.corner
          const halfCode = resolved.half
          // Height of the course depends on the RESOLVED body, not the
          // band code — a 300-series-overridden course uses 30.48 which
          // is still 200mm modular, but if the override was a 30.71 it
          // would be 100mm. Keeps the visual proportional to reality.
          const h = heightOf(bodyCode)
          const pct = (h / totalHeight) * 100
          const isEven = courseNum % 2 === 0
          const useHalves = bondType === 'stretcher' && isEven

          // Build the cells for this course.
          //   * Each cell's WIDTH is the block's modular face width (face
          //     + 10mm mortar) as a percentage of REPRESENTATIVE_WIDTH_MM,
          //     so a 20.03CW cell (200mm) renders half as wide as a
          //     20.48 cell (400mm). [from HEAD's bodyWidthOf approach]
          //   * Each cell's COLOUR is from the PER-COURSE resolved body /
          //     corner / half codes — so series-range overrides (e.g.
          //     30.01 corners on the base 5 courses) show up. [from the
          //     series-range / per-course-override resolver]
          const bodyW = bodyWidthOf(bodyCode)
          const cornerW = widthOf(cornerCode)
          const halfW = widthOf(halfCode)
          const toPct = (w: number) => (w / REPRESENTATIVE_WIDTH_MM) * 100
          // Body cells get a per-course role: course 1 = 'base', last
          // course = 'top', everything in between = 'body'. End cells
          // are 'corner' or 'half' depending on the bond rule. Cap is
          // emitted separately as a stripe above the wall body.
          const bodyRole: SlotRole =
            courseNum === 1
              ? 'base'
              : courseNum === courses.length
                ? 'top'
                : 'body'
          const cells: {
            widthPct: number
            role: SlotRole
            label: string
          }[] = []
          if (useHalves) {
            // Stretcher even: half end on the LEFT, then BLOCKS_ACROSS
            // body, then full corner on the RIGHT. Real brick walls
            // typically place a single half-block at one end of each
            // offset course rather than mirroring halves on both ends
            // — the half on one side is what shifts the body grid by
            // half a block, producing the running-bond stagger; a
            // second half on the other side would just absorb the same
            // shift back. Visual width is ~half a block narrower than
            // the odd row, which reads as 'this row is offset' to the
            // eye. justify-center on the row keeps the offset
            // symmetric within the wall envelope.
            cells.push({ widthPct: toPct(halfW), role: 'half', label: halfCode })
            for (let i = 0; i < BLOCKS_ACROSS; i++) {
              cells.push({ widthPct: toPct(bodyW), role: bodyRole, label: bodyCode })
            }
            cells.push({ widthPct: toPct(cornerW), role: 'corner', label: cornerCode })
          } else {
            // Stack bond OR stretcher odd: full end + N body + full end.
            cells.push({ widthPct: toPct(cornerW), role: 'corner', label: cornerCode })
            for (let i = 0; i < BLOCKS_ACROSS; i++) {
              cells.push({ widthPct: toPct(bodyW), role: bodyRole, label: bodyCode })
            }
            cells.push({ widthPct: toPct(cornerW), role: 'corner', label: cornerCode })
          }

          return (
            <div
              key={courseIdx}
              style={{ flexBasis: `${pct}%`, minHeight: 0 }}
              // Center the cells so a course whose total modular width is
              // less than REPRESENTATIVE_WIDTH_MM (e.g. a row using 200mm
              // corners while the widest course uses 400mm bodies) sits
              // symmetrically in the wall section rather than dangling
              // off to the right. Matches real masonry where a step-in
              // happens at both ends, not just one.
              className="flex w-full border-b border-black/40 last:border-b-0 justify-center"
              title={`Course ${courseNum}: ${bodyCode} body (${h}mm modular)${useHalves ? ` · ${halfCode} halves at ends` : ` · ${cornerCode} at ends`}`}
            >
              {cells.map((c, i) => (
                <div
                  key={i}
                  style={{ width: `${c.widthPct}%`, ...styleFor(c.role) }}
                  className="border-r border-black/30 last:border-r-0"
                  title={`${ROLE_LABELS[c.role]} — ${c.label}`}
                />
              ))}
            </div>
          )
        })}
        </div>

        {/* Band-boundary labels float to the right of the wall section.
            Each label is positioned by % from the bottom of the wall, so
            it always sits at the right vertical position regardless of
            how big the wall actually rendered. translateY(50%) centres
            the label vertically on its boundary line. */}
        {labels.map((mm, i) => (
          <div
            key={i}
            className="absolute left-full ml-1.5 text-[10px] text-ink-400 font-mono whitespace-nowrap leading-none pointer-events-none"
            style={{
              bottom: `${(mm / totalHeight) * 100}%`,
              transform: 'translateY(50%)',
            }}
          >
            {mm}mm
          </div>
        ))}
      </div>
    </div>
  )
}

// ---------- Tab: Advanced ----------

interface AdvancedTabProps {
  courseOverrides: CourseOverride[]
  addOverride: () => void
  updateOverride: (i: number, patch: Partial<CourseOverride>) => void
  removeOverride: (i: number) => void
  seriesRanges: CourseSeriesRange[]
  addSeriesRange: () => void
  updateSeriesRange: (i: number, patch: Partial<CourseSeriesRange>) => void
  removeSeriesRange: (i: number) => void
  selectableBlocks: BlockCode[]
}

function AdvancedTab(props: AdvancedTabProps) {
  const {
    courseOverrides,
    addOverride,
    updateOverride,
    removeOverride,
    seriesRanges,
    addSeriesRange,
    updateSeriesRange,
    removeSeriesRange,
    selectableBlocks,
  } = props

  return (
    <div className="max-w-3xl space-y-8">
      <section>
        <h3 className="text-sm font-semibold text-ink-100 mb-2">
          Per-course overrides
        </h3>
        <p className="text-xs text-ink-400 mb-3 leading-relaxed">
          Override the block used on a specific course (e.g. an intermediate 20.20
          bond beam mid-wall). Indexed from the base course (course 1 = base).
        </p>
        <div className="space-y-2">
          {courseOverrides.map((override, i) => (
            <div
              key={i}
              className="flex items-center gap-2 p-2 rounded-lg border border-ink-600 bg-ink-900/60 text-sm flex-wrap"
            >
              <span className="text-ink-400">Course</span>
              <input
                type="number"
                min="1"
                value={override.courseNumber}
                onChange={(e) =>
                  updateOverride(i, {
                    courseNumber: parseInt(e.target.value || '1', 10),
                  })
                }
                className="w-16 px-2 py-1 border border-ink-600 rounded bg-ink-900"
              />
              <span className="text-ink-400">uses</span>
              <select
                value={override.blockCode}
                onChange={(e) =>
                  updateOverride(i, { blockCode: e.target.value as BlockCode })
                }
                className="px-2 py-1 border border-ink-600 rounded bg-ink-900 flex-1 min-w-0"
              >
                {selectableBlocks.map((code) => (
                  <option key={code} value={code}>
                    {blockLabel(code)}
                  </option>
                ))}
              </select>
              <button
                onClick={() => removeOverride(i)}
                className="text-rose-400 hover:text-rose-300 text-base px-2"
                aria-label="Remove override"
              >
                ×
              </button>
            </div>
          ))}
        </div>
        <button
          onClick={addOverride}
          className="mt-3 text-sm px-3 py-2 rounded-lg border border-dashed border-ink-600 text-beme-300 hover:bg-ink-700/50 transition-colors"
        >
          + Add override
        </button>
      </section>

      <section>
        <h3 className="text-sm font-semibold text-ink-100 mb-2">
          Course-series ranges
        </h3>
        <p className="text-xs text-ink-400 mb-3 leading-relaxed">
          Use a different block series for a range of courses — e.g. 300-series for the
          bottom 5 courses, 200-series above. Each field left on Default falls back to
          the main composition picks.
        </p>
        <div className="space-y-3">
          {seriesRanges.map((range, i) => (
            <RangeRow
              key={i}
              range={range}
              selectableBlocks={selectableBlocks}
              onChange={(patch) => updateSeriesRange(i, patch)}
              onRemove={() => removeSeriesRange(i)}
            />
          ))}
        </div>
        <button
          onClick={addSeriesRange}
          className="mt-3 text-sm px-3 py-2 rounded-lg border border-dashed border-ink-600 text-beme-300 hover:bg-ink-700/50 transition-colors"
        >
          + Add series range
        </button>
      </section>
    </div>
  )
}

// ---------- Selected pier inspector ----------

interface SelectedPierInspectorProps {
  selectedPier: Pier
  pierMakeups: PierMakeup[]
  onReassign?: (pierId: string, pierMakeupId: string) => void
  onDelete?: (pierId: string) => void
  onDeselect?: () => void
}

/**
 * Inline editor for the currently-selected pier on the canvas, rendered
 * directly under the matching pier-type card in the sidebar. Replaces the
 * old floating "selected pier" banner — this lives in the right rail so
 * pier editing feels like wall editing.
 *
 * Freestanding piers get a Height input (per-instance). Tied piers show
 * a hint that height is inherited from the host wall.
 */
function SelectedPierInspector({
  selectedPier,
  pierMakeups,
  onReassign,
  onDelete,
  onDeselect,
}: SelectedPierInspectorProps) {
  return (
    <div
      className="p-2.5 rounded-b-lg border border-t-0 border-beme-500 bg-beme-500/5 flex flex-col gap-2"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-beme-300">
        Selected pier
      </div>
      <div className="text-[11px] text-ink-400 italic">
        {selectedPier.type === 'freestanding'
          ? `Freestanding pier · ${selectedPier.heightMm}mm. Click Edit on the type above to change the height.`
          : 'Tied pier — height inherits the host wall. Edit the wall to change it.'}
      </div>

      {pierMakeups.length > 1 && onReassign && (
        <label className="flex items-center gap-2 text-xs text-ink-200">
          <span className="w-14 flex-shrink-0">Type</span>
          <select
            value={selectedPier.pierMakeupId ?? ''}
            onChange={(e) => onReassign(selectedPier.id, e.target.value)}
            className="flex-1 min-w-0 px-2 py-1 border border-ink-600 rounded text-xs bg-ink-900 text-ink-50"
          >
            {pierMakeups.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </label>
      )}

      <div className="flex gap-2 mt-1">
        {onDelete && (
          <button
            onClick={() => onDelete(selectedPier.id)}
            className="px-2 py-1 rounded border border-rose-500/40 text-xs text-rose-300 hover:bg-rose-500/10 transition-colors"
          >
            Delete pier
          </button>
        )}
        {onDeselect && (
          <button
            onClick={onDeselect}
            className="px-2 py-1 rounded border border-ink-600 text-xs text-ink-300 hover:bg-ink-700 transition-colors"
          >
            Deselect
          </button>
        )}
      </div>
    </div>
  )
}

// ---------- Helpers ----------

interface BlockSelectProps {
  label: string
  value: BlockCode | ''
  onChange: (v: BlockCode | '') => void
  options: (BlockCode | '')[]
  disabled?: boolean
  allowEmpty?: boolean
  /**
   * Optional role colour. When provided, a small filled circle sits
   * before the label in the matching colour — same hue used for that
   * role's cells in the wall preview. Lets the user trace label →
   * dot → preview region without reading any text.
   */
  roleColor?: string
  /**
   * Fires when the user focuses / hovers this picker. The parent
   * raises a "highlight this role in the preview" signal so the
   * matching cells get a glow ring while the user is deciding what
   * block to put in this slot.
   */
  onHighlight?: () => void
  onUnhighlight?: () => void
}

function BlockSelect({
  label,
  value,
  onChange,
  options,
  disabled,
  allowEmpty,
  roleColor,
  onHighlight,
  onUnhighlight,
}: BlockSelectProps) {
  return (
    <label
      className="text-sm block"
      onMouseEnter={onHighlight}
      onMouseLeave={onUnhighlight}
    >
      <span className="flex items-center gap-1.5 text-ink-300 mb-1.5">
        {roleColor && (
          <span
            className="inline-block w-2.5 h-2.5 rounded-full flex-shrink-0"
            style={{ backgroundColor: roleColor }}
            aria-hidden="true"
          />
        )}
        <span className="min-w-0 truncate">{label}</span>
      </span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as BlockCode | '')}
        disabled={disabled}
        onFocus={onHighlight}
        onBlur={onUnhighlight}
        className="w-full px-3 py-2 border border-ink-600 rounded-lg text-sm bg-ink-900 focus:outline-none focus:border-beme-400 disabled:cursor-not-allowed disabled:bg-ink-800 disabled:text-ink-400"
      >
        {allowEmpty && <option value="">None</option>}
        {options
          .filter((c) => c !== '' || !allowEmpty)
          .map((code) => (
            <option key={code} value={code}>
              {code ? blockLabel(code) : 'None'}
            </option>
          ))}
      </select>
    </label>
  )
}

// ---------- Internal: RangeRow ----------

interface RangeRowProps {
  range: CourseSeriesRange
  selectableBlocks: BlockCode[]
  onChange: (patch: Partial<CourseSeriesRange>) => void
  onRemove: () => void
}

function RangeRow({ range, selectableBlocks, onChange, onRemove }: RangeRowProps) {
  return (
    <div className="p-3 border border-ink-600 rounded-lg bg-ink-900/60">
      <div className="flex items-center gap-2 mb-3 text-sm flex-wrap">
        <span className="text-ink-400">Courses</span>
        <input
          type="number"
          min="1"
          value={range.fromCourse}
          onChange={(e) =>
            onChange({ fromCourse: Math.max(1, parseInt(e.target.value || '1', 10)) })
          }
          className="w-16 px-2 py-1 border border-ink-600 rounded bg-ink-900"
        />
        <span className="text-ink-400">to</span>
        <input
          type="number"
          min="1"
          value={range.toCourse}
          onChange={(e) =>
            onChange({ toCourse: Math.max(1, parseInt(e.target.value || '1', 10)) })
          }
          className="w-16 px-2 py-1 border border-ink-600 rounded bg-ink-900"
        />
        <span className="text-xs text-ink-500">(1 = base course)</span>
        <button
          onClick={onRemove}
          className="ml-auto text-rose-400 hover:text-rose-300 text-base px-2"
          aria-label="Remove range"
        >
          ×
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-xs">
        <RangeFieldPicker
          label="Body"
          value={range.bodyBlockCode}
          options={selectableBlocks}
          onChange={(v) => onChange({ bodyBlockCode: v })}
        />
        <RangeFieldPicker
          label="Corner / full end"
          value={range.cornerBlockCode}
          options={selectableBlocks}
          onChange={(v) => onChange({ cornerBlockCode: v })}
        />
        <RangeFieldPicker
          label="Half-block end (stretcher)"
          value={range.halfBlockCode}
          options={selectableBlocks}
          onChange={(v) => onChange({ halfBlockCode: v })}
        />
        <RangeFieldPicker
          label="Base course (if c1 in range)"
          value={range.baseCourseBlockCode}
          options={selectableBlocks}
          onChange={(v) => onChange({ baseCourseBlockCode: v })}
        />
        <RangeFieldPicker
          label="90 mm height makeup"
          value={range.heightMakeup71BlockCode}
          options={selectableBlocks}
          onChange={(v) => onChange({ heightMakeup71BlockCode: v })}
        />
        <RangeFieldPicker
          label="Corner lead-in (×2 after corner)"
          value={range.cornerLeadInBlockCode}
          options={selectableBlocks}
          onChange={(v) => onChange({ cornerLeadInBlockCode: v })}
        />
      </div>
      {range.cornerLeadInBlockCode && (
        <p className="mt-2 text-[10px] text-ink-500">
          Two {range.cornerLeadInBlockCode} blocks placed between the corner block and
          the body on every course at a corner end.
        </p>
      )}
    </div>
  )
}

interface RangeFieldPickerProps {
  label: string
  value: BlockCode | undefined
  options: BlockCode[]
  onChange: (v: BlockCode | undefined) => void
}

function RangeFieldPicker({ label, value, options, onChange }: RangeFieldPickerProps) {
  return (
    <label className="block">
      <span className="block text-ink-400 mb-0.5">{label}</span>
      <select
        value={value ?? ''}
        onChange={(e) => onChange((e.target.value as BlockCode) || undefined)}
        className="w-full px-2 py-1 border border-ink-600 rounded text-xs bg-ink-900"
      >
        <option value="">Default</option>
        {options.map((code) => (
          <option key={code} value={code}>
            {blockLabel(code)}
          </option>
        ))}
      </select>
    </label>
  )
}

// ---------- Internal: PierTypeEditorModal ----------

interface PierTypeEditorModalProps {
  existing: PierMakeup | null
  /** When creating a NEW pier (existing === null), pre-fill the placement
   *  toggle so the user lands on the right kind without an extra click.
   *  The kind picker at the top of the wall modal uses this to map
   *  "Tied pier" vs "Freestanding pier" into the right initial state.
   *  Ignored when editing an existing pier (its own suggestedPlacement
   *  wins). */
  seedPlacement?: 'tied' | 'freestanding'
  /** When creating a NEW pier (existing === null), lets the user switch
   *  the kind picker back to "Wall" — closes this modal and opens the
   *  wall editor. Hidden when editing existing. */
  onSwitchToWall?: () => void
  /** Mirror of WallTypeEditorModal.onSwitchToCurved — picking Curved in
   *  this pier modal also closes it and activates curve mode. */
  onSwitchToCurved?: () => void
  onSave: (makeup: PierMakeup) => void
  onCancel: () => void
}

/**
 * Editor for a pier type. Same modal pattern + visual rail as the wall-type
 * editor — kept simpler because PierMakeup itself is simpler (name +
 * placement + course pattern, no bond / openings / curve handling).
 *
 * Course pattern: an ordered list of block codes that CYCLES up the pier.
 * For a tied pier built into a 2400mm wall (12 courses), pattern [40.925,
 * 20.01] gives 6× 40.925 + 6× 20.01 alternating. The preview shows the
 * pattern repeating to fill a representative pier height so the user can
 * see what they'll get.
 */
function PierTypeEditorModal({
  existing,
  seedPlacement,
  onSwitchToWall,
  onSwitchToCurved,
  onSave,
  onCancel,
}: PierTypeEditorModalProps) {
  const { library } = useBlockLibrary()

  // Block options for the pier-pattern dropdowns. Pier-tagged blocks
  // appear first (so US users see CMU8 at the top, AU sees 40.925),
  // followed by corner-tagged, then the rest alphabetical. Legacy
  // blocks (e.g. paired tiles like 50.45 that are auto-tallied via
  // Block.pairedWith) are filtered out — they aren't user-picked.
  const blockOptions = useMemo<BlockCode[]>(() => {
    const all = Object.values(library).filter(
      (b) => !b.roles.includes('legacy')
    )
    const pierTagged = all
      .filter((b) => b.roles.includes('pier'))
      .map((b) => b.code)
    const cornerTagged = all
      .filter((b) => !b.roles.includes('pier') && b.roles.includes('corner'))
      .map((b) => b.code)
    const pierSet = new Set(pierTagged)
    const cornerSet = new Set(cornerTagged)
    const rest = all
      .filter((b) => !pierSet.has(b.code) && !cornerSet.has(b.code))
      .map((b) => b.code)
      .sort()
    return [...pierTagged, ...cornerTagged, ...rest]
  }, [library])

  const [name, setName] = useState(existing?.name ?? 'New pier type')
  const [placement, setPlacement] = useState<'tied' | 'freestanding'>(
    existing?.suggestedPlacement ?? seedPlacement ?? 'tied'
  )
  // Seed pattern for a new pier: live library's pier block + corner
  // block (or any sensible region defaults). Existing piers keep their
  // saved pattern. Fallback to AU codes only if the library has
  // nothing tagged.
  const seedPierCode = pickBodyDefault()?.code ?? '20.48'
  const seedCornerCode = pickCornerBlock()?.code ?? '20.01'
  // Use pier-tagged code if there is one (AU 40.925); otherwise body
  // (US/UK use the body block as the pier per Step 3.5).
  const seedPierPrimary =
    Object.values(library).find((b) => b.roles.includes('pier'))?.code ??
    seedPierCode
  const [pattern, setPattern] = useState<BlockCode[]>(
    existing?.coursePattern && existing.coursePattern.length > 0
      ? existing.coursePattern
      : [seedPierPrimary, seedCornerCode]
  )
  // Height for freestanding pier types (in mm). Saving propagates the value
  // to every freestanding pier of this type so the modal is the single
  // editing surface — matches how walls work (edit the type's height, every
  // wall of that type updates). Tied piers ignore this and inherit the
  // host wall's height.
  const [heightMm, setHeightMm] = useState<number>(existing?.heightMm ?? 2400)

  function updateSlot(idx: number, code: BlockCode) {
    setPattern((prev) => prev.map((c, i) => (i === idx ? code : c)))
  }
  function addSlot() {
    // Default new slot to whatever the last slot is. If the pattern's
    // empty, fall back to the seed pier code (region-aware).
    const last = pattern[pattern.length - 1] ?? seedPierPrimary
    setPattern((prev) => [...prev, last])
  }
  function removeSlot(idx: number) {
    if (pattern.length <= 1) return
    setPattern((prev) => prev.filter((_, i) => i !== idx))
  }
  function moveSlot(idx: number, dir: -1 | 1) {
    setPattern((prev) => {
      const next = [...prev]
      const target = idx + dir
      if (target < 0 || target >= next.length) return prev
      ;[next[idx], next[target]] = [next[target], next[idx]]
      return next
    })
  }

  function handleSave() {
    if (!name.trim() || pattern.length === 0) return
    const updated: PierMakeup = {
      id:
        existing?.id ??
        (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `pm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`),
      name: name.trim() || 'New pier type',
      suggestedPlacement: placement,
      coursePattern: pattern,
      // Only persist heightMm for freestanding makeups — tied piers don't
      // use a type-level height (they inherit the wall).
      heightMm: placement === 'freestanding' ? heightMm : undefined,
      // Preserve area assignment across edits — see WallTypeEditorModal
      // handleSave for the rationale.
      ...(existing?.areaId ? { areaId: existing.areaId } : {}),
    }
    onSave(updated)
  }

  // Esc closes — mirrors WallTypeEditorModal so the keyboard UX is uniform
  // across both editors.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onCancel()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onCancel])

  // Pier preview: walk the pattern repeated enough times to fill a
  // representative 12-course pier (2400mm) so the user sees the cycle.
  // Each course renders as a single block-wide row (piers are 1 block
  // wide per course) tinted by the slot's block code.
  const PREVIEW_COURSES = 12
  const previewCourses: BlockCode[] = []
  for (let i = 0; i < PREVIEW_COURSES; i++) {
    previewCourses.push(pattern[i % pattern.length] ?? pattern[0])
  }

  const canSave = name.trim().length > 0 && pattern.length > 0

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={onCancel}
      role="dialog"
      aria-modal="true"
      aria-label={existing ? `Edit pier type ${existing.name}` : 'New pier type'}
    >
      <div
        className="bg-ink-800 border border-ink-600 rounded-2xl shadow-2xl w-full max-w-3xl h-[80vh] max-h-[760px] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <header className="px-5 py-3 border-b border-ink-600 flex items-center justify-between bg-ink-900/40">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-ink-100 truncate">
              {existing ? 'Edit pier type' : 'New pier type'}
              {existing && (
                <span className="text-ink-400 font-normal"> — {existing.name}</span>
              )}
            </h2>
            <p className="text-[11px] text-ink-500 mt-0.5">
              {pattern.length}-course pattern · {placement}
            </p>
          </div>
          <button
            onClick={onCancel}
            className="text-ink-400 hover:text-ink-100 text-2xl leading-none px-2"
            aria-label="Close"
          >
            ×
          </button>
        </header>

        {/* Kind picker — only shown when creating a NEW pier. Lets the
            user swap between the three kinds without going back to the
            panel. Picking "Wall" closes this modal and opens the wall
            editor; picking the other pier kind just updates the
            placement state in-place. */}
        {!existing && (onSwitchToWall || onSwitchToCurved) && (
          <KindPicker
            current={placement === 'tied' ? 'tied-pier' : 'freestanding-pier'}
            onChange={(kind) => {
              if (kind === 'wall') onSwitchToWall?.()
              else if (kind === 'curved') onSwitchToCurved?.()
              else if (kind === 'tied-pier') setPlacement('tied')
              else if (kind === 'freestanding-pier') setPlacement('freestanding')
            }}
          />
        )}

        {/* Body: form on the left, preview rail on the right (same shape
            as the wall type modal) */}
        <div className="flex flex-1 min-h-0">
          {/* Form area */}
          <div className="flex-1 overflow-y-auto p-6 min-w-0 max-w-2xl space-y-5">
            <label className="text-sm block">
              <span className="block text-ink-300 mb-1.5">Name</span>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full px-3 py-2 border border-ink-600 rounded-lg text-sm bg-ink-900 focus:outline-none focus:border-beme-400"
              />
            </label>

            {/* Default placement radio — only shown when EDITING an
                existing pier. When creating new, the kind picker at the
                top of the modal already drives this choice (Tied pier
                vs Freestanding pier), so showing the radio too would
                be a redundant second surface for the same property. */}
            {existing && (
              <fieldset className="text-sm">
                <legend className="text-ink-300 mb-1.5">Default placement</legend>
                <div className="flex flex-col gap-1.5">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      checked={placement === 'tied'}
                      onChange={() => setPlacement('tied')}
                    />
                    <span>Tied (built into a wall)</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      checked={placement === 'freestanding'}
                      onChange={() => setPlacement('freestanding')}
                    />
                    <span>Freestanding</span>
                  </label>
                </div>
              </fieldset>
            )}

            {placement === 'freestanding' && (
              <label className="text-sm block">
                <span className="block text-ink-300 mb-1.5">Height (mm)</span>
                <input
                  type="number"
                  min={200}
                  step={200}
                  value={heightMm}
                  onChange={(e) => {
                    const n = parseInt(e.target.value || '0', 10)
                    if (Number.isFinite(n)) setHeightMm(Math.max(200, n))
                  }}
                  className="w-full px-3 py-2 border border-ink-600 rounded-lg text-sm bg-ink-900 focus:outline-none focus:border-beme-400 font-mono"
                />
                <p className="text-[11px] text-ink-500 mt-1.5">
                  Applies to every freestanding pier of this type. Tied piers
                  inherit the host wall's height instead.
                </p>
              </label>
            )}

            <section>
              <div className="flex items-baseline justify-between mb-2">
                <h3 className="text-sm font-semibold text-ink-100">
                  Course pattern{' '}
                  <span className="text-[11px] font-normal text-ink-500">
                    (cycles up the pier)
                  </span>
                </h3>
              </div>
              <p className="text-[11px] text-ink-500 mb-3 leading-relaxed">
                The pattern repeats from the base course up — e.g. a
                tied pier typically alternates the pier block with a
                corner / tie-back block every other course.
              </p>
              <div className="space-y-2">
                {pattern.map((code, idx) => (
                  <div
                    key={idx}
                    className="flex items-center gap-2 p-2 rounded-lg border border-ink-600 bg-ink-900/60"
                  >
                    <span
                      className="inline-block w-3 h-3 rounded-sm flex-shrink-0 ring-1 ring-black/30"
                      style={{ backgroundColor: bandColor(code) }}
                      aria-hidden
                    />
                    <span className="text-ink-500 font-mono text-xs w-12 text-right">
                      c{idx + 1}
                    </span>
                    <select
                      value={code}
                      onChange={(e) => updateSlot(idx, e.target.value as BlockCode)}
                      className="px-2 py-1 border border-ink-600 rounded text-sm bg-ink-900 flex-1 min-w-0"
                    >
                      {blockOptions.map((c) => (
                        <option key={c} value={c}>
                          {blockLabel(c)}
                        </option>
                      ))}
                    </select>
                    <div className="flex items-center gap-0.5 ml-1">
                      <button
                        onClick={() => moveSlot(idx, -1)}
                        disabled={idx === 0}
                        className="text-ink-400 hover:text-ink-200 disabled:opacity-30 disabled:cursor-not-allowed text-xs px-1"
                        aria-label="Move course up"
                      >
                        ▲
                      </button>
                      <button
                        onClick={() => moveSlot(idx, 1)}
                        disabled={idx === pattern.length - 1}
                        className="text-ink-400 hover:text-ink-200 disabled:opacity-30 disabled:cursor-not-allowed text-xs px-1"
                        aria-label="Move course down"
                      >
                        ▼
                      </button>
                      <button
                        onClick={() => removeSlot(idx)}
                        disabled={pattern.length <= 1}
                        className="text-rose-400 hover:text-rose-300 disabled:opacity-30 disabled:cursor-not-allowed text-base px-2"
                        aria-label="Remove course"
                      >
                        ×
                      </button>
                    </div>
                  </div>
                ))}
              </div>
              <button
                onClick={addSlot}
                className="mt-3 text-sm px-3 py-2 rounded-lg border border-dashed border-ink-600 text-beme-300 hover:bg-ink-700/50 transition-colors"
              >
                + Add course slot
              </button>
            </section>

            {/* Block-library link — sends the user to /library when they
                need to add or edit a block that isn't in the dropdown. */}
            <p className="text-[11px] text-ink-500 pt-1">
              Need a block that isn't listed?{' '}
              <Link
                to="/library"
                target="_blank"
                rel="noopener noreferrer"
                className="text-beme-400 hover:text-beme-300 underline"
              >
                Manage blocks in the material library ↗
              </Link>
            </p>
          </div>

          {/* Right rail: pier preview */}
          <aside className="hidden lg:flex w-72 flex-shrink-0 border-l border-ink-600 bg-ink-900/30 flex-col p-4 min-h-0">
            <div className="flex items-baseline justify-between mb-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-400">
                Pier preview
              </h3>
              <span className="text-[10px] text-ink-500 font-mono">
                {PREVIEW_COURSES} courses
              </span>
            </div>
            <p className="text-[10px] text-ink-500 mb-3 leading-snug">
              Shows the pattern repeating to fill a representative pier height
              (~2400 mm). The actual pier height comes from the wall (tied) or
              the placed pier's height (freestanding).
            </p>
            <div className="flex-1 min-h-0 flex gap-2">
              {/* Single-column block stack — piers are one block wide per
                  course in the preview. Each cell rendered with the block's
                  band colour so the pattern repeats visibly. */}
              <div className="flex-1 max-w-[120px] flex flex-col-reverse rounded-md overflow-hidden border-2 border-ink-600 bg-ink-950 shadow-inner min-h-0 mx-auto">
                {previewCourses.map((code, i) => (
                  <div
                    key={i}
                    style={{
                      flexBasis: `${100 / PREVIEW_COURSES}%`,
                      minHeight: 0,
                      backgroundColor: bandColor(code),
                    }}
                    className="flex items-center justify-center text-white font-mono text-[10px] border-b border-black/40 last:border-b-0"
                    title={`Course ${i + 1}: ${code}`}
                  >
                    {code}
                  </div>
                ))}
              </div>
            </div>
            {/* Pier legend reuses the wall preview's legend helper with
                a flat resolver — every course is just the pattern slot
                cycling; no series ranges or per-course overrides on
                piers, so body == corner == half for legend purposes. */}
            <PreviewLegend
              bands={pattern.map((c) => ({ blockCode: c, count: 1 }))}
              resolveForCourse={(n) => {
                const code = pattern[(n - 1) % pattern.length] ?? pattern[0]
                return { body: code, corner: code, half: code }
              }}
              bondType="stack"
            />
          </aside>
        </div>

        {/* Footer — Cancel + Save always visible */}
        <footer className="px-5 py-3 border-t border-ink-600 bg-ink-900/40 flex items-center justify-end gap-2">
          <button
            onClick={onCancel}
            className="px-4 py-1.5 rounded-lg border border-ink-600 text-sm text-ink-200 hover:bg-ink-700 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={!canSave}
            className="px-4 py-1.5 rounded-lg bg-beme-500 text-black text-sm font-medium hover:bg-beme-400 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {existing ? 'Save changes' : 'Create pier type'}
          </button>
        </footer>
      </div>
    </div>
  )
}


/**
 * Mini course-stack preview — a column of colour stripes matching the
 * wall type's composition (base course at the bottom, body courses,
 * top course, optional cap). Colours come from bandColor so they match
 * the same hues the 3D view and pattern editor give those codes.
 */
function WallTypeStackPreview({
  makeup,
  width = 34,
}: {
  makeup: WallMakeup
  width?: number
}) {
  const stripes: Array<{ code: string; h: number }> = []
  if (makeup.capBlockCode) stripes.push({ code: makeup.capBlockCode, h: 3 })
  stripes.push({ code: makeup.topCourseBlockCode, h: 7 })
  stripes.push({ code: makeup.bodyBlockCode, h: 7 })
  stripes.push({ code: makeup.bodyBlockCode, h: 7 })
  stripes.push({ code: makeup.bodyBlockCode, h: 7 })
  stripes.push({ code: makeup.baseCourseBlockCode, h: 7 })
  return (
    <div
      className="flex flex-col gap-px shrink-0"
      style={{ width }}
      aria-hidden="true"
    >
      {stripes.map((st, i) => (
        <div
          key={i}
          className="rounded-[1px]"
          style={{ height: st.h, backgroundColor: bandColor(st.code, 'vibrant') }}
        />
      ))}
    </div>
  )
}

/** One-line spec summary for a wall type card. */
function wallTypeSpec(m: WallMakeup): string {
  return `${m.heightMm} mm · ${m.bondType}`
}

/** The distinct block codes a wall type uses (for the code chips). */
function wallTypeCodes(m: WallMakeup): string[] {
  const codes = [
    m.bodyBlockCode,
    m.cornerBlockCode,
    m.halfBlockCode,
    m.baseCourseBlockCode,
    m.topCourseBlockCode,
    m.capBlockCode,
  ].filter((c): c is string => !!c)
  return [...new Set(codes)]
}

/**
 * "Your library" wall types — the Material Library page's Wall types
 * tab. Named WallMakeup templates saved across projects: create and
 * edit them here with the same full editor projects use, or capture
 * one from any project via "Save to library" on a wall type card. The
 * new-wall-type modal offers these as starting points everywhere.
 */
export function WallTypeTemplatesSection({
  readOnly = false,
}: {
  readOnly?: boolean
}) {
  // Synced per-user via Supabase when signed in (templates follow your
  // login across devices); local IndexedDB fallback when offline.
  const { templates } = useUserWallTypeTemplates()
  const [editing, setEditing] = useState<WallMakeup | null>(null)
  const [adding, setAdding] = useState(false)

  return (
    <div>
      {templates.length === 0 ? (
        <p className="text-xs text-ink-400">
          No wall types saved yet. Build one here with “+ New wall
          type”, or open any project and click “Save to library” on a
          wall type you’ve already set up.
        </p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {templates.map((t) => (
            <div
              key={t.id}
              className="bg-ink-900/40 border border-ink-600/60 rounded-xl p-3 hover:border-ink-500 transition-colors"
            >
              <div className="flex gap-2.5">
                <WallTypeStackPreview makeup={t} />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-ink-100 truncate">
                    {t.name}
                  </div>
                  <div className="text-[11px] text-ink-400 mt-0.5">
                    {wallTypeSpec(t)}
                  </div>
                  <div className="flex flex-wrap gap-1 mt-1.5">
                    {wallTypeCodes(t)
                      .slice(0, 3)
                      .map((code) => (
                        <span
                          key={code}
                          className="text-[10px] font-mono bg-ink-700/60 text-ink-300 px-1.5 py-0.5 rounded"
                        >
                          {code}
                        </span>
                      ))}
                    {wallTypeCodes(t).length > 3 && (
                      <span className="text-[10px] font-mono text-ink-500 px-1 py-0.5">
                        +{wallTypeCodes(t).length - 3}
                      </span>
                    )}
                  </div>
                </div>
              </div>
              {!readOnly && (
                <div className="flex items-center gap-3 mt-2.5 pt-2 border-t border-ink-600/40">
                  <span
                    role="button"
                    tabIndex={0}
                    onClick={() => setEditing(t)}
                    className="text-[11px] text-beme-400 hover:text-beme-300 hover:underline cursor-pointer"
                  >
                    Edit
                  </span>
                  <span
                    role="button"
                    tabIndex={0}
                    onClick={() =>
                      void saveUserWallTypeTemplate({
                        ...t,
                        id: generateMakeupId(),
                        name: `${t.name} (copy)`,
                      })
                    }
                    className="text-[11px] text-ink-400 hover:text-ink-200 hover:underline cursor-pointer"
                  >
                    Duplicate
                  </span>
                  <span
                    role="button"
                    tabIndex={0}
                    onClick={async () => {
                      const ok = await confirm({
                        title: `Remove "${t.name}" from your library?`,
                        message:
                          'Wall types already created from it in projects are unaffected.',
                        confirmLabel: 'Remove',
                        variant: 'destructive',
                      })
                      if (!ok) return
                      try {
                        await deleteUserWallTypeTemplate(t.id)
                        toast.success(
                          `"${t.name}" removed from your library`,
                        )
                      } catch (err) {
                        const msg =
                          err instanceof Error
                            ? err.message
                            : 'Unknown error'
                        // Local-fallback: removed on this device but
                        // cloud sync is off. Treat as success so the
                        // user doesn't see a red error after the
                        // template visibly disappeared.
                        const isLocalFallback =
                          /removed locally/i.test(msg)
                        if (isLocalFallback) {
                          toast.success(
                            `"${t.name}" removed on this device`,
                            {
                              description:
                                'Cloud sync is off — apply the Supabase migration to sync across devices.',
                            },
                          )
                        } else {
                          toast.error(
                            `Couldn't remove "${t.name}"`,
                            { description: msg },
                          )
                        }
                      }
                    }}
                    className="text-[11px] text-rose-400 hover:text-rose-300 hover:underline cursor-pointer ml-auto"
                  >
                    Remove
                  </span>
                </div>
              )}
            </div>
          ))}
          {!readOnly && (
            <button
              type="button"
              onClick={() => setAdding(true)}
              className="border border-dashed border-ink-600 rounded-xl p-3 min-h-[104px] flex items-center justify-center text-xs text-ink-400 hover:text-ink-200 hover:border-ink-500 transition-colors"
            >
              + New wall type
            </button>
          )}
        </div>
      )}

      {!readOnly && templates.length === 0 && (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="mt-3 px-3 py-1.5 rounded-lg border border-ink-600 text-xs text-ink-200 hover:bg-ink-700 transition-colors"
        >
          + New wall type
        </button>
      )}

      {(editing || adding) && (
        <WallTypeEditorModal
          existing={editing}
          onSave={(makeup) => {
            // Upsert by id — editing keeps the template's identity,
            // adding mints a fresh one. Modal closes optimistically;
            // saveUserWallTypeTemplate does its own optimistic insert,
            // so the user sees the new template immediately. If the
            // Supabase upsert fails, the optimistic insert is rolled
            // back (template disappears) — surface that here via a
            // toast so the user knows save FAILED and isn't left
            // wondering why their wall type vanished. Without this
            // every failed upsert reads as "save did nothing".
            const payload = editing
              ? { ...makeup, id: editing.id }
              : { ...makeup, id: generateMakeupId() }
            void (async () => {
              try {
                await saveUserWallTypeTemplate(payload)
                toast.success(
                  editing
                    ? `Wall type "${payload.name}" updated`
                    : `Wall type "${payload.name}" added to your library`,
                )
              } catch (err) {
                const msg =
                  err instanceof Error
                    ? err.message
                    : 'Unknown error'
                // Local-fallback case: the cloud table is missing
                // but the wall type DID save to this device. Read
                // as info, not error — the wall type is in the
                // library, just not synced. Other failures stay as
                // a hard error so they can't be ignored.
                const isLocalFallback = /saved locally/i.test(msg)
                if (isLocalFallback) {
                  toast.success(
                    editing
                      ? `Wall type "${payload.name}" updated on this device`
                      : `Wall type "${payload.name}" saved on this device`,
                    {
                      description:
                        'Cloud sync is off — apply the Supabase migration to sync across devices.',
                    },
                  )
                } else {
                  toast.error(`Couldn't save wall type`, {
                    description: msg,
                  })
                }
              }
            })()
            setEditing(null)
            setAdding(false)
          }}
          onCancel={() => {
            setEditing(null)
            setAdding(false)
          }}
        />
      )}
    </div>
  )
}
