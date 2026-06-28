/**
 * Theme management - the app is light-only now, so this module just pins the
 * document to the light palette. The dark / light toggle was removed; what
 * stays here is a thin shim so the few components that still read a theme
 * (the 3D viewer, the PDF workspace) keep compiling without per-site edits.
 *
 * index.css treats dark as the bare `:root` default and flips to the warm
 * light palette under a `.light` class on `<html>`. "Light-only" therefore
 * means one thing: always add `.light`, never take it off. Any stale
 * `beme-theme` value left in localStorage from the old toggle is ignored.
 */

export type Theme = 'dark' | 'light'

/** The single theme the app now ships. */
const FIXED_THEME: Theme = 'light'

/** Add the light palette class to the document root. Safe to call repeatedly. */
function applyLight() {
  if (typeof document === 'undefined') return
  document.documentElement.classList.add('light')
}

/**
 * Run this as early as possible on page load (in main.tsx) so the first paint
 * is already on the light palette - no flash of the dark `:root` default.
 */
export function initTheme() {
  applyLight()
}

/**
 * Back-compat shim for components that still read a theme. Always returns
 * `light`; the setter is a no-op kept so existing call sites
 * (`const [theme, setTheme] = useTheme()`) don't need touching.
 */
export function useTheme(): [Theme, (next: Theme) => void] {
  return [FIXED_THEME, () => {}]
}
