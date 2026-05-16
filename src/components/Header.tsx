import { Link } from 'react-router-dom'
import { useTheme } from '../lib/theme'

/**
 * App-level top header for non-workspace pages (Home, etc).
 *
 * The workspace pages render their own compact ProjectBar instead — this Header is for
 * pages where there's no active project. Studio Black theme: dark chrome, brand mark
 * on the left, orange accent.
 */
export default function Header() {
  const [theme, setTheme] = useTheme()
  const isLight = theme === 'light'

  return (
    <header className="bg-ink-800 border-b border-ink-600">
      <div className="max-w-[1500px] mx-auto px-6 py-5 flex items-center justify-between gap-6">
        <Link to="/" className="flex items-center gap-3 group">
          <div className="relative w-[26px] h-[26px] rounded-[5px] bg-beme-500 group-hover:bg-beme-400 transition-colors">
            <div className="absolute inset-[5px] bg-ink-900 rounded-[2px]" />
          </div>
          <div className="leading-tight">
            <div className="text-2xl font-extrabold tracking-tight text-ink-50">Beme</div>
            <div className="text-[12px] text-ink-300">Brick &amp; block estimates, made easy</div>
          </div>
        </Link>

        <div className="flex items-center gap-4">
          <p className="text-[11px] text-ink-400 uppercase tracking-wider hidden md:block">
            Tailored for ABC Building Products
          </p>
          <ThemeSwitch theme={theme} onToggle={() => setTheme(isLight ? 'dark' : 'light')} />
        </div>
      </div>
    </header>
  )
}

/**
 * Compact icon-toggle between dark (moon) and light (sun) themes.
 */
function ThemeSwitch({
  theme,
  onToggle,
}: {
  theme: 'dark' | 'light'
  onToggle: () => void
}) {
  const isLight = theme === 'light'
  return (
    <button
      type="button"
      role="switch"
      aria-checked={isLight}
      onClick={onToggle}
      title={isLight ? 'Switch to dark mode' : 'Switch to light mode'}
      className="relative inline-flex items-center h-8 w-[60px] rounded-full border border-ink-600 bg-ink-700/60 hover:bg-ink-700 transition-colors cursor-pointer"
    >
      {/* Track icons */}
      <span className="absolute left-1.5 text-[12px] text-ink-400">🌙</span>
      <span className="absolute right-1.5 text-[12px] text-ink-400">☀️</span>
      {/* Thumb */}
      <span
        className="absolute top-0.5 left-0.5 w-6 h-6 rounded-full bg-beme-500 shadow-sm shadow-black/20 transition-transform duration-200 flex items-center justify-center text-[11px]"
        style={{ transform: isLight ? 'translateX(28px)' : 'translateX(0)' }}
      >
        {isLight ? '☀️' : '🌙'}
      </span>
    </button>
  )
}
