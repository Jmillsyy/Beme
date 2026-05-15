/**
 * Block-related types for the beme block library.
 *
 * All measurements are in millimetres (mm). The block library entries are
 * defined in src/data/blockLibrary.ts.
 */

/**
 * Every block code recognised by beme.
 *
 * Codes match the masonry industry codes used in Australia (per the Project Brief).
 * If you add a new code here, also add it to BLOCK_LIBRARY.
 */
export type BlockCode =
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
  | '20.18' // Lintel >300mm head
  | '20.25' // Lintel 190–290mm head
  | '20.12' // Lintel standard ~200mm

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
  /** A block that's typically paired with this one (e.g. 20.45 ↔ 50.45). */
  pairedWith?: BlockCode
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
