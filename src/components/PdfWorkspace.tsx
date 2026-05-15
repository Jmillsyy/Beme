import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Document, Page, pdfjs } from 'react-pdf'
import 'react-pdf/dist/Page/AnnotationLayer.css'
import 'react-pdf/dist/Page/TextLayer.css'

// Use the matching pdf.js worker from the CDN — version pinned to react-pdf's bundled version
pdfjs.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`

type Point = { x: number; y: number }

type PageData = {
  scalePxPerMm?: number // px per mm at zoom = 1 (canonical form, zoom-independent)
  pageWidthMm?: number // intrinsic page width in mm (from PDF metadata)
  pageHeightMm?: number
}

const POINTS_PER_INCH = 72
const MM_PER_INCH = 25.4

const MIN_ZOOM = 0.25
const MAX_ZOOM = 8
const ZOOM_LEVELS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4]

const RATIO_PRESETS = [
  { label: '1:20', value: 20 },
  { label: '1:50', value: 50 },
  { label: '1:100', value: 100 },
  { label: '1:200', value: 200 },
  { label: '1:500', value: 500 },
  { label: '1:1000', value: 1000 },
]

function distance(a: Point, b: Point) {
  const dx = b.x - a.x
  const dy = b.y - a.y
  return Math.sqrt(dx * dx + dy * dy)
}

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v))
}

export default function PdfWorkspace() {
  const [pdfFile, setPdfFile] = useState<File | null>(null)
  const [numPages, setNumPages] = useState<number>(0)
  const [currentPage, setCurrentPage] = useState<number>(1)
  const [isDragging, setIsDragging] = useState(false)

  // Zoom — two values:
  //   zoom: live target zoom (updates immediately on wheel/pinch/buttons)
  //   renderedZoom: zoom level the PDF canvas is actually rasterised at (updates on a debounce after user stops zooming)
  // During interactive zoom we apply (zoom / renderedZoom) via CSS transform for smooth, flicker-free scaling.
  const [zoom, setZoom] = useState(1)
  const [renderedZoom, setRenderedZoom] = useState(1)
  const baseWidth = Math.min(900, typeof window !== 'undefined' ? window.innerWidth - 120 : 900)
  const renderedPageWidth = Math.round(baseWidth * renderedZoom)
  const visualScale = zoom / renderedZoom

  // Per-page data (scale and intrinsic dimensions)
  const [pagesData, setPagesData] = useState<Record<number, PageData>>({})

  // Click-to-calibrate state
  const [calibrating, setCalibrating] = useState(false)
  const [calPoint1, setCalPoint1] = useState<Point | null>(null)
  const [calPoint2, setCalPoint2] = useState<Point | null>(null)
  const [mousePos, setMousePos] = useState<Point | null>(null)
  const [calInput, setCalInput] = useState('')

  const containerRef = useRef<HTMLDivElement>(null)
  const sidebarRef = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const zoomRef = useRef(zoom)
  const pendingScrollRef = useRef<{ x: number; y: number } | null>(null)

  // Pan (click-and-drag) state
  const isPanningRef = useRef(false)
  const panStartRef = useRef<{ x: number; y: number; scrollLeft: number; scrollTop: number } | null>(null)
  const calibratingRef = useRef(calibrating)

  const pageData = pagesData[currentPage]
  const currentScale = pageData?.scalePxPerMm

  // Aspect ratio (constant per page) — used to compute rendered height ahead of canvas re-render
  const aspectRatio =
    pageData?.pageWidthMm && pageData?.pageHeightMm
      ? pageData.pageHeightMm / pageData.pageWidthMm
      : null
  const renderedPageHeight = aspectRatio ? renderedPageWidth * aspectRatio : null
  const visualPageWidth = renderedPageWidth * visualScale
  const visualPageHeight = renderedPageHeight ? renderedPageHeight * visualScale : null

  // Keep zoomRef in sync so wheel handler reads current value
  useEffect(() => {
    zoomRef.current = zoom
  }, [zoom])

  // Keep calibratingRef in sync so pan handler can read it
  useEffect(() => {
    calibratingRef.current = calibrating
  }, [calibrating])

  // Reset calibration state when page or pdf changes
  useEffect(() => {
    cancelCalibration()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPage, pdfFile])

  // After the user stops zooming, re-rasterise the PDF at the new resolution
  // so the canvas is crisp instead of relying on the CSS transform upscale.
  useEffect(() => {
    if (zoom === renderedZoom) return
    const timer = setTimeout(() => {
      setRenderedZoom(zoom)
    }, 180)
    return () => clearTimeout(timer)
  }, [zoom, renderedZoom])

  useEffect(() => {
    if (calPoint1 && calPoint2) {
      inputRef.current?.focus()
    }
  }, [calPoint1, calPoint2])

  // ---------- Mouse wheel / trackpad zoom ----------
  // Attaches a non-passive wheel listener so we can preventDefault().
  // Re-runs when pdfFile changes so it reattaches after the workspace mounts.
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const handler = (e: WheelEvent) => {
      e.preventDefault()

      const oldZoom = zoomRef.current
      const sensitivity = e.ctrlKey ? 0.01 : 0.002
      const factor = Math.exp(-e.deltaY * sensitivity)
      const newZoom = clamp(oldZoom * factor, MIN_ZOOM, MAX_ZOOM)
      if (newZoom === oldZoom) return

      // Zoom-to-cursor: keep the point under the cursor stationary
      const rect = container.getBoundingClientRect()
      const cursorXInViewport = e.clientX - rect.left
      const cursorYInViewport = e.clientY - rect.top

      const scrollLeft = container.scrollLeft
      const scrollTop = container.scrollTop

      const contentX = scrollLeft + cursorXInViewport
      const contentY = scrollTop + cursorYInViewport

      const ratio = newZoom / oldZoom

      pendingScrollRef.current = {
        x: contentX * ratio - cursorXInViewport,
        y: contentY * ratio - cursorYInViewport,
      }

      setZoom(newZoom)
    }

    container.addEventListener('wheel', handler, { passive: false })
    return () => container.removeEventListener('wheel', handler)
  }, [pdfFile])

  // ---------- Thumbnail sidebar: explicit wheel scroll ----------
  // Ensures mouse wheel scrolling works when hovering over thumbnails
  // (some browsers can have issues with native scroll on dynamic content).
  useEffect(() => {
    const sidebar = sidebarRef.current
    if (!sidebar) return

    const handler = (e: WheelEvent) => {
      e.preventDefault()
      e.stopPropagation()
      sidebar.scrollTop += e.deltaY
    }

    sidebar.addEventListener('wheel', handler, { passive: false })
    return () => sidebar.removeEventListener('wheel', handler)
  }, [pdfFile, numPages])

  // ---------- Click-and-drag pan ----------
  // Mousedown on the PDF starts a pan; mousemove/mouseup are attached on document
  // so dragging keeps working even if the cursor leaves the container.
  useEffect(() => {
    if (!pdfFile) return

    const handleDocMouseMove = (e: MouseEvent) => {
      if (!isPanningRef.current || !panStartRef.current || !containerRef.current) return
      const start = panStartRef.current
      containerRef.current.scrollLeft = start.scrollLeft - (e.clientX - start.x)
      containerRef.current.scrollTop = start.scrollTop - (e.clientY - start.y)
    }

    const handleDocMouseUp = () => {
      if (isPanningRef.current) {
        isPanningRef.current = false
        panStartRef.current = null
        if (containerRef.current) {
          containerRef.current.style.cursor = ''
        }
      }
    }

    document.addEventListener('mousemove', handleDocMouseMove)
    document.addEventListener('mouseup', handleDocMouseUp)
    return () => {
      document.removeEventListener('mousemove', handleDocMouseMove)
      document.removeEventListener('mouseup', handleDocMouseUp)
    }
  }, [pdfFile])

  function handlePanMouseDown(e: React.MouseEvent<HTMLDivElement>) {
    if (calibratingRef.current) return
    if (e.button !== 0) return // only left mouse button
    const container = containerRef.current
    if (!container) return

    isPanningRef.current = true
    panStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      scrollLeft: container.scrollLeft,
      scrollTop: container.scrollTop,
    }
    container.style.cursor = 'grabbing'
  }

  // Apply the pending scroll position after the zoom-induced resize has been laid out
  useLayoutEffect(() => {
    if (pendingScrollRef.current && containerRef.current) {
      containerRef.current.scrollLeft = pendingScrollRef.current.x
      containerRef.current.scrollTop = pendingScrollRef.current.y
      pendingScrollRef.current = null
    }
  }, [zoom])

  // ---------- File handling ----------

  const acceptFile = (file: File | undefined | null) => {
    if (file && file.type === 'application/pdf') {
      setPdfFile(file)
      setCurrentPage(1)
      setNumPages(0)
      setPagesData({})
      setZoom(1)
      setRenderedZoom(1)
      cancelCalibration()
    }
  }

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    acceptFile(e.target.files?.[0])
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
    acceptFile(e.dataTransfer.files?.[0])
  }, [])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(true)
  }, [])

  const handleDragLeave = useCallback(() => {
    setIsDragging(false)
  }, [])

  // ---------- Zoom (button) ----------

  function zoomInButton() {
    const next = ZOOM_LEVELS.find((z) => z > zoom)
    if (next) setZoom(next)
  }

  function zoomOutButton() {
    const prev = [...ZOOM_LEVELS].reverse().find((z) => z < zoom)
    if (prev) setZoom(prev)
  }

  function resetZoom() {
    setZoom(1)
  }

  // ---------- Calibration: click two points ----------

  function startCalibration() {
    setCalibrating(true)
    setCalPoint1(null)
    setCalPoint2(null)
    setMousePos(null)
    setCalInput('')
  }

  function cancelCalibration() {
    setCalibrating(false)
    setCalPoint1(null)
    setCalPoint2(null)
    setMousePos(null)
    setCalInput('')
  }

  function svgCoordsFromEvent(e: React.MouseEvent<SVGSVGElement>): Point {
    const rect = svgRef.current!.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  function handleSvgClick(e: React.MouseEvent<SVGSVGElement>) {
    if (!calibrating) return
    const p = svgCoordsFromEvent(e)
    if (!calPoint1) {
      setCalPoint1(p)
    } else if (!calPoint2) {
      setCalPoint2(p)
    }
  }

  function handleSvgMouseMove(e: React.MouseEvent<SVGSVGElement>) {
    if (!calibrating) return
    if (calPoint1 && !calPoint2) {
      setMousePos(svgCoordsFromEvent(e))
    }
  }

  function submitCalibration() {
    if (!calPoint1 || !calPoint2) return
    const mm = parseFloat(calInput)
    if (!Number.isFinite(mm) || mm <= 0) return
    const pxAtCurrentZoom = distance(calPoint1, calPoint2)
    if (pxAtCurrentZoom < 2) return
    // Normalise to zoom = 1 so the scale is independent of how zoomed in we are
    const pxPerMmAtZoom1 = pxAtCurrentZoom / mm / zoom
    setPagesData((prev) => ({
      ...prev,
      [currentPage]: { ...prev[currentPage], scalePxPerMm: pxPerMmAtZoom1 },
    }))
    cancelCalibration()
  }

  // ---------- Calibration: ratio ----------

  function applyRatioScale(ratio: number) {
    if (!Number.isFinite(ratio) || ratio <= 0) return
    const data = pagesData[currentPage]
    if (!data?.pageWidthMm) return
    const pxPerMm = baseWidth / (data.pageWidthMm * ratio)
    setPagesData((prev) => ({
      ...prev,
      [currentPage]: { ...prev[currentPage], scalePxPerMm: pxPerMm },
    }))
    cancelCalibration()
  }

  // ---------- Render: upload zone ----------

  if (!pdfFile) {
    return (
      <div
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        className={`border-2 border-dashed rounded-xl p-16 text-center bg-neutral-50 transition-colors ${
          isDragging ? 'border-beme-500 bg-beme-50' : 'border-neutral-300 hover:border-beme-400'
        }`}
      >
        <p className="text-lg text-neutral-700 mb-2 font-medium">Drop your building plan PDF here</p>
        <p className="text-sm text-neutral-500 mb-6">or</p>
        <label className="inline-block px-6 py-3 bg-beme-600 text-white rounded-lg cursor-pointer hover:bg-beme-700 transition-colors font-medium">
          Choose a PDF
          <input
            type="file"
            accept="application/pdf"
            className="hidden"
            onChange={handleFileChange}
          />
        </label>
        <p className="text-xs text-neutral-400 mt-6">
          Multi-page plans are supported. Each page is calibrated separately.
        </p>
      </div>
    )
  }

  // ---------- Render: workspace ----------

  return (
    <div>
      {/* Top toolbar — filename & page nav */}
      <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
        <div>
          <p className="text-sm font-medium text-neutral-700">{pdfFile.name}</p>
          <button
            onClick={() => {
              setPdfFile(null)
              setNumPages(0)
              setCurrentPage(1)
              setPagesData({})
              setZoom(1)
              cancelCalibration()
            }}
            className="text-xs text-beme-600 hover:text-beme-700 hover:underline"
          >
            Replace PDF
          </button>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
            disabled={currentPage <= 1}
            className="px-4 py-2 rounded-lg border border-neutral-300 text-sm hover:bg-neutral-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            ← Prev
          </button>
          <span className="text-sm text-neutral-600 tabular-nums min-w-[6rem] text-center">
            Page {currentPage} of {numPages || '…'}
          </span>
          <button
            onClick={() => setCurrentPage((p) => Math.min(numPages, p + 1))}
            disabled={currentPage >= numPages}
            className="px-4 py-2 rounded-lg border border-neutral-300 text-sm hover:bg-neutral-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            Next →
          </button>
        </div>
      </div>

      {/* Zoom toolbar */}
      <div className="flex items-center justify-between mb-3 px-4 py-2 bg-neutral-50 border border-neutral-200 rounded-lg">
        <span className="text-xs text-neutral-500">Scroll to zoom. Click and drag to pan. Click the percentage to reset.</span>
        <div className="flex items-center gap-2">
          <button
            onClick={zoomOutButton}
            disabled={zoom <= MIN_ZOOM + 0.001}
            className="px-3 py-1 rounded border border-neutral-300 text-sm hover:bg-neutral-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            aria-label="Zoom out"
          >
            −
          </button>
          <button
            onClick={resetZoom}
            className="px-3 py-1 rounded border border-neutral-300 text-sm hover:bg-neutral-100 transition-colors min-w-[4.5rem] tabular-nums"
          >
            {Math.round(zoom * 100)}%
          </button>
          <button
            onClick={zoomInButton}
            disabled={zoom >= MAX_ZOOM - 0.001}
            className="px-3 py-1 rounded border border-neutral-300 text-sm hover:bg-neutral-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            aria-label="Zoom in"
          >
            +
          </button>
        </div>
      </div>

      {/* Scale toolbar */}
      <div className="flex items-center justify-between mb-3 px-4 py-3 bg-neutral-50 border border-neutral-200 rounded-lg flex-wrap gap-3">
        <div className="text-sm">
          {currentScale ? (
            <span className="text-neutral-700">
              Scale on page {currentPage}:{' '}
              <span className="font-semibold tabular-nums">{currentScale.toFixed(4)}</span>{' '}
              <span className="text-neutral-500">px/mm</span>{' '}
              <span className="text-neutral-400">({(1 / currentScale).toFixed(2)} mm/px)</span>
            </span>
          ) : (
            <span className="text-neutral-500">No scale set for page {currentPage}.</span>
          )}
        </div>

        {!calibrating && (
          <div className="flex items-center gap-2 flex-wrap">
            <label className="text-sm text-neutral-600">Ratio:</label>
            <select
              value=""
              onChange={(e) => {
                const v = e.target.value
                if (!v) return
                applyRatioScale(parseFloat(v))
                e.target.value = ''
              }}
              disabled={!pageData?.pageWidthMm}
              className="px-3 py-1.5 border border-neutral-300 rounded-lg text-sm bg-white disabled:opacity-50 focus:outline-none focus:border-beme-500"
            >
              <option value="">Choose…</option>
              {RATIO_PRESETS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
            <span className="text-sm text-neutral-400">or</span>
            <button
              onClick={startCalibration}
              className="px-4 py-1.5 rounded-lg bg-beme-600 text-white text-sm hover:bg-beme-700 transition-colors font-medium"
            >
              {currentScale ? 'Recalibrate by clicking' : 'Set by clicking'}
            </button>
          </div>
        )}

        {calibrating && (
          <button
            onClick={cancelCalibration}
            className="px-3 py-1.5 rounded-lg border border-neutral-300 text-sm hover:bg-neutral-100 transition-colors"
          >
            Cancel calibration
          </button>
        )}
      </div>

      {/* Calibration instructions banner */}
      {calibrating && !(calPoint1 && calPoint2) && (
        <div className="mb-3 px-4 py-3 bg-beme-50 border border-beme-300 rounded-lg text-sm text-beme-700">
          {!calPoint1
            ? 'Click the first point along a known dimension on the plan. Zoom in for accuracy.'
            : 'Click the second point.'}
        </div>
      )}

      {/* Calibration distance input */}
      {calibrating && calPoint1 && calPoint2 && (
        <div className="mb-3 px-4 py-3 bg-beme-50 border border-beme-300 rounded-lg flex items-center gap-3 flex-wrap">
          <span className="text-sm text-beme-700 font-medium">Real-world length of that line:</span>
          <input
            ref={inputRef}
            type="number"
            min="1"
            value={calInput}
            onChange={(e) => setCalInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitCalibration()
              if (e.key === 'Escape') cancelCalibration()
            }}
            placeholder="e.g. 5000"
            className="px-3 py-1.5 border border-beme-300 rounded-lg text-sm w-32 focus:outline-none focus:border-beme-500"
          />
          <span className="text-sm text-beme-700">mm</span>
          <button
            onClick={submitCalibration}
            disabled={!calInput || parseFloat(calInput) <= 0}
            className="px-4 py-1.5 rounded-lg bg-beme-600 text-white text-sm hover:bg-beme-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors font-medium"
          >
            Save scale
          </button>
        </div>
      )}

      {/* Page thumbnails + main PDF view */}
      <div className="flex gap-3">
        {/* Thumbnail sidebar (multi-page only) */}
        {numPages > 1 && (
          <div ref={sidebarRef} className="w-40 flex-shrink-0 max-h-[80vh] overflow-y-auto bg-white border border-neutral-200 rounded-xl p-2">
            <Document file={pdfFile} loading={null} error={null}>
              <div className="space-y-2">
                {Array.from({ length: numPages }, (_, i) => i + 1).map((pageNum) => {
                  const isCurrent = pageNum === currentPage
                  const hasScale = !!pagesData[pageNum]?.scalePxPerMm
                  return (
                    <button
                      key={pageNum}
                      onClick={() => setCurrentPage(pageNum)}
                      className={`block w-full p-1 rounded-md transition-colors text-left ${
                        isCurrent
                          ? 'ring-2 ring-beme-500 bg-beme-50'
                          : 'ring-1 ring-neutral-200 hover:ring-beme-300 bg-white'
                      }`}
                    >
                      <div
                        className="bg-neutral-50 flex justify-center overflow-hidden rounded-sm"
                        style={{ lineHeight: 0 }}
                      >
                        <Page
                          pageNumber={pageNum}
                          width={130}
                          renderAnnotationLayer={false}
                          renderTextLayer={false}
                        />
                      </div>
                      <div
                        className={`mt-1 text-xs flex items-center justify-between px-1 ${
                          isCurrent ? 'text-beme-700 font-semibold' : 'text-neutral-600'
                        }`}
                      >
                        <span>Page {pageNum}</span>
                        {hasScale && <span className="text-green-600" title="Scale set">✓</span>}
                      </div>
                    </button>
                  )
                })}
              </div>
            </Document>
          </div>
        )}

      {/* PDF + overlay (scrollable container with wheel-zoom and click-drag pan) */}
      <div
        ref={containerRef}
        onMouseDown={handlePanMouseDown}
        className="flex-1 border border-neutral-200 rounded-xl overflow-auto bg-neutral-100 min-h-[400px] max-h-[80vh]"
        style={{ cursor: calibrating ? 'crosshair' : 'grab' }}
      >
        <div className="flex justify-center" style={{ minWidth: 'max-content' }}>
          {/* Outer wrapper holds the VISUAL (transformed) dimensions so scrolling sizes correctly */}
          <div
            className="relative"
            style={{
              width: visualPageWidth || undefined,
              height: visualPageHeight ?? undefined,
              lineHeight: 0,
            }}
          >
            {/* Inner wrapper is at the rendered (canvas) resolution and gets CSS-scaled. */}
            <div
              style={{
                width: renderedPageWidth,
                height: renderedPageHeight ?? undefined,
                transform: visualScale !== 1 ? `scale(${visualScale})` : undefined,
                transformOrigin: '0 0',
                willChange: visualScale !== 1 ? 'transform' : undefined,
              }}
            >
              <Document
                file={pdfFile}
                onLoadSuccess={({ numPages: n }) => setNumPages(n)}
                loading={<p className="text-neutral-500 p-12">Loading PDF…</p>}
                error={<p className="text-red-600 p-12">Couldn't load that PDF. Is it a valid file?</p>}
              >
                <Page
                  pageNumber={currentPage}
                  width={renderedPageWidth}
                  renderAnnotationLayer={false}
                  renderTextLayer={false}
                  onLoadSuccess={(page) => {
                    const widthMm = (page.originalWidth / POINTS_PER_INCH) * MM_PER_INCH
                    const heightMm = (page.originalHeight / POINTS_PER_INCH) * MM_PER_INCH
                    setPagesData((prev) => ({
                      ...prev,
                      [currentPage]: {
                        ...prev[currentPage],
                        pageWidthMm: widthMm,
                        pageHeightMm: heightMm,
                      },
                    }))
                  }}
                />
              </Document>
            </div>

            {/* Calibration overlay — lives at visual scale so click coords map to visual pixels */}
            <svg
              ref={svgRef}
              className="absolute inset-0 w-full h-full"
              style={{
                pointerEvents: calibrating ? 'auto' : 'none',
                cursor: calibrating ? 'crosshair' : 'default',
              }}
              onClick={handleSvgClick}
              onMouseMove={handleSvgMouseMove}
            >
              {calibrating && calPoint1 && !calPoint2 && mousePos && (
                <line
                  x1={calPoint1.x}
                  y1={calPoint1.y}
                  x2={mousePos.x}
                  y2={mousePos.y}
                  stroke="#ED7D31"
                  strokeWidth="2"
                  strokeDasharray="4 4"
                />
              )}
              {calPoint1 && calPoint2 && (
                <line
                  x1={calPoint1.x}
                  y1={calPoint1.y}
                  x2={calPoint2.x}
                  y2={calPoint2.y}
                  stroke="#ED7D31"
                  strokeWidth="3"
                />
              )}
              {calPoint1 && (
                <circle cx={calPoint1.x} cy={calPoint1.y} r="5" fill="#ED7D31" stroke="white" strokeWidth="2" />
              )}
              {calPoint2 && (
                <circle cx={calPoint2.x} cy={calPoint2.y} r="5" fill="#ED7D31" stroke="white" strokeWidth="2" />
              )}
            </svg>
          </div>
        </div>
      </div>
      </div>
    </div>
  )
}
