/**
 * Library templates — the seed sets of blocks each region's library
 * starts with. A user creating a new account / org picks one of these
 * (Step 3 wires the picker) and gets a working library out of the box
 * for their region; they can then add or edit blocks via the material
 * library page.
 *
 * Each template carries enough metadata that the calc engine works
 * against it unchanged — every block is tagged with the right
 * functional role, mortar joint defaults differ by region, lintel
 * head-height buckets cover the typical range for that region's
 * lintel set.
 *
 * The AU-SEQ template re-exports DEFAULT_BLOCK_LIBRARY so existing
 * AU users keep the exact library they've always had. US-CMU and
 * UK-Block are NEW for region rollout — minimal but functional sets;
 * users add to them as needed.
 */

import type { Block, BlockCode } from '../types/blocks'
import type { BrickCode, BrickType } from '../types/bricks'
import { DEFAULT_BLOCK_LIBRARY } from './blockLibrary'

/** Discriminator key — stored on the user / org to pick a template. */
export type LibraryTemplateKey =
  | 'au-seq'
  | 'nz-block'
  | 'us-cmu'
  | 'ca-cmu'
  | 'uk-block'
  | 'blank'

export interface LibraryTemplate {
  key: LibraryTemplateKey
  /** Short display name for the region picker. */
  displayName: string
  /** Region label — surfaced in onboarding + Settings → Organisation. */
  region: string
  /** Default mortar joint thickness in mm for new wall makeups. */
  mortarJointMm: number
  /**
   * One-line elevator pitch for the template — shown under the radio
   * option in the region picker.
   */
  description: string
  /**
   * The seed block library. Stored as Record<BlockCode, Block> so the
   * calc engine and library page can treat it identically to the
   * current BLOCK_LIBRARY shape.
   */
  blocks: Record<BlockCode, Block>
  /**
   * The seed brick library — regional standard face brick(s). Same
   * shape as BRICK_LIBRARY so users can drop in a template and get a
   * working brick catalogue immediately. Region-specific because
   * face sizes vary materially (AU 230×76, US ~203×57, UK 215×65).
   */
  bricks: Record<BrickCode, BrickType>
}

// ─── US — CMU (Concrete Masonry Unit) ──────────────────────────────────────
// Nominal sizes call them "8 inch block" but actual = 7-5/8" × 7-5/8" ×
// 15-5/8" so that with 3/8" (~10mm) mortar the assembled dimension hits
// exactly 8" × 8" × 16". I store the ACTUAL dimensions and the calc
// engine adds the mortar joint to derive the modular size — matches how
// AU SEQ blocks are stored (390 actual + 10 mortar = 400 modular).
//
// Codes use a CMU-prefix-with-size convention so they don't collide
// with AU SEQ codes. The user can always rename a block from the
// library page later; this is just the seed.

export const US_CMU_LIBRARY: Record<BlockCode, Block> = {
  CMU8: {
    code: 'CMU8',
    name: '8" CMU (body)',
    description:
      'Standard 8 inch Concrete Masonry Unit, the main body block. Open-end ' +
      'or open-bottom configurations are both used regionally — Beme treats ' +
      'them interchangeably for tally purposes. Also doubles as the pier ' +
      'block and the base-course block — US masonry builds piers AND the ' +
      'base of the wall from the same body unit (the base course is just ' +
      'grouted solid on top of the footing, no special cleanout block).',
    dimensions: { widthMm: 397, heightMm: 194, depthMm: 194 },
    roles: ['body', 'pier', 'base-course'],
  },
  'CMU8-C': {
    code: 'CMU8-C',
    name: '8" CMU Corner',
    description:
      'Solid-end 8" CMU used at wall corners and ends. Closed end gives a ' +
      'finished face at the corner / end of the wall.',
    dimensions: { widthMm: 397, heightMm: 194, depthMm: 194 },
    roles: ['end-termination', 'corner'],
  },
  'CMU8-H': {
    code: 'CMU8-H',
    name: '8" CMU Half Block',
    description:
      'Half-length CMU (8" × 8" × 8" nominal). Alternates with the full ' +
      'corner block on even courses in running (stretcher) bond to maintain ' +
      'the half-block offset.',
    dimensions: { widthMm: 194, heightMm: 194, depthMm: 194 },
    roles: ['end-termination', 'fraction'],
    fraction: 0.5,
  },
  'CMU8-BB': {
    code: 'CMU8-BB',
    name: '8" CMU Bond Beam',
    description:
      'U-shaped bond beam block used on the top course (or intermediate ' +
      'reinforced courses) — open trough is filled with rebar and grout.',
    dimensions: { widthMm: 397, heightMm: 194, depthMm: 194 },
    roles: ['top-course'],
  },
  'CMU8-L4': {
    code: 'CMU8-L4',
    name: '4" CMU Lintel',
    description:
      'Half-height lintel block (8" wide × 4" tall) for head heights below ' +
      'a full course (~100mm).',
    dimensions: { widthMm: 397, heightMm: 92, depthMm: 194 },
    roles: ['lintel'],
    lintelMinHeadHeightMm: 0,
    lintelMaxHeadHeightMm: 200,
  },
  'CMU8-L8': {
    code: 'CMU8-L8',
    name: '8" CMU Lintel',
    description:
      'Full-height (8") U-channel lintel for head heights 200–399mm.',
    dimensions: { widthMm: 397, heightMm: 194, depthMm: 194 },
    roles: ['lintel'],
    lintelMinHeadHeightMm: 200,
    lintelMaxHeadHeightMm: 400,
  },
  'CMU8-L16': {
    code: 'CMU8-L16',
    name: '16" Deep Lintel',
    description:
      'Double-height (16") lintel for wide / heavy openings — covers head ' +
      'heights of 400mm and above.',
    dimensions: { widthMm: 397, heightMm: 397, depthMm: 194 },
    roles: ['lintel'],
    lintelMinHeadHeightMm: 400,
  },
  'CMU8-HH': {
    code: 'CMU8-HH',
    name: '8" Half-High CMU',
    description:
      'Half-height unit (15-5/8" × 3-5/8" face, ~397 × 92mm) — the ' +
      'height-makeup block for wall heights off the 8" course module.',
    dimensions: { widthMm: 397, heightMm: 92, depthMm: 194 },
    roles: ['height-makeup'],
  },
  'CMU8-CO': {
    code: 'CMU8-CO',
    name: '8" Open-End A Block',
    description:
      'Open-end (A-shaped) unit used on grouted base courses and cleanout ' +
      'courses — lets the grout key through and the inspector see the ' +
      'footing interface.',
    dimensions: { widthMm: 397, heightMm: 194, depthMm: 194 },
    roles: ['base-course'],
  },
  'CMU8-CAP': {
    code: 'CMU8-CAP',
    name: '8" Solid Cap',
    description:
      'Solid 2-1/4" cap unit (397 × 57 × 194mm) — closes the cores on the ' +
      'top of a finished wall.',
    dimensions: { widthMm: 397, heightMm: 57, depthMm: 194 },
    roles: ['cap'],
  },
  'CMU-COL16': {
    code: 'CMU-COL16',
    name: '16" × 16" Column Block',
    description:
      'Pilaster / column unit, 15-5/8" square (397 × 194 × 397mm) — ' +
      'freestanding and tied piers.',
    dimensions: { widthMm: 397, heightMm: 194, depthMm: 397 },
    roles: ['pier'],
  },
  CMU4: {
    code: 'CMU4',
    name: '4" CMU (body)',
    description:
      'Partition unit, 15-5/8" × 7-5/8" × 3-5/8" (397 × 194 × 92mm).',
    dimensions: { widthMm: 397, heightMm: 194, depthMm: 92 },
    roles: ['body'],
  },
  'CMU4-H': {
    code: 'CMU4-H',
    name: '4" CMU Half',
    description: 'Half-length closure for 4" walls (194 × 194 × 92mm).',
    dimensions: { widthMm: 194, heightMm: 194, depthMm: 92 },
    roles: ['end-termination', 'fraction'],
    fraction: 0.5,
  },
  CMU6: {
    code: 'CMU6',
    name: '6" CMU (body)',
    description:
      'Intermediate width, 15-5/8" × 7-5/8" × 5-5/8" (397 × 194 × 143mm).',
    dimensions: { widthMm: 397, heightMm: 194, depthMm: 143 },
    roles: ['body'],
  },
  'CMU6-C': {
    code: 'CMU6-C',
    name: '6" CMU Corner',
    description: 'Flat-ended corner / end unit for 6" walls.',
    dimensions: { widthMm: 397, heightMm: 194, depthMm: 143 },
    roles: ['corner', 'end-termination'],
  },
  'CMU6-H': {
    code: 'CMU6-H',
    name: '6" CMU Half',
    description: 'Half-length closure for 6" walls (194 × 194 × 143mm).',
    dimensions: { widthMm: 194, heightMm: 194, depthMm: 143 },
    roles: ['end-termination', 'fraction'],
    fraction: 0.5,
  },
  CMU10: {
    code: 'CMU10',
    name: '10" CMU (body)',
    description:
      'Heavy wall / foundation unit, 15-5/8" × 7-5/8" × 9-5/8" ' +
      '(397 × 194 × 244mm).',
    dimensions: { widthMm: 397, heightMm: 194, depthMm: 244 },
    roles: ['body'],
  },
  CMU12: {
    code: 'CMU12',
    name: '12" CMU (body)',
    description:
      'Foundation / retaining unit, 15-5/8" × 7-5/8" × 11-5/8" ' +
      '(397 × 194 × 295mm).',
    dimensions: { widthMm: 397, heightMm: 194, depthMm: 295 },
    roles: ['body'],
  },
  'CMU12-H': {
    code: 'CMU12-H',
    name: '12" CMU Half',
    description: 'Half-length closure for 12" walls (194 × 194 × 295mm).',
    dimensions: { widthMm: 194, heightMm: 194, depthMm: 295 },
    roles: ['end-termination', 'fraction'],
    fraction: 0.5,
  },
}

// ─── UK — Concrete block (dense aggregate) ─────────────────────────────────
// UK standard: 440mm × 215mm × 100mm dense aggregate block with 10mm
// mortar joints. 215mm tall block + 10mm joint = 225mm modular course
// height. Half block = 215mm × 215mm × 100mm.
//
// Lintels in UK are typically pre-stressed concrete sourced separately
// from the block stack (Naylor, Concrete Lintels Ltd, etc.) — modelled
// here as three depth buckets to match Beme's existing head-height
// bucket selection. Real distributors carry many sizes; users add the
// rest from the library page.

export const UK_BLOCK_LIBRARY: Record<BlockCode, Block> = {
  'BLK-100': {
    code: 'BLK-100',
    name: '100mm Block (body)',
    description:
      'Standard 440 × 215 × 100mm dense aggregate concrete block. Main ' +
      'body course block — also doubles as the pier block and the base- ' +
      'course block. UK construction uses the same body unit at the ' +
      'wall base (bedded on a damp-proof course) rather than a dedicated ' +
      'cleanout / starter block.',
    dimensions: { widthMm: 440, heightMm: 215, depthMm: 100 },
    roles: ['body', 'pier', 'base-course'],
  },
  'BLK-100-C': {
    code: 'BLK-100-C',
    name: '100mm Corner Block',
    description:
      'Full-size 100mm block used at wall corners and at the ends of ' +
      'stretcher-bond walls on odd courses.',
    dimensions: { widthMm: 440, heightMm: 215, depthMm: 100 },
    roles: ['end-termination', 'corner'],
  },
  'BLK-100-H': {
    code: 'BLK-100-H',
    name: '100mm Half Block',
    description:
      'Half-length (215mm face) block. Alternates with the full block ' +
      "at wall ends on even courses to maintain stretcher bond's " +
      'half-block offset.',
    dimensions: { widthMm: 215, heightMm: 215, depthMm: 100 },
    roles: ['end-termination', 'fraction'],
    fraction: 0.5,
  },
  'LIN-100-150': {
    code: 'LIN-100-150',
    name: 'Pre-stressed Lintel (100×150)',
    description:
      'Pre-stressed concrete lintel, 100mm wide × 150mm tall. For small ' +
      'openings with head heights below 200mm.',
    dimensions: { widthMm: 600, heightMm: 140, depthMm: 100 },
    roles: ['lintel'],
    lintelMinHeadHeightMm: 0,
    lintelMaxHeadHeightMm: 200,
  },
  'LIN-100-215': {
    code: 'LIN-100-215',
    name: 'Pre-stressed Lintel (100×215)',
    description:
      'Pre-stressed concrete lintel, 100mm wide × 215mm tall — matches a ' +
      'full course height. For head heights 200–399mm.',
    dimensions: { widthMm: 600, heightMm: 215, depthMm: 100 },
    roles: ['lintel'],
    lintelMinHeadHeightMm: 200,
    lintelMaxHeadHeightMm: 400,
  },
  'LIN-100-430': {
    code: 'LIN-100-430',
    name: 'Pre-stressed Lintel (100×430)',
    description:
      'Pre-stressed concrete lintel, 100mm wide × 430mm tall — two-course ' +
      'depth. For wider openings with head heights 400mm and above.',
    dimensions: { widthMm: 600, heightMm: 430, depthMm: 100 },
    roles: ['lintel'],
    lintelMinHeadHeightMm: 400,
  },
  'CB-65': {
    code: 'CB-65',
    name: 'Coursing Brick 215×65',
    description:
      'Concrete coursing brick (215 × 65 × 100mm) — the height-makeup ' +
      'unit for wall heights off the 225mm course module, and for ' +
      'levelling up to lintel bearings.',
    dimensions: { widthMm: 215, heightMm: 65, depthMm: 100 },
    roles: ['height-makeup'],
  },
  'BLK-140': {
    code: 'BLK-140',
    name: '140mm Block (body)',
    description:
      'Dense aggregate block, 440 × 215 × 140mm — party walls and ' +
      'heavier loadbearing leaves.',
    dimensions: { widthMm: 440, heightMm: 215, depthMm: 140 },
    roles: ['body'],
  },
  'BLK-140-C': {
    code: 'BLK-140-C',
    name: '140mm Corner Block',
    description: 'Full-size 140mm unit for corners and odd-course ends.',
    dimensions: { widthMm: 440, heightMm: 215, depthMm: 140 },
    roles: ['corner', 'end-termination'],
  },
  'BLK-140-H': {
    code: 'BLK-140-H',
    name: '140mm Half Block',
    description: 'Half-length closure (215 × 215 × 140mm).',
    dimensions: { widthMm: 215, heightMm: 215, depthMm: 140 },
    roles: ['end-termination', 'fraction'],
    fraction: 0.5,
  },
  'BLK-215': {
    code: 'BLK-215',
    name: '215mm Block (body)',
    description:
      'Full-width dense aggregate block, 440 × 215 × 215mm — solid ' +
      'single-leaf walls and below-DPC work.',
    dimensions: { widthMm: 440, heightMm: 215, depthMm: 215 },
    roles: ['body'],
  },
  'BLK-215-H': {
    code: 'BLK-215-H',
    name: '215mm Half Block',
    description: 'Half-length closure (215 × 215 × 215mm).',
    dimensions: { widthMm: 215, heightMm: 215, depthMm: 215 },
    roles: ['end-termination', 'fraction'],
    fraction: 0.5,
  },
  'AIR-100': {
    code: 'AIR-100',
    name: '100mm Aircrete Block',
    description:
      'Aerated (aircrete) block, 440 × 215 × 100mm — inner leaves where ' +
      'thermal performance drives the spec. Tally-identical to dense ' +
      '100mm; kept as a separate line so the schedule splits the order.',
    dimensions: { widthMm: 440, heightMm: 215, depthMm: 100 },
    roles: ['body'],
  },
  'AIR-140': {
    code: 'AIR-140',
    name: '140mm Aircrete Block',
    description: 'Aerated block at 140mm thickness (440 × 215 × 140mm).',
    dimensions: { widthMm: 440, heightMm: 215, depthMm: 140 },
    roles: ['body'],
  },
  'LIN-140-215': {
    code: 'LIN-140-215',
    name: 'Pre-stressed Lintel (140×215)',
    description:
      'Pre-stressed concrete lintel for 140mm walls, full course height. ' +
      'Head heights 200–399mm.',
    dimensions: { widthMm: 600, heightMm: 215, depthMm: 140 },
    roles: ['lintel'],
    lintelMinHeadHeightMm: 200,
    lintelMaxHeadHeightMm: 400,
  },
  'COP-150': {
    code: 'COP-150',
    name: 'Once-Weathered Coping',
    description:
      'Concrete coping, 600 × 75 × 150mm — caps freestanding and garden ' +
      'walls.',
    dimensions: { widthMm: 600, heightMm: 75, depthMm: 150 },
    roles: ['cap'],
  },
}

// ─── NZ — Concrete masonry (Firth hollow masonry catalogue) ────────────────
// New Zealand masonry shares the 390 × 190 face and 10mm joint with AU
// (400 × 200 modular). Codes and names follow Firth's hollow-masonry
// catalogue (10 / 15 / 20 / 25 series; H-prefix = half-high): 20.01
// whole, 20.02 half, 20.19 three-quarter, H20.04 half-high, 20.05 open
// end, 20.12 lintel, 20.16 open-end bond beam, 20.30 column, 05.17
// capping. Verified against the Firth Hollow Masonry brochure (2023).
// Regional availability varies (some units are North Island only).

export const NZ_BLOCK_LIBRARY: Record<BlockCode, Block> = {
  '20.01': {
    code: '20.01',
    name: '20.01 Standard Whole',
    description:
      'Firth 20-series standard whole block, 390 × 190 × 190mm — main ' +
      'body unit and the corner / end block in stretcher bond.',
    dimensions: { widthMm: 390, heightMm: 190, depthMm: 190 },
    roles: ['body', 'corner', 'end-termination'],
  },
  '20.02': {
    code: '20.02',
    name: '20.02 Half',
    description:
      'Half block, 190 × 190 × 190mm — alternates with the whole block ' +
      "at free wall ends on even courses for stretcher bond's offset.",
    dimensions: { widthMm: 190, heightMm: 190, depthMm: 190 },
    roles: ['end-termination', 'fraction'],
    fraction: 0.5,
  },
  '20.19': {
    code: '20.19',
    name: '20.19 Three Quarter',
    description:
      'Three-quarter block, 290 × 190 × 190mm — closure for non-modular ' +
      'wall lengths.',
    dimensions: { widthMm: 290, heightMm: 190, depthMm: 190 },
    roles: ['fraction'],
    fraction: 0.75,
  },
  'H20.04': {
    code: 'H20.04',
    name: 'H20.04 Half High',
    description:
      'Plain-end half-high, 390 × 90 × 190mm — the height-makeup unit ' +
      'for wall heights off the 200mm course module.',
    dimensions: { widthMm: 390, heightMm: 90, depthMm: 190 },
    roles: ['height-makeup'],
  },
  '20.05': {
    code: '20.05',
    name: '20.05 Open End',
    description:
      'Open-end unit — grouted base / cleanout courses where the grout ' +
      'keys through to the footing.',
    dimensions: { widthMm: 390, heightMm: 190, depthMm: 190 },
    roles: ['base-course'],
  },
  '20.12': {
    code: '20.12',
    name: '20.12 Lintel & Half End-Closer',
    description:
      'Lintel / half end-closer unit, 190 × 190 × 190mm — laid across ' +
      'opening heads (head heights to ~400mm).',
    dimensions: { widthMm: 190, heightMm: 190, depthMm: 190 },
    roles: ['lintel'],
    lintelMinHeadHeightMm: 0,
    lintelMaxHeadHeightMm: 400,
  },
  '20.16': {
    code: '20.16',
    name: '20.16 Open End Bond Beam',
    description:
      'Open-end bond beam (depressed web), 390 × 190 × 190mm — the ' +
      'reinforced top course, intermediate bond beams, and stacked ' +
      'bond-beam lintels over wide openings (head heights 400mm+).',
    dimensions: { widthMm: 390, heightMm: 190, depthMm: 190 },
    roles: ['top-course', 'lintel'],
    lintelMinHeadHeightMm: 400,
  },
  '20.30': {
    code: '20.30',
    name: '20.30 Standard Column',
    description:
      'Standard column block, 390 × 190 × 190mm — tied and freestanding ' +
      'piers.',
    dimensions: { widthMm: 390, heightMm: 190, depthMm: 190 },
    roles: ['pier'],
  },
  '05.17': {
    code: '05.17',
    name: '05.17 Capping',
    description:
      'Capping tile, 390 × 40 × 190mm — closes the cores across the top ' +
      'of a finished wall.',
    dimensions: { widthMm: 390, heightMm: 40, depthMm: 190 },
    roles: ['cap'],
  },
  '15.04': {
    code: '15.04',
    name: '15.04 Plain End Standard',
    description:
      '15-series whole block, 390 × 190 × 140mm — partition and ' +
      'veneer-backing walls.',
    dimensions: { widthMm: 390, heightMm: 190, depthMm: 140 },
    roles: ['body', 'corner', 'end-termination'],
  },
  'H15.04': {
    code: 'H15.04',
    name: 'H15.04 Half High',
    description:
      '15-series plain-end half-high, 390 × 90 × 140mm — height makeup ' +
      'on 140mm walls.',
    dimensions: { widthMm: 390, heightMm: 90, depthMm: 140 },
    roles: ['height-makeup'],
  },
  '10.01': {
    code: '10.01',
    name: '10.01 Standard Whole',
    description: '10-series whole block, 390 × 190 × 90mm.',
    dimensions: { widthMm: 390, heightMm: 190, depthMm: 90 },
    roles: ['body'],
  },
  '10.02': {
    code: '10.02',
    name: '10.02 Half',
    description: '10-series half block, 190 × 190 × 90mm.',
    dimensions: { widthMm: 190, heightMm: 190, depthMm: 90 },
    roles: ['end-termination', 'fraction'],
    fraction: 0.5,
  },
  '10.03': {
    code: '10.03',
    name: '10.03 Corner',
    description: '10-series corner block, 390 × 190 × 90mm.',
    dimensions: { widthMm: 390, heightMm: 190, depthMm: 90 },
    roles: ['corner', 'end-termination'],
  },
  '25.05': {
    code: '25.05',
    name: '25.05 Open / Plain End',
    description:
      '25-series whole block, 390 × 190 × 240mm — heavy structural and ' +
      'retaining walls.',
    dimensions: { widthMm: 390, heightMm: 190, depthMm: 240 },
    roles: ['body', 'corner', 'end-termination'],
  },
  'H25.04': {
    code: 'H25.04',
    name: 'H25.04 Half High',
    description:
      '25-series half-high, 390 × 90 × 240mm — height makeup on 240mm ' +
      'walls.',
    dimensions: { widthMm: 390, heightMm: 90, depthMm: 240 },
    roles: ['height-makeup'],
  },
}

// ─── Canada — CSA A165 metric CMU ──────────────────────────────────────────
// Canadian concrete block is metric CMU: 390 × 190 face with 10mm
// joints (390 + 10 = 400 modular — the "20cm block"). Widths run
// 90 / 140 / 190 / 240 / 290 for the 10 / 15 / 20 / 25 / 30cm series.
// The 20cm series is seeded as the primary structural set; add other
// widths from the library page.

export const CA_CMU_LIBRARY: Record<BlockCode, Block> = {
  CMU20: {
    code: 'CMU20',
    name: '20cm Block (body)',
    description:
      'Standard CSA A165 stretcher unit, 390 × 190 × 190mm. Main body ' +
      'block; also doubles as the pier and base-course block (base course ' +
      'is grout-filled on the footing).',
    dimensions: { widthMm: 390, heightMm: 190, depthMm: 190 },
    roles: ['body', 'pier', 'base-course'],
  },
  'CMU20-C': {
    code: 'CMU20-C',
    name: '20cm Corner Block',
    description:
      'Flat-ended corner / end unit. Turns corners and finishes free wall ' +
      'ends on odd courses.',
    dimensions: { widthMm: 390, heightMm: 190, depthMm: 190 },
    roles: ['corner', 'end-termination'],
  },
  'CMU20-H': {
    code: 'CMU20-H',
    name: '20cm Half Block',
    description:
      'Half-length (190mm face) block — alternates with the corner unit ' +
      'at wall ends on even courses for stretcher bond.',
    dimensions: { widthMm: 190, heightMm: 190, depthMm: 190 },
    roles: ['end-termination', 'fraction'],
    fraction: 0.5,
  },
  'CMU20-HH': {
    code: 'CMU20-HH',
    name: '20cm Half-High',
    description:
      'Half-height (90mm face) unit — the height-makeup block for wall ' +
      'heights off the 200mm course module.',
    dimensions: { widthMm: 390, heightMm: 90, depthMm: 190 },
    roles: ['height-makeup'],
  },
  'CMU20-BB': {
    code: 'CMU20-BB',
    name: '20cm Bond Beam',
    description:
      'Knock-out / U-shaped bond beam block for the reinforced top course ' +
      'and intermediate bond beams.',
    dimensions: { widthMm: 390, heightMm: 190, depthMm: 190 },
    roles: ['top-course'],
  },
  'CMU20-L10': {
    code: 'CMU20-L10',
    name: '10cm Lintel',
    description:
      'Half-height lintel unit (390 × 90 × 190mm) for head heights below ' +
      '~200mm.',
    dimensions: { widthMm: 390, heightMm: 90, depthMm: 190 },
    roles: ['lintel'],
    lintelMinHeadHeightMm: 0,
    lintelMaxHeadHeightMm: 200,
  },
  'CMU20-L20': {
    code: 'CMU20-L20',
    name: '20cm Lintel',
    description:
      'Full-course U-channel lintel (390 × 190 × 190mm) for head heights ' +
      '200–399mm.',
    dimensions: { widthMm: 390, heightMm: 190, depthMm: 190 },
    roles: ['lintel'],
    lintelMinHeadHeightMm: 200,
    lintelMaxHeadHeightMm: 400,
  },
  'CMU20-L40': {
    code: 'CMU20-L40',
    name: '40cm Deep Lintel',
    description:
      'Double-height lintel (390 × 390 × 190mm) for wide / heavy openings ' +
      '— head heights 400mm and above.',
    dimensions: { widthMm: 390, heightMm: 390, depthMm: 190 },
    roles: ['lintel'],
    lintelMinHeadHeightMm: 400,
  },
  CMU15: {
    code: 'CMU15',
    name: '15cm Block (body)',
    description:
      '140mm-wide stretcher (390 × 190 × 140mm) for partitions and ' +
      'backing walls.',
    dimensions: { widthMm: 390, heightMm: 190, depthMm: 140 },
    roles: ['body'],
  },
  'CMU15-H': {
    code: 'CMU15-H',
    name: '15cm Half Block',
    description: 'Half-length closure for 15cm walls (190 × 190 × 140mm).',
    dimensions: { widthMm: 190, heightMm: 190, depthMm: 140 },
    roles: ['end-termination', 'fraction'],
    fraction: 0.5,
  },
  CMU10C: {
    code: 'CMU10C',
    name: '10cm Block (body)',
    description:
      'Partition unit, 390 × 190 × 90mm.',
    dimensions: { widthMm: 390, heightMm: 190, depthMm: 90 },
    roles: ['body'],
  },
  CMU25: {
    code: 'CMU25',
    name: '25cm Block (body)',
    description:
      'Heavy structural unit, 390 × 190 × 240mm.',
    dimensions: { widthMm: 390, heightMm: 190, depthMm: 240 },
    roles: ['body'],
  },
  'CMU25-H': {
    code: 'CMU25-H',
    name: '25cm Half Block',
    description: 'Half-length closure for 25cm walls (190 × 190 × 240mm).',
    dimensions: { widthMm: 190, heightMm: 190, depthMm: 240 },
    roles: ['end-termination', 'fraction'],
    fraction: 0.5,
  },
  CMU30: {
    code: 'CMU30',
    name: '30cm Block (body)',
    description:
      'Foundation / retaining unit, 390 × 190 × 290mm.',
    dimensions: { widthMm: 390, heightMm: 190, depthMm: 290 },
    roles: ['body', 'corner', 'end-termination'],
  },
  'CMU30-H': {
    code: 'CMU30-H',
    name: '30cm Half Block',
    description: 'Half-length closure for 30cm walls (190 × 190 × 290mm).',
    dimensions: { widthMm: 190, heightMm: 190, depthMm: 290 },
    roles: ['end-termination', 'fraction'],
    fraction: 0.5,
  },
  'CMU20-CO': {
    code: 'CMU20-CO',
    name: '20cm Open-End A Block',
    description:
      'Open-end unit for grouted base / cleanout courses.',
    dimensions: { widthMm: 390, heightMm: 190, depthMm: 190 },
    roles: ['base-course'],
  },
  'CMU20-CAP': {
    code: 'CMU20-CAP',
    name: '20cm Solid Cap',
    description:
      'Solid cap unit (390 × 57 × 190mm) — closes the cores on top of a ' +
      'finished wall.',
    dimensions: { widthMm: 390, heightMm: 57, depthMm: 190 },
    roles: ['cap'],
  },
  'CMU-COL40': {
    code: 'CMU-COL40',
    name: '40cm Column Block',
    description:
      'Pilaster / column unit (390 × 190 × 390mm) for piers.',
    dimensions: { widthMm: 390, heightMm: 190, depthMm: 390 },
    roles: ['pier'],
  },
}

// ─── Brick library presets ─────────────────────────────────────────────────
// Region-specific because face sizes vary materially across markets. Users
// add their own custom bricks via the BrickLibraryPanel after seeding.

/** Standard AU brick set (matches the legacy seed library). */
export const AU_BRICK_LIBRARY: Record<BrickCode, BrickType> = {
  standard: {
    code: 'standard',
    name: 'Standard 230×76',
    description: 'The default Australian face brick. ~48 bricks/m².',
    widthMm: 230,
    heightMm: 76,
    depthMm: 110,
  },
  maxi: {
    code: 'maxi',
    name: 'Maxi 290×90',
    description: 'Larger format — wider and slightly taller. ~33 bricks/m².',
    widthMm: 290,
    heightMm: 90,
    depthMm: 110,
  },
  'double-height': {
    code: 'double-height',
    name: 'Double-height 230×162',
    description: 'Twice the height of a standard. ~24 bricks/m².',
    widthMm: 230,
    heightMm: 162,
    depthMm: 110,
  },
}

/** US modular face brick set. ~7 bricks/sq ft (~75/m²). */
export const US_BRICK_LIBRARY: Record<BrickCode, BrickType> = {
  modular: {
    code: 'modular',
    name: 'Modular 7-5/8" × 2-1/4"',
    description:
      'Standard US modular brick. 7-5/8" × 2-1/4" × 3-5/8" (~194 × 57 × 92mm). ' +
      'Roughly 6.86 bricks per sq ft (≈ 74 / m²).',
    widthMm: 194,
    heightMm: 57,
    depthMm: 92,
  },
  queen: {
    code: 'queen',
    name: 'Queen size 7-5/8" × 2-3/4"',
    description:
      'Queen brick — slightly taller face. 7-5/8" × 2-3/4" × 2-3/4" (~194 × 70 × 70mm). ' +
      '~5.76 bricks per sq ft (≈ 62 / m²).',
    widthMm: 194,
    heightMm: 70,
    depthMm: 70,
  },
  utility: {
    code: 'utility',
    name: 'Utility 11-5/8" × 3-5/8"',
    description:
      'Utility brick — large oversize for fast coverage. 11-5/8" × 3-5/8" × 3-5/8" ' +
      '(~295 × 92 × 92mm). ~3 bricks per sq ft (≈ 32 / m²).',
    widthMm: 295,
    heightMm: 92,
    depthMm: 92,
  },
}

/** UK standard face brick + popular alternatives. */
export const UK_BRICK_LIBRARY: Record<BrickCode, BrickType> = {
  standard: {
    code: 'standard',
    name: 'UK Standard 215×65',
    description:
      'BS EN 771 standard UK clay brick. 215 × 65 × 102.5mm with 10mm mortar ' +
      'joint gives the 225 × 75mm modular grid. ~60 bricks per m².',
    widthMm: 215,
    heightMm: 65,
    depthMm: 102.5,
  },
  imperial: {
    code: 'imperial',
    name: 'Imperial 215×73',
    description:
      'Older Imperial-equivalent brick used in conservation projects. 215 × 73 × ' +
      '102.5mm — works on a 225 × 83mm coursing grid.',
    widthMm: 215,
    heightMm: 73,
    depthMm: 102.5,
  },
}

/** NZ face brick set — shares the AU 230 × 76 format at 70mm bed depth. */
export const NZ_BRICK_LIBRARY: Record<BrickCode, BrickType> = {
  standard: {
    code: 'standard',
    name: 'Standard 230×76',
    description:
      'Standard NZ clay face brick, 230 × 76 × 70mm (veneer bed depth). ' +
      '~48 bricks/m² on a 10mm joint.',
    widthMm: 230,
    heightMm: 76,
    depthMm: 70,
  },
  longbrick: {
    code: 'longbrick',
    name: 'Long format 290×76',
    description:
      'Longer-format face brick (290 × 76 × 70mm). ~39 bricks/m².',
    widthMm: 290,
    heightMm: 76,
    depthMm: 70,
  },
}

/** Canadian face brick set — CSA metric sizes. */
export const CA_BRICK_LIBRARY: Record<BrickCode, BrickType> = {
  'metric-modular': {
    code: 'metric-modular',
    name: 'Metric Modular 190×57',
    description:
      'CSA metric modular brick, 190 × 57 × 90mm — the 200 × 67 modular ' +
      'grid. ~75 bricks/m².',
    widthMm: 190,
    heightMm: 57,
    depthMm: 90,
  },
  'metric-norman': {
    code: 'metric-norman',
    name: 'Metric Norman 290×57',
    description:
      'Long-format metric Norman, 290 × 57 × 90mm. ~50 bricks/m².',
    widthMm: 290,
    heightMm: 57,
    depthMm: 90,
  },
  jumbo: {
    code: 'jumbo',
    name: 'Metric Jumbo 290×90',
    description:
      'Oversize unit, 290 × 90 × 90mm — fast coverage. ~33 bricks/m².',
    widthMm: 290,
    heightMm: 90,
    depthMm: 90,
  },
}

// ─── Template registry ─────────────────────────────────────────────────────
// All templates exported as an ordered array so the region picker can
// iterate them in the order they should appear in the UI.

export const LIBRARY_TEMPLATES: LibraryTemplate[] = [
  {
    key: 'au-seq',
    displayName: 'Australia (SEQ)',
    region: 'AU',
    mortarJointMm: 10,
    description:
      'South-east QLD masonry block set — 20.48 H block body, 20.01 / 20.03 ' +
      'corners, 20.71 / 20.140 height makeup, 20.13 / 20.25 / 20.18 lintels, ' +
      '40.925 piers, 50.45 cleanout tiles, and the 300-series footing blocks. ' +
      'Bricks: 230×76 standard + maxi + double-height.',
    blocks: DEFAULT_BLOCK_LIBRARY,
    bricks: AU_BRICK_LIBRARY,
  },
  {
    key: 'nz-block',
    displayName: 'New Zealand (concrete masonry)',
    region: 'NZ',
    mortarJointMm: 10,
    description:
      'Firth hollow-masonry catalogue codes on the 400 × 200 modular ' +
      'grid — 10 / 15 / 20 / 25 series wholes and halves, H-series ' +
      'half-highs, 20.05 open end, 20.12 lintel, 20.16 bond beam, 20.30 ' +
      'column and 05.17 capping. Bricks: 230×76 standard + 290 long ' +
      'format.',
    blocks: NZ_BLOCK_LIBRARY,
    bricks: NZ_BRICK_LIBRARY,
  },
  {
    key: 'us-cmu',
    displayName: 'United States (CMU + modular)',
    region: 'US',
    mortarJointMm: 10, // 3/8" nominal
    description:
      'Full CMU range — 4" / 6" / 8" / 10" / 12" widths with corner, half, ' +
      'half-high, bond beam, open-end A block, solid cap, column block and ' +
      'three lintel sizes. Bricks: modular + queen + utility face brick.',
    blocks: US_CMU_LIBRARY,
    bricks: US_BRICK_LIBRARY,
  },
  {
    key: 'ca-cmu',
    displayName: 'Canada (metric CMU)',
    region: 'CA',
    mortarJointMm: 10,
    description:
      'CSA A165 metric block range — 10 / 15 / 20 / 25 / 30cm widths with ' +
      'halves, half-high, bond beam, open-end A block, solid cap, column ' +
      'block and three lintel depths. Bricks: metric modular + Norman + ' +
      'jumbo.',
    blocks: CA_CMU_LIBRARY,
    bricks: CA_BRICK_LIBRARY,
  },
  {
    key: 'uk-block',
    displayName: 'United Kingdom (concrete block + BS clay brick)',
    region: 'UK',
    mortarJointMm: 10,
    description:
      'Dense aggregate blocks in 100 / 140 / 215mm with aircrete ' +
      'alternatives, coursing bricks for height makeup, copings, and ' +
      'pre-stressed concrete lintels in 100 + 140mm widths. Bricks: 215×65 ' +
      'BS standard + 215×73 imperial.',
    blocks: UK_BLOCK_LIBRARY,
    bricks: UK_BRICK_LIBRARY,
  },
  {
    key: 'blank',
    displayName: 'Start blank',
    region: '—',
    mortarJointMm: 10,
    description:
      "No seed blocks or bricks — you'll add everything from scratch via " +
      'the material library page. Pick this only if none of the regional ' +
      "templates is close to your supplier's product range.",
    blocks: {},
    bricks: {},
  },
]

/** Look up a template by key. */
export function getLibraryTemplate(
  key: LibraryTemplateKey
): LibraryTemplate | undefined {
  return LIBRARY_TEMPLATES.find((t) => t.key === key)
}
