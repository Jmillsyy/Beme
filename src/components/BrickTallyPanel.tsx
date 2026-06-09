import { memo, useMemo, useState } from 'react'
import type { BrickMakeup, BrickSettings, Opening, Wall } from '../types/walls'
import { calculateBrickTally } from '../lib/brickCalc'
import { useBrickLibrary } from '../data/brickLibrary'
import { useUserSettings } from '../lib/userSettings'
import { brickLintelWarnings } from '../lib/lintelCoverage'
import LintelCoverageBand from './LintelCoverageBand'
import AnimatedNumber from './AnimatedNumber'

interface BrickTallyPanelProps {
  walls: Wall[]
  openings: Opening[]
  settings: BrickSettings
  /** Brick wall types — needed for per-wall heights when the calc
   *  derives area. */
  makeups?: BrickMakeup[]
}

/**
 * Right-rail tally for brick estimates — intentionally minimal.
 *
 * Two numbers, surfaced loud:
 *   - Total brickwork area (m²) — drives every quantity downstream
 *     when multiplied by the brick rate
 *   - Total wall lineal m — the run figure for spec-by-the-metre items
 *     (ties, plascourse, flashing)
 *
 * The per-wall-type breakdown (area, head lineals, sill lineals) lives
 * in the EXPORT PDF, not in the workspace rail. Reasoning: the rail
 * is glanceable headline-only feedback while the estimator's drawing;
 * the export is the deliverable where the breakdown actually gets
 * used. Stuffing both into the rail makes the most-used affordance
 * (the headline area) compete with information that belongs on
 * paper.
 *
 * Lintel coverage warnings still surface here because they're a
 * data-quality nudge — the estimator needs to know about misconfigured
 * openings WHILE they're still drawing, not when they generate the PDF.
 *
 * Memoised so re-renders driven by zoom / pan don't recompute the tally.
 */
function BrickTallyPanelImpl({ walls, openings, settings, makeups }: BrickTallyPanelProps) {
  const [expanded, setExpanded] = useState(true)
  // Subscribe to brick-library version so a rate change on a library
  // brick re-tallies immediately (the per-band counts read the rate
  // off each band's brick type at calc time).
  const { version: brickLibraryVersion } = useBrickLibrary()
  const { settings: userSettings } = useUserSettings()
  void userSettings

  const tally = useMemo(() => {
    void brickLibraryVersion
    return calculateBrickTally(walls, openings, settings, makeups)
  }, [walls, openings, settings, makeups, brickLibraryVersion])

  // Lintel coverage warnings — surfaces openings whose width doesn't
  // match any per-opening lintel supply item with a width range, and
  // overlapping ranges that would double-count. See lib/lintelCoverage.
  const lintelWarnings = useMemo(
    () => brickLintelWarnings(openings, userSettings.supplyItems),
    [openings, userSettings.supplyItems],
  )

  if (walls.length === 0) {
    return (
      <div className="border border-dashed border-ink-600 rounded-xl p-6 text-center text-ink-400 text-sm bg-ink-800/50">
        Draw your first wall to see the brick tally.
      </div>
    )
  }

  const areaSqM = tally.totalAreaSqMm / 1_000_000
  const lengthM = tally.totalLinealMm / 1000

  return (
    <div className="border border-ink-600 rounded-xl bg-ink-800 overflow-hidden">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full bg-ink-700 px-3 py-2 border-b border-ink-600 flex items-center justify-between gap-2 text-left group"
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-ink-400 group-hover:text-ink-200 text-xs">
            {expanded ? '▾' : '▸'}
          </span>
          <h3 className="text-sm font-bold text-ink-50">Brick tally</h3>
          <span className="text-xs text-beme-300 tabular-nums truncate">
            · <AnimatedNumber value={areaSqM} format={(n) => n.toFixed(2)} /> m²
          </span>
        </div>
        <span className="text-xs text-ink-400 tabular-nums flex-shrink-0">
          {tally.wallCount} wall{tally.wallCount === 1 ? '' : 's'}
        </span>
      </button>

      {expanded && lintelWarnings.length > 0 && (
        <div className="px-3 pt-3">
          <LintelCoverageBand warnings={lintelWarnings} />
        </div>
      )}

      {expanded && (
        <>
          {/* Big total card — orange hero, exact same structure as
              BlockTallyPanel: uppercase eyebrow, big extrabold
              headline number, single-line subtitle stacking the
              supporting figures. Keeps the brand-colour real estate
              tight to the headline so the panel reads as "one
              feature card on a neutral surface" rather than "all
              orange". */}
          <div className="px-4 py-4 bg-gradient-to-br from-beme-500 to-beme-600 text-ink-900">
            <div className="text-[11px] font-semibold uppercase tracking-[0.1em] opacity-85">
              Total brickwork area
            </div>
            <div className="text-3xl font-extrabold tracking-tight leading-none mt-1 tabular-nums">
              <AnimatedNumber value={areaSqM} format={(n) => n.toFixed(2)} /> m²
            </div>
            <div className="text-xs opacity-85 mt-1 tabular-nums">
              {tally.wallCount} wall{tally.wallCount === 1 ? '' : 's'} ·{' '}
              <AnimatedNumber value={lengthM} format={(n) => n.toFixed(2)} /> m run
            </div>
          </div>

          {/* Metadata strip — same visual rhythm as BlockTallyPanel:
              neutral ink-800 surface, ink-400 text, single line. The
              brick rail is intentionally headline-only (head/sill
              breakdowns live in the export PDF), so this strip only
              carries the openings count — keeps the structural
              parity with the block panel without duplicating
              numbers that are already in the export. */}
          <div className="px-3 py-2 text-xs text-ink-400 border-t border-ink-600 flex justify-between gap-2 flex-wrap tabular-nums">
            <span>
              <AnimatedNumber value={tally.openingCount} /> opening
              {tally.openingCount === 1 ? '' : 's'}
            </span>
          </div>
        </>
      )}
    </div>
  )
}

const BrickTallyPanel = memo(BrickTallyPanelImpl)
export default BrickTallyPanel
