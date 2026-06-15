import { useState } from 'react'
/**
 * Minimal brick-mode right-rail panel.
 *
 * Replaces the old BrickTypesPanel (which let the user define multiple
 * brick wall types, course composition, sill / head brick codes, brick
 * library entries, palette colours, etc.). The product decision is now:
 *
 *   - Brick estimates only output area + lineal m (+ opening sill / head
 *     lineal m). No per-brick-type tallies, no course composition, no
 *     visual styling per wall.
 *   - The 3D render shows a single generic warm-terracotta brick.
 *   - There's no "brick wall type" concept the user manages — every
 *     brick wall on the project uses the same project-level default
 *     height. Existing brick makeups are auto-managed by the workspace
 *     so saved projects keep working.
 *
 * This panel surfaces the two things that remain configurable for a
 * brick estimate:
 *
 *   1. Default wall height — applied to every newly-drawn brick wall.
 *   2. Curved-wall draw mode — for the 3-click curve tool, parity with
 *      the block-side button that lived inside the wall-type editor.
 *
 * Header chip shows the single terracotta swatch the 3D render uses, so
 * the user immediately reads "all brick walls look the same."
 */

const TERRACOTTA = '#B4593E'

export default function BrickWallSettingsPanel({
  defaultWallHeightMm,
  onChangeDefaultHeight,
  onStartCurvedWall,
}: {
  defaultWallHeightMm: number
  onChangeDefaultHeight: (mm: number) => void
  onStartCurvedWall: () => void
}) {
  // Edit-buffer so typing partial numbers (e.g. "24" → "2400") doesn't
  // immediately commit. We only commit on blur / Enter.
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<string>('')

  const commit = () => {
    const parsed = Number.parseInt(draft, 10)
    if (Number.isFinite(parsed) && parsed > 0) {
      onChangeDefaultHeight(parsed)
    }
    setEditing(false)
  }

  return (
    <div className="border border-ink-600 rounded-lg bg-ink-800 p-2">
      <div className="flex items-center gap-2 mb-2">
        <span
          className="inline-block w-2.5 h-2.5 rounded-full flex-shrink-0"
          style={{ backgroundColor: TERRACOTTA }}
          aria-hidden
        />
        <h3 className="text-sm font-semibold text-ink-200">Brick walls</h3>
        <span className="text-xs text-ink-400 truncate">
          · {(defaultWallHeightMm / 1000).toFixed(2)} m
        </span>
      </div>

      <div className="space-y-2">
        <label className="block text-xs text-ink-300">
          <span className="block mb-1">Default wall height (mm)</span>
          <input
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            value={editing ? draft : String(defaultWallHeightMm)}
            onFocus={() => {
              setDraft(String(defaultWallHeightMm))
              setEditing(true)
            }}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                ;(e.target as HTMLInputElement).blur()
              }
              if (e.key === 'Escape') {
                e.preventDefault()
                setEditing(false)
              }
            }}
            className="w-full px-2 py-1 border border-ink-600 rounded bg-ink-900 text-ink-50 text-sm focus:outline-none focus:border-beme-400"
          />
          <span className="block mt-1 text-[10px] text-ink-500 leading-tight">
            Newly-drawn brick walls land at this height. Existing walls
            keep their own height — open the wall properties panel to
            change one wall individually.
          </span>
        </label>

        <button
          type="button"
          onClick={onStartCurvedWall}
          className="w-full text-xs px-2 py-1.5 rounded border border-ink-600 hover:border-beme-500/60 hover:bg-ink-700 text-ink-200 transition-colors"
          title="Switch to 3-click curve draw"
        >
          + Curved brick wall
        </button>

        <p className="text-[10px] text-ink-500 leading-tight pt-1 border-t border-ink-700/60">
          Brick estimates output area, lineal metres, and sill / head
          lineal metres only. The 3D view shows a single generic brick.
        </p>
      </div>
    </div>
  )
}
