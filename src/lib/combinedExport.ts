/**
 * Combined block + brick export — for projects where both trades carry
 * walls. The output PDF reads as two stapled documents back-to-back:
 *
 *   1. Block section (assumptions / wall specs / layout / breakdown /
 *      grand total / accessories)
 *   2. Divider sheet ("Brickwork follows")
 *   3. Brick section (assumptions / wall layout / area summary / type
 *      breakdown / accessories)
 *   4. One shared Disclaimer page at the very end
 *
 * Implementation is a thin orchestrator over `buildBlockEstimateHtml`
 * and `buildBrickEstimateHtml`. Each builder is called with its trade's
 * own inclusions but with `disclaimer: false` so we can emit a single
 * shared disclaimer at the end of the combined doc. The `bodyContent`
 * + `styles` returned by each builder are stitched together into one
 * <html> document and handed to `downloadPdfFromHtml`.
 */

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
import {
  buildBlockEstimateHtml,
  type BusinessExportInfo,
  type PageInfo,
} from './blockExport'
import { buildBrickEstimateHtml } from './brickExport'
import { downloadPdfFromHtml } from './pdfExport'
import type { ProjectArea } from './projectStorage'

export interface CombinedExportParams {
  projectDetails: ProjectDetails
  referenceNumber?: number
  /** Per-project supply-item include/exclude map. Shared across trades. */
  supplyItemSelections?: Record<string, boolean>
  supplyItemRateOverrides?: Record<string, number>
  /**
   * Per-supply-item quantity ADJUSTMENTS shared across both trades —
   * forwarded unchanged to both single-trade builders so the same
   * supply item appearing in both sections (e.g. ties) honours the
   * user's modal adjustment consistently.
   */
  supplyItemAdjustments?: Record<string, number>
  business?: BusinessExportInfo
  pdfFile?: File

  // Block side — pre-filtered to block walls / makeups
  blockInclusions: BlockExportInclusions
  blockWalls: Wall[]
  blockMakeups: WallMakeup[]
  blockOpenings: Opening[]
  blockPiers?: Pier[]
  pierMakeups?: PierMakeup[]
  /** Pages with block walls (or with both, with brick walls filtered out by caller). */
  blockPagesInfo?: PageInfo[]
  /** Per-block quantity adjustments — see ExportParams in blockExport.ts. */
  blockAdjustments?: Record<string, number>

  // Brick side — pre-filtered to brick walls / makeups
  brickInclusions: BrickExportInclusions
  brickWalls: Wall[]
  brickMakeups: BrickMakeup[]
  brickOpenings: Opening[]
  brickSettings: BrickSettings
  /** Pages with brick walls (or with both, with block walls filtered out by caller). */
  brickPagesInfo?: PageInfo[]
  /** Per-brick-type quantity adjustments — see brickExport ExportParams. */
  brickAdjustments?: Record<string, number>

  /**
   * Project areas (e.g. First Floor / Second Floor). Forwarded to both
   * trade builders so the per-wall-type tables can group rows by area.
   */
  areas?: ProjectArea[]

  /**
   * Optional 3D viewport snapshots shared across BOTH trade sections.
   * Embedded as "3D View" pages after each side's plan overview
   * (block section first, brick section second). Same shape as the
   * single-trade exports.
   */
  view3dSnapshots?: Array<{
    dataUrl: string
    legend: Array<{ code: string; label: string; color: string }>
  }>
}

/**
 * Disclaimer copy lifted from the single-trade exporters. Kept in sync
 * with the same text in blockExport.ts / brickExport.ts so the combined
 * document doesn't drift from the single-trade ones.
 */
const DISCLAIMER_TEXT = [
  'This material schedule has been prepared as an estimate only, based on the drawings and information supplied by the client at the time of preparation. All quantities are indicative and should not be relied upon as a definitive or guaranteed measure of materials required for construction.',
  'Actual quantities required on site may differ from those shown in this schedule due to variations in construction methodology, site conditions, design changes, cutting waste, breakage, over-ordering requirements, or discrepancies between the drawings and constructed works. The preparer accepts no liability for any loss, cost, or claim arising from reliance on these estimated quantities.',
  'This schedule should be reviewed and verified by a suitably qualified quantity surveyor or estimator prior to procurement. Any amendments to the design or scope of works should be communicated to the preparer so that quantities can be revised accordingly.',
]

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

export async function exportCombinedEstimate(
  params: CombinedExportParams
): Promise<void> {
  const {
    projectDetails,
    referenceNumber,
    supplyItemSelections,
    supplyItemRateOverrides,
    supplyItemAdjustments,
    business,
    pdfFile,
    blockInclusions,
    blockWalls,
    blockMakeups,
    blockOpenings,
    blockPiers,
    pierMakeups,
    blockPagesInfo,
    blockAdjustments,
    brickInclusions,
    brickWalls,
    brickMakeups,
    brickOpenings,
    brickSettings,
    brickPagesInfo,
    brickAdjustments,
    areas,
    view3dSnapshots,
  } = params

  // Strip both trades' disclaimers — we emit one shared disclaimer at
  // the very end of the combined document instead of one per trade.
  const blockInclusionsNoDisclaimer: BlockExportInclusions = {
    ...blockInclusions,
    disclaimer: false,
  }
  const brickInclusionsNoDisclaimer: BrickExportInclusions = {
    ...brickInclusions,
    disclaimer: false,
  }

  const blockBuilt = await buildBlockEstimateHtml({
    projectDetails,
    inclusions: blockInclusionsNoDisclaimer,
    referenceNumber,
    supplyItemSelections,
    supplyItemRateOverrides,
    supplyItemAdjustments,
    walls: blockWalls,
    makeups: blockMakeups,
    openings: blockOpenings,
    piers: blockPiers,
    pierMakeups,
    business,
    pdfFile,
    pagesInfo: blockPagesInfo,
    blockAdjustments,
    view3dSnapshots,
  })

  const brickBuilt = await buildBrickEstimateHtml({
    projectDetails,
    inclusions: brickInclusionsNoDisclaimer,
    referenceNumber,
    supplyItemSelections,
    supplyItemRateOverrides,
    supplyItemAdjustments,
    walls: brickWalls,
    openings: brickOpenings,
    settings: brickSettings,
    makeups: brickMakeups,
    areas,
    business,
    pdfFile,
    pagesInfo: brickPagesInfo,
    brickAdjustments,
    view3dSnapshots,
  })

  // Divider sheet between the two trade sections — a single page with a
  // large heading so the reader can clearly tell when the block content
  // ends and brick content starts. The page-break-after on .page means
  // it gets its own physical sheet.
  const dividerPage = `
    <section class="page divider-page">
      <div class="divider-content">
        <div class="divider-eyebrow">Brickwork section</div>
        <h1 class="divider-title">Brickwork follows</h1>
        <p class="divider-sub">
          The pages above cover the blockwork portion of this estimate.
          The pages below cover the brickwork portion. Both sections
          share the same project header and reference number.
        </p>
      </div>
      <footer class="beme-credit">
        <span class="beme-mark"></span>
        <span>Built with <strong>Beme</strong> · building estimates made easy</span>
      </footer>
    </section>
  `

  // Shared final disclaimer — single page closing the combined document.
  const disclaimerPage = `
    <section class="page">
      <div class="disclaimer">
        <div class="disclaimer-title">Disclaimer</div>
        ${DISCLAIMER_TEXT.map((p) => `<p>${escapeHtml(p)}</p>`).join('')}
      </div>
      <footer class="beme-credit">
        <span class="beme-mark"></span>
        <span>Built with <strong>Beme</strong> · building estimates made easy</span>
      </footer>
    </section>
  `

  // Filename — prefer site address (estimators file PDFs by site)
  // with a hint so combined exports are distinguishable from
  // single-trade ones in the downloads folder.
  const baseName =
    projectDetails.siteAddress.trim() ||
    projectDetails.projectName.trim() ||
    'Combined Takeoff'
  const filename = `${baseName} — Combined Block + Brick Takeoff`

  // Stitch the document. Both trades' styles are concatenated; the later
  // styles override the earlier on any conflicting selector, but the
  // chrome is identical between the two so visually it doesn't matter
  // which wins. A small divider-page rule is appended so the in-between
  // sheet reads as intended.
  const dividerStyles = `
    .divider-page {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      text-align: center;
      page-break-after: always;
    }
    .divider-page .divider-content {
      max-width: 540px;
      padding: 40px;
    }
    .divider-page .divider-eyebrow {
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.12em;
      color: #6b7280;
      margin-bottom: 10px;
    }
    .divider-page .divider-title {
      font-size: 26px;
      font-weight: 700;
      color: #1f2937;
      margin: 0 0 12px 0;
    }
    .divider-page .divider-sub {
      font-size: 11px;
      line-height: 1.45;
      color: #4b5563;
    }
  `

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${escapeHtml(filename)}</title>
<style>
${blockBuilt.styles}
${brickBuilt.styles}
${dividerStyles}
</style>
</head>
<body>
${blockBuilt.bodyContent}
${dividerPage}
${brickBuilt.bodyContent}
${disclaimerPage}
</body>
</html>`

  await downloadPdfFromHtml({ html, filename })
}
