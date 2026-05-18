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
