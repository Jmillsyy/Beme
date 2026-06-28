/**
 * The Beme logo lockup - the two-block mark and the BEME wordmark drawn as
 * ONE inline SVG. Because the spacing, sizes and vertical alignment are baked
 * into the SVG's 256x56 coordinate space (not CSS flex / line-height), the
 * lockup renders byte-for-byte identically here and on the marketing site,
 * which carries the same artwork. The exact same paths live in the saved
 * asset at /beme-logo.svg (and /beme-logo-on-dark.svg) for use outside the app.
 *
 * The mark is fixed brand orange. The wordmark uses `currentColor`, so it
 * takes the surrounding text colour - defaulting to ink-50 for the dark app
 * chrome; pass a `className` like `text-ink-900` to recolour on light
 * surfaces.
 *
 * `size` is the rendered HEIGHT of the mark band in px; the whole lockup
 * scales as one unit off it (width = size * 256/56).
 */
export default function BemeLogo({
  size = 28,
  className = '',
}: {
  size?: number
  className?: string
}) {
  return (
    <svg
      viewBox="0 0 256 56"
      height={size}
      width={Math.round((size * 256) / 56)}
      className={`text-ink-50 group-hover:brightness-110 transition ${className}`}
      role="img"
      aria-label="Beme"
    >
      <path
        fill="#ff7a2d"
        fillRule="evenodd"
        clipRule="evenodd"
        d="M9 0 H95 A9 9 0 0 1 104 9 V47 A9 9 0 0 1 95 56 H9 A9 9 0 0 1 0 47 V9 A9 9 0 0 1 9 0 Z M15 11 H42 A4 4 0 0 1 46 15 V41 A4 4 0 0 1 42 45 H15 A4 4 0 0 1 11 41 V15 A4 4 0 0 1 15 11 Z M62 11 H89 A4 4 0 0 1 93 15 V41 A4 4 0 0 1 89 45 H62 A4 4 0 0 1 58 41 V15 A4 4 0 0 1 62 11 Z"
      />
      <text
        x="126"
        y="29"
        dominantBaseline="central"
        fontFamily="'Hanken Grotesk', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
        fontWeight="700"
        fontSize="44"
        letterSpacing="0.88"
        fill="currentColor"
      >
        BEME
      </text>
    </svg>
  )
}
