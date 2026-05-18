import { useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import Header from '../components/Header'
import { useAuth, signUpWithPassword, signInWithPassword, signOut } from '../lib/auth'
import {
  acceptInvitation,
  peekInvitation,
  type InvitationPreview,
} from '../lib/invitations'
import { setCurrentOrg } from '../lib/organisations'

/**
 * Accept-invite page reached from a link the admin pasted to a teammate.
 *
 * URL shape: `/accept-invite?token=<invitation-row-uuid>`
 *
 * Flow:
 *   1. Page mounts → calls peek_invitation RPC (anonymous-safe) to fetch
 *      the email + org name + inviter name. Renders the welcome card.
 *   2. User fills in display name + password + confirm → calls
 *      supabase.auth.signUp.
 *   3. Once signed in, calls accept_invitation RPC which inserts them into
 *      organisation_members and marks the invite used.
 *   4. Navigates to dashboard. The org context picks up their new
 *      membership on its next refresh.
 *
 * Edge cases:
 *   - Token invalid / expired / used → friendly "this link is no longer
 *     valid" state, ask the admin to send a new one.
 *   - User already signed in as the invited email → skip the sign-up,
 *     show "Looks like you're already signed in — join the org?" with a
 *     single-click accept.
 *   - User already signed in as DIFFERENT email → offer "Sign out and
 *     accept" since auth.users.email must match the invitation.
 */
export default function AcceptInvitePage() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const token = params.get('token') ?? ''
  const { user, signedIn, loading: authLoading } = useAuth()

  const [preview, setPreview] = useState<InvitationPreview | null>(null)
  const [previewLoading, setPreviewLoading] = useState(true)
  const [previewError, setPreviewError] = useState<string | null>(null)

  // Sign-up form state.
  const [displayName, setDisplayName] = useState('')
  const [password, setPassword] = useState('')
  const [passwordConfirm, setPasswordConfirm] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  useEffect(() => {
    if (!token) {
      setPreviewLoading(false)
      setPreviewError('No invitation token in the link.')
      return
    }
    let cancelled = false
    setPreviewLoading(true)
    peekInvitation(token)
      .then((p) => {
        if (cancelled) return
        if (!p) {
          setPreviewError(
            "This invite link is no longer valid — it may have expired or already been used."
          )
        } else {
          setPreview(p)
        }
        setPreviewLoading(false)
      })
      .catch(() => {
        if (cancelled) return
        setPreviewError("Couldn't load the invitation. Try the link again in a minute.")
        setPreviewLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [token])

  // Already signed in as the invited email → one-click accept. Skip the
  // sign-up form entirely.
  const signedInAsInvitee =
    signedIn &&
    !!user?.email &&
    !!preview?.email &&
    user.email.toLowerCase() === preview.email.toLowerCase()
  const signedInAsSomeoneElse =
    signedIn && !!user?.email && !!preview?.email && !signedInAsInvitee

  async function handleSignUpAndAccept(e: React.FormEvent) {
    e.preventDefault()
    if (!preview || submitting) return
    if (password.length < 8) {
      setSubmitError('Password must be at least 8 characters.')
      return
    }
    if (password !== passwordConfirm) {
      setSubmitError("Passwords don't match.")
      return
    }
    setSubmitting(true)
    setSubmitError(null)
    try {
      // Create the auth.users row with the invited email + password.
      const { error: signUpErr } = await signUpWithPassword(
        preview.email,
        password,
        displayName || undefined
      )
      if (signUpErr) {
        // If the email already exists in Supabase auth, fall through to
        // password sign-in instead — covers the "got the link, made an
        // account first, came back later" case. Supabase returns either
        // "User already registered" or a 422 here.
        const alreadyRegistered = /already.*registered|exists/i.test(signUpErr.message)
        if (!alreadyRegistered) throw signUpErr
        const { error: signInErr } = await signInWithPassword(preview.email, password)
        if (signInErr) throw signInErr
      }
      // Accept the invite — adds row to organisation_members + marks used.
      const { organisationId } = await acceptInvitation(token)
      // Set the active org so the dashboard reflects the new membership.
      setCurrentOrg(organisationId)
      navigate('/')
    } catch (err) {
      setSubmitError((err as Error).message ?? 'Could not finish sign-up.')
      setSubmitting(false)
    }
  }

  async function handleAcceptAsCurrentUser() {
    if (submitting) return
    setSubmitting(true)
    setSubmitError(null)
    try {
      const { organisationId } = await acceptInvitation(token)
      setCurrentOrg(organisationId)
      navigate('/')
    } catch (err) {
      setSubmitError((err as Error).message ?? 'Could not accept invitation.')
      setSubmitting(false)
    }
  }

  async function handleSignOutAndAccept() {
    await signOut()
    // Stay on the page — the auth state change will re-render and the
    // sign-up form will show. URL stays the same so the token is preserved.
  }

  if (authLoading || previewLoading) {
    return (
      <div className="min-h-screen bg-ink-900 text-ink-50">
        <Header />
        <main className="max-w-md mx-auto px-6 py-16">
          <p className="text-sm text-ink-400 text-center">Loading invitation…</p>
        </main>
      </div>
    )
  }

  // Token bad / expired / used — give the user something useful instead of
  // a blank page or stack trace.
  if (previewError || !preview) {
    return (
      <div className="min-h-screen bg-ink-900 text-ink-50">
        <Header />
        <main className="max-w-md mx-auto px-6 py-16">
          <div className="border border-ink-600 rounded-2xl bg-ink-800 p-8 text-center">
            <h2 className="text-2xl font-extrabold tracking-tight text-ink-50 mb-2">
              Invitation unavailable
            </h2>
            <p className="text-sm text-ink-300 mb-6">
              {previewError ??
                "This invite link is no longer valid — it may have expired or already been used."}
            </p>
            <p className="text-xs text-ink-400">
              Ask the person who invited you to generate a fresh link.
            </p>
            <Link
              to="/"
              className="inline-block mt-6 text-sm text-beme-300 hover:text-beme-200"
            >
              ← Back to home
            </Link>
          </div>
        </main>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-ink-900 text-ink-50">
      <Header />
      <main className="max-w-md mx-auto px-6 py-16">
        <div className="border border-ink-600 rounded-2xl bg-ink-800 p-8">
          <div className="mb-5 text-center">
            <div className="mx-auto w-14 h-14 rounded-xl bg-beme-500 relative mb-4">
              <div className="absolute inset-[10px] rounded-md bg-ink-900" />
            </div>
            <h2 className="text-2xl font-extrabold tracking-tight text-ink-50 mb-1">
              Join {preview.organisationName}
            </h2>
            <p className="text-sm text-ink-300">
              {preview.invitedByDisplayName ? (
                <>
                  <strong className="text-ink-100">
                    {preview.invitedByDisplayName}
                  </strong>{' '}
                  invited you to join their team as{' '}
                  <strong className="text-ink-100">{preview.role}</strong>.
                </>
              ) : (
                <>
                  You've been invited to join as{' '}
                  <strong className="text-ink-100">{preview.role}</strong>.
                </>
              )}
            </p>
          </div>

          {/* Three rendering paths depending on whether the user is signed in
              and as whom. */}
          {signedInAsInvitee ? (
            // Path A: already signed in as the invited email → one click.
            <div className="space-y-4">
              <div className="px-4 py-3 bg-emerald-500/10 border border-emerald-500/40 rounded-lg text-sm text-emerald-100">
                You're signed in as <strong>{preview.email}</strong> — ready to
                join the team.
              </div>
              <button
                type="button"
                onClick={handleAcceptAsCurrentUser}
                disabled={submitting}
                className="w-full px-5 py-3 rounded-lg bg-beme-500 text-black hover:bg-beme-400 font-semibold disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                {submitting ? 'Joining…' : `Join ${preview.organisationName}`}
              </button>
            </div>
          ) : signedInAsSomeoneElse ? (
            // Path B: signed in as a different email. Sign-out + re-sign-up.
            <div className="space-y-4">
              <div className="px-4 py-3 bg-amber-500/10 border border-amber-500/40 rounded-lg text-sm text-amber-100">
                You're signed in as <strong>{user?.email}</strong>, but this
                invitation is for <strong>{preview.email}</strong>. Sign out
                first to accept it.
              </div>
              <button
                type="button"
                onClick={handleSignOutAndAccept}
                className="w-full px-5 py-3 rounded-lg bg-beme-500 text-black hover:bg-beme-400 font-semibold transition-colors"
              >
                Sign out and continue
              </button>
            </div>
          ) : (
            // Path C: signed out → set password + display name to claim invite.
            <form onSubmit={handleSignUpAndAccept} className="space-y-3">
              <label className="block">
                <span className="text-xs text-ink-300 mb-1.5 inline-block">
                  Your email
                </span>
                <input
                  type="email"
                  value={preview.email}
                  readOnly
                  className="w-full px-3 py-2.5 rounded-lg border border-ink-600 bg-ink-900/60 text-ink-300 text-sm cursor-not-allowed"
                />
                <span className="text-[11px] text-ink-400 mt-1 inline-block">
                  Pre-approved by your admin — can't be changed here.
                </span>
              </label>
              <label className="block">
                <span className="text-xs text-ink-300 mb-1.5 inline-block">
                  Your name
                </span>
                <input
                  type="text"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="Sam Smith"
                  className="w-full px-3 py-2.5 rounded-lg border border-ink-600 bg-ink-900 text-ink-50 text-sm focus:outline-none focus:border-beme-400"
                  autoComplete="name"
                />
              </label>
              <label className="block">
                <span className="text-xs text-ink-300 mb-1.5 inline-block">
                  Set a password
                </span>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  minLength={8}
                  placeholder="At least 8 characters"
                  className="w-full px-3 py-2.5 rounded-lg border border-ink-600 bg-ink-900 text-ink-50 text-sm focus:outline-none focus:border-beme-400"
                  autoComplete="new-password"
                />
              </label>
              <label className="block">
                <span className="text-xs text-ink-300 mb-1.5 inline-block">
                  Confirm password
                </span>
                <input
                  type="password"
                  value={passwordConfirm}
                  onChange={(e) => setPasswordConfirm(e.target.value)}
                  required
                  minLength={8}
                  className="w-full px-3 py-2.5 rounded-lg border border-ink-600 bg-ink-900 text-ink-50 text-sm focus:outline-none focus:border-beme-400"
                  autoComplete="new-password"
                />
              </label>

              {submitError && (
                <p className="text-sm text-rose-300">{submitError}</p>
              )}

              <button
                type="submit"
                disabled={submitting || password.length < 8 || password !== passwordConfirm}
                className="w-full px-5 py-3 rounded-lg bg-beme-500 text-black hover:bg-beme-400 font-semibold disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                {submitting ? 'Setting up…' : `Create account and join ${preview.organisationName}`}
              </button>

              <p className="text-[11px] text-ink-400 leading-relaxed text-center mt-3">
                After this, you'll sign in with this email and password at
                the regular sign-in page.
              </p>
            </form>
          )}
        </div>
      </main>
    </div>
  )
}
