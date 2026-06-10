import { useEffect } from 'react'
import { Link } from 'react-router-dom'
import { useBlockLibrary } from '../data/blockLibrary'
import { useBrickLibrary } from '../data/brickLibrary'

/**
 * Onboarding modal for an empty material library. Renders as a centred
 * dialog over a dim backdrop — the rest of the workspace stays visible
 * behind a 60% scrim so the user knows where they are but can't
 * accidentally interact with disabled controls.
 *
 * IMPORTANT — controlled visibility:
 *
 *   The modal NO LONGER auto-shows on project load. An estimate can be
 *   block-only, brick-only, or both, and auto-showing nagged users
 *   working in one trade about libraries in another. The parent
 *   (PdfWorkspace) now opens the modal explicitly — typically when the
 *   user clicks a trade tab in TradeRail whose library is empty, to
 *   signal that this is the moment they need to set up.
 *
 *   The `open` prop drives visibility; the library-emptiness check is
 *   still here as a guard so the modal doesn't fire spuriously after
 *   the user has populated the library mid-session and re-clicked the
 *   tab.
 *
 * Skippable — `onClose` clears the open state in the parent. The
 * existing in-panel empty states and disabled toolbar buttons remain
 * as the always-on visual cues, so even with the modal skipped the
 * user is never stuck.
 */
export default function MaterialLibraryGate({
  mode,
  open,
  onClose,
}: {
  mode: 'block' | 'brick'
  open: boolean
  onClose: () => void
}) {
  const { library: blockLibrary, version: blockVersion } = useBlockLibrary()
  const { library: brickLibrary, version: brickVersion } = useBrickLibrary()
  void blockVersion
  void brickVersion

  const isBlockMode = mode === 'block'
  const libraryEntries = isBlockMode
    ? Object.keys(blockLibrary).length
    : Object.keys(brickLibrary).length

  // Esc closes the modal (treated as Skip). Standard modal courtesy.
  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  // Guard 1: parent hasn't asked for the modal.
  if (!open) return null
  // Guard 2: library was populated between open=true and now — don't
  // surface a stale prompt for a library that already has entries.
  if (libraryEntries > 0) return null

  const materialLink = isBlockMode ? '/library#blocks' : '/library#bricks'
  const noun = isBlockMode ? 'block' : 'brick'
  const trade = isBlockMode ? 'Block' : 'Brick'

  // Required-block guidance. Block side lists the roles the calc engine
  // leans on; brick side only needs one entry to start.
  const requirements: { label: string; detail: string; required?: boolean }[] =
    isBlockMode
      ? [
          {
            label: 'A body block',
            detail:
              'The standard block used through the body of the wall. Tag it with the body role.',
            required: true,
          },
          {
            label: 'A corner block',
            detail:
              'Used at L-junctions and free ends — often the same block as the body, just add the corner role.',
          },
          {
            label: 'A half block',
            detail:
              'Optional but recommended — keeps course staggering accurate. Tag the half role.',
          },
        ]
      : [
          {
            label: 'A brick type',
            detail:
              'Face dimensions and mortar joint — bricks per m² is auto-derived. Add more later if you swap products.',
            required: true,
          },
        ]

  function handleSkip() {
    // Dismissal is now controlled by the parent — calling onClose
    // clears the modal. The parent decides whether to reopen later
    // (e.g. when the user re-clicks the same trade tab).
    onClose()
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      role="dialog"
      aria-modal="true"
      aria-label={`Set up your ${noun} library`}
      onClick={onClose}
    >
      <div
        className="w-full max-w-xl bg-ink-800 border border-ink-600 rounded-2xl shadow-2xl shadow-black/50 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header — minimal so the modal reads as a friendly nudge, not
            a system alert. No big icon, no error colour. */}
        <header className="px-6 pt-5 pb-3">
          <p className="text-[11px] uppercase tracking-[0.14em] font-semibold text-beme-300">
            One quick setup
          </p>
          <h2 className="text-xl font-bold text-ink-50 mt-1">
            Let's set up your {noun} library
          </h2>
          <p className="text-sm text-ink-300 mt-1.5 leading-relaxed">
            {trade} estimates pull from your library — face dimensions,
            roles, the lot. Add a few entries and you're ready to draw.
          </p>
        </header>

        {/* Three-step map. Concrete and short. Step 1 is the only one
            that requires action right now — 2 and 3 just preview what's
            next so the user knows where they're heading. */}
        <div className="px-6 py-2">
          <div className="grid grid-cols-3 gap-2">
            <StepCard
              n={1}
              label={`Add ${noun}s`}
              hint="Tag roles so the calc engine knows what each block does"
              current
            />
            <StepCard
              n={2}
              label="Create wall types"
              hint="Body, corner, height, bond — built from your library"
            />
            <StepCard
              n={3}
              label="Draw on plan"
              hint="Tally updates live as you trace the walls"
            />
          </div>
        </div>

        {/* What the user needs to add. Kept tight — only the must-have
            roles, not the full taxonomy. */}
        <div className="px-6 pt-4 pb-2">
          <p className="text-[11px] uppercase tracking-[0.14em] font-semibold text-ink-400 mb-2">
            What to add
          </p>
          <ul className="space-y-2">
            {requirements.map((req) => (
              <li
                key={req.label}
                className="flex items-start gap-2.5 rounded-lg border border-ink-700 bg-ink-900/40 px-3 py-2"
              >
                <span
                  aria-hidden="true"
                  className="flex-shrink-0 inline-block w-1.5 h-1.5 rounded-full bg-beme-400 mt-2"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-ink-100">
                      {req.label}
                    </span>
                    {req.required && (
                      <span className="text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-beme-500/15 border border-beme-500/30 text-beme-200">
                        Required
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-ink-400 mt-0.5 leading-snug">
                    {req.detail}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </div>

        {/* Footer actions. Primary leads to the library; secondary
            dismisses the modal but leaves the workspace's other empty-
            state cues in place (panel empty state, disabled Draw
            button, tooltip on hover). */}
        <footer className="px-6 py-4 mt-2 border-t border-ink-700 bg-ink-900/30 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={handleSkip}
            className="px-3 py-2 rounded-lg text-sm text-ink-300 hover:text-ink-100 hover:bg-ink-700/60 transition-colors"
          >
            Skip for now
          </button>
          <Link
            to={materialLink}
            onClick={onClose}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-beme-500 text-black text-sm font-semibold hover:bg-beme-400 transition-colors shadow-sm"
          >
            Open Material Library
            <span aria-hidden="true">→</span>
          </Link>
        </footer>
      </div>
    </div>
  )
}

/**
 * Compact step card for the 3-up setup map. `current` lights up the
 * active step so the user sees "this is what's in front of me right
 * now" at a glance — steps 2 and 3 stay muted because they're future.
 */
function StepCard({
  n,
  label,
  hint,
  current,
}: {
  n: number
  label: string
  hint: string
  current?: boolean
}) {
  return (
    <div
      className={`rounded-lg border px-3 py-2.5 ${
        current
          ? 'border-beme-500/50 bg-beme-500/10'
          : 'border-ink-700 bg-ink-900/30'
      }`}
    >
      <div className="flex items-center gap-2 mb-1">
        <span
          className={`flex-shrink-0 inline-flex items-center justify-center w-5 h-5 rounded-full text-[11px] font-bold ${
            current
              ? 'bg-beme-500 text-black'
              : 'bg-ink-700 text-ink-300'
          }`}
        >
          {n}
        </span>
        <span
          className={`text-xs font-semibold ${
            current ? 'text-beme-200' : 'text-ink-300'
          }`}
        >
          {label}
        </span>
      </div>
      <p
        className={`text-[11px] leading-snug ${
          current ? 'text-ink-200' : 'text-ink-500'
        }`}
      >
        {hint}
      </p>
    </div>
  )
}
