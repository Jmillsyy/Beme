/**
 * Block estimate export — generates a printable HTML document in a new browser tab.
 * User then prints to PDF via the browser's built-in Print → Save as PDF.
 *
 * The block export mirrors brick export but is shaped around what block estimates need:
 *
 *   Page 1 — Assumptions
 *   Page 2 — Block Schedule (full code-by-code tally)
 *   Page 3 — Wall-type breakdown (block counts per makeup, with per-code grand totals)
 *   Page 4 — Openings + lintel blocks
 *   Page 5 — Disclaimer
 *
 * Each section is gated by an inclusion flag — users tick what they want in the
 * BlockExportPanel.
 */

import type { BlockCode } from '../types/blocks'
import { BLOCK_LIBRARY } from '../data/blockLibrary'
import type {
  BlockExportInclusions,
  BlockTally,
  Opening,
  Pier,
  PierMakeup,
  ProjectDetails,
  Wall,
  WallMakeup,
} from '../types/walls'
import {
  calculateProjectTally,
  calculateWallTally,
  wallLengthMm,
} from './blockCalc'
import { selectBlockLintel } from './lintels'
import { downloadPdfFromHtml } from './pdfExport'

interface ExportParams {
  projectDetails: ProjectDetails
  inclusions: BlockExportInclusions
  walls: Wall[]
  makeups: WallMakeup[]
  openings: Opening[]
  piers?: Pier[]
  pierMakeups?: PierMakeup[]
  /**
   * Optional business identity (from user settings). When provided, the
   * exported document header shows the user's company instead of the generic
   * "Beme" wordmark — turning the export into a branded quote.
   */
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

// ---------- Helpers ----------

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

function blockName(code: BlockCode): string {
  return BLOCK_LIBRARY[code]?.name ?? code
}

/** Sorted [code, count] entries from a tally, dropping zero entries. */
function tallyEntries(tally: BlockTally): Array<[BlockCode, number]> {
  return (Object.entries(tally) as Array<[BlockCode, number]>)
    .filter(([, c]) => c > 0)
    .sort(([, a], [, b]) => b - a)
}

function buildAssumptions(
  inclusions: BlockExportInclusions,
  hasOpenings: boolean,
  customNotes: string,
  pierCounts: { tied: number; freestanding: number } = { tied: 0, freestanding: 0 }
): string[] {
  if (!inclusions.assumptions) return []

  const items: string[] = [
    'All block dimensions are nominal and include a 10mm mortar joint (200mm modular face, 200mm modular course height).',
    'Wall heights are taken from the wall-type definitions used in this project unless overridden per wall.',
    'Wall lengths are measured from the dimensions shown on the drawings supplied by the client. All dimensions are in millimetres unless otherwise noted.',
    'Corners between walls are deduplicated so the shared corner column is only counted once.',
    'T-junctions are treated as two completely separate walls. The stem wall has its own complete end termination at the junction (same as a free end — alternating 20.01 / 20.03 in stretcher bond) and stops at the through wall’s face; the through wall is unaffected.',
    'Height-makeup courses (20.71 and 20.140) extend across the full course length. The height-makeup block is cut to the size of any end block (20.01 / 20.03) and any fraction block on that course, so we supply enough 20.71 / 20.140 to cover the entire row; no separate end or fraction blocks are counted for those courses.',
    'Walls shorter than 800mm are built without body blocks. Both ends use the makeup’s full end block (20.01 / 20.21) on every course — no alternating in stretcher bond — and the gap between is filled from 20.03, 20.02, and 20.22 (up to two fill blocks) chosen to minimise overshoot. If the bare two end blocks already exceed the wall length, no fill is added.',
    'Wall stubs shorter than 400mm can’t fit two end blocks, so they’re built as one block per course — the block whose face width is closest to the drawn wall length, picked from 20.03 (190mm), 20.02 (290mm), 20.22 (340mm), or 20.01 (390mm).',
    'Curved walls use 20.03CW (wedge-shaped half block, 190mm front × 140mm rear) up to ~7500mm centreline radius — the geometric point at which a standard 390mm body block stops fitting around the curve without rear overlap. Above ~7500mm we revert to the makeup’s standard body block with slightly compressed rear mortar joints. Below ~665mm centreline radius the 20.03CW itself can no longer absorb the curve and custom-cut blocks would be required.',
  ]

  if (hasOpenings) {
    items.push('Openings (doors, windows) have been deducted from the gross block count.')
    items.push(
      'Lintels are stood-up lintel blocks chosen by head height: 20.13 for heads under 200mm, 20.25 for 200–299mm, 20.18 for 300mm and above.'
    )
  }

  if (pierCounts.tied > 0) {
    items.push(
      'Tied piers (built into the wall) use a per-makeup block-by-block course pattern that repeats up the wall height. The default tied makeup alternates 40.925 and 20.01 by course. A tied pier only displaces a wall body block (H block) on courses where its block is deeper than the wall — e.g. the 40.925 sticks out past the wall face — so the 40.925 courses displace H blocks, but the 20.01 courses sit perpendicular and add without subtracting.'
    )
  }
  if (pierCounts.freestanding > 0) {
    items.push(
      'Freestanding piers are standalone columns using a per-makeup block-by-block course pattern repeated up the pier’s height. The default freestanding makeup is 40.925 stacked every course.'
    )
  }

  items.push('No waste allowance has been applied. Quantities are net as measured.')

  // Custom notes from the user — split on newlines, ignore blank lines
  const customLines = customNotes
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
  items.push(...customLines)

  return items
}

// ---------- Main entry point ----------

export async function exportBlockEstimate(params: ExportParams): Promise<void> {
  const {
    projectDetails,
    inclusions,
    walls,
    makeups,
    openings,
    piers = [],
    pierMakeups = [],
    business,
  } = params

  const makeupsById = Object.fromEntries(makeups.map((m) => [m.id, m]))
  const pierMakeupsById = Object.fromEntries(pierMakeups.map((m) => [m.id, m]))
  const tally: BlockTally = calculateProjectTally(
    walls,
    makeupsById,
    openings,
    piers,
    pierMakeupsById
  )
  const entries = tallyEntries(tally)
  const totalBlocks = entries.reduce((sum, [, c]) => sum + c, 0)

  // Per-wall thickness + lookup so wallLengthMm returns outer-edge length consistently
  // (only the wall whose endpoint sits INSIDE the other wall gets the extension).
  const thicknessByWallId: Record<string, number> = {}
  const wallsById: Record<string, Wall> = {}
  for (const w of walls) {
    const makeup = makeupsById[w.makeupId]
    const block = makeup ? BLOCK_LIBRARY[makeup.bodyBlockCode] : undefined
    thicknessByWallId[w.id] = block?.dimensions.depthMm ?? 190
    wallsById[w.id] = w
  }

  // Per-makeup breakdown: re-run calculateWallTally for walls of each makeup
  // (without corner dedup so the table is interpretable). Corner dedup only matters
  // at the project total, which we already have above.
  const perMakeup = makeups.map((m) => {
    const wallsOfMakeup = walls.filter((w) => w.makeupId === m.id)
    const merged: BlockTally = {}
    for (const w of wallsOfMakeup) {
      const openingsForWall = openings.filter((o) => o.wallId === w.id)
      const wallTally = calculateWallTally(w, m, openingsForWall, thicknessByWallId, wallsById)
      for (const [code, count] of Object.entries(wallTally) as Array<[BlockCode, number]>) {
        if (!count) continue
        merged[code] = (merged[code] ?? 0) + count
      }
    }
    return {
      makeup: m,
      wallCount: wallsOfMakeup.length,
      lengthMm: wallsOfMakeup.reduce(
        (s, w) => s + wallLengthMm(w, thicknessByWallId, wallsById),
        0
      ),
      tally: merged,
    }
  })

  // Openings detail: index, wall, dimensions, head, lintel
  const openingsDetail = openings.map((o, i) => {
    const wall = walls.find((w) => w.id === o.wallId)
    const makeup = wall ? makeupsById[wall.makeupId] : undefined
    const wallHeightMm = wall?.heightMmOverride ?? makeup?.heightMm ?? 0
    const headMm = wallHeightMm - o.sillHeightMm - o.heightMm
    const lintel = headMm > 0 ? selectBlockLintel(headMm) : null
    return {
      index: i + 1,
      wallNumber: wall ? walls.indexOf(wall) + 1 : null,
      makeupName: makeup?.name ?? '—',
      widthMm: o.widthMm,
      heightMm: o.heightMm,
      sillMm: o.sillHeightMm,
      headMm,
      lintelCode: lintel?.code ?? null,
    }
  })

  const headerTitle =
    projectDetails.siteAddress.trim() ||
    projectDetails.projectName.trim() ||
    'Block Takeoff'
  const docTitle =
    `${projectDetails.projectName.trim() || projectDetails.siteAddress.trim() || 'Block Takeoff'} — Block Takeoff`

  const tiedPierCount = piers.filter((p) => p.type === 'tied').length
  const freestandingPierCount = piers.filter((p) => p.type === 'freestanding').length

  const assumptions = buildAssumptions(
    inclusions,
    openings.length > 0,
    projectDetails.notes,
    { tied: tiedPierCount, freestanding: freestandingPierCount }
  )

  // ---------- HTML pieces ----------

  // Branded header — when the user has filled out their business identity in
  // settings, the company name + ABN + address replace the generic "Beme"
  // wordmark, turning the export into a real quote.
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
        <div class="title-main">Block Takeoff — Material Schedule</div>
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
    if (projectDetails.date)
      rows.push(`<div><span>Date</span> ${formatDate(projectDetails.date)}</div>`)
    if (rows.length === 0) return ''
    return `<div class="meta">${rows.join('')}</div>`
  })()

  // Page 1: Assumptions
  const assumptionsPage = inclusions.assumptions
    ? `
      <section class="page">
        ${pageHeader}
        ${metaBlock}
        <h2>Assumptions</h2>
        <ol class="assumptions">
          ${assumptions.map((a) => `<li>${escapeHtml(a)}</li>`).join('')}
        </ol>
      </section>
    `
    : ''

  // Page 2: Block Schedule (full code-by-code tally)
  const scheduleTable = inclusions.blockSchedule && entries.length > 0
    ? `
      <h2>Block Schedule</h2>
      <table>
        <thead>
          <tr>
            <th style="width: 100px">Code</th>
            <th>Block</th>
            <th class="right" style="width: 100px">Quantity</th>
          </tr>
        </thead>
        <tbody>
          ${entries
            .map(
              ([code, count]) =>
                `<tr><td class="mono">${escapeHtml(code)}</td><td>${escapeHtml(blockName(code))}</td><td class="right">${formatNumber(count)}</td></tr>`
            )
            .join('')}
          <tr class="bold">
            <td colspan="2">Total blocks</td>
            <td class="right">${formatNumber(totalBlocks)}</td>
          </tr>
        </tbody>
      </table>
    `
    : ''

  const schedulePage = scheduleTable
    ? `
      <section class="page">
        ${pageHeader}
        ${scheduleTable}
      </section>
    `
    : ''

  // Page 3: Wall-type breakdown
  const breakdownTables = inclusions.wallTypeBreakdown && perMakeup.some((p) => p.wallCount > 0)
    ? perMakeup
        .filter((p) => p.wallCount > 0)
        .map((p) => {
          const subEntries = tallyEntries(p.tally)
          const subTotal = subEntries.reduce((s, [, c]) => s + c, 0)
          return `
            <h3 class="wall-type-name">
              ${escapeHtml(p.makeup.name)}
              <span class="wall-type-meta">
                · ${p.wallCount} wall${p.wallCount === 1 ? '' : 's'}
                · ${formatNumber(p.lengthMm / 1000, 2)} m
                · ${p.makeup.heightMm}mm high
              </span>
            </h3>
            <table>
              <thead>
                <tr>
                  <th style="width: 100px">Code</th>
                  <th>Block</th>
                  <th class="right" style="width: 100px">Quantity</th>
                </tr>
              </thead>
              <tbody>
                ${subEntries
                  .map(
                    ([code, count]) =>
                      `<tr><td class="mono">${escapeHtml(code)}</td><td>${escapeHtml(blockName(code))}</td><td class="right">${formatNumber(count)}</td></tr>`
                  )
                  .join('')}
                <tr class="bold">
                  <td colspan="2">Subtotal</td>
                  <td class="right">${formatNumber(subTotal)}</td>
                </tr>
              </tbody>
            </table>
          `
        })
        .join('')
    : ''

  // Combined totals per block code across all makeups — pre-corner-dedup, so these are the
  // sums you'd get from adding up every sub-table above. The Block Schedule on its own page
  // shows the dedup'd numbers; the diff = corner blocks shared between adjacent walls.
  const combinedPerCode: BlockTally = {}
  for (const p of perMakeup) {
    for (const [code, count] of Object.entries(p.tally) as Array<[BlockCode, number]>) {
      if (!count) continue
      combinedPerCode[code] = (combinedPerCode[code] ?? 0) + count
    }
  }
  const combinedEntries = tallyEntries(combinedPerCode)
  const breakdownGrandTotal = combinedEntries.reduce((s, [, c]) => s + c, 0)

  const breakdownPage = breakdownTables
    ? `
      <section class="page">
        ${pageHeader}
        <h2>Breakdown by Wall Type</h2>
        <p class="page-intro">Block counts per wall makeup (pre-deduplication of shared corners).</p>
        ${breakdownTables}
        <h3 class="wall-type-name">Grand total per block type</h3>
        <table>
          <thead>
            <tr>
              <th style="width: 100px">Code</th>
              <th>Block</th>
              <th class="right" style="width: 100px">Quantity</th>
            </tr>
          </thead>
          <tbody>
            ${combinedEntries
              .map(
                ([code, count]) =>
                  `<tr><td class="mono">${escapeHtml(code)}</td><td>${escapeHtml(blockName(code))}</td><td class="right tabular">${formatNumber(count)}</td></tr>`
              )
              .join('')}
            <tr class="bold">
              <td colspan="2">Total</td>
              <td class="right tabular">${formatNumber(breakdownGrandTotal)}</td>
            </tr>
          </tbody>
        </table>
      </section>
    `
    : ''

  // Page 4: Openings + lintels
  const openingsTable = inclusions.openingsList && openings.length > 0
    ? `
      <h2>Openings &amp; Lintels</h2>
      <p class="page-intro">
        ${openings.length} opening${openings.length === 1 ? '' : 's'}
        · Lintels selected by head height (see Assumptions)
      </p>
      <table>
        <thead>
          <tr>
            <th style="width: 40px">#</th>
            <th>Wall type</th>
            <th class="right" style="width: 90px">Width (mm)</th>
            <th class="right" style="width: 90px">Height (mm)</th>
            <th class="right" style="width: 70px">Sill (mm)</th>
            <th class="right" style="width: 70px">Head (mm)</th>
            <th style="width: 70px">Lintel</th>
          </tr>
        </thead>
        <tbody>
          ${openingsDetail
            .map(
              (o) =>
                `<tr>
                  <td>${o.index}</td>
                  <td>${escapeHtml(o.makeupName)}</td>
                  <td class="right tabular">${formatNumber(o.widthMm)}</td>
                  <td class="right tabular">${formatNumber(o.heightMm)}</td>
                  <td class="right tabular">${formatNumber(o.sillMm)}</td>
                  <td class="right tabular">${formatNumber(o.headMm)}</td>
                  <td class="mono">${o.lintelCode ?? '—'}</td>
                </tr>`
            )
            .join('')}
          ${(() => {
            const totalWidth = openings.reduce((s, o) => s + o.widthMm, 0)
            const totalAreaSqM =
              openings.reduce((s, o) => s + o.widthMm * o.heightMm, 0) / 1_000_000
            return `<tr class="bold">
              <td colspan="2">Total — ${openings.length} opening${openings.length === 1 ? '' : 's'} (${formatNumber(totalAreaSqM, 2)} m²)</td>
              <td class="right tabular">${formatNumber(totalWidth)}</td>
              <td class="right tabular">—</td>
              <td class="right tabular">—</td>
              <td class="right tabular">—</td>
              <td class="mono">—</td>
            </tr>`
          })()}
        </tbody>
      </table>
    `
    : ''

  const openingsPage = openingsTable
    ? `
      <section class="page">
        ${pageHeader}
        ${openingsTable}
      </section>
    `
    : ''

  // Page 5: Disclaimer
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

  /* "Built with Beme" credit footer that appears on every page. */
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
    margin: 24px 0 8px;
    color: #1f2937;
  }
  h3.wall-type-name {
    font-size: 13px;
    margin: 20px 0 6px;
    color: #1f2937;
    font-weight: 700;
  }
  .wall-type-meta {
    color: #6b7280;
    font-weight: 400;
    font-size: 11px;
  }
  .page-intro {
    font-size: 12px;
    color: #6b7280;
    margin: 0 0 12px;
  }

  ol.assumptions { padding-left: 24px; margin: 0; }
  ol.assumptions li {
    padding: 6px 0;
    font-size: 13px;
    line-height: 1.5;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    margin-bottom: 16px;
    font-size: 13px;
  }
  th, td {
    padding: 8px 12px;
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
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  .tabular { font-variant-numeric: tabular-nums; }
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
    .page { padding: 1.5cm; min-height: auto; }
    @page { margin: 0; size: A4; }
  }
</style>
</head>
<body>
  ${assumptionsPage}
  ${schedulePage}
  ${breakdownPage}
  ${openingsPage}
  ${disclaimerPage}
</body>
</html>`

  // Inject the "Built with Beme" credit before each page's closing tag.
  // Doing it post-hoc keeps the per-page building blocks simple while
  // ensuring every page (assumptions / schedule / breakdown / openings /
  // disclaimer) carries the footer.
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

export function createDefaultBlockExportInclusions(): BlockExportInclusions {
  return {
    assumptions: true,
    blockSchedule: true,
    wallTypeBreakdown: true,
    openingsList: true,
    disclaimer: true,
  }
}
