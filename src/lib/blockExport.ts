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
  curveZoneForRadius,
  wallLengthMm,
} from './blockCalc'
import { arcFromThreePoints, isCurvedWall, sampleArc } from './curveGeom'
import { rasterisePdfPage } from './pdfRaster'
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
  /**
   * Optional reference to the loaded PDF. When provided together with
   * `pagesInfo`, each page's plan is rasterised as the SVG background for
   * its Wall Layout overview so the reader sees the building plan with
   * walls drawn over it. Without the PDF the layout still renders, just
   * without the background image.
   */
  pdfFile?: File
  /**
   * One entry per PDF page that has any walls / openings / piers worth
   * showing on its own Wall Layout overview page. The export emits one
   * "Wall Layout — Page N" section per entry in this array, in order.
   *
   * Multi-floor projects need this — the current PDF page is no longer
   * enough info, because the export's Wall Layout section runs across
   * every drawn floor. When the array has just one entry, the export
   * behaves the same as the old single-page flow.
   */
  pagesInfo?: PageInfo[]
}

/**
 * Per-PDF-page metadata + the walls / openings / piers that belong to
 * that page. The export uses these to build one Wall Layout section per
 * page; the tally tables still come off the flat `walls` / `openings` /
 * `piers` arrays in the params so totals are project-wide.
 */
export interface PageInfo {
  pageNumber: number
  pageWidthMm?: number
  pageHeightMm?: number
  pageScaleRatio?: number
  walls: Wall[]
  openings: Opening[]
  piers: Pier[]
  /** Optional human label, e.g. "Ground Floor". Falls back to "Page N". */
  label?: string
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

/**
 * Build the Wall Layout page — an SVG diagram of every wall, pier and
 * curved arc as drawn on the plan, with each wall labelled 1..N so the
 * tally tables further down the document can be cross-referenced visually.
 *
 * The SVG uses millimetre coordinates as its viewBox so we can place
 * shapes directly from the wall data. The print stylesheet sizes the SVG
 * to fill a landscape A4 content area with `preserveAspectRatio='xMidYMid
 * meet'`, so plans of any aspect ratio fit cleanly without distortion.
 *
 * Walls: orange thick lines (straight) or polylines (curves, sampled from
 *        arcFromThreePoints to avoid SVG arc-flag pitfalls). Stroke width
 *        equals the wall's real-world thickness.
 * Piers: blue 400 × 400 squares centred on the pier position.
 * Labels: white-on-orange numbered circles at each wall's midpoint.
 *
 * Returns an empty string when there are no walls — no point in a blank
 * overview page.
 */
/**
 * Render one page of a PDF to a base64 PNG data URL using PDF.js, plus
 * return the page's intrinsic mm dimensions. Used by the Wall Layout page
 * to embed the plan as the SVG's background so walls overlay the drawing.
 *
 * Failures (corrupt file, page not found, render error) resolve to null so
 * the export can fall back to the bare diagram without crashing.
 */
// rasterisePdfPage now lives in lib/pdfRaster.ts so the brick export can
// share it. The signature + behaviour are unchanged.

/**
 * Palette of (stroke, dark) colour pairs used to differentiate wall types on
 * the layout diagram. Each pair is a medium colour (used at 55 % opacity for
 * the wall body stroke) and a darker version (used as the solid fill of the
 * numbered label circle, so the white number reads cleanly inside).
 *
 * Colour choice is colour-blind-friendly-ish and prints well in landscape A4.
 * First slot stays the brand orange so plans with a single wall type look
 * unchanged from the previous version of the diagram.
 */
const WALL_TYPE_PALETTE: Array<{ body: string; dark: string }> = [
  { body: '#ED7D31', dark: '#9A3F08' }, // brand orange
  { body: '#2563eb', dark: '#1e3a8a' }, // blue
  { body: '#16a34a', dark: '#14532d' }, // green
  { body: '#7c3aed', dark: '#4c1d95' }, // purple
  { body: '#db2777', dark: '#831843' }, // pink
  { body: '#0891b2', dark: '#164e63' }, // teal
  { body: '#ca8a04', dark: '#713f12' }, // amber
  { body: '#dc2626', dark: '#7f1d1d' }, // red
]

function buildPlanOverviewPage(
  walls: Wall[],
  openings: Opening[],
  piers: Pier[],
  makeups: WallMakeup[],
  makeupsById: Record<string, WallMakeup>,
  thicknessByWallId: Record<string, number>,
  totalBlocks: number,
  pageHeader: string,
  background: { dataUrl: string; pageWidthMm: number; pageHeightMm: number; pageScaleRatio: number } | null = null,
  /** Suffix on the section heading + intro, e.g. ' — Ground Floor' or ' — Page 9'.
   *  Empty string keeps the original "Wall Layout" heading for single-page exports. */
  pageLabelSuffix: string = ''
): string {
  if (walls.length === 0) return ''

  // Assign each wall type a colour from the palette. Order follows the order
  // makeups were added to the project so the assignment is stable across
  // exports — the bricklayer doesn't see the colour for "Retaining" change
  // between two builds of the same project.
  const colourByMakeupId: Record<string, { body: string; dark: string }> = {}
  // Only consider makeups that actually have walls in this project, in the
  // order they first appear in the walls array. Then fall through to any
  // remaining makeups (e.g. defined but unused) so the legend stays stable.
  const orderedMakeups: WallMakeup[] = []
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
    colourByMakeupId[orderedMakeups[i].id] = WALL_TYPE_PALETTE[i % WALL_TYPE_PALETTE.length]
  }
  // Fallback for any wall whose makeup id isn't in makeupsById (shouldn't
  // happen but defensively keep the diagram from crashing).
  const fallbackColour = WALL_TYPE_PALETTE[0]
  const colourFor = (wall: Wall) => colourByMakeupId[wall.makeupId] ?? fallbackColour

  // Compute the at-a-glance summary stats shown above the diagram. These
  // give the reader a sense of project size before they look at the
  // numbered breakdown — walls × total length × wall area × counts.
  const wallLengthsMm = walls.map((w) => {
    if (isCurvedWall(w) && w.midX !== undefined && w.midY !== undefined) {
      const geom = arcFromThreePoints(
        { x: w.startX, y: w.startY },
        { x: w.midX, y: w.midY },
        { x: w.endX, y: w.endY }
      )
      if (geom) return geom.arcLengthMm
    }
    const dx = w.endX - w.startX
    const dy = w.endY - w.startY
    return Math.sqrt(dx * dx + dy * dy)
  })
  const totalWallLengthMm = wallLengthsMm.reduce((s, l) => s + l, 0)
  const totalWallAreaSqMm = walls.reduce((sum, w, i) => {
    const makeup = makeupsById[w.makeupId]
    const heightMm = w.heightMmOverride ?? makeup?.heightMm ?? 0
    return sum + wallLengthsMm[i] * heightMm
  }, 0)
  const openingsAreaSqMm = openings.reduce((s, o) => s + o.widthMm * o.heightMm, 0)
  const netWallAreaSqMm = Math.max(0, totalWallAreaSqMm - openingsAreaSqMm)
  const tiedPierCount = piers.filter((p) => p.type === 'tied').length
  const freestandingPierCount = piers.filter((p) => p.type === 'freestanding').length
  const wallTypeCount = new Set(walls.map((w) => w.makeupId)).size

  // Stat tiles are tuned for what a bricklayer / supplier looking at the
  // overview actually needs: count, run, area, total blocks, plus the
  // accessory counts (openings, piers) when they're non-zero. Per-wall
  // extremes like "longest" / "tallest" don't drive ordering decisions
  // so they're left out.
  const summaryTiles: Array<{ label: string; value: string; sub?: string }> = [
    {
      label: 'Walls',
      value: String(walls.length),
      sub: `${wallTypeCount} wall type${wallTypeCount === 1 ? '' : 's'}`,
    },
    { label: 'Total length', value: `${(totalWallLengthMm / 1000).toFixed(2)} m` },
    {
      label: 'Wall area',
      value: `${(netWallAreaSqMm / 1_000_000).toFixed(2)} m²`,
      sub: openings.length > 0 ? `net of openings` : 'gross area',
    },
    {
      label: 'Total blocks',
      value: formatNumber(totalBlocks),
    },
  ]
  if (openings.length > 0) {
    summaryTiles.push({
      label: 'Openings',
      value: String(openings.length),
      sub: `${(openingsAreaSqMm / 1_000_000).toFixed(2)} m² deducted`,
    })
  }
  if (piers.length > 0) {
    summaryTiles.push({
      label: 'Piers',
      value: String(piers.length),
      sub: `${tiedPierCount} tied · ${freestandingPierCount} freestanding`,
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

  // Bounding box of everything we're about to draw (walls + curve midpoints +
  // freestanding pier positions), so the SVG viewBox covers the whole plan.
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  const expand = (x: number, y: number) => {
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  for (const w of walls) {
    expand(w.startX, w.startY)
    expand(w.endX, w.endY)
    if (isCurvedWall(w) && w.midX !== undefined && w.midY !== undefined) {
      // The arc bulges past the chord — sample a few points to capture the
      // extent. Sampling is cheap and covers any arc geometry correctly.
      const geom = arcFromThreePoints(
        { x: w.startX, y: w.startY },
        { x: w.midX, y: w.midY },
        { x: w.endX, y: w.endY }
      )
      if (geom) {
        for (const p of sampleArc(geom, 12)) expand(p.x, p.y)
      } else {
        expand(w.midX, w.midY)
      }
    }
  }
  for (const p of piers) {
    if (p.type === 'freestanding') expand(p.x, p.y)
  }
  if (!isFinite(minX) || !isFinite(maxX)) return ''

  // Pad by a generous amount so the walls have breathing room AND a bit
  // of surrounding plan context (when a PDF is shown behind). The amount
  // scales with the plan's extent — a tiny gazebo gets a 1 m pad, a
  // multi-storey commercial layout gets several metres.
  const maxThick = Math.max(
    190,
    ...Object.values(thicknessByWallId).filter((v) => v > 0)
  )
  const pad = Math.max(
    1000,
    maxThick * 4,
    (maxX - minX) * 0.1,
    (maxY - minY) * 0.1
  )

  // viewBox crops to the walls' bounding box + padding REGARDLESS of
  // whether we have a background image. With a background, the
  // rasterised page is placed at the page origin (0, 0) covering its
  // full real-world extent — the SVG just shows the cropped slice. This
  // means the reader gets a zoomed-in view of the walls with the relevant
  // bit of plan around them, instead of a full A4 page with the walls
  // crammed in one corner. When there's a background, we also clamp the
  // viewBox to the page bounds so we never expose empty SVG space past
  // the edge of the page.
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

  // Numbered wall labels — size scales with the larger of plan-extent and
  // wall thickness. Tuned for "readable but not obscuring the walls" on
  // plans with many wall types: at a typical residential 190 mm block
  // wall and a 10 m bounding box the labels print at about 4 mm tall on
  // landscape A4, which sits comfortably without blocking the plan and
  // leaves room for adjacent labels even in dense junctions.
  const labelDiameter = Math.max(maxThick * 2.8, Math.min(viewW, viewH) * 0.045)
  const labelFontSize = labelDiameter * 0.55

  // Wall bodies — semi-transparent fill keyed off the wall's makeup colour
  // (see WALL_TYPE_PALETTE / colourByMakeupId above). We render walls as a
  // STROKE on a line/polyline with stroke-width equal to the thickness,
  // which is simpler than computing per-corner mitres and is accurate
  // enough for an at-a-glance overview. stroke-opacity 0.55 lets the
  // dashed plan beneath show through a touch where walls overlap, which
  // helps disambiguate cavity/double walls drawn close together.
  const wallShapes: string[] = []
  for (const w of walls) {
    const thickness = thicknessByWallId[w.id] || 190
    const c = colourFor(w)
    if (isCurvedWall(w) && w.midX !== undefined && w.midY !== undefined) {
      const geom = arcFromThreePoints(
        { x: w.startX, y: w.startY },
        { x: w.midX, y: w.midY },
        { x: w.endX, y: w.endY }
      )
      if (!geom) {
        wallShapes.push(
          `<line x1="${w.startX}" y1="${w.startY}" x2="${w.endX}" y2="${w.endY}" stroke="${c.body}" stroke-opacity="0.55" stroke-width="${thickness}" stroke-linecap="butt"/>`
        )
        continue
      }
      // Sample the arc into a polyline — sidesteps SVG arc flag bugs and
      // matches exactly what's rendered in the live canvas (which uses the
      // same sampleArc helper).
      const samples = sampleArc(geom, 48)
      const pts = samples.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')
      wallShapes.push(
        `<polyline points="${pts}" stroke="${c.body}" stroke-opacity="0.55" stroke-width="${thickness}" fill="none" stroke-linecap="butt" stroke-linejoin="round"/>`
      )
    } else {
      wallShapes.push(
        `<line x1="${w.startX}" y1="${w.startY}" x2="${w.endX}" y2="${w.endY}" stroke="${c.body}" stroke-opacity="0.55" stroke-width="${thickness}" stroke-linecap="butt"/>`
      )
    }
  }

  // Pier squares — 400 × 400 mm centred on the pier position. For tied piers
  // we resolve the (along-wall mm) into an x/y from the host wall's geometry.
  const pierShapes: string[] = []
  for (const p of piers) {
    let cx: number
    let cy: number
    if (p.type === 'freestanding') {
      cx = p.x
      cy = p.y
    } else {
      const wall = walls.find((w) => w.id === p.wallId)
      if (!wall) continue
      const dx = wall.endX - wall.startX
      const dy = wall.endY - wall.startY
      const len = Math.sqrt(dx * dx + dy * dy)
      if (len === 0) continue
      const t = p.alongMm / len
      cx = wall.startX + t * dx
      cy = wall.startY + t * dy
    }
    const s = 400
    pierShapes.push(
      `<rect x="${cx - s / 2}" y="${cy - s / 2}" width="${s}" height="${s}" fill="#3b82f6" stroke="#1e40af" stroke-width="${maxThick * 0.1}"/>`
    )
  }

  // Numbered labels at each wall's midpoint with the wall length as a
  // secondary text below the circle. White-on-orange circle for the number
  // so it reads on top of the wall fill; the length text is white with a
  // dark stroke (paint-order: stroke) so it's legible whether it falls on
  // the wall body or in the gap.
  const lengthFontSize = labelFontSize * 0.85
  const wallLabels: string[] = walls.map((w, i) => {
    let cx: number
    let cy: number
    if (isCurvedWall(w) && w.midX !== undefined && w.midY !== undefined) {
      cx = w.midX
      cy = w.midY
    } else {
      cx = (w.startX + w.endX) / 2
      cy = (w.startY + w.endY) / 2
    }
    const lengthM = (wallLengthsMm[i] / 1000).toFixed(2)
    const lengthOffsetY = labelDiameter * 0.7 + lengthFontSize * 0.6
    // Circle fill matches the wall type's "dark" colour so the number sits
    // visually on top of a deeper version of the wall colour beside it.
    const c = colourFor(w)
    return `
      <circle cx="${cx}" cy="${cy}" r="${labelDiameter / 2}" fill="${c.dark}" stroke="#fff" stroke-width="${labelDiameter * 0.06}"/>
      <text x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="central" font-family="Inter, system-ui, sans-serif" font-size="${labelFontSize}" font-weight="700" fill="#fff">${i + 1}</text>
      <text x="${cx}" y="${cy + lengthOffsetY}" text-anchor="middle" dominant-baseline="central" font-family="Inter, system-ui, sans-serif" font-size="${lengthFontSize}" font-weight="600" fill="#1f2937" stroke="#fff" stroke-width="${lengthFontSize * 0.18}" paint-order="stroke">${lengthM} m</text>
    `
  })

  // Inline legend — one row per wall type used on the project, each with
  // its colour swatch and the count + total length of walls in that type.
  // Piers (if any) get their own line at the end. Lets the reader map a
  // colour they see on the diagram back to a named wall type instantly.
  const wallTypeLegendItems = orderedMakeups
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
      ${wallTypeLegendItems}
      ${piers.length > 0 ? `<span class="legend-item"><span class="legend-swatch legend-pier"></span><strong>Pier</strong></span>` : ''}
      <span class="legend-item legend-note">Shapes drawn at real-world thickness; plan scaled to fit page.</span>
    </div>
  `

  // Background <image> — only when we have a rasterised PDF. Sits at the
  // page origin (0, 0) covering the full page real-world extent. Walls
  // (which are positioned in the same coordinate system) overlay it
  // perfectly. preserveAspectRatio="none" on the image so the data URL
  // stretches edge-to-edge regardless of the source PNG's pixel ratio.
  const backgroundSvgElement = background
    ? `<image href="${background.dataUrl}" x="0" y="0" width="${(background.pageWidthMm * background.pageScaleRatio).toFixed(0)}" height="${(background.pageHeightMm * background.pageScaleRatio).toFixed(0)}" preserveAspectRatio="none" opacity="0.85"/>`
    : ''

  const intro = background
    ? 'The plan with the drawn walls and piers overlaid in colour. Numbered labels match the wall references in the breakdown tables.'
    : 'Diagram of every wall as drawn on the plan with overall sizing. Numbered labels match the wall references in the breakdown tables.'

  return `
    <section class="page plan-overview-page">
      ${pageHeader}
      <h2 class="section-title">Wall Layout${escapeHtml(pageLabelSuffix)}</h2>
      <p class="page-intro">${intro}</p>
      ${summaryRow}
      <div class="plan-overview-wrap">
        <svg viewBox="${viewMinX.toFixed(0)} ${viewMinY.toFixed(0)} ${viewW.toFixed(0)} ${viewH.toFixed(0)}" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid meet">
          ${backgroundSvgElement}
          ${wallShapes.join('\n          ')}
          ${pierShapes.join('\n          ')}
          ${wallLabels.join('\n          ')}
        </svg>
      </div>
      ${legend}
    </section>
  `
}

/**
 * Build the "Wall Specifications" section — one card per wall makeup
 * listing its bond + height, block composition, any course-series ranges,
 * course overrides, and how many walls use it / their total length. Sits
 * between the Assumptions page and the Wall Layout overview pages so the
 * reader can flick to a wall reference number on the layout and find what
 * went into that wall type.
 *
 * Returns the full <section class="page"> wrapper — or '' if no wall types
 * are in use, in which case the doc assembly silently skips the section.
 */
function buildWallSpecsPage(
  makeups: WallMakeup[],
  walls: Wall[],
  thicknessByWallId: Record<string, number>,
  wallsById: Record<string, Wall>,
  pageHeader: string
): string {
  // Only document makeups that are actually used on the project. A library
  // of stale makeups left over from earlier iterations of the same project
  // would otherwise clutter the spec sheet.
  const used = makeups
    .map((m) => {
      const wallsOfMakeup = walls.filter((w) => w.makeupId === m.id)
      const totalLenMm = wallsOfMakeup.reduce(
        (s, w) => s + wallLengthMm(w, thicknessByWallId, wallsById),
        0
      )
      return { makeup: m, walls: wallsOfMakeup, totalLenMm }
    })
    .filter((row) => row.walls.length > 0)

  if (used.length === 0) return ''

  // Each card is a self-contained spec block. Compact key/value grid + an
  // optional 'Course series ranges' table + an optional 'Course overrides'
  // table. break-inside: avoid keeps a card whole when it would otherwise
  // straddle a page edge.
  const cards = used
    .map(({ makeup, walls: wallsOfMakeup, totalLenMm }) => {
      const cornerLabel =
        makeup.cornerBlockCode === '20.21'
          ? `${makeup.cornerBlockCode} (knockout)`
          : makeup.cornerBlockCode
      const baseLabel = makeup.baseCourseTileCode
        ? `${makeup.baseCourseBlockCode} + ${makeup.baseCourseTileCode}`
        : makeup.baseCourseBlockCode

      // Key/value rows for the always-on fields. Pier type is only shown
      // when the makeup actually opted into piers.
      const specRows: Array<[string, string]> = [
        ['Bond', `${makeup.bondType} bond`],
        ['Height', `${formatNumber(makeup.heightMm)} mm`],
        ['Base course', baseLabel],
        ['Body block', makeup.bodyBlockCode],
        ['Top course', makeup.topCourseBlockCode],
        ['Corner', cornerLabel],
        ['Fractions', makeup.useFractions ? 'On (20.02 / 20.22)' : 'Off'],
      ]
      if (makeup.pierType) {
        specRows.push(['Piers', `${makeup.pierType} piers`])
      }

      const specGrid = specRows
        .map(
          ([k, v]) => `
        <div class="spec-row">
          <span class="spec-key">${escapeHtml(k)}</span>
          <span class="spec-val">${escapeHtml(v)}</span>
        </div>`
        )
        .join('')

      // Course-series ranges — only render the block when the makeup has
      // any. Each range's overrides are shown as code-list pairs; fields
      // left on default are omitted to keep the table tight.
      let rangesBlock = ''
      if (makeup.courseSeriesRanges && makeup.courseSeriesRanges.length > 0) {
        const rangeRows = makeup.courseSeriesRanges
          .map((r) => {
            const parts: string[] = []
            if (r.bodyBlockCode) parts.push(`body ${r.bodyBlockCode}`)
            if (r.cornerBlockCode) parts.push(`corner ${r.cornerBlockCode}`)
            if (r.halfBlockCode) parts.push(`half ${r.halfBlockCode}`)
            if (r.baseCourseBlockCode) parts.push(`base ${r.baseCourseBlockCode}`)
            if (r.baseCourseTileCode) parts.push(`tile ${r.baseCourseTileCode}`)
            if (r.heightMakeup71BlockCode) parts.push(`90mm makeup ${r.heightMakeup71BlockCode}`)
            if (r.cornerLeadInBlockCode) {
              const count = r.cornerLeadInCount ?? 2
              parts.push(`corner lead-in ${count}× ${r.cornerLeadInBlockCode}`)
            }
            const rangeLabel =
              r.toCourse > r.fromCourse
                ? `Courses ${r.fromCourse}–${r.toCourse}`
                : `Course ${r.fromCourse}`
            return `
            <tr>
              <td class="range-courses">${escapeHtml(rangeLabel)}</td>
              <td class="range-detail">${escapeHtml(parts.join(' · ')) || '—'}</td>
            </tr>`
          })
          .join('')
        rangesBlock = `
          <div class="spec-subsection">
            <div class="spec-sub-title">Course series ranges</div>
            <table class="spec-sub-table">
              <tbody>${rangeRows}</tbody>
            </table>
          </div>`
      }

      // Per-course explicit overrides (e.g. an intermediate bond beam) —
      // separate from series ranges because they target a single course
      // by number rather than swapping a whole block series.
      let overridesBlock = ''
      if (makeup.courseOverrides && makeup.courseOverrides.length > 0) {
        const overrideRows = makeup.courseOverrides
          .map(
            (o) => `
          <tr>
            <td class="range-courses">Course ${o.courseNumber}</td>
            <td class="range-detail">body ${escapeHtml(o.blockCode)}</td>
          </tr>`
          )
          .join('')
        overridesBlock = `
          <div class="spec-subsection">
            <div class="spec-sub-title">Course overrides</div>
            <table class="spec-sub-table">
              <tbody>${overrideRows}</tbody>
            </table>
          </div>`
      }

      const wallCountLabel = `${wallsOfMakeup.length} wall${wallsOfMakeup.length === 1 ? '' : 's'}`
      const totalLenLabel = `${(totalLenMm / 1000).toFixed(2)} m run`

      return `
        <div class="wall-spec-card">
          <div class="wall-spec-header">
            <h3 class="wall-spec-name">${escapeHtml(makeup.name)}</h3>
            <span class="wall-spec-meta">${escapeHtml(wallCountLabel)} · ${escapeHtml(totalLenLabel)}</span>
          </div>
          <div class="spec-grid">
            ${specGrid}
          </div>
          ${rangesBlock}
          ${overridesBlock}
        </div>`
    })
    .join('')

  return `
    <section class="page">
      ${pageHeader}
      <h2 class="section-title">Wall Specifications</h2>
      <p class="page-intro">
        Block composition for every wall type used on the job — cross-reference
        with the numbered labels on the Wall Layout pages and the per-makeup
        tables in the breakdown.
      </p>
      ${cards}
    </section>
  `
}

function buildAssumptions(
  inclusions: BlockExportInclusions,
  hasOpenings: boolean,
  customNotes: string,
  pierCounts: { tied: number; freestanding: number } = { tied: 0, freestanding: 0 },
  curvePresence: { hasCutCurves: boolean; hasWedgeCurves: boolean; hasCustomCurves: boolean } = {
    hasCutCurves: false,
    hasWedgeCurves: false,
    hasCustomCurves: false,
  }
): string[] {
  if (!inclusions.assumptions) return []

  // Tighter prose so the whole list comfortably fits on one landscape A4
  // page. The previous wording was longer-form / explanatory; this version
  // keeps the substance but cuts hedging and parenthetical asides. Anything
  // a reader needs that's NOT in this list lives in the per-section pages
  // (block schedule, breakdown, openings) anyway.
  const items: string[] = [
    'All block sizes are nominal and include a 10 mm mortar joint (200 mm modular face and 200 mm modular course).',
    'Wall heights come from the wall-type definitions unless overridden per wall.',
    'Wall heights are rounded UP to the nearest achievable course stack — i.e. combinations of 200 mm standard courses plus optional 100 mm (20.71) and 150 mm (20.140) modular makeup courses (each = block + 10 mm mortar joint). When the requested height doesn\'t hit an exact combination, the closest-size makeup block gets applied (typically 10–50 mm overage) and the bricklayer trims mortar to suit on site.',
    'Wall lengths are measured from the drawings supplied. All dimensions in millimetres.',
    'Corner columns shared between two walls are counted once.',
    'T-junctions are treated as two separate walls. The stem terminates against the through-wall face with its own end column (alternating 20.01 / 20.03 in stretcher bond); the through-wall is unaffected.',
    'Height-makeup courses (20.71 / 20.140) span the full course length — end and fraction blocks are not counted separately on those rows.',
    'Walls under 800 mm use end blocks only (20.01 / 20.21) on every course, with up to two fill blocks (20.03 / 20.02 / 20.22) chosen to minimise overshoot.',
    'Wall stubs under 400 mm use a single block per course — the closest face width from 20.03 (190 mm), 20.02 (290 mm), 20.22 (340 mm), or 20.01 (390 mm).',
    'Curved walls: ≥ 6000 mm radius uses stock body blocks with compressed rear mortar. 1500–6000 mm uses stock blocks with a small saw cut on the rear corners. < 1500 mm uses the 20.03CW wedge. < 665 mm requires custom blocks.',
  ]

  if (curvePresence.hasCutCurves) {
    items.push(
      'One or more curves fall in the 1500–6000 mm "cut to radius" band — stock body blocks are supplied; the bricklayer saws a few mm to ~30 mm off the rear corners to absorb the curvature. No cut allowance is added to the count.'
    )
  }
  if (curvePresence.hasCustomCurves) {
    items.push(
      'One or more curves fall below the 665 mm minimum-feasible radius. The wedge can’t absorb a curve this tight — custom blocks need to be supplied. The wedge is counted as a placeholder; confirm the build with the bricklayer.'
    )
  }

  if (hasOpenings) {
    items.push('Openings (doors, windows) are deducted from the gross block count.')
    items.push(
      'Lintels are stood-up lintel blocks by head height: 20.13 under 200 mm, 20.25 for 200–299 mm, 20.18 at 300 mm and above.'
    )
  }

  if (pierCounts.tied > 0) {
    items.push(
      'Tied piers use a per-makeup course pattern repeated up the wall height (default: 40.925 / 20.01 alternating). A pier only displaces a body block on courses where its block is deeper than the wall.'
    )
  }
  if (pierCounts.freestanding > 0) {
    items.push(
      'Freestanding piers use a per-makeup course pattern repeated up the pier height (default: 40.925 stacked every course).'
    )
  }

  items.push('No waste allowance applied — quantities are net as measured.')

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
    pdfFile,
    pagesInfo,
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

  // Walk the curved walls once and bucket each by its build zone, so the
  // assumption page can conditionally tell the bricklayer / supplier whether
  // any block-cutting is required. A curve whose geometry can't be derived
  // (degenerate three-point arc) is ignored — those don't tally anything.
  let hasCutCurves = false
  let hasWedgeCurves = false
  let hasCustomCurves = false
  for (const w of walls) {
    if (!isCurvedWall(w) || w.midX === undefined || w.midY === undefined) continue
    const geom = arcFromThreePoints(
      { x: w.startX, y: w.startY },
      { x: w.midX, y: w.midY },
      { x: w.endX, y: w.endY }
    )
    if (!geom) continue
    const zone = curveZoneForRadius(geom.radiusMm)
    if (zone === 'cut') hasCutCurves = true
    else if (zone === 'wedge') hasWedgeCurves = true
    else if (zone === 'custom') hasCustomCurves = true
  }

  const assumptions = buildAssumptions(
    inclusions,
    openings.length > 0,
    projectDetails.notes,
    { tied: tiedPierCount, freestanding: freestandingPierCount },
    { hasCutCurves, hasWedgeCurves, hasCustomCurves }
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
        <h2 class="section-title">Assumptions</h2>
        <ol class="assumptions">
          ${assumptions.map((a) => `<li>${escapeHtml(a)}</li>`).join('')}
        </ol>
      </section>
    `
    : ''

  // Page 2: Wall Specifications — one card per wall type with bond,
  // height, block composition, course-series ranges, course overrides,
  // and the wall count + total length using it. Sits between Assumptions
  // and the Wall Layout pages so the reader can map a layout reference
  // back to the spec.
  const wallSpecsPage = inclusions.wallSpecs
    ? buildWallSpecsPage(makeups, walls, thicknessByWallId, wallsById, pageHeader)
    : ''

  // Page 3: Block Schedule (full code-by-code tally)
  const scheduleTable = inclusions.blockSchedule && entries.length > 0
    ? `
      <h2 class="section-title">Block Schedule</h2>
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

  // Plan-overview pages — one section per PDF page that has walls (a
  // multi-floor project draws walls on multiple pages, so a single
  // overview can't show the whole job). Each section has its own SVG
  // viewBox cropped to its page's walls, its own rasterised PDF page as
  // a background, and a heading like "Wall Layout — Page 9" so the
  // running header on continuation pages carries the same label.
  //
  // The schedule + breakdown tables that follow are project-wide and
  // come off the flat walls/openings/piers arrays — only the layout
  // diagram needs page splitting.
  const pagesToShow: PageInfo[] = pagesInfo && pagesInfo.length > 0
    ? pagesInfo.filter((p) => p.walls.length > 0)
    : []
  const planOverviewPages: string[] = []
  for (const page of pagesToShow) {
    // Rasterise this PDF page so the diagram has the building plan behind
    // it. If the page isn't calibrated yet (no scale ratio) or the PDF
    // can't be opened, the section still renders — just without the
    // background image.
    let pageBackground: {
      dataUrl: string
      pageWidthMm: number
      pageHeightMm: number
      pageScaleRatio: number
    } | null = null
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

    const pageLabel = page.label?.trim() || `Page ${page.pageNumber}`
    // Only suffix the heading when there's more than one Wall Layout
    // section — single-page exports keep the cleaner "Wall Layout" title.
    const labelSuffix = pagesToShow.length > 1 ? ` — ${pageLabel}` : ''

    // Total blocks across just THIS page's walls so the per-page tile
    // reads as the blocks for this floor, not the whole project. Computed
    // from per-wall tallies (without corner dedup, same as the breakdown
    // tables); the project-wide dedup'd count still appears on the Block
    // Schedule page.
    let pageBlockTotal = 0
    for (const w of page.walls) {
      const makeup = makeupsById[w.makeupId]
      if (!makeup) continue
      const openingsForWall = page.openings.filter((o) => o.wallId === w.id)
      const t = calculateWallTally(w, makeup, openingsForWall, thicknessByWallId, wallsById)
      for (const c of Object.values(t)) pageBlockTotal += c ?? 0
    }

    planOverviewPages.push(
      buildPlanOverviewPage(
        page.walls,
        page.openings,
        page.piers,
        makeups,
        makeupsById,
        thicknessByWallId,
        pageBlockTotal,
        pageHeader,
        pageBackground,
        labelSuffix
      )
    )
  }
  // Pre-joined so the assembly below can splice it in unchanged regardless
  // of how many pages there are.
  const planOverviewPage = planOverviewPages.join('\n')

  // Page 3: Wall-type breakdown
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

  // Each wall-type breakdown gets its own .page section so every page reliably
  // carries the full pageHeader (ABC Building Products / Block Takeoff —
  // Material Schedule) and the "Breakdown by Wall Type" subtitle. Trying to
  // pack multiple wall types onto one page would have left continuation pages
  // headerless because the first .page section's pageHeader only renders once
  // at the section's start. Per-wall-type pages is more pages but every page
  // reads as a complete, self-labelled sheet.
  const breakdownPages = inclusions.wallTypeBreakdown && perMakeup.some((p) => p.wallCount > 0)
    ? (() => {
        const wallTypePages = perMakeup
          .filter((p) => p.wallCount > 0)
          .map((p) => {
            const subEntries = tallyEntries(p.tally)
            const subTotal = subEntries.reduce((s, [, c]) => s + c, 0)
            return `
              <section class="page">
                ${pageHeader}
                <h2 class="section-title">Breakdown by Wall Type</h2>
                <p class="page-intro">Block counts per wall makeup.</p>
                <div class="wall-type-section">
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
                </div>
              </section>
            `
          })
          .join('')

        const grandTotalPage = `
          <section class="page">
            ${pageHeader}
            <h2 class="section-title">Grand Total per Block Type</h2>
            <p class="page-intro">Combined block counts across every wall makeup.</p>
            <div class="wall-type-section">
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
            </div>
          </section>
        `

        return wallTypePages + grandTotalPage
      })()
    : ''

  // Page 4: Openings + lintels
  const openingsTable = inclusions.openingsList && openings.length > 0
    ? `
      <h2 class="section-title">Openings &amp; Lintels</h2>
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

  ol.assumptions { padding-left: 22px; margin: 0; }
  ol.assumptions li {
    padding: 3px 0;
    font-size: 12px;
    line-height: 1.45;
  }
  /* Keep the whole list together so it doesn't split across pages —
     reading half the assumptions on each of two sheets reads worse than
     a slightly tight single page. The shortened item text above is
     sized so even the longest combination (curves + cut + openings +
     piers + waste) still fits in landscape A4. */
  ol.assumptions {
    page-break-inside: avoid;
    break-inside: avoid;
  }

  /* ── Wall layout page ─────────────────────────────────────────────
     Stats strip across the top, SVG diagram in the middle, legend at
     the bottom. Sizes are tuned to keep the whole section on a single
     landscape A4 page — content area is ≈ 165 mm tall after page
     margins + footer, and the stats + intro + legend take ~40 mm of
     that, leaving ~95 mm for the diagram. Don't increase any of
     these without re-checking the one-page fit. */
  .plan-overview-page h2.section-title {
    margin: 12px 0 4px;
  }
  .plan-overview-page .page-intro {
    margin-bottom: 6px;
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
  .plan-stat-sub {
    font-size: 9px;
    color: #6b7280;
    margin-top: 1px;
  }

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
  .plan-overview-wrap svg {
    width: 100%;
    height: 100%;
    display: block;
  }

  .plan-overview-legend {
    display: flex;
    gap: 14px;
    align-items: center;
    margin-top: 6px;
    font-size: 10px;
    color: #4b5563;
    flex-wrap: wrap;
  }
  .legend-item {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .legend-item strong {
    font-weight: 600;
    color: #1f2937;
  }
  .legend-sub {
    color: #6b7280;
    font-size: 10px;
    margin-left: 2px;
  }
  .legend-swatch {
    display: inline-block;
    width: 18px;
    height: 10px;
    border-radius: 2px;
  }
  .legend-pier {
    background: #3b82f6;
    border: 1px solid #1e40af;
    width: 10px;
  }
  .legend-note {
    color: #9ca3af;
    font-style: italic;
  }

  /* ── Wall specifications page ─────────────────────────────────────
     One card per wall type with a compact key/value spec grid and
     optional sub-tables for course-series ranges + per-course
     overrides. Multiple cards flow down the page; break-inside: avoid
     keeps a single card whole when it would otherwise straddle a page
     boundary. Sized so 3–4 cards fit comfortably on a landscape A4. */
  .wall-spec-card {
    margin: 8px 0 14px;
    padding: 10px 14px;
    border: 1px solid #e5e7eb;
    border-radius: 6px;
    background: #fafafa;
    page-break-inside: avoid;
    break-inside: avoid;
  }
  .wall-spec-header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 8px;
    flex-wrap: wrap;
  }
  .wall-spec-name {
    font-size: 13px;
    font-weight: 700;
    color: #1f2937;
    margin: 0;
  }
  .wall-spec-meta {
    font-size: 11px;
    color: #6b7280;
    font-variant-numeric: tabular-nums;
  }
  .spec-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 4px 18px;
    font-size: 12px;
  }
  .spec-row {
    display: flex;
    justify-content: space-between;
    border-bottom: 1px dotted #e5e7eb;
    padding: 3px 0;
    gap: 12px;
  }
  .spec-key {
    color: #6b7280;
  }
  .spec-val {
    color: #1f2937;
    font-weight: 500;
    font-variant-numeric: tabular-nums;
    text-align: right;
  }
  .spec-subsection {
    margin-top: 8px;
  }
  .spec-sub-title {
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: #6b7280;
    margin-bottom: 4px;
  }
  .spec-sub-table {
    width: 100%;
    border-collapse: collapse;
    margin: 0;
    font-size: 11px;
  }
  .spec-sub-table td {
    padding: 3px 6px;
    border-bottom: 1px dotted #e5e7eb;
  }
  .spec-sub-table .range-courses {
    width: 110px;
    color: #1f2937;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .spec-sub-table .range-detail {
    color: #4b5563;
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
    .page { padding: 0.4cm 1.5cm 1.5cm 1.5cm; min-height: auto; }
    /* Landscape A4 with a 1.1cm top margin reserved for the running header
       in @top-center. The .page padding-top is reduced to 0.4cm in print
       to compensate so the body content doesn't end up double-padded. */
    @page {
      margin: 1.1cm 0 0 0;
      size: A4 landscape;
      /* Running header — picks up the current section's title from the
         CSS named string 'sectionTitle' (set via the section-title class
         on each <h2>). Chrome propagates the most recent value of a named
         string across continuation pages, so when a section overflows
         onto a second page the same heading still appears at the top.
         On the section's first page, the in-flow h2 sits below this
         running version — slight redundancy that reads as 'page subtitle
         + section heading', which is the standard report layout. */
      @top-center {
        content: string(sectionTitle);
        font-family: 'Inter', system-ui, -apple-system, sans-serif;
        font-size: 10pt;
        color: #6b7280;
        font-style: italic;
        padding-top: 4mm;
      }
      /* Explicitly blank out the other margin boxes so the browser's
         built-in 'Headers and footers' chrome (date / URL / page title)
         doesn't get to draw there. Per the CSS Paged Media spec, when
         these boxes have content defined the user-agent's default
         content is replaced. Chrome's print dialog 'Headers and footers'
         option may still override this — that's a print-dialog setting,
         not a CSS rule — but the empty boxes are the most we can do
         from the document side. */
      @top-left { content: ""; }
      @top-right { content: ""; }
      @bottom-left { content: ""; }
      @bottom-center { content: ""; }
      @bottom-right { content: ""; }
    }
    /* Each section's h2 sets the named string so any continuation pages
       of that section inherit the title in the running header. */
    h2.section-title {
      string-set: sectionTitle content();
    }

    /* ── Page-break hygiene ──────────────────────────────────────────
       Keep individual rows from being sliced in half across pages, and
       repeat each table's header at the top of every continuation page
       so a long schedule still reads cleanly. Each wall-type subsection
       (heading + its table) is kept together when it fits on a single
       page — break-inside: avoid is a hint, so a section that's too
       big for a page will still break, but the rows inside it stay
       atomic and the header reprints. */
    thead { display: table-header-group; }
    tfoot { display: table-footer-group; }
    tr, .beme-credit { page-break-inside: avoid; break-inside: avoid; }
    .wall-type-section, .disclaimer, .meta {
      page-break-inside: avoid;
      break-inside: avoid;
    }
    /* Don't let the bold subtotal/total rows orphan at the top of a
       new page — they have to stay glued to the row above. Without
       this, a tall table whose last few data rows fit on one page
       can push its Total summary onto a near-empty next page, which
       is what looked janky in the v1 export. */
    tr.bold {
      page-break-before: avoid;
      break-before: avoid-page;
    }
    /* Tables are preferred-together when they fit on a page. If a
       table is genuinely longer than a page, the browser ignores this
       hint and falls back to splitting between rows — which is fine
       because thead reprints and the row-atomic rule keeps each row
       intact. */
    table {
      page-break-inside: avoid;
      break-inside: avoid;
    }
    /* Don't strand a heading at the bottom of a page — let the heading
       drag onto the next page with its content. */
    h2, h3 {
      page-break-after: avoid;
      break-after: avoid-page;
    }
  }
</style>
</head>
<body>
  ${assumptionsPage}
  ${wallSpecsPage}
  ${planOverviewPage}
  ${schedulePage}
  ${breakdownPages}
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
    wallSpecs: true,
    blockSchedule: true,
    wallTypeBreakdown: true,
    // Openings & lintels section is removed from the export options UI and
    // defaults off — keep the flag in the type for backward-compat with
    // already-saved projects so older saves still load cleanly.
    openingsList: false,
    disclaimer: true,
  }
}
