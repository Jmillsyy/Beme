import { useMemo, useState } from 'react'
import type {
  BlockExportInclusions,
  BrickExportInclusions,
  BrickMakeup,
  BrickSettings,
  Opening,
  Pier,
  PierMakeup,
  ProjectDetails,
  Wall,
  WallMakeup,
} from '../types/walls'
import type { ProjectArea } from '../lib/projectStorage'
import type { PageInfo } from '../lib/blockExport'
import { exportBlockEstimate } from '../lib/blockExport'
import { exportBrickEstimate } from '../lib/brickExport'
import { exportCombinedEstimate } from '../lib/combinedExport'
import { useUserSettings } from '../lib/userSettings'
import { useOrganisations } from '../lib/organisations'
import { toast } from '../lib/toast'

interface UnifiedExportPanelProps {
  projectDetails: ProjectDetails
  referenceNumber?: number | null
  supplyItemSelections?: Record<string, boolean>
  supplyItemRateOverrides?: Record<string, number>
  pdfFile?: File | null

  /** Raw walls across both trades / all areas — partitioned internally. */
  allWalls: Wall[]
  /** Raw openings across both trades. */
  allOpenings: Opening[]
  /** All piers (block trade only). */
  allPiers?: Pier[]

  blockMakeups: WallMakeup[]
  pierMakeups?: PierMakeup[]
  brickMakeups: BrickMakeup[]
  brickSettings: BrickSettings

  /** Project areas (named buckets). Empty → area picker hidden. */
  areas: ProjectArea[]

  /** The area the workspace is currently viewing. null = the "All
   *  areas" view. Drives the default tick state of the area picker:
   *  when an area is active, only that area is ticked by default
   *  (so an export from inside "First Floor" produces a First-Floor-
   *  only PDF). When null, every area + unassigned is ticked. */
  activeAreaId?: string | null

  /** Per-PDF-page metadata (without trade pre-filtering). */
  rawPagesInfo: Array<{
    pageNumber: number
    pageWidthMm?: number
    pageHeightMm?: number
    pageScaleRatio?: number
    walls: Wall[]
    openings: Opening[]
    piers: Pier[]
    measurements?: Array<{
      id: string
      startMm: { x: number; y: number }
      endMm: { x: number; y: number }
    }>
    label?: string
  }>
}

/**
 * UNIFIED_AREA_ID for "Unassigned" walls (those with no areaId set).
 * Distinct from any real area id so the Set check works cleanly.
 */
const UNASSIGNED = '__unassigned__'

/**
 * Single export panel that replaces the legacy BlockExportPanel +
 * BrickExportPanel + CombinedExportCard combo. The user gets:
 *
 *   - One "Open print preview" button
 *   - Area checkboxes (only shown when the project has any areas)
 *   - A short Sections list — Assumptions / Wall layout / Ruler
 *     measurements / Schedules / Disclaimer
 *
 * Trade selection is automatic. After applying the area filter:
 *   - Both trades have walls → combined export (one PDF, both trades)
 *   - Only one trade has walls → that trade's single export
 *   - Neither → button disabled
 *
 * Per-trade inclusions are derived from the unified Sections state at
 * export time. The legacy per-trade BlockExportInclusions /
 * BrickExportInclusions persisted on saved projects is ignored — the
 * unified panel never reads them, but they stay on the schema so old
 * saves continue to load cleanly.
 */
export default function UnifiedExportPanel({
  projectDetails,
  referenceNumber,
  supplyItemSelections,
  supplyItemRateOverrides,
  pdfFile,
  allWalls,
  allOpenings,
  allPiers = [],
  blockMakeups,
  pierMakeups = [],
  brickMakeups,
  brickSettings,
  areas,
  activeAreaId = null,
  rawPagesInfo,
}: UnifiedExportPanelProps) {
  const [expanded, setExpanded] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { settings: userSettings } = useUserSettings()
  const { currentOrg } = useOrganisations()

  // Area selection. Default depends on whether the workspace is
  // currently scoped to a specific area:
  //   - activeAreaId === <id> → only that area ticked. The user is
  //     working inside one area; exporting from there should default
  //     to that area only (matches the workspace scope they see on
  //     screen).
  //   - activeAreaId === null → "All areas" view, every area +
  //     unassigned ticked. They asked for an everything export.
  //
  // The user can still tick/untick freely after the panel opens —
  // the active-area gate only seeds the initial state. We don't
  // re-seed on activeAreaId change after mount, otherwise switching
  // tabs while the panel is open would clobber their selection.
  const initialSelectedAreas = useMemo(() => {
    const s = new Set<string>()
    if (activeAreaId) {
      // Active area is set → only that area in the selection. We
      // skip UNASSIGNED here on purpose: walls without an areaId are
      // visible under "All areas" but not under any specific one, so
      // a "First Floor" export shouldn't include them.
      s.add(activeAreaId)
    } else {
      for (const a of areas) s.add(a.id)
      s.add(UNASSIGNED)
    }
    return s
    // Only seed on mount — see comment above. The deps below are
    // intentionally limited to the values used at mount time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const [selectedAreas, setSelectedAreas] =
    useState<Set<string>>(initialSelectedAreas)
  // If `areas` changes (user added/removed area mid-session), keep
  // the selection in sync: drop ids that no longer exist, but DON'T
  // automatically tick newly-added ones — the user already chose
  // what to include, adding a new area shouldn't broaden their export.
  useMemo(() => {
    setSelectedAreas((prev) => {
      const validIds = new Set([...areas.map((a) => a.id), UNASSIGNED])
      const next = new Set(prev)
      for (const id of next) if (!validIds.has(id)) next.delete(id)
      return next
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [areas.map((a) => a.id).join('|')])

  // Sections — unified short list. All ticked by default.
  const [sections, setSections] = useState({
    assumptions: true,
    wallLayout: true,
    measurements: true,
    schedules: true,
    disclaimer: true,
  })

  // Walls passing the area filter. A wall's areaId is checked against
  // selectedAreas; an undefined areaId maps to UNASSIGNED.
  const includedWalls = useMemo(
    () => allWalls.filter((w) => selectedAreas.has(w.areaId ?? UNASSIGNED)),
    [allWalls, selectedAreas]
  )

  // Partition included walls by trade. Walls without an explicit trade
  // default to block (matches the migration logic).
  const { blockWalls, brickWalls } = useMemo(() => {
    const block: Wall[] = []
    const brick: Wall[] = []
    for (const w of includedWalls) {
      if ((w.trade ?? 'block') === 'brick') brick.push(w)
      else block.push(w)
    }
    return { blockWalls: block, brickWalls: brick }
  }, [includedWalls])

  // Partition openings by trade (via the wallId they reference).
  const { blockOpenings, brickOpenings } = useMemo(() => {
    const blockIds = new Set(blockWalls.map((w) => w.id))
    const brickIds = new Set(brickWalls.map((w) => w.id))
    const blockO: Opening[] = []
    const brickO: Opening[] = []
    for (const o of allOpenings) {
      if (brickIds.has(o.wallId)) brickO.push(o)
      else if (blockIds.has(o.wallId)) blockO.push(o)
    }
    return { blockOpenings: blockO, brickOpenings: brickO }
  }, [allOpenings, blockWalls, brickWalls])

  // Piers always belong to block. Filter by inclusion in the block wall set.
  const includedPiers = useMemo(() => {
    const blockIds = new Set(blockWalls.map((w) => w.id))
    return allPiers.filter((p) => {
      // Piers have a wallId (tied piers) or sit free; include free piers
      // when their stamped trade (if any) is block, default block otherwise.
      const wallId = (p as { wallId?: string }).wallId
      if (wallId) return blockIds.has(wallId)
      return true
    })
  }, [allPiers, blockWalls])

  // Per-trade pagesInfo so each Wall Layout section only shows its
  // trade's walls. Pages without walls of that trade are skipped.
  const { blockPagesInfo, brickPagesInfo } = useMemo(() => {
    const blockBy: PageInfo[] = []
    const brickBy: PageInfo[] = []
    const blockWallIds = new Set(blockWalls.map((w) => w.id))
    const brickWallIds = new Set(brickWalls.map((w) => w.id))
    for (const p of rawPagesInfo) {
      const pBlockWalls = p.walls.filter((w) => blockWallIds.has(w.id))
      const pBrickWalls = p.walls.filter((w) => brickWallIds.has(w.id))
      const pBlockWIds = new Set(pBlockWalls.map((w) => w.id))
      const pBrickWIds = new Set(pBrickWalls.map((w) => w.id))
      const pBlockOpenings = p.openings.filter((o) => pBlockWIds.has(o.wallId))
      const pBrickOpenings = p.openings.filter((o) => pBrickWIds.has(o.wallId))
      if (pBlockWalls.length > 0) {
        blockBy.push({
          pageNumber: p.pageNumber,
          pageWidthMm: p.pageWidthMm,
          pageHeightMm: p.pageHeightMm,
          pageScaleRatio: p.pageScaleRatio,
          walls: pBlockWalls,
          openings: pBlockOpenings,
          piers: p.piers,
          measurements: p.measurements,
          label: p.label,
        })
      }
      if (pBrickWalls.length > 0) {
        brickBy.push({
          pageNumber: p.pageNumber,
          pageWidthMm: p.pageWidthMm,
          pageHeightMm: p.pageHeightMm,
          pageScaleRatio: p.pageScaleRatio,
          walls: pBrickWalls,
          openings: pBrickOpenings,
          piers: [],
          measurements: p.measurements,
          label: p.label,
        })
      }
    }
    return { blockPagesInfo: blockBy, brickPagesInfo: brickBy }
  }, [rawPagesInfo, blockWalls, brickWalls])

  const hasBlock = blockWalls.length > 0
  const hasBrick = brickWalls.length > 0
  const canExport = hasBlock || hasBrick
  const exportMode: 'combined' | 'block' | 'brick' | 'none' = hasBlock && hasBrick
    ? 'combined'
    : hasBlock
    ? 'block'
    : hasBrick
    ? 'brick'
    : 'none'

  function toggleArea(id: string) {
    setSelectedAreas((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // Derive per-trade inclusions from the unified sections state. Sections
  // that don't have a one-to-one mapping (block has wallSpecs which brick
  // doesn't; brick has brickAreaSummary which block doesn't) are routed
  // under the most natural unified flag — both wallSpecs and
  // brickAreaSummary live under "schedules".
  function buildBlockInclusions(): BlockExportInclusions {
    return {
      assumptions: sections.assumptions,
      wallSpecs: sections.schedules,
      blockSchedule: sections.schedules,
      wallTypeBreakdown: sections.schedules,
      measurements: sections.measurements,
      disclaimer: sections.disclaimer,
    }
  }
  function buildBrickInclusions(): BrickExportInclusions {
    return {
      assumptions: sections.assumptions,
      wallLayout: sections.wallLayout,
      measurements: sections.measurements,
      brickAreaSummary: sections.schedules,
      disclaimer: sections.disclaimer,
    }
  }

  function business() {
    return {
      companyName: currentOrg?.name || userSettings.business.companyName,
      abn: userSettings.business.abn,
      phone: userSettings.business.phone,
      website: userSettings.business.website,
      addressLine1: userSettings.business.addressLine1,
      addressLine2: userSettings.business.addressLine2,
      suburb: userSettings.business.suburb,
      state: userSettings.business.state,
      postcode: userSettings.business.postcode,
      logoUrl: currentOrg?.logoUrl || userSettings.business.logoUrl,
    }
  }

  async function handleExport() {
    if (busy || exportMode === 'none') return
    setBusy(true)
    setError(null)
    const progressId = toast.info('Generating PDF…', { durationMs: null })
    try {
      const shared = {
        projectDetails,
        referenceNumber: referenceNumber ?? undefined,
        supplyItemSelections,
        supplyItemRateOverrides,
        business: business(),
        pdfFile: pdfFile ?? undefined,
      }
      if (exportMode === 'combined') {
        await exportCombinedEstimate({
          ...shared,
          blockInclusions: buildBlockInclusions(),
          blockWalls,
          blockMakeups,
          blockOpenings,
          blockPiers: includedPiers,
          pierMakeups,
          blockPagesInfo,
          brickInclusions: buildBrickInclusions(),
          brickWalls,
          brickMakeups,
          brickOpenings,
          brickSettings,
          brickPagesInfo,
        })
      } else if (exportMode === 'block') {
        await exportBlockEstimate({
          ...shared,
          inclusions: buildBlockInclusions(),
          walls: blockWalls,
          makeups: blockMakeups,
          openings: blockOpenings,
          piers: includedPiers,
          pierMakeups,
          pagesInfo: blockPagesInfo,
        })
      } else {
        await exportBrickEstimate({
          ...shared,
          inclusions: buildBrickInclusions(),
          walls: brickWalls,
          openings: brickOpenings,
          settings: brickSettings,
          makeups: brickMakeups,
          pagesInfo: brickPagesInfo,
        })
      }
      toast.dismiss(progressId)
      toast.success('Estimate exported')
    } catch (e) {
      console.error('Export failed', e)
      toast.dismiss(progressId)
      const msg = (e as Error)?.message ?? String(e)
      toast.error(`Export failed: ${msg}`)
      setError(msg)
    } finally {
      setBusy(false)
    }
  }

  // Label hint under the button so the user knows what they'll get.
  const modeLabel =
    exportMode === 'combined'
      ? 'Combined block + brick'
      : exportMode === 'block'
      ? 'Block estimate'
      : exportMode === 'brick'
      ? 'Brick estimate'
      : 'No walls match the filter'

  return (
    <div className="my-4 border border-ink-600 rounded-xl bg-ink-800 overflow-hidden">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full bg-ink-700 px-3 py-2 border-b border-ink-600 flex items-center justify-between gap-2 text-left group"
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-beme-400 group-hover:text-beme-300 text-xs">
            {expanded ? '▾' : '▸'}
          </span>
          <h3 className="text-sm font-bold text-beme-300">Export estimate</h3>
          <span className="text-xs text-ink-400 truncate">· {modeLabel}</span>
        </div>
      </button>

      {expanded && (
        <div className="p-3 flex flex-col gap-3">
          <p className="text-[11px] text-ink-400 leading-snug">
            One PDF — block, brick, or both depending on which trades have
            walls in the included areas. Hit <em>Open print preview</em> then
            print to PDF.
          </p>

          {/* Areas — only shown when the project has any defined.
              All ticked by default; user unticks to drop a bucket. */}
          {areas.length > 0 && (
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-400 mb-1.5">
                Areas
              </div>
              <div className="flex flex-col gap-1">
                {areas.map((a) => (
                  <label
                    key={a.id}
                    className="flex items-center gap-2 text-xs text-ink-200 cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={selectedAreas.has(a.id)}
                      onChange={() => toggleArea(a.id)}
                      className="accent-beme-500"
                    />
                    <span className="flex-1 truncate">{a.name}</span>
                  </label>
                ))}
                <label className="flex items-center gap-2 text-xs text-ink-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={selectedAreas.has(UNASSIGNED)}
                    onChange={() => toggleArea(UNASSIGNED)}
                    className="accent-beme-500"
                  />
                  <span className="italic">Unassigned</span>
                </label>
              </div>
            </div>
          )}

          {/* Sections — short unified list. */}
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-400 mb-1.5">
              Sections
            </div>
            <div className="flex flex-col gap-1">
              <SectionToggle
                label="Assumptions"
                checked={sections.assumptions}
                onChange={(v) => setSections((s) => ({ ...s, assumptions: v }))}
              />
              <SectionToggle
                label="Wall layout pages"
                checked={sections.wallLayout}
                onChange={(v) => setSections((s) => ({ ...s, wallLayout: v }))}
              />
              <SectionToggle
                label="Ruler measurements on layout"
                checked={sections.measurements}
                onChange={(v) => setSections((s) => ({ ...s, measurements: v }))}
                disabled={!sections.wallLayout}
                indent
              />
              <SectionToggle
                label="Schedules & breakdowns"
                checked={sections.schedules}
                onChange={(v) => setSections((s) => ({ ...s, schedules: v }))}
              />
              <SectionToggle
                label="Disclaimer"
                checked={sections.disclaimer}
                onChange={(v) => setSections((s) => ({ ...s, disclaimer: v }))}
              />
            </div>
          </div>

          <button
            onClick={handleExport}
            disabled={busy || !canExport}
            className="w-full px-3 py-2 rounded-lg bg-beme-500 text-black text-sm font-medium hover:bg-beme-400 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {busy
              ? 'Opening preview…'
              : canExport
              ? 'Open print preview →'
              : 'No walls match the filter'}
          </button>
          {!canExport && (
            <p className="text-[11px] text-ink-500">
              Tick at least one area that contains walls to enable export.
            </p>
          )}
          {error && (
            <p className="text-[11px] text-rose-300 leading-snug">{error}</p>
          )}
        </div>
      )}
    </div>
  )
}

interface SectionToggleProps {
  label: string
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
  indent?: boolean
}

function SectionToggle({
  label,
  checked,
  onChange,
  disabled,
  indent,
}: SectionToggleProps) {
  return (
    <label
      className={`flex items-center gap-2 text-xs cursor-pointer ${
        disabled ? 'text-ink-500 cursor-not-allowed' : 'text-ink-200'
      } ${indent ? 'pl-5' : ''}`}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="accent-beme-500"
      />
      <span className="flex-1">{label}</span>
    </label>
  )
}
