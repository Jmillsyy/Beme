import { useMemo, useState } from 'react'
import {
  analyseLibraryHealth,
  useBlockLibrary,
  type HealthCheck,
} from '../data/blockLibrary'

/**
 * Sits above the block list on the material library page. Shows any
 * problems the calc engine would hit downstream — missing required
 * roles (errors) or missing-but-recoverable roles (warnings).
 *
 * Auto-hides when the library is fully tagged. Errors render in red,
 * warnings in amber. Each item carries a `detail` line explaining what
 * the role is for so the user knows what to fix.
 *
 * Future: a "Tag a block" inline picker that lets the user assign the
 * missing role to one of their existing blocks without leaving the
 * page. For now the banner surfaces the issue and the user fixes it via
 * the existing block editor.
 */
export default function LibraryHealthBanner() {
  const { library, version } = useBlockLibrary()
  void version
  const [collapsed, setCollapsed] = useState(false)
  const checks = useMemo(() => analyseLibraryHealth(library), [library, version])

  if (checks.length === 0) return null

  const errors = checks.filter((c) => c.severity === 'error')
  const warnings = checks.filter((c) => c.severity === 'warning')
  const errorCount = errors.length
  const warningCount = warnings.length
  const tone = errorCount > 0 ? 'error' : 'warning'

  return (
    <div
      className={`mb-5 rounded-xl border ${
        tone === 'error'
          ? 'border-rose-500/50 bg-rose-500/10'
          : 'border-amber-500/40 bg-amber-500/10'
      }`}
    >
      <button
        onClick={() => setCollapsed((v) => !v)}
        className={`w-full flex items-center gap-3 px-4 py-3 text-left ${
          tone === 'error' ? 'text-rose-200' : 'text-amber-200'
        }`}
      >
        <span className="text-base font-semibold">
          {tone === 'error' ? '⚠ Library issues' : '! Library advisories'}
        </span>
        <span className="text-xs font-mono opacity-80">
          {errorCount > 0 &&
            `${errorCount} issue${errorCount === 1 ? '' : 's'}`}
          {errorCount > 0 && warningCount > 0 && ' · '}
          {warningCount > 0 &&
            `${warningCount} advisor${warningCount === 1 ? 'y' : 'ies'}`}
        </span>
        <span className="ml-auto text-xs opacity-60">
          {collapsed ? 'Show details ▾' : 'Hide ▴'}
        </span>
      </button>

      {!collapsed && (
        <ul className="border-t border-current/20 divide-y divide-current/10">
          {[...errors, ...warnings].map((c) => (
            <HealthRow key={c.id} check={c} />
          ))}
        </ul>
      )}
    </div>
  )
}

function HealthRow({ check }: { check: HealthCheck }) {
  const isError = check.severity === 'error'
  return (
    <li
      className={`px-4 py-3 ${
        isError ? 'text-rose-100' : 'text-amber-100'
      }`}
    >
      <div className="flex items-start gap-2">
        <span
          className={`text-xs font-mono font-semibold pt-0.5 ${
            isError ? 'text-rose-300' : 'text-amber-300'
          }`}
        >
          {isError ? 'ERROR' : 'WARN'}
        </span>
        <div className="min-w-0">
          <div className="text-sm font-medium">{check.message}</div>
          {check.detail && (
            <div className="text-xs opacity-80 mt-1 leading-relaxed">
              {check.detail}
            </div>
          )}
        </div>
      </div>
    </li>
  )
}
