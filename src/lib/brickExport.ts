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
  BrickMakeup,
  BrickSettings,
  Opening,
  ProjectDetails,
  Wall,
} from '../types/walls'
import { calculateBrickTally } from './brickCalc'
import { downloadPdfFromHtml } from './pdfExport'
import { rasterisePdfPage } from './pdfRaster'
import { getUserSettings } from './userSettings'
import { BRICK_LIBRARY } from '../data/brickLibrary'

/** Single-skin default — same value PdfWorkspace uses for wall thickness
 *  when no brick type is selected. Drives the layout-page wall stroke. */
const DEFAULT_BRICK_WALL_THICKNESS_MM = 110

/**
 * One entry per PDF page the user has walls drawn on. Same shape as the
 * block export's PageInfo so the workspace can pass the same data through
 * to either export. The export builds a separate Wall Layout overview
 * page from each entry. `label` overrides the auto-generated heading
 * suffix (e.g. "Ground Floor" instead of "Page 1").
 */
export interface PageInfo {
  pageNumber: number
  label?: string
  pageWidthMm?: number
  pageHeightMm?: number
  pageScaleRatio?: number
  walls: Wall[]
  openings: Opening[]
  /**
   * Ruler measurements drawn on this page. Rendered as dashed-line overlays
   * with their lengths labelled when `inclusions.measurements` is on.
   * Coordinates share the same mm space as the walls so they sit at the
   * right spot relative to the plan.
   */
  measurements?: Array<{
    id: string
    startMm: { x: number; y: number }
    endMm: { x: number; y: number }
  }>
}

interface ExportParams {
  projectDetails: ProjectDetails
  inclusions: BrickExportInclusions
  /**
   * Server-allocated 6-digit reference number. Embedded in the exported
   * document header + meta strip so the reader can quote it back when
   * looking the job up. Optional for projects predating the rollout.
   */
  referenceNumber?: number
  /**
   * Per-project supply-item include/exclude. Same shape as the in-memory
   * map: missing key → included, `false` → excluded. Drives whether each
   * library item turns into a row in the Accessories table.
   */
  supplyItemSelections?: Record<string, boolean>
  /**
   * Per-project rate overrides for supply items. Missing key means "use
   * the library default rate." Applied before per-unit math.
   */
  supplyItemRateOverrides?: Record<string, number>
  walls: Wall[]
  openings: Opening[]
  settings: BrickSettings
  /** Brick wall types — used to colour the Wall Layout diagrams and group
   *  walls for the legend. Optional + defaulted-empty for older callers. */
  makeups?: BrickMakeup[]
  /** Optional business identity (from user settings). Same shape as block export. */
  business?: BusinessExportInfo
  /** The primary plan PDF — when supplied alongside pagesInfo, each Wall
   *  Layout section uses the rasterised page as its background. */
  pdfFile?: File
  /** One entry per PDF page that carries walls. The export iterates these
   *  to build per-page layout sections, identical to the block flow. */
  pagesInfo?: PageInfo[]
}

/**
 * Palette for brick wall-type colouring on the layout pages — same shape
 * as the block export's palette so the visual style matches.
 */
const BRICK_WALL_TYPE_PALETTE: Array<{ body: string; dark: string }> = [
  { body: '#ED7D31', dark: '#9A3F08' }, // brand orange
  { body: '#2563eb', dark: '#1e3a8a' }, // blue
  { body: '#16a34a', dark: '#14532d' }, // green
  { body: '#7c3aed', dark: '#4c1d95' }, // purple
  { body: '#db2777', dark: '#831843' }, // pink
  { body: '#0891b2', dark: '#164e63' }, // teal
  { body: '#ca8a04', dark: '#713f12' }, // amber
  { body: '#dc2626', dark: '#7f1d1d' }, // red
]

/**
 * Build one Wall Layout overview page for a brick estimate. Mirrors the
 * block export's buildPlanOverviewPage but simpler:
 *   - no piers (brick mode doesn't draw them)
 *   - no curves (brick walls are straight)
 *   - tally tiles are brickwork-flavoured (area, brick count) instead of
 *     block-flavoured (total blocks)
 *
 * Returns '' when the page has no walls, so the caller can splice the
 * result into the document unconditionally.
 */
function buildBrickPlanOverviewPage(
  walls: Wall[],
  openings: Opening[],
  makeups: BrickMakeup[],
  pageHeader: string,
  brickwork: {
    totalAreaSqMm: number
    brickCount: number
  },
  brickThicknessMm: number,
  background:
    | { dataUrl: string; pageWidthMm: number; pageHeightMm: number; pageScaleRatio: number }
    | null,
  pageLabelSuffix: string,
  /** Ruler measurements on this page — rendered as dashed cyan reference
   *  lines when supplied. Empty array means no overlay. */
  measurements: Array<{ id: string; startMm: { x: number; y: number }; endMm: { x: number; y: number } }> = []
): string {
  if (walls.length === 0) return ''

  // Order makeups by first appearance in walls so the colour assignment
  // is stable across exports of the same project.
  const makeupsById = Object.fromEntries(makeups.map((m) => [m.id, m]))
  const colourByMakeupId: Record<string, { body: string; dark: string }> = {}
  const orderedMakeups: BrickMakeup[] = []
  const seen = new Set<string>()
  for (const w of walls) {
    if (!seen.has(w.makeupId) && makeupsById[w.makeupId]) {
      seen.add(w.makeupId)
      orderedMakeups.push(makeupsById[w.makeupId])
    }
  }
  for (const m of makeups) {
    if (!seen.has(m.id)) {
      seen.add(m.id)
      orderedMakeups.push(m)
    }
  }
  for (let i = 0; i < orderedMakeups.length; i++) {
    colourByMakeupId[orderedMakeups[i].id] =
      BRICK_WALL_TYPE_PALETTE[i % BRICK_WALL_TYPE_PALETTE.length]
  }
  const fallbackColour = BRICK_WALL_TYPE_PALETTE[0]
  const colourFor = (w: Wall) => colourByMakeupId[w.makeupId] ?? fallbackColour

  const wallLengthsMm = walls.map((w) => {
    const dx = w.endX - w.startX
    const dy = w.endY - w.startY
    return Math.sqrt(dx * dx + dy * dy)
  })
  const totalWallLengthMm = wallLengthsMm.reduce((s, l) => s + l, 0)
  const openingsAreaSqMm = openings.reduce((s, o) => s + o.widthMm * o.heightMm, 0)
  const netWallAreaSqMm = Math.max(0, brickwork.totalAreaSqMm)
  const wallTypeCount = new Set(walls.map((w) => w.makeupId)).size

  const summaryTiles: Array<{ label: string; value: string; sub?: string }> = [
    {
      label: 'Walls',
      value: String(walls.length),
      sub: `${wallTypeCount} wall type${wallTypeCount === 1 ? '' : 's'}`,
    },
    { label: 'Total length', value: `${(totalWallLengthMm / 1000).toFixed(2)} m` },
    {
      label: 'Brickwork area',
      value: `${(netWallAreaSqMm / 1_000_000).toFixed(2)} m²`,
      sub: openings.length > 0 ? 'net of openings' : 'gross area',
    },
    {
      label: 'Bricks',
      value: formatNumber(brickwork.brickCount),
    },
  ]
  if (openings.length > 0) {
    summaryTiles.push({
      label: 'Openings',
      value: String(openings.length),
      sub: `${(openingsAreaSqMm / 1_000_000).toFixed(2)} m² deducted`,
    })
  }
  const summaryRow = `
    <div class="plan-overview-stats">
      ${summaryTiles
        .map(
          (t) => `
        <div class="plan-stat">
          <div class="plan-stat-value">${escapeHtml(t.value)}</div>
          <div class="plan-stat-label">${escapeHtml(t.label)}</div>
          ${t.sub ? `<div class="plan-stat-sub">${escapeHtml(t.sub)}</div>` : ''}
        </div>
      `
        )
        .join('')}
    </div>
  `

  // Compute the viewBox from the wall extents + padding so the diagram
  // crops to the relevant region of the plan. With a background image the
  // crop is clamped to the page bounds so we never show empty SVG space.
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  for (const w of walls) {
    if (w.startX < minX) minX = w.startX
    if (w.startX > maxX) maxX = w.startX
    if (w.endX < minX) minX = w.endX
    if (w.endX > maxX) maxX = w.endX
    if (w.startY < minY) minY = w.startY
    if (w.startY > maxY) maxY = w.startY
    if (w.endY < minY) minY = w.endY
    if (w.endY > maxY) maxY = w.endY
  }
  // Pull measurements into the bounding box so a ruler that strays past
  // the wall extents still ends up inside the rendered viewBox.
  for (const m of measurements) {
    if (m.startMm.x < minX) minX = m.startMm.x
    if (m.startMm.x > maxX) maxX = m.startMm.x
    if (m.endMm.x < minX) minX = m.endMm.x
    if (m.endMm.x > maxX) maxX = m.endMm.x
    if (m.startMm.y < minY) minY = m.startMm.y
    if (m.startMm.y > maxY) maxY = m.startMm.y
    if (m.endMm.y < minY) minY = m.endMm.y
    if (m.endMm.y > maxY) maxY = m.endMm.y
  }
  if (!isFinite(minX) || !isFinite(maxX)) return ''
  const pad = Math.max(
    1000,
    brickThicknessMm * 4,
    (maxX - minX) * 0.1,
    (maxY - minY) * 0.1
  )
  let viewMinX = minX - pad
  let viewMinY = minY - pad
  let viewW = maxX - minX + pad * 2
  let viewH = maxY - minY + pad * 2
  if (background) {
    const pageRealW = background.pageWidthMm * background.pageScaleRatio
    const pageRealH = background.pageHeightMm * background.pageScaleRatio
    viewMinX = Math.max(0, viewMinX)
    viewMinY = Math.max(0, viewMinY)
    viewW = Math.min(viewW, pageRealW - viewMinX)
    viewH = Math.min(viewH, pageRealH - viewMinY)
  }

  const labelDiameter = Math.max(brickThicknessMm * 2.8, Math.min(viewW, viewH) * 0.045)
  const labelFontSize = labelDiameter * 0.55
  const lengthFontSize = labelFontSize * 0.85

  // Two-pass wall rendering for visibility: a slightly-wider dark rim
  // underneath, then the body colour on top at high opacity. Matches the
  // block export's treatment (June 2026) — walls pop clearly against
  // rasterised PDF backgrounds and pale page tints. Rim is 20 mm wider
  // than the wall (10 mm border each side); brick walls are typically
  // 110 mm thick so 20 mm is enough to register as a defined edge
  // without dominating the body fill.
  const BRICK_RIM_EXTRA_MM = 20
  const wallShapes = walls
    .map((w) => {
      const c = colourFor(w)
      return [
        `<line x1="${w.startX}" y1="${w.startY}" x2="${w.endX}" y2="${w.endY}" stroke="${c.dark}" stroke-opacity="0.85" stroke-width="${brickThicknessMm + BRICK_RIM_EXTRA_MM}" stroke-linecap="butt"/>`,
        `<line x1="${w.startX}" y1="${w.startY}" x2="${w.endX}" y2="${w.endY}" stroke="${c.body}" stroke-opacity="0.9" stroke-width="${brickThicknessMm}" stroke-linecap="butt"/>`,
      ].join('\n          ')
    })
    .join('\n          ')

  // Measurement overlays — dashed cyan lines with the measured length
  // labelled at the midpoint. Same visual treatment as the block export
  // so the deliverables read consistently across product modes.
  const measurementStrokeWidth = Math.max(brickThicknessMm * 0.18, Math.min(viewW, viewH) * 0.004)
  const measurementFontSize = labelFontSize * 0.7
  const measurementShapes = measurements
    .map((m) => {
      const dx = m.endMm.x - m.startMm.x
      const dy = m.endMm.y - m.startMm.y
      const lenMm = Math.sqrt(dx * dx + dy * dy)
      if (lenMm < 1) return ''
      const lenM = (lenMm / 1000).toFixed(2)
      const midX = (m.startMm.x + m.endMm.x) / 2
      const midY = (m.startMm.y + m.endMm.y) / 2
      const dash = measurementStrokeWidth * 4
      const gap = measurementStrokeWidth * 2
      const dotR = measurementStrokeWidth * 1.6
      return `
        <line x1="${m.startMm.x.toFixed(1)}" y1="${m.startMm.y.toFixed(1)}" x2="${m.endMm.x.toFixed(1)}" y2="${m.endMm.y.toFixed(1)}" stroke="#0891b2" stroke-width="${measurementStrokeWidth.toFixed(1)}" stroke-dasharray="${dash.toFixed(1)} ${gap.toFixed(1)}" stroke-linecap="round"/>
        <circle cx="${m.startMm.x.toFixed(1)}" cy="${m.startMm.y.toFixed(1)}" r="${dotR.toFixed(1)}" fill="#0891b2"/>
        <circle cx="${m.endMm.x.toFixed(1)}" cy="${m.endMm.y.toFixed(1)}" r="${dotR.toFixed(1)}" fill="#0891b2"/>
        <text x="${midX.toFixed(1)}" y="${(midY - measurementStrokeWidth * 2).toFixed(1)}" text-anchor="middle" dominant-baseline="alphabetic" font-family="Inter, system-ui, sans-serif" font-size="${measurementFontSize.toFixed(1)}" font-weight="600" fill="#0e7490" stroke="#fff" stroke-width="${(measurementFontSize * 0.22).toFixed(1)}" paint-order="stroke">${lenM} m</text>
      `
    })
    .join('\n          ')

  // Length-only labels — numbered circles dropped to match the block
  // export. No companion table references wall numbers, so the circles
  // were just visual noise.
  void labelDiameter
  const wallLabels = walls
    .map((w, i) => {
      const cx = (w.startX + w.endX) / 2
      const cy = (w.startY + w.endY) / 2
      const lengthM = (wallLengthsMm[i] / 1000).toFixed(2)
      return `
        <text x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="central" font-family="Inter, system-ui, sans-serif" font-size="${lengthFontSize}" font-weight="600" fill="#1f2937" stroke="#fff" stroke-width="${lengthFontSize * 0.32}" paint-order="stroke">${lengthM} m</text>
      `
    })
    .join('\n          ')

  const legendItems = orderedMakeups
    .filter((m) => walls.some((w) => w.makeupId === m.id))
    .map((m) => {
      const c = colourByMakeupId[m.id] ?? fallbackColour
      const wallsOfType = walls.filter((w) => w.makeupId === m.id)
      const totalLenM =
        wallsOfType.reduce((s, w) => {
          const idx = walls.indexOf(w)
          return s + (idx >= 0 ? wallLengthsMm[idx] : 0)
        }, 0) / 1000
      return `
        <span class="legend-item">
          <span class="legend-swatch" style="background: ${c.body}; opacity: 0.85; border: 1px solid ${c.dark};"></span>
          <strong>${escapeHtml(m.name)}</strong>
          <span class="legend-sub">${wallsOfType.length} wall${wallsOfType.length === 1 ? '' : 's'} · ${totalLenM.toFixed(2)} m</span>
        </span>
      `
    })
    .join('')

  const legend = `
    <div class="plan-overview-legend">
      ${legendItems}
      <span class="legend-item legend-note">Shapes drawn at real-world thickness; plan scaled to fit page.</span>
    </div>
  `

  const backgroundSvgElement = background
    ? `<image href="${background.dataUrl}" x="0" y="0" width="${(background.pageWidthMm * background.pageScaleRatio).toFixed(0)}" height="${(background.pageHeightMm * background.pageScaleRatio).toFixed(0)}" preserveAspectRatio="none" opacity="0.85"/>`
    : ''

  const intro = background
    ? 'The plan with the drawn walls overlaid in colour, length labelled at each wall midpoint.'
    : 'Diagram of every wall as drawn on the plan with overall sizing. Length labelled at each wall midpoint.'

  return `
    <section class="page plan-overview-page">
      ${pageHeader}
      <h2 class="section-title">Wall Layout${escapeHtml(pageLabelSuffix)}</h2>
      <p class="page-intro">${intro}</p>
      ${summaryRow}
      <div class="plan-overview-wrap">
        <svg viewBox="${viewMinX.toFixed(0)} ${viewMinY.toFixed(0)} ${viewW.toFixed(0)} ${viewH.toFixed(0)}" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid meet">
          ${backgroundSvgElement}
          ${wallShapes}
          ${measurementShapes}
          ${wallLabels}
        </svg>
      </div>
      ${legend}
    </section>
  `
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
  customNotes: string,
  supplyItemNotes: string[] = [],
  /**
   * Pre-formatted summary line for the wall-height assumption — built by
   * the caller from the project's BrickMakeup heights + per-wall
   * overrides so a multi-height project ("Facework 2400, Render 2700")
   * reads correctly. Empty / undefined falls back to the legacy single-
   * height line that quotes settings.defaultWallHeightMm, which is what
   * older projects (single makeup, no per-wall overrides) want anyway.
   */
  wallHeightSummary: string = ''
): string[] {
  if (!inclusions.assumptions) return []

  const items: string[] = [
    'All brick dimensions are nominal and include mortar joint.',
    wallHeightSummary ||
      `Wall heights are uniform at ${formatNumber(settings.defaultWallHeightMm)}mm for all walls unless otherwise noted.`,
    'Wall lengths are taken from the dimensions shown on the drawings supplied by the client. All dimensions are in millimetres unless otherwise noted.',
    'Openings (doors and windows) have been deducted from gross wall areas as indicated on the drawings.',
    'No waste allowance has been applied. Quantities are net as measured.',
  ]

  // Brick-tie + plascourse + lintel assumption notes used to be hand-
  // crafted here from BrickSettings + a hardcoded lintel catalogue. All
  // three moved to the supply-items catalogue, so the lines now come in
  // through `supplyItemNotes` below in the same rate-and-quantity style
  // ('Brick Ties allowance at 2 per m² — 25 included.'). The previous
  // hand-crafted paths have been deleted; nothing to suppress here.

  // Lintel assumption text removed — lintels are now per-opening supply
  // items the user defines themselves (with optional opening-width
  // ranges). Each lintel supply item's note appears below in the
  // supply-items section of the assumption list, so the reader still
  // knows what's being priced.

  // Supply items contributed from the user's Material library — each item
  // tells the reader the rate that was applied, in the same plain-English
  // style as the ties / plascourse lines above. Built by the caller so the
  // rate text can read off the same item objects that drove the tally.
  items.push(...supplyItemNotes)

  // Custom notes from the user — split on newlines, ignore blank lines
  const customLines = customNotes
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
  items.push(...customLines)

  return items
}

// groupLintels + LintelGroup removed — brick lintels now flow through
// the supply-item pipeline (per-opening unit with optional opening-width
// range). The user defines their own lintels in the material library
// and they render in the Accessories section like every other supply.

export async function exportBrickEstimate(params: ExportParams): Promise<void> {
  const {
    projectDetails,
    inclusions,
    referenceNumber,
    supplyItemSelections,
    supplyItemRateOverrides,
    walls,
    openings,
    settings,
    business,
    makeups = [],
    pdfFile,
    pagesInfo,
  } = params

  const referenceText =
    typeof referenceNumber === 'number'
      ? `#${
          referenceNumber >= 100000
            ? referenceNumber
            : String(referenceNumber).padStart(6, '0')
        }`
      : ''
  const tally = calculateBrickTally(walls, openings, settings)

  const headerTitle =
    projectDetails.siteAddress.trim() ||
    projectDetails.projectName.trim() ||
    'Brickwork Takeoff'
  const docTitle =
    `${projectDetails.projectName.trim() || projectDetails.siteAddress.trim() || 'Brickwork Takeoff'} — Brickwork Takeoff`

  // Compute supply-item rows + assumption notes in a single pass so the
  // Accessories table below and the Assumptions section above stay in
  // lockstep — the user-defined items show up in both places consistently.
  const supplyItems = getUserSettings().supplyItems ?? []
  const brickArea_m2 = tally.totalAreaSqMm / 1_000_000
  const brickRun_m = tally.totalLinealMm / 1000
  type SupplyRow = { name: string; qty: number; noteRate: string }
  const supplyRows: SupplyRow[] = []
  for (const item of supplyItems) {
    if (!item.appliesTo.includes('brick')) continue
    // Honour the per-project selection — missing key means included by
    // default, `false` excludes the item from this export entirely.
    if (supplyItemSelections?.[item.id] === false) continue
    // Honour the per-project rate override — undefined / unset falls back
    // to the library default rate so projects without overrides behave
    // exactly as before.
    const override = supplyItemRateOverrides?.[item.id]
    const rate =
      override !== undefined && Number.isFinite(override) ? override : item.rate
    let qty = 0
    let noteRate = ''
    switch (item.unit) {
      case 'each':
        qty = rate
        noteRate = `${rate} per project`
        break
      case 'per-brick':
        qty = rate * tally.brickCount
        noteRate = `${rate} per brick`
        break
      case 'per-m2':
        qty = rate * brickArea_m2
        noteRate = `${rate} per m²`
        break
      case 'per-m-lineal':
        qty = rate * brickRun_m
        noteRate = `${rate} per lineal metre`
        break
      case 'per-opening': {
        // If the supply item carries an opening-width range (used for
        // lintels / sills / heads), only count openings whose width
        // falls within that range. No range = applies to every opening
        // (the pre-existing behaviour for ties / flashings / etc.).
        const min = item.openingWidthMinMm
        const max = item.openingWidthMaxMm
        const inScope =
          min === undefined && max === undefined
            ? openings.length
            : openings.filter(
                (o) =>
                  (min === undefined || o.widthMm >= min) &&
                  (max === undefined || o.widthMm < max)
              ).length
        qty = rate * inScope
        const rangeLabel =
          min !== undefined || max !== undefined
            ? ` (${min ?? 0}–${max ?? '∞'} mm openings only)`
            : ''
        noteRate = `${rate} per opening${rangeLabel}`
        break
      }
      case 'per-block':
        // Brick estimate — block-relative rates don't apply.
        continue
    }
    const rounded = Math.ceil(qty)
    if (rounded <= 0) continue
    supplyRows.push({ name: item.name, qty: rounded, noteRate })
  }
  const supplyItemNotes = supplyRows.map(
    (r) => `${r.name} allowance at ${r.noteRate} — ${r.qty.toLocaleString()} included.`
  )

  // Build a human-readable summary of the distinct wall heights actually
  // used on this project — per-wall override wins over the makeup's
  // height, which wins over the project default. Single-height projects
  // collapse to one line ("2400 mm"); multi-makeup projects list each.
  // Sorted ascending so the reader sees the smallest first.
  const wallHeightSummary = (() => {
    const heightsToNames = new Map<number, Set<string>>()
    const recordHeight = (h: number, name: string) => {
      if (!Number.isFinite(h) || h <= 0) return
      const rounded = Math.round(h)
      const existing = heightsToNames.get(rounded)
      if (existing) existing.add(name)
      else heightsToNames.set(rounded, new Set([name]))
    }
    const makeupsById = new Map(makeups.map((m) => [m.id, m]))
    for (const w of walls) {
      const makeup = makeupsById.get(w.makeupId)
      const name = makeup?.name?.trim() || 'wall type'
      const h = w.heightMmOverride ?? makeup?.heightMm
      if (h !== undefined) recordHeight(h, name)
    }
    if (heightsToNames.size === 0) return ''
    const entries = [...heightsToNames.entries()].sort(([a], [b]) => a - b)
    if (entries.length === 1) {
      const [h] = entries[0]
      return `Wall heights are uniform at ${formatNumber(h)} mm for all walls unless overridden per wall.`
    }
    const parts = entries.map(([h, names]) => {
      const nameList = [...names].sort().join(', ')
      return `${formatNumber(h)} mm (${nameList})`
    })
    return `Wall heights vary by wall type: ${parts.join('; ')}. Per-wall overrides honoured where set.`
  })()

  const assumptions = buildAssumptions(
    inclusions,
    settings,
    projectDetails.notes,
    supplyItemNotes,
    wallHeightSummary
  )

  // ---------- HTML pieces ----------

  // Branded header — mirrors blockExport's logic. Logo set → logo IS the
  // brand mark and the name text drops out (no visual duplication). No
  // logo, company name set → render the name as text. Neither → generic
  // Beme wordmark. ABN/phone/website/address always print under whatever
  // mark is chosen.
  const hasBusinessIdentity = !!business?.companyName?.trim()
  const hasLogo = !!business?.logoUrl
  const contactBlock = hasBusinessIdentity
    ? `
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
    : ''
  const brandBlock = hasLogo
    ? `
        <img src="${escapeHtml(business!.logoUrl ?? '')}" alt="${escapeHtml(business?.companyName ?? 'Logo')}" class="brand-logo-primary" />
        ${contactBlock}
      `
    : hasBusinessIdentity
    ? `
        <div class="brand-name">${escapeHtml(business?.companyName ?? '')}</div>
        ${contactBlock}
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
        <div class="title-sub">${escapeHtml(headerTitle)} | All dimensions in mm${
          referenceText ? ` | Ref ${escapeHtml(referenceText)}` : ''
        }</div>
      </div>
    </header>
  `

  const metaBlock = (() => {
    const rows: string[] = []
    if (referenceText)
      rows.push(`<div><span>Reference</span> ${escapeHtml(referenceText)}</div>`)
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

  // Per-page Wall Layout overview pages — built upfront so the
  // async PDF rasterisation completes before the HTML document is
  // assembled. Each PDF page that has walls becomes one <section> with
  // its own SVG cropped to the walls + the rasterised plan beneath. The
  // section is skipped entirely when the wallLayout toggle is off, when
  // there are no pages with walls, or when the page can't be calibrated.
  const pagesToShow: PageInfo[] = inclusions.wallLayout && pagesInfo && pagesInfo.length > 0
    ? pagesInfo.filter((p) => p.walls.length > 0)
    : []
  // Resolve a wall thickness for the diagram from the project's brick
  // type; falls back to the single-skin default. Brick walls all use
  // the same thickness today (no per-wall-makeup brick type yet).
  const brickThicknessMm =
    (settings.brickTypeCode && BRICK_LIBRARY[settings.brickTypeCode]?.depthMm) ||
    DEFAULT_BRICK_WALL_THICKNESS_MM
  const planOverviewPagesArr: string[] = []
  for (const page of pagesToShow) {
    let pageBackground:
      | { dataUrl: string; pageWidthMm: number; pageHeightMm: number; pageScaleRatio: number }
      | null = null
    if (
      pdfFile &&
      page.pageWidthMm &&
      page.pageHeightMm &&
      page.pageScaleRatio &&
      page.pageScaleRatio > 0
    ) {
      const rastered = await rasterisePdfPage(pdfFile, page.pageNumber)
      if (rastered) {
        pageBackground = {
          dataUrl: rastered.dataUrl,
          pageWidthMm: page.pageWidthMm,
          pageHeightMm: page.pageHeightMm,
          pageScaleRatio: page.pageScaleRatio,
        }
      }
    }
    // Tally for JUST this page's walls so the tile reads as the page's
    // own brickwork rather than the project total. Uses the same calc
    // engine as the project-wide tally.
    const pageTally = calculateBrickTally(page.walls, page.openings, settings)
    const pageLabel = page.label?.trim() || `Page ${page.pageNumber}`
    const labelSuffix = pagesToShow.length > 1 ? ` — ${pageLabel}` : ''
    planOverviewPagesArr.push(
      buildBrickPlanOverviewPage(
        page.walls,
        page.openings,
        makeups,
        pageHeader,
        {
          totalAreaSqMm: pageTally.totalAreaSqMm,
          brickCount: pageTally.brickCount,
        },
        brickThicknessMm,
        pageBackground,
        labelSuffix,
        inclusions.measurements ? page.measurements ?? [] : []
      )
    )
  }
  const planOverviewPages = planOverviewPagesArr.join('\n')

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

  // Accessories table is driven exclusively by the user's supply-item
  // catalogue (Material library). Ties + plascourse used to be governed
  // by their own per-export inclusion flags and per-project BrickSettings
  // toggles, but both layers have been retired — the user enables /
  // disables a supply item from one place (the Material library entry)
  // and overrides it per-project via supplyItemSelections.
  const accessoriesRows: string[] = []
  for (const row of supplyRows) {
    accessoriesRows.push(
      `<tr><td>${escapeHtml(row.name)}</td><td class="right">${row.qty.toLocaleString()}</td></tr>`
    )
  }

  const accessoriesTable = accessoriesRows.length > 0
    ? `
      <h2 class="section-title">Accessories</h2>
      <table>
        <thead><tr><th>Item</th><th class="right">Quantity</th></tr></thead>
        <tbody>${accessoriesRows.join('')}</tbody>
      </table>
    `
    : ''

  const tablesPage = summaryTable || accessoriesTable
    ? `
      <section class="page">
        ${pageHeader}
        ${summaryTable}
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

  /* Wall Layout overview pages — mirrored from the block export styles
     so brick and block exports look like siblings rather than cousins. */
  .plan-overview-page h2.section-title { margin: 12px 0 4px; }
  .plan-overview-page .page-intro { margin-bottom: 6px; }
  .plan-overview-stats {
    display: flex;
    gap: 10px;
    margin: 4px 0 6px;
    flex-wrap: wrap;
  }
  .plan-stat {
    flex: 1 1 0;
    min-width: 100px;
    padding: 6px 10px;
    border: 1px solid #e5e7eb;
    border-radius: 6px;
    background: #fafafa;
  }
  .plan-stat-value {
    font-size: 16px;
    font-weight: 700;
    color: #1f2937;
    font-variant-numeric: tabular-nums;
    line-height: 1.1;
  }
  .plan-stat-label {
    font-size: 9px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: #6b7280;
    margin-top: 2px;
  }
  .plan-stat-sub { font-size: 9px; color: #6b7280; margin-top: 1px; }
  .plan-overview-wrap {
    width: 100%;
    height: 95mm;
    display: flex;
    align-items: center;
    justify-content: center;
    page-break-inside: avoid;
    break-inside: avoid;
    border: 1px solid #e5e7eb;
    border-radius: 6px;
    background: #fafaf7;
  }
  .plan-overview-wrap svg { width: 100%; height: 100%; display: block; }
  .plan-overview-legend {
    display: flex;
    gap: 14px;
    align-items: center;
    margin-top: 6px;
    font-size: 10px;
    color: #4b5563;
    flex-wrap: wrap;
  }
  .legend-item { display: inline-flex; align-items: center; gap: 6px; }
  .legend-item strong { font-weight: 600; color: #1f2937; }
  .legend-sub { color: #6b7280; font-size: 10px; margin-left: 2px; }
  .legend-swatch {
    display: inline-block;
    width: 18px;
    height: 10px;
    border-radius: 2px;
  }
  .legend-note { color: #9ca3af; font-style: italic; }

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
  /* Primary brand mark — used when no text name accompanies the logo. */
  .brand-logo-primary {
    max-height: 80px;
    max-width: 280px;
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
  ${planOverviewPages}
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

/**
 * Default brick-export inclusion tickboxes. Section flags for lintels /
 * brick ties / plascourse honour the user's regional-feature preferences
 * so a US estimator who's turned off plascourse doesn't see that section
 * appear in every new project. The user can still re-enable per project.
 */
export function createDefaultExportInclusions(): BrickExportInclusions {
  return {
    assumptions: true,
    wallLayout: true,
    // Ruler measurements default ON — same reasoning as the block side:
    // if the user drew them, they likely want them carried through.
    measurements: true,
    brickAreaSummary: true,
    disclaimer: true,
  }
}
