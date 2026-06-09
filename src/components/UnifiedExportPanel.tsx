import { useEffect, useMemo, useState } from 'react'
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
  // type editor, opening editor, etc.).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
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
    }
    return Math.max(0, Math.ceil(raw))
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
      const shared = {
        projectDetails,
        referenceNumber: referenceNumber ?? undefined,
        supplyItemSelections,
        supplyItemRateOverrides,
        supplyItemAdjustments,
        supplyItemNameOverrides,
        business: business(),
        pdfFile: pdfFile ?? undefined,
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

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Export estimate"
    >
      <div
        className="bg-ink-800 border border-ink-600 rounded-2xl shadow-2xl w-full max-w-4xl max-h-[92vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <header className="px-5 py-3 border-b border-ink-600 flex items-center justify-between bg-ink-900/40">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-ink-100">
              Export estimate
            </h2>
            <p className="text-[11px] text-ink-500 mt-0.5">
              {modeLabel} · sections, quantity adjustments and supply items
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-ink-400 hover:text-ink-100 text-2xl leading-none px-2"
            aria-label="Close"
          >
            ×
          </button>
        </header>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          {/*
           * Top stripe: Areas (when shown) + Sections side-by-side on
           * md+. These are short selection lists that don't benefit
           * from full width, so pairing them lets the longer tables
           * below get the whole modal. Falls back to stacked on narrow
           * screens. When the area picker is hidden (single-area
           * project), Sections takes the full width.
           */}
          <div
            className={
              showAreaPicker
                ? 'grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-5'
                : ''
            }
          >
          {/* Areas */}
          {showAreaPicker && (
            <section>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-300 mb-2">
                Areas
              </h3>
              <p className="text-[11px] text-ink-500 mb-2 leading-snug">
                Pick which areas to include. Each area's walls are added
                to the schedule independently.
              </p>
              <div className="flex flex-col gap-1 pl-1">
                {/* Master "All" toggle. Ticked when every individual
                    area row is selected; flips the whole group when
                    the user clicks it. Sits above the dividing line
                    so it reads as a controller for the rows below. */}
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

          {/* Sections */}
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-300 mb-2">
              Include in the PDF
            </h3>
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
                onChange={(v) => setSections((s) => ({ ...s, schedules: v }))}
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
          </div>

          {/* Quantity adjustments — Blocks only. Brick exports now
              produce lineal- and square-metre outputs, not per-brick
              counts, so a per-code brick adjustment table doesn't
              fit the export shape any more. If we add per-area or
              per-rate brick adjustments later they'll go here as a
              separate row. */}
          {(hasBlockTally ||
            Object.keys(blockAdjustments).length > 0) && (
            <section>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-300 mb-2">
                Quantity adjustments
              </h3>
              <p className="text-[11px] text-ink-500 mb-3 leading-snug">
                Each row shows the auto-tally quantity. Hit Edit to
                override it with a different number — useful when you
                want fewer (blocks on site, reused from another job)
                or more (extras for breakage, future work). Use the
                "+ Add" button to include a code that isn't on the
                plan at all. Tallies respect the area filter above —
                untick areas to remove their blocks from the count.
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

          {/* Supply items — same table UX as blocks/bricks but driven
              by the user's Material library. Each trade's rates × the
              trade's own metrics produce the auto-tally; the user can
              edit any row to override the final qty for THIS export
              only (no library mutation), or add a supply that the
              auto-tally currently shows as zero. The supply rates
              themselves are still owned by the Material library —
              this is purely a per-export quantity adjustment surface. */}
          {(hasBlockSupply || hasBrickSupply) && (
            <section>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-300 mb-2">
                Supply items
              </h3>
              <p className="text-[11px] text-ink-500 mb-3 leading-snug">
                Auto-calculated from your Material-library rates and the
                walls included above. Hit Edit to override a quantity
                for this export (e.g. fewer cement bags because some
                are already on site, or extra ties for breakage). The
                library rates themselves stay untouched.
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
        </div>

        {/* Footer */}
        <footer className="px-5 py-3 border-t border-ink-600 bg-ink-900/40 flex items-center justify-between gap-3">
          {error ? (
            <p className="text-[11px] text-rose-300 leading-snug flex-1 min-w-0">
              {error}
            </p>
          ) : (
            <p className="text-[11px] text-ink-500 leading-snug flex-1 min-w-0">
              {canExport
                ? 'Print to PDF from the preview that opens.'
                : 'Tick at least one area with walls to enable export.'}
            </p>
          )}
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded-lg border border-ink-600 text-ink-200 text-sm hover:bg-ink-700 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleExport}
            disabled={busy || !canExport}
            className="px-4 py-1.5 rounded-lg bg-beme-500 text-black text-sm font-medium hover:bg-beme-400 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {busy ? 'Opening preview…' : 'Export'}
          </button>
        </footer>
      </div>
    </div>
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
