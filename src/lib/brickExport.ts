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
import { wallLengthMm } from './blockCalc'
import { downloadPdfFromHtml } from './pdfExport'
import { rasterisePdfPage } from './pdfRaster'
import { getUserSettings } from './userSettings'
import { getOrgSupplyItems } from './orgSupplyItems'
import { getCurrentOrgId } from './organisations'
import {
  formatSupplyQuantity,
  roundSupplyQuantity,
} from '../types/userSettings'
import { BRICK_LIBRARY } from '../data/brickLibrary'
import { arcFromThreePoints, isCurvedWall } from './curveGeom'

/**
 * Wall lineal length in mm. Mirrors the brickCalc helper:
 *   - Straight walls → Euclidean distance.
 *   - Curved walls → true centreline arc length (sweep × radius).
 *
 * Centralised here too so every callsite — summary tiles, per-wall
 * tally, opening shape projection — reports the same length for the
 * same wall.
 */
function wallLinealMm(w: Wall): number {
  if (isCurvedWall(w) && w.midX !== undefined && w.midY !== undefined) {
    const geom = arcFromThreePoints(
      { x: w.startX, y: w.startY },
      { x: w.midX, y: w.midY },
      { x: w.endX, y: w.endY },
    )
    if (geom) return geom.arcLengthMm
  }
  const dx = w.endX - w.startX
  const dy = w.endY - w.startY
  return Math.sqrt(dx * dx + dy * dy)
}

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
  /**
   * Per-export supply-item NAME overrides — keyed by supply item id,
   * value is the renamed label to use in the PDF. Empty / missing
   * value falls back to the library item's name. Lets the user
   * rename a specific supply on a per-quote basis (e.g. "Galintel
   * 1500" → "Lintel above front door") without mutating the master
   * material library.
   */
  supplyItemNameOverrides?: Record<string, string>
  /**
   * Per-export cover page text overrides — title, subtitle, intro.
   * Same shape as the block exporter. When ALL three are missing /
   * empty, no cover page is rendered. When any field is set, a
   * dedicated cover page is prepended using `projectDetails` as
   * fallback for the title.
   */
  coverOverrides?: {
    title?: string
    subtitle?: string
    intro?: string
  }
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
  /**
   * Per-area metric overrides from the export modal's Quantities
   * section. When a field is set, it replaces the auto-computed
   * value for that area in the export's headline summary totals.
   * Keyed by areaId (or `__unassigned__` for the unassigned bucket).
   * Missing fields fall back to the calc-engine value.
   *
   * Currently applied to the top-level summary numbers in the
   * exported PDF. The detailed schedule of materials (Galintels per
   * opening, etc.) still tracks the raw geometry so a hand-bumped
   * m² doesn't invent new openings.
   */
  perAreaBrickOverrides?: Record<
    string,
    {
      sqM?: number
      headLinealM?: number
      sillLinealM?: number
      /** Per-wall-type drilldown within this area. Each entry is
       *  keyed by makeup id and can override that wall type's
       *  m² / head lineal m / sill lineal m contribution. Deltas are
       *  computed against per-(area, makeup) auto totals and
       *  applied to the project-wide brick tally. */
      byMakeup?: Record<
        string,
        { sqM?: number; headLinealM?: number; sillLinealM?: number }
      >
    }
  >
  /** Wastage uplift percent for the brick AREA total (m²) only.
   *  When supplied (> 0), the Brick Area Summary table grows a
   *  second column showing the net area + X% wastage. Supply items,
   *  per-area Quantities overrides, and the per-wall-type breakdown
   *  are intentionally not touched — supplies are estimator-managed
   *  allowances, and wastage is a single project-wide uplift on the
   *  headline figure used to order brick. */
  wastagePercent?: number
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

  // Per-wall length. Routes through wallLengthMm (same helper the 2D
  // canvas + tally use) so corner ends pick up the halfThickness
  // extension out to the outer-edge corner — without this the export
  // labels read ~halfThickness shorter than what the user drew at
  // every corner. Curved walls still resolve to true arc length via
  // wallLengthMm's internal isCurvedWall path. Brick is single-skin
  // so every wall shares the same thickness for the helper.
  const thicknessByWallId: Record<string, number> = {}
  const wallsById: Record<string, Wall> = {}
  for (const w of walls) {
    thicknessByWallId[w.id] = brickThicknessMm
    wallsById[w.id] = w
  }
  const wallLengthsMm = walls.map((w) =>
    wallLengthMm(w, thicknessByWallId, wallsById),
  )
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
    // "Bricks" tile intentionally removed — the deliverable now
    // reports total wall area + lineal m for trim courses; the
    // estimator applies their own bricks/m² rate from the library.
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
      // Curved walls render as an SVG <path> A-arc instead of a
      // straight <line> so the plan overview shows the same shape
      // the user drew. Two stroked passes — wider dark rim, narrower
      // body fill — match the straight-wall styling exactly so
      // mixed straight + curved walls read as one drawing.
      if (isCurvedWall(w) && w.midX !== undefined && w.midY !== undefined) {
        const geom = arcFromThreePoints(
          { x: w.startX, y: w.startY },
          { x: w.midX, y: w.midY },
          { x: w.endX, y: w.endY },
        )
        if (geom) {
          // SVG arc flags: large-arc when |sweep| > π,
          // sweep-flag = 1 for CCW in screen space (y grows down
          // so the sign convention flips vs maths-conventional
          // atan2). arcFromThreePoints uses screen-space y, so
          // sweepAngle > 0 already maps to the visual CCW.
          const largeArc = Math.abs(geom.sweepAngle) > Math.PI ? 1 : 0
          const sweepFlag = geom.sweepAngle > 0 ? 1 : 0
          const d = `M ${w.startX} ${w.startY} A ${geom.radiusMm} ${geom.radiusMm} 0 ${largeArc} ${sweepFlag} ${w.endX} ${w.endY}`
          return [
            `<path d="${d}" fill="none" stroke="${c.dark}" stroke-opacity="0.85" stroke-width="${brickThicknessMm + BRICK_RIM_EXTRA_MM}" stroke-linecap="butt"/>`,
            `<path d="${d}" fill="none" stroke="${c.body}" stroke-opacity="0.9" stroke-width="${brickThicknessMm}" stroke-linecap="butt"/>`,
          ].join('\n          ')
        }
        // Degenerate curve (collinear points) — fall through to the
        // straight-line render below so nothing disappears.
      }
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

  // Opening keys — break out by door / window kind so the reader
  // can match the cream-break markers on the plan to "opening of
  // kind X" in the legend. Inline SVG swatch shows the same cream
  // body + dark jamb tick treatment the plan uses, so the key is
  // visually grounded to the markers above.
  const windowCount = openings.filter((o) => o.kind !== 'door').length
  const doorCount = openings.filter((o) => o.kind === 'door').length
  const openingSwatch = `
    <svg viewBox="0 0 24 12" xmlns="http://www.w3.org/2000/svg" class="legend-opening-swatch" aria-hidden="true">
      <rect x="0" y="3" width="24" height="6" fill="#cbb89a" stroke="#0f172a" stroke-width="0.5"/>
      <rect x="3" y="3" width="18" height="6" fill="#fef3c7"/>
      <line x1="3" y1="1" x2="3" y2="11" stroke="#0f172a" stroke-width="0.8" stroke-linecap="round"/>
      <line x1="21" y1="1" x2="21" y2="11" stroke="#0f172a" stroke-width="0.8" stroke-linecap="round"/>
    </svg>
  `
  const openingKeyItems: string[] = []
  if (windowCount > 0) {
    openingKeyItems.push(`
      <span class="legend-item">
        ${openingSwatch}
        <strong>Window</strong>
        <span class="legend-sub">${windowCount} on this page</span>
      </span>
    `)
  }
  if (doorCount > 0) {
    openingKeyItems.push(`
      <span class="legend-item">
        ${openingSwatch}
        <strong>Door</strong>
        <span class="legend-sub">${doorCount} on this page</span>
      </span>
    `)
  }

  const legend = `
    <div class="plan-overview-legend">
      ${legendItems}
      ${openingKeyItems.join('')}
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

/**
 * Categorised assumption groups for the brick export. Mirrors the
 * block side's structure (Materials → Geometry → Openings → Waste →
 * Project-specific) so the deliverable reads consistently across
 * trades.
 */
export type BrickAssumptionCategory =
  | 'materials'
  | 'geometry'
  | 'openings'
  | 'waste'
  | 'project'
export interface BrickAssumptionGroup {
  category: BrickAssumptionCategory
  title: string
  items: string[]
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
  wallHeightSummary: string = '',
  /**
   * True when the project has at least one opening on a brick wall.
   * Used to gate the Openings group — no point telling the reader
   * about opening deductions when there are none.
   */
  hasOpenings: boolean = false,
): BrickAssumptionGroup[] {
  if (!inclusions.assumptions) return []

  const groups: BrickAssumptionGroup[] = []

  // ── Materials ──
  groups.push({
    category: 'materials',
    title: 'Materials',
    items: [
      'All brick dimensions are nominal and include mortar joint.',
    ],
  })

  // ── Geometry ──
  groups.push({
    category: 'geometry',
    title: 'Wall geometry',
    items: [
      wallHeightSummary ||
        `Wall heights are uniform at ${formatNumber(settings.defaultWallHeightMm)}mm for all walls unless otherwise noted.`,
      'Wall lengths are taken from the dimensions shown on the drawings supplied by the client. All dimensions are in millimetres unless otherwise noted.',
    ],
  })

  // ── Openings ──
  // Only when the project actually has any — no point telling the
  // reader about opening deductions on a wall with no openings.
  if (hasOpenings) {
    groups.push({
      category: 'openings',
      title: 'Openings',
      items: [
        'Openings (doors and windows) have been deducted from gross wall areas as indicated on the drawings.',
      ],
    })
  }

  // ── Waste / supply ──
  groups.push({
    category: 'waste',
    title: 'Waste & supply',
    items: ['No waste allowance has been applied. Quantities are net as measured.'],
  })

  // Per-item supply notes are NOT appended here. With 16+ Galintel
  // SKUs configured the assumptions section became dominated by
  // allowance-rate lines. Each supply item is already listed in the
  // Accessories table with its quantity grouped by category.
  void supplyItemNotes

  // ── Project-specific ──
  // User-typed lines from Project details → Notes. Anything not
  // covered by the canned categories above lives here, one bullet
  // per non-empty line so the user can cover ANY scenario.
  const customLines = customNotes
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
  if (customLines.length > 0) {
    groups.push({
      category: 'project',
      title: 'Project-specific notes',
      items: customLines,
    })
  }

  return groups
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
  // Apply per-area m² / head / sill overrides from the export modal.
  // Strategy: for every area with at least one override, compute the
  // auto-tally on that area's wall subset to get the auto value,
  // then apply the override delta (override - auto) to the global
  // rawTally totals. Result: the headline area + head + sill numbers
  // reflect what the user set in the modal, while the per-opening
  // schedule and per-makeup breakdown stay tied to geometry.
  let areaSqMmDelta = 0
  let headLinealMmDelta = 0
  let sillLinealMmDelta = 0
  const perAreaOv = params.perAreaBrickOverrides ?? {}
  if (Object.keys(perAreaOv).length > 0) {
    const areaIdsToProcess = Object.keys(perAreaOv)
    for (const areaId of areaIdsToProcess) {
      const ov = perAreaOv[areaId]
      if (!ov) continue
      const wallsInArea = walls.filter((w) =>
        areaId === '__unassigned__' ? !w.areaId : w.areaId === areaId,
      )
      if (wallsInArea.length === 0) continue
      const wallIds = new Set(wallsInArea.map((w) => w.id))
      const openingsInArea = openings.filter((o) => wallIds.has(o.wallId))
      const areaTally = calculateBrickTally(
        wallsInArea,
        openingsInArea,
        settings,
        makeups,
      )
      const autoSqM = areaTally.totalAreaSqMm / 1_000_000
      const autoHead =
        Object.values(areaTally.headLinealMmByType).reduce(
          (s, v) => s + v,
          0,
        ) / 1000
      const autoSill =
        Object.values(areaTally.sillLinealMmByType).reduce(
          (s, v) => s + v,
          0,
        ) / 1000
      if (typeof ov.sqM === 'number') {
        areaSqMmDelta += (ov.sqM - autoSqM) * 1_000_000
      }
      if (typeof ov.headLinealM === 'number') {
        headLinealMmDelta += (ov.headLinealM - autoHead) * 1000
      }
      if (typeof ov.sillLinealM === 'number') {
        sillLinealMmDelta += (ov.sillLinealM - autoSill) * 1000
      }

      // Per-(area, makeup) drilldown overrides. For each makeup
      // override the user set under this area, compute the auto
      // value on the wall subset restricted to BOTH the area and
      // the makeup, then push the (override - auto) delta into the
      // same global delta accumulators. m² edits only feed the
      // area-total delta when the area-level m² is NOT set
      // (otherwise area-level wins). head/sill always stack —
      // they're per-wall-type by nature and shouldn't get swamped
      // by area-level totals if both happen to be set.
      const byMakeup = ov.byMakeup
      if (byMakeup) {
        for (const [makeupId, mkOv] of Object.entries(byMakeup)) {
          if (!mkOv) continue
          const mkWalls = wallsInArea.filter((w) => w.makeupId === makeupId)
          if (mkWalls.length === 0) continue
          const mkWallIds = new Set(mkWalls.map((w) => w.id))
          const mkOpenings = openingsInArea.filter((o) =>
            mkWallIds.has(o.wallId),
          )
          const mkTally = calculateBrickTally(
            mkWalls,
            mkOpenings,
            settings,
            makeups,
          )
          const mkAutoSqM = mkTally.totalAreaSqMm / 1_000_000
          const mkAutoHead =
            Object.values(mkTally.headLinealMmByType).reduce(
              (s, v) => s + v,
              0,
            ) / 1000
          const mkAutoSill =
            Object.values(mkTally.sillLinealMmByType).reduce(
              (s, v) => s + v,
              0,
            ) / 1000
          if (typeof mkOv.sqM === 'number' && typeof ov.sqM !== 'number') {
            areaSqMmDelta += (mkOv.sqM - mkAutoSqM) * 1_000_000
          }
          if (typeof mkOv.headLinealM === 'number') {
            headLinealMmDelta += (mkOv.headLinealM - mkAutoHead) * 1000
          }
          if (typeof mkOv.sillLinealM === 'number') {
            sillLinealMmDelta += (mkOv.sillLinealM - mkAutoSill) * 1000
          }
        }
      }
    }
  }
  // Apply the cumulative deltas to the by-type maps proportionally to
  // each type's share — so a 5% bump in head lineal m boosts every
  // existing head brick code by 5%, instead of dumping everything onto
  // one code. When no auto value exists (empty by-type map) the
  // delta is dropped on the floor: there's no code to assign it to.
  function scaleMap(
    map: Record<string, number>,
    deltaMm: number,
  ): Record<string, number> {
    if (deltaMm === 0) return map
    const total = Object.values(map).reduce((s, v) => s + v, 0)
    if (total <= 0) return map
    const factor = (total + deltaMm) / total
    const next: Record<string, number> = {}
    for (const [k, v] of Object.entries(map)) {
      next[k] = Math.max(0, v * factor)
    }
    return next
  }

  const tally = {
    ...rawTally,
    bricksByType: adjustedBricksByType,
    brickCount: adjustedBrickCount,
    totalAreaSqMm: Math.max(0, rawTally.totalAreaSqMm + areaSqMmDelta),
    headLinealMmByType: scaleMap(
      rawTally.headLinealMmByType,
      headLinealMmDelta,
    ),
    sillLinealMmByType: scaleMap(
      rawTally.sillLinealMmByType,
      sillLinealMmDelta,
    ),
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
    /** Pre-formatted quantity using the item's decimalPlaces (0 dp = whole
     *  units, 1–3 dp = decimal precision). Display only — `qty` is still
     *  the numeric ceil result for any downstream maths. */
    display: string
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
    // Round at the item's chosen precision (0 dp → whole units, 1–3 dp
    // → 0.1 / 0.01 / 0.001 increments). Same ceil semantics as before
    // — no under-ordering — just at a finer step for consumables.
    const rounded = roundSupplyQuantity(qty, item)
    // Apply the user's per-supply-item adjustment (positive = remove,
    // negative = add) AFTER rounding so the modal's preview number
    // matches the row that lands in the PDF. Clamp to >= 0; skip
    // zero-qty rows. The pre-adjusted `rounded` is intentionally
    // NOT gated to zero — a negative delta promotes a zero-qty item
    // into the schedule.
    const supplyAdj = supplyItemAdjustments?.[item.id] ?? 0
    const finalQty = Math.max(0, rounded - supplyAdj)
    if (finalQty <= 0) continue
    // Apply per-export name override (if the user renamed this item
    // in the export modal). Falls back to the library item's name
    // when no override is set or the override is empty.
    const overriddenName = params.supplyItemNameOverrides?.[item.id]?.trim()
    supplyRows.push({
      name: overriddenName || item.name,
      qty: finalQty,
      display: formatSupplyQuantity(finalQty, item),
      noteRate,
      category: item.category?.trim() || 'Uncategorised',
    })
  }
  const supplyItemNotes = supplyRows.map(
    (r) => `${r.name} allowance at ${r.noteRate} — ${r.display} included.`
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
    wallHeightSummary,
    openings.length > 0,
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
    // Estimator name intentionally omitted — see blockExport.ts.
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

  // Page 0: Cover page — emitted only when the user customised any
  // of the cover fields via the export modal. Mirrors the block
  // exporter's cover (same CSS classes for cross-trade
  // consistency).
  const coverTitle = params.coverOverrides?.title?.trim() ?? ''
  const coverSubtitle = params.coverOverrides?.subtitle?.trim() ?? ''
  const coverIntro = params.coverOverrides?.intro?.trim() ?? ''
  const hasCover = !!(coverTitle || coverSubtitle || coverIntro)
  const coverTitleResolved =
    coverTitle ||
    projectDetails.projectName.trim() ||
    projectDetails.siteAddress.trim() ||
    'Brick Estimate'
  const coverPage = hasCover
    ? `
      <section class="page cover-page">
        ${pageHeader}
        <div class="cover-body">
          <div class="cover-eyebrow">Brick estimate${referenceText ? ` · ${escapeHtml(referenceText)}` : ''}</div>
          <div class="cover-head">
            <div>
              <h1 class="cover-title">${escapeHtml(coverTitleResolved)}</h1>
              ${coverSubtitle ? `<p class="cover-subtitle">${escapeHtml(coverSubtitle)}</p>` : ''}
            </div>
            <dl class="cover-meta">
              ${projectDetails.siteAddress.trim() && projectDetails.siteAddress.trim() !== coverTitleResolved ? `<div><dt>Site</dt><dd>${escapeHtml(projectDetails.siteAddress)}</dd></div>` : ''}
              ${projectDetails.clientName.trim() ? `<div><dt>Client</dt><dd>${escapeHtml(projectDetails.clientName)}</dd></div>` : ''}
              ${projectDetails.date ? `<div><dt>Date</dt><dd>${formatDate(projectDetails.date)}</dd></div>` : ''}
            </dl>
          </div>
          ${coverIntro ? `<div class="cover-intro">${escapeHtml(coverIntro).replace(/\n/g, '<br/>')}</div>` : ''}
        </div>
      </section>
    `
    : ''

  // Page 1: Assumptions — categorised groups with subheadings so
  // the reader can scan to the relevant area (Geometry vs Openings
  // vs Project-specific) rather than reading one long flat list.
  const assumptionsPage = inclusions.assumptions
    ? `
      <section class="page">
        ${pageHeader}
        ${metaBlock}
        <h2 class="section-title">Assumptions</h2>
        ${assumptions
          .map(
            (g) => `
          <div class="assumption-group">
            <h3 class="assumption-group-title">${escapeHtml(g.title)}</h3>
            <ul class="assumption-list">
              ${g.items.map((a) => `<li>${escapeHtml(a)}</li>`).join('')}
            </ul>
          </div>`,
          )
          .join('')}
      </section>
    `
    : ''

  // Page 2: Tables
  const areaSqM = tally.totalAreaSqMm / 1_000_000
  const openingsAreaSqM = openings.reduce((sum, op) => sum + op.widthMm * op.heightMm, 0) / 1_000_000
  const grossAreaSqM = areaSqM + openingsAreaSqM

  // Wastage uplift — when configured, a second column on the area
  // summary shows each row with X% added so the estimator can order
  // bricks against the inflated number. Supply items are not touched.
  const wastagePct =
    typeof params.wastagePercent === 'number' && params.wastagePercent > 0
      ? params.wastagePercent
      : null
  const wastageFactor = wastagePct ? 1 + wastagePct / 100 : 1
  const wastageHeaderCell = wastagePct
    ? `<th class="right">+ ${formatNumber(wastagePct, 1)}% wastage (m²)</th>`
    : ''
  const wastageCell = (v: number, sign: '' | '-' = ''): string =>
    wastagePct
      ? `<td class="right">${sign}${formatNumber(v * wastageFactor, 3)} m²</td>`
      : ''

  const summaryTable = inclusions.brickAreaSummary
    ? `
      <h2 class="section-title">Brick Area Summary</h2>
      <table>
        <thead>
          <tr><th>Description</th><th class="right">Area (m²)</th>${wastageHeaderCell}</tr>
        </thead>
        <tbody>
          <tr><td>Gross Wall Area</td><td class="right">${formatNumber(grossAreaSqM, 3)} m²</td>${wastageCell(grossAreaSqM)}</tr>
          <tr><td>Less Openings</td><td class="right">-${formatNumber(openingsAreaSqM, 3)} m²</td>${wastageCell(openingsAreaSqM, '-')}</tr>
          <tr class="bold"><td>Net Wall Area</td><td class="right">${formatNumber(areaSqM, 3)} m²</td>${wastageCell(areaSqM)}</tr>
        </tbody>
      </table>
    `
    : ''

  // Brick type breakdown — removed in favour of the lineal-metre
  // tables below. The deliverable used to count individual bricks
  // per type; now we surface total wall area and lineal metres for
  // each special course (head / sill / substitute) so the estimator
  // applies their own bricks/m² rate from the brick library.
  const typeBreakdownTable = ''

  // Trim courses + course substitute — all reported in lineal METRES
  // so the bricklayer can price by their own per-metre rates. One
  // table per category, each hidden when its bucket is empty so
  // projects without trim / substitute bricks see no blank sections.
  // Head / sill course tables — summarised to a single total per
  // section. Per-brick-code rows were removed: the brick code that
  // gets used at the head / sill is a 3D-render concern (set in the
  // wall type modal's "Opening visuals" tab) and the estimator
  // doesn't need it in the deliverable. What they need is the
  // lineal-m total they can multiply by their lay rate. Wastage, if
  // configured, adds a second column with the uplifted figure.
  const renderLinealTable = (
    title: string,
    blurb: string,
    totalMm: number,
  ): string => {
    if (totalMm <= 0) return ''
    const metres = (totalMm / 1000).toFixed(2)
    const wastageHeader = wastagePct
      ? `<th class="right" style="width: 160px">+ ${formatNumber(wastagePct, 1)}% wastage</th>`
      : ''
    const wastageRow = wastagePct
      ? `<td class="right">${((totalMm * wastageFactor) / 1000).toFixed(2)} m</td>`
      : ''
    return `
      <h2 class="section-title">${escapeHtml(title)}</h2>
      <p style="margin: 4px 0 8px; color: #555; font-size: 12px;">
        ${blurb}
      </p>
      <table>
        <thead>
          <tr><th></th><th class="right">Lineal m</th>${wastageHeader}</tr>
        </thead>
        <tbody>
          <tr><td>Brickwork</td><td class="right">${metres} m</td>${wastageRow}</tr>
        </tbody>
      </table>
    `
  }
  const headTotalMm = Object.values(tally.headLinealMmByType ?? {}).reduce(
    (s, v) => s + v,
    0,
  )
  const sillTotalMm = Object.values(tally.sillLinealMmByType ?? {}).reduce(
    (s, v) => s + v,
    0,
  )
  // Course substitute section removed — the per-course lineal m
  // value was confusing on walls with mixed brick heights (e.g. a
  // double-height substitute would surface a count that didn't
  // match wall coursing intuition). The simpler "Total length" tile
  // on the assumptions summary now carries the total-walls-lineal-m
  // figure, which is what the estimator actually wanted.
  const trimTable =
    renderLinealTable(
      'Head courses',
      `Lineal metres of head course above every opening (doors and
       windows). Span is opening width plus bearing overhang at each
       end. Multiply by your per-metre lay rate.`,
      headTotalMm,
    ) +
    renderLinealTable(
      'Sill courses',
      `Lineal metres of sill course under every window. Doors are
       excluded (no sill course). Multiply by your per-metre lay rate.`,
      sillTotalMm,
    )

  // Per-wall-type breakdown — mirrors the headline aggregates (area,
  // run, head, sill) one wall type at a time so the estimator can
  // price each makeup separately. Net area = gross area minus any
  // openings landing on walls of this type, same calc the headline
  // uses. Head/sill totals come from the per-makeup maps the calc
  // produces alongside the per-brick-code ones (the calc tracks
  // both so this table doesn't have to re-walk openings).
  //
  // Walls without a makeup pool under "No wall type" so they're not
  // hidden from the breakdown. Wall types with zero area (created
  // but never drawn on) are dropped so the table only lists types
  // actually contributing brickwork.
  type MakeupRow = {
    makeupId: string
    label: string
    wallCount: number
    totalLinealMm: number
    netAreaSqMm: number
    headLinealMm: number
    sillLinealMm: number
  }
  const makeupRows: MakeupRow[] = Object.values(tally.byMakeup ?? {})
    .filter((b) => b.grossAreaSqMm > 0 || b.netAreaSqMm > 0)
    .map((b) => {
      const makeup =
        b.makeupId === '__none__'
          ? null
          : makeups.find((m) => m.id === b.makeupId) ?? null
      return {
        makeupId: b.makeupId,
        label: makeup?.name ?? 'No wall type',
        wallCount: b.wallCount,
        totalLinealMm: b.totalLinealMm,
        netAreaSqMm: b.netAreaSqMm,
        headLinealMm: tally.headLinealMmByMakeup?.[b.makeupId] ?? 0,
        sillLinealMm: tally.sillLinealMmByMakeup?.[b.makeupId] ?? 0,
      }
    })
    .sort((a, b) => b.netAreaSqMm - a.netAreaSqMm)

  // Wastage uplift on the consumable totals (Area, Head, Sill) — wall
  // count and Length stay on the net figure because those are the
  // physical wall geometry, they don't change with wastage. Helper
  // formats each m / m² figure with its wastage twin in the same
  // cell so the table stays at 6 columns regardless of wastage state.
  const fmtWithWaste = (
    valueMm: number,
    unit: 'm' | 'm²',
    divisor: number,
  ): string => {
    const net = valueMm > 0 ? formatNumber(valueMm / divisor, 2) : '—'
    if (!wastagePct || valueMm <= 0) return net
    const uplift = formatNumber((valueMm * wastageFactor) / divisor, 2)
    return `${net} <span style="color:#9a3f08;font-weight:600">(+${uplift} ${unit})</span>`
  }

  const totalHeadMm = makeupRows.reduce((s, r) => s + r.headLinealMm, 0)
  const totalSillMm = makeupRows.reduce((s, r) => s + r.sillLinealMm, 0)

  const makeupBreakdownTable = makeupRows.length > 0
    ? `
      <h2 class="section-title">Brickwork by Wall Type</h2>
      <p style="margin: 4px 0 8px; color: #555; font-size: 12px;">
        Per wall type: total brickwork area (after opening deductions),
        wall lineal length, and the head &amp; sill course metres the
        type contributes. Multiply each by the bricklayer's per-metre
        or per-m² rate to price each type independently.${
          wastagePct
            ? ` Each Area / Head / Sill cell shows the net figure with the wastage-uplifted figure beside it in parentheses.`
            : ''
        }
      </p>
      <table>
        <thead>
          <tr>
            <th>Wall type</th>
            <th class="right" style="width: 70px">Walls</th>
            <th class="right" style="width: 100px">Length (m)</th>
            <th class="right" style="width: ${wastagePct ? '160px' : '100px'}">Area (m²)</th>
            <th class="right" style="width: ${wastagePct ? '140px' : '90px'}">Head (m)</th>
            <th class="right" style="width: ${wastagePct ? '140px' : '90px'}">Sill (m)</th>
          </tr>
        </thead>
        <tbody>
          ${makeupRows
            .map((r) => {
              return `<tr>
                <td>${escapeHtml(r.label)}</td>
                <td class="right">${r.wallCount}</td>
                <td class="right">${formatNumber(r.totalLinealMm / 1000, 2)}</td>
                <td class="right">${fmtWithWaste(r.netAreaSqMm, 'm²', 1_000_000)}</td>
                <td class="right">${fmtWithWaste(r.headLinealMm, 'm', 1000)}</td>
                <td class="right">${fmtWithWaste(r.sillLinealMm, 'm', 1000)}</td>
              </tr>`
            })
            .join('')}
          <tr class="bold">
            <td>Total</td>
            <td class="right">${tally.wallCount}</td>
            <td class="right">${formatNumber(tally.totalLinealMm / 1000, 2)}</td>
            <td class="right">${fmtWithWaste(tally.totalAreaSqMm, 'm²', 1_000_000)}</td>
            <td class="right">${fmtWithWaste(totalHeadMm, 'm', 1000)}</td>
            <td class="right">${fmtWithWaste(totalSillMm, 'm', 1000)}</td>
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
            `<tr><td>${escapeHtml(r.name)}</td><td class="right">${r.display}</td></tr>`
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
        <!-- Footer Reference/Client/Date row removed — same info
             already sits at the top of the page meta block, and the
             reclaimed vertical space goes to the hero image. -->
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
  ${coverPage}
  ${assumptionsPage}
  ${/* 3D snapshots come FIRST after the assumptions pages so the
       reader sees the project in 3D as soon as they've finished
       the cover/assumptions reading. The 2D plan overview then
       follows for the plan-on-plan layout details, with the tally
       tables landing at the back. */ ''}
  ${view3dPages}
  ${planOverviewPages}
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
    /* Tighter base font for a denser layout — see blockExport for
       the same rationale. */
    font-size: 11px;
    line-height: 1.4;
  }
  .page {
    padding: 24px 32px;
    page-break-after: always;
    min-height: 100vh;
  }
  .page:last-child { page-break-after: auto; }

  /* Wall Layout overview pages — mirrored from the block export styles
     so brick and block exports look like siblings rather than cousins. */
  .plan-overview-page h2.section-title { margin: 12px 0 4px; }
  .plan-overview-page .page-intro { margin-bottom: 6px; }
  /* Force wall-layout page to print as a single sheet — see
     blockExport.ts for the same rule. */
  .plan-overview-page {
    page-break-inside: avoid;
    break-inside: avoid;
    page-break-after: always;
    break-after: page;
  }
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
    font-size: 13px;
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
    /* Sized to fit the whole wall-layout page on one sheet of
       landscape A4 (stats + diagram + legend). See blockExport
       for the per-chrome budget. */
    height: 120mm;
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
  .legend-opening-swatch {
    display: inline-block;
    width: 22px;
    height: 11px;
    vertical-align: middle;
  }
  .legend-note { color: #9ca3af; font-style: italic; }

  .page-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    border-bottom: 1.5px solid #1f2937;
    padding-bottom: 8px;
    margin-bottom: 16px;
  }
  .brand-name {
    color: #C5530A;
    font-weight: 700;
    font-size: 22px;
    line-height: 1;
  }
  .brand-tag {
    color: #ED7D31;
    font-style: italic;
    font-size: 10px;
    margin-top: 2px;
  }
  .brand-address {
    color: #4B5563;
    font-size: 10px;
    margin-top: 3px;
    line-height: 1.4;
  }
  .brand-logo {
    max-height: 46px;
    max-width: 150px;
    display: block;
    margin-bottom: 4px;
  }

  /* Cover page — A4 landscape layout, same as the block exporter so
     a combined deliverable reads as one document. See
     blockExport.ts for the design notes. */
  .cover-page .cover-body {
    padding: 28px 12px 0 12px;
    max-width: 100%;
  }
  .cover-eyebrow {
    text-transform: uppercase;
    letter-spacing: 0.14em;
    font-size: 10px;
    color: #6B7280;
    font-weight: 600;
    margin-bottom: 14px;
  }
  .cover-head {
    display: grid;
    grid-template-columns: 3fr 2fr;
    column-gap: 36px;
    align-items: start;
    padding-bottom: 20px;
    border-bottom: 1px solid #E5E7EB;
  }
  .cover-title {
    font-size: 44px;
    font-weight: 800;
    letter-spacing: -0.01em;
    line-height: 1.1;
    color: #111827;
    margin: 0 0 6px 0;
  }
  .cover-subtitle {
    font-size: 15px;
    color: #4B5563;
    margin: 8px 0 0 0;
    line-height: 1.45;
    max-width: 540px;
  }
  .cover-meta {
    display: grid;
    grid-template-columns: 1fr;
    row-gap: 10px;
    margin: 4px 0 0 0;
    padding: 0 0 0 24px;
    border-left: 1px solid #E5E7EB;
  }
  .cover-meta dt {
    text-transform: uppercase;
    letter-spacing: 0.1em;
    font-size: 9px;
    color: #6B7280;
    margin-bottom: 2px;
  }
  .cover-meta dd {
    font-size: 12px;
    color: #1F2937;
    font-weight: 500;
    margin: 0;
  }
  .cover-intro {
    font-size: 12px;
    color: #374151;
    line-height: 1.6;
    margin-top: 24px;
    max-width: 100%;
    white-space: pre-wrap;
  }

  /* Primary brand mark — used when no text name accompanies the logo. */
  .brand-logo-primary {
    max-height: 64px;
    max-width: 230px;
    display: block;
    margin-bottom: 4px;
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
    page-break-after: always;
    break-after: page;
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
    font-size: 20px;
    font-weight: 700;
    color: #0f172a;
    letter-spacing: -0.02em;
    line-height: 1.1;
  }
  .view3d-subtitle {
    font-size: 10px;
    color: #475569;
    font-weight: 400;
  }
  .view3d-body {
    display: flex;
    align-items: stretch;
    gap: 5mm;
    /* Hero shot height — reduced from 140mm to 125mm so the page
       header + view3d-header stay on the same page as the image
       even when the title block runs over its expected 28mm. See
       blockExport.ts for the full chrome budget. */
    height: 125mm;
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
    max-height: 125mm;
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
    font-size: 15px;
    font-weight: 700;
  }
  .title-sub {
    font-size: 10px;
    color: #6b7280;
    margin-top: 2px;
  }

  .meta {
    display: flex;
    gap: 20px;
    font-size: 10px;
    color: #4b5563;
    margin-bottom: 14px;
  }
  .meta span {
    color: #9ca3af;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-size: 9px;
    margin-right: 4px;
  }

  h2 {
    font-size: 13px;
    margin: 16px 0 8px;
    color: #1f2937;
  }

  ol.assumptions {
    padding-left: 20px;
    margin: 0;
  }
  ol.assumptions li {
    padding: 3px 0;
    font-size: 10.5px;
    line-height: 1.45;
  }
  /* Categorised assumption groups — same structure as the block
     export so the trade-combined PDF reads consistently. */
  .assumption-group {
    page-break-inside: avoid;
    break-inside: avoid;
    margin-top: 10px;
  }
  .assumption-group:first-of-type { margin-top: 0; }
  .assumption-group-title {
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: #1f2937;
    margin: 0 0 4px 0;
    padding-bottom: 2px;
    border-bottom: 1px solid #e5e7eb;
  }
  ul.assumption-list {
    list-style: disc;
    padding-left: 18px;
    margin: 0;
  }
  ul.assumption-list li {
    padding: 1.5px 0;
    font-size: 10.5px;
    line-height: 1.4;
    color: #374151;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    margin-bottom: 12px;
    font-size: 10.5px;
  }
  th, td {
    padding: 5px 9px;
    border-bottom: 1px solid #e5e7eb;
    text-align: left;
  }
  thead th {
    background: #f3f4f6;
    font-weight: 600;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    color: #4b5563;
  }
  .right { text-align: right; }
  tr.bold td { font-weight: 700; background: #fafafa; }

  .disclaimer {
    background: #fef9c3;
    border-left: 3px solid #ca8a04;
    padding: 12px 16px;
    border-radius: 4px;
  }
  .disclaimer-title {
    color: #854d0e;
    font-weight: 700;
    margin-bottom: 6px;
    font-size: 11.5px;
  }
  .disclaimer p {
    margin: 0 0 6px 0;
    font-size: 10px;
    line-height: 1.45;
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
