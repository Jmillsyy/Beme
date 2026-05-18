import { Routes, Route, useLocation } from 'react-router-dom'
import HomePage from './pages/HomePage'
import BrickEstimatePage from './pages/BrickEstimatePage'
import BlockEstimatePage from './pages/BlockEstimatePage'
import SettingsPage from './pages/SettingsPage'
import SignInPage from './pages/SignInPage'
import RequestsPage from './pages/RequestsPage'
import NewRequestPage from './pages/NewRequestPage'
import RequestDetailPage from './pages/RequestDetailPage'
import MaterialLibraryPage from './pages/MaterialLibraryPage'
import GuidePage from './pages/GuidePage'
import AcceptInvitePage from './pages/AcceptInvitePage'
import { useAuth } from './lib/auth'
import { isSupabaseConfigured } from './lib/supabase'

/**
 * Routes that are reachable WITHOUT being signed in. The accept-invite flow
 * needs this so brand-new users can land on the page from a link and set
 * their password before they have an account at all.
 */
const PUBLIC_PATHS = new Set(['/accept-invite'])

export default function App() {
  const { loading, signedIn } = useAuth()
  const location = useLocation()

  // While Supabase is hydrating the session from localStorage we don't yet
  // know if the user is signed in. Show a thin loading state to avoid a flash
  // of the sign-in screen.
  if (loading) {
    return (
      <div className="min-h-screen bg-ink-900 text-ink-300 flex items-center justify-center">
        <p className="text-sm">Loading…</p>
      </div>
    )
  }

  // Supabase isn't configured (e.g. dev without env vars) → run in legacy
  // offline mode where the IndexedDB-only flow still works. Protects against
  // a hard-broken local dev experience for someone cloning the repo.
  const requireAuth = isSupabaseConfigured
  const isPublic = PUBLIC_PATHS.has(location.pathname)

  if (requireAuth && !signedIn && !isPublic) {
    return <SignInPage />
  }

  return (
    <Routes>
      <Route path="/" element={<HomePage />} />
      <Route path="/project/brick" element={<BrickEstimatePage />} />
      <Route path="/project/block" element={<BlockEstimatePage />} />
      <Route path="/library" element={<MaterialLibraryPage />} />
      <Route path="/guide" element={<GuidePage />} />
      <Route path="/settings" element={<SettingsPage />} />
      <Route path="/requests" element={<RequestsPage />} />
      <Route path="/requests/new" element={<NewRequestPage />} />
      <Route path="/requests/:id" element={<RequestDetailPage />} />
      <Route path="/accept-invite" element={<AcceptInvitePage />} />
    </Routes>
  )
}
