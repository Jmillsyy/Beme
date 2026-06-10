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
export type PaletteName = 'mono' | 'concrete' | 'brick' | 'sandstone' | 'slate' | 'vibrant'

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

/** Brick / clay tones — terracotta-dominant, no brown. Hues sit in
 *  the 14–28° band (orange-red baked clay through warm sienna),
 *  saturations 46–64% so slots stay vivid and warm. Lightness floor
 *  raised to ~44% so even the darker slots read as deep terracotta /
 *  paprika rather than the muddy browns the previous palette had.
 *  No slot dips into the dark-brown / mahogany zone. */
const BAND_COLOR_PALETTE_BRICK: string[] = [
  'hsl( 18, 58%, 50%)', // 1  classic terracotta
  'hsl( 22, 50%, 60%)', // 2  warm clay
  'hsl( 16, 62%, 46%)', // 3  burnt terracotta
  'hsl( 24, 46%, 68%)', // 4  pale buff terracotta
  'hsl( 20, 60%, 54%)', // 5  vivid baked clay
  'hsl( 14, 58%, 44%)', // 6  deep terracotta
  'hsl( 26, 48%, 52%)', // 7  pottery clay
  'hsl( 16, 64%, 58%)', // 8  bright terracotta
  'hsl( 14, 52%, 50%)', // 9  classic flowerpot
  'hsl( 28, 42%, 66%)', // 10 soft sandstone clay
  'hsl( 20, 58%, 48%)', // 11 paprika clay
  'hsl( 22, 54%, 62%)', // 12 coral terracotta
  'hsl( 18, 56%, 46%)', // 13 rich baked clay
  'hsl( 26, 46%, 56%)', // 14 baked sienna
  'hsl( 16, 54%, 52%)', // 15 warm sienna
  'hsl( 24, 48%, 58%)', // 16 dusty rose terracotta
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

/** Vibrant — saturated, varied tones across the full hue wheel for
 *  maximum visual distinction between codes. Modelled after the
 *  takeoff-diagram style used by The Brick Counter et al — every
 *  code reads as a distinct, bold hue so you can scan a 3D model
 *  and see "that wall type is the red one" instantly. Reads as
 *  "colour-coded diagram" rather than realistic masonry. Default
 *  palette for the 3D view because the diagrammatic clarity beats
 *  realism for an estimating tool. */
const BAND_COLOR_PALETTE_VIBRANT: string[] = [
  '#E53935', // 1  bright red
  '#26C6DA', // 2  cyan
  '#FFB300', // 3  amber / mustard
  '#7CB342', // 4  lime green
  '#EC407A', // 5  magenta-pink
  '#5E35B1', // 6  deep purple
  '#FB8C00', // 7  vivid orange
  '#1E88E5', // 8  royal blue
  '#43A047', // 9  green
  '#8E24AA', // 10 violet
  '#FDD835', // 11 yellow
  '#00ACC1', // 12 teal
  '#F06292', // 13 pink
  '#3949AB', // 14 indigo
  '#6D4C41', // 15 chocolate brown
  '#C0CA33', // 16 olive
]

/** 16-slot Mono palette — matches the site's brand language
 *  (orange + black + white + neutral grays). Interleaves brand-orange
 *  tones with zinc grays so adjacent palette slots don't share a
 *  family; the hash spreads codes across the whole 16 so two block
 *  codes in the same project still read as distinct hues even though
 *  the overall feel is monochromatic. Use this when you want the 3D
 *  view to read as "part of the Beme app" rather than a
 *  colour-coded diagram. */
const BAND_COLOR_PALETTE_MONO: string[] = [
  '#ff7a2d', // 1  brand orange (beme-500)
  '#27272a', // 2  near-black (zinc-800)
  '#d4d4d8', // 3  light gray (zinc-300)
  '#fb923c', // 4  light orange (orange-400)
  '#71717a', // 5  mid gray (zinc-500)
  '#fdba74', // 6  pale orange (orange-300)
  '#18181b', // 7  black (zinc-900)
  '#fed7aa', // 8  peach (orange-200)
  '#52525b', // 9  charcoal (zinc-600)
  '#ea580c', // 10 deep orange (orange-600)
  '#a1a1aa', // 11 mid-light gray (zinc-400)
  '#c2410c', // 12 rust (orange-700)
  '#3f3f46', // 13 deep charcoal (zinc-700)
  '#e4e4e7', // 14 light gray (zinc-200)
  '#f97316', // 15 vivid orange (orange-500)
  '#ffedd5', // 16 cream-peach (orange-100)
]

/** Palette-name → 16-slot palette lookup. Default 'mono' so a fresh
 *  install renders in the brand palette; legacy palettes remain
 *  selectable through the picker. */
export const BAND_COLOR_PALETTES: Record<PaletteName, string[]> = {
  mono: BAND_COLOR_PALETTE_MONO,
  concrete: BAND_COLOR_PALETTE,
  brick: BAND_COLOR_PALETTE_BRICK,
  sandstone: BAND_COLOR_PALETTE_SANDSTONE,
  slate: BAND_COLOR_PALETTE_SLATE,
  vibrant: BAND_COLOR_PALETTE_VIBRANT,
}

/** Human-readable names for each palette — used by the picker UI. */
export const PALETTE_LABELS: Record<PaletteName, string> = {
  mono: 'Mono',
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
export function bandColor(code: string, palette: PaletteName = 'mono'): string {
  const slots = BAND_COLOR_PALETTES[palette] ?? BAND_COLOR_PALETTE
  return slots[hashCode(code) % slots.length]
}

/**
 * Pure hash → colour map for a known set of codes.
 *
 * Every code lands on its hash-derived palette slot — the same slot
 * it would land on in any other project. So `20.48` is always red,
 * `20.01` is always royal blue, etc., regardless of which other
 * codes are present. The cross-project consistency lets you scan
 * any 3D view and recognise "the body block by colour" without
 * having to check the legend each time.
 *
 * Trade-off: when two codes happen to hash to the same slot, both
 * will share that colour within the project. With 16 slots and a
 * typical project carrying 5-10 distinct codes the collision chance
 * is small (~1-in-16 per code added beyond the first). When it
 * happens, the legend still disambiguates them by name — the colour
 * just isn't unique inside that one project.
 *
 * The previous behaviour (walk-forward collision avoidance) gave
 * uniqueness within a project but meant a code's colour depended on
 * which other codes were present alongside it — so the same code
 * could be different colours in different projects. Tradies asked
 * for the colour identity to be PER-CODE, not per-project.
 */
export function buildBlockColorMap(
  codes: string[],
  palette: PaletteName = 'mono'
): Map<string, string> {
  const slots = BAND_COLOR_PALETTES[palette] ?? BAND_COLOR_PALETTE
  const unique = Array.from(new Set(codes.filter(Boolean)))
  const map = new Map<string, string>()
  for (const code of unique) {
    const idx = hashCode(code) % slots.length
    map.set(code, slots[idx])
  }
  return map
}
