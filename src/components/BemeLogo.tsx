import BemeMark from './BemeMark'

/**
 * The Beme header lockup - the two-block mark followed by the BEME
 * wordmark, locked to one set of proportions so every header renders
 * identically. These values mirror the marketing site's nav lockup
 * exactly (mark 28 high, wordmark 22, 0.02em tracking, 11px gap) so the
 * app and bemeapp.app read as the same brand. Use this anywhere the mark
 * sits next to the word; the bare mark (favicon, nav rail, loader) keeps
 * using BemeMark directly.
 *
 * Callers wrap this in their own <Link> / <a>; it renders no link itself.
 * Drop it inside an element with the `group` class to get the mark's
 * hover colour shift (beme-500 to beme-400).
 *
 * `size` is the mark HEIGHT in px. The wordmark size and the mark-to-word
 * gap are tied to it (22 / 11 at the canonical 28) so the lockup scales
 * as a single unit if a surface ever needs a larger mark.
 */
export default function BemeLogo({
  size = 28,
}: {
  size?: number
}) {
  const wordPx = Math.round((size * 22) / 28)
  const gapPx = Math.round((size * 11) / 28)
  return (
    <span className="inline-flex items-center" style={{ gap: `${gapPx}px` }}>
      <span className="text-beme-500 group-hover:text-beme-400 transition-colors inline-block">
        <BemeMark size={size} wide />
      </span>
      <span
        className="font-bold uppercase text-ink-50"
        style={{ fontSize: `${wordPx}px`, lineHeight: 1, letterSpacing: '0.02em' }}
      >
        Beme
      </span>
    </span>
  )
}
