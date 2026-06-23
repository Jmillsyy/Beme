import { Routes, Route, useLocation } from 'react-router-dom'
import HomePage from './pages/HomePage'
import BrickEstimatePage from './pages/BrickEstimatePage'
import BlockEstimatePage from './pages/BlockEstimatePage'
import SettingsPage from './pages/SettingsPage'
import SignInPage from './pages/SignInPage'
import ProjectsPage from './pages/ProjectsPage'
import MaterialLibraryPage from './pages/MaterialLibraryPage'
import GuidePage from './pages/GuidePage'
import AcceptInvitePage from './pages/AcceptInvitePage'
import WelcomePage from './pages/WelcomePage'
import AppShell from './components/AppShell'
import { useAuth } from './lib/auth'
import { isSupabaseConfigured } from './lib/supabase'
import ToastHost from './components/ToastHost'
import ErrorBoundary from './components/ErrorBoundary'
import ConfirmHost from './components/ConfirmHost'
import KeyboardCheatSheet from './components/KeyboardCheatSheet'
import CommandPalette from './components/CommandPalette'
import HelpFloatingButton from './components/HelpFloatingButton'
import BemeLoader from './components/BemeLoader'

/**
 * Routes that are reachable WITHOUT being signed in. Accept-invite is
 * needed so brand-new users can land on a setup link before they have
 * an account. /welcome is where Stripe Checkout redirects after a
 * successful subscription — the user lands there before they've
 * clicked the magic-link email, so it must be public too.
 */
const PUBLIC_PATHS = new Set(['/accept-invite', '/welcome'])

export default function App() {
  const { loading, signedIn } = useAuth()
  const location = useLocation()

  // While Supabase is hydrating the session from localStorage we don't yet
  // know if the user is signed in. Show a thin loading state to avoid a flash
  // of the sign-in screen.
  if (loading) {
    return (
      <div className="min-h-screen bg-ink-900 text-ink-300 flex items-center justify-center">
        <BemeLoader />
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
    <>
      <ErrorBoundary>
        <Routes>
          {/* Dashboard-style pages share a single AppShell mount —
              LeftNav stays alive across nav clicks so they don't flash
              the whole chrome away and back. Each child page renders
              into AppShell's <Outlet />. */}
          <Route element={<AppShell />}>
            <Route path="/" element={<HomePage />} />
            <Route path="/library" element={<MaterialLibraryPage />} />
            <Route path="/guide" element={<GuidePage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/projects" element={<ProjectsPage />} />
          </Route>
          {/* Workspace + standalone pages own their own layout. */}
          <Route path="/project/brick" element={<BrickEstimatePage />} />
          <Route path="/project/block" element={<BlockEstimatePage />} />
          <Route path="/accept-invite" element={<AcceptInvitePage />} />
          <Route path="/welcome" element={<WelcomePage />} />
        </Routes>
      </ErrorBoundary>
      {/* Global toast host — single mount, floats over every page. */}
      <ToastHost />
      {/* Global confirm dialog — single mount; confirm() opens it. */}
      <ConfirmHost />
      {/* Global keyboard cheat-sheet — opens with `?`, closes with Esc. */}
      <KeyboardCheatSheet />
      {/* Command palette — Cmd/Ctrl+K to toggle from anywhere. */}
      <CommandPalette />
      {/* Persistent ? button bottom-left so users can discover the
          keyboard shortcuts without hunting for the chord. */}
      <HelpFloatingButton />
    </>
  )
}
