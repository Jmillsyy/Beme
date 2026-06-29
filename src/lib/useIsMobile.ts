import { useEffect, useState } from 'react'

/**
 * Viewport width (px) at/below which the app switches to its read-only
 * mobile layout. Matches Tailwind's `md` breakpoint (768px), so anything
 * styled `md:` lines up with this hook. Exported so non-React code and the
 * CSS media queries can stay in sync with one number.
 */
export const MOBILE_MAX_WIDTH = 767

/**
 * The viewport counts as "phone-sized" when EITHER dimension is small:
 * width <= 767 (portrait, and the narrow-window test) OR height <= 500
 * (landscape phones, where the width grows past 767 but the height stays
 * short). Without the height clause, rotating a phone to landscape flips the
 * app back to the desktop layout and the read-only / fullscreen-viewer chrome
 * (close button, 2D/3D toggle) vanishes.
 */
export const MOBILE_MEDIA_QUERY = '(max-width: 767px), (max-height: 500px)'

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
    const mq = window.matchMedia(MOBILE_MEDIA_QUERY)
    const update = () => setIsMobile(mq.matches)
    update()
    mq.addEventListener('change', update)
    return () => mq.removeEventListener('change', update)
  }, [])

  return isMobile
}
