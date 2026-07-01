/**
 * PlanLegend - a "what do these markers mean?" reference for the 2D plan,
 * surfaced as a small floating button anchored bottom-left (stacked just
 * above the global ? help button) that opens a styled modal.
 *
 * The plan draws a handful of coloured glyphs (corner squares, control
 * joint dots, opening bands, etc.) whose meaning isn't obvious at a
 * glance. Rather than label every marker on the canvas, this tucks the
 * key behind one unobtrusive button, mirroring the keyboard cheat sheet.
 *
 * Portaled to <body> so the fixed positioning + backdrop use the real
 * viewport and aren't trapped inside the plan's zoom/pan transform layer.
 */
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'

interface LegendItem {
  label: string
  description: string
  swatch: React.ReactNode
}

/** A small coloured square (corner / selected). */
function Square({ color }: { color: string }) {
  return (
    <span
      className="inline-block w-3.5 h-3.5 rounded-[2px] border border-white/70"
      style={{ background: color }}
    />
  )
}

/** A small coloured diamond (T-junction). */
function Diamond({ color }: { color: string }) {
  return (
    <span
      className="inline-block w-3 h-3 rotate-45 border border-white/70"
      style={{ background: color }}
    />
  )
}

/** A small coloured dot (control joint / free end). */
function Dot({ color, ring }: { color: string; ring?: boolean }) {
  return (
    <span
      className="inline-block w-3.5 h-3.5 rounded-full border-2"
      style={{
        background: ring ? 'white' : color,
        borderColor: color,
      }}
    />
  )
}

/** A short coloured band (openings). */
function Band({ color }: { color: string }) {
  return (
    <span
      className="inline-block w-5 h-2 rounded-sm"
      style={{ background: color }}
    />
  )
}

/** A short line - solid (step) or dashed (ruler). */
function Bar({ color, dashed }: { color: string; dashed?: boolean }) {
  return (
    <span
      className="inline-block w-5 h-0"
      style={{
        borderTop: `2.5px ${dashed ? 'dashed' : 'solid'} ${color}`,
      }}
    />
  )
}

const ITEMS: LegendItem[] = [
  {
    label: 'Corner',
    description: 'Where two walls meet at an angle.',
    swatch: <Square color="#10b981" />,
  },
  {
    label: 'T-junction',
    description: 'A wall butting into the middle of another.',
    swatch: <Diamond color="#8b5cf6" />,
  },
  {
    label: 'Control joint',
    description: 'A movement joint splitting the wall. Tap it to set its end blocks.',
    swatch: <Dot color="#e11d48" ring />,
  },
  {
    label: 'Free end',
    description: 'An open wall end with no connection.',
    swatch: <Dot color="#ED7D31" ring />,
  },
  {
    label: 'Selected',
    description: "The wall or item you've selected.",
    swatch: <Square color="#3b82f6" />,
  },
  {
    label: 'Height step',
    description: 'A change in wall height along a stepped wall.',
    swatch: <Bar color="#0ea5e9" />,
  },
  {
    label: 'Window',
    description: 'A window opening in the wall.',
    swatch: <Band color="#D97706" />,
  },
  {
    label: 'Door',
    description: 'A door opening in the wall.',
    swatch: <Band color="#0D9488" />,
  },
  {
    label: 'Measurement',
    description: "A ruler measurement you've drawn.",
    swatch: <Bar color="#d946ef" dashed />,
  },
]

export default function PlanLegend() {
  const [open, setOpen] = useState(false)

  // Esc closes when open. Bubble phase so workspace tool-cancel handlers
  // still run first when the legend isn't open.
  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault()
        setOpen(false)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  return createPortal(
    <>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="Plan legend"
        title="Plan legend - what the markers mean"
        className="fixed bottom-16 left-4 z-[90] w-9 h-9 rounded-full bg-ink-800 border border-ink-600 text-ink-300 hover:bg-ink-700 hover:text-ink-50 hover:border-beme-500/60 shadow-lg shadow-black/40 transition-colors flex items-center justify-center"
      >
        {/* Legend / key glyph: three rows each with a leading dot. */}
        <svg
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
        >
          <circle cx="3" cy="4" r="1.6" fill="currentColor" />
          <rect x="6.5" y="3.2" width="7" height="1.6" rx="0.8" fill="currentColor" />
          <circle cx="3" cy="8" r="1.6" fill="currentColor" />
          <rect x="6.5" y="7.2" width="7" height="1.6" rx="0.8" fill="currentColor" />
          <circle cx="3" cy="12" r="1.6" fill="currentColor" />
          <rect x="6.5" y="11.2" width="7" height="1.6" rx="0.8" fill="currentColor" />
        </svg>
      </button>

      {open && (
        <div
          className="fixed inset-0 z-[150] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="plan-legend-title"
          onClick={() => setOpen(false)}
        >
          <div
            className="max-w-md w-full max-h-[85vh] bg-ink-800 border border-ink-600 rounded-2xl shadow-2xl shadow-black/50 flex flex-col overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="px-5 py-3 border-b border-ink-600 bg-ink-900/40 flex items-center justify-between">
              <div>
                <h2
                  id="plan-legend-title"
                  className="text-base font-semibold text-ink-50"
                >
                  Plan legend
                </h2>
                <p className="text-[11px] text-ink-500 mt-0.5">
                  What the markers on the 2D plan mean.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="text-ink-400 hover:text-ink-100 text-2xl leading-none px-2"
                aria-label="Close"
              >
                ×
              </button>
            </header>

            <ul className="overflow-y-auto p-5 space-y-2.5">
              {ITEMS.map((item) => (
                <li key={item.label} className="flex items-center gap-3 text-sm">
                  <span className="flex items-center justify-center w-7 flex-shrink-0">
                    {item.swatch}
                  </span>
                  <span className="flex-shrink-0 w-28 font-medium text-ink-100">
                    {item.label}
                  </span>
                  <span className="text-ink-300 leading-snug">
                    {item.description}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </>,
    document.body
  )
}
