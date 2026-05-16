import { useMemo, useState } from 'react'
import type { PierMakeup } from '../types/walls'
import type { BlockCode } from '../types/blocks'
import { BLOCK_LIBRARY, useBlockLibrary } from '../data/blockLibrary'

interface PierTypesPanelProps {
  pierMakeups: PierMakeup[]
  /** Number of piers currently using each makeup (drives "can delete" guard). */
  pierCountsByMakeupId: Record<string, number>
  onAddMakeup: () => void
  onUpdateMakeup: (makeup: PierMakeup) => void
  onDeleteMakeup: (id: string) => void
}

/**
 * Pier-relevant block codes appear first in the dropdown; the rest follow alphabetically.
 * "Pier-relevant" = those with the 'pier' role plus the corner / body / cleanout-block
 * codes a user typically reaches for when building a pier column.
 */
const PIER_PREFERRED: BlockCode[] = ['40.925', '20.01', '20.21', '20.48', '20.03']

function blockLabel(code: BlockCode): string {
  const b = BLOCK_LIBRARY[code]
  return b ? `${code} — ${b.name}` : code
}

export default function PierTypesPanel({
  pierMakeups,
  pierCountsByMakeupId,
  onAddMakeup,
  onUpdateMakeup,
  onDeleteMakeup,
}: PierTypesPanelProps) {
  const [expanded, setExpanded] = useState(false)
  // Re-derive when the library changes.
  const { library } = useBlockLibrary()
  const blockOptions = useMemo<BlockCode[]>(() => {
    const allBlocks: BlockCode[] = Object.values(library)
      .map((b) => b.code)
      .filter((c) => c !== '50.45') // tile is not a pier block
    const preferred = PIER_PREFERRED.filter((c) => allBlocks.includes(c))
    const rest = allBlocks.filter((c) => !PIER_PREFERRED.includes(c)).sort()
    return [...preferred, ...rest]
  }, [library])

  function patch(makeup: PierMakeup, changes: Partial<PierMakeup>) {
    onUpdateMakeup({ ...makeup, ...changes })
  }

  function setPatternAt(makeup: PierMakeup, idx: number, code: BlockCode) {
    const pattern = [...makeup.coursePattern]
    pattern[idx] = code
    patch(makeup, { coursePattern: pattern })
  }

  function addPatternSlot(makeup: PierMakeup) {
    // Default the new slot to the last block (or 40.925 if empty).
    const last = makeup.coursePattern[makeup.coursePattern.length - 1] ?? '40.925'
    patch(makeup, { coursePattern: [...makeup.coursePattern, last] })
  }

  function removePatternSlot(makeup: PierMakeup, idx: number) {
    if (makeup.coursePattern.length <= 1) return
    const pattern = makeup.coursePattern.filter((_, i) => i !== idx)
    patch(makeup, { coursePattern: pattern })
  }

  return (
    <div className="my-4 border border-ink-600 rounded-xl bg-ink-800 p-3">
      <div className="flex items-center justify-between mb-2 gap-2">
        <button
          onClick={() => setExpanded((v) => !v)}
          className="flex items-center gap-2 text-left flex-1 min-w-0 group"
        >
          <span className="text-ink-400 group-hover:text-ink-200 text-xs">
            {expanded ? '▾' : '▸'}
          </span>
          <h3 className="text-sm font-semibold text-ink-50 group-hover:text-beme-300">
            Pier types
          </h3>
          <span className="text-xs text-ink-400 truncate">
            · {pierMakeups.length}
          </span>
        </button>
        {expanded && (
          <button
            onClick={onAddMakeup}
            className="text-sm px-2.5 py-1 rounded-lg bg-beme-500 text-black font-medium hover:bg-beme-400 transition-colors flex-shrink-0"
          >
            + Add
          </button>
        )}
      </div>

      {expanded && (
        <div className="flex flex-col gap-3 pb-1">
          {pierMakeups.map((makeup) => {
            const pierCount = pierCountsByMakeupId[makeup.id] ?? 0
            const canDelete = pierMakeups.length > 1 && pierCount === 0
            return (
              <div
                key={makeup.id}
                className="rounded-lg border border-ink-600 p-2.5 bg-ink-700/40"
              >
                <div className="flex items-center gap-2 mb-2">
                  <input
                    type="text"
                    value={makeup.name}
                    onChange={(e) => patch(makeup, { name: e.target.value })}
                    className="flex-1 min-w-0 px-2 py-1 border border-ink-600 rounded text-sm bg-ink-800 text-ink-50"
                  />
                  <button
                    onClick={() => onDeleteMakeup(makeup.id)}
                    disabled={!canDelete}
                    title={
                      !canDelete
                        ? pierCount > 0
                          ? `${pierCount} pier${pierCount === 1 ? '' : 's'} still use this type`
                          : 'At least one pier type must remain'
                        : 'Delete this pier type'
                    }
                    className="px-2 py-1 rounded border border-ink-600 text-xs text-ink-300 hover:bg-ink-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    Delete
                  </button>
                </div>

                <label className="flex items-center gap-2 text-xs text-ink-300 mb-2">
                  <span className="w-32 flex-shrink-0">Default placement:</span>
                  <select
                    value={makeup.suggestedPlacement}
                    onChange={(e) =>
                      patch(makeup, {
                        suggestedPlacement: e.target.value as 'tied' | 'freestanding',
                      })
                    }
                    className="flex-1 px-2 py-1 border border-ink-600 rounded text-xs bg-ink-800 text-ink-50"
                  >
                    <option value="tied">Tied (built into a wall)</option>
                    <option value="freestanding">Freestanding</option>
                  </select>
                </label>

                <div className="text-xs text-ink-300 mb-1">
                  Course pattern (repeats up the pier):
                </div>
                <div className="flex flex-col gap-1.5">
                  {makeup.coursePattern.map((code, idx) => (
                    <div key={idx} className="flex items-center gap-2">
                      <span className="text-xs text-ink-400 tabular-nums w-14 flex-shrink-0 font-mono">
                        c{idx + 1}
                      </span>
                      <select
                        value={code}
                        onChange={(e) =>
                          setPatternAt(makeup, idx, e.target.value as BlockCode)
                        }
                        className="flex-1 min-w-0 px-2 py-1 border border-ink-600 rounded text-xs bg-ink-800 text-ink-50 font-mono"
                      >
                        {blockOptions.map((c) => (
                          <option key={c} value={c}>
                            {blockLabel(c)}
                          </option>
                        ))}
                      </select>
                      <button
                        onClick={() => removePatternSlot(makeup, idx)}
                        disabled={makeup.coursePattern.length <= 1}
                        className="px-2 py-1 rounded border border-ink-600 text-xs text-ink-300 hover:bg-ink-700 disabled:opacity-40 disabled:cursor-not-allowed"
                        title="Remove this slot"
                      >
                        −
                      </button>
                    </div>
                  ))}
                  <button
                    onClick={() => addPatternSlot(makeup)}
                    className="self-start mt-1 px-2 py-1 rounded border border-ink-600 text-xs text-ink-300 hover:bg-ink-700 hover:text-ink-50"
                  >
                    + Add course slot
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
