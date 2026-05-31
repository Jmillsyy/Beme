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
import { exportCombinedEstimate } from '../lib/combinedExport'
import type { PageInfo } from '../lib/blockExport'
import { useUserSettings } from '../lib/userSettings'
import { useOrganisations } from '../lib/organisations'

interface CombinedExportCardProps {
  projectDetails: ProjectDetails
  referenceNumber?: number | null
  supplyItemSelections?: Record<string, boolean>
  supplyItemRateOverrides?: Record<string, number>
  pdfFile?: File | null

  /** Raw walls across both trades (NOT pre-filtered by active view). */
  allWalls: Wall[]
  /** Raw openings across both trades. */
  allOpenings: Opening[]
  /** Block piers (brick mode doesn't draw piers). */
  allPiers?: Pier[]

  blockMakeups: WallMakeup[]
  pierMakeups?: PierMakeup[]
  blockInclusions: BlockExportInclusions

  brickMakeups: BrickMakeup[]
  brickSettings: BrickSettings
  brickInclusions: BrickExportInclusions

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
 * Right-rail card for projects that carry walls of BOTH trades. Renders
 * a single "Open combined preview" button that builds a PDF with the
 * block schedule + brick schedule back-to-back, separated by a divider
 * sheet, with one shared disclaimer at the end.
 *
 * Walls / openings are partitioned by trade inside this component so the
 * caller can pass the raw unfiltered lists straight from project state —
 * no need to maintain parallel filtered arrays in the workspace just for
 * this card. PagesInfo gets the same partitioning treatment, producing
 * trade-specific pagesInfo arrays so each trade's Wall Layout page only
 * shows its own walls.
 *
 * The card is collapsed by default to stay quiet — combined export is
 * a less common path than per-trade export.
 */
export default function CombinedExportCard({
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
  blockInclusions,
  brickMakeups,
  brickSettings,
  brickInclusions,
  rawPagesInfo,
}: CombinedExportCardProps) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Same business-info construction as the per-trade export panels:
  // org name + logo win over the user's personal Settings → Business
  // values when the user is signed into an org. Other contact fields
  // (ABN, phone, address) come from personal settings on the assumption
  // that the user is the sales rep / estimator using their own details.
  const { settings: userSettings } = useUserSettings()
  const { currentOrg } = useOrganisations()

  // Partition walls + openings by trade. Walls without an explicit trade
  // are treated as block (mirrors the migration default applied on load),
  // which means legacy single-trade projects continue to render their
  // single trade and the "Combined" button just doesn't show.
  const { blockWalls, brickWalls } = useMemo(() => {
    const block: Wall[] = []
    const brick: Wall[] = []
    for (const w of allWalls) {
      if ((w.trade ?? 'block') === 'brick') brick.push(w)
      else block.push(w)
    }
    return { blockWalls: block, brickWalls: brick }
  }, [allWalls])

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

  // Per-trade pagesInfo so each trade's Wall Layout section only shows
  // its own walls + openings. A page that has both trades on it appears
  // in both arrays, each with only that trade's content.
  const { blockPagesInfo, brickPagesInfo } = useMemo(() => {
    const blockBy: PageInfo[] = []
    const brickBy: PageInfo[] = []
    for (const p of rawPagesInfo) {
      const pBlockWalls = p.walls.filter((w) => (w.trade ?? 'block') === 'block')
      const pBrickWalls = p.walls.filter((w) => (w.trade ?? 'block') === 'brick')
      const pBlockIds = new Set(pBlockWalls.map((w) => w.id))
      const pBrickIds = new Set(pBrickWalls.map((w) => w.id))
      const pBlockOpenings = p.openings.filter((o) => pBlockIds.has(o.wallId))
      const pBrickOpenings = p.openings.filter((o) => pBrickIds.has(o.wallId))
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
  }, [rawPagesInfo])

  const hasBothTrades = blockWalls.length > 0 && brickWalls.length > 0
  if (!hasBothTrades) return null

  async function handleExport() {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await exportCombinedEstimate({
        projectDetails,
        referenceNumber: referenceNumber ?? undefined,
        supplyItemSelections,
        supplyItemRateOverrides,
        business: {
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
        },
        pdfFile: pdfFile ?? undefined,
        blockInclusions,
        blockWalls,
        blockMakeups,
        blockOpenings,
        blockPiers: allPiers,
        pierMakeups,
        blockPagesInfo,
        brickInclusions,
        brickWalls,
        brickMakeups,
        brickOpenings,
        brickSettings,
        brickPagesInfo,
      })
    } catch (err) {
      console.error('Combined export failed', err)
      setError((err as Error)?.message ?? String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="my-4 border border-ink-600 rounded-xl bg-ink-800 p-3">
      <div className="flex items-baseline justify-between mb-2 gap-2">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-ink-200">
            Combined block + brick
          </h3>
          <p className="text-[11px] text-ink-400 mt-0.5 leading-snug">
            One PDF: block schedule → brickwork section → shared
            disclaimer. Each trade keeps its own inclusions configured
            in the panels below.
          </p>
        </div>
      </div>
      <button
        onClick={handleExport}
        disabled={busy}
        className="w-full px-3 py-1.5 rounded-lg bg-beme-500 text-black text-sm font-medium hover:bg-beme-400 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        {busy ? 'Opening preview…' : 'Open combined preview →'}
      </button>
      {error && (
        <p className="text-xs text-rose-300 mt-2 leading-snug">
          {error}
        </p>
      )}
    </div>
  )
}
