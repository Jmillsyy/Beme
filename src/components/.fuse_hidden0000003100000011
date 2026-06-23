import { useEffect, useState } from 'react'
import {
  clearLocalProjects,
  listLocalProjects,
  saveProject,
  type SavedProject,
} from '../lib/projectStorage'

const DISMISS_KEY = 'beme-local-migration-dismissed'

interface Props {
  /** Called after a successful migration so the parent list can refresh. */
  onMigrated?: () => void
}

/**
 * Shown on the dashboard when:
 *   - the user is signed in (cloud is active)
 *   - there are projects in their local IndexedDB
 *   - they haven't dismissed the banner before
 *
 * Offers a single "Sync to my account" action that uploads each local project
 * to the cloud, then clears the local store and remembers the dismissal.
 */
export default function LocalMigrationBanner({ onMigrated }: Props) {
  const [localProjects, setLocalProjects] = useState<SavedProject[]>([])
  const [busy, setBusy] = useState(false)
  const [dismissed, setDismissed] = useState(
    () => typeof window !== 'undefined' && window.localStorage.getItem(DISMISS_KEY) === '1'
  )
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (dismissed) return
    let cancelled = false
    listLocalProjects()
      .then((projects) => {
        if (!cancelled) setLocalProjects(projects)
      })
      .catch(() => {
        if (!cancelled) setLocalProjects([])
      })
    return () => {
      cancelled = true
    }
  }, [dismissed])

  if (dismissed || localProjects.length === 0) return null

  function rememberDismissed() {
    setDismissed(true)
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(DISMISS_KEY, '1')
    }
  }

  async function handleSync() {
    setBusy(true)
    setError(null)
    try {
      for (const p of localProjects) {
        // saveProject() dispatches to cloud because the user is signed in.
        await saveProject(p)
      }
      await clearLocalProjects()
      rememberDismissed()
      setLocalProjects([])
      onMigrated?.()
    } catch (e) {
      setError((e as Error).message ?? 'Migration failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mb-6 px-5 py-4 rounded-xl border border-beme-500/40 bg-beme-500/10 flex items-start gap-4 flex-wrap">
      <div className="flex-1 min-w-0">
        <div className="font-semibold text-beme-200">
          You have {localProjects.length} project{localProjects.length === 1 ? '' : 's'} saved
          on this device.
        </div>
        <p className="text-sm text-ink-200 mt-1">
          Sync them to your account so they're available everywhere you sign in, and
          backed up to the cloud.
        </p>
        {error && <p className="text-sm text-rose-300 mt-2">{error}</p>}
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={handleSync}
          disabled={busy}
          className="px-3 py-1.5 rounded-md bg-beme-500 text-black text-sm font-semibold hover:bg-beme-400 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {busy ? 'Syncing…' : 'Sync to my account'}
        </button>
        <button
          type="button"
          onClick={rememberDismissed}
          className="px-3 py-1.5 rounded-md border border-ink-600 text-ink-200 text-sm hover:bg-ink-700 transition-colors"
        >
          Not now
        </button>
      </div>
    </div>
  )
}
