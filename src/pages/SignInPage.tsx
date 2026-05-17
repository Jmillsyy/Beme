import { useState } from 'react'
import Header from '../components/Header'
import { signInWithMagicLink, signInWithMicrosoft } from '../lib/auth'
import { isSupabaseConfigured } from '../lib/supabase'

/**
 * Sign-in screen with two paths:
 *
 *   - Magic-link email: lowest-friction, works for anyone with any inbox. The
 *     primary option while you're dogfooding before Microsoft Entra is set up
 *     against your company's tenant.
 *   - Microsoft Outlook: corporate-tenant sign-in for the real product
 *     rollout. Visible whenever Supabase is configured; the user just picks
 *     whichever is right for them.
 *
 * Once a user signs in, the route guard in `App.tsx` lets them through to the
 * dashboard. Studio Black themed throughout.
 */
export default function SignInPage() {
  const [busy, setBusy] = useState(false)
  const [magicEmail, setMagicEmail] = useState('')
  const [magicSent, setMagicSent] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleMicrosoftSignIn() {
    setBusy(true)
    setError(null)
    const { error } = await signInWithMicrosoft()
    if (error) {
      setError(error.message)
      setBusy(false)
    }
    // On success the browser redirects to Microsoft and back; busy stays true
    // until the redirect lands.
  }

  async function handleMagicLinkSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (busy || !magicEmail.trim()) return
    setBusy(true)
    setError(null)
    const { error } = await signInWithMagicLink(magicEmail)
    if (error) {
      setError(error.message)
      setBusy(false)
      return
    }
    setMagicSent(true)
    setBusy(false)
  }

  return (
    <div className="min-h-screen bg-ink-900 text-ink-50">
      <Header />

      <main className="max-w-md mx-auto px-6 py-20">
        <div className="border border-ink-600 rounded-2xl bg-ink-800 p-8">
          <div className="text-center">
            <div className="mx-auto w-14 h-14 rounded-xl bg-beme-500 relative mb-5">
              <div className="absolute inset-[10px] rounded-md bg-ink-900" />
            </div>

            <h2 className="text-2xl font-extrabold tracking-tight text-ink-50 mb-2">
              Sign in to Beme
            </h2>
            <p className="text-sm text-ink-300 mb-6">
              We'll email you a one-time link, or use Microsoft if your company has it
              set up.
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

          {/* Magic-link form. Surfaces a success card once the email has been
              sent so the user knows to go check their inbox. */}
          {magicSent ? (
            <div className="px-4 py-4 bg-emerald-500/10 border border-emerald-500/40 rounded-lg text-sm text-emerald-100">
              <strong className="font-semibold text-emerald-50">Check your email.</strong>
              <p className="text-xs mt-1">
                We sent a sign-in link to <strong>{magicEmail}</strong>. Click it from the
                same device to land back here signed in. The link expires after an hour;
                you can request another one if it does.
              </p>
              <button
                type="button"
                onClick={() => {
                  setMagicSent(false)
                  setMagicEmail('')
                }}
                className="text-xs text-emerald-300 hover:text-emerald-200 underline mt-2"
              >
                Use a different email
              </button>
            </div>
          ) : (
            <form onSubmit={handleMagicLinkSubmit} className="space-y-3">
              <label className="block">
                <span className="text-xs text-ink-300 mb-1.5 inline-block">Email</span>
                <input
                  type="email"
                  required
                  value={magicEmail}
                  onChange={(e) => setMagicEmail(e.target.value)}
                  placeholder="you@example.com"
                  className="w-full px-3 py-2.5 rounded-lg border border-ink-600 bg-ink-900 text-ink-50 text-sm focus:outline-none focus:border-beme-400"
                  disabled={!isSupabaseConfigured || busy}
                />
              </label>
              <button
                type="submit"
                disabled={busy || !isSupabaseConfigured || !magicEmail.trim()}
                className="w-full px-5 py-3 rounded-lg bg-beme-500 text-black hover:bg-beme-400 font-semibold disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                {busy ? 'Sending…' : 'Email me a sign-in link'}
              </button>
            </form>
          )}

          {/* Divider + Microsoft option. Hidden in the "magic link sent"
              state because the user's mid-action and we don't want to confuse
              them with a second option. */}
          {!magicSent && (
            <>
              <div className="flex items-center gap-3 my-5 text-[11px] uppercase tracking-wider text-ink-500">
                <span className="flex-1 h-px bg-ink-600" />
                <span>or</span>
                <span className="flex-1 h-px bg-ink-600" />
              </div>

              <button
                type="button"
                onClick={handleMicrosoftSignIn}
                disabled={busy || !isSupabaseConfigured}
                className="w-full px-5 py-3 rounded-lg border border-ink-600 hover:bg-ink-700 text-ink-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors inline-flex items-center justify-center gap-3"
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
            </>
          )}

          {error && <p className="mt-4 text-sm text-rose-300">{error}</p>}

          <p className="mt-6 text-[11px] text-ink-400 leading-relaxed text-center">
            Beme never sees your password — the sign-in is handled by Supabase / Microsoft
            and returns a secure token. By signing in you agree to your projects being
            stored in our cloud database (Sydney region).
          </p>
        </div>
      </main>
    </div>
  )
}
