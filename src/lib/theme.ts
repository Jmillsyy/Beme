/**
 * Theme management — persists the user's choice to localStorage and applies it
 * via a `.light` class on `<html>`. The CSS variables in index.css flip under
 * that class so all `bg-ink-N` / `text-ink-N` utilities respond automatically.
 *
 * Default theme is dark (Studio Black).
 */

import { useEffect, useState } from 'react'

export type Theme = 'dark' | 'light'

const STORAGE_KEY = 'beme-theme'

function readStoredTheme(): Theme {
  if (typeof window === 'undefined') return 'dark'
  const stored = window.localStorage.getItem(STORAGE_KEY)
  return stored === 'light' ? 'light' : 'dark'
}

/** Apply the theme class to the document root. Safe to call repeatedly. */
function applyTheme(theme: Theme) {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  if (theme === 'light') root.classList.add('light')
  else root.classList.remove('light')
}

/**
 * Run this as early as possible on page load (e.g. in main.tsx) so there's no
 * flash of dark-mode chrome when the user had previously picked light mode.
 */
export function initTheme() {
  applyTheme(readStoredTheme())
}

/**
 * React hook that returns the current theme + a setter. Persists changes to
 * localStorage and keeps the document class in sync.
 */
export function useTheme(): [Theme, (next: Theme) => void] {
  const [theme, setThemeState] = useState<Theme>(() => readStoredTheme())

  useEffect(() => {
    applyTheme(theme)
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(STORAGE_KEY, theme)
    }
  }, [theme])

  return [theme, setThemeState]
}
