/**
 * Role-based colour scheme shared across the 2D wall preview, the 3D
 * view, and the slot picker dots in the wall types modal.
 *
 * The 3D view used to colour each block by its library CODE (via
 * bandColor + a per-code palette slot). That meant two walls with
 * different body codes rendered as different hues even though the
 * masonry "shape" of the wall — body courses with corner ends and
 * half-blocks alternating on free ends — was identical. Users
 * wanted the visual to read the same way as the 2D preview: body
 * blocks blue, corners red, halves green, etc, regardless of which
 * specific block code fills the slot. Same colour scheme = same
 * mental model across the two views.
 *
 * Six fixed hues, each ~60° apart on the wheel so they read as six
 * clearly different roles at a glance. Tailwind 500-ish saturations
 * so they sit well on both the dark ink (3D scene background) and
 * the light cream (modal background).
 */

export type SlotRole = 'body' | 'corner' | 'half' | 'base' | 'top' | 'cap'

export const ROLE_COLORS: Record<SlotRole, string> = {
  body: '#3B82F6',   // blue-500
  corner: '#EF4444', // red-500
  half: '#10B981',   // emerald-500
  base: '#F59E0B',   // amber-500
  top: '#8B5CF6',    // violet-500
  cap: '#EC4899',    // pink-500
}

export const ROLE_LABELS: Record<SlotRole, string> = {
  body: 'Body',
  corner: 'Full end',
  half: 'Half end',
  base: 'Base',
  top: 'Top',
  cap: 'Cap',
}
