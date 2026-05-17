/**
 * Brick estimate export — generates a printable HTML document in a new browser tab.
 * User then prints to PDF via the browser's built-in Print → Save as PDF.
 *
 * The layout matches a typical brickwork takeoff document:
 *   Page 1 — Assumptions (auto-generated from settings + custom notes)
 *   Page 2 — Brick Area Summary + Lintels + Accessories tables
 *   Page 3 — Disclaimer
 */

import type {
  BrickExportInclusions,
  BrickSettings,
  Opening,
  ProjectDetails,
  Wall,
} from '../types/walls'
import { calculateBrickTally } from './brickCalc'
import { downloadPdfFromHtml } from './pdfExport'

interface ExportParams {
  projectDetails: ProjectDetails
  inclusions: BrickExportInclusions
  walls: Wall[]
  openings: Opening[]
  settings: BrickSettings
  /** Optional business identity (from user settings). Same shape as block export. */
  business?: BusinessExportInfo
}

export interface BusinessExportInfo {
  companyName?: string
  abn?: string
  phone?: string
  website?: string
  addressLine1?: string
  addressLine2?: string
  suburb?: string
  state?: string
  postcode?: string
  logoUrl?: string
}

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

function formatNumber(n: number, digits = 0): string {
  return n.toLocaleString('en-AU', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })
}

function formatDate(iso: string): string {
  if (!iso) return ''
  try {
    const d = new Date(iso)
    return d.toLocaleDateString('en-AU', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    })
  } catch {
    return iso
  }
}

function buildAssumptions(
  inclusions: BrickExportInclusions,
  settings: BrickSettings,
  totalLinealMm: number,
  plascourseCount: number,
  customNotes: string
): string[] {
  if (!inclusions.assumptions) return []

  const items: string[] = [
    'All brick dimensions are nominal and include mortar joint.',
    `Wall heights are uniform at ${formatNumber(settings.defaultWallHeightMm)}mm for all walls unless otherwise noted.`,
    'Wall lengths are taken from the dimensions shown on the drawings supplied by the client. All dimensions are in millimetres unless otherwise noted.',
    'Openings (doors and windows) have been deducted from gross wall areas as indicated on the drawings.',
    'No waste allowance has been applied. Quantities are net as measured.',
  ]

  if (settings.ties.enabled && inclusions.brickTies) {
    items.push(`Brick tie rate is ${settings.ties.perSquareMetre} ties per m² of net brickwork.`)
  }

  if (inclusions.lintels) {
    items.push(
      'Lintels are sized at opening width plus bearing each side: 100mm ≤ 800mm openings, 150mm for 800–4000mm openings, 200mm for openings over 4000mm.'
    )
  }

  if (settings.plascourse.enabled && inclusions.plascourse && plascourseCount > 0) {
    const totalLengthM = totalLinealMm / 1000
    items.push(
      `${plascourseCount} ${plascourseCount === 1 ? 'Roll' : 'Rolls'} of Plascourse allowed for ${formatNumber(totalLengthM, 1)} Lineal Metres of Brickwork.`
    )
  }

  // Custom notes from the user — split on newlines, ignore blank lines
  const customLines = customNotes
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
  items.push(...customLines)

  return items
}

interface LintelGroup {
  lengthMm: number
  profile: string
  count: number
}

function groupLintels(
  lintels: ReturnType<typeof calculateBrickTally>['lintels']
): { groups: LintelGroup[]; oversizedCount: number; total: number } {
  const map = new Map<string, LintelGroup>()
  let oversizedCount = 0
  let total = 0
  for (const entry of lintels) {
    if (!entry.selectedLintel) {
      oversizedCount++
      continue
    }
    total++
    const key = `${entry.selectedLintel.lengthMm}-${entry.selectedLintel.profile}`
    const existing = map.get(key)
    if (existing) existing.count++
    else
      map.set(key, {
        lengthMm: entry.selectedLintel.lengthMm,
        profile: entry.selectedLintel.profile,
        count: 1,
      })
  }
  const groups = Array.from(map.values()).sort((a, b) => a.lengthMm - b.lengthMm)
  return { groups, oversizedCount, total }
}

export async function exportBrickEstimate(params: ExportParams): Promise<void> {
  const { projectDetails, inclusions, walls, openings, settings, business } = params
  const tally = calculateBrickTally(walls, openings, settings)

  const headerTitle =
    projectDetails.siteAddress.trim() ||
    projectDetails.projectName.trim() ||
    'Brickwork Takeoff'
  const docTitle =
    `${projectDetails.projectName.trim() || projectDetails.siteAddress.trim() || 'Brickwork Takeoff'} — Brickwork Takeoff`

  const assumptions = buildAssumptions(
    inclusions,
    settings,
    tally.totalLinealMm,
    tally.plascourseCount,
    projectDetails.notes
  )

  const { groups: lintelGroups, oversizedCount, total: lintelTotal } = groupLintels(
    tally.lintels
  )

  // ---------- HTML pieces ----------

  // Branded header — uses the user's business identity when provided.
  const hasBusinessIdentity = !!business?.companyName?.trim()
  const brandBlock = hasBusinessIdentity
    ? `
        ${business?.logoUrl ? `<img src="${escapeHtml(business.logoUrl)}" alt="Logo" class="brand-logo" />` : ''}
        <div class="brand-name">${escapeHtml(business?.companyName ?? '')}</div>
        <div class="brand-tag">
          ${business?.abn ? `ABN ${escapeHtml(business.abn)}` : ''}
          ${business?.phone ? ` · ${escapeHtml(business.phone)}` : ''}
          ${business?.website ? ` · ${escapeHtml(business.website)}` : ''}
        </div>
        ${
          business?.addressLine1
            ? `<div class="brand-address">${[
                business.addressLine1,
                business.addressLine2,
                [business.suburb, business.state, business.postcode]
                  .filter(Boolean)
                  .join(' '),
              ]
                .filter(Boolean)
                .map((line) => escapeHtml(line ?? ''))
                .join('<br/>')}</div>`
            : ''
        }
      `
    : `
        <div class="brand-name">Beme</div>
        <div class="brand-tag">Building Estimates Made Easy</div>
      `

  const pageHeader = `
    <header class="page-header">
      <div class="brand">${brandBlock}</div>
      <div class="title-block">
        <div class="title-main">Brickwork Takeoff — Material Schedule</div>
        <div class="title-sub">${escapeHtml(headerTitle)} | All dimensions in mm</div>
      </div>
    </header>
  `

  const metaBlock = (() => {
    const rows: string[] = []
    if (projectDetails.clientName.trim())
      rows.push(`<div><span>Client</span> ${escapeHtml(projectDetails.clientName)}</div>`)
    if (projectDetails.estimatorName.trim())
      rows.push(
        `<div><span>Estimator</span> ${escapeHtml(projectDetails.estimatorName)}</div>`
      )
    if (projectDetails.date) rows.push(`<div><span>Date</span> ${formatDate(projectDetails.date)}</div>`)
    if (rows.length === 0) return ''
    return `<div class="meta">${rows.join('')}</div>`
  })()

  // Page 1: Assumptions
  const assumptionsPage = inclusions.assumptions
    ? `
      <section class="page">
        ${pageHeader}
        ${metaBlock}
        <h2 class="section-title">Assumptions</h2>
        <ol class="assumptions">
          ${assumptions.map((a) => `<li>${escapeHtml(a)}</li>`).join('')}
        </ol>
      </section>
    `
    : ''

  // Page 2: Tables
  const areaSqM = tally.totalAreaSqMm / 1_000_000
  const openingsAreaSqM = openings.reduce((sum, op) => sum + op.widthMm * op.heightMm, 0) / 1_000_000
  const grossAreaSqM = areaSqM + openingsAreaSqM

  const summaryTable = inclusions.brickAreaSummary
    ? `
      <h2 class="section-title">Brick Area Summary</h2>
      <table>
        <thead>
          <tr><th>Description</th><th class="right">Area (m²)</th></tr>
        </thead>
        <tbody>
          <tr><td>Gross Wall Area</td><td class="right">${formatNumber(grossAreaSqM, 3)} m²</td></tr>
          <tr><td>Less Openings</td><td class="right">-${formatNumber(openingsAreaSqM, 3)} m²</td></tr>
          <tr class="bold"><td>Net Wall Area</td><td class="right">${formatNumber(areaSqM, 3)} m²</td></tr>
        </tbody>
      </table>
    `
    : ''

  const lintelsTable = inclusions.lintels && (lintelGroups.length > 0 || oversizedCount > 0)
    ? `
      <h2 class="section-title">Lintels</h2>
      <table>
        <thead>
          <tr><th>Lintel Size</th><th class="right">Quantity</th></tr>
        </thead>
        <tbody>
          ${lintelGroups
            .map(
              (g) =>
                `<tr><td>${formatNumber(g.lengthMm)}mm ${escapeHtml(g.profile)}</td><td class="right">${g.count}</td></tr>`
            )
            .join('')}
          ${
            oversizedCount > 0
              ? `<tr><td>Custom (exceeds stock sizes)</td><td class="right">${oversizedCount}</td></tr>`
              : ''
          }
          <tr class="bold"><td>Total</td><td class="right">${lintelTotal + oversizedCount}</td></tr>
        </tbody>
      </table>
    `
    : ''

  const accessoriesRows: string[] = []
  if (inclusions.brickTies && settings.ties.enabled)
    accessoriesRows.push(
      `<tr><td>Brick Ties</td><td class="right">${tally.tiesCount.toLocaleString()}</td></tr>`
    )
  if (inclusions.plascourse && settings.plascourse.enabled && tally.plascourseCount > 0)
    accessoriesRows.push(
      `<tr><td>Plascourse</td><td class="right">${tally.plascourseCount} ${tally.plascourseCount === 1 ? 'roll' : 'rolls'}</td></tr>`
    )

  const accessoriesTable = accessoriesRows.length > 0
    ? `
      <h2 class="section-title">Accessories</h2>
      <table>
        <thead><tr><th>Item</th><th class="right">Quantity</th></tr></thead>
        <tbody>${accessoriesRows.join('')}</tbody>
      </table>
    `
    : ''

  const tablesPage = summaryTable || lintelsTable || accessoriesTable
    ? `
      <section class="page">
        ${pageHeader}
        ${summaryTable}
        ${lintelsTable}
        ${accessoriesTable}
      </section>
    `
    : ''

  // Page 3: Disclaimer
  const disclaimerPage = inclusions.disclaimer
    ? `
      <section class="page">
        ${pageHeader}
        <div class="disclaimer">
          <div class="disclaimer-title">Disclaimer</div>
          ${DISCLAIMER_TEXT.map((p) => `<p>${escapeHtml(p)}</p>`).join('')}
        </div>
      </section>
    `
    : ''

  // ---------- Assembled HTML ----------

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${escapeHtml(docTitle)}</title>
<style>
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
    color: #1f2937;
    margin: 0;
    background: #fff;
  }
  .page {
    padding: 40px 48px;
    page-break-after: always;
    min-height: 100vh;
  }
  .page:last-child { page-break-after: auto; }

  .page-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    border-bottom: 2px solid #1f2937;
    padding-bottom: 12px;
    margin-bottom: 24px;
  }
  .brand-name {
    color: #C5530A;
    font-weight: 700;
    font-size: 28px;
    line-height: 1;
  }
  .brand-tag {
    color: #ED7D31;
    font-style: italic;
    font-size: 11px;
    margin-top: 2px;
  }
  .brand-address {
    color: #4B5563;
    font-size: 11px;
    margin-top: 4px;
    line-height: 1.4;
  }
  .brand-logo {
    max-height: 56px;
    max-width: 180px;
    display: block;
    margin-bottom: 6px;
  }

  /* "Built with Beme" credit footer on every page. */
  .page { position: relative; padding-bottom: 50px; }
  .beme-credit {
    position: absolute;
    left: 1.5cm;
    right: 1.5cm;
    bottom: 1cm;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    font-size: 10px;
    color: #9CA3AF;
    border-top: 1px solid #E5E7EB;
    padding-top: 6px;
  }
  .beme-credit .beme-mark {
    display: inline-block;
    width: 10px;
    height: 10px;
    background: #FF7A2D;
    border-radius: 2px;
    position: relative;
  }
  .beme-credit .beme-mark::after {
    content: '';
    position: absolute;
    inset: 2px;
    background: #111111;
    border-radius: 1px;
  }
  .beme-credit strong {
    color: #1F2937;
    font-weight: 700;
  }
  .title-block { text-align: right; }
  .title-main {
    font-size: 18px;
    font-weight: 700;
  }
  .title-sub {
    font-size: 12px;
    color: #6b7280;
    margin-top: 2px;
  }

  .meta {
    display: flex;
    gap: 24px;
    font-size: 12px;
    color: #4b5563;
    margin-bottom: 20px;
  }
  .meta span {
    color: #9ca3af;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-size: 10px;
    margin-right: 4px;
  }

  h2 {
    font-size: 16px;
    margin: 24px 0 12px;
    color: #1f2937;
  }

  ol.assumptions {
    padding-left: 24px;
    margin: 0;
  }
  ol.assumptions li {
    padding: 6px 0;
    font-size: 13px;
    line-height: 1.5;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    margin-bottom: 20px;
    font-size: 13px;
  }
  th, td {
    padding: 9px 12px;
    border-bottom: 1px solid #e5e7eb;
    text-align: left;
  }
  thead th {
    background: #f3f4f6;
    font-weight: 600;
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    color: #4b5563;
  }
  .right { text-align: right; }
  tr.bold td { font-weight: 700; background: #fafafa; }

  .disclaimer {
    background: #fef9c3;
    border-left: 4px solid #ca8a04;
    padding: 16px 20px;
    border-radius: 4px;
  }
  .disclaimer-title {
    color: #854d0e;
    font-weight: 700;
    margin-bottom: 8px;
    font-size: 14px;
  }
  .disclaimer p {
    margin: 0 0 8px 0;
    font-size: 12px;
    line-height: 1.5;
    color: #422006;
  }
  .disclaimer p:last-child { margin-bottom: 0; }

  @media print {
    .page { padding: 0.4cm 1.5cm 1.5cm 1.5cm; min-height: auto; }
    /* Landscape A4 with a 1.1cm top margin reserved for the running
       header in @top-center. The .page padding-top is reduced to 0.4cm
       in print to compensate. */
    @page {
      margin: 1.1cm 0 0 0;
      size: A4 landscape;
      /* Running header — see blockExport.ts for the full explainer. */
      @top-center {
        content: string(sectionTitle);
        font-family: 'Inter', system-ui, -apple-system, sans-serif;
        font-size: 10pt;
        color: #6b7280;
        font-style: italic;
        padding-top: 4mm;
      }
      /* Blank the other margin boxes so the browser's built-in print
         chrome (date / URL / page title) is suppressed where supported. */
      @top-left { content: ""; }
      @top-right { content: ""; }
      @bottom-left { content: ""; }
      @bottom-center { content: ""; }
      @bottom-right { content: ""; }
    }
    h2.section-title {
      string-set: sectionTitle content();
    }

    /* Page-break hygiene — see blockExport.ts for the rationale. Keep
       table rows atomic, repeat thead/tfoot on continuation pages,
       glue subtotal/total rows to the rows above them so they don't
       orphan, and avoid splitting tables when they fit on a page. */
    thead { display: table-header-group; }
    tfoot { display: table-footer-group; }
    tr, .beme-credit { page-break-inside: avoid; break-inside: avoid; }
    .disclaimer, .meta, .section-group {
      page-break-inside: avoid;
      break-inside: avoid;
    }
    tr.bold {
      page-break-before: avoid;
      break-before: avoid-page;
    }
    table {
      page-break-inside: avoid;
      break-inside: avoid;
    }
    h2, h3 {
      page-break-after: avoid;
      break-after: avoid-page;
    }
  }
</style>
</head>
<body>
  ${assumptionsPage}
  ${tablesPage}
  ${disclaimerPage}
</body>
</html>`

  // "Built with Beme" credit on every page — injected before each section's
  // closing tag so all pages (assumptions / area / lintels / disclaimer)
  // carry the footer without touching the per-page builders.
  const bemeFooter = `
    <footer class="beme-credit">
      <span class="beme-mark"></span>
      <span>Built with <strong>Beme</strong> · building estimates made easy</span>
    </footer>`
  const htmlWithFooter = html.replace(/<\/section>/g, `${bemeFooter}</section>`)

  // Hand the styled HTML to the print-to-PDF helper, which opens the export in
  // a fresh tab and auto-triggers the browser's print dialog. The user picks
  // "Save as PDF" and the tab closes itself afterwards.
  await downloadPdfFromHtml({ html: htmlWithFooter, filename: docTitle })
}

export function createDefaultProjectDetails(): ProjectDetails {
  const today = new Date().toISOString().split('T')[0]
  return {
    projectName: '',
    siteAddress: '',
    clientName: '',
    estimatorName: '',
    date: today,
    notes: '',
  }
}

export function createDefaultExportInclusions(): BrickExportInclusions {
  return {
    assumptions: true,
    brickAreaSummary: true,
    lintels: true,
    brickTies: true,
    plascourse: true,
    disclaimer: true,
  }
}
