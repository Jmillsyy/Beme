import { useEffect, useMemo, useState } from 'react'
import { Document, Page } from 'react-pdf'

/**
 * Modal that previews every page of a freshly-dropped/picked PDF as a
 * thumbnail with a tickbox. The user picks which pages should land in
 * the project as a reference; on Import the parent gets back the
 * 1-indexed page numbers in ascending order.
 *
 * Behaviour
 *   - Defaults every page ticked.
 *   - "Select all" / "Clear" shortcuts above the grid.
 *   - Single-page PDFs auto-import without showing the modal — the
 *     caller decides whether to surface the picker (we still render
 *     happily for 1-page docs if asked, just there's nothing to choose).
 *   - Cancel button + Esc closes without importing.
 *
 * Rendering uses react-pdf's <Document> with a single <Page> per
 * thumb — same pipeline as the workspace's primary canvas so we don't
 * need a second PDF library. Thumbnails are capped at 160px wide so
 * a 20-page engineering set doesn't blow out a 4K monitor.
 */
interface ReferencePagePickerModalProps {
  file: File
  /** Called with the user's chosen pages (1-indexed, ascending). */
  onImport: (selectedPages: number[]) => void
  onCancel: () => void
}

export default function ReferencePagePickerModal({
  file,
  onImport,
  onCancel,
}: ReferencePagePickerModalProps) {
  const [numPages, setNumPages] = useState<number | null>(null)
  const [picked, setPicked] = useState<Set<number>>(new Set())
  const [loadError, setLoadError] = useState<string | null>(null)

  // Esc closes — matches every other modal in the app.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault()
        onCancel()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  // Default-all when we first learn the page count. The user can clear
  // and pick from there; ticking everything is by far the most common
  // case (a takeoff usually wants every page of the engineering set
  // attached). The Set seed runs once per file because we key on file.
  useEffect(() => {
    if (numPages === null) return
    const all = new Set<number>()
    for (let i = 1; i <= numPages; i += 1) all.add(i)
    setPicked(all)
  }, [numPages])

  function togglePage(n: number) {
    setPicked((prev) => {
      const next = new Set(prev)
      if (next.has(n)) next.delete(n)
      else next.add(n)
      return next
    })
  }

  function selectAll() {
    if (!numPages) return
    const all = new Set<number>()
    for (let i = 1; i <= numPages; i += 1) all.add(i)
    setPicked(all)
  }
  function clearAll() {
    setPicked(new Set())
  }

  function confirm() {
    const sorted = Array.from(picked).sort((a, b) => a - b)
    if (sorted.length === 0) return
    onImport(sorted)
  }

  // Keep the same Document file instance across renders so react-pdf
  // doesn't tear down and rebuild the worker every state change.
  const docFile = useMemo(() => file, [file])

  const canImport = picked.size > 0 && numPages !== null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={onCancel}
      role="dialog"
      aria-modal="true"
      aria-label="Pick pages to import"
    >
      <div
        className="bg-ink-800 border border-ink-600 rounded-2xl shadow-2xl w-full max-w-4xl max-h-[90vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <header className="px-5 py-3 border-b border-ink-600 flex items-center justify-between bg-ink-900/40">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-ink-100">
              Pick pages to import
            </h2>
            <p className="text-[11px] text-ink-500 mt-0.5 truncate">
              {file.name}
              {numPages !== null && (
                <span className="ml-2 text-ink-400">
                  · {numPages} page{numPages === 1 ? '' : 's'}
                </span>
              )}
            </p>
          </div>
          <button
            onClick={onCancel}
            className="text-ink-400 hover:text-ink-100 text-2xl leading-none px-2"
            aria-label="Close"
          >
            ×
          </button>
        </header>

        {/* Toolbar */}
        <div className="px-5 py-2 border-b border-ink-600 flex items-center gap-2 text-xs">
          <button
            type="button"
            onClick={selectAll}
            className="px-2 py-1 rounded border border-ink-600 text-ink-200 hover:bg-ink-700"
          >
            Select all
          </button>
          <button
            type="button"
            onClick={clearAll}
            className="px-2 py-1 rounded border border-ink-600 text-ink-200 hover:bg-ink-700"
          >
            Clear
          </button>
          <span className="ml-auto text-ink-400">
            {numPages !== null
              ? `${picked.size} / ${numPages} selected`
              : 'Loading PDF…'}
          </span>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 bg-ink-900/30">
          {loadError ? (
            <p className="text-sm text-rose-300">{loadError}</p>
          ) : (
            <Document
              file={docFile}
              onLoadSuccess={({ numPages: n }) => setNumPages(n)}
              onLoadError={(err) =>
                setLoadError(
                  `Couldn't read this PDF — ${
                    (err as Error)?.message ?? 'unknown error'
                  }`
                )
              }
              loading={
                <p className="text-sm text-ink-400">Reading PDF…</p>
              }
              error={
                <p className="text-sm text-rose-300">
                  Couldn't read this PDF.
                </p>
              }
            >
              <div className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-3">
                {numPages !== null &&
                  Array.from({ length: numPages }, (_, i) => i + 1).map(
                    (n) => {
                      const isPicked = picked.has(n)
                      return (
                        <button
                          key={n}
                          type="button"
                          onClick={() => togglePage(n)}
                          className={`relative rounded-lg border bg-white overflow-hidden transition-colors group ${
                            isPicked
                              ? 'border-beme-500 ring-2 ring-beme-500/60'
                              : 'border-ink-600 hover:border-beme-500/60'
                          }`}
                          title={`Page ${n}`}
                          aria-pressed={isPicked}
                        >
                          {/* react-pdf <Page> sized to 160px wide; the
                              SVG render mode keeps thumbnails crisp at
                              the cost of slightly slower paint than
                              canvas. Fine for a one-time picker view. */}
                          <Page
                            pageNumber={n}
                            width={160}
                            renderAnnotationLayer={false}
                            renderTextLayer={false}
                          />
                          {/* Page-number chip + tick state badge */}
                          <span className="absolute top-1 left-1 text-[10px] font-semibold tabular-nums px-1.5 py-0.5 rounded bg-ink-900/80 text-ink-100">
                            {n}
                          </span>
                          <span
                            className={`absolute top-1 right-1 w-5 h-5 rounded-full text-[11px] font-bold flex items-center justify-center ${
                              isPicked
                                ? 'bg-beme-500 text-black'
                                : 'bg-ink-900/80 text-ink-400 border border-ink-500'
                            }`}
                            aria-hidden
                          >
                            {isPicked ? '✓' : ''}
                          </span>
                        </button>
                      )
                    }
                  )}
              </div>
            </Document>
          )}
        </div>

        {/* Footer */}
        <footer className="px-5 py-3 border-t border-ink-600 bg-ink-900/40 flex items-center justify-end gap-3">
          <button
            onClick={onCancel}
            className="px-4 py-1.5 rounded-lg border border-ink-600 text-ink-200 text-sm hover:bg-ink-700 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={confirm}
            disabled={!canImport}
            className="px-4 py-1.5 rounded-lg bg-beme-500 text-black text-sm font-medium hover:bg-beme-400 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            Import {picked.size > 0 ? `${picked.size} page${picked.size === 1 ? '' : 's'}` : 'pages'}
          </button>
        </footer>
      </div>
    </div>
  )
}
