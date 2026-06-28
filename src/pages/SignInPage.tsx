import { useState } from 'react'
import Header from '../components/Header'
import {
  signInWithMagicLink,
  signInWithPassword,
} from '../lib/auth'
import { isSupabaseConfigured } from '../lib/supabase'
import BemeMark from '../components/BemeMark'

/** Which auth flow the user has chosen on the sign-in page. */
type Mode = 'magic-link' | 'password'

/**
 * Sign-in screen with two email paths:
 *
 * - Magic-link email: lowest-friction, works for anyone with any inbox.
 * - Password: for users who set one when accepting an invite.
 *
 * Once a user signs in, the route guard in `App.tsx` lets them through to the
 * dashboard. Studio Black themed throughout.
 */
export default function SignInPage() {
  const [busy, setBusy] = useState(false)
  const [mode, setMode] = useState<Mode>('magic-link')
  // Email is shared across magic-link and password modes - switching mode
  // shouldn't make the user retype it. Password is per-attempt; we never
  // persist it.
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [magicSent, setMagicSent] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleMagicLinkSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (busy || !email.trim()) return
    setBusy(true)
    setError(null)
    const { error } = await signInWithMagicLink(email)
    if (error) {
      setError(error.message)
      setBusy(false)
      return
    }
    setMagicSent(true)
    setBusy(false)
  }

  async function handlePasswordSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (busy || !email.trim() || !password) return
    setBusy(true)
    setError(null)
    const { error } = await signInWithPassword(email, password)
    if (error) {
      setError(error.message)
      setBusy(false)
      return
    }
    // Supabase fires the onAuthStateChange listener in useAuth - the route
    // guard in App.tsx will swap to the dashboard on next render.
    setBusy(false)
  }

  return (
    <div className="full-scale min-h-screen bg-ink-900 text-ink-50">
      <Header />

      <main className="app-scale max-w-md mx-auto px-6 py-20">
        <div className="border border-ink-600 rounded-2xl bg-ink-800 p-8">
          <div className="text-center">
            <span className="inline-block text-beme-500 mb-5">
              <BemeMark size={40} wide />
            </span>

            <h2 className="text-2xl font-bold tracking-tight text-ink-50 mb-2">
              Sign in to Beme
            </h2>
            <p className="text-sm text-ink-300 mb-6">
              {mode === 'password'
                ? 'Use the password you set when you accepted your invite.'
                : "We'll email you a one-time sign-in link."}
            </p>
          </div>

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

          {/* Email-based sign-in. Three render states:
              - magicSent: just submitted magic-link form, showing the
                "check your inbox" card.
              - mode === 'password': email + password form for users who
                set a password via /accept-invite.
              - default: magic-link email-only form (lowest-friction). */}
          {magicSent ? (
            <div className="px-4 py-4 bg-emerald-500/10 border border-emerald-500/40 rounded-lg text-sm text-emerald-100">
              <strong className="font-semibold text-emerald-50">Check your email.</strong>
              <p className="text-xs mt-1">
                We sent a sign-in link to <strong>{email}</strong>. Click it from the
                same device to land back here signed in. The link expires after an hour;
                you can request another one if it does.
              </p>
              <button
                type="button"
                onClick={() => {
                  setMagicSent(false)
                  setEmail('')
                }}
                className="text-xs text-emerald-300 hover:text-emerald-200 underline mt-2"
              >
                Use a different email
              </button>
            </div>
          ) : mode === 'password' ? (
            <form onSubmit={handlePasswordSubmit} className="space-y-3">
              <label className="block">
                <span className="text-xs text-ink-300 mb-1.5 inline-block">Email</span>
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  autoComplete="email"
                  className="w-full px-3 py-2.5 rounded-lg border border-ink-600 bg-ink-900 text-ink-50 text-sm focus:outline-none focus:border-beme-400"
                  disabled={!isSupabaseConfigured || busy}
                />
              </label>
              <label className="block">
                <span className="text-xs text-ink-300 mb-1.5 inline-block">Password</span>
                <input
                  type="password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                  className="w-full px-3 py-2.5 rounded-lg border border-ink-600 bg-ink-900 text-ink-50 text-sm focus:outline-none focus:border-beme-400"
                  disabled={!isSupabaseConfigured || busy}
                />
              </label>
              <button
                type="submit"
                disabled={busy || !isSupabaseConfigured || !email.trim() || !password}
                className="w-full px-5 py-3 rounded-lg bg-beme-500 text-black hover:bg-beme-400 font-semibold disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                {busy ? 'Signing in…' : 'Sign in'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setMode('magic-link')
                  setPassword('')
                  setError(null)
                }}
                className="w-full text-xs text-beme-300 hover:text-beme-200 underline mt-1"
              >
                Use a magic link instead
              </button>
            </form>
          ) : (
            <form onSubmit={handleMagicLinkSubmit} className="space-y-3">
              <label className="block">
                <span className="text-xs text-ink-300 mb-1.5 inline-block">Email</span>
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  autoComplete="email"
                  className="w-full px-3 py-2.5 rounded-lg border border-ink-600 bg-ink-900 text-ink-50 text-sm focus:outline-none focus:border-beme-400"
                  disabled={!isSupabaseConfigured || busy}
                />
              </label>
              <button
                type="submit"
                disabled={busy || !isSupabaseConfigured || !email.trim()}
                className="w-full px-5 py-3 rounded-lg bg-beme-500 text-black hover:bg-beme-400 font-semibold disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                {busy ? 'Sending…' : 'Email me a sign-in link'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setMode('password')
                  setError(null)
                }}
                className="w-full text-xs text-beme-300 hover:text-beme-200 underline mt-1"
              >
                Sign in with a password instead
              </button>
            </form>
          )}

          {error && <p className="mt-4 text-sm text-rose-300">{error}</p>}

          <p className="mt-6 text-[11px] text-ink-400 leading-relaxed text-center">
            Beme never sees your password - the sign-in is handled by Supabase and
            returns a secure token. By signing in you agree to your projects being
            stored in our cloud database (Sydney region).
          </p>
        </div>
      </main>
    </div>
  )
}
