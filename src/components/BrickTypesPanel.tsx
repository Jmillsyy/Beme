import { useEffect, useMemo, useState, type ReactElement } from 'react'
import type { BrickCourseRange, BrickMakeup } from '../types/walls'
import type { BrickCode, BrickType } from '../types/bricks'
import { DEFAULT_BRICK_MORTAR_MM } from '../types/bricks'
import { Link } from 'react-router-dom'
import { useBrickLibrary } from '../data/brickLibrary'
import { confirm } from '../lib/confirm'
import { toast } from '../lib/toast'
import { wallTypeColor } from '../lib/wallTypeColors'
import LengthInput from './LengthInput'
import LibraryGuidance from './LibraryGuidance'

interface BrickTypesPanelProps {
  makeups: BrickMakeup[]
  /**
   * Full project-wide brick makeups list — used SOLELY to compute the
   * palette slot for each type's colour swatch, so the same brick
   * type lights up the same colour regardless of which area filter
   * is active. Defaults to {@link makeups} when not provided.
   */
  paletteMakeups?: BrickMakeup[]
  activeMakeupId: string
  wallCountsByMakeupId: Record<string, number>
  onSetActive: (id: string) => void
  onAddMakeup: (makeup: BrickMakeup) => void
  onUpdateMakeup: (makeup: BrickMakeup) => void
  onDeleteMakeup: (id: string) => void
  /**
   * Optional curve-draw activator passed from PdfWorkspace. When wired,
   * the brick wall-type editor surfaces a "Curved" toggle alongside
   * "Straight" — same affordance the block wall-type modal exposes.
   * Saving a Curved brick type stamps `kind: 'curved'` on the makeup
   * so the Draw button routes to 3-click curve-draw mode. Optional so
   * older host integrations that haven't wired curves still compile.
   */
  onToggleCurvedWall?: () => void
}

function generateMakeupId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `bm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Mirrors WallTypesPanel but with the smaller field set brick walls need:
 * just a name, a brick type, and a default height. Edit pops a fixed-
 * overlay modal (same UX as the block wall types editor) instead of
 * inline-expanding under the card — the previous inline form pushed
 * everything below it down and got lost on a long list.
 *
 * Selecting a wall type sets it as active (drives newly-drawn brick walls)
 * and highlights every wall of that type on the page.
 */
export default function BrickTypesPanel({
  makeups,
  paletteMakeups,
  activeMakeupId,
  wallCountsByMakeupId,
  onSetActive,
  onAddMakeup,
  onUpdateMakeup,
  onDeleteMakeup,
  onToggleCurvedWall,
}: BrickTypesPanelProps) {
  // Palette colours come from the FULL project list (or `makeups`
  // when no separate palette arg was passed). See WallTypesPanel for
  // the same rationale — keeps colours stable across area filters.
  const colorMakeups = paletteMakeups ?? makeups
  // Library check so the panel can tell the user which knob is the
  // missing one — "no brick in library, fix that first" vs "library has
  // bricks, just no wall types yet". Also drives suppression of saved
  // wall types when the library is empty: showing a "brick wall —
  // Acme 76mm" card while the library has no Acme 76mm in it would let
  // the user activate a type whose underlying brick is missing.
  const { library: brickLibrary, version: brickLibraryVersion } = useBrickLibrary()
  void brickLibraryVersion
  const brickLibraryEmpty = Object.keys(brickLibrary).length === 0
  const visibleMakeups = brickLibraryEmpty ? [] : makeups
  const [editingId, setEditingId] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(true)
  const editingMakeup =
    editingId && editingId !== 'new' ? makeups.find((m) => m.id === editingId) : null
  const activeMakeup = visibleMakeups.find((m) => m.id === activeMakeupId)
  const orderedMakeups = useMemo(() => {
    if (!activeMakeup) return visibleMakeups
    return [activeMakeup, ...visibleMakeups.filter((m) => m.id !== activeMakeup.id)]
  }, [visibleMakeups, activeMakeup])

  return (
    <div className="border border-ink-600 rounded-xl bg-ink-800 p-3">
      <div className="flex items-center justify-between mb-2 gap-2">
        <button
          onClick={() => setExpanded((v) => !v)}
          className="flex items-center gap-2 text-left flex-1 min-w-0 group"
        >
          <span className="text-ink-500 group-hover:text-ink-300 text-xs">
            {expanded ? '▾' : '▸'}
          </span>
          <h3 className="text-sm font-semibold text-ink-200 group-hover:text-beme-300">
            Brick wall types
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
          <LibraryGuidance mode="brick" actionLabel="Add wall type" position="left">
            <button
              onClick={() => {
                if (brickLibraryEmpty) return
                setEditingId('new')
              }}
              disabled={brickLibraryEmpty}
              className="text-sm px-2.5 py-1 rounded-lg bg-beme-500 text-black font-medium hover:bg-beme-400 disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex-shrink-0"
            >
              + Add
            </button>
          </LibraryGuidance>
        )}
      </div>

      {expanded && (
        <div className="flex flex-col gap-2 pb-1">
          {orderedMakeups.map((m) => {
            const isActive = m.id === activeMakeupId
            const wallCount = wallCountsByMakeupId[m.id] ?? 0
            const canDelete = makeups.length > 1 && wallCount === 0
            return (
              <button
                key={m.id}
                onClick={() => onSetActive(m.id)}
                className={`relative w-full p-2.5 rounded-lg border text-left transition-colors ${
                  isActive
                    ? 'border-beme-500 ring-2 ring-beme-500/20 bg-beme-500/10'
                    : 'border-ink-600 hover:border-beme-500/50 bg-ink-700/40'
                }`}
              >
                {isActive && (
                  <span className="absolute top-2 right-2 text-[11px] px-2 py-0.5 rounded bg-beme-500 text-black font-medium">
                    Active
                  </span>
                )}
                <div className="flex items-start gap-2 mb-1 pr-12">
                  {/* Colour-tinted chip doubling as the type label —
                      matches the block panel exactly so brick + block
                      wall-type lists read the same way. Says "Wall"
                      for straight types, "Curved" for kind='curved'.
                      Background is the type's plan colour so the
                      chip itself is the colour-id swatch. */}
                  <span
                    className="inline-block text-[10px] px-1.5 py-0.5 rounded uppercase tracking-wider font-semibold flex-shrink-0 text-white ring-1 ring-black/30"
                    style={{
                      backgroundColor: wallTypeColor(m.id, colorMakeups),
                    }}
                    title="Wall colour shown on the plan"
                  >
                    {m.kind === 'curved' ? 'Curved' : 'Wall'}
                  </span>
                  {/* Wrap the name onto multiple lines rather than truncate —
                      the name is the identity of this entry, so the user
                      always wants it in full even if the card grows taller. */}
                  <div className="text-sm font-medium text-ink-100 break-words flex-1 min-w-0">
                    {m.name}
                  </div>
                </div>
                <div className="text-xs text-ink-400">
                  {m.heightMm}mm · brick {m.brickTypeCode || 'project default'}
                </div>
                <div className="text-xs text-ink-500 mt-2">
                  {wallCount} wall{wallCount === 1 ? '' : 's'} using this
                </div>
                <div className="flex gap-3 mt-2">
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
                  {/* Duplicate — clones the makeup as a starting point for
                      a variant (e.g. Brickwork 2400mm → Brickwork 2700mm).
                      Fresh id so it lives independently; name suffixed
                      with " (copy)" so the user can spot which is new
                      and rename it. */}
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
                  {canDelete && (
                    <span
                      role="button"
                      tabIndex={0}
                      onClick={async (e) => {
                        e.stopPropagation()
                        const ok = await confirm({
                          title: `Delete brick wall type "${m.name}"?`,
                          message:
                            'Brick walls currently using this type will ' +
                            'fall back to the default.',
                          confirmLabel: 'Delete',
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

          {/* Empty state — mirrors WallTypesPanel exactly so block + brick
              workspaces feel the same when the user lands cold. */}
          {orderedMakeups.length === 0 && (
            <div className="rounded-lg border border-dashed border-ink-600 bg-ink-900/40 px-3 py-4 text-center">
              {brickLibraryEmpty ? (
                <>
                  <p className="text-xs font-semibold text-ink-200">
                    No brick wall types yet
                  </p>
                  <p className="text-[11px] text-ink-400 mt-1 leading-relaxed">
                    Add at least one brick to your Material Library, then come
                    back to create brick wall types here.
                  </p>
                  <Link
                    to="/library#bricks"
                    className="inline-flex items-center gap-1 mt-2 text-xs font-semibold text-beme-300 hover:text-beme-200"
                  >
                    Open Material Library
                    <span aria-hidden="true">→</span>
                  </Link>
                </>
              ) : (
                <>
                  <p className="text-xs font-semibold text-ink-200">
                    No brick wall types yet
                  </p>
                  <p className="text-[11px] text-ink-400 mt-1 leading-relaxed">
                    Hit <span className="font-semibold text-ink-200">+ Add</span>{' '}
                    above to set up your first brick wall — height, bond, and
                    brick type.
                  </p>
                </>
              )}
            </div>
          )}
        </div>
      )}

      {/* Brick wall type editor — same modal pattern as WallTypeEditorModal
          (fixed overlay, backdrop dismiss, Esc to close) so the brick
          workspace's edit affordance feels the same as the block one. */}
      {editingId !== null && (
        <BrickTypeEditorModal
          existing={editingId === 'new' ? null : editingMakeup ?? null}
          // Curved option only available on NEW types (same rule as the
          // block modal — converting an existing wall type's shape
          // mid-flight has too many cascading implications). Disabled
          // when the host hasn't wired a curve-draw activator.
          curvedAvailable={
            editingId === 'new' && Boolean(onToggleCurvedWall)
          }
          onCancel={() => setEditingId(null)}
          onSave={(m) => {
            const isNew = editingId === 'new'
            if (isNew) onAddMakeup(m)
            else onUpdateMakeup(m)
            setEditingId(null)
            toast.success(
              isNew
                ? `Brick wall type "${m.name}" added`
                : `Brick wall type "${m.name}" updated`
            )
            // The saved brick type sits in the panel labelled "Curved"
            // (kind flag on the makeup). The user selects it like any
            // other type and hits Draw — the toolbar's draw routing
            // checks the active makeup's kind and routes to curve-draw
            // or straight-draw accordingly. Same flow as the block
            // wall-type modal.
          }}
        />
      )}
    </div>
  )
}

// ---------- Internal: BrickTypeEditorModal ----------

interface BrickTypeEditorModalProps {
  existing: BrickMakeup | null
  onSave: (makeup: BrickMakeup) => void
  onCancel: () => void
  /**
   * Curve option is shown when true. Same rule as the block modal:
   * only the "+ Add" entry surface offers it (you can't convert an
   * existing brick type's shape mid-flight). Selecting Curved keeps
   * the form open so the user can fill out the basics, then saving
   * stamps `kind: 'curved'` so the parent's draw button routes to
   * 3-click curve-draw mode the next time this type is active.
   */
  curvedAvailable?: boolean
}

function BrickTypeEditorModal({
  existing,
  onSave,
  onCancel,
  curvedAvailable,
}: BrickTypeEditorModalProps) {
  const { library } = useBrickLibrary()
  const brickTypes = useMemo(
    () => Object.values(library).sort((a, b) => a.heightMm - b.heightMm),
    [library]
  )

  const [name, setName] = useState(existing?.name ?? 'New brick type')
  const [heightMm, setHeightMm] = useState<number>(existing?.heightMm ?? 2400)
  const [brickTypeCode, setBrickTypeCode] = useState<string>(existing?.brickTypeCode ?? '')
  // Optional course composition — start empty so a basic single-brick
  // wall type is still a single decision. Adding a band turns the wall
  // into a stack: course N to course M uses brick X, etc.
  const [courseRanges, setCourseRanges] = useState<BrickCourseRange[]>(
    existing?.courseRanges ?? []
  )
  // Optional sill / head brick types for openings on this wall type.
  // Empty string = "use project default brick" (no separate line item
  // in the tally — the opening trim is absorbed in the body brick
  // deduction). Selecting a brick type adds a dedicated trim line per
  // opening so the bricklayer can order solider / rowlock courses
  // distinctly.
  const [sillBrickCode, setSillBrickCode] = useState<string>(
    existing?.sillBrickCode ?? '',
  )
  const [sillBrickOrientation, setSillBrickOrientation] = useState<
    'stretcher' | 'soldier' | 'rowlock' | 'header'
  >(existing?.sillBrickOrientation ?? 'stretcher')
  const [headBrickCode, setHeadBrickCode] = useState<string>(
    existing?.headBrickCode ?? '',
  )
  const [headBrickOrientation, setHeadBrickOrientation] = useState<
    'stretcher' | 'soldier' | 'rowlock' | 'header'
  >(existing?.headBrickOrientation ?? 'stretcher')
  // Left-rail tabs — mirrors the multi-tab block wall type modal so
  // the two editors feel uniform. Basics = name + height + main brick.
  // Course pattern = bands of different bricks across courses. Openings
  // = sill / head bricks + orientation.
  type TabKey = 'basics' | 'composition' | 'openings'
  const [activeTab, setActiveTab] = useState<TabKey>('basics')

  // Wall shape — Straight (default) or Curved. Existing brick types
  // keep their stored kind; new types default to Straight. The Curved
  // option only renders when the host wired the curve-draw activator
  // (curvedAvailable). Same UX pattern as the block wall type modal:
  // picking Curved keeps the form open so the user fills the same
  // fields as a straight wall; on Save the kind flag is stamped on
  // the makeup and the parent's Draw button routes to 3-click
  // curve-draw the next time this type is active.
  const [selectedKind, setSelectedKind] = useState<'wall' | 'curved'>(
    existing?.kind ?? 'wall',
  )

  // Esc closes — mirrors WallTypeEditorModal so the keyboard UX is uniform.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault()
        onCancel()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  function handleSave() {
    const id = existing?.id ?? generateMakeupId()
    // Drop incomplete ranges (no brick selected) and sort by fromCourse
    // before persisting so the saved shape is always normalised.
    const cleanRanges = courseRanges
      .filter((r) => r.brickTypeCode && Number.isFinite(r.fromCourse) && r.fromCourse >= 1)
      .sort((a, b) => a.fromCourse - b.fromCourse)
    onSave({
      id,
      name: name.trim() || 'New brick type',
      // Existing brick types keep their stored kind (you can't morph
      // a straight brick wall type into a curved one mid-flight).
      // New types pick up whatever the user chose in the kind picker;
      // 'wall' is the default and stays absent from the persisted
      // shape (undefined ≡ straight wall, backward-compatible).
      kind:
        existing?.kind ??
        (selectedKind === 'curved' ? 'curved' : 'wall'),
      heightMm,
      brickTypeCode,
      ...(cleanRanges.length > 0 ? { courseRanges: cleanRanges } : {}),
      // Opening trim — only persist when the user actually nominated a
      // brick type. Empty strings stay absent so the tally treats the
      // opening as plain body brickwork. Orientation only persists
      // alongside its brick code (no point persisting orientation
      // when no trim brick is set).
      ...(sillBrickCode ? { sillBrickCode } : {}),
      ...(sillBrickCode && sillBrickOrientation !== 'stretcher'
        ? { sillBrickOrientation }
        : {}),
      ...(headBrickCode ? { headBrickCode } : {}),
      ...(headBrickCode && headBrickOrientation !== 'stretcher'
        ? { headBrickOrientation }
        : {}),
      // Preserve area assignment across edits. Same bug we hit on the
      // block side: this editor builds the result object explicitly and
      // never copied areaId, so every edit demoted a per-area brick wall
      // type back to All-only.
      ...(existing?.areaId ? { areaId: existing.areaId } : {}),
    })
  }

  const canSave = name.trim().length > 0 && heightMm >= 200

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={onCancel}
      role="dialog"
      aria-modal="true"
      aria-label={existing ? `Edit brick wall type ${existing.name}` : 'New brick wall type'}
    >
      <div
        className="bg-ink-800 border border-ink-600 rounded-2xl shadow-2xl w-full max-w-6xl h-[90vh] max-h-[960px] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <header className="px-5 py-3 border-b border-ink-600 flex items-center justify-between bg-ink-900/40">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-ink-100 truncate">
              {existing ? 'Edit brick wall type' : 'New brick wall type'}
              {existing && (
                <span className="text-ink-400 font-normal"> — {existing.name}</span>
              )}
            </h2>
            <p className="text-[11px] text-ink-500 mt-0.5">
              {courseRanges.length > 0
                ? `Pattern-driven · ${courseRanges.length} band${courseRanges.length === 1 ? '' : 's'} · ${heightMm} mm`
                : `${heightMm} mm`}
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

        {/* Wall shape picker — visual style mirrors the block modal's
            KindPicker so the two editors read as the same product.
            Brick has no pier kinds, so the picker is just Straight /
            Curved. Renders only on new types when the host wired
            curve-draw (existing brick types can't morph their shape
            mid-flight, same rule the block side enforces). */}
        {!existing && curvedAvailable && (
          <div className="px-5 py-2.5 border-b border-ink-600 bg-ink-900/20">
            <div className="flex items-center gap-3">
              <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-400">
                Type
              </span>
              <div className="inline-flex border border-ink-600 rounded-lg overflow-hidden">
                {(
                  [
                    { value: 'wall', label: 'Wall' },
                    { value: 'curved', label: 'Curved' },
                  ] as const
                ).map((o, i) => {
                  const isActive = selectedKind === o.value
                  return (
                    <button
                      key={o.value}
                      type="button"
                      onClick={() => {
                        if (!isActive) setSelectedKind(o.value)
                      }}
                      aria-pressed={isActive}
                      className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                        isActive
                          ? 'bg-beme-500 text-black'
                          : 'bg-ink-800 text-ink-300 hover:bg-ink-700 hover:text-ink-100'
                      } ${i > 0 ? 'border-l border-ink-600' : ''}`}
                    >
                      {o.label}
                    </button>
                  )
                })}
              </div>
            </div>
          </div>
        )}

        {/* Tabs + content — same shell as the blockwork modal: left tab
            rail, scrollable content area, right rail with live preview. */}
        <div className="flex flex-1 min-h-0">
          {/* Left tab rail */}
          <nav className="w-44 border-r border-ink-600 bg-ink-900/30 p-2 flex flex-col gap-1">
            {(
              [
                { key: 'basics', label: 'Basics' },
                {
                  key: 'composition',
                  label: 'Course pattern',
                  badge: courseRanges.length > 0 ? `${courseRanges.length}` : undefined,
                },
                {
                  key: 'openings',
                  label: 'Opening visuals',
                  badge:
                    (sillBrickCode ? 1 : 0) + (headBrickCode ? 1 : 0) > 0
                      ? `${(sillBrickCode ? 1 : 0) + (headBrickCode ? 1 : 0)}`
                      : undefined,
                },
              ] as { key: TabKey; label: string; badge?: string }[]
            ).map((t) => {
              const isActive = activeTab === t.key
              return (
                <button
                  key={t.key}
                  onClick={() => setActiveTab(t.key)}
                  className={`text-left text-sm px-3 py-2 rounded-lg transition-colors flex items-center justify-between gap-2 ${
                    isActive
                      ? 'bg-beme-500/15 text-beme-200 border border-beme-500/40'
                      : 'text-ink-300 hover:bg-ink-700/60 border border-transparent'
                  }`}
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
          <div className="flex-1 overflow-y-auto p-6 min-w-0 space-y-5">
          {activeTab === 'basics' && (
            <>
          {/* ─── Basics ───
              Name, default wall height, and the brick this wall type is
              based on. Same section grouping as the block editor so the
              two modals read the same way. */}
          <section className="space-y-3">
            <h4 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-400">
              Basics
            </h4>
            <label className="text-sm block">
              <span className="block text-ink-300 mb-1">Name</span>
              <input
                type="text"
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Facework, Rendered"
                className="w-full px-3 py-2 border border-ink-600 rounded-lg text-sm bg-ink-900 text-ink-50 focus:outline-none focus:border-beme-400"
              />
            </label>
            <label className="text-sm block">
              <span className="block text-ink-300 mb-1">Height</span>
              <LengthInput
                valueMm={heightMm}
                onChangeMm={(mm) => setHeightMm(Math.round(mm))}
                minMm={200}
                className="w-full"
              />
            </label>
            <label className="text-sm block">
              <span className="block text-ink-300 mb-1">
                {courseRanges.length === 0 ? 'Main brick' : 'Default brick'}
              </span>
              <select
                value={brickTypeCode}
                onChange={(e) => setBrickTypeCode(e.target.value)}
                className="w-full px-3 py-2 border border-ink-600 rounded-lg text-sm bg-ink-900 text-ink-50 focus:outline-none focus:border-beme-400"
              >
                <option value="">Use project default</option>
                {brickTypes.map((t) => (
                  <option key={t.code} value={t.code}>
                    {t.name} ({t.heightMm}mm tall)
                  </option>
                ))}
              </select>
              <span className="text-[11px] text-ink-400 mt-1 block">
                {courseRanges.length === 0
                  ? 'The brick used for the whole wall.'
                  : 'Fallback brick — used for any course not covered by a band on the Course pattern tab.'}
              </span>
            </label>
          </section>
            </>
          )}

          {activeTab === 'composition' && (
            <>
          {/* ─── Course composition ───
              Optional. Each entry: from course X, use brick Y. Last
              entry runs to the top of the wall. Single-brick walls
              leave this empty and the wall is one layer of "Main
              brick" above. Section header always renders so the user
              sees the feature exists; the band list only renders
              when there's at least one band. */}
          <section>
            <div className="flex items-center justify-between mb-2">
              <div>
                <h4 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-400">
                  Course composition
                  <span className="ml-2 text-ink-500 normal-case tracking-normal font-normal">
                    · optional
                  </span>
                </h4>
                <div className="text-[11px] text-ink-400 mt-1.5 leading-snug">
                  Stack different bricks on different courses (e.g. course
                  1 = single-height, course 2+ = double-height). Leave
                  empty for a single-brick wall.
                </div>
              </div>
              <button
                onClick={() => {
                  // New band defaults to "5 courses above the last
                  // band's threshold" so the user has a sensible
                  // starting point. The first band defaults to
                  // "below course 5" (= courses 1-4).
                  const lastBelow = courseRanges.length > 0
                    ? Math.max(...courseRanges.map((r) => r.fromCourse))
                    : 0
                  setCourseRanges([
                    ...courseRanges,
                    {
                      fromCourse: lastBelow + 5,
                      brickTypeCode: brickTypeCode || brickTypes[0]?.code || '',
                    },
                  ])
                }}
                className="text-xs px-2 py-1 rounded border border-ink-600 text-beme-300 hover:border-beme-500/60 hover:bg-ink-700 transition-colors flex-shrink-0"
              >
                + Add band
              </button>
            </div>

            {courseRanges.length > 0 && (
              <div className="flex flex-col gap-2">
                {courseRanges.map((range, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-2 p-2 border border-ink-700 rounded-lg bg-ink-900/40"
                  >
                    <div className="flex items-center gap-1.5 text-xs">
                      <span className="text-ink-400">Below course</span>
                      <input
                        type="number"
                        min="1"
                        step="1"
                        value={range.fromCourse}
                        onChange={(e) => {
                          const next = [...courseRanges]
                          next[i] = {
                            ...range,
                            fromCourse: Math.max(1, parseInt(e.target.value || '1', 10) || 1),
                          }
                          setCourseRanges(next)
                        }}
                        className="w-14 px-2 py-1 border border-ink-600 rounded text-xs bg-ink-900 text-ink-50 focus:outline-none focus:border-beme-400 tabular-nums"
                      />
                    </div>
                    <select
                      value={range.brickTypeCode}
                      onChange={(e) => {
                        const next = [...courseRanges]
                        next[i] = { ...range, brickTypeCode: e.target.value }
                        setCourseRanges(next)
                      }}
                      className="flex-1 min-w-0 px-2 py-1 border border-ink-600 rounded text-xs bg-ink-900 text-ink-50 focus:outline-none focus:border-beme-400"
                    >
                      <option value="">Pick a brick…</option>
                      {brickTypes.map((t) => (
                        <option key={t.code} value={t.code}>
                          {t.name} ({t.heightMm}mm)
                        </option>
                      ))}
                    </select>
                    <button
                      onClick={() =>
                        setCourseRanges(courseRanges.filter((_, idx) => idx !== i))
                      }
                      className="text-xs text-rose-400 hover:text-rose-300 px-1.5"
                      aria-label="Remove band"
                    >
                      ×
                    </button>
                  </div>
                ))}
                <div className="text-[11px] text-ink-500 italic">
                  Each band's brick applies to courses BELOW the
                  number shown. Courses above the highest band use
                  the default brick from the Basics tab.
                </div>
              </div>
            )}
          </section>
            </>
          )}

          {activeTab === 'openings' && (
            <>
          {/* ─── Sill course ───
              Brick + orientation for the course immediately below
              every opening on this wall type. */}
          <section className="space-y-3">
            <h4 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-400">
              Sill course
            </h4>
            <label className="text-sm block">
              <span className="block text-ink-300 mb-1">Brick type</span>
              <select
                value={sillBrickCode}
                onChange={(e) => setSillBrickCode(e.target.value)}
                className="w-full px-3 py-2 border border-ink-600 rounded-lg text-sm bg-ink-900 text-ink-50 focus:outline-none focus:border-beme-400"
              >
                <option value="">— none (absorbed in body) —</option>
                {brickTypes.map((t) => (
                  <option key={t.code} value={t.code}>
                    {t.name} ({t.heightMm}mm tall)
                  </option>
                ))}
              </select>
              <span className="text-[11px] text-ink-400 mt-1 block">
                Brick laid under each window/door sill on this wall type.
                Adds one course across the opening width to the tally per
                opening.
              </span>
            </label>
            {sillBrickCode && (
              <div className="text-sm">
                <span className="block text-ink-300 mb-1">Orientation</span>
                <div className="grid grid-cols-2 gap-2">
                  {(['stretcher', 'soldier', 'rowlock', 'header'] as const).map((o) => {
                    const isActive = sillBrickOrientation === o
                    const label =
                      o === 'stretcher'
                        ? 'Stretcher'
                        : o === 'soldier'
                          ? 'Soldier'
                          : o === 'rowlock'
                            ? 'Rowlock'
                            : 'Header'
                    const sub =
                      o === 'stretcher'
                        ? 'Long face out, flat'
                        : o === 'soldier'
                          ? 'On end, long edge up'
                          : o === 'rowlock'
                            ? 'On edge, depth showing'
                            : 'Rolled, typical face up'
                    return (
                      <button
                        key={o}
                        onClick={() => setSillBrickOrientation(o)}
                        className={`text-left px-3 py-2 rounded-lg border text-xs transition-colors ${
                          isActive
                            ? 'border-beme-500 ring-2 ring-beme-500/20 bg-beme-500/10 text-ink-100'
                            : 'border-ink-600 hover:border-beme-500/50 bg-ink-900/40 text-ink-300'
                        }`}
                      >
                        <div className="font-medium">{label}</div>
                        <div className="text-[10px] text-ink-500 mt-0.5">{sub}</div>
                      </button>
                    )
                  })}
                </div>
              </div>
            )}
          </section>

          {/* ─── Head course ─── */}
          <section className="space-y-3">
            <h4 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-400">
              Head course
            </h4>
            <label className="text-sm block">
              <span className="block text-ink-300 mb-1">Brick type</span>
              <select
                value={headBrickCode}
                onChange={(e) => setHeadBrickCode(e.target.value)}
                className="w-full px-3 py-2 border border-ink-600 rounded-lg text-sm bg-ink-900 text-ink-50 focus:outline-none focus:border-beme-400"
              >
                <option value="">— none (absorbed in body) —</option>
                {brickTypes.map((t) => (
                  <option key={t.code} value={t.code}>
                    {t.name} ({t.heightMm}mm tall)
                  </option>
                ))}
              </select>
              <span className="text-[11px] text-ink-400 mt-1 block">
                Brick laid above each opening (soldier or rowlock course
                over the lintel). Adds one course across the opening
                width per opening.
              </span>
            </label>
            {headBrickCode && (
              <div className="text-sm">
                <span className="block text-ink-300 mb-1">Orientation</span>
                <div className="grid grid-cols-2 gap-2">
                  {(['stretcher', 'soldier', 'rowlock', 'header'] as const).map((o) => {
                    const isActive = headBrickOrientation === o
                    const label =
                      o === 'stretcher'
                        ? 'Stretcher'
                        : o === 'soldier'
                          ? 'Soldier'
                          : o === 'rowlock'
                            ? 'Rowlock'
                            : 'Header'
                    const sub =
                      o === 'stretcher'
                        ? 'Long face out, flat'
                        : o === 'soldier'
                          ? 'On end, long edge up'
                          : o === 'rowlock'
                            ? 'On edge, depth showing'
                            : 'Rolled, typical face up'
                    return (
                      <button
                        key={o}
                        onClick={() => setHeadBrickOrientation(o)}
                        className={`text-left px-3 py-2 rounded-lg border text-xs transition-colors ${
                          isActive
                            ? 'border-beme-500 ring-2 ring-beme-500/20 bg-beme-500/10 text-ink-100'
                            : 'border-ink-600 hover:border-beme-500/50 bg-ink-900/40 text-ink-300'
                        }`}
                      >
                        <div className="font-medium">{label}</div>
                        <div className="text-[10px] text-ink-500 mt-0.5">{sub}</div>
                      </button>
                    )
                  })}
                </div>
              </div>
            )}
          </section>
            </>
          )}
          </div>

          {/* Right rail: live wall preview. Same shell as the block
              modal so the user reads the two editors the same way.
              Width / padding / typography all match for direct visual
              continuity when switching between trades. */}
          <aside className="hidden lg:flex w-80 flex-shrink-0 border-l border-ink-600 bg-ink-900/30 flex-col p-4 min-h-0">
            <div className="flex items-baseline justify-between mb-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-400">
                Wall preview
              </h3>
              {courseRanges.length > 0 ? (
                <span className="text-[10px] text-beme-300 font-mono">pattern</span>
              ) : (
                <span className="text-[10px] text-ink-500 font-mono">auto</span>
              )}
            </div>
            <p className="text-[10px] text-ink-500 mb-3 leading-snug">
              {courseRanges.length === 0
                ? 'Single layer of the main brick.'
                : `${courseRanges.length} band${courseRanges.length === 1 ? '' : 's'}, stacked bottom to top.`}
            </p>
            <div className="flex-1 min-h-0">
              <BrickWallPreview
                wallHeightMm={heightMm}
                mainBrickCode={brickTypeCode}
                courseRanges={courseRanges}
                library={library}
                sillBrickCode={sillBrickCode || undefined}
                sillBrickOrientation={sillBrickOrientation}
                headBrickCode={headBrickCode || undefined}
                headBrickOrientation={headBrickOrientation}
              />
            </div>
          </aside>
        </div>

        {/* Footer */}
        <footer className="px-5 py-3 border-t border-ink-600 bg-ink-900/40 flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="px-4 py-1.5 rounded-lg border border-ink-600 text-ink-200 text-sm hover:bg-ink-700 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={!canSave}
            className="px-4 py-1.5 rounded-lg bg-beme-500 text-black text-sm hover:bg-beme-400 disabled:opacity-40 disabled:cursor-not-allowed transition-colors font-medium"
          >
            {existing ? 'Save changes' : 'Create brick wall type'}
          </button>
        </footer>
      </div>
    </div>
  )
}

// ---------- Internal: BrickWallPreview ----------

interface BrickWallPreviewProps {
  wallHeightMm: number
  mainBrickCode: string
  courseRanges: BrickCourseRange[]
  library: Record<BrickCode, BrickType>
  /** Optional sill / head trim — shown as bricks of the chosen type
   *  laid at the opening edge so the user can preview the soldier /
   *  rowlock / stretcher orientation before committing. */
  sillBrickCode?: string
  sillBrickOrientation?: 'stretcher' | 'soldier' | 'rowlock' | 'header'
  headBrickCode?: string
  headBrickOrientation?: 'stretcher' | 'soldier' | 'rowlock' | 'header'
}

/**
 * Live SVG preview of a brick wall as configured in the modal. Resolves
 * the makeup's main brick + course bands into segments bottom-to-top,
 * then renders each course as a row of bricks in stretcher bond (every
 * other course offset by half a face length).
 *
 * Each band gets its own colour band so the user can see at a glance
 * where one brick type stops and the next starts.
 */
function BrickWallPreview({
  wallHeightMm,
  mainBrickCode,
  courseRanges,
  library,
  sillBrickCode,
  sillBrickOrientation = 'stretcher',
  headBrickCode,
  headBrickOrientation = 'stretcher',
}: BrickWallPreviewProps) {
  const segments = useMemo(() => {
    // BELOW-COURSE semantics for the live preview. Each range's
    // brick fills courses BELOW its fromCourse threshold (above
    // the previous range's threshold). Top of the wall (above the
    // highest threshold) uses the main brick — implicit, no
    // explicit band needed.
    const ranges = (courseRanges ?? []).filter(
      (r) =>
        r.brickTypeCode && Number.isFinite(r.fromCourse) && r.fromCourse >= 1
    )
    const sorted = [...ranges].sort((a, b) => a.fromCourse - b.fromCourse)
    if (sorted.length === 0) {
      const brick = mainBrickCode ? library[mainBrickCode] : undefined
      if (!brick) return []
      return [{ brick, heightMm: wallHeightMm, bandIndex: 0 }]
    }
    const out: Array<{ brick: BrickType; heightMm: number; bandIndex: number }> = []
    let cursorMm = 0
    let cursorCourse = 1
    for (let i = 0; i < sorted.length; i++) {
      const range = sorted[i]
      const brick = library[range.brickTypeCode]
      if (!brick) continue
      const pitch = brick.heightMm + (brick.mortarJointMm ?? DEFAULT_BRICK_MORTAR_MM)
      const remaining = wallHeightMm - cursorMm
      if (remaining <= 0) break
      const bandCourses = Math.max(0, range.fromCourse - cursorCourse)
      const bandHeight = Math.min(bandCourses * pitch, remaining)
      if (bandHeight > 0) {
        out.push({ brick, heightMm: bandHeight, bandIndex: i })
        cursorMm += bandHeight
      }
      cursorCourse = range.fromCourse
    }
    // Above the highest threshold — fill with main brick.
    const remaining = wallHeightMm - cursorMm
    if (remaining > 0) {
      const mainBrick = mainBrickCode ? library[mainBrickCode] : undefined
      if (mainBrick) {
        out.push({ brick: mainBrick, heightMm: remaining, bandIndex: sorted.length })
      }
    }
    return out
  }, [wallHeightMm, mainBrickCode, courseRanges, library])

  // Width of the preview wall section — wide enough to fit a sample
  // window opening with body bricks on either side. Real-world mm so
  // the SVG scales naturally; the parent container handles fit-to-fill.
  const widestFaceMm = Math.max(
    ...segments.map((s) => s.brick.widthMm + (s.brick.mortarJointMm ?? DEFAULT_BRICK_MORTAR_MM)),
    230
  )
  const viewWidth = Math.max(widestFaceMm * 6, 1500)
  const viewHeight = Math.max(wallHeightMm, 100)

  // ── Sample window opening — drawn into the preview when there's
  // enough wall height to host one. Sized roughly half the viewWidth
  // and at typical residential sill / head positions. Skipped on
  // very short walls (< 1500 mm) where a window wouldn't fit.
  const hasWindow = wallHeightMm >= 1500
  const windowSillMm = hasWindow ? Math.max(600, wallHeightMm * 0.3) : 0
  const windowHeightMm = hasWindow
    ? Math.min(1200, wallHeightMm - windowSillMm - 300)
    : 0
  const windowHeadMm = windowSillMm + windowHeightMm
  const windowWidthMm = Math.min(viewWidth * 0.55, 1200)
  const windowX0Mm = (viewWidth - windowWidthMm) / 2
  const windowX1Mm = windowX0Mm + windowWidthMm
  // SVG mm-space is Y-DOWN, so y0 = top of opening in SVG = top of
  // wall − head height.
  const windowSvgTopY = wallHeightMm - windowHeadMm
  const windowSvgBotY = wallHeightMm - windowSillMm

  // Resolve a brick + orientation into the visible face dimensions
  // and a colour. Mirrors the 3D rendering's orientedFace() helper.
  const orientedFace = (
    brick: BrickType | undefined,
    orientation: 'stretcher' | 'soldier' | 'rowlock' | 'header',
  ): { faceWMm: number; faceHMm: number } | null => {
    if (!brick) return null
    const w = brick.widthMm
    const h = brick.heightMm
    const d = brick.depthMm ?? 110
    switch (orientation) {
      case 'soldier':
        return { faceWMm: h, faceHMm: w }
      case 'rowlock':
        return { faceWMm: w, faceHMm: d }
      case 'header':
        return { faceWMm: h, faceHMm: d }
      default:
        return { faceWMm: w, faceHMm: h }
    }
  }
  const sillBrick = sillBrickCode ? library[sillBrickCode] : undefined
  const headBrick = headBrickCode ? library[headBrickCode] : undefined
  const sillFace = hasWindow ? orientedFace(sillBrick, sillBrickOrientation) : null
  const headFace = hasWindow ? orientedFace(headBrick, headBrickOrientation) : null

  // Band palette — matches the spirit of WallTypesPanel's wall-type
  // colours so an estimator switching between block / brick projects
  // sees the same visual language.
  const PALETTE = [
    { fill: '#ED7D31', stroke: '#9A3F08' },
    { fill: '#2563eb', stroke: '#1e3a8a' },
    { fill: '#16a34a', stroke: '#14532d' },
    { fill: '#7c3aed', stroke: '#4c1d95' },
    { fill: '#db2777', stroke: '#831843' },
    { fill: '#0891b2', stroke: '#164e63' },
  ]
  // Dedicated trim palette — distinct from the body bands so the
  // sill / head visually stand apart.
  const SILL_TRIM_COLOUR = { fill: '#a3e635', stroke: '#3f6212' }
  const HEAD_TRIM_COLOUR = { fill: '#f59e0b', stroke: '#7c2d12' }

  if (segments.length === 0) {
    return (
      <div className="h-full w-full flex items-center justify-center text-[11px] text-ink-500 italic border border-dashed border-ink-700 rounded-lg">
        Pick a main brick to see the preview.
      </div>
    )
  }

  // Walk segments TOP→BOTTOM in SVG mm-space. For each segment build
  // (a) a backing rectangle that fills the band's ENTIRE allocated
  // height with the band colour, and (b) a list of horizontal course
  // gridlines + vertical stretcher-bond gridlines drawn on top. The
  // backing rectangle approach makes it impossible for a leftover /
  // partial course to leave an empty strip between bands — every mm
  // of the band is covered by the colour even when a course doesn't
  // fit neatly.
  interface BandRender {
    topY: number
    height: number
    brick: BrickType
    pitch: number
    colour: typeof PALETTE[number]
    /** Course index from the ground for the band's bottom-most course,
     *  used to pick the stretcher offset parity. */
    bottomCourseIndexFromGround: number
  }
  const bandRenders: BandRender[] = []
  let yCursor = 0
  const segmentsTopDown = [...segments].reverse()
  for (const seg of segmentsTopDown) {
    const colour = PALETTE[seg.bandIndex % PALETTE.length]
    const pitch = seg.brick.heightMm + (seg.brick.mortarJointMm ?? DEFAULT_BRICK_MORTAR_MM)
    const bandBottomY = yCursor + seg.heightMm
    const segBottomFromGroundMm = wallHeightMm - bandBottomY
    const bottomCourseIndexFromGround = Math.floor(segBottomFromGroundMm / pitch)
    bandRenders.push({
      topY: yCursor,
      height: seg.heightMm,
      brick: seg.brick,
      pitch,
      colour,
      bottomCourseIndexFromGround,
    })
    yCursor = bandBottomY
  }

  // Mortar gridline thickness in mm — needs to be wide enough to read
  // against the band colour at preview scale. The mortar is drawn as
  // dark gridlines (horizontal between courses, vertical between
  // bricks) on top of the solid band fill.
  const mortarWidthMm = 8

  return (
    <div className="h-full w-full flex flex-col gap-2">
      <div className="flex-1 min-h-0 border border-ink-700 rounded-lg bg-ink-900/40 overflow-hidden">
        <svg
          viewBox={`0 0 ${viewWidth} ${viewHeight}`}
          xmlns="http://www.w3.org/2000/svg"
          preserveAspectRatio="xMidYMid meet"
          className="w-full h-full"
        >
          {/* 1. Backing rectangle per band: fills the entire band height
                with the band colour. No matter how the course gridlines
                land, the band itself is always continuous so adjacent
                bands meet without any visible gap. */}
          {bandRenders.map((band, i) => (
            <rect
              key={`band-${i}`}
              x={0}
              y={band.topY}
              width={viewWidth}
              height={band.height}
              fill={band.colour.fill}
              opacity={0.94}
            />
          ))}
          {/* 2. Course gridlines + vertical brick gridlines on top of
                the backing fills. Each band gets its own brick subdivision
                pattern at the brick's pitch — partial top courses just
                drop the last gridline naturally without leaving a gap. */}
          {bandRenders.map((band, i) => {
            const faceMm =
              band.brick.widthMm + (band.brick.mortarJointMm ?? DEFAULT_BRICK_MORTAR_MM)
            const bandBottomY = band.topY + band.height
            const lines: ReactElement[] = []
            // Horizontal mortar lines: one at the TOP of each course,
            // starting from the band's bottom-most course and walking
            // up. The very bottom of the wall doesn't get a top line
            // (there's no course above it), and we stop drawing past
            // the band's top edge.
            let lineY = bandBottomY - band.pitch
            while (lineY > band.topY - 0.5) {
              lines.push(
                <line
                  key={`h-${i}-${lineY}`}
                  x1={0}
                  y1={lineY}
                  x2={viewWidth}
                  y2={lineY}
                  stroke={band.colour.stroke}
                  strokeWidth={mortarWidthMm}
                  opacity={0.55}
                />
              )
              lineY -= band.pitch
            }
            // Vertical mortar lines: walk every course in the band and
            // place a vertical mark at each brick boundary. Alternating
            // courses shift by half a face so the bond reads.
            let courseBottom = bandBottomY
            let courseIndexFromGround = band.bottomCourseIndexFromGround
            // Draw down from the band's top into the band so each course
            // gets its verticals. We walk in CourseBottom decreasing.
            while (courseBottom > band.topY + 0.5) {
              const offset = courseIndexFromGround % 2 === 1
              const startX = offset ? -faceMm / 2 : 0
              const courseTop = Math.max(band.topY, courseBottom - band.pitch)
              // Place a vertical line at the end of each brick face
              // within the visible width. Skip the line at x=0 / x=viewWidth
              // (those are the wall edges, not internal mortar).
              for (let x = startX + band.brick.widthMm; x < viewWidth; x += faceMm) {
                if (x <= 0 || x >= viewWidth) continue
                lines.push(
                  <line
                    key={`v-${i}-${courseIndexFromGround}-${x}`}
                    x1={x}
                    y1={courseTop}
                    x2={x}
                    y2={courseBottom}
                    stroke={band.colour.stroke}
                    strokeWidth={mortarWidthMm}
                    opacity={0.55}
                  />
                )
              }
              courseBottom -= band.pitch
              courseIndexFromGround += 1
            }
            return <g key={`grid-${i}`}>{lines}</g>
          })}
          {/* 3. Sample window opening + sill / head trim bricks.
                Rendered AFTER the body so it visually overrides the
                bricks where the void / trim sit. The window void
                shows the ink-900 background colour like the rest of
                the workspace's empty-space colour. */}
          {hasWindow && (
            <g>
              {/* Window void — punches through the body bricks */}
              <rect
                x={windowX0Mm}
                y={windowSvgTopY}
                width={windowWidthMm}
                height={windowSvgBotY - windowSvgTopY}
                fill="#0b0d10"
                stroke="#1f2937"
                strokeWidth={4}
              />
              {/* Sill trim band — sits IMMEDIATELY below the window,
                  spans the window width. Each brick is drawn at the
                  oriented face width with a 10 mm mortar gap. */}
              {sillFace && (
                <g>
                  {(() => {
                    const trimY1 = windowSvgBotY
                    const trimY0 = trimY1 - sillFace.faceHMm
                    const TRIM_MORTAR_MM = 10
                    const modular = sillFace.faceWMm + TRIM_MORTAR_MM
                    const count = Math.max(
                      1,
                      Math.ceil(windowWidthMm / modular),
                    )
                    const bricks: ReactElement[] = []
                    // Backing band so the 10 mm gaps between trim
                    // bricks read as mortar joints, not voids.
                    bricks.push(
                      <rect
                        key="sill-back"
                        x={windowX0Mm}
                        y={trimY0}
                        width={windowWidthMm}
                        height={sillFace.faceHMm}
                        fill={SILL_TRIM_COLOUR.stroke}
                      />,
                    )
                    let cursor = windowX0Mm
                    for (let i = 0; i < count; i++) {
                      const remain = windowX1Mm - cursor
                      if (remain < 1) break
                      const w = Math.min(sillFace.faceWMm, remain)
                      bricks.push(
                        <rect
                          key={`sill-${i}`}
                          x={cursor}
                          y={trimY0}
                          width={w}
                          height={sillFace.faceHMm}
                          fill={SILL_TRIM_COLOUR.fill}
                          stroke={SILL_TRIM_COLOUR.stroke}
                          strokeWidth={4}
                        />,
                      )
                      cursor += modular
                    }
                    return bricks
                  })()}
                </g>
              )}
              {/* Head trim band — sits IMMEDIATELY above the window */}
              {headFace && (
                <g>
                  {(() => {
                    const trimY1 = windowSvgTopY
                    const trimY0 = trimY1 - headFace.faceHMm
                    const TRIM_MORTAR_MM = 10
                    const modular = headFace.faceWMm + TRIM_MORTAR_MM
                    const count = Math.max(
                      1,
                      Math.ceil(windowWidthMm / modular),
                    )
                    const bricks: ReactElement[] = []
                    bricks.push(
                      <rect
                        key="head-back"
                        x={windowX0Mm}
                        y={trimY0}
                        width={windowWidthMm}
                        height={headFace.faceHMm}
                        fill={HEAD_TRIM_COLOUR.stroke}
                      />,
                    )
                    let cursor = windowX0Mm
                    for (let i = 0; i < count; i++) {
                      const remain = windowX1Mm - cursor
                      if (remain < 1) break
                      const w = Math.min(headFace.faceWMm, remain)
                      bricks.push(
                        <rect
                          key={`head-${i}`}
                          x={cursor}
                          y={trimY0}
                          width={w}
                          height={headFace.faceHMm}
                          fill={HEAD_TRIM_COLOUR.fill}
                          stroke={HEAD_TRIM_COLOUR.stroke}
                          strokeWidth={4}
                        />,
                      )
                      cursor += modular
                    }
                    return bricks
                  })()}
                </g>
              )}
            </g>
          )}
        </svg>
      </div>
      {/* Legend ordered TOP → BOTTOM so the rows in the swatch list
          line up with what the eye reads in the preview above. Trim
          rows appear when a sill / head brick is configured. */}
      <div className="flex flex-col gap-1">
        {headBrick && hasWindow && (
          <div className="flex items-center gap-2 text-[11px]">
            <span
              className="inline-block w-3 h-3 rounded-sm flex-shrink-0 ring-1 ring-black/30"
              style={{ backgroundColor: HEAD_TRIM_COLOUR.fill }}
              aria-hidden
            />
            <span className="text-ink-200 flex-1 truncate">
              {headBrick.name}
            </span>
            <span className="text-ink-500 text-[10px] flex-shrink-0">
              head ({headBrickOrientation})
            </span>
          </div>
        )}
        {sillBrick && hasWindow && (
          <div className="flex items-center gap-2 text-[11px]">
            <span
              className="inline-block w-3 h-3 rounded-sm flex-shrink-0 ring-1 ring-black/30"
              style={{ backgroundColor: SILL_TRIM_COLOUR.fill }}
              aria-hidden
            />
            <span className="text-ink-200 flex-1 truncate">
              {sillBrick.name}
            </span>
            <span className="text-ink-500 text-[10px] flex-shrink-0">
              sill ({sillBrickOrientation})
            </span>
          </div>
        )}
        {[...segments].reverse().map((seg, i) => {
          const colour = PALETTE[seg.bandIndex % PALETTE.length]
          const pitch =
            seg.brick.heightMm + (seg.brick.mortarJointMm ?? DEFAULT_BRICK_MORTAR_MM)
          // Course count rounds UP when there's a partial top course in
          // the band so the legend matches what the user sees rendered.
          const fullCourses = Math.floor(seg.heightMm / pitch)
          const leftover = seg.heightMm - fullCourses * pitch
          const courses = Math.max(1, fullCourses + (leftover > 1 ? 1 : 0))
          return (
            <div key={i} className="flex items-center gap-2 text-[11px]">
              <span
                className="inline-block w-3 h-3 rounded-sm flex-shrink-0 ring-1 ring-black/30"
                style={{ backgroundColor: colour.fill }}
                aria-hidden
              />
              <span className="text-ink-200 flex-1 truncate">{seg.brick.name}</span>
              <span className="text-ink-500 tabular-nums flex-shrink-0">
                {courses} course{courses === 1 ? '' : 's'}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
