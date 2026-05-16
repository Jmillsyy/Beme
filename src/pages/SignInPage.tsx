import { useState } from 'react'
import Header from '../components/Header'
import { signInWithMicrosoft } from '../lib/auth'
import { isSupabaseConfigured } from '../lib/supabase'

/**
 * Sign-in screen. One big "Sign in with Microsoft" button — that's the whole
 * surface for now. Studio Black themed to match the rest of the app.
 */
export default function SignInPage() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSignIn() {
    setBusy(true)
    setError(null)
    const { error } = await signInWithMicrosoft()
    if (error) {
      setError(error.message)
      setBusy(false)
    }
    // On success the browser redirects to Microsoft and back; no need to clear busy.
  }

  return (
    <div className="min-h-screen bg-ink-900 text-ink-50">
      <Header />

      <main className="max-w-md mx-auto px-6 py-20">
        <div className="border border-ink-600 rounded-2xl bg-ink-800 p-8 text-center">
          <div className="mx-auto w-14 h-14 rounded-xl bg-beme-500 relative mb-5">
            <div className="absolute inset-[10px] rounded-md bg-ink-900" />
          </div>

          <h2 className="text-2xl font-extrabold tracking-tight text-ink-50 mb-2">
            Sign in to Beme
          </h2>
          <p className="text-sm text-ink-300 mb-6">
            Use your work Microsoft account to access your projects.
          </p>

          {!isSupabaseConfigured && (
            <div className="mb-5 px-4 py-3 bg-amber-500/10 border border-amber-500/40 rounded-lg text-sm text-amber-200 text-left">
              <strong className="font-semibold">Sign-in isn't configured yet.</strong>
              <p className="text-xs mt-1 text-amber-100">
                Set <code className="font-mono text-amber-300">VITE_SUPABASE_URL</code> and{' '}
                <code className="font-mono text-amber-300">VITE_SUPABASE_ANON_KEY</code> in your{' '}
                <code className="font-mono text-amber-300">.env.local</code>. See{' '}
                <code className="font-mono text-amber-300">SETUP.md</code> for full instructions.
              </p>
            </div>
          )}

          <button
            type="button"
            onClick={handleSignIn}
            disabled={busy || !isSupabaseConfigured}
            className="w-full px-5 py-3 rounded-lg bg-beme-500 text-black hover:bg-beme-400 font-semibold disabled:opacity-40 disabled:cursor-not-allowed transition-colors inline-flex items-center justify-center gap-3"
          >
            {/* Microsoft "windows" logo — four coloured squares */}
            <svg viewBox="0 0 21 21" width="18" height="18" aria-hidden>
              <rect x="1" y="1" width="9" height="9" fill="#f25022" />
              <rect x="11" y="1" width="9" height="9" fill="#7fba00" />
              <rect x="1" y="11" width="9" height="9" fill="#00a4ef" />
              <rect x="11" y="11" width="9" height="9" fill="#ffb900" />
            </svg>
            {busy ? 'Redirecting…' : 'Sign in with Microsoft'}
          </button>

          {error && (
            <p className="mt-4 text-sm text-rose-300">{error}</p>
          )}

          <p className="mt-6 text-[11px] text-ink-400 leading-relaxed">
            Beme never sees your password — Microsoft handles the sign-in and returns a
            secure token. By signing in you agree to your projects being stored in our
            cloud database (UK / EU region).
          </p>
        </div>
      </main>
    </div>
  )
}
