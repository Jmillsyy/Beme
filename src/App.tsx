import { Routes, Route } from 'react-router-dom'
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
import { useAuth } from './lib/auth'
import { isSupabaseConfigured } from './lib/supabase'

export default function App() {
  const { loading, signedIn } = useAuth()

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

  if (requireAuth && !signedIn) {
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
    </Routes>
  )
}
