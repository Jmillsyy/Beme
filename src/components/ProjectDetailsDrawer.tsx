import { useEffect } from 'react'
import type { ProjectDetails } from '../types/walls'

interface ProjectDetailsDrawerProps {
  open: boolean
  details: ProjectDetails
  onChange: (details: ProjectDetails) => void
  onClose: () => void
}

/**
 * Slide-in panel for editing the project metadata (client, estimator, date,
 * notes, etc). These fields are filled in once at the start and rarely
 * revisited, so they live behind a button on the ProjectBar instead of
 * taking permanent vertical space.
 */
export default function ProjectDetailsDrawer({
  open,
  details,
  onChange,
  onClose,
}: ProjectDetailsDrawerProps) {
  // Close on Escape
  useEffect(() => {
    if (!open) return
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [open, onClose])

  // Lock body scroll while the drawer is open
  useEffect(() => {
    if (!open) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [open])

  function patch(p: Partial<ProjectDetails>) {
    onChange({ ...details, ...p })
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex">
      {/* Backdrop */}
      <button
        onClick={onClose}
        aria-label="Close project details"
        className="flex-1 bg-black/30 cursor-default"
      />

      {/* Drawer */}
      <aside className="w-full max-w-md bg-white shadow-xl flex flex-col">
        <header className="px-5 py-4 border-b border-neutral-200 flex items-center justify-between flex-shrink-0">
          <div>
            <h2 className="text-lg font-semibold text-neutral-800">Project details</h2>
            <p className="text-xs text-neutral-500 mt-0.5">
              Used in the header of the exported estimate.
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-neutral-400 hover:text-neutral-700 text-2xl leading-none p-1"
            aria-label="Close"
          >
            ×
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
          <label className="text-sm block">
            <span className="block text-neutral-600 mb-1">Project name</span>
            <input
              type="text"
              value={details.projectName}
              onChange={(e) => patch({ projectName: e.target.value })}
              placeholder="e.g. Berrinba"
              className="w-full px-3 py-1.5 border border-neutral-300 rounded-lg text-sm focus:outline-none focus:border-beme-500"
            />
          </label>

          <label className="text-sm block">
            <span className="block text-neutral-600 mb-1">Site address</span>
            <input
              type="text"
              value={details.siteAddress}
              onChange={(e) => patch({ siteAddress: e.target.value })}
              placeholder="14 Mothership Drive, Berrinba"
              className="w-full px-3 py-1.5 border border-neutral-300 rounded-lg text-sm focus:outline-none focus:border-beme-500"
            />
          </label>

          <label className="text-sm block">
            <span className="block text-neutral-600 mb-1">Client name</span>
            <input
              type="text"
              value={details.clientName}
              onChange={(e) => patch({ clientName: e.target.value })}
              placeholder="Optional"
              className="w-full px-3 py-1.5 border border-neutral-300 rounded-lg text-sm focus:outline-none focus:border-beme-500"
            />
          </label>

          <label className="text-sm block">
            <span className="block text-neutral-600 mb-1">Estimator</span>
            <input
              type="text"
              value={details.estimatorName}
              onChange={(e) => patch({ estimatorName: e.target.value })}
              placeholder="Optional"
              className="w-full px-3 py-1.5 border border-neutral-300 rounded-lg text-sm focus:outline-none focus:border-beme-500"
            />
          </label>

          <label className="text-sm block">
            <span className="block text-neutral-600 mb-1">Date</span>
            <input
              type="date"
              value={details.date}
              onChange={(e) => patch({ date: e.target.value })}
              className="w-full px-3 py-1.5 border border-neutral-300 rounded-lg text-sm focus:outline-none focus:border-beme-500"
            />
          </label>

          <label className="text-sm block">
            <span className="block text-neutral-600 mb-1">Additional notes / assumptions</span>
            <textarea
              value={details.notes}
              onChange={(e) => patch({ notes: e.target.value })}
              rows={5}
              placeholder={'One assumption per line. e.g.\nLintel not supplied for Garage opening'}
              className="w-full px-3 py-1.5 border border-neutral-300 rounded-lg text-sm focus:outline-none focus:border-beme-500"
            />
            <span className="block text-xs text-neutral-400 mt-1">
              Each non-empty line is added as a numbered assumption at the end of the standard list.
            </span>
          </label>
        </div>

        <footer className="px-5 py-3 border-t border-neutral-200 flex justify-end gap-2 flex-shrink-0">
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded-lg bg-beme-600 text-white text-sm hover:bg-beme-700 transition-colors font-medium"
          >
            Done
          </button>
        </footer>
      </aside>
    </div>
  )
}
