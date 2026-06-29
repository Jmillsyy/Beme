import { useEffect, useState } from 'react'

/**
 * Viewport width (px) at/below which the app switches to its read-only
 * mobile layout. Matches Tailwind's `md` breakpoint (768px), so anything
 * styled `md:` lines up with this hook. Exported so non-React code and the
 * CSS media queries can stay in sync with one number.
 */
export const MOBILE_MAX_WIDTH = 767

/**
 * True when the viewport is phone-sized (<= MOBILE_MAX_WIDTH).
 *
 * Drives the read-only mobile experience: drawing tools and edit panels
 * are hidden, the workspace collapses to swipeable 2D / 3D / schedule
 * tabs, and the desktop space-saving zoom is dropped. SSR-safe: returns
 * false until mounted, then syncs to the live media query.
 */
export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(false)

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const mq = window.matchMedia(`(max-width: ${MOBILE_MAX_WIDTH}px)`)
    const update = () => setIsMobile(mq.matches)
    update()
    mq.addEventListener('change', update)
    return () => mq.removeEventListener('change', update)
  }, [])

  return isMobile
}
