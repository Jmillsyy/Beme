/**
 * Block-related types for the beme block library.
 *
 * All measurements are in millimetres (mm). The block library entries are
 * defined in src/data/blockLibrary.ts.
 */

/**
 * Block codes are user-editable strings. Users in different regions / countries
 * use different naming schemes (the SEQ QLD codes — 20.48, 20.01, etc. — are
 * just the defaults seeded for new users). A user can rename built-ins, add
 * new blocks, or remove ones they don't use.
 *
 * Code uniqueness is enforced at write time inside the library panel — two
 * blocks can't share the same code.
 */
export type BlockCode = string

/**
 * The built-in / "seed" codes shipped with the app. Used internally where the
 * calc engine needs to reach for a specific block (e.g. height-makeup courses
 * default to 20.71 / 20.140). End-user data is just `BlockCode` (string).
 */
export type BuiltInBlockCode =
  | '20.48' // H Block — main body
  | '20.01' // Standard Block — end terminations
  | '20.03' // Half Block — end terminations / 1/2 fraction
  | '20.03CW' // Curved-Wall Half Block — tight-radius curves
  | '20.71' // Half-Height (90mm) — height makeup
  | '20.140' // 140mm-High — height makeup
  | '20.45' // Cleanout — base course
  | '50.45' // Cleanout Tile — paired with 20.45
  | '20.02' // Three Quarter (3/4 fraction)
  | '20.22' // Seven Eighths (7/8 fraction)
  | '20.42' // Channel — legacy
  | '20.21' // Knockout Corner
  | '20.20' // Knockout — top course bond beam
  | '40.925' // 400mm Pier Block
  | '20.18' // Lintel ≥300mm head (stood up, 400mm tall modular)
  | '20.25' // Lintel 200–299mm head (stood up, 300mm tall modular)
  | '20.13' // Half lintel — heads <200mm (stood up, 200mm tall modular)
  | '20.12' // Standard lintel (laid flat, ~200mm high) — legacy
  // ── 300 series (290mm-deep, used on base courses where engineering calls for ──
  // a wider wall stepping down to standard 200 series above). Same face widths
  // and course heights as 200 series so they sit on a common 200mm modular grid;
  // only the wall thickness differs.
  | '30.48' // 300-series H Block — body
  | '30.01' // 300-series Standard Block — end terminations
  | '30.02' // 300-series Cube Block (290×190×290) — corner lead-in (×2 after a corner)
  | '30.03' // 300-series Half Block — end terminations / 1/2 fraction
  | '30.45' // 300-series Cleanout — base course
  | '30.71' // 300-series Half-Height (90mm) — height makeup

/**
 * Functional role(s) a block can play within a wall.
 * Most blocks have a single role; some (e.g. 20.03) have multiple.
 */
export type BlockRole =
  | 'body' // main course body block
  | 'end-termination' // at the end of a wall
  | 'fraction' // length makeup (3/4, 7/8, 1/2)
  | 'height-makeup' // for non-200mm-multiple wall heights
  | 'base-course' // bottom course of a wall
  | 'base-tile' // tile paired with cleanout blocks
  | 'top-course' // top course (e.g. bond beam)
  | 'corner' // at a wall corner
  | 'pier' // tied or freestanding pier
  | 'lintel' // over an opening
  | 'curve-tight' // for tight-radius curved walls
  | 'corner-lead-in' // inserted ×2 between a corner block and the body on 300-series courses to get back on bond
  | 'legacy' // older block superseded in most cases

/**
 * Physical dimensions of a block.
 *
 * widthMm is the face width (front face).
 * Some blocks (e.g. 20.03CW) are tapered — rearWidthMm captures the back width.
 */
export interface BlockDimensions {
  /** Face (front) width in mm */
  widthMm: number
  /** Course height in mm (typically 190, but 90 for 20.71 etc.) */
  heightMm: number
  /** Depth (wall thickness) in mm */
  depthMm: number
  /** Rear face width in mm — only for tapered blocks like 20.03CW */
  rearWidthMm?: number
}

/**
 * A block in the beme library.
 */
export interface Block {
  code: BlockCode
  /** Short human-readable name (e.g. "H Block") */
  name: string
  /** Use case / where it appears in a wall */
  description: string
  dimensions: BlockDimensions
  /** All roles this block can play. */
  roles: BlockRole[]
  /**
   * For fraction blocks, the fraction of a full body block this represents.
   * e.g. 0.75 for 20.02 (three-quarter), 0.5 for 20.03 (half).
   */
  fraction?: number
  /** A block that's typically paired with this one (e.g. 20.45 ↔ 50.45).
   *  Whenever this block is tallied, the calc engine also tallies the
   *  paired code at a ratio of `1 / pairedPer` items per this block.
   *  Library editors can set the pairing per-block so it applies
   *  everywhere — not just on the base course — and matches whatever
   *  the user's region calls for. */
  pairedWith?: BlockCode
  /**
   * How many of THIS block one paired block covers. 1 means 1:1
   * (one paired per one of this block — e.g. one 50.45 tile per
   * 20.45 cleanout). 2 means 1:2 (one paired per two of this block).
   * 3, 4, … similarly. Undefined defaults to 1:1.
   */
  pairedPer?: number
  /**
   * For lintel blocks ONLY: the head-height range this lintel covers, in mm.
   * `selectBlockLintel(headHeightMm)` walks every block with the `lintel`
   * role and picks the one whose range contains the given head height.
   * Lets each region's library carry its own lintel rules instead of the
   * AU 200 / 300mm thresholds being hard-coded in the calc engine.
   *
   * Convention: `lintelMinHeadHeightMm` is inclusive (a 200mm lintel with
   * min=200 covers a 200mm head), `lintelMaxHeadHeightMm` is exclusive
   * (max=300 covers up to but not including 300mm — anything ≥ 300 picks
   * the next size up). Leave `lintelMaxHeadHeightMm` undefined for the
   * largest lintel in the set (it's the upper-open bucket).
   */
  lintelMinHeadHeightMm?: number
  lintelMaxHeadHeightMm?: number
}

/**
 * The standard mortar joint thickness (mm).
 * One block + one mortar joint = "modular" length / height.
 */
export const DEFAULT_MORTAR_JOINT_MM = 10

/**
 * Standard "modular" length added per block when chained:
 * a 390mm 20.48 + 10mm mortar = 400mm modular length.
 */
export function modularLength(widthMm: number, mortarJointMm = DEFAULT_MORTAR_JOINT_MM): number {
  return widthMm + mortarJointMm
}

/**
 * Standard "modular" height per course: 190mm block + 10mm mortar = 200mm.
 */
export function modularHeight(heightMm: number, mortarJointMm = DEFAULT_MORTAR_JOINT_MM): number {
  return heightMm + mortarJointMm
}
