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
export function bandColor(code: string): string {
  return BAND_COLOR_PALETTE[hashCode(code) % BAND_COLOR_PALETTE.length]
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
export function buildBlockColorMap(codes: string[]): Map<string, string> {
  const unique = Array.from(new Set(codes.filter(Boolean))).sort()
  const taken = new Set<number>()
  const map = new Map<string, string>()
  for (const code of unique) {
    let idx = hashCode(code) % BAND_COLOR_PALETTE.length
    let attempts = 0
    while (taken.has(idx) && attempts < BAND_COLOR_PALETTE.length) {
      idx = (idx + 1) % BAND_COLOR_PALETTE.length
      attempts++
    }
    taken.add(idx)
    map.set(code, BAND_COLOR_PALETTE[idx])
  }
  return map
}
