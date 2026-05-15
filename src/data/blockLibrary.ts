/**
 * The beme block library.
 *
 * Source of truth for every masonry block code beme understands. Block sizes,
 * descriptions, and roles are taken from the Project Brief (`docs/beme - Project Brief.docx`).
 *
 * All dimensions are in mm and refer to the block face viewed from the wall front.
 */

import type { Block, BlockCode, BlockRole } from '../types/blocks'

export const BLOCK_LIBRARY: Record<BlockCode, Block> = {
  '20.48': {
    code: '20.48',
    name: 'H Block',
    description:
      'Main body block used through the middle of most courses. Open ends allow full corefill ' +
      'top-to-bottom through the wall.',
    dimensions: { widthMm: 390, heightMm: 190, depthMm: 190 },
    roles: ['body'],
  },
  '20.01': {
    code: '20.01',
    name: 'Standard Block',
    description:
      'Standard end-termination block. Used at the ends of walls and at corners. In stretcher ' +
      'bond, alternates with 20.03 per course on free ends. In stack bond, may stack the full ' +
      'height of an end column.',
    dimensions: { widthMm: 390, heightMm: 190, depthMm: 190 },
    roles: ['end-termination', 'corner'],
  },
  '20.03': {
    code: '20.03',
    name: 'Half Block',
    description:
      'Half-length block. Primarily used at end terminations on alternating courses in ' +
      'stretcher bond to maintain the half-block offset. Technically also a 1/2 fraction but ' +
      'reserved for end terminations except where deliberately specified.',
    dimensions: { widthMm: 190, heightMm: 190, depthMm: 190 },
    roles: ['end-termination', 'fraction'],
    fraction: 0.5,
  },
  '20.03CW': {
    code: '20.03CW',
    name: 'Curved-Wall Half Block',
    description:
      'Tapered half block for tight-radius curved walls. Face is 190mm wide and the rear is ' +
      '140mm wide, allowing the blocks to nest around small radii.',
    dimensions: { widthMm: 190, heightMm: 190, depthMm: 190, rearWidthMm: 140 },
    roles: ['curve-tight'],
  },
  '20.71': {
    code: '20.71',
    name: 'Half-Height Block (90mm)',
    description:
      'Half-height block. Used to make up wall heights that are not multiples of 200mm. ' +
      'Typically placed second from the top course (e.g. for a 3100mm wall).',
    dimensions: { widthMm: 390, heightMm: 90, depthMm: 190 },
    roles: ['height-makeup'],
  },
  '20.140': {
    code: '20.140',
    name: '140mm-High Block',
    description:
      '140mm-high block. Used for 50mm height denominations (e.g. a 3150mm wall). Typically ' +
      'placed second from the top in place of a 20.48.',
    dimensions: { widthMm: 390, heightMm: 140, depthMm: 190 },
    roles: ['height-makeup'],
  },
  '20.45': {
    code: '20.45',
    name: 'Cleanout Block',
    description:
      'Base course block with a knockout for cleaning out core debris before grouting. Runs ' +
      'the entirety of the base course except at the ends.',
    dimensions: { widthMm: 390, heightMm: 190, depthMm: 190 },
    roles: ['base-course'],
    pairedWith: '50.45',
  },
  '50.45': {
    code: '50.45',
    name: 'Cleanout Tile',
    description: 'Cleanout tile, paired with every 20.45 in the base course.',
    dimensions: { widthMm: 390, heightMm: 190, depthMm: 190 },
    roles: ['base-tile'],
    pairedWith: '20.45',
  },
  '20.02': {
    code: '20.02',
    name: 'Three Quarter (3/4 Fraction)',
    description:
      '3/4-length fraction block used to absorb leftover wall length when "Fractions" is ' +
      'enabled, avoiding cuts. 290mm face width.',
    dimensions: { widthMm: 290, heightMm: 190, depthMm: 190 },
    roles: ['fraction'],
    fraction: 0.75,
  },
  '20.22': {
    code: '20.22',
    name: 'Seven Eighths (7/8 Fraction)',
    description:
      '7/8-length fraction block. Finer length makeup than 20.02 — combined with 20.02 on ' +
      'either end of a wall, the program can usually land within a few mm of the actual wall ' +
      'length without cuts.',
    dimensions: { widthMm: 340, heightMm: 190, depthMm: 190 },
    roles: ['fraction'],
    fraction: 0.875,
  },
  '20.42': {
    code: '20.42',
    name: 'Channel Block',
    description: 'Channel block, legacy. Superseded in most applications by the 20.48 H block.',
    dimensions: { widthMm: 390, heightMm: 190, depthMm: 190 },
    roles: ['legacy'],
  },
  '20.21': {
    code: '20.21',
    name: 'Knockout Corner Block',
    description:
      'Alternative to 20.01 at corners. Provides better corefill where extra reinforcement is ' +
      'required.',
    dimensions: { widthMm: 390, heightMm: 190, depthMm: 190 },
    roles: ['corner', 'end-termination'],
  },
  '20.20': {
    code: '20.20',
    name: 'Knockout Block',
    description:
      'Knockout block used on the top course to form a bond beam. Typically used when a slab ' +
      'is poured above for additional structural integrity.',
    dimensions: { widthMm: 390, heightMm: 190, depthMm: 190 },
    roles: ['top-course'],
  },
  '40.925': {
    code: '40.925',
    name: '400mm Pier Block',
    description:
      'Pier block. For tied piers (built into a wall) used every second course with 20.01 on ' +
      'alternating courses. For freestanding piers, stacked every course.',
    dimensions: { widthMm: 390, heightMm: 190, depthMm: 390 },
    roles: ['pier'],
  },
  '20.18': {
    code: '20.18',
    name: '400mm Lintel Block',
    description: 'Lintel block stacked vertically over openings with head heights greater than 300mm.',
    dimensions: { widthMm: 390, heightMm: 190, depthMm: 190 },
    roles: ['lintel'],
  },
  '20.25': {
    code: '20.25',
    name: '300mm Lintel Block',
    description: 'Lintel block for opening head heights between 190mm and 290mm.',
    dimensions: { widthMm: 290, heightMm: 190, depthMm: 190 },
    roles: ['lintel'],
  },
  '20.12': {
    code: '20.12',
    name: 'Standard Lintel Block',
    description:
      'Lintel stacked normally across the head at ~200mm. Less common than 20.18 / 20.25.',
    dimensions: { widthMm: 390, heightMm: 190, depthMm: 190 },
    roles: ['lintel'],
  },
}

// ---------- Helpers ----------

/** Look up a single block by code. */
export function getBlock(code: BlockCode): Block {
  return BLOCK_LIBRARY[code]
}

/** All blocks that can play a given role. */
export function getBlocksByRole(role: BlockRole): Block[] {
  return Object.values(BLOCK_LIBRARY).filter((b) => b.roles.includes(role))
}

/**
 * Fraction blocks available for length makeup, in ascending order of fraction.
 * Excludes 20.03 — it's technically a 1/2 fraction but reserved for end terminations.
 */
export function getFractionBlocksForLengthMakeup(): Block[] {
  return Object.values(BLOCK_LIBRARY)
    .filter((b) => b.fraction !== undefined && b.code !== '20.03')
    .sort((a, b) => (a.fraction ?? 0) - (b.fraction ?? 0))
}
