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
import { DEFAULT_BLOCK_LIBRARY } from './blockLibrary'

/** Discriminator key — stored on the user / org to pick a template. */
export type LibraryTemplateKey = 'au-seq' | 'us-cmu' | 'uk-block' | 'blank'

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
   * The seed library. Stored as Record<BlockCode, Block> so the calc
   * engine and library page can treat it identically to the current
   * BLOCK_LIBRARY shape.
   */
  blocks: Record<BlockCode, Block>
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
      'them interchangeably for tally purposes.',
    dimensions: { widthMm: 397, heightMm: 194, depthMm: 194 },
    roles: ['body'],
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
      'body course block.',
    dimensions: { widthMm: 440, heightMm: 215, depthMm: 100 },
    roles: ['body'],
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
      '40.925 piers, 50.45 cleanout tiles, and the 300-series footing blocks.',
    blocks: DEFAULT_BLOCK_LIBRARY,
  },
  {
    key: 'us-cmu',
    displayName: 'United States (CMU)',
    region: 'US',
    mortarJointMm: 10, // 3/8" nominal
    description:
      'Standard 8" Concrete Masonry Unit set — body, corner, half, bond ' +
      'beam, and three lintel sizes covering the typical head height range. ' +
      'Add 6" / 10" / 12" CMUs from the library page if your projects use them.',
    blocks: US_CMU_LIBRARY,
  },
  {
    key: 'uk-block',
    displayName: 'United Kingdom (concrete block)',
    region: 'UK',
    mortarJointMm: 10,
    description:
      'Dense aggregate 100mm concrete block (440 × 215 × 100mm) with ' +
      'pre-stressed concrete lintels. Add 140 / 215mm thick blocks or ' +
      'aerated alternatives from the library page as needed.',
    blocks: UK_BLOCK_LIBRARY,
  },
  {
    key: 'blank',
    displayName: 'Start blank',
    region: '—',
    mortarJointMm: 10,
    description:
      "No seed blocks — you'll add everything from scratch via the " +
      'material library page. Pick this only if none of the regional ' +
      "templates is close to your supplier's product range.",
    blocks: {},
  },
]

/** Look up a template by key. */
export function getLibraryTemplate(
  key: LibraryTemplateKey
): LibraryTemplate | undefined {
  return LIBRARY_TEMPLATES.find((t) => t.key === key)
}
