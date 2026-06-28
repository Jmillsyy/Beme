/**
 * The Beme brand mark - two orange rounded blocks side by side with
 * their centres cut clean through (true transparency, not a dark inset),
 * so the mark sits cleanly on any surface. Matches the marketing site.
 *
 * Why a single path with `evenodd`: the holes are subtracted from the
 * outer frame in one fill, so the centres are GENUINELY transparent (the
 * surface behind shows through) with no theme-tracking inset colour to
 * mismatch on cards or hover treatments.
 *
 * Colour comes from `currentColor`, so the consuming wrapper drives it
 * via `text-beme-500` (or hover `text-beme-400`, etc).
 *
 * Shape: the mark is naturally wide (104×56). `wide` renders it that
 * way for header lockups; the default centres it in a square footprint
 * so square slots (collapsed nav rail, spinning loader, favicon) fit.
 */
export default function BemeMark({
  size = 32,
  wide = false,
  className,
}: {
  /** Rendered HEIGHT in CSS pixels. Default 32 keeps the same vertical
   * footprint as the legacy square mark, so it drops into every slot
   * (header, collapsed nav rail, loaders) without shifting layout. */
  size?: number
  /** Draw the full edge-to-edge two-block mark (for header lockups next
   * to the wordmark). Default false renders the same mark centred in a
   * SQUARE footprint, so square slots - the collapsed nav rail, the
   * spinning loader, the favicon - don't overflow or wobble. */
  wide?: boolean
  className?: string
}) {
  const ASPECT = 104 / 56
  return (
    <svg
      // Wide: the mark's natural 104×56 frame. Square (default): the same
      // frame centred in a 104×104 box (min-y -24) so width === height.
      viewBox={wide ? '0 0 104 56' : '0 -24 104 104'}
      width={wide ? Math.round(size * ASPECT) : size}
      height={size}
      className={className}
      aria-hidden="true"
      role="img"
    >
      {/* Outer rounded frame plus two square holes; fill-rule evenodd
          subtracts the holes so the centres are genuinely transparent and
          currentColor drives the orange via the wrapper's text colour. */}
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        fill="currentColor"
        d="M9 0 H95 A9 9 0 0 1 104 9 V47 A9 9 0 0 1 95 56 H9 A9 9 0 0 1 0 47 V9 A9 9 0 0 1 9 0 Z M15 11 H42 A4 4 0 0 1 46 15 V41 A4 4 0 0 1 42 45 H15 A4 4 0 0 1 11 41 V15 A4 4 0 0 1 15 11 Z M62 11 H89 A4 4 0 0 1 93 15 V41 A4 4 0 0 1 89 45 H62 A4 4 0 0 1 58 41 V15 A4 4 0 0 1 62 11 Z"
      />
    </svg>
  )
}
