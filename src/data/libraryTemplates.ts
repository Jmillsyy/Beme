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
}

// ─── NZ — Concrete masonry (NZS 4210 / series convention) ──────────────────
// New Zealand masonry shares the 390 × 190 face and 10mm joint with AU
// (400 × 200 modular) and names blocks by a width-series convention:
// 10 series = 90mm, 15 series = 140mm, 20 series = 190mm wide. The 20
// series is seeded as the primary structural set with a 15-series body
// alongside. Seed codes follow the series convention — rename them to
// your supplier's exact catalogue codes from the library page.

export const NZ_BLOCK_LIBRARY: Record<BlockCode, Block> = {
  '20.01': {
    code: '20.01',
    name: '20 Series Whole Block',
    description:
      'Standard 390 × 190 × 190mm whole block — the main body unit, and ' +
      'the corner / end block in stretcher bond. Also doubles as the pier ' +
      'and base-course block (NZ practice grout-fills the base course ' +
      'rather than using a dedicated cleanout unit).',
    dimensions: { widthMm: 390, heightMm: 190, depthMm: 190 },
    roles: ['body', 'corner', 'end-termination', 'pier', 'base-course'],
  },
  '20.02': {
    code: '20.02',
    name: '20 Series Three-Quarter',
    description:
      'Three-quarter length (290mm face) closure block for non-modular ' +
      'wall lengths.',
    dimensions: { widthMm: 290, heightMm: 190, depthMm: 190 },
    roles: ['fraction'],
    fraction: 0.75,
  },
  '20.03': {
    code: '20.03',
    name: '20 Series Half Block',
    description:
      'Half-length (190mm face) block. Alternates with the whole block at ' +
      "free wall ends on even courses to hold stretcher bond's half-block " +
      'offset.',
    dimensions: { widthMm: 190, heightMm: 190, depthMm: 190 },
    roles: ['end-termination', 'fraction'],
    fraction: 0.5,
  },
  '20.04': {
    code: '20.04',
    name: '20 Series Half-High',
    description:
      'Half-height (90mm face) block — the height-makeup unit for wall ' +
      'heights that land off the 200mm course module.',
    dimensions: { widthMm: 390, heightMm: 90, depthMm: 190 },
    roles: ['height-makeup'],
  },
  '20.16': {
    code: '20.16',
    name: '20 Series Lintel / Bond Beam',
    description:
      'U-shaped lintel & bond-beam block — top course of reinforced walls ' +
      'and single-course lintels over openings (head heights to ~400mm).',
    dimensions: { widthMm: 390, heightMm: 190, depthMm: 190 },
    roles: ['top-course', 'lintel'],
    lintelMinHeadHeightMm: 0,
    lintelMaxHeadHeightMm: 400,
  },
  '20.16D': {
    code: '20.16D',
    name: '20 Series Deep Lintel',
    description:
      'Double-height (390mm) lintel arrangement for wide / heavy openings ' +
      '— covers head heights of 400mm and above.',
    dimensions: { widthMm: 390, heightMm: 390, depthMm: 190 },
    roles: ['lintel'],
    lintelMinHeadHeightMm: 400,
  },
  '15.01': {
    code: '15.01',
    name: '15 Series Whole Block',
    description:
      '140mm-wide whole block (390 × 190 × 140mm) for partition and ' +
      'veneer-backing walls.',
    dimensions: { widthMm: 390, heightMm: 190, depthMm: 140 },
    roles: ['body', 'corner', 'end-termination'],
  },
  '15.03': {
    code: '15.03',
    name: '15 Series Half Block',
    description: 'Half-length closure for the 15 series (190 × 190 × 140mm).',
    dimensions: { widthMm: 190, heightMm: 190, depthMm: 140 },
    roles: ['end-termination', 'fraction'],
    fraction: 0.5,
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
      'NZS-convention series blocks on the 400 × 200 modular grid — 20 ' +
      'series whole / three-quarter / half / half-high, 20.16 lintel & ' +
      'bond beam, plus a 15-series partition set. Bricks: 230×76 standard ' +
      '+ 290 long format. Rename seed codes to your supplier catalogue ' +
      'from the library page.',
    blocks: NZ_BLOCK_LIBRARY,
    bricks: NZ_BRICK_LIBRARY,
  },
  {
    key: 'us-cmu',
    displayName: 'United States (CMU + modular)',
    region: 'US',
    mortarJointMm: 10, // 3/8" nominal
    description:
      'Standard 8" Concrete Masonry Unit set — body, corner, half, bond ' +
      'beam, and three lintel sizes covering the typical head height range. ' +
      'Bricks: modular + queen + utility face brick. Add 6" / 10" / 12" CMUs ' +
      'from the library page if your projects use them.',
    blocks: US_CMU_LIBRARY,
    bricks: US_BRICK_LIBRARY,
  },
  {
    key: 'ca-cmu',
    displayName: 'Canada (metric CMU)',
    region: 'CA',
    mortarJointMm: 10,
    description:
      'CSA A165 metric block set — 20cm body / corner / half / half-high, ' +
      'bond beam, three lintel depths, and a 15cm partition body. Bricks: ' +
      'metric modular + Norman + jumbo. Add 25 / 30cm widths from the ' +
      'library page if your projects use them.',
    blocks: CA_CMU_LIBRARY,
    bricks: CA_BRICK_LIBRARY,
  },
  {
    key: 'uk-block',
    displayName: 'United Kingdom (concrete block + BS clay brick)',
    region: 'UK',
    mortarJointMm: 10,
    description:
      'Dense aggregate 100mm concrete block (440 × 215 × 100mm) with ' +
      'pre-stressed concrete lintels. Bricks: 215×65 BS standard + 215×73 ' +
      'imperial. Add 140 / 215mm thick blocks or aerated alternatives ' +
      'from the library page as needed.',
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
