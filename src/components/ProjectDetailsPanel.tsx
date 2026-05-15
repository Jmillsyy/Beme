import { useState } from 'react'
import type { ProjectDetails } from '../types/walls'

interface ProjectDetailsPanelProps {
  details: ProjectDetails
  onChange: (details: ProjectDetails) => void
}

export default function ProjectDetailsPanel({ details, onChange }: ProjectDetailsPanelProps) {
  const [expanded, setExpanded] = useState(true)

  function patch(p: Partial<ProjectDetails>) {
    onChange({ ...details, ...p })
  }

  return (
    <div className="my-4 border border-neutral-200 rounded-xl bg-white p-4">
      <div className="flex items-center justify-between mb-1">
        <h3 className="text-sm font-semibold text-neutral-700">Project details</h3>
        <button
          onClick={() => setExpanded((v) => !v)}
          className="text-sm text-beme-600 hover:text-beme-700 hover:underline"
        >
          {expanded ? '− Hide' : '+ Show'}
        </button>
      </div>
      <p className="text-xs text-neutral-500 mb-3">
        Used in the header of the exported estimate. The site address appears on every page.
      </p>

      {expanded && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="text-sm">
              <span className="block text-neutral-600 mb-1">Project name</span>
              <input
                type="text"
                value={details.projectName}
                onChange={(e) => patch({ projectName: e.target.value })}
                placeholder="e.g. Berrinba"
                className="w-full px-3 py-1.5 border border-neutral-300 rounded-lg text-sm focus:outline-none focus:border-beme-500"
              />
            </label>

            <label className="text-sm">
              <span className="block text-neutral-600 mb-1">Site address</span>
              <input
                type="text"
                value={details.siteAddress}
                onChange={(e) => patch({ siteAddress: e.target.value })}
                placeholder="14 Mothership Drive, Berrinba"
                className="w-full px-3 py-1.5 border border-neutral-300 rounded-lg text-sm focus:outline-none focus:border-beme-500"
              />
            </label>

            <label className="text-sm">
              <span className="block text-neutral-600 mb-1">Client name</span>
              <input
                type="text"
                value={details.clientName}
                onChange={(e) => patch({ clientName: e.target.value })}
                placeholder="Optional"
                className="w-full px-3 py-1.5 border border-neutral-300 rounded-lg text-sm focus:outline-none focus:border-beme-500"
              />
            </label>

            <label className="text-sm">
              <span className="block text-neutral-600 mb-1">Estimator</span>
              <input
                type="text"
                value={details.estimatorName}
                onChange={(e) => patch({ estimatorName: e.target.value })}
                placeholder="Optional"
                className="w-full px-3 py-1.5 border border-neutral-300 rounded-lg text-sm focus:outline-none focus:border-beme-500"
              />
            </label>

            <label className="text-sm">
              <span className="block text-neutral-600 mb-1">Date</span>
              <input
                type="date"
                value={details.date}
                onChange={(e) => patch({ date: e.target.value })}
                className="w-full px-3 py-1.5 border border-neutral-300 rounded-lg text-sm focus:outline-none focus:border-beme-500"
              />
            </label>
          </div>

          <label className="block text-sm mt-3">
            <span className="block text-neutral-600 mb-1">
              Additional notes / assumptions
            </span>
            <textarea
              value={details.notes}
              onChange={(e) => patch({ notes: e.target.value })}
              rows={3}
              placeholder={'One assumption per line. e.g.\nLintel not supplied for Garage opening'}
              className="w-full px-3 py-1.5 border border-neutral-300 rounded-lg text-sm focus:outline-none focus:border-beme-500"
            />
            <span className="block text-xs text-neutral-400 mt-1">
              Each non-empty line is added as a numbered assumption at the end of the standard list.
            </span>
          </label>
        </>
      )}
    </div>
  )
}
