/**
 * ErrorBoundary — wraps the app's routes so any uncaught render error
 * shows a friendly recovery card instead of a whitescreen.
 *
 * React error boundaries can only be class components (the hooks-based
 * `useErrorBoundary` API is still proposal-stage in v19), so this stays
 * a small class. It exposes the standard two lifecycle hooks
 * (`getDerivedStateFromError` to swap in the error UI, `componentDidCatch`
 * for logging) plus a `reset()` callback the user can fire via the
 * "Try again" button so they aren't forced to do a full page reload.
 *
 * Why a single boundary at the root: a crash anywhere downstream (a wall
 * calc bug, a stale block code, a Supabase race) is otherwise the
 * difference between "the app crashed" and "the app is broken." With
 * the boundary the user always lands on a calm card with two affordances
 * — reload or try-again — plus the underlying error message so support
 * can act on it. A more granular per-route boundary is a follow-up; one
 * root boundary covers the common case.
 *
 * Reset semantics: clicking Try again does NOT reload the page. It just
 * resets the boundary's error state, which re-mounts the children. If
 * the underlying bug is deterministic (e.g. a stale saved project that
 * always crashes on load) the boundary will catch the same error again
 * on the next render and re-show the card — that's the right outcome,
 * because the user shouldn't be stuck in a "try again that always fails"
 * loop with no recovery path. Reload (full page reload) is the escape
 * hatch for that case.
 */
import { Component, type ReactNode } from 'react'

interface ErrorBoundaryProps {
  children: ReactNode
  /** Optional override for the heading shown on the recovery card. */
  fallbackTitle?: string
}

interface ErrorBoundaryState {
  error: Error | null
}

export default class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: { componentStack?: string }) {
    // Log to console so the browser devtools show the stack — same surface
    // a dev would expect to see. When we wire up real telemetry (Sentry,
    // PostHog, etc.) this is the function to extend.
    console.error('[ErrorBoundary] Caught error:', error)
    if (info.componentStack) {
      console.error('Component stack:', info.componentStack)
    }
  }

  reset = () => {
    this.setState({ error: null })
  }

  reload = () => {
    if (typeof window !== 'undefined') {
      window.location.reload()
    }
  }

  render() {
    if (!this.state.error) return this.props.children

    const err = this.state.error
    const title = this.props.fallbackTitle ?? 'Something went wrong'
    const message =
      err.message && err.message.length > 0
        ? err.message
        : 'Beme hit an unexpected error rendering this view.'

    return (
      <div className="min-h-screen bg-ink-900 text-ink-50 flex items-center justify-center p-6">
        <div className="max-w-lg w-full border border-ink-600 rounded-2xl bg-ink-800 shadow-xl shadow-black/40 p-6">
          <div className="flex items-start gap-3 mb-4">
            <span
              className="inline-block w-2 h-2 rounded-full bg-rose-500 mt-2 flex-shrink-0"
              aria-hidden
            />
            <div className="flex-1 min-w-0">
              <h2 className="text-lg font-semibold text-ink-50">{title}</h2>
              <p className="text-sm text-ink-300 mt-1 leading-snug">{message}</p>
            </div>
          </div>

          {/* Quick affordances. Try again resets the boundary so the
              children re-render — works when the error was transient
              (e.g. a network blip). Reload is the brute-force escape
              hatch when the error is deterministic. */}
          <div className="flex flex-wrap items-center gap-2 mt-5">
            <button
              type="button"
              onClick={this.reset}
              className="px-4 py-1.5 rounded-lg bg-beme-500 text-black text-sm font-semibold hover:bg-beme-400 transition-colors"
            >
              Try again
            </button>
            <button
              type="button"
              onClick={this.reload}
              className="px-4 py-1.5 rounded-lg border border-ink-600 text-sm text-ink-200 hover:bg-ink-700 transition-colors"
            >
              Reload page
            </button>
          </div>

          {/* Stack trace tucked into a collapsed details so the user
              has it on hand without it dominating the recovery card.
              Click to expand if support asks for the trace. */}
          {err.stack && (
            <details className="mt-5 group">
              <summary className="text-[11px] uppercase tracking-[0.12em] text-ink-400 cursor-pointer hover:text-ink-200">
                Technical details
              </summary>
              <pre className="mt-2 p-3 text-[11px] text-ink-300 bg-ink-900 border border-ink-700 rounded-lg overflow-auto max-h-60 leading-snug whitespace-pre-wrap break-words">
                {err.stack}
              </pre>
            </details>
          )}
        </div>
      </div>
    )
  }
}
