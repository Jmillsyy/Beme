import { useEffect, useMemo, useRef, useState } from 'react'
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
import type { SupplyItem } from '../types/userSettings'
import { roundSupplyQuantity } from '../types/userSettings'
import type { ProjectArea } from '../lib/projectStorage'
import type { PageInfo } from '../lib/blockExport'
import { exportBlockEstimate } from '../lib/blockExport'
import { exportBrickEstimate } from '../lib/brickExport'
import { exportCombinedEstimate } from '../lib/combinedExport'
import { useUserSettings } from '../lib/userSettings'
import { useOrganisations } from '../lib/organisations'
import { useOrgSupplyItems } from '../lib/orgSupplyItems'
import { toast } from '../lib/toast'
import { calculateProjectTally, wallLengthMm } from '../lib/blockCalc'
import { calculateBrickTally } from '../lib/brickCalc'
import { BLOCK_LIBRARY } from '../data/blockLibrary'
import { BRICK_LIBRARY } from '../data/brickLibrary'

function blockLabel(code: string): string {
  const b = BLOCK_LIBRARY[code]
  return b ? b.name : ''
}

function brickLabel(code: string): string {
  const b = BRICK_LIBRARY[code]
  return b ? b.name : ''
}

interface UnifiedExportPanelProps {
  projectDetails: ProjectDetails
  referenceNumber?: number | null
  supplyItemSelections?: Record<string, boolean>
  supplyItemRateOverrides?: Record<string, number>
  pdfFile?: File | null

  /**
   * Currently-open project id. Retained for legacy callers; the
   * snapshot pipeline no longer needs it because captures now come
   * straight in via {@link view3dSnapshots} from PdfWorkspace.
   */
  projectId?: string | null
  /**
   * 3D captures to embed in the export. Owned by PdfWorkspace
   * (lifted out of WorkspaceView3D + localStorage) so they're
   * scoped to a single saved project and can't bleed across.
   * Empty array (or omitted) means "no captures" and the export
   * skips the 3D pages entirely.
   */
  view3dSnapshots?: Array<{
    id: string
    dataUrl: string
    createdAt: number
    pageNumber?: number
    trade?: 'block' | 'brick'
    legend?: Array<{ code: string; label: string; color: string }>
  }>

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
   *  areas" view. Seeds the area picker default when the modal opens. */
  activeAreaId?: string | null

  /**
   * Controlled open state — when supplied, the parent owns the modal
   * open/close lifecycle and can trigger it from elsewhere (e.g. the
   * top-bar Export button). The big right-rail trigger button is
   * hidden in this mode, since the parent is providing its own
   * affordance. When omitted, the panel falls back to the legacy
   * uncontrolled behaviour: it renders its own trigger button and
   * manages open/close internally.
   */
  open?: boolean
  /** Setter paired with {@link open}. Called with `false` from inside
   *  the modal (Cancel / Esc / Export-success) and `true` from the
   *  built-in trigger button when the panel is uncontrolled. */
  onOpenChange?: (open: boolean) => void
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
 * Sentinel id used to represent walls that have no `areaId` set in the
 * area picker. Distinct from any real area id so the Set check works
 * cleanly when filtering walls.
 */
const UNASSIGNED = '__unassigned__'

/**
 * Top-level export surface. Renders a SINGLE large "Export estimate"
 * button. Clicking opens a modal where the user picks:
 *
 *   1. **Areas** (skipped when the project only has one area — that
 *      area is auto-selected).
 *   2. **Sections** to include in the PDF.
 *   3. **Block adjustments** — a live tally preview with a "remove"
 *      column per block code. Useful for blocks the user already has
 *      on site or is re-using from another job; the schedule subtracts
 *      them before printing.
 *
 * After "Export" inside the modal, we partition the included walls
 * by trade and call the appropriate exporter (block / brick /
 * combined). Adjustments flow through to those exporters which clamp
 * the tally and re-render the schedule.
 */
export default function UnifiedExportPanel({
  projectDetails,
  referenceNumber,
  supplyItemSelections,
  supplyItemRateOverrides,
  pdfFile,
  projectId,
  view3dSnapshots: view3dSnapshotsProp,
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
  open: controlledOpen,
  onOpenChange,
}: UnifiedExportPanelProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false)
  // Controlled mode: parent owns the open state (e.g. the ProjectBar's
  // Export button drives it). Uncontrolled: internal state, used when
  // someone embeds the rail-button form without lifting state up.
  // Detected by either prop being defined — the panel never mixes the
  // two so this is unambiguous.
  const isControlled = controlledOpen !== undefined || onOpenChange !== undefined
  const open = isControlled ? !!controlledOpen : uncontrolledOpen
  const setOpen = (next: boolean) => {
    if (onOpenChange) onOpenChange(next)
    if (!isControlled) setUncontrolledOpen(next)
  }

  // Disable the button when there are no walls drawn at all — nothing
  // to export. Stays clickable even when only one trade has walls;
  // the modal handles partitioning.
  const hasAnyWalls = allWalls.length > 0

  return (
    <>
      {/* Rail trigger button — only rendered in uncontrolled mode.
          When a parent (PdfWorkspace) owns the open state and is
          providing its own trigger (the ProjectBar's Export pill),
          the rail button is redundant and we hide it so the column
          ends cleanly at the tally panel. */}
      {!isControlled && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          disabled={!hasAnyWalls}
          title={
            hasAnyWalls
              ? 'Open the export modal'
              : 'Draw at least one wall to enable export'
          }
          className="w-full px-4 py-3 rounded-xl bg-beme-500 text-black text-sm font-semibold shadow-md hover:bg-beme-400 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          Export estimate
        </button>
      )}
      {open && (
        <ExportEstimateModal
          onClose={() => setOpen(false)}
          projectDetails={projectDetails}
          referenceNumber={referenceNumber}
          supplyItemSelections={supplyItemSelections}
          supplyItemRateOverrides={supplyItemRateOverrides}
          pdfFile={pdfFile}
          allWalls={allWalls}
          allOpenings={allOpenings}
          allPiers={allPiers}
          blockMakeups={blockMakeups}
          pierMakeups={pierMakeups}
          brickMakeups={brickMakeups}
          brickSettings={brickSettings}
          areas={areas}
          activeAreaId={activeAreaId}
          rawPagesInfo={rawPagesInfo}
        />
      )}
    </>
  )
}

// ─────────────────────────────────────────────────────────────────────
// Modal
// ─────────────────────────────────────────────────────────────────────

interface ModalProps extends UnifiedExportPanelProps {
  onClose: () => void
}

function ExportEstimateModal({
  onClose,
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
}: ModalProps) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { settings: userSettings } = useUserSettings()
  const { currentOrg } = useOrganisations()

  // Esc closes — keep keyboard parity with the other modals (wall
  // type editor, opening editor, etc.). ⌘/Ctrl + Enter fires Export
  // so power users can ship a quote without touching the mouse.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
        return
      }
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        // Don't reference handleExport directly — it's redefined on
        // every render. Synthesise a click on the export button
        // instead so the handler that's wired through React fires.
        const btn = document.querySelector<HTMLButtonElement>(
          'button[data-export-action="export"]'
        )
        if (btn && !btn.disabled) btn.click()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Area selection. Default to EVERY area + Unassigned ticked so
  // exports include the whole project by default — that matches how a
  // builder reads an estimate (the whole job, not just one floor).
  // Earlier this defaulted to just the active area when activeAreaId
  // was set, which silently dropped every wall in other areas from
  // the tally + wall types list. User had to remember to tick the
  // others; if they didn't, the PDF was missing wall types they
  // expected to see. Defaulting to all-on means the export always
  // surfaces everything, and the user can deselect any area they
  // want excluded.
  const initialSelectedAreas = useMemo(() => {
    const s = new Set<string>()
    for (const a of areas) s.add(a.id)
    s.add(UNASSIGNED)
    return s
    // Initial state only — see comment block above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // activeAreaId intentionally not consumed here — see initialSelectedAreas.
  void activeAreaId
  const [selectedAreas, setSelectedAreas] =
    useState<Set<string>>(initialSelectedAreas)

  function toggleArea(id: string) {
    setSelectedAreas((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // Count walls that have no areaId so we can hide the "Unassigned"
  // row when it's empty. Also feeds the All-toggle's allIds.
  const hasUnassignedWalls = useMemo(
    () => allWalls.some((w) => !w.areaId),
    [allWalls]
  )

  // "All" master toggle. Ticked when every area (and Unassigned, if
  // it's surfaced) is currently selected. Clicking it flips the whole
  // group on/off so the user can either grab everything in one click
  // or quickly clear to pick individual areas.
  const allIds = useMemo(() => {
    const ids = areas.map((a) => a.id)
    if (hasUnassignedWalls) ids.push(UNASSIGNED)
    return ids
  }, [areas, hasUnassignedWalls])
  const allSelected =
    allIds.length > 0 && allIds.every((id) => selectedAreas.has(id))
  function toggleAll() {
    setSelectedAreas((prev) => {
      if (allSelected) {
        // Already all on → clear so user can pick individuals.
        return new Set<string>()
      }
      return new Set(allIds)
    })
  }

  // Sections — short unified list, all ticked by default.
  const [sections, setSections] = useState({
    assumptions: true,
    wallLayout: true,
    measurements: true,
    schedules: true,
    disclaimer: true,
  })

  // Cover-page overrides — per-export only, never mutate ProjectDetails.
  // Empty strings fall back to ProjectDetails defaults inside the
  // exporter (projectName → title, etc.). Each field is plain text;
  // the exporter HTML-escapes before rendering.
  const [coverTitle, setCoverTitle] = useState('')
  const [coverSubtitle, setCoverSubtitle] = useState('')
  const [coverIntro, setCoverIntro] = useState('')

  // Active nav anchor — drives the highlighted state on the left rail.
  // Click → scroll the corresponding section into view; the
  // IntersectionObserver below also updates this as the user scrolls
  // manually through the long body so the rail and content stay
  // in sync.
  type NavId = 'cover' | 'sections' | 'areas' | 'quantities' | 'supplies'
  const [activeNavId, setActiveNavId] = useState<NavId>('cover')
  const coverSectionRef = useRef<HTMLElement | null>(null)
  const sectionsSectionRef = useRef<HTMLElement | null>(null)
  const areasSectionRef = useRef<HTMLElement | null>(null)
  const quantitiesSectionRef = useRef<HTMLElement | null>(null)
  const suppliesSectionRef = useRef<HTMLElement | null>(null)
  const settingsScrollRef = useRef<HTMLDivElement | null>(null)
  function sectionRefFor(id: NavId) {
    return id === 'cover'
      ? coverSectionRef
      : id === 'sections'
        ? sectionsSectionRef
        : id === 'areas'
          ? areasSectionRef
          : id === 'quantities'
            ? quantitiesSectionRef
            : suppliesSectionRef
  }
  function scrollToSection(id: NavId) {
    setActiveNavId(id)
    const node = sectionRefFor(id).current
    if (node) node.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  // IntersectionObserver — when the user scrolls manually through
  // the settings column, highlight whichever section's top edge has
  // most recently entered the upper third of the viewport. Without
  // this the nav rail stays stuck on whichever item the user last
  // clicked, which feels broken once they scroll past it.
  useEffect(() => {
    const scrollNode = settingsScrollRef.current
    if (!scrollNode) return
    const nodes: Array<[NavId, HTMLElement | null]> = [
      ['cover', coverSectionRef.current],
      ['sections', sectionsSectionRef.current],
      ['areas', areasSectionRef.current],
      ['quantities', quantitiesSectionRef.current],
      ['supplies', suppliesSectionRef.current],
    ]
    const live = nodes.filter((n): n is [NavId, HTMLElement] => !!n[1])
    if (live.length === 0) return
    const observer = new IntersectionObserver(
      (entries) => {
        // Pick the entry with the highest intersection ratio that's
        // currently intersecting. Falls back to the topmost visible
        // section so the rail picks something even when several are
        // partly on screen.
        const visible = entries.filter((e) => e.isIntersecting)
        if (visible.length === 0) return
        visible.sort((a, b) => b.intersectionRatio - a.intersectionRatio)
        const top = visible[0]
        const match = live.find(([, el]) => el === top.target)
        if (match) setActiveNavId(match[0])
      },
      {
        root: scrollNode,
        // Top 0% → 50% of viewport. Bias upward so the highlight
        // matches what the user is reading near the top.
        rootMargin: '0px 0px -50% 0px',
        threshold: [0, 0.25, 0.5, 0.75, 1],
      }
    )
    for (const [, el] of live) observer.observe(el)
    return () => observer.disconnect()
  })

  // ── Walls / openings / piers after the area filter ──
  const includedWalls = useMemo(
    () => allWalls.filter((w) => selectedAreas.has(w.areaId ?? UNASSIGNED)),
    [allWalls, selectedAreas]
  )
  const { blockWalls, brickWalls } = useMemo(() => {
    const block: Wall[] = []
    const brick: Wall[] = []
    for (const w of includedWalls) {
      if ((w.trade ?? 'block') === 'brick') brick.push(w)
      else block.push(w)
    }
    return { blockWalls: block, brickWalls: brick }
  }, [includedWalls])
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
  const includedPiers = useMemo(() => {
    const blockIds = new Set(blockWalls.map((w) => w.id))
    return allPiers.filter((p) => {
      const wallId = (p as { wallId?: string }).wallId
      if (wallId) return blockIds.has(wallId)
      return true
    })
  }, [allPiers, blockWalls])
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

  // ── Block tally preview (drives the adjustments table). The base
  //    tally is the auto-calculated map keyed by block code. The
  //    table component combines this with user adjustments to
  //    compute final counts + add-only rows. ──
  const blockBaseTally = useMemo(() => {
    if (blockWalls.length === 0) return {} as Record<string, number>
    const makeupsById = Object.fromEntries(blockMakeups.map((m) => [m.id, m]))
    const pierMakeupsById = Object.fromEntries(pierMakeups.map((m) => [m.id, m]))
    return calculateProjectTally(
      blockWalls,
      makeupsById,
      blockOpenings,
      includedPiers,
      pierMakeupsById
    ) as Record<string, number>
  }, [blockWalls, blockMakeups, blockOpenings, includedPiers, pierMakeups])
  const hasBlockTally = Object.keys(blockBaseTally).length > 0

  // ── Brick tally preview — same shape as the block one. ──
  const brickBaseTally = useMemo(() => {
    if (brickWalls.length === 0) return {} as Record<string, number>
    const tally = calculateBrickTally(
      brickWalls,
      brickOpenings,
      brickSettings,
      brickMakeups
    )
    if (Object.keys(tally.bricksByType).length > 0) {
      return tally.bricksByType as Record<string, number>
    }
    if (tally.brickCount > 0) {
      return { [brickSettings.brickTypeCode]: tally.brickCount }
    }
    return {} as Record<string, number>
  }, [brickWalls, brickOpenings, brickSettings, brickMakeups])
  const hasBrickTally = Object.keys(brickBaseTally).length > 0

  // ── Per-area Quantities (brick + block) ──
  //
  // For each project area (plus an "Unassigned" bucket for walls
  // without an areaId), compute the trade-specific metrics the user
  // wants to override on a per-area basis:
  //   - brick: total brickwork m², head lineal m, sill lineal m
  //   - block: total blockwork m² (block has no head/sill concept)
  //
  // These memos run the same calc engine the headline tally uses,
  // just on a wall subset filtered to the area. Overrides (below)
  // can then replace any value per area; final totals are the sum
  // of (override ?? auto) across all areas.
  type PerAreaSpec = { id: string; name: string; colorHex?: string }
  const areaSpecs = useMemo<PerAreaSpec[]>(() => {
    return [
      ...areas.map((a) => ({
        id: a.id,
        name: a.name,
        colorHex: a.colorHex,
      })),
      // Always include an unassigned bucket so walls without an areaId
      // still show up. Hidden by the render if it ends up empty.
      { id: '__unassigned__', name: 'Unassigned', colorHex: undefined },
    ]
  }, [areas])

  // Sources for per-area Quantities: use the FULL project walls /
  // openings (not the area-included ones) so every area in the
  // project shows up in this section, regardless of whether the
  // user has currently ticked it under the Areas filter. The user
  // wanted to manage rates per area independently of inclusion;
  // unticked areas just won't make it into the export, but their
  // overrides are still recorded for when they get re-included.
  const allBrickWalls = useMemo(
    () => allWalls.filter((w) => (w.trade ?? 'block') === 'brick'),
    [allWalls],
  )
  const allBlockWalls = useMemo(
    () => allWalls.filter((w) => (w.trade ?? 'block') !== 'brick'),
    [allWalls],
  )
  const allBrickOpenings = useMemo(() => {
    const ids = new Set(allBrickWalls.map((w) => w.id))
    return allOpenings.filter((o) => ids.has(o.wallId))
  }, [allOpenings, allBrickWalls])
  const allBlockOpenings = useMemo(() => {
    const ids = new Set(allBlockWalls.map((w) => w.id))
    return allOpenings.filter((o) => ids.has(o.wallId))
  }, [allOpenings, allBlockWalls])

  interface PerAreaBrickMakeupMetrics {
    sqM: number
    headLinealM: number
    sillLinealM: number
    wallCount: number
  }
  interface PerAreaBrickMetrics {
    sqM: number
    headLinealM: number
    sillLinealM: number
    runM: number
    wallCount: number
    openingCount: number
    /** Per-wall-type breakdown — keyed by makeup id — for the
     *  drilldown editor inside the area card. */
    byMakeup: Record<string, PerAreaBrickMakeupMetrics>
  }
  const perAreaBrickMetrics = useMemo(() => {
    const result: Record<string, PerAreaBrickMetrics> = {}
    for (const area of areaSpecs) {
      const wallsInArea = allBrickWalls.filter((w) =>
        area.id === '__unassigned__' ? !w.areaId : w.areaId === area.id,
      )
      if (wallsInArea.length === 0) continue
      const wallIds = new Set(wallsInArea.map((w) => w.id))
      const openingsInArea = allBrickOpenings.filter((o) =>
        wallIds.has(o.wallId),
      )
      const tally = calculateBrickTally(
        wallsInArea,
        openingsInArea,
        brickSettings,
        brickMakeups,
      )
      const headLineal =
        Object.values(tally.headLinealMmByType).reduce(
          (s, v) => s + v,
          0,
        ) / 1000
      const sillLineal =
        Object.values(tally.sillLinealMmByType).reduce(
          (s, v) => s + v,
          0,
        ) / 1000

      // Per-makeup brick breakdown — same pattern as block. Groups
      // walls by makeupId, runs calculateBrickTally on each subset,
      // and exposes m² / head / sill per wall type for the drilldown
      // editor in the area card.
      const wallsByMakeup: Record<string, Wall[]> = {}
      for (const w of wallsInArea) {
        const mid = w.makeupId ?? ''
        if (!mid) continue
        if (!wallsByMakeup[mid]) wallsByMakeup[mid] = []
        wallsByMakeup[mid].push(w)
      }
      const byMakeup: Record<string, PerAreaBrickMakeupMetrics> = {}
      for (const [mid, mWalls] of Object.entries(wallsByMakeup)) {
        const mWallIds = new Set(mWalls.map((w) => w.id))
        const mOpenings = openingsInArea.filter((o) => mWallIds.has(o.wallId))
        const mTally = calculateBrickTally(
          mWalls,
          mOpenings,
          brickSettings,
          brickMakeups,
        )
        const mHead =
          Object.values(mTally.headLinealMmByType).reduce(
            (s, v) => s + v,
            0,
          ) / 1000
        const mSill =
          Object.values(mTally.sillLinealMmByType).reduce(
            (s, v) => s + v,
            0,
          ) / 1000
        byMakeup[mid] = {
          sqM: mTally.totalAreaSqMm / 1_000_000,
          headLinealM: mHead,
          sillLinealM: mSill,
          wallCount: mWalls.length,
        }
      }

      result[area.id] = {
        sqM: tally.totalAreaSqMm / 1_000_000,
        headLinealM: headLineal,
        sillLinealM: sillLineal,
        runM: tally.totalLinealMm / 1000,
        wallCount: tally.wallCount,
        openingCount: tally.openingCount,
        byMakeup,
      }
    }
    return result
  }, [areaSpecs, allBrickWalls, allBrickOpenings, brickSettings, brickMakeups])

  interface PerAreaBlockMakeupMetrics {
    sqM: number
    wallCount: number
    blockTally: Record<string, number>
  }
  interface PerAreaBlockMetrics {
    sqM: number
    runM: number
    wallCount: number
    /** Per-block-code counts for this area, from calculateProjectTally
     *  on the area's wall subset. Sorted entries used by the UI. */
    blockTally: Record<string, number>
    /** Per-wall-type breakdown for the wall-type drilldown editor
     *  inside the area card. Keyed by makeup id. */
    byMakeup: Record<string, PerAreaBlockMakeupMetrics>
  }
  const perAreaBlockMetrics = useMemo(() => {
    const result: Record<string, PerAreaBlockMetrics> = {}
    const makeupsByIdLocal = Object.fromEntries(
      blockMakeups.map((m) => [m.id, m]),
    ) as Record<string, WallMakeup>
    const pierMakeupsByIdLocal = Object.fromEntries(
      (pierMakeups ?? []).map((m) => [m.id, m]),
    ) as Record<string, PierMakeup>
    for (const area of areaSpecs) {
      const wallsInArea = allBlockWalls.filter((w) =>
        area.id === '__unassigned__' ? !w.areaId : w.areaId === area.id,
      )
      if (wallsInArea.length === 0) continue
      const wallIds = new Set(wallsInArea.map((w) => w.id))
      const openingsInArea = allBlockOpenings.filter((o) =>
        wallIds.has(o.wallId),
      )
      const piersInArea = (allPiers ?? []).filter((p) => {
        const pWallId = (p as { wallId?: string }).wallId
        if (pWallId) return wallIds.has(pWallId)
        return true
      })
      // Per-block-code tally on this area's wall subset. Drives the
      // editable per-code breakdown the user wanted (instead of just
      // m²). Uses the same calc-engine path the headline tally uses.
      const tally = calculateProjectTally(
        wallsInArea,
        makeupsByIdLocal,
        openingsInArea,
        piersInArea,
        pierMakeupsByIdLocal,
      )

      // Per-wall-type (makeup) breakdown — group the area's walls by
      // makeup id, then run calculateProjectTally on each subset to
      // get the per-code tally for that wall type alone. Used by the
      // drilldown editor inside each area card. m² for each wall
      // type comes from sum(len × height) of just those walls,
      // minus opening voids on those walls.
      const wallsByMakeup: Record<string, Wall[]> = {}
      for (const w of wallsInArea) {
        const mid = w.makeupId ?? ''
        if (!mid) continue
        if (!wallsByMakeup[mid]) wallsByMakeup[mid] = []
        wallsByMakeup[mid].push(w)
      }
      const byMakeup: Record<string, PerAreaBlockMakeupMetrics> = {}
      for (const [mid, mWalls] of Object.entries(wallsByMakeup)) {
        const mWallIds = new Set(mWalls.map((w) => w.id))
        const mOpenings = openingsInArea.filter((o) => mWallIds.has(o.wallId))
        const mPiers = piersInArea.filter((p) => {
          const pWallId = (p as { wallId?: string }).wallId
          if (!pWallId) return false
          return mWallIds.has(pWallId)
        })
        const mTally = calculateProjectTally(
          mWalls,
          makeupsByIdLocal,
          mOpenings,
          mPiers,
          pierMakeupsByIdLocal,
        )
        const mBlockTally: Record<string, number> = {}
        for (const [code, count] of Object.entries(mTally)) {
          if (typeof count === 'number' && count > 0) mBlockTally[code] = count
        }
        let mAreaSqMm = 0
        for (const w of mWalls) {
          const len = wallLengthMm(w)
          const heightMm =
            w.heightMmOverride ??
            makeupsByIdLocal[w.makeupId]?.heightMm ??
            0
          mAreaSqMm += len * heightMm
        }
        for (const o of mOpenings) {
          mAreaSqMm -= o.widthMm * o.heightMm
        }
        byMakeup[mid] = {
          sqM: Math.max(0, mAreaSqMm) / 1_000_000,
          wallCount: mWalls.length,
          blockTally: mBlockTally,
        }
      }
      const blockTallyClean: Record<string, number> = {}
      for (const [code, count] of Object.entries(tally)) {
        if (typeof count === 'number' && count > 0) blockTallyClean[code] = count
      }
      let totalAreaSqMm = 0
      let totalLinealMm = 0
      for (const w of wallsInArea) {
        const len = wallLengthMm(w)
        totalLinealMm += len
        const heightMm =
          w.heightMmOverride ?? makeupsByIdLocal[w.makeupId]?.heightMm ?? 0
        totalAreaSqMm += len * heightMm
      }
      for (const o of openingsInArea) {
        totalAreaSqMm -= o.widthMm * o.heightMm
      }
      result[area.id] = {
        sqM: Math.max(0, totalAreaSqMm) / 1_000_000,
        runM: totalLinealMm / 1000,
        wallCount: wallsInArea.length,
        blockTally: blockTallyClean,
        byMakeup,
      }
    }
    return result
  }, [
    areaSpecs,
    allBlockWalls,
    allBlockOpenings,
    blockMakeups,
    allPiers,
    pierMakeups,
  ])

  // Per-area overrides. Field absent / undefined = use the auto
  // value; numeric value = override. Keyed by areaId then field.
  const [perAreaBrickOverrides, setPerAreaBrickOverrides] = useState<
    Record<
      string,
      {
        sqM?: number
        headLinealM?: number
        sillLinealM?: number
        /** Per-wall-type drilldown overrides — keyed by makeup id.
         *  Mirrors the block side: each entry can override that
         *  wall type's m² / head / sill within this area. */
        byMakeup?: Record<
          string,
          { sqM?: number; headLinealM?: number; sillLinealM?: number }
        >
      }
    >
  >({})
  const [perAreaBlockOverrides, setPerAreaBlockOverrides] = useState<
    Record<
      string,
      {
        sqM?: number
        /** Per-block-code overrides for this area. Field absent =
         *  use auto count; numeric = override count. Negative is
         *  clamped to 0 at apply time. */
        blocks?: Record<string, number>
        /** Per-wall-type drilldown overrides. Keyed by makeup id;
         *  each entry can override that wall type's m² and per-code
         *  counts in this area. */
        byMakeup?: Record<
          string,
          { sqM?: number; blocks?: Record<string, number> }
        >
      }
    >
  >({})

  // Wastage % applied to brick / block headline totals only (NOT
  // supply items — those are already user-managed allowances). When
  // `wastageEnabled` is on AND `wastagePercent` is a positive number,
  // the brick and block exporters add a "+ X% wastage" column to
  // their area summary, with a wastage-uplifted total alongside the
  // net figure. Off by default so existing projects export unchanged.
  const [wastageEnabled, setWastageEnabled] = useState<boolean>(false)
  const [wastagePercent, setWastagePercent] = useState<number | undefined>(
    undefined,
  )

  /**
   * Resolve a per-area metric: return the override if the user has set
   * one, otherwise the auto-computed value. Tiny helper so the JSX
   * stays readable.
   */
  const brickAreaValue = (areaId: string, field: 'sqM' | 'headLinealM' | 'sillLinealM'): number => {
    const override = perAreaBrickOverrides[areaId]?.[field]
    if (typeof override === 'number') return override
    return perAreaBrickMetrics[areaId]?.[field] ?? 0
  }
  const blockAreaValue = (areaId: string, field: 'sqM'): number => {
    const override = perAreaBlockOverrides[areaId]?.[field]
    if (typeof override === 'number') return override
    return perAreaBlockMetrics[areaId]?.[field] ?? 0
  }

  // Per-area expansion state — collapsed by default to keep the
  // section glanceable on first open; user expands the ones they
  // want to edit. Keyed by `${trade}-${areaId}`.
  const [expandedAreaCards, setExpandedAreaCards] = useState<
    Record<string, boolean>
  >({})

  // Picker options for "+ Add" — show every code in the libraries so
  // the user can include anything. Sorted alphabetically for
  // predictable scanning.
  const blockPickerOptions = useMemo(
    () =>
      Object.values(BLOCK_LIBRARY)
        .map((b) => ({ code: b.code, description: b.name }))
        .sort((a, b) => a.code.localeCompare(b.code)),
    []
  )
  const brickPickerOptions = useMemo(
    () =>
      Object.values(BRICK_LIBRARY)
        .map((b) => ({ code: b.code, description: b.name }))
        .sort((a, b) => a.code.localeCompare(b.code)),
    []
  )

  // ── Signed adjustments. Keyed by block / brick code. ──
  //   - positive value → remove that many from the auto-tally
  //   - negative value → add that many on top of the auto-tally
  //   - missing / 0 → no override (use auto-tally as-is)
  const [blockAdjustments, setBlockAdjustments] = useState<
    Record<string, number>
  >({})
  const [brickAdjustments, setBrickAdjustments] = useState<
    Record<string, number>
  >({})

  function makeSetAdjustment(
    setter: (
      f: (prev: Record<string, number>) => Record<string, number>
    ) => void
  ) {
    return (code: string, signedAdj: number) => {
      setter((prev) => {
        if (signedAdj === 0) {
          // No override — drop the entry to keep the export params clean.
          const { [code]: _drop, ...rest } = prev
          void _drop
          return rest
        }
        return { ...prev, [code]: signedAdj }
      })
    }
  }
  const setBlockAdj = makeSetAdjustment(setBlockAdjustments)
  const setBrickAdj = makeSetAdjustment(setBrickAdjustments)

  // ── Supply items adjustments. Same signed-delta model as the
  //    block / brick adjustments above, keyed by SupplyItem.id.
  //    Lets the user override the rate-driven quantity per supply
  //    item from inside the modal — useful for "I have 5 bags of
  //    cement on site already" or "add 2 extra ties for breakage."
  //    Applied AFTER the exporter's Math.ceil rounding, then clamped
  //    to >= 0. ──
  const [supplyItemAdjustments, setSupplyItemAdjustments] = useState<
    Record<string, number>
  >({})
  const setSupplyAdj = makeSetAdjustment(setSupplyItemAdjustments)
  // Per-export supply-item NAME overrides — keyed by item id, value
  // is the renamed label to display in the PDF. Empty string clears
  // the override (falls back to the library item's name). Stays
  // export-scoped (not persisted to the library) so the same item
  // can read differently on a per-quote basis without polluting the
  // master library.
  const [supplyItemNameOverrides, setSupplyItemNameOverrides] = useState<
    Record<string, string>
  >({})
  function setSupplyName(code: string, name: string | null) {
    setSupplyItemNameOverrides((prev) => {
      if (!name || !name.trim()) {
        const { [code]: _drop, ...rest } = prev
        void _drop
        return rest
      }
      return { ...prev, [code]: name.trim() }
    })
  }

  // ── Source of truth for the supply item library, same precedence
  //    as the SupplyItemsPanel and the exporters: org-synced list
  //    when an org is active, otherwise the personal IndexedDB list
  //    on userSettings. We read both unconditionally and pick at the
  //    point of use so the modal stays in sync as orgs switch. ──
  const { items: orgSupplyItems } = useOrgSupplyItems()
  const supplyItems: SupplyItem[] = currentOrg
    ? orgSupplyItems
    : userSettings.supplyItems ?? []

  // Per-trade metrics that drive the supply-item maths. Mirror the
  // exporter's logic 1:1 so the modal's preview qty matches the row
  // that lands in the PDF:
  //   - blockArea = Σ wallLength × wallHeight − Σ openingWidth × openingHeight
  //   - blockRun = Σ wallLength
  //   - openingCount = block openings
  //   - openingWidthsMm = per-opening widths (for width-ranged items)
  // and the same again for brick. Values flow off the already-
  // filtered includedWalls / blockOpenings / brickOpenings derived
  // above, so toggling areas updates this immediately.
  const blockMetrics = useMemo(() => {
    let lengthMm = 0
    let areaSqMm = 0
    const makeupsById = Object.fromEntries(blockMakeups.map((m) => [m.id, m]))
    for (const w of blockWalls) {
      const len = wallLengthMm(w)
      lengthMm += len
      const mk = makeupsById[w.makeupId]
      const h =
        w.heightMmOverride ??
        mk?.heightMm ??
        0
      areaSqMm += len * h
    }
    for (const o of blockOpenings) {
      areaSqMm -= o.widthMm * o.heightMm
    }
    if (areaSqMm < 0) areaSqMm = 0
    const tallyForBlocks = blockBaseTally
    const blockCount = Object.values(tallyForBlocks).reduce(
      (s, n) => s + n,
      0
    )
    return {
      areaSqM: areaSqMm / 1_000_000,
      lengthM: lengthMm / 1000,
      blockCount,
      openingCount: blockOpenings.length,
      openingWidthsMm: blockOpenings.map((o) => o.widthMm),
      // Parallel kind list so per-opening-sill (windows only) and
      // per-opening-head (everything) read from the same metrics
      // object as per-opening — same shape as PdfWorkspace's
      // supplyMetrics. 'window' is the default for older openings.
      openingKinds: blockOpenings.map((o) =>
        o.kind === 'door' ? ('door' as const) : ('window' as const),
      ),
    }
  }, [blockWalls, blockMakeups, blockOpenings, blockBaseTally])

  const brickMetrics = useMemo(() => {
    if (brickWalls.length === 0) {
      return {
        areaSqM: 0,
        lengthM: 0,
        brickCount: 0,
        openingCount: 0,
        openingWidthsMm: [] as number[],
        openingKinds: [] as Array<'window' | 'door'>,
      }
    }
    const tally = calculateBrickTally(
      brickWalls,
      brickOpenings,
      brickSettings,
      brickMakeups
    )
    return {
      areaSqM: tally.totalAreaSqMm / 1_000_000,
      lengthM: tally.totalLinealMm / 1000,
      brickCount: tally.brickCount,
      openingCount: brickOpenings.length,
      openingWidthsMm: brickOpenings.map((o) => o.widthMm),
      // Parallel kind list — see blockMetrics comment.
      openingKinds: brickOpenings.map((o) =>
        o.kind === 'door' ? ('door' as const) : ('window' as const),
      ),
    }
  }, [brickWalls, brickOpenings, brickSettings, brickMakeups])

  // Resolve a per-project rate for an item — override wins over the
  // library default. Lives inline rather than imported because we
  // also need to compute the qty alongside, and this keeps both
  // pieces of logic together.
  function resolveRate(item: SupplyItem): number {
    const override = supplyItemRateOverrides?.[item.id]
    return override !== undefined && Number.isFinite(override)
      ? override
      : item.rate
  }

  // Compute the rounded auto-tally quantity for a supply item against
  // a single trade's metrics. Same rules the exporters use — keep
  // these in sync.
  function autoQtyFor(
    item: SupplyItem,
    metrics:
      | typeof blockMetrics
      | typeof brickMetrics,
    mode: 'block' | 'brick'
  ): number {
    if (!item.appliesTo.includes(mode)) return 0
    const rate = resolveRate(item)
    let raw = 0
    switch (item.unit) {
      case 'each':
        raw = rate
        break
      case 'per-block':
        raw = mode === 'block' ? rate * (metrics as typeof blockMetrics).blockCount : 0
        break
      case 'per-brick':
        raw = mode === 'brick' ? rate * (metrics as typeof brickMetrics).brickCount : 0
        break
      case 'per-m2':
        raw = rate * metrics.areaSqM
        break
      case 'per-m-lineal':
        raw = rate * metrics.lengthM
        break
      case 'per-opening': {
        const min = item.openingWidthMinMm
        const max = item.openingWidthMaxMm
        const widths = metrics.openingWidthsMm
        let scope: number
        if (min === undefined && max === undefined) {
          scope = metrics.openingCount
        } else if (widths.length === 0) {
          // Caller didn't pass widths — fall back to total count
          // rather than silently zeroing the row (matches both
          // exporters' fallback).
          scope = metrics.openingCount
        } else {
          scope = widths.filter(
            (w) =>
              (min === undefined || w >= min) &&
              (max === undefined || w <= max)
          ).length
        }
        raw = rate * scope
        break
      }
      case 'per-opening-head':
      case 'per-opening-sill': {
        // Same shape as per-opening with an extra kind filter:
        // heads count every opening, sills count windows only
        // (doors have no sill). Width-range filter applies the
        // same way.
        const min = item.openingWidthMinMm
        const max = item.openingWidthMaxMm
        const widths = metrics.openingWidthsMm
        const kinds = metrics.openingKinds
        const isSill = item.unit === 'per-opening-sill'
        let scope = 0
        for (let i = 0; i < widths.length; i++) {
          const w = widths[i]
          const k = kinds[i] ?? 'window'
          if (isSill && k === 'door') continue
          if (min !== undefined && w < min) continue
          if (max !== undefined && w > max) continue
          scope++
        }
        raw = rate * scope
        break
      }
    }
    // Match the exporter exactly: round up at the item's chosen
    // decimal precision (0 dp → whole units, 1–3 dp → finer step).
    return Math.max(0, roundSupplyQuantity(raw, item))
  }

  // Trade-keyed base tallies for the supply table — { itemId → qty }
  // for items that have a non-zero auto count (or have a user
  // adjustment, so add-only rows surface even when the auto is 0).
  // The selections map gates which items appear: a supply item that
  // the user has unticked from the SupplyItemsPanel is hidden from
  // the modal too, since it can't be adjusted into the PDF anyway.
  const blockSupplyBaseTally = useMemo(() => {
    const out: Record<string, number> = {}
    for (const it of supplyItems) {
      if (!it.appliesTo.includes('block')) continue
      if (supplyItemSelections?.[it.id] === false) continue
      const q = autoQtyFor(it, blockMetrics, 'block')
      if (q > 0) out[it.id] = q
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supplyItems, blockMetrics, supplyItemSelections, supplyItemRateOverrides])

  const brickSupplyBaseTally = useMemo(() => {
    const out: Record<string, number> = {}
    for (const it of supplyItems) {
      if (!it.appliesTo.includes('brick')) continue
      if (supplyItemSelections?.[it.id] === false) continue
      const q = autoQtyFor(it, brickMetrics, 'brick')
      if (q > 0) out[it.id] = q
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supplyItems, brickMetrics, supplyItemSelections, supplyItemRateOverrides])

  // Lookup so the AdjustmentsTable's `describe` callback can resolve
  // names for both surface tallies. Keys are item ids.
  const supplyItemById = useMemo(
    () => Object.fromEntries(supplyItems.map((it) => [it.id, it])),
    [supplyItems]
  )
  function describeSupply(id: string): string {
    const it = supplyItemById[id]
    return it ? it.name : id
  }
  /**
   * Category resolver for the supply-item AdjustmentsTables. Returns
   * the item's library category (e.g. "Galintel", "Ties") or '' so
   * the table falls back to the 'Uncategorised' bucket. Read off the
   * id-indexed lookup so a row with an unknown id (shouldn't happen)
   * collapses cleanly.
   */
  function categoryForSupply(id: string): string {
    return supplyItemById[id]?.category ?? ''
  }

  // Picker options for the "+ Add supply item" controls. Filtered
  // per trade so brick-only items don't show in the block picker
  // and vice-versa. The picker uses the item's id as the row "code"
  // since supply items aren't identified by a short code like blocks.
  // Picker options for supply items — bare name only (no category
  // suffix); the picker's `<optgroup>` carries the category.
  //
  // We DON'T filter out items where supplyItemSelections[id] === false
  // here. The right-rail SupplyItemsPanel no longer exposes a
  // toggle, so the modal's "+ Add" picker is the user's only way to
  // bring an item that was previously excluded back into a project.
  // Picking such an item creates an adjustment that promotes its
  // count above zero and overrides the legacy exclusion in the
  // exporter (which only checks selections === false against the
  // auto-tally, not against user adjustments).
  const blockSupplyPickerOptions = useMemo(
    () =>
      supplyItems
        .filter((it) => it.appliesTo.includes('block'))
        .map((it) => ({ code: it.id, description: it.name }))
        .sort((a, b) => a.description.localeCompare(b.description)),
    [supplyItems]
  )
  const brickSupplyPickerOptions = useMemo(
    () =>
      supplyItems
        .filter((it) => it.appliesTo.includes('brick'))
        .map((it) => ({ code: it.id, description: it.name }))
        .sort((a, b) => a.description.localeCompare(b.description)),
    [supplyItems]
  )

  // Trade-scoped views of the shared supplyItemAdjustments map so the
  // block supply table doesn't list brick-only adjustments and vice
  // versa. The writer (setSupplyAdj) still mutates the shared map —
  // the item id is globally unique so an adjustment to a per-m² tie
  // count applies to whichever trade it surfaces in.
  const blockSupplyAdjustments = useMemo(() => {
    const out: Record<string, number> = {}
    for (const [id, v] of Object.entries(supplyItemAdjustments)) {
      if (supplyItemById[id]?.appliesTo.includes('block')) out[id] = v
    }
    return out
  }, [supplyItemAdjustments, supplyItemById])
  const brickSupplyAdjustments = useMemo(() => {
    const out: Record<string, number> = {}
    for (const [id, v] of Object.entries(supplyItemAdjustments)) {
      if (supplyItemById[id]?.appliesTo.includes('brick')) out[id] = v
    }
    return out
  }, [supplyItemAdjustments, supplyItemById])

  const hasBlockSupply =
    Object.keys(blockSupplyBaseTally).length > 0 ||
    Object.keys(blockSupplyAdjustments).length > 0
  const hasBrickSupply =
    Object.keys(brickSupplyBaseTally).length > 0 ||
    Object.keys(brickSupplyAdjustments).length > 0

  // ── Export-mode dispatch ──
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

  function buildBlockInclusions(): BlockExportInclusions {
    return {
      assumptions: sections.assumptions,
      wallSpecs: sections.schedules,
      blockSchedule: sections.schedules,
      wallTypeBreakdown: sections.schedules,
      measurements: sections.measurements,
      // 3D snapshots are gated by the user managing their own queue
      // in the 3D viewport (Capture button + Snapshots panel) — flag
      // is always on here so any queued snapshots land in the PDF.
      // If the queue is empty `view3dImages` is `[]` and the export
      // skips the pages anyway.
      view3d: true,
      disclaimer: sections.disclaimer,
    }
  }
  function buildBrickInclusions(): BrickExportInclusions {
    return {
      assumptions: sections.assumptions,
      wallLayout: sections.wallLayout,
      measurements: sections.measurements,
      brickAreaSummary: sections.schedules,
      // 3D snapshots gated by the user's queue in the 3D viewport.
      // Flag is always on here — queue empty → snapshot pages just
      // don't appear in the PDF.
      view3d: true,
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
      // Cover-page overrides — only forwarded when the user actually
      // entered something. Empty / whitespace-only fields stay
      // undefined so the exporter's fallback (projectName, site
      // address, etc.) kicks in instead of stamping a literal "" on
      // the page.
      const trimmedCoverTitle = coverTitle.trim()
      const trimmedCoverSubtitle = coverSubtitle.trim()
      const trimmedCoverIntro = coverIntro.trim()
      const coverOverrides =
        trimmedCoverTitle || trimmedCoverSubtitle || trimmedCoverIntro
          ? {
              title: trimmedCoverTitle || undefined,
              subtitle: trimmedCoverSubtitle || undefined,
              intro: trimmedCoverIntro || undefined,
            }
          : undefined
      const shared = {
        projectDetails,
        referenceNumber: referenceNumber ?? undefined,
        supplyItemSelections,
        supplyItemRateOverrides,
        supplyItemAdjustments,
        supplyItemNameOverrides,
        business: business(),
        pdfFile: pdfFile ?? undefined,
        coverOverrides,
      }
      // Read the 3D view snapshot queue (saved to localStorage by
      // the ▣ Capture button as a JSON array of {id, dataUrl,
      // createdAt, legend}). Storage is namespaced per-PROJECT AND
      // per-TRADE so block-mode captures live under :block and
      // brick-mode captures under :brick — that way the per-trade
      // exports (block estimate / brick estimate) only embed
      // snapshots that match their walls, and the combined export
      // includes both. A legacy `:no-trade` bucket is also read so
      // captures taken before the trade split still surface.
      // 3D captures: try the prop FIRST (correct path — state lives
      // on the SavedProject), fall back to window.__beme3dCurrentSnapshots
      // which PdfWorkspace mirrors the current project's captures
      // onto. The fallback exists because Vite HMR occasionally
      // ships a closure where the destructured prop binding is gone,
      // which previously made captures vanish silently. The window
      // mirror always holds the live React state.
      type Snap = {
        id: string
        dataUrl: string
        createdAt: number
        pageNumber?: number
        trade?: 'block' | 'brick'
        legend?: Array<{ code: string; label: string; color: string }>
      }
      let allSnapshots: Snap[] = []
      try {
        if (
          typeof view3dSnapshotsProp !== 'undefined' &&
          Array.isArray(view3dSnapshotsProp)
        ) {
          allSnapshots = view3dSnapshotsProp as Snap[]
        }
      } catch {
        // Stale closure — fall through to the window mirror below.
      }
      if (allSnapshots.length === 0) {
        try {
          const fromWindow = (
            window as Window & { __beme3dCurrentSnapshots?: Snap[] }
          ).__beme3dCurrentSnapshots
          if (Array.isArray(fromWindow)) allSnapshots = fromWindow
        } catch {
          // ignore
        }
      }
      const view3dSnapshots = (
        exportMode === 'combined'
          ? allSnapshots
          : exportMode === 'block'
            ? allSnapshots.filter((s) => s.trade !== 'brick')
            : exportMode === 'brick'
              ? allSnapshots.filter((s) => s.trade !== 'block')
              : []
      ).map((s) => ({ dataUrl: s.dataUrl, legend: s.legend ?? [] }))
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
          blockAdjustments,
          brickInclusions: buildBrickInclusions(),
          brickWalls,
          brickMakeups,
          brickOpenings,
          brickSettings,
          brickPagesInfo,
          brickAdjustments,
          areas,
          view3dSnapshots,
        })
      } else if (exportMode === 'block' || exportMode === 'brick') {
        if (exportMode === 'block') {
          await exportBlockEstimate({
            ...shared,
            inclusions: buildBlockInclusions(),
            walls: blockWalls,
            makeups: blockMakeups,
            openings: blockOpenings,
            piers: includedPiers,
            pierMakeups,
            pagesInfo: blockPagesInfo,
            blockAdjustments,
            // Per-area m² overrides from the Quantities section.
            perAreaBlockOverrides,
            // Wastage uplift % — undefined when the checkbox is off
            // (exporter renders no wastage column). Brick / block
            // totals only; supply items unaffected.
            wastagePercent:
              wastageEnabled && wastagePercent && wastagePercent > 0
                ? wastagePercent
                : undefined,
            view3dSnapshots,
          })
        } else {
          await exportBrickEstimate({
            ...shared,
            inclusions: buildBrickInclusions(),
            walls: brickWalls,
            openings: brickOpenings,
            settings: brickSettings,
            makeups: brickMakeups,
            // Project areas pass through so the Brickwork by Wall Type
            // table can group rows under area headings (First Floor /
            // Second Floor / etc.).
            areas,
            pagesInfo: brickPagesInfo,
            brickAdjustments,
            // Per-area m² / head lineal / sill lineal overrides from
            // the Quantities section. Empty when the user hasn't
            // touched any field — exporter falls back to auto values.
            perAreaBrickOverrides,
            // Wastage uplift % — undefined when the checkbox is off.
            // Applied to the headline brick m² figure only; supply
            // schedule + per-area Quantities pass through unchanged.
            wastagePercent:
              wastageEnabled && wastagePercent && wastagePercent > 0
                ? wastagePercent
                : undefined,
            view3dSnapshots,
          })
        }
      }
      toast.dismiss(progressId)
      toast.success('Estimate exported')
      onClose()
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

  const modeLabel =
    exportMode === 'combined'
      ? 'Combined block + brick'
      : exportMode === 'block'
        ? 'Block estimate'
        : exportMode === 'brick'
          ? 'Brick estimate'
          : 'No walls match the filter'

  // Skip the area picker entirely when there's only one area to choose
  // from (or none). One-area projects get auto-selected via the seed
  // above; there's nothing for the user to pick.
  const showAreaPicker = areas.length > 1

  // Footer quantity summary — Σ for the trades that actually have
  // walls included after the area filter. Drives the "scope of this
  // export" line in the footer so the user feels the impact of each
  // toggle in real time.
  const summaryStats = useMemo(() => {
    const totalBlocks = Object.values(blockBaseTally).reduce(
      (s, n) => s + n,
      0
    )
    const blockArea = blockMetrics.areaSqM
    const brickArea = brickMetrics.areaSqM
    const totalLengthM = blockMetrics.lengthM + brickMetrics.lengthM
    const supplyCount =
      Object.keys(blockSupplyBaseTally).length +
      Object.keys(brickSupplyBaseTally).length
    return {
      totalBlocks,
      blockArea,
      brickArea,
      totalLengthM,
      walls: includedWalls.length,
      openings: blockOpenings.length + brickOpenings.length,
      supplyCount,
    }
  }, [
    blockBaseTally,
    blockMetrics,
    brickMetrics,
    blockSupplyBaseTally,
    brickSupplyBaseTally,
    includedWalls,
    blockOpenings,
    brickOpenings,
  ])

  // Effective cover-page values for the live preview pane — overrides
  // take priority, fall back to the project details when blank.
  // Trimmed so a stray space doesn't beat the project name.
  const previewTitle =
    coverTitle.trim() ||
    projectDetails.projectName.trim() ||
    projectDetails.siteAddress.trim() ||
    'Untitled project'
  const previewSubtitle = coverSubtitle.trim()
  const previewIntro = coverIntro.trim()
  const previewSubaddress =
    projectDetails.siteAddress.trim() &&
    projectDetails.siteAddress.trim() !== previewTitle
      ? projectDetails.siteAddress.trim()
      : ''
  const previewBusiness = business()
  const previewModeLabel = modeLabel

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Export estimate"
    >
      <div
        className="bg-ink-800 border border-ink-600 rounded-2xl shadow-2xl w-full max-w-7xl max-h-[94vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header — wider modal earns a more substantial header.
            Title sits above a chip row that surfaces the export mode
            and (when overridden) the cover-page title so the user
            sees at-a-glance what's about to ship. */}
        <header className="px-6 py-3.5 border-b border-ink-600 flex items-start justify-between gap-4 bg-ink-900/40">
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-semibold text-ink-100 leading-tight">
              Export estimate
            </h2>
            <div className="mt-1 flex items-center gap-2 flex-wrap">
              <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-beme-500/15 border border-beme-500/30 text-[11px] text-beme-300 font-medium">
                {previewModeLabel}
              </span>
              <span className="text-[11px] text-ink-500 truncate">
                Cover · sections · areas · quantities · supplies
              </span>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-ink-400 hover:text-ink-100 text-2xl leading-none px-2 -mt-1"
            aria-label="Close"
          >
            ×
          </button>
        </header>

        {/* Body — three-column flex: left nav rail / middle settings
            scroll / right live cover preview. Each pane scrolls
            independently so a long supply list doesn't push the
            preview off-screen and the nav rail stays visible while
            the user works through the settings. */}
        <div className="flex-1 flex min-h-0">

          {/* LEFT — Section nav rail. Click each to anchor-scroll the
              middle column to that section. The active item gets a
              brand-tinted background so the user knows what they're
              reading even on long projects. */}
          <nav className="w-48 border-r border-ink-600 bg-ink-900/40 py-4 overflow-y-auto flex-shrink-0 hidden md:block">
            <SectionNavItem
              id="cover"
              label="Cover page"
              activeId={activeNavId}
              onClick={scrollToSection}
            />
            <SectionNavItem
              id="sections"
              label="Sections"
              activeId={activeNavId}
              onClick={scrollToSection}
            />
            {showAreaPicker && (
              <SectionNavItem
                id="areas"
                label="Areas"
                activeId={activeNavId}
                onClick={scrollToSection}
              />
            )}
            {(hasBlockTally || Object.keys(blockAdjustments).length > 0) && (
              <SectionNavItem
                id="quantities"
                label="Quantities"
                activeId={activeNavId}
                onClick={scrollToSection}
              />
            )}
            {(hasBlockSupply || hasBrickSupply) && (
              <SectionNavItem
                id="supplies"
                label="Supplies"
                activeId={activeNavId}
                onClick={scrollToSection}
              />
            )}
          </nav>

          {/* MIDDLE — Settings column. Each section gets its own ref
              so the nav rail can anchor-scroll. space-y-8 between
              sections gives generous breathing room — the wider
              canvas lets us slow down the vertical density. */}
          <div
            ref={settingsScrollRef}
            className="flex-1 overflow-y-auto px-6 py-5 space-y-8 min-w-0"
          >

            {/* Cover page editor — title, subtitle, intro. Per-export
                only; project details stay untouched. Plain text
                inputs so estimators can paste straight from email
                without formatting headaches. */}
            <section ref={coverSectionRef} id="cover">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-300 mb-1">
                Cover page
              </h3>
              <p className="text-[11px] text-ink-500 mb-3 leading-snug">
                Customise the title page for this export. Leave blank
                to use the project name. Changes don't save back to
                the project — they're scoped to this PDF only.
              </p>
              <div className="space-y-2.5">
                <label className="block">
                  <span className="block text-[11px] uppercase tracking-wide text-ink-400 mb-1">
                    Title
                  </span>
                  <input
                    type="text"
                    value={coverTitle}
                    onChange={(e) => setCoverTitle(e.target.value)}
                    placeholder={
                      projectDetails.projectName.trim() ||
                      projectDetails.siteAddress.trim() ||
                      'Project title'
                    }
                    className="w-full px-3 py-2 rounded-md bg-ink-900 border border-ink-600 text-sm text-ink-100 placeholder-ink-500 focus:outline-none focus:border-beme-500"
                  />
                </label>
                <label className="block">
                  <span className="block text-[11px] uppercase tracking-wide text-ink-400 mb-1">
                    Subtitle
                  </span>
                  <input
                    type="text"
                    value={coverSubtitle}
                    onChange={(e) => setCoverSubtitle(e.target.value)}
                    placeholder="e.g. Block + brickwork estimate"
                    className="w-full px-3 py-2 rounded-md bg-ink-900 border border-ink-600 text-sm text-ink-100 placeholder-ink-500 focus:outline-none focus:border-beme-500"
                  />
                </label>
                <label className="block">
                  <span className="block text-[11px] uppercase tracking-wide text-ink-400 mb-1">
                    Intro note
                  </span>
                  <textarea
                    value={coverIntro}
                    onChange={(e) => setCoverIntro(e.target.value)}
                    placeholder="e.g. Estimate covers ground-floor blockwork only — see attached drawings for scope of brickwork upper floor."
                    rows={3}
                    className="w-full px-3 py-2 rounded-md bg-ink-900 border border-ink-600 text-sm text-ink-100 placeholder-ink-500 focus:outline-none focus:border-beme-500 resize-y"
                  />
                </label>
              </div>
            </section>

            {/* Sections */}
            <section ref={sectionsSectionRef} id="sections">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-300 mb-1">
                Include in the PDF
              </h3>
              <p className="text-[11px] text-ink-500 mb-3 leading-snug">
                Pages to include. Skip the assumptions or disclaimer
                for quick internal-only exports; keep them on for
                anything going to the customer.
              </p>
              <div className="flex flex-col gap-1 pl-1">
                <SectionToggle
                  label="Assumptions"
                  checked={sections.assumptions}
                  onChange={(v) =>
                    setSections((s) => ({ ...s, assumptions: v }))
                  }
                />
                <SectionToggle
                  label="Wall layout pages"
                  checked={sections.wallLayout}
                  onChange={(v) =>
                    setSections((s) => ({ ...s, wallLayout: v }))
                  }
                />
                <SectionToggle
                  label="Ruler measurements on layout"
                  checked={sections.measurements}
                  onChange={(v) =>
                    setSections((s) => ({ ...s, measurements: v }))
                  }
                  disabled={!sections.wallLayout}
                  indent
                />
                <SectionToggle
                  label="Schedules & breakdowns"
                  checked={sections.schedules}
                  onChange={(v) =>
                    setSections((s) => ({ ...s, schedules: v }))
                  }
                />
                <SectionToggle
                  label="Disclaimer"
                  checked={sections.disclaimer}
                  onChange={(v) =>
                    setSections((s) => ({ ...s, disclaimer: v }))
                  }
                />
              </div>
            </section>

            {/* Areas */}
            {showAreaPicker && (
              <section ref={areasSectionRef} id="areas">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-300 mb-1">
                  Areas
                </h3>
                <p className="text-[11px] text-ink-500 mb-3 leading-snug">
                  Pick which areas to include. Each area's walls are
                  added to the schedule independently.
                </p>
                <div className="flex flex-col gap-1 pl-1">
                  <label className="flex items-center gap-2 text-sm font-medium text-ink-100 cursor-pointer hover:text-beme-300 pb-1 mb-1 border-b border-ink-700/60">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={toggleAll}
                      className="accent-beme-500"
                    />
                    <span>All areas</span>
                  </label>
                  {areas.map((a) => (
                    <label
                      key={a.id}
                      className="flex items-center gap-2 text-sm text-ink-200 cursor-pointer hover:text-ink-100"
                    >
                      <input
                        type="checkbox"
                        checked={selectedAreas.has(a.id)}
                        onChange={() => toggleArea(a.id)}
                        className="accent-beme-500"
                      />
                      {a.colorHex && (
                        <span
                          className="inline-block w-2 h-2 rounded-full flex-shrink-0"
                          style={{ backgroundColor: a.colorHex }}
                          aria-hidden
                        />
                      )}
                      <span className="flex-1 truncate">{a.name}</span>
                    </label>
                  ))}
                  {hasUnassignedWalls && (
                    <label className="flex items-center gap-2 text-sm text-ink-300 cursor-pointer hover:text-ink-100">
                      <input
                        type="checkbox"
                        checked={selectedAreas.has(UNASSIGNED)}
                        onChange={() => toggleArea(UNASSIGNED)}
                        className="accent-beme-500"
                      />
                      <span className="italic">Unassigned</span>
                    </label>
                  )}
                </div>
              </section>
            )}

            {/* Quantity adjustments — Blocks only. */}
            {(hasBlockTally || Object.keys(blockAdjustments).length > 0) && (
              <section ref={quantitiesSectionRef} id="quantities">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-300 mb-1">
                  Quantity adjustments
                </h3>
                <p className="text-[11px] text-ink-500 mb-3 leading-snug">
                  Each row shows the auto-tally quantity. Hit Edit to
                  override it with a different number — useful when
                  you want fewer (blocks on site, reused from another
                  job) or more (extras for breakage, future work). Use
                  the "+ Add" button to include a code that isn't on
                  the plan at all. Tallies respect the area filter
                  above — untick areas to remove their blocks from
                  the count.
                </p>
                {hasBlockTally && (
                  <AdjustmentsTable
                    label="Blocks"
                    baseTally={blockBaseTally}
                    adjustments={blockAdjustments}
                    onSetAdjustment={setBlockAdj}
                    describe={blockLabel}
                    availableCodes={blockPickerOptions}
                    addLabel="Add block"
                  />
                )}
              </section>
            )}

            {/* Per-area Quantities — collapsible cards per area, one
                per trade. Lets the user override the m² and (for
                brick) head + sill lineal m on a per-area basis. The
                final exported figure for each area = override ??
                auto-computed. Sits above Supply items so the user
                edits headline numbers first, supplies second. */}
            {(Object.keys(perAreaBrickMetrics).length > 0 ||
              Object.keys(perAreaBlockMetrics).length > 0) && (
              <section id="quantities">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-300 mb-1">
                  Quantities
                </h3>
                <p className="text-[11px] text-ink-500 mb-3 leading-snug">
                  Auto-calculated per area from the walls and openings
                  on the plan. Expand any area to override the m² (and
                  for brick, the head / sill lineal m) — useful when
                  you need to account for a renovation, or hand-tune
                  for unusual geometry. Empty fields fall back to the
                  auto value.
                </p>

                {/* Wastage uplift — single project-wide % applied to
                    the brick + block area / count totals on the
                    export. Wastage doesn't touch the per-area
                    overrides or the supply schedule (those are
                    estimator-managed allowances); it just stacks a
                    "+ X% wastage" column onto the area summary so the
                    deliverable shows BOTH the net figure AND the
                    ordered-with-wastage figure. */}
                <div className="mb-3 rounded-md border border-ink-700/80 bg-ink-900/40 px-3 py-2.5">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={wastageEnabled}
                      onChange={(e) => {
                        const next = e.target.checked
                        setWastageEnabled(next)
                        // Seed a sensible default the first time the box
                        // is ticked so the user isn't staring at an
                        // empty field.
                        if (next && wastagePercent === undefined) {
                          setWastagePercent(10)
                        }
                      }}
                      className="w-4 h-4 accent-beme-500"
                    />
                    <span className="text-sm font-medium text-ink-100">
                      Add wastage to brick + block totals
                    </span>
                  </label>
                  {wastageEnabled && (
                    <div className="mt-2 flex items-center gap-2 pl-6">
                      <label className="text-xs text-ink-300">Percent</label>
                      <input
                        type="number"
                        min="0"
                        max="100"
                        step="0.5"
                        value={wastagePercent ?? ''}
                        onChange={(e) => {
                          const v = parseFloat(e.target.value)
                          setWastagePercent(
                            Number.isFinite(v) && v >= 0 ? v : undefined,
                          )
                        }}
                        placeholder="10"
                        className="w-20 px-2 py-1 border border-ink-600 rounded text-sm bg-ink-900 text-ink-50 focus:outline-none focus:border-beme-400 tabular-nums"
                      />
                      <span className="text-sm text-ink-300">%</span>
                      <span className="text-[11px] text-ink-500 ml-2">
                        Adds a "+ wastage" column next to each net
                        figure on the export.
                      </span>
                    </div>
                  )}
                </div>

                {/* Brick areas */}
                {Object.keys(perAreaBrickMetrics).length > 0 && (
                  <div className="mb-3">
                    <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-400 mb-1.5">
                      Brick
                    </div>
                    <div className="space-y-1.5">
                      {areaSpecs
                        .filter((a) => perAreaBrickMetrics[a.id])
                        .map((a) => {
                          const m = perAreaBrickMetrics[a.id]
                          const key = `brick-${a.id}`
                          const expanded = !!expandedAreaCards[key]
                          const o = perAreaBrickOverrides[a.id] ?? {}
                          const setField = (
                            field: 'sqM' | 'headLinealM' | 'sillLinealM',
                            v: number | undefined,
                          ) => {
                            setPerAreaBrickOverrides((prev) => ({
                              ...prev,
                              [a.id]: { ...(prev[a.id] ?? {}), [field]: v },
                            }))
                          }
                          return (
                            <div
                              key={key}
                              className="rounded-lg border border-ink-700 bg-ink-900/40 overflow-hidden"
                            >
                              <button
                                type="button"
                                onClick={() =>
                                  setExpandedAreaCards((s) => ({
                                    ...s,
                                    [key]: !s[key],
                                  }))
                                }
                                className="w-full flex items-center justify-between gap-3 px-3 py-2 hover:bg-ink-800/40 transition-colors text-left"
                              >
                                <div className="flex items-center gap-2 min-w-0 flex-1">
                                  <span
                                    aria-hidden="true"
                                    className="inline-block w-2 h-2 rounded-full flex-shrink-0"
                                    style={{
                                      backgroundColor:
                                        a.colorHex ?? '#7a8896',
                                    }}
                                  />
                                  <span className="text-sm text-ink-100 font-medium truncate">
                                    {a.name}
                                  </span>
                                </div>
                                <div className="flex items-center gap-3 text-xs text-ink-400 tabular-nums">
                                  <span>
                                    <span className="text-ink-200 font-medium">
                                      {brickAreaValue(a.id, 'sqM').toFixed(2)}
                                    </span>{' '}
                                    m²
                                  </span>
                                  <span className="text-ink-500">
                                    {expanded ? '▾' : '▸'}
                                  </span>
                                </div>
                              </button>
                              {expanded && (
                                <div className="px-3 py-3 border-t border-ink-700 bg-ink-900/60 space-y-2.5 text-xs">
                                  <div className="grid grid-cols-2 gap-x-3 gap-y-2 text-[11px] text-ink-400">
                                    <div>
                                      <span className="text-ink-500">
                                        Walls
                                      </span>{' '}
                                      <span className="text-ink-200 tabular-nums">
                                        {m.wallCount}
                                      </span>
                                    </div>
                                    <div>
                                      <span className="text-ink-500">
                                        Openings
                                      </span>{' '}
                                      <span className="text-ink-200 tabular-nums">
                                        {m.openingCount}
                                      </span>
                                    </div>
                                  </div>
                                  <PerAreaInput
                                    label="Total m²"
                                    auto={m.sqM}
                                    value={o.sqM}
                                    unit="m²"
                                    onChange={(v) => setField('sqM', v)}
                                  />
                                  <PerAreaInput
                                    label="Head Lineal m"
                                    auto={m.headLinealM}
                                    value={o.headLinealM}
                                    unit="m"
                                    onChange={(v) => setField('headLinealM', v)}
                                  />
                                  <PerAreaInput
                                    label="Sill Lineal m"
                                    auto={m.sillLinealM}
                                    value={o.sillLinealM}
                                    unit="m"
                                    onChange={(v) => setField('sillLinealM', v)}
                                  />
                                  {/* Wall-type drilldown for brick areas.
                                      Same shape as block: each wall type is
                                      a collapsible row showing m² in this
                                      area; expanded reveals m² / head / sill
                                      inputs scoped to that wall type. */}
                                  {Object.keys(m.byMakeup).length > 0 && (
                                    <div className="space-y-1.5">
                                      <div className="text-[10px] uppercase tracking-wider font-semibold text-ink-400 pt-1">
                                        Wall types
                                      </div>
                                      <div className="space-y-1">
                                        {Object.entries(m.byMakeup)
                                          .sort(([ai], [bi]) => {
                                            const an =
                                              brickMakeups.find(
                                                (mk) => mk.id === ai,
                                              )?.name ?? ''
                                            const bn =
                                              brickMakeups.find(
                                                (mk) => mk.id === bi,
                                              )?.name ?? ''
                                            return an.localeCompare(bn)
                                          })
                                          .map(([makeupId, mkData]) => {
                                            const makeup = brickMakeups.find(
                                              (mk) => mk.id === makeupId,
                                            )
                                            const mkKey = `brick-${a.id}-mk-${makeupId}`
                                            const mkExpanded =
                                              !!expandedAreaCards[mkKey]
                                            const mkOv =
                                              o.byMakeup?.[makeupId] ?? {}
                                            const setMkField = (
                                              field:
                                                | 'sqM'
                                                | 'headLinealM'
                                                | 'sillLinealM',
                                              v: number | undefined,
                                            ) => {
                                              setPerAreaBrickOverrides((prev) => {
                                                const curr = prev[a.id] ?? {}
                                                const byMakeupCurr =
                                                  curr.byMakeup ?? {}
                                                const mkCurr =
                                                  byMakeupCurr[makeupId] ?? {}
                                                return {
                                                  ...prev,
                                                  [a.id]: {
                                                    ...curr,
                                                    byMakeup: {
                                                      ...byMakeupCurr,
                                                      [makeupId]: {
                                                        ...mkCurr,
                                                        [field]: v,
                                                      },
                                                    },
                                                  },
                                                }
                                              })
                                            }
                                            const mkDisplaySqM =
                                              typeof mkOv.sqM === 'number'
                                                ? mkOv.sqM
                                                : mkData.sqM
                                            return (
                                              <div
                                                key={mkKey}
                                                className="rounded-md border border-ink-700/80 overflow-hidden"
                                              >
                                                <button
                                                  type="button"
                                                  onClick={() =>
                                                    setExpandedAreaCards((s) => ({
                                                      ...s,
                                                      [mkKey]: !s[mkKey],
                                                    }))
                                                  }
                                                  className="w-full flex items-center justify-between gap-2 px-2.5 py-1.5 hover:bg-ink-800/40 transition-colors text-left"
                                                >
                                                  <span className="text-ink-100 text-[11px] font-medium truncate flex-1 min-w-0">
                                                    {makeup?.name ??
                                                      'Unknown wall type'}
                                                  </span>
                                                  <span className="text-[11px] text-ink-300 tabular-nums">
                                                    <span className="text-ink-200 font-medium">
                                                      {mkDisplaySqM.toFixed(2)}
                                                    </span>{' '}
                                                    m²
                                                  </span>
                                                  <span className="text-ink-500 text-[10px]">
                                                    {mkExpanded ? '▾' : '▸'}
                                                  </span>
                                                </button>
                                                {mkExpanded && (
                                                  <div className="px-2.5 py-2 border-t border-ink-700/60 bg-ink-900/40 space-y-2">
                                                    <PerAreaInput
                                                      label="m² in this area"
                                                      auto={mkData.sqM}
                                                      value={mkOv.sqM}
                                                      unit="m²"
                                                      onChange={(v) =>
                                                        setMkField('sqM', v)
                                                      }
                                                    />
                                                    <PerAreaInput
                                                      label="Head Lineal m"
                                                      auto={mkData.headLinealM}
                                                      value={mkOv.headLinealM}
                                                      unit="m"
                                                      onChange={(v) =>
                                                        setMkField(
                                                          'headLinealM',
                                                          v,
                                                        )
                                                      }
                                                    />
                                                    <PerAreaInput
                                                      label="Sill Lineal m"
                                                      auto={mkData.sillLinealM}
                                                      value={mkOv.sillLinealM}
                                                      unit="m"
                                                      onChange={(v) =>
                                                        setMkField(
                                                          'sillLinealM',
                                                          v,
                                                        )
                                                      }
                                                    />
                                                  </div>
                                                )}
                                              </div>
                                            )
                                          })}
                                      </div>
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>
                          )
                        })}
                    </div>
                  </div>
                )}

                {/* Block areas */}
                {Object.keys(perAreaBlockMetrics).length > 0 && (
                  <div>
                    <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-400 mb-1.5">
                      Block
                    </div>
                    <div className="space-y-1.5">
                      {areaSpecs
                        .filter((a) => perAreaBlockMetrics[a.id])
                        .map((a) => {
                          const m = perAreaBlockMetrics[a.id]
                          const key = `block-${a.id}`
                          const expanded = !!expandedAreaCards[key]
                          const o = perAreaBlockOverrides[a.id] ?? {}
                          const setField = (
                            field: 'sqM',
                            v: number | undefined,
                          ) => {
                            setPerAreaBlockOverrides((prev) => ({
                              ...prev,
                              [a.id]: { ...(prev[a.id] ?? {}), [field]: v },
                            }))
                          }
                          const setBlockCount = (
                            code: string,
                            v: number | undefined,
                          ) => {
                            setPerAreaBlockOverrides((prev) => {
                              const curr = prev[a.id] ?? {}
                              const blocks = { ...(curr.blocks ?? {}) }
                              if (typeof v === 'number') {
                                blocks[code] = v
                              } else {
                                delete blocks[code]
                              }
                              return {
                                ...prev,
                                [a.id]: { ...curr, blocks },
                              }
                            })
                          }
                          const sortedBlockCodes = Object.keys(m.blockTally).sort()
                          return (
                            <div
                              key={key}
                              className="rounded-lg border border-ink-700 bg-ink-900/40 overflow-hidden"
                            >
                              <button
                                type="button"
                                onClick={() =>
                                  setExpandedAreaCards((s) => ({
                                    ...s,
                                    [key]: !s[key],
                                  }))
                                }
                                className="w-full flex items-center justify-between gap-3 px-3 py-2 hover:bg-ink-800/40 transition-colors text-left"
                              >
                                <div className="flex items-center gap-2 min-w-0 flex-1">
                                  <span
                                    aria-hidden="true"
                                    className="inline-block w-2 h-2 rounded-full flex-shrink-0"
                                    style={{
                                      backgroundColor:
                                        a.colorHex ?? '#7a8896',
                                    }}
                                  />
                                  <span className="text-sm text-ink-100 font-medium truncate">
                                    {a.name}
                                  </span>
                                </div>
                                <div className="flex items-center gap-3 text-xs text-ink-400 tabular-nums">
                                  <span>
                                    <span className="text-ink-200 font-medium">
                                      {blockAreaValue(a.id, 'sqM').toFixed(2)}
                                    </span>{' '}
                                    m²
                                  </span>
                                  <span className="text-ink-500">
                                    {expanded ? '▾' : '▸'}
                                  </span>
                                </div>
                              </button>
                              {expanded && (
                                <div className="px-3 py-3 border-t border-ink-700 bg-ink-900/60 space-y-3 text-xs">
                                  <div className="grid grid-cols-2 gap-x-3 gap-y-2 text-[11px] text-ink-400">
                                    <div>
                                      <span className="text-ink-500">
                                        Walls
                                      </span>{' '}
                                      <span className="text-ink-200 tabular-nums">
                                        {m.wallCount}
                                      </span>
                                    </div>
                                    <div>
                                      <span className="text-ink-500">Run</span>{' '}
                                      <span className="text-ink-200 tabular-nums">
                                        {m.runM.toFixed(2)} m
                                      </span>
                                    </div>
                                  </div>
                                  <PerAreaInput
                                    label="Total m²"
                                    auto={m.sqM}
                                    value={o.sqM}
                                    unit="m²"
                                    onChange={(v) => setField('sqM', v)}
                                  />
                                  {/* Per-block-code editor for this area.
                                      Auto count from calculateProjectTally
                                      on the area's wall subset; override
                                      replaces the auto count at export
                                      time. Empty / cleared input falls
                                      back to auto. */}
                                  {sortedBlockCodes.length > 0 && (
                                    <div className="space-y-1.5">
                                      <div className="text-[10px] uppercase tracking-wider font-semibold text-ink-400 pt-1">
                                        Block breakdown
                                      </div>
                                      <div className="rounded-md border border-ink-700/80 divide-y divide-ink-700/60">
                                        {sortedBlockCodes.map((code) => {
                                          const autoCount = m.blockTally[code] ?? 0
                                          const ovCount =
                                            o.blocks?.[code]
                                          return (
                                            <div
                                              key={code}
                                              className="flex items-center justify-between gap-2 px-2.5 py-1.5"
                                            >
                                              <div className="min-w-0 flex-1">
                                                <div className="text-ink-100 font-mono text-[11px]">
                                                  {code}
                                                </div>
                                                <div className="text-ink-500 text-[10px] truncate">
                                                  {blockLabel(code) || '—'}
                                                </div>
                                              </div>
                                              <PerAreaCountInput
                                                auto={autoCount}
                                                value={ovCount}
                                                onChange={(v) =>
                                                  setBlockCount(code, v)
                                                }
                                              />
                                            </div>
                                          )
                                        })}
                                      </div>
                                    </div>
                                  )}
                                  {/* Wall-type drilldown — list every wall
                                      type used in this area, each
                                      expandable to a per-wall-type m²
                                      input + per-code editor scoped to
                                      that wall type only. */}
                                  {Object.keys(m.byMakeup).length > 0 && (
                                    <div className="space-y-1.5">
                                      <div className="text-[10px] uppercase tracking-wider font-semibold text-ink-400 pt-1">
                                        Wall types
                                      </div>
                                      <div className="space-y-1">
                                        {Object.entries(m.byMakeup)
                                          .sort(([ai], [bi]) => {
                                            const an =
                                              blockMakeups.find(
                                                (mk) => mk.id === ai,
                                              )?.name ?? ''
                                            const bn =
                                              blockMakeups.find(
                                                (mk) => mk.id === bi,
                                              )?.name ?? ''
                                            return an.localeCompare(bn)
                                          })
                                          .map(([makeupId, mkData]) => {
                                            const makeup = blockMakeups.find(
                                              (mk) => mk.id === makeupId,
                                            )
                                            const mkKey = `block-${a.id}-mk-${makeupId}`
                                            const mkExpanded =
                                              !!expandedAreaCards[mkKey]
                                            const mkOv =
                                              o.byMakeup?.[makeupId] ?? {}
                                            const setMkField = (
                                              field: 'sqM',
                                              v: number | undefined,
                                            ) => {
                                              setPerAreaBlockOverrides((prev) => {
                                                const curr = prev[a.id] ?? {}
                                                const byMakeupCurr =
                                                  curr.byMakeup ?? {}
                                                const mkCurr =
                                                  byMakeupCurr[makeupId] ?? {}
                                                return {
                                                  ...prev,
                                                  [a.id]: {
                                                    ...curr,
                                                    byMakeup: {
                                                      ...byMakeupCurr,
                                                      [makeupId]: {
                                                        ...mkCurr,
                                                        [field]: v,
                                                      },
                                                    },
                                                  },
                                                }
                                              })
                                            }
                                            const setMkBlockCount = (
                                              code: string,
                                              v: number | undefined,
                                            ) => {
                                              setPerAreaBlockOverrides((prev) => {
                                                const curr = prev[a.id] ?? {}
                                                const byMakeupCurr =
                                                  curr.byMakeup ?? {}
                                                const mkCurr =
                                                  byMakeupCurr[makeupId] ?? {}
                                                const blocks = {
                                                  ...(mkCurr.blocks ?? {}),
                                                }
                                                if (typeof v === 'number') {
                                                  blocks[code] = v
                                                } else {
                                                  delete blocks[code]
                                                }
                                                return {
                                                  ...prev,
                                                  [a.id]: {
                                                    ...curr,
                                                    byMakeup: {
                                                      ...byMakeupCurr,
                                                      [makeupId]: {
                                                        ...mkCurr,
                                                        blocks,
                                                      },
                                                    },
                                                  },
                                                }
                                              })
                                            }
                                            const mkAutoSqM = mkData.sqM
                                            const mkDisplaySqM =
                                              typeof mkOv.sqM === 'number'
                                                ? mkOv.sqM
                                                : mkAutoSqM
                                            const mkCodes = Object.keys(
                                              mkData.blockTally,
                                            ).sort()
                                            return (
                                              <div
                                                key={mkKey}
                                                className="rounded-md border border-ink-700/80 overflow-hidden"
                                              >
                                                <button
                                                  type="button"
                                                  onClick={() =>
                                                    setExpandedAreaCards((s) => ({
                                                      ...s,
                                                      [mkKey]: !s[mkKey],
                                                    }))
                                                  }
                                                  className="w-full flex items-center justify-between gap-2 px-2.5 py-1.5 hover:bg-ink-800/40 transition-colors text-left"
                                                >
                                                  <span className="text-ink-100 text-[11px] font-medium truncate flex-1 min-w-0">
                                                    {makeup?.name ??
                                                      'Unknown wall type'}
                                                  </span>
                                                  <span className="text-[11px] text-ink-300 tabular-nums">
                                                    <span className="text-ink-200 font-medium">
                                                      {mkDisplaySqM.toFixed(2)}
                                                    </span>{' '}
                                                    m²
                                                  </span>
                                                  <span className="text-ink-500 text-[10px]">
                                                    {mkExpanded ? '▾' : '▸'}
                                                  </span>
                                                </button>
                                                {mkExpanded && (
                                                  <div className="px-2.5 py-2 border-t border-ink-700/60 bg-ink-900/40 space-y-2">
                                                    <PerAreaInput
                                                      label="m² in this area"
                                                      auto={mkAutoSqM}
                                                      value={mkOv.sqM}
                                                      unit="m²"
                                                      onChange={(v) =>
                                                        setMkField('sqM', v)
                                                      }
                                                    />
                                                    {mkCodes.length > 0 && (
                                                      <div className="space-y-1">
                                                        <div className="text-[10px] uppercase tracking-wider font-semibold text-ink-500">
                                                          Blocks
                                                        </div>
                                                        <div className="rounded border border-ink-700/60 divide-y divide-ink-700/40">
                                                          {mkCodes.map(
                                                            (code) => {
                                                              const mkAuto =
                                                                mkData
                                                                  .blockTally[
                                                                  code
                                                                ] ?? 0
                                                              const mkOvVal =
                                                                mkOv.blocks?.[
                                                                  code
                                                                ]
                                                              return (
                                                                <div
                                                                  key={code}
                                                                  className="flex items-center justify-between gap-2 px-2 py-1"
                                                                >
                                                                  <div className="min-w-0 flex-1">
                                                                    <div className="text-ink-100 font-mono text-[10px]">
                                                                      {code}
                                                                    </div>
                                                                    <div className="text-ink-500 text-[9px] truncate">
                                                                      {blockLabel(
                                                                        code,
                                                                      ) || '—'}
                                                                    </div>
                                                                  </div>
                                                                  <PerAreaCountInput
                                                                    auto={mkAuto}
                                                                    value={
                                                                      mkOvVal
                                                                    }
                                                                    onChange={(
                                                                      v,
                                                                    ) =>
                                                                      setMkBlockCount(
                                                                        code,
                                                                        v,
                                                                      )
                                                                    }
                                                                  />
                                                                </div>
                                                              )
                                                            },
                                                          )}
                                                        </div>
                                                      </div>
                                                    )}
                                                  </div>
                                                )}
                                              </div>
                                            )
                                          })}
                                      </div>
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>
                          )
                        })}
                    </div>
                  </div>
                )}
              </section>
            )}

            {/* Supply items */}
            {(hasBlockSupply || hasBrickSupply) && (
              <section ref={suppliesSectionRef} id="supplies">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-300 mb-1">
                  Supply items
                </h3>
                <p className="text-[11px] text-ink-500 mb-3 leading-snug">
                  Auto-calculated from your Material-library rates and
                  the walls included above. Hit Edit to override a
                  quantity for this export (e.g. fewer cement bags
                  because some are already on site, or extra ties for
                  breakage). The library rates themselves stay
                  untouched.
                </p>
                {hasBlockSupply && (
                  <AdjustmentsTable
                    label="Block supplies"
                    baseTally={blockSupplyBaseTally}
                    adjustments={blockSupplyAdjustments}
                    onSetAdjustment={setSupplyAdj}
                    describe={describeSupply}
                    availableCodes={blockSupplyPickerOptions}
                    addLabel="Add supply item"
                    hideCode
                    groupBy={categoryForSupply}
                    nameOverrides={supplyItemNameOverrides}
                    onSetNameOverride={setSupplyName}
                  />
                )}
                {hasBrickSupply && (
                  <div className={hasBlockSupply ? 'mt-3' : ''}>
                    <AdjustmentsTable
                      label="Brick supplies"
                      baseTally={brickSupplyBaseTally}
                      adjustments={brickSupplyAdjustments}
                      onSetAdjustment={setSupplyAdj}
                      describe={describeSupply}
                      availableCodes={brickSupplyPickerOptions}
                      addLabel="Add supply item"
                      hideCode
                      groupBy={categoryForSupply}
                      nameOverrides={supplyItemNameOverrides}
                      onSetNameOverride={setSupplyName}
                    />
                  </div>
                )}
              </section>
            )}

            {/* Trailing whitespace so the last section can scroll all
                the way to the top of the viewport — without this,
                "Supplies" can only reach mid-screen before bottoming
                out and the nav rail's active state stops tracking. */}
            <div className="h-32" aria-hidden />
          </div>

          {/* RIGHT — Live cover-page preview. Sticky on lg+; hidden
              on narrow viewports. Updates as the user types in the
              cover section. Renders a faithful mini-cover with
              brand block, title, subtitle, project meta, intro.
              Wider than a portrait pane so the landscape preview has
              room to breathe — at w-[28rem] the mini comes out at
              ~316px tall, comfortable to read without dominating
              the modal. */}
          <aside className="w-[28rem] border-l border-ink-600 bg-ink-900/40 overflow-y-auto flex-shrink-0 hidden lg:block">
            <div className="p-5">
              <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-500 mb-2">
                Cover preview
              </div>
              <CoverPagePreview
                title={previewTitle}
                subtitle={previewSubtitle}
                intro={previewIntro}
                siteAddress={previewSubaddress}
                clientName={projectDetails.clientName.trim()}
                date={projectDetails.date}
                referenceNumber={referenceNumber ?? null}
                business={previewBusiness}
                modeLabel={previewModeLabel}
              />
              <p className="text-[10px] text-ink-500 mt-3 leading-snug">
                Final PDF uses your settings letterhead and exact
                fonts. Layout above is a faithful mini — proportions
                won't change.
              </p>
            </div>
          </aside>
        </div>

        {/* Footer — beefier than before. Left side carries the live
            quantity summary so the user feels the scope of the
            current export as they toggle areas and sections. Right
            side: ghost Cancel + a primary Export button that's
            sized to look like the deliverable's "go" button, with a
            ⌘⏎ chip for the keyboard shortcut. */}
        <footer className="px-6 py-3 border-t border-ink-600 bg-ink-900/40 flex items-center justify-between gap-4">
          <div className="min-w-0 flex-1">
            {error ? (
              <p className="text-xs text-rose-300 leading-snug">
                {error}
              </p>
            ) : !canExport ? (
              <p className="text-xs text-ink-400 leading-snug">
                Tick at least one area with walls to enable export.
              </p>
            ) : (
              <div className="flex items-center gap-3 flex-wrap text-xs tabular-nums">
                <span className="inline-flex items-center gap-1.5">
                  <span className="text-ink-500">Walls</span>
                  <span className="text-ink-100 font-semibold">
                    {summaryStats.walls}
                  </span>
                </span>
                {summaryStats.totalBlocks > 0 && (
                  <span className="inline-flex items-center gap-1.5">
                    <span className="text-ink-500">Blocks</span>
                    <span className="text-ink-100 font-semibold">
                      {summaryStats.totalBlocks.toLocaleString()}
                    </span>
                  </span>
                )}
                {(summaryStats.blockArea > 0 || summaryStats.brickArea > 0) && (
                  <span className="inline-flex items-center gap-1.5">
                    <span className="text-ink-500">m²</span>
                    <span className="text-ink-100 font-semibold">
                      {(summaryStats.blockArea + summaryStats.brickArea).toFixed(2)}
                    </span>
                  </span>
                )}
                {summaryStats.totalLengthM > 0 && (
                  <span className="inline-flex items-center gap-1.5">
                    <span className="text-ink-500">Run</span>
                    <span className="text-ink-100 font-semibold">
                      {summaryStats.totalLengthM.toFixed(2)} m
                    </span>
                  </span>
                )}
                {summaryStats.openings > 0 && (
                  <span className="inline-flex items-center gap-1.5">
                    <span className="text-ink-500">Openings</span>
                    <span className="text-ink-100 font-semibold">
                      {summaryStats.openings}
                    </span>
                  </span>
                )}
                {summaryStats.supplyCount > 0 && (
                  <span className="inline-flex items-center gap-1.5">
                    <span className="text-ink-500">Supplies</span>
                    <span className="text-ink-100 font-semibold">
                      {summaryStats.supplyCount}
                    </span>
                  </span>
                )}
              </div>
            )}
          </div>
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg text-ink-300 text-sm hover:text-ink-100 hover:bg-ink-700/60 transition-colors flex-shrink-0"
          >
            Cancel
          </button>
          <button
            onClick={handleExport}
            disabled={busy || !canExport}
            data-export-action="export"
            className="px-5 py-2 rounded-lg bg-beme-500 text-black text-base font-semibold hover:bg-beme-400 disabled:opacity-40 disabled:cursor-not-allowed transition-colors inline-flex items-center gap-2 flex-shrink-0 shadow-lg shadow-beme-500/20"
          >
            <span>{busy ? 'Opening preview…' : 'Export'}</span>
            {!busy && (
              <kbd className="hidden sm:inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-black/15 text-[10px] font-mono">
                ⌘⏎
              </kbd>
            )}
          </button>
        </footer>
      </div>
    </div>
  )
}

// ─── Internal: cover-page preview ──────────────────────────────────

/**
 * Faithful mini of the cover page that the export will render. Used
 * inside the export modal's right pane so the user sees their cover
 * changes (title, subtitle, intro) land before they hit Export.
 *
 * Stays proportionally similar to the real cover (brand block top,
 * big title + subtitle, meta strip, intro paragraph) but scaled to
 * fit the modal column. We deliberately don't iframe / SSR the actual
 * exporter HTML — that would mean spinning up react-pdf or rendering
 * a hidden full-page document just to grab a thumbnail. The mini
 * tracks the cover content one-to-one and that's enough to validate
 * "yes this is the version I want to send".
 */
function CoverPagePreview({
  title,
  subtitle,
  intro,
  siteAddress,
  clientName,
  date,
  referenceNumber,
  business,
  modeLabel,
}: {
  title: string
  subtitle: string
  intro: string
  siteAddress: string
  clientName: string
  date: string | undefined
  referenceNumber: number | null
  business: { companyName?: string; logoUrl?: string }
  modeLabel: string
}) {
  // 1:√2 portrait aspect (A-series proportions, what a real PDF page
  // looks like). Width is 100% of the container, height derives from
  // aspect so the preview always feels like an actual sheet of paper.
  const formattedDate = date
    ? new Date(date).toLocaleDateString('en-AU', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      })
    : ''
  return (
    <div
      className="bg-white text-ink-900 rounded-md shadow-2xl shadow-black/40 overflow-hidden border border-ink-600 flex flex-col"
      // A4 landscape — √2 : 1 aspect. Matches `@page { size: A4
      // landscape }` in the exporter so the preview matches what
      // prints, not the legacy portrait shape.
      style={{ aspectRatio: '1.414 / 1' }}
    >
      {/* Letterhead strip — mirrors the real cover's brand block. */}
      <div className="px-5 pt-4 pb-2.5 border-b border-stone-200 flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          {business?.logoUrl ? (
            // Logo as the brand mark when set — matches exporter rule.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={business.logoUrl}
              alt={business.companyName ?? 'Brand'}
              className="max-h-7 max-w-full object-contain"
            />
          ) : business?.companyName ? (
            <div className="text-[11px] font-bold tracking-wide text-stone-800 truncate">
              {business.companyName}
            </div>
          ) : (
            <div className="text-[11px] font-bold tracking-wide text-stone-800">
              beme
            </div>
          )}
        </div>
        <div className="text-right flex-shrink-0">
          <div className="text-[8px] uppercase tracking-[0.14em] text-stone-500">
            {modeLabel}
          </div>
          {typeof referenceNumber === 'number' && (
            <div className="text-[8px] text-stone-500 mt-0.5 font-mono">
              #{String(referenceNumber).padStart(6, '0')}
            </div>
          )}
        </div>
      </div>

      {/* Body — two-column landscape layout. Title block on the
          left half (eats up the broad horizontal canvas with a
          larger headline), meta block on the right half. Intro
          paragraph spans full width below if set. */}
      <div className="flex-1 px-5 py-3 flex flex-col min-h-0">
        <div className="flex gap-5 mt-1">
          <div className="flex-[3] min-w-0">
            <div className="text-[8px] uppercase tracking-[0.14em] text-stone-500 font-semibold mb-1">
              {modeLabel}
            </div>
            <h1 className="text-[15px] font-extrabold leading-tight tracking-tight text-stone-900 break-words">
              {title}
            </h1>
            {subtitle && (
              <p className="text-[10px] text-stone-600 mt-1.5 leading-snug break-words">
                {subtitle}
              </p>
            )}
          </div>
          <div className="flex-[2] min-w-0 border-l border-stone-200 pl-4">
            <dl className="space-y-1.5 text-[8px]">
              {siteAddress && (
                <div>
                  <dt className="uppercase tracking-wide text-stone-500">
                    Site
                  </dt>
                  <dd className="text-stone-800 font-medium break-words leading-snug">
                    {siteAddress}
                  </dd>
                </div>
              )}
              {clientName && (
                <div>
                  <dt className="uppercase tracking-wide text-stone-500">
                    Client
                  </dt>
                  <dd className="text-stone-800 font-medium break-words leading-snug">
                    {clientName}
                  </dd>
                </div>
              )}
              {formattedDate && (
                <div>
                  <dt className="uppercase tracking-wide text-stone-500">
                    Date
                  </dt>
                  <dd className="text-stone-800 font-medium leading-snug">
                    {formattedDate}
                  </dd>
                </div>
              )}
            </dl>
          </div>
        </div>

        {/* Intro paragraph spans the full width — landscape gives us
            ~22cm of typing room, perfect for a single readable line
            of body text instead of the cramped narrow column the
            portrait layout had. */}
        {intro && (
          <div className="mt-3 pt-3 border-t border-stone-200 flex-1 min-h-0 overflow-hidden">
            <p className="text-[8px] text-stone-700 leading-relaxed whitespace-pre-wrap break-words">
              {intro}
            </p>
          </div>
        )}
      </div>

      {/* Faux footer — reads as "PDF page furniture" so the preview
          settles as a real document, not just floating content. */}
      <div className="px-5 py-1.5 border-t border-stone-200 text-[7px] text-stone-400 flex items-center justify-between">
        <span>Page 1</span>
        {business?.companyName && (
          <span className="truncate ml-2">{business.companyName}</span>
        )}
      </div>
    </div>
  )
}

// ─── Internal: section nav item ────────────────────────────────────

function SectionNavItem({
  id,
  label,
  activeId,
  onClick,
}: {
  id: 'cover' | 'sections' | 'areas' | 'quantities' | 'supplies'
  label: string
  activeId: string
  onClick: (id: 'cover' | 'sections' | 'areas' | 'quantities' | 'supplies') => void
}) {
  const active = activeId === id
  return (
    <button
      type="button"
      onClick={() => onClick(id)}
      className={`w-full text-left px-4 py-2 text-sm transition-colors ${
        active
          ? 'bg-beme-500/15 text-beme-300 border-l-2 border-beme-500'
          : 'text-ink-300 hover:text-ink-100 hover:bg-ink-700/40 border-l-2 border-transparent'
      }`}
    >
      {label}
    </button>
  )
}

// ─── Internal: adjustments table ──────────────────────────────────

interface AdjustmentsTableProps {
  /** Section label rendered above the table (e.g. "Blocks", "Bricks"). */
  label: string
  /** Auto-tally rows from the calc engine, keyed by code. */
  baseTally: Record<string, number>
  /** Current signed adjustments, keyed by code. Missing → 0.
   *  Positive = remove, negative = add. */
  adjustments: Record<string, number>
  /** Replace the current adjustment for `code`. Passing 0 means "no
   *  override" — caller should drop the entry from the map. */
  onSetAdjustment: (code: string, signedAdj: number) => void
  /** Resolves a human-readable description for a code. */
  describe: (code: string) => string
  /** Library of available codes for the "+ Add" picker. */
  availableCodes: Array<{ code: string; description: string }>
  /** Label for the "+ Add" button (e.g. "Add block", "Add brick"). */
  addLabel: string
  /**
   * When true, suppress the monospace `code` prefix in each row and
   * show only the `describe(code)` text. Used for supply items where
   * the "code" is a UUID that's meaningless to the user — the
   * describe callback already returns a friendly "Name · Category"
   * label. Default false so blocks/bricks keep their short codes
   * (e.g. "standard", "200x200x90") visible as before.
   */
  hideCode?: boolean
  /**
   * Optional category resolver. When provided, rows are grouped by
   * the returned label and each group renders under a small header
   * inside the table. The "+ Add" picker also gets an `<optgroup>`
   * per category. Returning '' or undefined buckets a code under
   * 'Uncategorised'. Used to break the supply-items table into
   * "Ties", "Galintel", "Cement" etc. so it stays scannable as the
   * library grows.
   */
  groupBy?: (code: string) => string | undefined
  /**
   * Optional per-row name overrides. When present, the row's
   * displayed label uses `nameOverrides[code]` instead of
   * `describe(code)`. Used by supply-item tables so the user can
   * rename a row inline (e.g. "Galintel 1500" → "Lintel above
   * front door") for THIS export only.
   */
  nameOverrides?: Record<string, string>
  /**
   * Optional setter for name overrides. When provided, the inline
   * edit panel also surfaces a name input alongside the quantity
   * input. Pass `null` for the second arg to clear the override.
   */
  onSetNameOverride?: (code: string, name: string | null) => void
}

function AdjustmentsTable({
  label,
  baseTally,
  adjustments,
  onSetAdjustment,
  describe,
  availableCodes,
  addLabel,
  hideCode = false,
  groupBy,
  nameOverrides,
  onSetNameOverride,
}: AdjustmentsTableProps) {
  // Resolve the label that should display for this row — prefer
  // the per-export name override (if the caller passes one) over
  // the library / calc engine's description.
  function labelFor(code: string): string {
    const overridden = nameOverrides?.[code]
    if (overridden && overridden.trim()) return overridden
    return describe(code)
  }
  // Combine the auto-tally codes with any add-only adjustments so
  // user-added entries appear in the row list even when they're not
  // in the original tally.
  const rows = useMemo(() => {
    const allCodes = new Set<string>([
      ...Object.keys(baseTally),
      ...Object.keys(adjustments),
    ])
    return Array.from(allCodes)
      .map((code) => {
        const base = baseTally[code] ?? 0
        const adj = adjustments[code] ?? 0
        return {
          code,
          base,
          adj,
          final: Math.max(0, base - adj),
        }
      })
      .filter((r) => r.final > 0 || r.adj !== 0)
      .sort((a, b) => b.final - a.final)
  }, [baseTally, adjustments])

  // Group rows by category when a groupBy resolver is supplied.
  // Insertion order follows first appearance in `rows` so a busy
  // category (more / bigger rows) bubbles to the top, matching the
  // existing per-row sort behaviour. Empty / undefined categories
  // fall under 'Uncategorised', which is always rendered last so a
  // single uncategorised row doesn't fragment the more meaningful
  // categories above.
  const UNCATEGORISED = 'Uncategorised'
  const groupedRows = useMemo(() => {
    if (!groupBy) return null
    const map = new Map<string, typeof rows>()
    for (const r of rows) {
      const key = groupBy(r.code)?.trim() || UNCATEGORISED
      const ex = map.get(key)
      if (ex) ex.push(r)
      else map.set(key, [r])
    }
    // Pull Uncategorised to the end if present, otherwise keep
    // insertion order so the busiest category leads.
    const entries = Array.from(map.entries())
    return entries.sort((a, b) => {
      if (a[0] === UNCATEGORISED) return 1
      if (b[0] === UNCATEGORISED) return -1
      return 0
    })
  }, [rows, groupBy])

  // Picker options grouped by category too — when groupBy is set we
  // render <optgroup>s so the "+ Add" dropdown stays scannable.
  const groupedPickerOptions = useMemo(() => {
    if (!groupBy) return null
    const map = new Map<string, typeof availableCodes>()
    for (const opt of availableCodes) {
      const key = groupBy(opt.code)?.trim() || UNCATEGORISED
      const ex = map.get(key)
      if (ex) ex.push(opt)
      else map.set(key, [opt])
    }
    return Array.from(map.entries()).sort((a, b) => {
      if (a[0] === UNCATEGORISED) return 1
      if (b[0] === UNCATEGORISED) return -1
      return a[0].localeCompare(b[0])
    })
  }, [availableCodes, groupBy])

  // Which row is in inline-edit mode (one at a time). null = nothing
  // being edited. The draft value lives alongside so Cancel can
  // restore without writing through to the parent.
  const [editingCode, setEditingCode] = useState<string | null>(null)
  const [draftValue, setDraftValue] = useState<string>('')
  // Draft name for supply-item rename. Only surfaces in the edit
  // panel when `onSetNameOverride` is supplied by the parent
  // (currently: supply-item tables only). Persists the typed name
  // independently from the qty draft so Cancel reverts both.
  const [draftName, setDraftName] = useState<string>('')
  // Open-state for the "+ Add" picker — keeps the form inline below
  // the table without needing a separate modal.
  const [adding, setAdding] = useState(false)
  const [addCode, setAddCode] = useState('')
  const [addQty, setAddQty] = useState<string>('')

  function beginEdit(code: string, final: number) {
    setEditingCode(code)
    setDraftValue(String(final))
    // Seed the name draft with the CURRENT label (override or
    // describe(code)) so the user sees what they're editing.
    setDraftName(labelFor(code))
  }
  function commitEdit(base: number) {
    if (editingCode === null) return
    const parsed = parseInt(draftValue, 10)
    if (Number.isFinite(parsed)) {
      const finalCount = Math.max(0, parsed)
      // Signed delta = base - finalCount. Positive removes,
      // negative adds. Zero means no override (drop the entry).
      onSetAdjustment(editingCode, base - finalCount)
    }
    // Name override — only meaningful when the parent supplied a
    // setter. Pushing the bare describe(code) back as the "name"
    // would create a noisy override; only persist when the user
    // actually changed it.
    if (onSetNameOverride) {
      const trimmed = draftName.trim()
      const base = describe(editingCode).trim()
      if (!trimmed || trimmed === base) {
        onSetNameOverride(editingCode, null)
      } else {
        onSetNameOverride(editingCode, trimmed)
      }
    }
    setEditingCode(null)
  }
  function cancelEdit() {
    setEditingCode(null)
  }

  function submitAdd() {
    const qty = parseInt(addQty, 10)
    if (!addCode || !Number.isFinite(qty) || qty <= 0) return
    // Add row → final desired = qty, base = 0 (or whatever the tally
    // has if this code is somehow already there). Adjustment = base -
    // qty, which is negative for an add-only entry.
    const base = baseTally[addCode] ?? 0
    onSetAdjustment(addCode, base - qty)
    setAdding(false)
    setAddCode('')
    setAddQty('')
  }

  // Codes available in the "+ Add" picker — show ALL library codes so
  // the user can add anything, including codes already in the tally
  // (in which case it just bumps the final count via an add adjustment).
  const pickerOptions = availableCodes

  // Renders one quantity row. Pulled out of the JSX so the grouped
  // and flat layouts share identical markup — the only difference
  // between them is whether category headers get interleaved above
  // the rows. All edit-mode handlers are closed over from the
  // enclosing component, so this stays a plain function (not a
  // React subcomponent — we'd lose the focus-on-edit transition if
  // a parent re-render unmounted the input).
  function renderRow(r: {
    code: string
    base: number
    adj: number
    final: number
  }) {
    const { code, base, adj, final } = r
    const isEditing = editingCode === code
    const isAdjusted = adj !== 0
    return (
      <div
        key={code}
        className="grid grid-cols-[1fr_auto_auto] gap-x-3 px-3 py-1.5 text-xs text-ink-100 items-center"
      >
        <span className="truncate">
          {isEditing && onSetNameOverride ? (
            // Rename input — only when this row's table supports
            // name overrides (currently supply-item tables only).
            // Takes the full label column so the user can type a
            // long descriptive name like "Lintel above front door".
            <input
              type="text"
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  commitEdit(base)
                } else if (e.key === 'Escape') {
                  e.preventDefault()
                  cancelEdit()
                }
              }}
              placeholder={describe(code)}
              className="w-full px-2 py-0.5 bg-ink-900 border border-beme-400 rounded text-xs focus:outline-none text-ink-100"
            />
          ) : hideCode ? (
            <span className="text-ink-200">{labelFor(code)}</span>
          ) : (
            <>
              <span className="font-mono text-ink-300">{code}</span>{' '}
              <span className="text-ink-500">{labelFor(code)}</span>
            </>
          )}
        </span>
        {isEditing ? (
          <input
            type="number"
            min="0"
            step="1"
            // Only autofocus qty when name editing isn't available
            // — when name editing IS available, autofocus the
            // name input (it's the new field and usually what the
            // user is here to change).
            autoFocus={!onSetNameOverride}
            value={draftValue}
            onChange={(e) => setDraftValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                commitEdit(base)
              } else if (e.key === 'Escape') {
                e.preventDefault()
                cancelEdit()
              }
            }}
            className="w-20 text-right px-2 py-0.5 bg-ink-900 border border-beme-400 rounded text-xs font-mono focus:outline-none"
          />
        ) : (
          <span
            className={`text-right font-mono font-semibold ${
              isAdjusted ? 'text-beme-300' : 'text-ink-200'
            }`}
            title={
              isAdjusted
                ? `Auto-tally: ${base} · adjusted by ${
                    adj > 0 ? `−${adj}` : `+${-adj}`
                  }`
                : undefined
            }
          >
            {final}
          </span>
        )}
        {isEditing ? (
          <span className="flex items-center gap-1 justify-end w-auto">
            <button
              type="button"
              onClick={() => commitEdit(base)}
              className="px-2 py-0.5 text-[11px] rounded bg-beme-500 text-black hover:bg-beme-400"
            >
              Save
            </button>
            <button
              type="button"
              onClick={cancelEdit}
              className="px-2 py-0.5 text-[11px] rounded border border-ink-600 text-ink-300 hover:bg-ink-700"
            >
              Cancel
            </button>
          </span>
        ) : (
          <button
            type="button"
            onClick={() => beginEdit(code, final)}
            className="text-[11px] text-beme-400 hover:text-beme-300 px-2 py-0.5 rounded hover:bg-ink-700 w-12 text-right"
          >
            Edit
          </button>
        )}
      </div>
    )
  }

  return (
    <>
      <div className="border border-ink-700 rounded-lg overflow-hidden">
        <div className="grid grid-cols-[1fr_auto_auto] gap-x-3 px-3 py-1.5 bg-ink-900/40 text-[10px] uppercase tracking-wider text-ink-400 font-semibold border-b border-ink-700">
          <span>{label}</span>
          <span className="text-right">Quantity</span>
          <span className="text-right w-12"></span>
        </div>
        <div className="max-h-72 overflow-y-auto divide-y divide-ink-700/60">
          {/* When grouped, interleave a small category header before
              each group's rows. When ungrouped (blocks/bricks), the
              else-branch renders the original flat list unchanged. */}
          {groupedRows
            ? groupedRows.map(([category, groupRowsArr]) => (
                <div key={category} className="divide-y divide-ink-700/60">
                  {/* Only show the header when there's more than one
                      group, OR the only group is a real category (not
                      'Uncategorised'). A single uncategorised group
                      doesn't need a redundant header. */}
                  {(groupedRows.length > 1 || category !== UNCATEGORISED) && (
                    <div className="px-3 py-1 bg-ink-900/30 text-[10px] uppercase tracking-wider text-ink-500 font-semibold">
                      {category}
                    </div>
                  )}
                  {groupRowsArr.map((r) => renderRow(r))}
                </div>
              ))
            : rows.map((r) => renderRow(r))}
          {rows.length === 0 && (
            <div className="px-3 py-3 text-[11px] text-ink-500 italic">
              No rows — add one below to include something not on the plan.
            </div>
          )}
        </div>
      </div>
      {/* Add-row form. Click button → inline form appears with a
          code picker + quantity input. Stays inside the table card
          for visual cohesion. */}
      {adding ? (
        <div className="mt-2 p-3 rounded-lg border border-ink-600 bg-ink-900/40 space-y-2">
          <div className="grid grid-cols-[1fr_auto] gap-2 items-end">
            <label className="text-xs text-ink-300">
              <span className="block mb-1">Code</span>
              <select
                value={addCode}
                onChange={(e) => setAddCode(e.target.value)}
                className="w-full px-2 py-1 bg-ink-900 border border-ink-600 rounded text-xs text-ink-100 focus:outline-none focus:border-beme-400"
              >
                <option value="">— pick one —</option>
                {groupedPickerOptions
                  ? groupedPickerOptions.map(([category, opts]) => (
                      <optgroup key={category} label={category}>
                        {opts.map((opt) => (
                          <option key={opt.code} value={opt.code}>
                            {hideCode
                              ? opt.description || opt.code
                              : `${opt.code}${
                                  opt.description
                                    ? ` — ${opt.description}`
                                    : ''
                                }`}
                          </option>
                        ))}
                      </optgroup>
                    ))
                  : pickerOptions.map((opt) => (
                      <option key={opt.code} value={opt.code}>
                        {hideCode
                          ? opt.description || opt.code
                          : `${opt.code}${
                              opt.description ? ` — ${opt.description}` : ''
                            }`}
                      </option>
                    ))}
              </select>
            </label>
            <label className="text-xs text-ink-300">
              <span className="block mb-1">Quantity</span>
              <input
                type="number"
                min="1"
                step="1"
                value={addQty}
                onChange={(e) => setAddQty(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    submitAdd()
                  }
                }}
                placeholder="0"
                className="w-24 px-2 py-1 bg-ink-900 border border-ink-600 rounded text-xs text-ink-100 text-right font-mono focus:outline-none focus:border-beme-400"
              />
            </label>
          </div>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                setAdding(false)
                setAddCode('')
                setAddQty('')
              }}
              className="px-3 py-1 text-xs rounded-lg border border-ink-600 text-ink-200 hover:bg-ink-700"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={submitAdd}
              disabled={!addCode || !addQty}
              className="px-3 py-1 text-xs rounded-lg bg-beme-500 text-black hover:bg-beme-400 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Add
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="mt-2 px-3 py-1 text-xs text-beme-400 hover:text-beme-300 rounded-lg border border-ink-600 hover:border-beme-500/60 hover:bg-ink-700/40"
        >
          + {addLabel}
        </button>
      )}
    </>
  )
}

// ─── Internal: section toggle row ─────────────────────────────────

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
      className={`flex items-center gap-2 text-sm cursor-pointer ${
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

/**
 * Editable numeric input for per-area Quantities. Shows the auto-
 * computed value as a hint when no override is set; user can type a
 * different value to override. Empty / cleared input falls back to
 * the auto value (state stored as undefined).
 */
function PerAreaInput({
  label,
  auto,
  value,
  unit,
  onChange,
}: {
  label: string
  auto: number
  value: number | undefined
  unit: string
  onChange: (next: number | undefined) => void
}) {
  const hasOverride = typeof value === 'number'
  const [draft, setDraft] = useState<string>(
    hasOverride ? String(value) : '',
  )
  // Re-sync draft when the prop value changes from outside (e.g. when
  // a different area's overrides come into focus or a reset happens).
  useEffect(() => {
    setDraft(hasOverride ? String(value) : '')
  }, [value, hasOverride])
  return (
    <label className="flex items-center justify-between gap-3">
      <span className="flex-shrink-0 text-ink-300">{label}</span>
      <div className="flex items-center gap-2 min-w-0">
        <input
          type="number"
          step="0.01"
          min={0}
          value={draft}
          placeholder={auto.toFixed(2)}
          onChange={(e) => {
            const v = e.target.value
            setDraft(v)
            if (v === '') {
              onChange(undefined)
              return
            }
            const n = parseFloat(v)
            if (Number.isFinite(n)) onChange(n)
          }}
          className="w-24 px-2 py-1 border border-ink-600 rounded text-sm bg-ink-900 text-ink-50 tabular-nums text-right focus:outline-none focus:border-beme-400"
        />
        <span className="text-ink-400 text-[11px] w-6 text-left flex-shrink-0">
          {unit}
        </span>
      </div>
    </label>
  )
}

/**
 * Compact integer input for the per-area block-code editor. Tighter
 * footprint than PerAreaInput (one row per code, sometimes 10+ of
 * them in a single area card). Shows the auto count in the placeholder
 * when no override is set; typing replaces it. Empty / cleared input
 * clears the override and falls back to the auto count.
 */
function PerAreaCountInput({
  auto,
  value,
  onChange,
}: {
  auto: number
  value: number | undefined
  onChange: (next: number | undefined) => void
}) {
  const hasOverride = typeof value === 'number'
  const [draft, setDraft] = useState<string>(
    hasOverride ? String(value) : '',
  )
  useEffect(() => {
    setDraft(hasOverride ? String(value) : '')
  }, [value, hasOverride])
  return (
    <input
      type="number"
      step="1"
      min={0}
      value={draft}
      placeholder={String(auto)}
      onChange={(e) => {
        const v = e.target.value
        setDraft(v)
        if (v === '') {
          onChange(undefined)
          return
        }
        const n = parseInt(v, 10)
        if (Number.isFinite(n)) onChange(Math.max(0, n))
      }}
      title={`Auto-tallied count: ${auto}`}
      className="w-16 px-1.5 py-0.5 border border-ink-600 rounded text-[11px] bg-ink-900 text-ink-50 tabular-nums text-right focus:outline-none focus:border-beme-400 flex-shrink-0"
    />
  )
}
