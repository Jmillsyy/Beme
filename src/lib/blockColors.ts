/**
 * Stable, distinct colours for block codes.
 *
 * Used by:
 *   - WallTypesPanel's wall preview + legend (single makeup, ~5-15 codes)
 *   - WorkspaceView3D's per-band wall colouring (whole project, up to ~30
 *     codes across all walls)
 *
 * Two functions:
 *   - `bandColor(code)`         — hash → curated palette slot. Fast but
 *     two codes can collide on the same slot (about 1-in-16). Use this
 *     in standalone scopes where collisions aren't visible (e.g. the
 *     pier preview, makeup list).
 *   - `buildBlockColorMap(codes)` — for a known set of codes, returns a
 *     Map<code, color> that GUARANTEES no two codes share a slot (until
 *     the input exceeds the palette size). Sort + walk-forward
 *     collision avoidance. Use this anywhere multiple codes appear in
 *     the same render and could be visually confused.
 *
 * Both share the same 16-slot HSL palette — colours chosen for maximum
 * perceptual distance with alternating saturation/lightness so even
 * adjacent slots read distinctly. 16 hues span the wheel in ~22°
 * increments (16 × 22.5 = 360).
 */

/** Named palette set. Each palette is a 16-slot array — same shape /
 *  same semantics as the single original palette below. `bandColor`
 *  and `buildBlockColorMap` pick which palette to sample by name. */
export type PaletteName = 'concrete' | 'brick' | 'sandstone' | 'slate' | 'vibrant'

/** 16-slot realistic-masonry palette. Order matters —
 *  buildBlockColorMap walks forward on collision, so visually-near
 *  lightnesses should not be adjacent.
 *
 *  All slots are concrete-grey tones: saturation 4–14% (essentially
 *  neutral, with a faint warm/cool cast so adjacent codes don't blur),
 *  lightness 38–76% (spread across the full grey range so different
 *  block codes are still distinguishable at a glance).
 *
 *  Reads as actual stacked concrete blockwork rather than a
 *  colour-coded diagram. Different wall types using the same block
 *  code still land on the same slot via buildBlockColorMap's code-keyed
 *  dedupe. */
export const BAND_COLOR_PALETTE: string[] = [
  'hsl( 32,  8%, 62%)', // 1  warm mid grey   — default-ish concrete
  'hsl(210, 10%, 50%)', // 2  cool mid grey
  'hsl( 38,  6%, 72%)', // 3  pale buff
  'hsl(218, 12%, 40%)', // 4  dark slate
  'hsl( 28, 12%, 55%)', // 5  warm grey
  'hsl(200,  8%, 68%)', // 6  light cool grey
  'hsl( 35, 14%, 44%)', // 7  deep taupe
  'hsl(220, 10%, 75%)', // 8  pale stone
  'hsl( 40,  6%, 60%)', // 9  sandy grey
  'hsl(215, 14%, 38%)', // 10 charcoal slate
  'hsl( 30, 10%, 48%)', // 11 mushroom
  'hsl(225,  6%, 66%)', // 12 neutral light grey
  'hsl( 36, 12%, 52%)', // 13 sandstone
  'hsl(208,  4%, 56%)', // 14 plain grey
  'hsl( 42,  8%, 76%)', // 15 bone
  'hsl(215,  8%, 46%)', // 16 graphite
]

/** Brick / clay tones — saturated reds, oranges, terracottas. */
const BAND_COLOR_PALETTE_BRICK: string[] = [
  'hsl( 12, 42%, 46%)', // 1  classic red brick
  'hsl( 22, 36%, 58%)', // 2  warm terracotta
  'hsl(  8, 32%, 38%)', // 3  deep oxblood
  'hsl( 28, 28%, 64%)', // 4  pale clay
  'hsl( 16, 38%, 52%)', // 5  burnt sienna
  'hsl(  6, 24%, 30%)', // 6  charcoal-burnt brick
  'hsl( 24, 30%, 50%)', // 7  rust
  'hsl( 18, 44%, 56%)', // 8  bright firebrick
  'hsl( 14, 26%, 42%)', // 9  dusty red
  'hsl( 32, 22%, 60%)', // 10 buff
  'hsl( 10, 36%, 48%)', // 11 paprika
  'hsl( 20, 40%, 64%)', // 12 salmon brick
  'hsl(  4, 28%, 34%)', // 13 wine
  'hsl( 26, 24%, 54%)', // 14 sandy clay
  'hsl( 18, 32%, 44%)', // 15 mahogany
  'hsl( 30, 18%, 38%)', // 16 dark taupe
]

/** Warm sandstone — buffs, tans, soft yellows. */
const BAND_COLOR_PALETTE_SANDSTONE: string[] = [
  'hsl( 38, 30%, 64%)', // 1  classic sandstone
  'hsl( 42, 22%, 56%)', // 2  warm tan
  'hsl( 34, 36%, 72%)', // 3  pale honey
  'hsl( 46, 26%, 48%)', // 4  ochre
  'hsl( 40, 24%, 58%)', // 5  buff
  'hsl( 32, 18%, 44%)', // 6  deep tan
  'hsl( 44, 32%, 68%)', // 7  cream
  'hsl( 36, 20%, 52%)', // 8  mushroom
  'hsl( 48, 28%, 60%)', // 9  wheat
  'hsl( 30, 16%, 40%)', // 10 dark sandstone
  'hsl( 42, 30%, 76%)', // 11 pale cream
  'hsl( 38, 26%, 50%)', // 12 sand
  'hsl( 46, 22%, 44%)', // 13 dark ochre
  'hsl( 34, 20%, 56%)', // 14 fawn
  'hsl( 40, 28%, 70%)', // 15 light buff
  'hsl( 36, 16%, 48%)', // 16 stone
]

/** Cool slate / blue-grey tones — natural stone, dark masonry. */
const BAND_COLOR_PALETTE_SLATE: string[] = [
  'hsl(215, 18%, 42%)', // 1  classic slate
  'hsl(200, 14%, 56%)', // 2  cool grey-blue
  'hsl(220, 22%, 32%)', // 3  deep slate
  'hsl(210, 12%, 64%)', // 4  pale slate
  'hsl(225, 18%, 46%)', // 5  navy slate
  'hsl(195, 16%, 52%)', // 6  steel
  'hsl(230, 20%, 38%)', // 7  blue-black
  'hsl(205, 10%, 60%)', // 8  light steel
  'hsl(218, 14%, 48%)', // 9  blueish grey
  'hsl(190,  8%, 44%)', // 10 dark cyan-grey
  'hsl(222, 24%, 28%)', // 11 graphite
  'hsl(208, 14%, 58%)', // 12 mist
  'hsl(216, 20%, 50%)', // 13 ocean slate
  'hsl(228, 12%, 42%)', // 14 indigo grey
  'hsl(200, 18%, 36%)', // 15 deep teal
  'hsl(212, 16%, 66%)', // 16 pale blue
]

/** Vibrant — pulls the same hand-tuned bright tones used by the wall
 *  type swatches in the side panels (WALL_TYPE_PALETTE in
 *  wallTypeColors.ts), then extends with 6 more in the same family so
 *  there's a full 16 slots for distinct block / brick codes. Reads as
 *  "colour-coded diagram" rather than realistic masonry — useful when
 *  the user wants to see every code as a distinct hue. */
const BAND_COLOR_PALETTE_VIBRANT: string[] = [
  '#ED7D31', // 1  brand orange
  '#3B82F6', // 2  blue
  '#10B981', // 3  emerald
  '#A855F7', // 4  purple
  '#F59E0B', // 5  amber
  '#EC4899', // 6  pink
  '#14B8A6', // 7  teal
  '#84CC16', // 8  lime
  '#EF4444', // 9  red
  '#6366F1', // 10 indigo
  '#06B6D4', // 11 cyan
  '#F97316', // 12 deep orange
  '#8B5CF6', // 13 violet
  '#22C55E', // 14 green
  '#F43F5E', // 15 rose
  '#0EA5E9', // 16 sky blue
]

/** Palette-name → 16-slot palette lookup. Default 'concrete' for
 *  backwards compatibility with single-palette callers. */
export const BAND_COLOR_PALETTES: Record<PaletteName, string[]> = {
  concrete: BAND_COLOR_PALETTE,
  brick: BAND_COLOR_PALETTE_BRICK,
  sandstone: BAND_COLOR_PALETTE_SANDSTONE,
  slate: BAND_COLOR_PALETTE_SLATE,
  vibrant: BAND_COLOR_PALETTE_VIBRANT,
}

/** Human-readable names for each palette — used by the picker UI. */
export const PALETTE_LABELS: Record<PaletteName, string> = {
  concrete: 'Concrete',
  brick: 'Brick',
  sandstone: 'Sandstone',
  slate: 'Slate',
  vibrant: 'Vibrant',
}

/** Internal: FNV-1a + xorshift-spread → 32-bit hash. Same input always
 *  yields the same output, with each character propagating through the
 *  full bit space (so single-char differences land on a different slot
 *  most of the time). */
function hashCode(code: string): number {
  let h = 0x811c9dc5 // FNV-1a offset basis
  for (let i = 0; i < code.length; i++) {
    h ^= code.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
    h ^= h >>> 15
    h = Math.imul(h, 0x85ebca6b)
    h ^= h >>> 13
    h = Math.imul(h, 0xc2b2ae35)
    h ^= h >>> 16
  }
  return h >>> 0
}

/**
 * Hash-only colour resolver. The same code always returns the same
 * hue. Collisions possible — two codes can land on the same palette
 * slot (about 1-in-16 chance). Use for scopes where multiple codes
 * don't need to be visually distinct from each other.
 */
export function bandColor(code: string, palette: PaletteName = 'concrete'): string {
  const slots = BAND_COLOR_PALETTES[palette] ?? BAND_COLOR_PALETTE
  return slots[hashCode(code) % slots.length]
}

/**
 * Collision-free colour map for a known set of codes.
 *
 * Sorts the unique codes alphabetically (stable across re-renders),
 * then for each code seeds at the hash's preferred slot and walks
 * forward through the palette until it finds an unused slot. So:
 *   - codes added independently still tend to land on their "natural"
 *     hue (so the visual identity stays familiar);
 *   - no two codes in the input set ever share a slot, until the
 *     input exceeds the palette size — after which slots wrap and
 *     can repeat (rare in practice for a single project).
 */
export function buildBlockColorMap(
  codes: string[],
  palette: PaletteName = 'concrete'
): Map<string, string> {
  const slots = BAND_COLOR_PALETTES[palette] ?? BAND_COLOR_PALETTE
  const unique = Array.from(new Set(codes.filter(Boolean))).sort()
  const taken = new Set<number>()
  const map = new Map<string, string>()
  for (const code of unique) {
    let idx = hashCode(code) % slots.length
    let attempts = 0
    while (taken.has(idx) && attempts < slots.length) {
      idx = (idx + 1) % slots.length
      attempts++
    }
    taken.add(idx)
    map.set(code, slots[idx])
  }
  return map
}
