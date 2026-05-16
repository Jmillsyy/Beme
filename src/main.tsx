import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './index.css'
import App from './App.tsx'
import { initTheme } from './lib/theme'
import { initBlockLibrary } from './data/blockLibrary'
import { initBrickLibrary } from './data/brickLibrary'
import { initUserSettings } from './lib/userSettings'

// Apply the persisted theme (dark / light) before first render so there's no
// flash of the wrong colour scheme.
initTheme()

// Bootstrap the user's customised block library (if any). This is async but we
// don't await — first paint uses the seed defaults; once IndexedDB resolves,
// subscribed components re-render with the loaded library. Avoids blocking
// the initial render on disk I/O.
void initBlockLibrary()
void initBrickLibrary()
void initUserSettings()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
)
