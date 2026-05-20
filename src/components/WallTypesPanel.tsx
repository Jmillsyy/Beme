import { useMemo, useState } from 'react'
import type {
  WallMakeup,
  BondType,
  CourseOverride,
  CourseSeriesRange,
} from '../types/walls'
import type { BlockCode } from '../types/blocks'
import { BLOCK_LIBRARY, useBlockLibrary } from '../data/blockLibrary'
import { wallTypeColor } from '../lib/wallTypeColors'
import {
  CURVED_WALL_WEDGE_RADIUS_MM,
  CURVED_WALL_MIN_FEASIBLE_RADIUS_MM,
  curveZoneForRadius,
} from '../lib/blockCalc'

interface WallTypesPanelProps {
  makeups: WallMakeup[]
  activeMakeupId: string
  wallCountsByMakeupId: Record<string, number>
  onSetActive: (id: string) => void
  onAddMakeup: (makeup: WallMakeup) => void
  onUpdateMakeup: (makeup: WallMakeup) => void
  onDeleteMakeup: (id: string) => void
}

function generateMakeupId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

const TILE_BLOCKS: BlockCode[] = ['50.45']

function blockLabel(code: BlockCode): string {
  const b = BLOCK_LIBRARY[code]
  return b ? `${code} — ${b.name}` : code
}

export default function WallTypesPanel({
  makeups,
  activeMakeupId,
  wallCountsByMakeupId,
  onSetActive,
  onAddMakeup,
  onUpdateMakeup,
  onDeleteMakeup,
}: WallTypesPanelProps) {
  /** null = no form; 'new' = adding; otherwise = editing makeup with this id */
  const [editingId, setEditingId] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(true)

  const editingMakeup =
    editingId && editingId !== 'new' ? makeups.find((m) => m.id === editingId) : null

  const activeMakeup = makeups.find((m) => m.id === activeMakeupId)

  // Sort so the active wall type sits at the top of the list and stays there
  // — handy when there are 4+ types and the user spends most of their time
  // drawing with one of them. The remaining types keep their original order
  // so the user's mental map of "the second one I created" doesn't shuffle.
  const orderedMakeups = useMemo(() => {
    if (!activeMakeup) return makeups
    return [activeMakeup, ...makeups.filter((m) => m.id !== activeMakeup.id)]
  }, [makeups, activeMakeup])

  return (
    <div className="my-4 border border-ink-600 rounded-xl bg-ink-800 p-3">
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
              <>· {makeups.length}</>
            )}
          </span>
        </button>
        {expanded && (
          <button
            onClick={() => setEditingId('new')}
            className="text-sm px-2.5 py-1 rounded-lg bg-beme-500 text-black font-medium hover:bg-beme-400 transition-colors flex-shrink-0"
          >
            + Add
          </button>
        )}
      </div>

      {expanded && (
        <>
      <div className="flex flex-col gap-2 pb-1">
        {/* "New" form opens at the very top of the list so an in-progress add
            doesn't shove every existing wall type down out of view. */}
        {editingId === 'new' && (
          <WallTypeForm
            existing={null}
            onSave={(makeup) => {
              onAddMakeup(makeup)
              setEditingId(null)
            }}
            onCancel={() => setEditingId(null)}
          />
        )}
        {orderedMakeups.map((m) => {
          const isActive = m.id === activeMakeupId
          const wallCount = wallCountsByMakeupId[m.id] ?? 0
          const canDelete = makeups.length > 1 && wallCount === 0
          const isEditingThis = editingId === m.id
          return (
            <div key={m.id} className="flex flex-col gap-2">
            <button
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
                {/* Swatch that matches the colour walls of this type are drawn in
                    on the plan. Picked deterministically from a palette by index. */}
                <span
                  className="inline-block w-3 h-3 rounded-sm flex-shrink-0 ring-1 ring-black/30 mt-0.5"
                  style={{ backgroundColor: wallTypeColor(m.id, makeups) }}
                  aria-hidden
                />
                {/* Allow the name to wrap onto multiple lines rather than
                    truncate — the wall-type name is the identity of this
                    entry, so the user always wants it in full even if that
                    means the card grows taller. break-words handles single
                    long names without spaces. */}
                <div className="text-sm font-medium text-ink-100 break-words flex-1 min-w-0">
                  {m.name}
                </div>
              </div>
              {/* Condensed details. Bond + height stay because they're the
                  two facts an estimator checks first; everything else
                  (corners, fractions, base/top blocks) lives behind Edit so
                  the card can give the wall-type NAME the room it needs. */}
              <div className="text-xs text-ink-400">
                {m.bondType} bond · {m.heightMm}mm · Body {m.bodyBlockCode}
              </div>
              {m.courseOverrides && m.courseOverrides.length > 0 && (
                <div className="text-xs text-ink-400 mt-1">
                  {m.courseOverrides.length} course override
                  {m.courseOverrides.length === 1 ? '' : 's'}
                </div>
              )}
              {m.courseSeriesRanges && m.courseSeriesRanges.length > 0 && (
                <div className="text-xs text-ink-400 mt-1">
                  {m.courseSeriesRanges.length} series range
                  {m.courseSeriesRanges.length === 1 ? '' : 's'}
                  {m.courseSeriesRanges.map((r, idx) => {
                    const codes = [
                      r.bodyBlockCode,
                      r.cornerBlockCode,
                      r.baseCourseBlockCode,
                    ]
                      .filter(Boolean)
                      .slice(0, 1)
                      .join(' / ')
                    return (
                      <span key={idx} className="ml-2 font-mono text-ink-500">
                        c{r.fromCourse}
                        {r.toCourse > r.fromCourse ? `–${r.toCourse}` : ''}
                        {codes ? `: ${codes}` : ''}
                      </span>
                    )
                  })}
                </div>
              )}
              <div className="text-xs text-ink-500 mt-2">
                {wallCount} wall{wallCount === 1 ? '' : 's'} using this
              </div>
              <div className="flex gap-3 mt-2">
                <span
                  role="button"
                  tabIndex={0}
                  onClick={(e) => {
                    e.stopPropagation()
                    // Toggle: clicking Edit on the type that's already open
                    // collapses the form instead of leaving it stuck open.
                    setEditingId(isEditingThis ? null : m.id)
                  }}
                  className="text-xs text-beme-400 hover:text-beme-300 hover:underline cursor-pointer"
                >
                  {isEditingThis ? 'Close' : 'Edit'}
                </span>
                {canDelete && (
                  <span
                    role="button"
                    tabIndex={0}
                    onClick={(e) => {
                      e.stopPropagation()
                      if (window.confirm(`Delete wall type "${m.name}"?`)) {
                        onDeleteMakeup(m.id)
                      }
                    }}
                    className="text-xs text-rose-400 hover:text-rose-300 hover:underline cursor-pointer"
                  >
                    Delete
                  </span>
                )}
              </div>
            </button>
            {/* Edit form opens INLINE beneath the wall type being edited so
                the user doesn't have to scroll to find it at the bottom of
                the panel every time. */}
            {isEditingThis && (
              <WallTypeForm
                existing={editingMakeup}
                onSave={(makeup) => {
                  onUpdateMakeup(makeup)
                  setEditingId(null)
                }}
                onCancel={() => setEditingId(null)}
              />
            )}
            </div>
          )
        })}
      </div>
        </>
      )}
    </div>
  )
}

// ---------- Internal: WallTypeForm ----------

interface WallTypeFormProps {
  existing: WallMakeup | null
  onSave: (makeup: WallMakeup) => void
  onCancel: () => void
}

function WallTypeForm({ existing, onSave, onCancel }: WallTypeFormProps) {
  // Re-derive the dropdown options each render so they reflect the user's
  // current library (re-renders when the library changes via useBlockLibrary).
  const { library } = useBlockLibrary()
  const selectableBlocks = useMemo<BlockCode[]>(
    () =>
      Object.values(library)
        .filter((b) => b.code !== '50.45')
        .map((b) => b.code)
        .sort(),
    [library]
  )
  const [name, setName] = useState(existing?.name ?? 'New wall type')
  const [bondType, setBondType] = useState<BondType>(existing?.bondType ?? 'stretcher')
  const [heightMm, setHeightMm] = useState<number>(existing?.heightMm ?? 2400)
  const [useFractions, setUseFractions] = useState(existing?.useFractions ?? true)

  const [baseCourseBlockCode, setBaseCourseBlockCode] = useState<BlockCode>(
    existing?.baseCourseBlockCode ?? '20.45'
  )
  const [baseCourseTileCode, setBaseCourseTileCode] = useState<BlockCode | ''>(
    existing?.baseCourseTileCode ?? '50.45'
  )
  const [bodyBlockCode, setBodyBlockCode] = useState<BlockCode>(
    existing?.bodyBlockCode ?? '20.48'
  )
  const [topCourseBlockCode, setTopCourseBlockCode] = useState<BlockCode>(
    existing?.topCourseBlockCode ?? '20.48'
  )
  // Full + half end-termination blocks. Seeded with 20.01 / 20.03 so the
  // standard SEQ behaviour is the out-of-the-box default, but the user can
  // swap in any block from their library (knockout corners, third-party
  // blocks, etc.). Replaces the old binary "Knockout corners (20.21)"
  // checkbox — that was just one specific override hiding the full
  // freedom this gives.
  const [cornerBlockCode, setCornerBlockCode] = useState<BlockCode>(
    existing?.cornerBlockCode ?? '20.01'
  )
  const [halfBlockCode, setHalfBlockCode] = useState<BlockCode>(
    existing?.halfBlockCode ?? '20.03'
  )

  const [courseOverrides, setCourseOverrides] = useState<CourseOverride[]>(
    existing?.courseOverrides ?? []
  )
  const [showOverrides, setShowOverrides] = useState(
    (existing?.courseOverrides ?? []).length > 0
  )

  function addOverride() {
    setCourseOverrides((prev) => [...prev, { courseNumber: 2, blockCode: '20.48' }])
    setShowOverrides(true)
  }

  function updateOverride(index: number, patch: Partial<CourseOverride>) {
    setCourseOverrides((prev) => prev.map((o, i) => (i === index ? { ...o, ...patch } : o)))
  }

  function removeOverride(index: number) {
    setCourseOverrides((prev) => prev.filter((_, i) => i !== index))
  }

  const [seriesRanges, setSeriesRanges] = useState<CourseSeriesRange[]>(
    existing?.courseSeriesRanges ?? []
  )
  const [showSeriesRanges, setShowSeriesRanges] = useState(
    (existing?.courseSeriesRanges ?? []).length > 0
  )

  /**
   * Add a new series range pre-filled with the 300-series block codes — the
   * common case from the user's brief is "bottom 5 courses use 300 series",
   * so the first-time UX should land on a useful starting point instead of an
   * empty form. If the user wants something else they can change each picker.
   */
  function addSeriesRange() {
    setSeriesRanges((prev) => [
      ...prev,
      {
        fromCourse: 1,
        toCourse: 5,
        bodyBlockCode: '30.48',
        cornerBlockCode: '30.01',
        halfBlockCode: '30.03',
        baseCourseBlockCode: '30.45',
        baseCourseTileCode: '50.45',
        heightMakeup71BlockCode: '30.71',
        // 300-series corners need two 30.02 cube blocks laid between the
        // corner block and the regular body so the next 30.48 lands back on
        // bond — pre-fill the rule so the canonical 300-series setup is one
        // click from a saved makeup.
        cornerLeadInBlockCode: '30.02',
        cornerLeadInCount: 2,
      },
    ])
    setShowSeriesRanges(true)
  }

  function updateSeriesRange(index: number, patch: Partial<CourseSeriesRange>) {
    setSeriesRanges((prev) =>
      prev.map((r, i) => (i === index ? { ...r, ...patch } : r))
    )
  }

  function removeSeriesRange(index: number) {
    setSeriesRanges((prev) => prev.filter((_, i) => i !== index))
  }

  // ---- Curve-makeup state ----
  // A makeup created from a drawn curved wall carries a `curveRadiusMm` so we
  // know to render two block-composition sections (wedge / normal) instead of
  // one. The radius itself is read-only — it's a property of the drawn arc,
  // not something the user changes here.
  const curveRadiusMm = existing?.curveRadiusMm
  const isCurveMakeup = typeof curveRadiusMm === 'number' && isFinite(curveRadiusMm)
  // A curve below the wedge threshold (1500mm centreline) MUST be built with
  // 20.03CW wedges — straight 20.48 won't bend tightly enough. A curve above
  // the threshold uses normal body blocks (cut at the back on the tighter end
  // of that band, no cuts above 6000mm). The disabled section is greyed out
  // with a hint explaining why so the user understands the choice was made
  // for them by the geometry.
  const wedgeRequired = isCurveMakeup && curveRadiusMm < CURVED_WALL_WEDGE_RADIUS_MM
  const curveZone = isCurveMakeup ? curveZoneForRadius(curveRadiusMm) : null
  const wedgeFeasible = isCurveMakeup && curveRadiusMm >= CURVED_WALL_MIN_FEASIBLE_RADIUS_MM
  // Track wedge / normal body block codes separately so toggling between
  // sections doesn't lose the user's pick. If the existing makeup already has
  // a wedge body, seed the wedge state with it; otherwise default to 20.03CW.
  const [wedgeBodyBlockCode, setWedgeBodyBlockCode] = useState<BlockCode>(
    existing && wedgeRequired ? existing.bodyBlockCode : '20.03CW'
  )
  const [normalBodyBlockCode, setNormalBodyBlockCode] = useState<BlockCode>(
    existing && !wedgeRequired && isCurveMakeup ? existing.bodyBlockCode : '20.48'
  )

  function handleSave() {
    const id = existing?.id ?? generateMakeupId()
    // Strip any range with from > to (degenerate) and any whose overrides are
    // all blank (no-op). Saves on bytes and keeps the calc engine's iteration
    // efficient if the user added a range and then cleared it.
    const cleanedRanges = seriesRanges.filter((r) => {
      if (r.toCourse < r.fromCourse) return false
      const anyOverride =
        r.bodyBlockCode ||
        r.cornerBlockCode ||
        r.halfBlockCode ||
        r.baseCourseBlockCode ||
        r.baseCourseTileCode ||
        r.heightMakeup71BlockCode ||
        r.cornerLeadInBlockCode
      return !!anyOverride
    })
    // For curve makeups, the body block comes from whichever section is
    // active (driven by the curve's radius zone). For regular makeups, the
    // single Body picker drives bodyBlockCode the way it always has.
    const resolvedBodyBlockCode: BlockCode = isCurveMakeup
      ? wedgeRequired
        ? wedgeBodyBlockCode
        : normalBodyBlockCode
      : bodyBlockCode
    const updated: WallMakeup = {
      id,
      name: name.trim() || 'New wall type',
      bondType,
      heightMm,
      baseCourseBlockCode,
      baseCourseTileCode: baseCourseTileCode || undefined,
      bodyBlockCode: resolvedBodyBlockCode,
      topCourseBlockCode,
      cornerBlockCode,
      halfBlockCode,
      useFractions,
      courseOverrides: courseOverrides.length > 0 ? courseOverrides : undefined,
      courseSeriesRanges: cleanedRanges.length > 0 ? cleanedRanges : undefined,
      // Preserve the curve marker so editing the makeup doesn't accidentally
      // convert it into a straight-wall makeup on save.
      curveRadiusMm: existing?.curveRadiusMm,
    }
    onSave(updated)
  }

  const canSave = name.trim().length > 0 && heightMm >= 200

  return (
    // When editing an existing wall type, the form reads as a dropdown of
    // the card above: a subtle left-border accent in the active beme colour
    // and no separate frame / background. When creating a new wall type
    // it still gets a faint border + heading so the user knows they're
    // filling in a fresh entry rather than editing one.
    <div
      className={
        existing
          ? 'mt-1 mb-2 pl-3 pr-1 py-2 border-l-2 border-beme-500/40'
          : 'mt-2 mb-3 p-3 border border-ink-600/60 rounded-lg bg-ink-700/30'
      }
    >
      {!existing && (
        <h4 className="text-sm font-semibold mb-3 text-ink-200">New wall type</h4>
      )}
      <div className="grid grid-cols-1 gap-4">
        <label className="text-sm">
          <span className="block text-ink-300 mb-1">Name</span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full px-3 py-1.5 border border-ink-600 rounded-lg text-sm focus:outline-none focus:border-beme-400"
          />
        </label>

        <label className="text-sm">
          <span className="block text-ink-300 mb-1">Height (mm)</span>
          <input
            type="number"
            min="200"
            step="50"
            value={heightMm}
            onChange={(e) => setHeightMm(parseInt(e.target.value || '0', 10))}
            className="w-full px-3 py-1.5 border border-ink-600 rounded-lg text-sm focus:outline-none focus:border-beme-400"
          />
        </label>

        <div className="text-sm">
          <span className="block text-ink-300 mb-1">Bond type</span>
          <div className="flex gap-3">
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input
                type="radio"
                checked={bondType === 'stretcher'}
                onChange={() => setBondType('stretcher')}
              />
              <span>Stretcher</span>
            </label>
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input
                type="radio"
                checked={bondType === 'stack'}
                onChange={() => setBondType('stack')}
              />
              <span>Stack</span>
            </label>
          </div>
        </div>

        <div className="text-sm">
          <span className="block text-ink-300 mb-1">Options</span>
          <div className="flex flex-col gap-1">
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input
                type="checkbox"
                checked={useFractions}
                onChange={(e) => setUseFractions(e.target.checked)}
              />
              <span>Use fractions (20.02 / 20.22)</span>
            </label>
          </div>
        </div>
      </div>

      {/* Curve readout — sits above Block composition so the user always
          knows what radius drove the wedge / normal split, and whether the
          curve is in a feasible build zone (custom-cut warning for the
          tightest band). Read-only on purpose — the radius is a geometric
          property of the drawn arc, edited by moving the curve on the plan. */}
      {isCurveMakeup && (
        <div className="mt-5 p-3 border border-ink-600 rounded-lg bg-ink-800/60">
          <div className="text-xs font-semibold uppercase tracking-wide text-ink-400 mb-1">
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
            <p className="mt-1 text-[11px] text-amber-400">
              This radius is below the wedge feasibility threshold ({CURVED_WALL_MIN_FEASIBLE_RADIUS_MM}
              mm). 20.03CW is the closest stock block but custom-cut blocks will be flagged
              in the estimate.
            </p>
          )}
        </div>
      )}

      {/* Block composition */}
      <div className="mt-5">
        <div className="text-xs font-semibold uppercase tracking-wide text-ink-400 mb-2">
          Block composition
        </div>

        {/* Curve makeups: two side-by-side sections so the user sees both
            paths the wall could take, with the one that doesn't match the
            radius disabled and explained. Keeps the wedge/normal mental
            model in front of the user without letting them choose the
            wrong path for the geometry. */}
        {isCurveMakeup ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3">
            {/* Wedge section */}
            <div
              className={`p-3 border rounded-lg ${
                wedgeRequired
                  ? 'border-beme-500/60 bg-ink-800'
                  : 'border-ink-600 bg-ink-800/40 opacity-50'
              }`}
              aria-disabled={!wedgeRequired}
            >
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-semibold text-ink-200">
                  Wedge (20.03CW)
                </span>
                {wedgeRequired ? (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-beme-500 text-black font-medium">
                    Active
                  </span>
                ) : (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-ink-700 text-ink-400">
                    Disabled
                  </span>
                )}
              </div>
              <label className="text-sm block">
                <span className="block text-ink-300 mb-1 text-xs">Wedge body block</span>
                <select
                  value={wedgeBodyBlockCode}
                  onChange={(e) => setWedgeBodyBlockCode(e.target.value as BlockCode)}
                  disabled={!wedgeRequired}
                  className="w-full px-3 py-1.5 border border-ink-600 rounded-lg text-sm bg-ink-800 focus:outline-none focus:border-beme-400 disabled:cursor-not-allowed"
                >
                  {selectableBlocks.map((code) => (
                    <option key={code} value={code}>
                      {blockLabel(code)}
                    </option>
                  ))}
                </select>
              </label>
              <p className="mt-2 text-[11px] text-ink-400 leading-snug">
                {wedgeRequired
                  ? wedgeFeasible
                    ? `Required for R < ${CURVED_WALL_WEDGE_RADIUS_MM}mm — wedge taper absorbs the curve.`
                    : `R is below the wedge feasibility floor — closest stock block selected; custom cuts will be flagged.`
                  : `Not applicable at R${Math.round(curveRadiusMm!)}mm — normal blocks fit.`}
              </p>
            </div>

            {/* Normal-block section */}
            <div
              className={`p-3 border rounded-lg ${
                !wedgeRequired
                  ? 'border-beme-500/60 bg-ink-800'
                  : 'border-ink-600 bg-ink-800/40 opacity-50'
              }`}
              aria-disabled={wedgeRequired}
            >
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-semibold text-ink-200">
                  Normal blocks (20.48)
                </span>
                {!wedgeRequired ? (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-beme-500 text-black font-medium">
                    Active
                  </span>
                ) : (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-ink-700 text-ink-400">
                    Disabled
                  </span>
                )}
              </div>
              <label className="text-sm block">
                <span className="block text-ink-300 mb-1 text-xs">Normal body block</span>
                <select
                  value={normalBodyBlockCode}
                  onChange={(e) => setNormalBodyBlockCode(e.target.value as BlockCode)}
                  disabled={wedgeRequired}
                  className="w-full px-3 py-1.5 border border-ink-600 rounded-lg text-sm bg-ink-800 focus:outline-none focus:border-beme-400 disabled:cursor-not-allowed"
                >
                  {selectableBlocks.map((code) => (
                    <option key={code} value={code}>
                      {blockLabel(code)}
                    </option>
                  ))}
                </select>
              </label>
              <p className="mt-2 text-[11px] text-ink-400 leading-snug">
                {!wedgeRequired
                  ? curveZone === 'cut'
                    ? `Active at R${Math.round(curveRadiusMm!)}mm — cut at the back of each block (called out in assumptions).`
                    : `Active at R${Math.round(curveRadiusMm!)}mm — stock blocks fit without cuts.`
                  : `Not applicable below R${CURVED_WALL_WEDGE_RADIUS_MM}mm — wedge required.`}
              </p>
            </div>
          </div>
        ) : null}

        <div className="grid grid-cols-1 gap-3">
          <label className="text-sm">
            <span className="block text-ink-300 mb-1">Base course block</span>
            <select
              value={baseCourseBlockCode}
              onChange={(e) => setBaseCourseBlockCode(e.target.value as BlockCode)}
              className="w-full px-3 py-1.5 border border-ink-600 rounded-lg text-sm bg-ink-800 focus:outline-none focus:border-beme-400"
            >
              {selectableBlocks.map((code) => (
                <option key={code} value={code}>
                  {blockLabel(code)}
                </option>
              ))}
            </select>
          </label>

          <label className="text-sm">
            <span className="block text-ink-300 mb-1">Base course tile (paired)</span>
            <select
              value={baseCourseTileCode}
              onChange={(e) => setBaseCourseTileCode(e.target.value as BlockCode | '')}
              className="w-full px-3 py-1.5 border border-ink-600 rounded-lg text-sm bg-ink-800 focus:outline-none focus:border-beme-400"
            >
              <option value="">None</option>
              {TILE_BLOCKS.map((code) => (
                <option key={code} value={code}>
                  {blockLabel(code)}
                </option>
              ))}
            </select>
          </label>

          {/* For curve makeups the single Body picker is hidden — the dual
              section above replaces it. We still render Base / Top here so the
              user can tweak the bottom/top of a curved wall. */}
          {!isCurveMakeup && (
            <label className="text-sm">
              <span className="block text-ink-300 mb-1">Body course block</span>
              <select
                value={bodyBlockCode}
                onChange={(e) => setBodyBlockCode(e.target.value as BlockCode)}
                className="w-full px-3 py-1.5 border border-ink-600 rounded-lg text-sm bg-ink-800 focus:outline-none focus:border-beme-400"
              >
                {selectableBlocks.map((code) => (
                  <option key={code} value={code}>
                    {blockLabel(code)}
                  </option>
                ))}
              </select>
            </label>
          )}

          <label className="text-sm">
            <span className="block text-ink-300 mb-1">Top course block</span>
            <select
              value={topCourseBlockCode}
              onChange={(e) => setTopCourseBlockCode(e.target.value as BlockCode)}
              className="w-full px-3 py-1.5 border border-ink-600 rounded-lg text-sm bg-ink-800 focus:outline-none focus:border-beme-400"
            >
              {selectableBlocks.map((code) => (
                <option key={code} value={code}>
                  {blockLabel(code)}
                </option>
              ))}
            </select>
          </label>

          {/* End terminations — full and half. Defaulted to 20.01 / 20.03
              for SEQ usage but every block in the library is selectable
              here so an org can wire their preferred terminations in once
              per wall type. Used at corners (full) and at free /
              T-junction / control-joint ends (alternating full + half on
              stretcher bond). */}
          <label className="text-sm">
            <span className="block text-ink-300 mb-1">Full end termination</span>
            <select
              value={cornerBlockCode}
              onChange={(e) => setCornerBlockCode(e.target.value as BlockCode)}
              className="w-full px-3 py-1.5 border border-ink-600 rounded-lg text-sm bg-ink-800 focus:outline-none focus:border-beme-400"
            >
              {selectableBlocks.map((code) => (
                <option key={code} value={code}>
                  {blockLabel(code)}
                </option>
              ))}
            </select>
            <span className="text-[11px] text-ink-400 mt-1 block">
              Used at corners + on odd courses of stretcher bond at free ends. Default 20.01.
            </span>
          </label>

          <label className="text-sm">
            <span className="block text-ink-300 mb-1">Half end termination</span>
            <select
              value={halfBlockCode}
              onChange={(e) => setHalfBlockCode(e.target.value as BlockCode)}
              className="w-full px-3 py-1.5 border border-ink-600 rounded-lg text-sm bg-ink-800 focus:outline-none focus:border-beme-400"
            >
              {selectableBlocks.map((code) => (
                <option key={code} value={code}>
                  {blockLabel(code)}
                </option>
              ))}
            </select>
            <span className="text-[11px] text-ink-400 mt-1 block">
              Alternates with the full end block on even courses of stretcher bond at free ends. Default 20.03.
            </span>
          </label>
        </div>
      </div>

      {/* Per-course overrides */}
      <div className="mt-5">
        <button
          onClick={() => setShowOverrides((v) => !v)}
          className="text-sm text-beme-400 hover:text-beme-300 hover:underline"
        >
          {showOverrides ? '−' : '+'} Customise specific courses
          {courseOverrides.length > 0 && ` (${courseOverrides.length})`}
        </button>

        {showOverrides && (
          <div className="mt-2 p-3 border border-ink-600 rounded-lg bg-ink-800">
            {courseOverrides.length === 0 && (
              <p className="text-xs text-ink-400 mb-2">
                Override the block used on a specific course (e.g. a 20.140 row mid-wall for height makeup,
                or an intermediate 20.20 bond beam).
              </p>
            )}
            {courseOverrides.map((override, i) => (
              <div key={i} className="flex items-center gap-2 mb-2 text-sm flex-wrap">
                <span className="text-ink-300">Course</span>
                <input
                  type="number"
                  min="1"
                  value={override.courseNumber}
                  onChange={(e) =>
                    updateOverride(i, { courseNumber: parseInt(e.target.value || '1', 10) })
                  }
                  className="w-16 px-2 py-1 border border-ink-600 rounded text-sm"
                />
                <span className="text-ink-300">uses block</span>
                <select
                  value={override.blockCode}
                  onChange={(e) => updateOverride(i, { blockCode: e.target.value as BlockCode })}
                  className="px-2 py-1 border border-ink-600 rounded text-sm bg-ink-800"
                >
                  {selectableBlocks.map((code) => (
                    <option key={code} value={code}>
                      {blockLabel(code)}
                    </option>
                  ))}
                </select>
                <button
                  onClick={() => removeOverride(i)}
                  className="text-rose-400 hover:text-rose-300 text-sm px-2"
                  aria-label="Remove override"
                >
                  ×
                </button>
              </div>
            ))}
            <button
              onClick={addOverride}
              className="text-sm text-beme-400 hover:text-beme-300 hover:underline"
            >
              + Add course override
            </button>
          </div>
        )}
      </div>

      {/* Course-series ranges — let the user mix series across courses, e.g.
          300 series for the base 5 courses for an engineered footing, then
          standard 200 series above. Each range overrides any subset of the
          role-based block picks; anything left on "Default" falls back to the
          makeup-level field above. */}
      <div className="mt-5">
        <button
          onClick={() => setShowSeriesRanges((v) => !v)}
          className="text-sm text-beme-400 hover:text-beme-300 hover:underline"
        >
          {showSeriesRanges ? '−' : '+'} Mix block series across courses
          {seriesRanges.length > 0 && ` (${seriesRanges.length})`}
        </button>

        {showSeriesRanges && (
          <div className="mt-2 p-3 border border-ink-600 rounded-lg bg-ink-800">
            {seriesRanges.length === 0 && (
              <p className="text-xs text-ink-400 mb-2">
                Use a different block series for a range of courses — e.g. when
                engineering calls for 300-series (290 mm-deep) blocks on the
                bottom 5 courses, stepping down to standard 200 series above.
                Each range can override any subset of the role-based picks;
                leave a field on Default to inherit from the makeup above.
              </p>
            )}
            {seriesRanges.map((range, i) => (
              <RangeRow
                key={i}
                range={range}
                selectableBlocks={selectableBlocks}
                onChange={(patch) => updateSeriesRange(i, patch)}
                onRemove={() => removeSeriesRange(i)}
              />
            ))}
            <button
              onClick={addSeriesRange}
              className="text-sm text-beme-400 hover:text-beme-300 hover:underline"
            >
              + Add series range
            </button>
          </div>
        )}
      </div>

      <div className="flex gap-2 mt-5">
        <button
          onClick={handleSave}
          disabled={!canSave}
          className="px-4 py-1.5 rounded-lg bg-beme-600 text-white text-sm hover:bg-beme-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors font-medium"
        >
          {existing ? 'Save changes' : 'Create wall type'}
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

// ---------- Internal: RangeRow ----------

interface RangeRowProps {
  range: CourseSeriesRange
  selectableBlocks: BlockCode[]
  onChange: (patch: Partial<CourseSeriesRange>) => void
  onRemove: () => void
}

/**
 * One series range editor. Course bounds on the top line, then a 2-column
 * grid of optional block-code overrides (each with a Default option that
 * stores the field as undefined so the calc engine falls back to the
 * makeup-level pick). Kept compact because a user will typically have only
 * one or two ranges per wall type.
 */
function RangeRow({ range, selectableBlocks, onChange, onRemove }: RangeRowProps) {
  return (
    <div className="mb-3 p-2 border border-ink-600 rounded bg-ink-700/30">
      <div className="flex items-center gap-2 mb-2 text-sm flex-wrap">
        <span className="text-ink-300">Courses</span>
        <input
          type="number"
          min="1"
          value={range.fromCourse}
          onChange={(e) =>
            onChange({ fromCourse: Math.max(1, parseInt(e.target.value || '1', 10)) })
          }
          className="w-16 px-2 py-1 border border-ink-600 rounded text-sm"
        />
        <span className="text-ink-300">to</span>
        <input
          type="number"
          min="1"
          value={range.toCourse}
          onChange={(e) =>
            onChange({ toCourse: Math.max(1, parseInt(e.target.value || '1', 10)) })
          }
          className="w-16 px-2 py-1 border border-ink-600 rounded text-sm"
        />
        <span className="text-xs text-ink-500">(1 = base course)</span>
        <button
          onClick={onRemove}
          className="ml-auto text-rose-400 hover:text-rose-300 text-sm px-2"
          aria-label="Remove range"
        >
          ×
        </button>
      </div>

      <div className="grid grid-cols-2 gap-2 text-xs">
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
          label="Base tile (paired)"
          value={range.baseCourseTileCode}
          options={['50.45'] as BlockCode[]}
          onChange={(v) => onChange({ baseCourseTileCode: v })}
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
        <p className="mt-1 text-[10px] text-ink-500">
          Two {range.cornerLeadInBlockCode} blocks placed between the corner block and the
          body on every course at a corner end. Free / T-junction / control-joint ends are
          unaffected.
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
        className="w-full px-2 py-1 border border-ink-600 rounded text-xs bg-ink-800"
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
