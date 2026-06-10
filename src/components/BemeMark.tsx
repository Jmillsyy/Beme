/**
 * The canonical Beme brand mark — orange rounded square with a dark
 * inset square cut from the middle. Sourced from `/public/favicon.svg`
 * so every rendering across the app uses the same exact geometry.
 *
 * Why an SVG instead of two nested divs:
 *   • The div-based version we had across LeftNav, AppShell, BemeLoader
 *     and others used `inset-[Npx]` + `rounded-[Mpx]` to approximate
 *     the mark. Each call site picked a slightly different N / M for
 *     its target size, so a w-11 instance had different proportions
 *     to a w-10 instance, and sub-pixel rounding made the inner
 *     square look subtly off-centre at certain sizes.
 *   • An SVG keeps the geometry exact at every size — no rounding
 *     artifacts, no per-component proportion drift.
 *
 * Colours:
 *   • Outer rect uses `currentColor` so the consuming wrapper drives
 *     it via `text-beme-500` (or hover `text-beme-400`, etc).
 *   • Inner rect uses the `--color-ink-900` token so it tracks the
 *     theme automatically — dark inset in dark mode, light inset
 *     would be wrong (the mark stays orange/dark even in light
 *     theme, matching the favicon).
 */
export default function BemeMark({
  size = 32,
  className,
}: {
  /** Rendered edge length in CSS pixels. Default 32 matches the
   *  legacy `<div className="w-[32px] h-[32px]" />` mark size so the
   *  drop-in replacement is invisible to layouts that hard-coded
   *  around that dimension. */
  size?: number
  className?: string
}) {
  return (
    <svg
      viewBox="0 0 64 64"
      width={size}
      height={size}
      className={className}
      aria-hidden="true"
      role="img"
    >
      {/* Outer rounded square — orange brand fill via currentColor so
          a parent wrapper's text-* class drives it. */}
      <rect x="0" y="0" width="64" height="64" rx="12" ry="12" fill="currentColor" />
      {/* Inner dark inset — 12px inset on all sides, sliughtly less
          pronounced corner radius (5px on a 40px square) so the
          mark reads as "square with a square hole" rather than two
          nested rounded shapes. */}
      <rect x="12" y="12" width="40" height="40" rx="5" ry="5" fill="#0E0E10" />
    </svg>
  )
}
