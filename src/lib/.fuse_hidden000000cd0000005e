/**
 * Auto-assigned colour palette for wall types.
 *
 * Each wall makeup gets a distinct colour drawn from a fixed palette, picked
 * deterministically by its position in the makeups list. The same id always
 * resolves to the same colour for a given list, so the canvas swatch and the
 * Wall types panel swatch agree, and so re-renders don't flicker.
 *
 * The palette is hand-tuned for the Studio Black dark theme: saturated enough
 * to stand out on the PDF plan, light enough not to fight the brand orange,
 * and well-spaced around the colour wheel so neighbouring wall types are
 * easy to tell apart at a glance.
 *
 * If there are more wall types than palette entries, we wrap. Picking distinct
 * names + a paint-mixing mindset stays the user's job at that point.
 */

export const WALL_TYPE_PALETTE: readonly string[] = [
  '#ED7D31', // brand orange — first type uses this so existing projects look unchanged
  '#3B82F6', // blue
  '#10B981', // emerald
  '#A855F7', // purple
  '#F59E0B', // amber
  '#EC4899', // pink
  '#14B8A6', // teal
  '#84CC16', // lime
  '#EF4444', // red
  '#6366F1', // indigo
]

/**
 * Resolve the colour for a wall makeup given its id and the full ordered list.
 *
 * Returns a fallback colour if the id is not found in the list — this keeps
 * the canvas safe to render even while state is mid-update (e.g. just after a
 * delete, before the walls' makeupId has been migrated).
 */
export function wallTypeColor(
  makeupId: string,
  makeups: ReadonlyArray<{ id: string }>
): string {
  const idx = makeups.findIndex((m) => m.id === makeupId)
  if (idx < 0) return WALL_TYPE_PALETTE[0]
  return WALL_TYPE_PALETTE[idx % WALL_TYPE_PALETTE.length]
}

/**
 * Resolve a unique colour for ANY masonry-type id (wall makeup OR pier
 * makeup) across the project. Walls and piers share one colour
 * namespace — without this, a wall at index 0 and a pier at index 0
 * would both render orange, making them indistinguishable on the 2D
 * plan. We concatenate (walls, piers) into one ordered id list and
 * index the palette by the id's position in that combined list.
 *
 * Ordering rule: walls come first, then piers, both in their existing
 * panel order. So adding a new pier never re-paints existing walls,
 * and adding a new wall never re-paints existing piers (it just
 * shifts piers up by one palette slot).
 *
 * Returns palette[0] when the id is unknown, same defensive fallback
 * as wallTypeColor — safe to call mid-state-update.
 */
export function masonryTypeColor(
  typeId: string,
  wallMakeups: ReadonlyArray<{ id: string }>,
  pierMakeups: ReadonlyArray<{ id: string }>
): string {
  const inWalls = wallMakeups.findIndex((m) => m.id === typeId)
  if (inWalls >= 0) {
    return WALL_TYPE_PALETTE[inWalls % WALL_TYPE_PALETTE.length]
  }
  const inPiers = pierMakeups.findIndex((m) => m.id === typeId)
  if (inPiers >= 0) {
    const offset = wallMakeups.length + inPiers
    return WALL_TYPE_PALETTE[offset % WALL_TYPE_PALETTE.length]
  }
  return WALL_TYPE_PALETTE[0]
}

/**
 * Convert a `#RRGGBB` (or `#RGB`) hex colour to an rgba() string with the
 * given alpha. Used by the selection-highlight renderer to fade a wall
 * type's own colour into the selected-state fill — so a green-coded wall
 * highlights green, an orange-coded wall highlights orange, etc.
 *
 * Returns the original input unchanged when it isn't a hex colour (e.g.
 * a CSS keyword), so callers can pass user-supplied colours without first
 * normalising.
 */
export function hexToRgba(hex: string, alpha: number): string {
  if (typeof hex !== 'string' || !hex.startsWith('#')) return hex
  let r: number, g: number, b: number
  const stripped = hex.slice(1)
  if (stripped.length === 3) {
    r = parseInt(stripped[0] + stripped[0], 16)
    g = parseInt(stripped[1] + stripped[1], 16)
    b = parseInt(stripped[2] + stripped[2], 16)
  } else if (stripped.length === 6) {
    r = parseInt(stripped.slice(0, 2), 16)
    g = parseInt(stripped.slice(2, 4), 16)
    b = parseInt(stripped.slice(4, 6), 16)
  } else {
    return hex
  }
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return hex
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}
