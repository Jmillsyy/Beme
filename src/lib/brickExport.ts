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
import type { ProjectArea } from './projectStorage'
import { calculateBrickTally } from './brickCalc'
import { downloadPdfFromHtml } from './pdfExport'
import { rasterisePdfPage } from './pdfRaster'
import { getUserSettings } from './userSettings'
import { getOrgSupplyItems } from './orgSupplyItems'
import { getCurrentOrgId } from './organisations'
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
   * Optional list of 3D viewport snapshots captured via the ▣
   * Capture button. Each entry pairs the PNG image with the legend
   * items visible at the moment of capture. When non-empty and
   * `inclusions.view3d` is true, the export renders one "3D View"
   * page per snapshot with the image as the hero and the legend as
   * a key column on the right. Matches the block export.
   */
  view3dSnapshots?: Array<{
    dataUrl: string
    legend: Array<{ code: string; label: string; color: string }>
  }>
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
  /**
   * Per-supply-item quantity ADJUSTMENTS, keyed by supply item id.
   * Same semantics as {@link brickAdjustments}: a positive value
   * subtracts from the auto-computed (rate × metric, rounded up)
   * quantity, a negative value adds. Used when the user wants to
   * override per-supply counts from the export modal (e.g. excluding
   * a tie supply that's already on site, or padding ties for
   * breakage). Missing keys → no change. Applied AFTER Math.ceil
   * rounding, then clamped to >= 0.
   */
  supplyItemAdjustments?: Record<string, number>
  walls: Wall[]
  openings: Opening[]
  settings: BrickSettings
  /** Brick wall types — used to colour the Wall Layout diagrams and group
   *  walls for the legend. Optional + defaulted-empty for older callers. */
  makeups?: BrickMakeup[]
  /**
   * Project areas (e.g. "First Floor", "Second Floor"). Optional so older
   * callers stay valid. When provided, the Brickwork by Wall Type table
   * groups rows under area headings so the estimator can see at a glance
   * which wall types live on which floor — and any wall whose areaId
   * doesn't resolve gets surfaced under an "Unassigned" group so missing
   * area data isn't silently buried.
   */
  areas?: ProjectArea[]
  /**
   * Per brick-type quantity adjustments — same semantics as
   * `blockAdjustments` in blockExport: positive number = bricks of
   * that type to SUBTRACT from the final schedule. Used when some
   * bricks are already on site, reused, or excluded from the order.
   * Keyed by brick type code. Final count clamped to >= 0.
   */
  brickAdjustments?: Record<string, number>
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

  // Opening markers — cream break on top of the wall line at each
  // opening's along-wall position with dark slate jamb ticks at each
  // end. Same architectural convention as the block export so
  // door / window positions read identically across both product
  // exports. Skips curved walls for now.
  const openingShapes = openings
    .map((op) => {
      const w = walls.find((ww) => ww.id === op.wallId)
      if (!w) return ''
      if (w.kind === 'curved') return ''
      const dx = w.endX - w.startX
      const dy = w.endY - w.startY
      const wallLen = Math.sqrt(dx * dx + dy * dy)
      if (wallLen === 0) return ''
      const ux = dx / wallLen
      const uy = dy / wallLen
      const px = -uy
      const py = ux
      const s0 = Math.max(0, op.startAlongWallMm)
      const s1 = Math.min(wallLen, op.startAlongWallMm + op.widthMm)
      if (s1 - s0 < 1) return ''
      const ox0 = w.startX + ux * s0
      const oy0 = w.startY + uy * s0
      const ox1 = w.startX + ux * s1
      const oy1 = w.startY + uy * s1
      const tickHalf = brickThicknessMm * 0.65
      const t0x = ox0 + px * tickHalf
      const t0y = oy0 + py * tickHalf
      const t0xN = ox0 - px * tickHalf
      const t0yN = oy0 - py * tickHalf
      const t1x = ox1 + px * tickHalf
      const t1y = oy1 + py * tickHalf
      const t1xN = ox1 - px * tickHalf
      const t1yN = oy1 - py * tickHalf
      return [
        `<line x1="${ox0.toFixed(1)}" y1="${oy0.toFixed(1)}" x2="${ox1.toFixed(1)}" y2="${oy1.toFixed(1)}" stroke="#fef3c7" stroke-opacity="0.96" stroke-width="${(brickThicknessMm * 0.92).toFixed(1)}" stroke-linecap="butt"/>`,
        `<line x1="${t0x.toFixed(1)}" y1="${t0y.toFixed(1)}" x2="${t0xN.toFixed(1)}" y2="${t0yN.toFixed(1)}" stroke="#0f172a" stroke-width="${(brickThicknessMm * 0.18).toFixed(1)}" stroke-linecap="round"/>`,
        `<line x1="${t1x.toFixed(1)}" y1="${t1y.toFixed(1)}" x2="${t1xN.toFixed(1)}" y2="${t1yN.toFixed(1)}" stroke="#0f172a" stroke-width="${(brickThicknessMm * 0.18).toFixed(1)}" stroke-linecap="round"/>`,
      ].join('\n          ')
    })
    .filter(Boolean)
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
          ${openingShapes}
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

  // Per-item supply notes are NOT appended any more. With 16+
  // Galintel SKUs (and ties / cement / rebar etc.) the assumptions
  // section became dominated by allowance-rate lines. The Accessories
  // table on the tally page already lists every supply with its
  // quantity and is grouped by category, so the reader gets the same
  // information in a cleaner format. supplyItemNotes is left in the
  // signature for caller back-compat; nothing consumes it here.
  void supplyItemNotes

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

/**
 * Build the assembled brick-export HTML without downloading it. Mirrors
 * `buildBlockEstimateHtml` so the combined exporter can extract this
 * function's `bodyContent` + `styles` and stitch them into a single
 * document alongside the block side.
 */
export async function buildBrickEstimateHtml(
  params: ExportParams
): Promise<{ html: string; filename: string; bodyContent: string; styles: string }> {
  const {
    projectDetails,
    inclusions,
    referenceNumber,
    supplyItemSelections,
    supplyItemRateOverrides,
    supplyItemAdjustments,
    walls,
    openings,
    settings,
    business,
    makeups = [],
    areas,
    pdfFile,
    pagesInfo,
    view3dSnapshots,
  } = params

  const referenceText =
    typeof referenceNumber === 'number'
      ? `#${
          referenceNumber >= 100000
            ? referenceNumber
            : String(referenceNumber).padStart(6, '0')
        }`
      : ''
  // Pass makeups through so per-makeup course bands (single bottom
  // course + double-height above, etc.) feed into the printed tally
  // exactly as they do in the workspace tally panel.
  const rawTally = calculateBrickTally(walls, openings, settings, makeups)
  // Apply per-brick-type signed adjustments. Same semantics as the
  // block side:
  //   - positive → remove from tally (on-site / reused).
  //   - negative → add extra (user wants more than the auto-count,
  //     or a brick type not in the auto-tally at all).
  // Final counts clamped to >= 0.
  const adjMap = params.brickAdjustments ?? {}
  let adjustedBricksByType: Record<string, number> = {}
  let adjustedBrickCount: number = 0
  if (Object.keys(rawTally.bricksByType).length > 0) {
    // Mixed-type project — iterate over union of tally codes +
    // adjustment codes so add-only entries land in the schedule.
    const allCodes = new Set([
      ...Object.keys(rawTally.bricksByType),
      ...Object.keys(adjMap),
    ])
    for (const code of allCodes) {
      const base = rawTally.bricksByType[code] ?? 0
      const adj = adjMap[code] ?? 0
      const remaining = Math.max(0, base - adj)
      if (remaining > 0) adjustedBricksByType[code] = remaining
      adjustedBrickCount += remaining
    }
  } else {
    // Single-type project — adjustments apply to the project's
    // configured brick type code. Other codes in adjMap (if any)
    // are extra rows added by the user.
    const projectCode = settings.brickTypeCode
    const projectAdj = adjMap[projectCode] ?? 0
    const projectRemaining = Math.max(0, rawTally.brickCount - projectAdj)
    if (projectRemaining > 0) {
      adjustedBricksByType[projectCode] = projectRemaining
      adjustedBrickCount += projectRemaining
    }
    for (const [code, adj] of Object.entries(adjMap)) {
      if (code === projectCode) continue
      // Add-only entries — base is 0, adj negative means add.
      const remaining = Math.max(0, 0 - adj)
      if (remaining > 0) {
        adjustedBricksByType[code] = remaining
        adjustedBrickCount += remaining
      }
    }
    // When NO add-only entries land in bricksByType, fall back to
    // empty so downstream consumers use the flat brickCount path.
    if (Object.keys(adjustedBricksByType).length === 1 && adjustedBricksByType[projectCode] !== undefined) {
      adjustedBricksByType = {}
    }
  }
  const tally = {
    ...rawTally,
    bricksByType: adjustedBricksByType,
    brickCount: adjustedBrickCount,
  }

  const headerTitle =
    projectDetails.siteAddress.trim() ||
    projectDetails.projectName.trim() ||
    'Brickwork Takeoff'
  // Filename + document title — prefer site address so the saved
  // PDF is named by site. Falls back to project name, then generic.
  const docTitle =
    `${projectDetails.siteAddress.trim() || projectDetails.projectName.trim() || 'Brickwork Takeoff'} — Brickwork Takeoff`

  // Compute supply-item rows + assumption notes in a single pass so the
  // Accessories table below and the Assumptions section above stay in
  // lockstep — the user-defined items show up in both places consistently.
  // Source of truth: org-synced list when an org is active; falls back
  // to local IndexedDB for personal mode.
  const supplyItems = getCurrentOrgId()
    ? getOrgSupplyItems()
    : getUserSettings().supplyItems ?? []
  const brickArea_m2 = tally.totalAreaSqMm / 1_000_000
  const brickRun_m = tally.totalLinealMm / 1000
  type SupplyRow = {
    name: string
    qty: number
    noteRate: string
    category: string
  }
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
        //
        // Both bounds INCLUSIVE — matches the block-lintel bucket
        // convention. A "Galintel 100×100" with range 1200–1800
        // covers both a 1200mm and a 1800mm opening.
        const min = item.openingWidthMinMm
        const max = item.openingWidthMaxMm
        const inScope =
          min === undefined && max === undefined
            ? openings.length
            : openings.filter(
                (o) =>
                  (min === undefined || o.widthMm >= min) &&
                  (max === undefined || o.widthMm <= max)
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
    // Apply the user's per-supply-item adjustment (positive = remove,
    // negative = add) AFTER rounding so the modal's preview number
    // matches the row that lands in the PDF. Clamp to >= 0; skip
    // zero-qty rows. The pre-adjusted `rounded` is intentionally
    // NOT gated to zero — a negative delta promotes a zero-qty item
    // into the schedule.
    const supplyAdj = supplyItemAdjustments?.[item.id] ?? 0
    const finalQty = Math.max(0, rounded - supplyAdj)
    if (finalQty <= 0) continue
    supplyRows.push({
      name: item.name,
      qty: finalQty,
      noteRate,
      category: item.category?.trim() || 'Uncategorised',
    })
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
    const pageTally = calculateBrickTally(page.walls, page.openings, settings, makeups)
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

  // Brick type breakdown — only printed when at least one wall type uses
  // course bands (single bottom course + double-height above, etc.).
  // For single-brick projects the tally returns an empty `bricksByType`
  // and this section drops out entirely, leaving the simpler old layout.
  const typeBreakdownRows = Object.entries(tally.bricksByType).sort((a, b) => b[1] - a[1])
  const typeBreakdownTable = typeBreakdownRows.length > 0
    ? `
      <h2 class="section-title">Brick Type Breakdown</h2>
      <table>
        <thead>
          <tr><th>Brick</th><th class="right">Quantity</th></tr>
        </thead>
        <tbody>
          ${typeBreakdownRows
            .map(([code, count]) => {
              const brick = BRICK_LIBRARY[code]
              const label = brick?.name ?? code ?? 'Project default'
              return `<tr><td>${escapeHtml(label)}</td><td class="right">${count.toLocaleString()}</td></tr>`
            })
            .join('')}
          <tr class="bold"><td>Total bricks</td><td class="right">${tally.brickCount.toLocaleString()}</td></tr>
        </tbody>
      </table>
    `
    : ''

  // Opening trim bricks (sill / head courses) — one row per brick type
  // used as sill or head, with the count of trim bricks the bricklayer
  // needs to order separately from the body brickwork. Only renders
  // when at least one makeup on the project nominated a trim brick;
  // empty for legacy projects without sill / head codes set.
  const trimEntries = Object.entries(tally.openingTrimByType ?? {}).sort(
    (a, b) => b[1] - a[1],
  )
  const trimTable = trimEntries.length > 0
    ? `
      <h2 class="section-title">Opening Trim Bricks</h2>
      <p style="margin: 4px 0 8px; color: #555; font-size: 12px;">
        Sill and head course bricks ordered separately from the body
        brickwork. One course's worth of bricks per opening, including
        bearing overhang at each end. Tally is the sum across every
        opening on walls whose type nominates a trim brick.
      </p>
      <table>
        <thead>
          <tr><th>Brick</th><th class="right">Quantity</th></tr>
        </thead>
        <tbody>
          ${trimEntries
            .map(([code, count]) => {
              const brick = BRICK_LIBRARY[code]
              const label = brick?.name ?? code ?? 'Project default'
              return `<tr><td>${escapeHtml(label)}</td><td class="right">${count.toLocaleString()}</td></tr>`
            })
            .join('')}
        </tbody>
      </table>
    `
    : ''

  const brickMakeupsById = new Map(makeups.map((m) => [m.id, m]))
  // Per-wall-type (per-makeup) breakdown, grouped by AREA. Each wall
  // makeup gets a row under its area heading showing gross area /
  // openings deducted / net area / bricks needed — so the estimator
  // can price each wall type independently per floor (Common $X/m²
  // on Ground Floor, Facework $Y/m² on First Floor, etc.) without
  // re-doing the deduction maths by hand.
  //
  // Hidden when there's only ONE makeup on the project (or no makeups
  // at all), since a one-row table just duplicates the Brick Area
  // Summary above.
  //
  // Per-area aggregation works by re-bucketing each wall against
  // (areaId, makeupId) — `tally.byMakeup` doesn't carry area info
  // because the tally engine is area-agnostic. We re-compute per-area
  // gross/net/opening here using the same engine pattern.
  type AreaMakeupRow = {
    areaId: string | null
    makeupId: string
    wallCount: number
    grossAreaSqMm: number
    openingAreaSqMm: number
    netAreaSqMm: number
    brickCount: number
  }
  const rowsByKey: Record<string, AreaMakeupRow> = {}
  const openingsByWallId = new Map<string, Opening[]>()
  for (const op of openings) {
    if (!op.wallId) continue
    const arr = openingsByWallId.get(op.wallId) ?? []
    arr.push(op)
    openingsByWallId.set(op.wallId, arr)
  }
  for (const w of walls) {
    const areaKey = w.areaId ?? ''
    const makeupKey = w.makeupId || '__none__'
    const key = `${areaKey}|${makeupKey}`
    const row =
      rowsByKey[key] ??
      (rowsByKey[key] = {
        areaId: w.areaId ?? null,
        makeupId: makeupKey,
        wallCount: 0,
        grossAreaSqMm: 0,
        openingAreaSqMm: 0,
        netAreaSqMm: 0,
        brickCount: 0,
      })
    const makeup = brickMakeupsById.get(w.makeupId)
    const height =
      w.heightMmOverride ??
      makeup?.heightMm ??
      settings.defaultWallHeightMm
    // Brick walls don't have corner extensions like block walls do, so
    // a simple Euclidean length matches what calculateBrickTally does
    // for the same wall.
    const dx = w.endX - w.startX
    const dy = w.endY - w.startY
    const len = Math.sqrt(dx * dx + dy * dy)
    const gross = len * height
    const wallOps = openingsByWallId.get(w.id) ?? []
    const opArea = wallOps.reduce(
      (s, o) => s + o.widthMm * o.heightMm,
      0,
    )
    const net = Math.max(0, gross - opArea)
    row.wallCount += 1
    row.grossAreaSqMm += gross
    row.openingAreaSqMm += opArea
    row.netAreaSqMm += net
    // Brick count for this wall using its own makeup's rate (falls
    // back to project default when the makeup carries no rate).
    const rate = settings.bricksPerSquareMetre
    row.brickCount += Math.ceil((net / 1_000_000) * rate)
  }
  const allRows = Object.values(rowsByKey).filter((r) => r.grossAreaSqMm > 0)
  // Order areas: project order first, then any 'Unassigned' / unknown
  // area at the bottom. Within an area, sort wall-type rows by net
  // area DESC so the biggest contributor leads.
  const areaIdOrder = new Map<string, number>()
  if (areas) {
    for (let i = 0; i < areas.length; i++) areaIdOrder.set(areas[i].id, i)
  }
  const areaOrder = (id: string | null): number =>
    id === null
      ? Number.POSITIVE_INFINITY
      : areaIdOrder.get(id) ?? Number.POSITIVE_INFINITY - 1
  allRows.sort((a, b) => {
    const ao = areaOrder(a.areaId)
    const bo = areaOrder(b.areaId)
    if (ao !== bo) return ao - bo
    return b.netAreaSqMm - a.netAreaSqMm
  })
  // Group by area for rendering.
  const groupedByArea: Array<{
    areaName: string
    rows: AreaMakeupRow[]
  }> = []
  for (const row of allRows) {
    const areaName =
      row.areaId === null
        ? 'Unassigned'
        : areas?.find((a) => a.id === row.areaId)?.name ?? 'Unknown area'
    const last = groupedByArea[groupedByArea.length - 1]
    if (last && last.areaName === areaName) last.rows.push(row)
    else groupedByArea.push({ areaName, rows: [row] })
  }
  const makeupBreakdownTable = allRows.length > 1
    ? `
      <h2 class="section-title">Brickwork by Wall Type</h2>
      <table>
        <thead>
          <tr>
            <th>Wall type</th>
            <th class="right" style="width: 80px">Walls</th>
            <th class="right" style="width: 110px">Gross (m²)</th>
            <th class="right" style="width: 110px">Openings (m²)</th>
            <th class="right" style="width: 110px">Net (m²)</th>
            <th class="right" style="width: 110px">Bricks</th>
          </tr>
        </thead>
        <tbody>
          ${groupedByArea
            .map((group) => {
              const groupGross = group.rows.reduce((s, r) => s + r.grossAreaSqMm, 0)
              const groupOpening = group.rows.reduce((s, r) => s + r.openingAreaSqMm, 0)
              const groupNet = group.rows.reduce((s, r) => s + r.netAreaSqMm, 0)
              const groupBricks = group.rows.reduce((s, r) => s + r.brickCount, 0)
              const groupWallCount = group.rows.reduce((s, r) => s + r.wallCount, 0)
              const header = `<tr class="area-header">
                <td colspan="6" style="background: #f3f0ea; font-weight: 600; padding-top: 6px;">${escapeHtml(group.areaName)}</td>
              </tr>`
              const rowsHtml = group.rows
                .map((r) => {
                  const makeup =
                    r.makeupId === '__none__'
                      ? null
                      : makeups.find((m) => m.id === r.makeupId) ?? null
                  const label = makeup?.name ?? 'No wall type'
                  return `<tr>
                    <td>${escapeHtml(label)}</td>
                    <td class="right">${r.wallCount}</td>
                    <td class="right">${formatNumber(r.grossAreaSqMm / 1_000_000, 3)}</td>
                    <td class="right">${r.openingAreaSqMm > 0 ? `-${formatNumber(r.openingAreaSqMm / 1_000_000, 3)}` : '0'}</td>
                    <td class="right">${formatNumber(r.netAreaSqMm / 1_000_000, 3)}</td>
                    <td class="right">${r.brickCount.toLocaleString()}</td>
                  </tr>`
                })
                .join('')
              const subtotal = groupedByArea.length > 1
                ? `<tr class="area-subtotal" style="font-style: italic;">
                    <td>${escapeHtml(group.areaName)} subtotal</td>
                    <td class="right">${groupWallCount}</td>
                    <td class="right">${formatNumber(groupGross / 1_000_000, 3)}</td>
                    <td class="right">-${formatNumber(groupOpening / 1_000_000, 3)}</td>
                    <td class="right">${formatNumber(groupNet / 1_000_000, 3)}</td>
                    <td class="right">${groupBricks.toLocaleString()}</td>
                  </tr>`
                : ''
              return header + rowsHtml + subtotal
            })
            .join('')}
          <tr class="bold">
            <td>Total</td>
            <td class="right">${tally.wallCount}</td>
            <td class="right">${formatNumber(
              allRows.reduce((s, r) => s + r.grossAreaSqMm, 0) / 1_000_000,
              3
            )}</td>
            <td class="right">-${formatNumber(
              allRows.reduce((s, r) => s + r.openingAreaSqMm, 0) / 1_000_000,
              3
            )}</td>
            <td class="right">${formatNumber(
              allRows.reduce((s, r) => s + r.netAreaSqMm, 0) / 1_000_000,
              3
            )}</td>
            <td class="right">${tally.brickCount.toLocaleString()}</td>
          </tr>
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
  //
  // Rendered grouped by category: items sharing a category appear
  // under one bold sub-header row. Uncategorised group pinned last
  // (rendered without a header when it's the only group, so projects
  // without any categories keep the flat-list look).
  const accessoriesTable = (() => {
    if (supplyRows.length === 0) return ''
    const UNCAT = 'Uncategorised'
    const groups = new Map<string, typeof supplyRows>()
    for (const r of supplyRows) {
      const key = r.category || UNCAT
      const arr = groups.get(key)
      if (arr) arr.push(r)
      else groups.set(key, [r])
    }
    const ordered = Array.from(groups.entries()).sort(([a], [b]) => {
      if (a === UNCAT) return 1
      if (b === UNCAT) return -1
      return a.localeCompare(b)
    })
    const renderGroup = (label: string, rows: typeof supplyRows) => {
      const showHeader = ordered.length > 1 || label !== UNCAT
      const headerRow = showHeader
        ? `<tr class="category-row"><td colspan="2" style="font-weight: 600; padding-top: 12px;">${escapeHtml(label)}</td></tr>`
        : ''
      const itemRows = rows
        .map(
          (r) =>
            `<tr><td>${escapeHtml(r.name)}</td><td class="right">${r.qty.toLocaleString()}</td></tr>`
        )
        .join('')
      return headerRow + itemRows
    }
    return `
      <h2 class="section-title">Accessories</h2>
      <table>
        <thead><tr><th>Item</th><th class="right">Quantity</th></tr></thead>
        <tbody>${ordered.map(([cat, rows]) => renderGroup(cat, rows)).join('')}</tbody>
      </table>
    `
  })()

  const tablesPage =
    summaryTable ||
    makeupBreakdownTable ||
    typeBreakdownTable ||
    trimTable ||
    accessoriesTable
      ? `
      <section class="page">
        ${pageHeader}
        ${summaryTable}
        ${makeupBreakdownTable}
        ${typeBreakdownTable}
        ${trimTable}
        ${accessoriesTable}
      </section>
    `
      : ''

  // 3D view snapshots — same magazine-style hero pages as the block
  // export. One page per snapshot, in queue order, immediately after
  // the 2D plan overview so the same project geometry flows from
  // plan → 3D → tally tables.
  const formattedDate = projectDetails.date
    ? new Date(projectDetails.date).toLocaleDateString('en-AU', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      })
    : ''
  const view3dPages =
    inclusions.view3d && view3dSnapshots && view3dSnapshots.length > 0
      ? view3dSnapshots
          .map((snap, i) => {
            const legendHtml =
              snap.legend.length > 0
                ? `
              <aside class="view3d-legend">
                <div class="view3d-legend-title">Legend</div>
                <ul class="view3d-legend-list">
                  ${snap.legend
                    .map(
                      (item) => `
                    <li class="view3d-legend-row">
                      <span class="view3d-legend-swatch" style="background:${item.color};"></span>
                      <span class="view3d-legend-label">${escapeHtml(item.label)}</span>
                      <span class="view3d-legend-code">${escapeHtml(item.code)}</span>
                    </li>
                  `
                    )
                    .join('')}
                </ul>
              </aside>
            `
                : ''
            return `
      <section class="page view3d-page">
        ${pageHeader}
        <div class="view3d-accent"></div>
        <header class="view3d-header">
          <div class="view3d-eyebrow">3D Visualisation${view3dSnapshots.length > 1 ? ` &middot; View ${i + 1} of ${view3dSnapshots.length}` : ''}</div>
          <h1 class="view3d-title">${escapeHtml(projectDetails.projectName || 'Project preview')}</h1>
          ${
            projectDetails.siteAddress
              ? `<div class="view3d-subtitle">${escapeHtml(projectDetails.siteAddress)}</div>`
              : ''
          }
        </header>
        <div class="view3d-body${legendHtml ? ' has-legend' : ''}">
          <figure class="view3d-figure">
            <img src="${snap.dataUrl}" alt="3D view of the project" class="view3d-image" />
          </figure>
          ${legendHtml}
        </div>
        <footer class="view3d-meta">
          <div class="view3d-meta-block">
            <div class="view3d-meta-label">Reference</div>
            <div class="view3d-meta-value">${referenceText || '—'}</div>
          </div>
          <div class="view3d-meta-block">
            <div class="view3d-meta-label">Client</div>
            <div class="view3d-meta-value">${escapeHtml(projectDetails.clientName || '—')}</div>
          </div>
          <div class="view3d-meta-block">
            <div class="view3d-meta-label">Date</div>
            <div class="view3d-meta-value">${escapeHtml(formattedDate || '—')}</div>
          </div>
        </footer>
      </section>
    `
          })
          .join('')
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
  //
  // Body content captured separately so the combined exporter can splice
  // brick pages into a document alongside the block side. Single-trade
  // callers get the full assembled doc just like before.

  const bodyContent = `
  ${assumptionsPage}
  ${planOverviewPages}
  ${/* 3D snapshots flow directly after the 2D plan overview — same
       visual subject (the walls), different view. Same ordering as
       the block export so combined exports read consistently. */ ''}
  ${view3dPages}
  ${tablesPage}
  ${disclaimerPage}
`

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

  /* "Built with Beme" credit footer on every page. Pulled tight
     against the bottom margin so it doesn't crowd metadata rows. */
  .page { position: relative; padding-bottom: 50px; }
  .beme-credit {
    position: absolute;
    left: 1.5cm;
    right: 1.5cm;
    bottom: 0.3cm;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 5px;
    font-size: 9px;
    color: #9CA3AF;
    border-top: 1px solid #E5E7EB;
    padding-top: 4px;
  }

  /* 3D view pages — magazine-style hero shot. Same layout as the
     block export so the deliverables read consistently across
     product modes. Explicit mm dimensions because PDF print engines
     don't honour flex grow on landscape A4. */
  .view3d-page {
    position: relative;
    page-break-inside: avoid;
    break-inside: avoid;
  }
  .view3d-accent {
    width: 32mm;
    height: 3px;
    background: linear-gradient(90deg, #ED7D31 0%, #F59E0B 100%);
    border-radius: 2px;
    margin-bottom: 3mm;
  }
  .view3d-header {
    margin-bottom: 3mm;
  }
  .view3d-eyebrow {
    text-transform: uppercase;
    letter-spacing: 0.18em;
    font-size: 9px;
    font-weight: 700;
    color: #ED7D31;
    margin-bottom: 1.5mm;
  }
  .view3d-title {
    margin: 0 0 1.5mm 0;
    font-size: 26px;
    font-weight: 700;
    color: #0f172a;
    letter-spacing: -0.02em;
    line-height: 1.1;
  }
  .view3d-subtitle {
    font-size: 11px;
    color: #475569;
    font-weight: 400;
  }
  .view3d-body {
    display: flex;
    align-items: stretch;
    gap: 5mm;
    height: 102mm;
  }
  .view3d-figure {
    flex: 1 1 auto;
    min-width: 0;
    margin: 0;
    padding: 0;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .view3d-image {
    max-width: 100%;
    max-height: 102mm;
    object-fit: contain;
    border-radius: 8px;
    box-shadow:
      0 1px 2px rgba(15, 23, 42, 0.04),
      0 8px 24px rgba(15, 23, 42, 0.10);
  }
  .view3d-legend {
    flex: 0 0 44mm;
    padding: 2.5mm 3mm 2mm;
    border: 1px solid #e2e8f0;
    border-radius: 5px;
    background: #f8fafc;
    font-size: 8px;
    color: #1f2937;
    overflow: hidden;
  }
  .view3d-legend-title {
    text-transform: uppercase;
    letter-spacing: 0.12em;
    font-size: 7px;
    font-weight: 700;
    color: #ED7D31;
    margin-bottom: 1.5mm;
    padding-bottom: 1mm;
    border-bottom: 1px solid #e2e8f0;
  }
  .view3d-legend-list { list-style: none; margin: 0; padding: 0; }
  .view3d-legend-row {
    display: flex;
    align-items: center;
    gap: 1.5mm;
    padding: 0.4mm 0;
    min-width: 0;
  }
  .view3d-legend-swatch {
    flex: 0 0 auto;
    width: 2.2mm;
    height: 2.2mm;
    border-radius: 1px;
    border: 1px solid rgba(15, 23, 42, 0.08);
  }
  .view3d-legend-label {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: #0f172a;
    font-weight: 500;
  }
  .view3d-legend-code {
    flex: 0 0 auto;
    color: #94a3b8;
    font-size: 7px;
    font-variant-numeric: tabular-nums;
  }
  .view3d-meta {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 6mm;
    padding-top: 3mm;
    margin-top: 3mm;
    border-top: 1px solid #e2e8f0;
  }
  .view3d-meta-block { min-width: 0; }
  .view3d-meta-label {
    text-transform: uppercase;
    letter-spacing: 0.12em;
    font-size: 7px;
    font-weight: 600;
    color: #94a3b8;
    margin-bottom: 0.7mm;
  }
  .view3d-meta-value {
    font-size: 10px;
    font-weight: 600;
    color: #0f172a;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    line-height: 1.2;
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
<body>${bodyContent}</body>
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
  // Same footer injection applied to the standalone bodyContent so the
  // combined exporter (which uses bodyContent directly) keeps the credit.
  const bodyContentWithFooter = bodyContent.replace(
    /<\/section>/g,
    `${bemeFooter}</section>`
  )

  // Extract the style block so the combined exporter can merge brick
  // styles with block styles into one document.
  const styleMatch = htmlWithFooter.match(/<style>([\s\S]*?)<\/style>/)
  const styles = styleMatch ? styleMatch[1] : ''

  return {
    html: htmlWithFooter,
    filename: docTitle,
    bodyContent: bodyContentWithFooter,
    styles,
  }
}

/**
 * Single-trade entry point — kept as a thin wrapper over
 * `buildBrickEstimateHtml` so the existing BrickExportPanel call site
 * doesn't need to change.
 */
export async function exportBrickEstimate(params: ExportParams): Promise<void> {
  const built = await buildBrickEstimateHtml(params)
  await downloadPdfFromHtml({ html: built.html, filename: built.filename })
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
    // 3D snapshot default ON — same semantics as the block side. If
    // the user hasn't captured any, the export is just silently
    // shorter by a page.
    view3d: true,
    disclaimer: true,
  }
}
