import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import type {
  PierMakeup,
  WallMakeup,
  BondType,
  CourseBand,
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
import {
  convertMakeupToBands,
  getMakeupHeightMm,
  moduleHeightForBand,
} from '../lib/makeups'

interface WallTypesPanelProps {
  makeups: WallMakeup[]
  activeMakeupId: string
  wallCountsByMakeupId: Record<string, number>
  onSetActive: (id: string) => void
  onAddMakeup: (makeup: WallMakeup) => void
  onUpdateMakeup: (makeup: WallMakeup) => void
  onDeleteMakeup: (id: string) => void

  /** Pier types now live in this same panel as a separate card group. */
  pierMakeups: PierMakeup[]
  pierCountsByMakeupId: Record<string, number>
  onAddPierMakeup: (makeup: PierMakeup) => void
  onUpdatePierMakeup: (makeup: PierMakeup) => void
  onDeletePierMakeup: (id: string) => void
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
  pierMakeups,
  pierCountsByMakeupId,
  onAddPierMakeup,
  onUpdatePierMakeup,
  onDeletePierMakeup,
}: WallTypesPanelProps) {
  /** null = no form; 'new' = adding; otherwise = editing makeup with this id */
  const [editingId, setEditingId] = useState<string | null>(null)
  /** Same pattern for piers — null = none open, 'new' = adding, id = editing */
  const [editingPierId, setEditingPierId] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(true)
  const editingPierMakeup =
    editingPierId && editingPierId !== 'new'
      ? pierMakeups.find((m) => m.id === editingPierId)
      : null

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
                  {/* Swatch that matches the colour walls of this type are drawn in
                      on the plan. Picked deterministically from a palette by index. */}
                  <span
                    className="inline-block w-3 h-3 rounded-sm flex-shrink-0 ring-1 ring-black/30 mt-0.5"
                    style={{ backgroundColor: wallTypeColor(m.id, makeups) }}
                    aria-hidden
                  />
                  <div className="text-sm font-medium text-ink-100 break-words flex-1 min-w-0">
                    {m.name}
                  </div>
                </div>
                <div className="text-xs text-ink-400">
                  {m.bondType} bond · {getMakeupHeightMm(m)}mm · Body {m.bodyBlockCode}
                </div>
                {m.coursePattern && m.coursePattern.length > 0 && (
                  <div className="text-xs text-beme-300 mt-1 font-mono">
                    Pattern:{' '}
                    {m.coursePattern.map((b) => `${b.count}×${b.blockCode}`).join(' + ')}
                  </div>
                )}
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
                      setEditingId(m.id)
                    }}
                    className="text-xs text-beme-400 hover:text-beme-300 hover:underline cursor-pointer"
                  >
                    Edit
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
            )
          })}
        </div>
      )}

      {/* Pier types — listed in the same panel so the right rail has one
          "types" container instead of two. Visually separated with a
          subheader + divider; cards use a stack of circle markers so the
          eye picks them out from the wall-type swatches above. */}
      {expanded && (
        <div className="mt-4 pt-3 border-t border-ink-700">
          <div className="flex items-center justify-between mb-2 gap-2">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-ink-400">
              Pier types
              <span className="ml-2 text-ink-500 font-normal normal-case">
                · {pierMakeups.length}
              </span>
            </h4>
            <button
              onClick={() => setEditingPierId('new')}
              className="text-xs px-2 py-0.5 rounded-lg border border-ink-600 text-ink-200 hover:bg-ink-700 transition-colors"
            >
              + Add pier
            </button>
          </div>
          <div className="flex flex-col gap-2">
            {pierMakeups.length === 0 && (
              <p className="text-[11px] text-ink-500 italic px-1">
                No pier types yet. Add one to drop tied or freestanding piers on
                the plan.
              </p>
            )}
            {pierMakeups.map((pm) => {
              const usage = pierCountsByMakeupId[pm.id] ?? 0
              const canDelete = pierMakeups.length > 1 && usage === 0
              return (
                <div
                  key={pm.id}
                  className="w-full p-2.5 rounded-lg border border-ink-600 bg-ink-700/40"
                >
                  <div className="flex items-start gap-2 mb-1">
                    {/* Stack of circle dots to differentiate from the wall
                        swatch above (square block). Reads as "column of
                        blocks" which is what a pier is. */}
                    <span className="text-ink-400 leading-[0.6] text-lg mt-0.5 flex-shrink-0">
                      ⦿
                    </span>
                    <div className="text-sm font-medium text-ink-100 break-words flex-1 min-w-0">
                      {pm.name}
                    </div>
                  </div>
                  <div className="text-xs text-ink-400">
                    {pm.suggestedPlacement === 'tied' ? 'Tied' : 'Freestanding'} ·{' '}
                    Pattern{' '}
                    <span className="font-mono">
                      {pm.coursePattern.join(' / ')}
                    </span>
                  </div>
                  <div className="text-xs text-ink-500 mt-1.5">
                    {usage} pier{usage === 1 ? '' : 's'} using this
                  </div>
                  <div className="flex gap-3 mt-1.5">
                    <span
                      role="button"
                      tabIndex={0}
                      onClick={() => setEditingPierId(pm.id)}
                      className="text-xs text-beme-400 hover:text-beme-300 hover:underline cursor-pointer"
                    >
                      Edit
                    </span>
                    {canDelete && (
                      <span
                        role="button"
                        tabIndex={0}
                        onClick={() => {
                          if (window.confirm(`Delete pier type "${pm.name}"?`)) {
                            onDeletePierMakeup(pm.id)
                          }
                        }}
                        className="text-xs text-rose-400 hover:text-rose-300 hover:underline cursor-pointer"
                      >
                        Delete
                      </span>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Modal lives at the panel root so it floats over everything, not
          inline in the list. Mounted only while editing/adding so the form
          state (and its hooks) get fresh defaults each open. */}
      {editingId !== null && (
        <WallTypeEditorModal
          existing={editingId === 'new' ? null : editingMakeup}
          onCancel={() => setEditingId(null)}
          onSave={(m) => {
            if (editingId === 'new') onAddMakeup(m)
            else onUpdateMakeup(m)
            setEditingId(null)
          }}
        />
      )}

      {editingPierId !== null && (
        <PierTypeEditorModal
          existing={editingPierId === 'new' ? null : editingPierMakeup}
          onCancel={() => setEditingPierId(null)}
          onSave={(pm) => {
            if (editingPierId === 'new') onAddPierMakeup(pm)
            else onUpdatePierMakeup(pm)
            setEditingPierId(null)
          }}
        />
      )}
    </div>
  )
}

// ---------- Internal: WallTypeEditorModal ----------

type TabKey = 'basics' | 'composition' | 'pattern' | 'advanced'

interface WallTypeEditorModalProps {
  existing: WallMakeup | null
  onSave: (makeup: WallMakeup) => void
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
function WallTypeEditorModal({ existing, onSave, onCancel }: WallTypeEditorModalProps) {
  const { library } = useBlockLibrary()
  const selectableBlocks = useMemo<BlockCode[]>(
    () =>
      Object.values(library)
        .filter((b) => b.code !== '50.45')
        .map((b) => b.code)
        .sort(),
    [library]
  )

  const [activeTab, setActiveTab] = useState<TabKey>('basics')
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
  const [cornerBlockCode, setCornerBlockCode] = useState<BlockCode>(
    existing?.cornerBlockCode ?? '20.01'
  )
  const [halfBlockCode, setHalfBlockCode] = useState<BlockCode>(
    existing?.halfBlockCode ?? '20.03'
  )

  const [courseOverrides, setCourseOverrides] = useState<CourseOverride[]>(
    existing?.courseOverrides ?? []
  )

  // ---- Course pattern (bands) state ----
  const [coursePattern, setCoursePattern] = useState<CourseBand[]>(
    existing?.coursePattern ?? []
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
    setCoursePattern((prev) => [
      ...prev,
      { blockCode: bodyBlockCode || '20.48', count: 1 },
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

  function convertCurrentToBands() {
    const draft: WallMakeup = {
      id: existing?.id ?? 'draft',
      name,
      bondType,
      heightMm,
      baseCourseBlockCode,
      baseCourseTileCode: baseCourseTileCode || undefined,
      bodyBlockCode,
      topCourseBlockCode,
      cornerBlockCode,
      halfBlockCode,
      useFractions,
      courseOverrides,
    }
    const { bands, lossy } = convertMakeupToBands(draft)
    if (bands.length === 0) {
      window.alert('Wall is too short to convert (less than one course).')
      return
    }
    if (
      lossy &&
      !window.confirm(
        'This wall type has per-course overrides which can’t be translated band-for-band. ' +
          'Convert anyway? The overrides will be cleared.'
      )
    ) {
      return
    }
    setCoursePattern(bands)
    if (lossy) setCourseOverrides([])
  }

  function clearCoursePattern() {
    if (
      !window.confirm(
        'Clear the course pattern and revert this wall type to the uniform-height makeup? ' +
          'The Height field will take over again.'
      )
    ) {
      return
    }
    setCoursePattern([])
  }

  function addOverride() {
    setCourseOverrides((prev) => [...prev, { courseNumber: 2, blockCode: '20.48' }])
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
    existing?.courseSeriesRanges ?? []
  )

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
        cornerLeadInBlockCode: '30.02',
        cornerLeadInCount: 2,
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
    existing && wedgeRequired ? existing.bodyBlockCode : '20.03CW'
  )
  const [normalBodyBlockCode, setNormalBodyBlockCode] = useState<BlockCode>(
    existing && !wedgeRequired && isCurveMakeup ? existing.bodyBlockCode : '20.48'
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
      baseCourseTileCode: baseCourseTileCode || undefined,
      bodyBlockCode: resolvedBodyForPreview,
      topCourseBlockCode,
      cornerBlockCode,
      halfBlockCode,
      useFractions,
    }
    return convertMakeupToBands(draft).bands
  }, [
    coursePattern,
    existing?.id,
    name,
    bondType,
    heightMm,
    baseCourseBlockCode,
    baseCourseTileCode,
    bodyBlockCode,
    topCourseBlockCode,
    cornerBlockCode,
    halfBlockCode,
    useFractions,
    isCurveMakeup,
    wedgeRequired,
    wedgeBodyBlockCode,
    normalBodyBlockCode,
  ])

  function handleSave() {
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
      bondType,
      heightMm: finalHeightMm,
      baseCourseBlockCode,
      baseCourseTileCode: baseCourseTileCode || undefined,
      bodyBlockCode: resolvedBodyBlockCode,
      topCourseBlockCode,
      cornerBlockCode,
      halfBlockCode,
      useFractions,
      courseOverrides: courseOverrides.length > 0 ? courseOverrides : undefined,
      courseSeriesRanges: cleanedRanges.length > 0 ? cleanedRanges : undefined,
      coursePattern: cleanedPattern.length > 0 ? cleanedPattern : undefined,
      curveRadiusMm: existing?.curveRadiusMm,
    }
    onSave(updated)
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

  const tabs: { key: TabKey; label: string; badge?: string; disabled?: boolean }[] = [
    { key: 'basics', label: 'Basics' },
    {
      key: 'composition',
      label: isCurveMakeup ? 'Composition (curve)' : 'Composition',
    },
    {
      key: 'pattern',
      label: 'Course pattern',
      badge: hasCoursePattern ? `${coursePattern.length}` : undefined,
      disabled: wedgeDisablesCourseMix,
    },
    {
      key: 'advanced',
      label: 'Advanced',
      badge:
        courseOverrides.length + seriesRanges.length > 0
          ? `${courseOverrides.length + seriesRanges.length}`
          : undefined,
      disabled: wedgeDisablesCourseMix,
    },
  ]

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
                  title={t.disabled ? 'Not applicable for wedge curves' : undefined}
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
                baseCourseTileCode={baseCourseTileCode}
                setBaseCourseTileCode={setBaseCourseTileCode}
                bodyBlockCode={bodyBlockCode}
                setBodyBlockCode={setBodyBlockCode}
                topCourseBlockCode={topCourseBlockCode}
                setTopCourseBlockCode={setTopCourseBlockCode}
                cornerBlockCode={cornerBlockCode}
                setCornerBlockCode={setCornerBlockCode}
                halfBlockCode={halfBlockCode}
                setHalfBlockCode={setHalfBlockCode}
                selectableBlocks={selectableBlocks}
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
                cornerBlockCode={cornerBlockCode}
                halfBlockCode={halfBlockCode}
              />
            </div>
            {/* Tiny legend so the user can map cell colour → block code at
                a glance. Shows whatever distinct codes appear in the
                preview right now (body bands + corner + half). */}
            <PreviewLegend
              bands={previewBands}
              cornerBlockCode={cornerBlockCode}
              halfBlockCode={halfBlockCode}
              bondType={bondType}
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
        <input
          type="number"
          min="200"
          step="50"
          value={hasCoursePattern ? patternTotalHeight : heightMm}
          onChange={(e) => setHeightMm(parseInt(e.target.value || '0', 10))}
          disabled={hasCoursePattern}
          className="w-full px-3 py-2 border border-ink-600 rounded-lg text-sm bg-ink-900 focus:outline-none focus:border-beme-400 disabled:bg-ink-800 disabled:text-ink-400 disabled:cursor-not-allowed"
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
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={useFractions}
            onChange={(e) => setUseFractions(e.target.checked)}
          />
          <span>Use fractions (20.02 / 20.22)</span>
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
  baseCourseTileCode: BlockCode | ''
  setBaseCourseTileCode: (v: BlockCode | '') => void
  bodyBlockCode: BlockCode
  setBodyBlockCode: (v: BlockCode) => void
  topCourseBlockCode: BlockCode
  setTopCourseBlockCode: (v: BlockCode) => void
  cornerBlockCode: BlockCode
  setCornerBlockCode: (v: BlockCode) => void
  halfBlockCode: BlockCode
  setHalfBlockCode: (v: BlockCode) => void
  selectableBlocks: BlockCode[]
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
    baseCourseTileCode,
    setBaseCourseTileCode,
    bodyBlockCode,
    setBodyBlockCode,
    topCourseBlockCode,
    setTopCourseBlockCode,
    cornerBlockCode,
    setCornerBlockCode,
    halfBlockCode,
    setHalfBlockCode,
    selectableBlocks,
  } = props

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

      <section
        className={`grid grid-cols-1 md:grid-cols-2 gap-4 ${
          isCurveMakeup && wedgeRequired
            ? 'opacity-40 pointer-events-none select-none'
            : ''
        }`}
      >
        <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-400 -mb-2 col-span-full">
          Course block roles
        </h3>
        <BlockSelect
          label="Base course block"
          value={baseCourseBlockCode}
          onChange={setBaseCourseBlockCode}
          options={selectableBlocks}
        />
        <BlockSelect
          label="Base course tile (paired)"
          value={baseCourseTileCode || ''}
          onChange={(v) => setBaseCourseTileCode(v as BlockCode | '')}
          options={['', ...TILE_BLOCKS] as (BlockCode | '')[]}
          allowEmpty
        />
        {!isCurveMakeup && (
          <BlockSelect
            label="Body course block"
            value={bodyBlockCode}
            onChange={setBodyBlockCode}
            options={selectableBlocks}
          />
        )}
        <BlockSelect
          label="Top course block"
          value={topCourseBlockCode}
          onChange={setTopCourseBlockCode}
          options={selectableBlocks}
        />
        <div>
          <BlockSelect
            label="Full end termination"
            value={cornerBlockCode}
            onChange={setCornerBlockCode}
            options={selectableBlocks}
          />
          <p className="text-[11px] text-ink-500 mt-1">
            Used at corners + odd courses of stretcher bond at free ends.
          </p>
        </div>
        <div>
          <BlockSelect
            label="Half end termination"
            value={halfBlockCode}
            onChange={setHalfBlockCode}
            options={selectableBlocks}
          />
          <p className="text-[11px] text-ink-500 mt-1">
            Alternates with the full end block on even courses of stretcher bond.
          </p>
        </div>
      </section>

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

/**
 * Stable colour from a block code. Same block code always renders the
 * same hue, but visually-similar codes (e.g. 20.45 vs 20.48) get
 * well-separated hues — the old *31 polynomial hash gave them adjacent
 * values because only the last char changes by 3.
 *
 * Mixing strategy:
 *   - FNV-1a base (XOR the byte before multiplying) so a small change
 *     in any char propagates across all 32 bits.
 *   - Per-char xxhash-32 finalisation rounds (xorshift + multiply with
 *     two big primes) so even a 3-bit difference in the input avalanches
 *     into the high bits before the next char folds in.
 *   - Golden-angle (~137.508°) hue distribution so consecutive hashes
 *     land on opposite sides of the colour wheel — maximises perceptual
 *     separation when several codes happen to hash close together.
 *
 * For the typical SEQ block set (20.48 / 20.01 / 20.03 / 20.71 / 20.45
 * etc.) this gives 100°+ of hue separation between every commonly-paired
 * code. Some pairs (e.g. 20.18 / 20.20) can still land within 10–20°
 * — the legend under the preview disambiguates those.
 */
function bandColor(code: BlockCode): string {
  let h = 0x811c9dc5 // FNV-1a offset basis
  for (let i = 0; i < code.length; i++) {
    h += code.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
    h ^= h >>> 15
    h = Math.imul(h, 0x85ebca6b)
    h ^= h >>> 13
    h = Math.imul(h, 0xc2b2ae35)
    h ^= h >>> 16
  }
  const hue = ((h >>> 0) * 137.508) % 360
  // Soft, light tones matching the wall-makeup palette (Tailwind-500-ish
  // mid-saturation, mid-light) rather than the saturated dark hues the
  // first pass used. Reads as a soft elevation drawing instead of
  // hi-vis stage markings.
  return `hsl(${hue}, 55%, 62%)`
}

/**
 * Tiny legend under the preview that maps each colour swatch to its block
 * code. Lists the body blocks from every band in the preview, plus the
 * corner / half end-termination codes (only the relevant ones for the
 * active bond type — stack bond doesn't use halves).
 */
function PreviewLegend({
  bands,
  cornerBlockCode,
  halfBlockCode,
  bondType,
}: {
  bands: CourseBand[]
  cornerBlockCode: BlockCode
  halfBlockCode: BlockCode
  bondType: BondType
}) {
  // Collect distinct codes the preview will actually render: every body
  // band + the corner + (for stretcher) the half block. De-dupe so a
  // wall using 20.48 as both body and end doesn't list the same swatch
  // twice.
  const items: { code: BlockCode; role: string }[] = []
  const seen = new Set<BlockCode>()
  function push(code: BlockCode, role: string) {
    if (!code || seen.has(code)) return
    seen.add(code)
    items.push({ code, role })
  }
  for (const b of bands) if (b.count > 0) push(b.blockCode, 'body')
  push(cornerBlockCode, 'corner')
  if (bondType === 'stretcher') push(halfBlockCode, 'half end')

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
              style={{ backgroundColor: bandColor(it.code) }}
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
  /** Full-block end termination (e.g. 20.01) — drawn at the ends of every
   *  course in stack bond + odd courses in stretcher bond. */
  cornerBlockCode: BlockCode
  /** Half-block end termination (e.g. 20.03) — drawn at the ends of even
   *  courses in stretcher bond, creating the half-block offset that
   *  defines the bond pattern visually. */
  halfBlockCode: BlockCode
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
  cornerBlockCode,
  halfBlockCode,
}: CoursePatternPreviewProps) {
  const visible = bands.filter((b) => b.count > 0)
  // Expand the band list into a flat per-course block-code array so we
  // can lay out each course independently — needed because course N+1
  // might use a different block code from course N (e.g. 20.48 → 20.71).
  const courses: BlockCode[] = []
  for (const band of visible) {
    for (let i = 0; i < band.count; i++) courses.push(band.blockCode)
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

  // Representative number of BODY blocks across the wall section. The
  // end-termination columns sit either side, so the total visual width
  // is BLOCKS_ACROSS + 2 full-block units. On stretcher even courses
  // the end blocks are half-width and an extra body block fills in,
  // matching how the real wall maths works out (the wall length is the
  // same, the body count and end-block widths flip together).
  const BLOCKS_ACROSS = 4
  const TOTAL_UNITS = BLOCKS_ACROSS + 2 // full-block widths total
  const fullPct = 100 / TOTAL_UNITS
  const halfPct = 50 / TOTAL_UNITS

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
    <div className="flex gap-2 h-full min-h-[280px]">
      {/* Wall section. Each course is a row; blocks within a row stretch
          to fill the row width proportionally. Stretcher even-course
          offset is achieved by inserting half-width filler blocks at
          each end so the visible course is still the same total width.
          h-full + min-h-0 lets the preview obey its parent's flex slot
          (so the legend below always has room) while still claiming a
          sensible floor on tiny viewports. */}
      <div className="flex-1 max-w-[240px] flex flex-col-reverse rounded-md overflow-hidden border-2 border-ink-600 bg-ink-950 shadow-inner min-h-0">
        {courses.map((code, courseIdx) => {
          // courseIdx 0 = bottom of wall (base). flex-col-reverse means
          // we render the array in normal order but DOM/visual order is
          // reversed so course[0] sits at the bottom of the column.
          const courseNum = courseIdx + 1 // 1-indexed
          const h = heightOf(code)
          const pct = (h / totalHeight) * 100
          const isEven = courseNum % 2 === 0
          const useHalves = bondType === 'stretcher' && isEven

          // Build the cells for this course. End-termination cells use
          // the cornerBlockCode / halfBlockCode colours so the user can
          // see where the corner and half blocks land; body cells use
          // the band's blockCode colour.
          const bodyFill = bandColor(code)
          const cornerFill = bandColor(cornerBlockCode)
          const halfFill = bandColor(halfBlockCode)
          const cells: { widthPct: number; color: string; label: string }[] = []
          if (useHalves) {
            // Stretcher even: half end + (BLOCKS_ACROSS + 1) body + half
            // end. Total = 0.5 + (n+1) + 0.5 = n + 2 full-block widths,
            // same total as the odd-course row below — that's why the
            // bond pattern reads as an offset rather than a width change.
            cells.push({ widthPct: halfPct, color: halfFill, label: halfBlockCode })
            for (let i = 0; i < BLOCKS_ACROSS + 1; i++) {
              cells.push({ widthPct: fullPct, color: bodyFill, label: code })
            }
            cells.push({ widthPct: halfPct, color: halfFill, label: halfBlockCode })
          } else {
            // Stack bond OR stretcher odd: full end + N body + full end.
            cells.push({ widthPct: fullPct, color: cornerFill, label: cornerBlockCode })
            for (let i = 0; i < BLOCKS_ACROSS; i++) {
              cells.push({ widthPct: fullPct, color: bodyFill, label: code })
            }
            cells.push({ widthPct: fullPct, color: cornerFill, label: cornerBlockCode })
          }

          return (
            <div
              key={courseIdx}
              style={{ flexBasis: `${pct}%`, minHeight: 0 }}
              className="flex w-full border-b border-black/40 last:border-b-0"
              title={`Course ${courseNum}: ${code} body (${h}mm modular)${useHalves ? ` · ${halfBlockCode} halves at ends` : ` · ${cornerBlockCode} at ends`}`}
            >
              {cells.map((c, i) => (
                <div
                  key={i}
                  style={{ width: `${c.widthPct}%`, backgroundColor: c.color }}
                  className="border-r border-black/30 last:border-r-0"
                  title={c.label}
                />
              ))}
            </div>
          )
        })}
      </div>

      {/* Right-side ruler — band boundaries only (not every course) so the
          labels stay readable on a 24-course wall. Top-of-wall label sits
          above the strips; each band's strip then shows the running total
          at its BOTTOM edge so labels line up with the visible mortar
          line between bands. */}
      <div className="flex flex-col text-[10px] text-ink-400 font-mono w-12 shrink-0 leading-none">
        <div>{totalHeight}mm</div>
        {topDownBands.map((band, idx) => {
          const bandH = band.count * ((library[band.blockCode]?.dimensions.heightMm ?? 190) + 10)
          const pct = (bandH / totalHeight) * 100
          return (
            <div
              key={idx}
              style={{ flexBasis: `${pct}%`, minHeight: 0 }}
              className="flex items-end"
            >
              {labels[idx + 1]}mm
            </div>
          )
        })}
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

// ---------- Helpers ----------

interface BlockSelectProps {
  label: string
  value: BlockCode | ''
  onChange: (v: BlockCode | '') => void
  options: (BlockCode | '')[]
  disabled?: boolean
  allowEmpty?: boolean
}

function BlockSelect({ label, value, onChange, options, disabled, allowEmpty }: BlockSelectProps) {
  return (
    <label className="text-sm block">
      <span className="block text-ink-300 mb-1.5">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as BlockCode | '')}
        disabled={disabled}
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
function PierTypeEditorModal({ existing, onSave, onCancel }: PierTypeEditorModalProps) {
  const { library } = useBlockLibrary()

  // Block options: pier-relevant codes first, then everything else sorted.
  // Mirrors the original PierTypesPanel preference list so users see the
  // codes they actually pick at the top of the dropdown.
  const PIER_PREFERRED: BlockCode[] = ['40.925', '20.01', '20.21', '20.48', '20.03']
  const blockOptions = useMemo<BlockCode[]>(() => {
    const allBlocks: BlockCode[] = Object.values(library)
      .map((b) => b.code)
      .filter((c) => c !== '50.45')
    const preferred = PIER_PREFERRED.filter((c) => allBlocks.includes(c))
    const rest = allBlocks.filter((c) => !PIER_PREFERRED.includes(c)).sort()
    return [...preferred, ...rest]
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [library])

  const [name, setName] = useState(existing?.name ?? 'New pier type')
  const [placement, setPlacement] = useState<'tied' | 'freestanding'>(
    existing?.suggestedPlacement ?? 'tied'
  )
  const [pattern, setPattern] = useState<BlockCode[]>(
    existing?.coursePattern && existing.coursePattern.length > 0
      ? existing.coursePattern
      : ['40.925', '20.01']
  )

  function updateSlot(idx: number, code: BlockCode) {
    setPattern((prev) => prev.map((c, i) => (i === idx ? code : c)))
  }
  function addSlot() {
    const last = pattern[pattern.length - 1] ?? '40.925'
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
                The pattern repeats from the base course up. e.g.{' '}
                <span className="font-mono">40.925 / 20.01</span> alternates the
                pier block and a tie-back corner block every other course.
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
            <PreviewLegend
              bands={pattern.map((c) => ({ blockCode: c, count: 1 }))}
              cornerBlockCode={pattern[0]}
              halfBlockCode={pattern[0]}
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
