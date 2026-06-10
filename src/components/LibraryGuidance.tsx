import { Link } from 'react-router-dom'
import type { ReactNode } from 'react'
import { useBlockLibrary } from '../data/blockLibrary'
import { useBrickLibrary } from '../data/brickLibrary'

/**
 * Wrap a disabled toolbar button or panel control with a rich hover
 * tooltip that explains WHY it's unavailable and offers a one-click
 * path to fix it. Designed for the "library is empty" case where the
 * native `title` attribute is too thin (just plain text, no link).
 *
 * Usage:
 *
 *   <LibraryGuidance mode="block" actionLabel="Draw wall">
 *     <button disabled={!canDraw}>Draw wall</button>
 *   </LibraryGuidance>
 *
 * The popover sits below the wrapped element by default. Hover the
 * wrapper to surface it; opacity-tweens in, doesn't steal focus.
 *
 * Hover events fire on the wrapping span — that's important because
 * a disabled button doesn't receive pointer events in most browsers,
 * so wrapping is the only way to get hover-driven guidance over a
 * disabled control.
 *
 * When the library is NOT empty, the wrapper just renders the children
 * straight through — zero extra DOM, no positioning surprises in the
 * happy path.
 */
export default function LibraryGuidance({
  mode,
  actionLabel,
  position = 'bottom',
  children,
}: {
  mode: 'block' | 'brick'
  /** What the disabled action is — used in the popover heading
   *  ("Draw wall unavailable", "Add wall type unavailable", etc.). */
  actionLabel: string
  /** Where the popover sits relative to the wrapped control. */
  position?: 'top' | 'bottom' | 'right' | 'left'
  children: ReactNode
}) {
  const { library: blockLib, version: blockVer } = useBlockLibrary()
  const { library: brickLib, version: brickVer } = useBrickLibrary()
  // Touch the version values so the wrapper re-evaluates whenever the
  // library changes — without these, adding a block elsewhere wouldn't
  // hide the popover on the next hover.
  void blockVer
  void brickVer

  const empty =
    mode === 'block'
      ? Object.keys(blockLib).length === 0
      : Object.keys(brickLib).length === 0

  // Library has entries → wrap is a no-op. Keeps the DOM clean and
  // means the wrapped button's existing `title` attribute keeps
  // working for OTHER disable reasons (no scale, no walls, etc.).
  if (!empty) return <>{children}</>

  // Position classes for the popover wrapper. The visual gap between
  // the button and the popover card is rendered as PADDING on the
  // wrapper — not margin — so the cursor traversing the gap is still
  // inside the popover element. Margin would put the cursor outside
  // the `.group` bounding box, breaking group-hover and dismissing
  // the popover the instant the user tried to move into it (the
  // "popover disappears when I reach for it" bug). With padding, the
  // cursor stays inside the hover region and the link inside the
  // card stays clickable.
  const positionClass =
    position === 'top'
      ? 'bottom-full pb-2 left-1/2 -translate-x-1/2'
      : position === 'right'
      ? 'left-full pl-2 top-1/2 -translate-y-1/2'
      : position === 'left'
      ? 'right-full pr-2 top-1/2 -translate-y-1/2'
      : 'top-full pt-2 left-1/2 -translate-x-1/2'

  const link = mode === 'block' ? '/library#blocks' : '/library#bricks'
  const noun = mode === 'block' ? 'block' : 'brick'

  return (
    <span className="relative inline-flex group">
      {children}
      {/* Outer: positions the popover and includes a transparent
          padding "bridge" between the button and the visible card.
          Hover events on the bridge keep .group-hover active so the
          popover stays open while the user moves toward it. */}
      <span
        role="tooltip"
        className={`absolute z-40 pointer-events-none group-hover:pointer-events-auto opacity-0 group-hover:opacity-100 transition-opacity duration-100 ${positionClass}`}
      >
        {/* Inner: the visible card. All chrome + content live here so
            the wrapper above can carry padding without inflating the
            card itself. */}
        <span className="block w-64 rounded-lg border border-ink-600 bg-ink-800 shadow-xl shadow-black/40 px-3 py-2.5 text-left">
          <span className="block text-[10px] uppercase tracking-[0.12em] font-semibold text-beme-300">
            {actionLabel} — set up needed
          </span>
          <span className="block text-xs text-ink-200 mt-1 leading-relaxed">
            Your {noun} library is empty. Add at least one {noun} to enable
            this.
          </span>
          <Link
            to={link}
            className="inline-flex items-center gap-1 mt-2 text-xs font-semibold text-beme-300 hover:text-beme-200"
          >
            Open Material Library
            <span aria-hidden="true">→</span>
          </Link>
        </span>
      </span>
    </span>
  )
}
