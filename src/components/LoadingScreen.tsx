import { useEffect, useState } from 'react'
import BemeMark from './BemeMark'

/**
 * Full-surface, brand-aware loading state - the "real program is starting"
 * screen. Replaces bare spinners / blank canvases on the slower loads
 * (dashboard, workspace, app boot).
 *
 * Three layered cues so it reads as finished rather than a holding pattern:
 *   1. The Beme mark with the canonical stop-and-start spin.
 *   2. A headline (what's happening) plus an optional rotating sub-line that
 *      cycles through friendly status steps every couple of seconds.
 *   3. A slim indeterminate progress bar for continuous motion.
 *
 * Colours come from the theme-aware `ink` tokens, so the same component reads
 * correctly on the dark workspace AND the light dashboard without props. It
 * centres within whatever box the caller gives it - wrap it in a full-height
 * container for a splash, or a min-h section for an inline load.
 *
 * For tiny inline spots (a settings row, a menu) prefer the smaller
 * {@link BemeLoader}; this one is sized for full panels and pages.
 */
export default function LoadingScreen({
  message = 'Loading…',
  steps,
  size = 56,
  className = '',
}: {
  /** Primary line under the logo - the headline of what's loading. */
  message?: string
  /** Optional status lines that cycle one at a time under the headline.
   * Pass 2+ for the rotation; 1 shows statically; omit for none. */
  steps?: string[]
  /** Logo edge length in px. */
  size?: number
  /** Extra classes on the outer wrapper (e.g. min-height, sizing). */
  className?: string
}) {
  const [stepIndex, setStepIndex] = useState(0)
  // Depend on the COUNT (a stable number), not the array - callers pass an
  // inline `steps` literal that's a fresh reference every render, which would
  // otherwise reset the interval each render and stall the rotation.
  const stepCount = steps?.length ?? 0

  useEffect(() => {
    if (stepCount < 2) return
    const id = setInterval(
      () => setStepIndex((i) => (i + 1) % stepCount),
      2200
    )
    return () => clearInterval(id)
  }, [stepCount])

  const sub = stepCount > 0 ? steps![stepIndex % stepCount] : null

  return (
    <div
      className={`beme-fade-in flex flex-col items-center justify-center gap-5 text-center ${className}`}
      role="status"
      aria-live="polite"
    >
      <span className="beme-spin-stop inline-block text-beme-500">
        <BemeMark size={size} />
      </span>

      <div className="flex flex-col items-center gap-1">
        <p className="text-base font-semibold tracking-tight text-ink-50">
          {message}
        </p>
        {sub && (
          // Keyed so each step remounts and replays the fade as it rotates.
          <p
            key={stepIndex}
            className="beme-fade-in text-sm text-ink-400 min-h-[1.5rem]"
          >
            {sub}
          </p>
        )}
      </div>

      <div
        className="h-1 w-48 overflow-hidden rounded-full bg-ink-500/20"
        aria-hidden="true"
      >
        <div className="beme-load-bar h-full w-1/3 rounded-full bg-beme-500" />
      </div>
    </div>
  )
}
