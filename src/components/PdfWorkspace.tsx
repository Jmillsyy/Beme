import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Document, Page, pdfjs } from 'react-pdf'
import 'react-pdf/dist/Page/AnnotationLayer.css'
import 'react-pdf/dist/Page/TextLayer.css'
import WallDrawingLayer from './WallDrawingLayer'
import BlockTallyPanel from './BlockTallyPanel'
import WallTypesPanel from './WallTypesPanel'
import BrickSettingsPanel from './BrickSettingsPanel'
import BrickTallyPanel from './BrickTallyPanel'
import ProjectDetailsPanel from './ProjectDetailsPanel'
import BrickExportPanel from './BrickExportPanel'
import type {
  BrickExportInclusions,
  BrickSettings,
  Opening,
  ProjectDetails,
  Wall,
  WallMakeup,
} from '../types/walls'
import { createDefaultWallMakeup } from '../lib/makeups'
import { createDefaultBrickSettings, selectBrickLintelSize } from '../lib/brickCalc'
import {
  createDefaultExportInclusions,
  createDefaultProjectDetails,
} from '../lib/brickExport'
import { detectJunctionsForNewWall, recomputeAllJunctions } from '../lib/junctions'
import { selectBlockLintel, brickLintelBearingMm, brickLintelTotalLengthMm } from '../lib/lintels'

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

interface PdfWorkspaceProps {
  /**
   * Estimate mode. When 'block', enables wall drawing tools and a live block tally panel
   * below the PDF view. 'brick' will get its own workflow later.
   */
  mode?: 'block' | 'brick'
}

export default function PdfWorkspace({ mode }: PdfWorkspaceProps = {}) {
  const [pdfFile, setPdfFile] = useState<File | null>(null)
  const [numPages, setNumPages] = useState<number>(0)
  const [currentPage, setCurrentPage] = useState<number>(1)
  const [isDragging, setIsDragging] = useState(false)

  // ---------- Wall drawing state (block mode) ----------
  const [wallsByPage, setWallsByPage] = useState<Record<number, Wall[]>>({})
  const [drawingMode, setDrawingMode] = useState(false)
  const [selectedWallId, setSelectedWallId] = useState<string | null>(null)
  const drawingModeRef = useRef(false)

  // ---------- Opening state (block mode) ----------
  const [openingsByPage, setOpeningsByPage] = useState<Record<number, Opening[]>>({})
  const [placingOpening, setPlacingOpening] = useState(false)
  const [selectedOpeningId, setSelectedOpeningId] = useState<string | null>(null)
  const [pendingOpening, setPendingOpening] = useState<{
    wallId: string
    startAlongWallMm: number
    widthMm: number
  } | null>(null)
  const placingOpeningRef = useRef(false)
  const [openingSillHeightMm, setOpeningSillHeightMm] = useState(0)
  const [openingHeadHeightMm, setOpeningHeadHeightMm] = useState(300)
  /** Brick-mode opening height — user types it directly, no sill/head math needed. */
  const [brickOpeningHeightMm, setBrickOpeningHeightMm] = useState(2100)
  const [makeups, setMakeups] = useState<WallMakeup[]>(() => [
    createDefaultWallMakeup({ name: 'External 2400mm stretcher' }),
  ])
  const [activeMakeupId, setActiveMakeupId] = useState<string>(() => makeups[0].id)

  const makeupsById = useMemo(
    () => Object.fromEntries(makeups.map((m) => [m.id, m])),
    [makeups]
  )

  // Brick-mode settings
  const [brickSettings, setBrickSettings] = useState<BrickSettings>(() =>
    createDefaultBrickSettings()
  )

  // Project details + export inclusion tickboxes (brick mode)
  const [projectDetails, setProjectDetails] = useState<ProjectDetails>(() =>
    createDefaultProjectDetails()
  )
  const [exportInclusions, setExportInclusions] = useState<BrickExportInclusions>(() =>
    createDefaultExportInclusions()
  )

  // Keep drawingMode ref in sync for pan handler
  useEffect(() => {
    drawingModeRef.current = drawingMode
  }, [drawingMode])

  useEffect(() => {
    placingOpeningRef.current = placingOpening
  }, [placingOpening])

  const allWalls = useMemo(() => Object.values(wallsByPage).flat(), [wallsByPage])
  const currentPageWalls = wallsByPage[currentPage] ?? []
  const allOpenings = useMemo(() => Object.values(openingsByPage).flat(), [openingsByPage])
  const currentPageOpenings = openingsByPage[currentPage] ?? []
  const selectedOpening = useMemo(
    () => (selectedOpeningId ? currentPageOpenings.find((o) => o.id === selectedOpeningId) : null),
    [selectedOpeningId, currentPageOpenings]
  )
  const pendingOpeningWall = useMemo(
    () => (pendingOpening ? currentPageWalls.find((w) => w.id === pendingOpening.wallId) : null),
    [pendingOpening, currentPageWalls]
  )

  const wallCountsByMakeupId = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const w of allWalls) counts[w.makeupId] = (counts[w.makeupId] ?? 0) + 1
    return counts
  }, [allWalls])

  const selectedWall = useMemo(
    () => (selectedWallId ? currentPageWalls.find((w) => w.id === selectedWallId) : null),
    [selectedWallId, currentPageWalls]
  )

  function handleWallAdded(startMm: { x: number; y: number }, endMm: { x: number; y: number }) {
    const isBrick = mode === 'brick'
    const rawWall: Wall = {
      id:
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `w-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      // Brick walls don't reference a WallMakeup — they use brickSettings instead.
      makeupId: isBrick ? '' : activeMakeupId,
      startX: startMm.x,
      startY: startMm.y,
      endX: endMm.x,
      endY: endMm.y,
      startJunction: { type: 'free' },
      endJunction: { type: 'free' },
      heightMmOverride: isBrick ? brickSettings.defaultWallHeightMm : undefined,
    }

    const existing = wallsByPage[currentPage] ?? []
    // Junction detection only matters for block walls (corners affect tally). Brick mode
    // doesn't need junctions, but running detection doesn't hurt and keeps state consistent.
    const { newWall, updatedExistingWalls } = detectJunctionsForNewWall(rawWall, existing)

    setWallsByPage((prev) => ({
      ...prev,
      [currentPage]: [...updatedExistingWalls, newWall],
    }))
  }

  function handleWallHeightChange(wallId: string, heightMm: number) {
    setWallsByPage((prev) => {
      const pageWalls = prev[currentPage] ?? []
      const updated = pageWalls.map((w) =>
        w.id === wallId ? { ...w, heightMmOverride: heightMm } : w
      )
      return { ...prev, [currentPage]: updated }
    })
  }

  function handleAddMakeup(makeup: WallMakeup) {
    setMakeups((prev) => [...prev, makeup])
    setActiveMakeupId(makeup.id)
  }

  function handleUpdateMakeup(updated: WallMakeup) {
    setMakeups((prev) => prev.map((m) => (m.id === updated.id ? updated : m)))
  }

  function handleDeleteMakeup(id: string) {
    setMakeups((prev) => {
      const remaining = prev.filter((m) => m.id !== id)
      if (remaining.length === 0) return prev
      if (activeMakeupId === id) {
        setActiveMakeupId(remaining[0].id)
      }
      return remaining
    })
  }

  function handleReassignWallMakeup(wallId: string, makeupId: string) {
    setWallsByPage((prev) => {
      const pageWalls = prev[currentPage] ?? []
      const updated = pageWalls.map((w) => (w.id === wallId ? { ...w, makeupId } : w))
      return { ...prev, [currentPage]: updated }
    })
  }

  // ---------- Opening handlers ----------

  function handleOpeningPlaced(wallId: string, startAlongWallMm: number, widthMm: number) {
    setPendingOpening({ wallId, startAlongWallMm, widthMm })
    setPlacingOpening(false)
  }

  function handleSavePendingOpening() {
    if (!pendingOpening) return
    const wall = currentPageWalls.find((w) => w.id === pendingOpening.wallId)
    if (!wall) return

    let openingHeightForSave: number
    let sillForSave: number

    if (mode === 'brick') {
      // Brick mode: user types height directly; sill irrelevant for tally (just stored as 0).
      if (brickOpeningHeightMm < 100) return
      openingHeightForSave = brickOpeningHeightMm
      sillForSave = 0
    } else {
      // Block mode: opening height = wall − sill − head.
      const makeup = makeupsById[wall.makeupId]
      const wallHeightMm = wall.heightMmOverride ?? makeup?.heightMm ?? 0
      const computed = wallHeightMm - openingSillHeightMm - openingHeadHeightMm
      if (computed < 100) return
      openingHeightForSave = computed
      sillForSave = openingSillHeightMm
    }

    const newOpening: Opening = {
      id:
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `o-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      wallId: pendingOpening.wallId,
      startAlongWallMm: pendingOpening.startAlongWallMm,
      widthMm: pendingOpening.widthMm,
      heightMm: openingHeightForSave,
      sillHeightMm: sillForSave,
    }
    setOpeningsByPage((prev) => ({
      ...prev,
      [currentPage]: [...(prev[currentPage] ?? []), newOpening],
    }))
    setPendingOpening(null)
  }

  function handleCancelPendingOpening() {
    setPendingOpening(null)
  }

  function handleOpeningDelete(openingId: string) {
    setOpeningsByPage((prev) => {
      const pageOpenings = prev[currentPage] ?? []
      return { ...prev, [currentPage]: pageOpenings.filter((o) => o.id !== openingId) }
    })
    setSelectedOpeningId(null)
  }

  function clearAllWalls() {
    if (allWalls.length === 0) return
    if (!window.confirm(`Delete all ${allWalls.length} walls in this project?`)) return
    setWallsByPage({})
    setDrawingMode(false)
    setSelectedWallId(null)
  }

  function handleWallEndpointMoved(
    wallId: string,
    which: 'start' | 'end',
    newPositionMm: { x: number; y: number }
  ) {
    setWallsByPage((prev) => {
      const pageWalls = prev[currentPage] ?? []
      const updated = pageWalls.map((w) => {
        if (w.id !== wallId) return w
        if (which === 'start') {
          return { ...w, startX: newPositionMm.x, startY: newPositionMm.y }
        }
        return { ...w, endX: newPositionMm.x, endY: newPositionMm.y }
      })
      return { ...prev, [currentPage]: recomputeAllJunctions(updated) }
    })
  }

  function handleWallDelete(wallId: string) {
    setWallsByPage((prev) => {
      const pageWalls = prev[currentPage] ?? []
      const remaining = pageWalls.filter((w) => w.id !== wallId)
      return { ...prev, [currentPage]: recomputeAllJunctions(remaining) }
    })
    setSelectedWallId(null)
  }

  // Delete / Backspace removes the selected wall or selected opening
  useEffect(() => {
    if (!selectedWallId && !selectedOpeningId) return
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Delete' || e.key === 'Backspace') {
        const tgt = e.target as HTMLElement | null
        if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA')) return
        e.preventDefault()
        if (selectedOpeningId) handleOpeningDelete(selectedOpeningId)
        else if (selectedWallId) handleWallDelete(selectedWallId)
      }
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedWallId, selectedOpeningId])

  // Clear selection when leaving the page or replacing PDF
  useEffect(() => {
    setSelectedWallId(null)
    setSelectedOpeningId(null)
  }, [currentPage, pdfFile])

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
  /**
   * True if a pan was activated during the current mouse press. Stays true until the next
   * mousedown resets it. Used to suppress the browser's `click` event from reaching Konva
   * after a pan — Konva would otherwise treat the click+drag as a click (because in canvas-
   * local coordinates the cursor doesn't move, since the canvas scrolls with the cursor).
   */
  const didPanDuringPressRef = useRef(false)
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
  //
  // Click-vs-drag: on mousedown we just RECORD the start position; we don't start panning
  // until the cursor has moved beyond PAN_DRAG_THRESHOLD_PX. That lets the same left button
  // work for both: a click without movement falls through to Konva (draw a point, select a
  // wall, place a calibration mark), while a click+drag pans the view.
  useEffect(() => {
    if (!pdfFile) return

    const PAN_DRAG_THRESHOLD_PX = 4
    const container = containerRef.current
    if (!container) return

    const handleDocMouseMove = (e: MouseEvent) => {
      if (!panStartRef.current || !containerRef.current) return
      const start = panStartRef.current
      const dx = e.clientX - start.x
      const dy = e.clientY - start.y

      // Activate pan only once movement exceeds the threshold
      if (!isPanningRef.current) {
        if (dx * dx + dy * dy < PAN_DRAG_THRESHOLD_PX * PAN_DRAG_THRESHOLD_PX) return
        isPanningRef.current = true
        didPanDuringPressRef.current = true
        containerRef.current.style.cursor = 'grabbing'
      }

      containerRef.current.scrollLeft = start.scrollLeft - dx
      containerRef.current.scrollTop = start.scrollTop - dy
    }

    const handleDocMouseUp = () => {
      if (isPanningRef.current) {
        isPanningRef.current = false
        if (containerRef.current) {
          containerRef.current.style.cursor = ''
        }
      }
      panStartRef.current = null
    }

    // Capture-phase click listener: if a pan happened during this press, swallow the
    // browser's click event before it reaches Konva (which would otherwise treat the
    // click+drag as a click in its local coordinates).
    const handleContainerClickCapture = (e: MouseEvent) => {
      if (didPanDuringPressRef.current) {
        e.stopPropagation()
        e.preventDefault()
        didPanDuringPressRef.current = false
      }
    }

    document.addEventListener('mousemove', handleDocMouseMove)
    document.addEventListener('mouseup', handleDocMouseUp)
    container.addEventListener('click', handleContainerClickCapture, { capture: true })
    return () => {
      document.removeEventListener('mousemove', handleDocMouseMove)
      document.removeEventListener('mouseup', handleDocMouseUp)
      container.removeEventListener('click', handleContainerClickCapture, { capture: true })
    }
  }, [pdfFile])

  function handlePanMouseDown(e: React.MouseEvent<HTMLDivElement>) {
    if (e.button !== 0) return // only left mouse button
    const container = containerRef.current
    if (!container) return

    // Reset pan-during-press flag for this new mouse press.
    didPanDuringPressRef.current = false

    // Just record the start point — pan activates from the document mousemove once the
    // cursor has moved past the threshold. This way clicks fall through to Konva for
    // drawing / placing / selecting, and only deliberate drags scroll the view.
    panStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      scrollLeft: container.scrollLeft,
      scrollTop: container.scrollTop,
    }
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
      {/* Project details panel (block + brick) — at the very top since it's one-time setup */}
      {(mode === 'block' || mode === 'brick') && (
        <ProjectDetailsPanel details={projectDetails} onChange={setProjectDetails} />
      )}

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

      {/* Sticky action bar — keeps drawing controls + banners glued to the top of the
          viewport while the user scrolls, so they don't need to scroll up to start a new
          wall/opening. Wraps the wall-drawing toolbar and all contextual banners/forms. */}
      <div className="sticky top-0 z-20 bg-white pt-2 pb-1 -mx-1 px-1 mb-2 shadow-[0_1px_0_rgba(0,0,0,0.06)]">

      {/* Wall drawing toolbar (block + brick modes) */}
      {(mode === 'block' || mode === 'brick') && (
        <div className="flex items-center justify-between mb-3 px-4 py-3 bg-neutral-50 border border-neutral-200 rounded-lg flex-wrap gap-3">
          <div className="text-sm">
            {currentScale ? (
              <span className="text-neutral-700">
                {currentPageWalls.length}{' '}
                wall{currentPageWalls.length === 1 ? '' : 's'} on this page
                {allWalls.length !== currentPageWalls.length && (
                  <span className="text-neutral-500">
                    {' '}
                    · {allWalls.length} total in project
                  </span>
                )}
              </span>
            ) : (
              <span className="text-neutral-500">
                Calibrate the scale on this page before drawing walls.
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={() => {
                setDrawingMode((v) => !v)
                setPlacingOpening(false)
                setSelectedWallId(null)
                setSelectedOpeningId(null)
              }}
              disabled={!currentScale || calibrating}
              className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                drawingMode
                  ? 'bg-beme-700 text-white hover:bg-beme-800'
                  : 'bg-beme-600 text-white hover:bg-beme-700 disabled:opacity-40 disabled:cursor-not-allowed'
              }`}
            >
              {drawingMode ? 'Stop drawing' : 'Draw wall'}
            </button>
            <button
              onClick={() => {
                setPlacingOpening((v) => !v)
                setDrawingMode(false)
                setSelectedWallId(null)
                setSelectedOpeningId(null)
              }}
              disabled={!currentScale || calibrating || currentPageWalls.length === 0}
              className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                placingOpening
                  ? 'bg-amber-700 text-white hover:bg-amber-800'
                  : 'bg-amber-600 text-white hover:bg-amber-700 disabled:opacity-40 disabled:cursor-not-allowed'
              }`}
            >
              {placingOpening ? 'Cancel opening' : '+ Add opening'}
            </button>
            {allWalls.length > 0 && (
              <button
                onClick={clearAllWalls}
                className="px-3 py-1.5 rounded-lg border border-neutral-300 text-sm hover:bg-neutral-100 transition-colors"
              >
                Clear all walls
              </button>
            )}
          </div>
        </div>
      )}

      {drawingMode && (
        <div className="mb-3 px-4 py-3 bg-beme-50 border border-beme-300 rounded-lg text-sm text-beme-700">
          Click two points on the plan to draw a wall. Press <kbd className="px-1.5 py-0.5 rounded border border-beme-300 bg-white text-xs font-mono">Esc</kbd> to cancel.
        </div>
      )}

      {placingOpening && (
        <div className="mb-3 px-4 py-3 bg-amber-50 border border-amber-300 rounded-lg text-sm text-amber-800">
          Click two points along the same wall to define the opening. Press{' '}
          <kbd className="px-1.5 py-0.5 rounded border border-amber-300 bg-white text-xs font-mono">Esc</kbd> to cancel.
        </div>
      )}

      {/* Pending opening form — block mode (sill + head, opening height computed) */}
      {pendingOpening && pendingOpeningWall && mode === 'block' && (() => {
        const pendingMakeup = makeupsById[pendingOpeningWall.makeupId]
        const wallHeightMm =
          pendingOpeningWall.heightMmOverride ?? pendingMakeup?.heightMm ?? 0
        const computedOpeningHeightMm = wallHeightMm - openingSillHeightMm - openingHeadHeightMm
        const lintelBlock =
          openingHeadHeightMm > 0 ? selectBlockLintel(openingHeadHeightMm).code : null
        const tooSmall = computedOpeningHeightMm < 100
        return (
          <div className="mb-3 px-4 py-3 bg-amber-50 border border-amber-300 rounded-lg text-sm text-amber-800">
            <div className="font-medium mb-3">
              Opening on a {Math.round(wallHeightMm)}mm wall · {Math.round(pendingOpening.widthMm)}mm wide
            </div>
            <div className="flex flex-wrap items-end gap-3">
              <label className="text-sm">
                <span className="block text-amber-700 mb-1">Sill height (mm)</span>
                <input
                  type="number"
                  min="0"
                  step="50"
                  value={openingSillHeightMm}
                  onChange={(e) => setOpeningSillHeightMm(parseInt(e.target.value || '0', 10))}
                  className="px-3 py-1.5 border border-amber-300 rounded-lg text-sm bg-white w-28 focus:outline-none focus:border-amber-500"
                />
              </label>
              <label className="text-sm">
                <span className="block text-amber-700 mb-1">Head height (mm)</span>
                <input
                  type="number"
                  min="0"
                  step="50"
                  value={openingHeadHeightMm}
                  onChange={(e) => setOpeningHeadHeightMm(parseInt(e.target.value || '0', 10))}
                  className="px-3 py-1.5 border border-amber-300 rounded-lg text-sm bg-white w-28 focus:outline-none focus:border-amber-500"
                />
              </label>
              <button
                onClick={handleSavePendingOpening}
                disabled={tooSmall}
                className="px-4 py-1.5 rounded-lg bg-amber-600 text-white text-sm hover:bg-amber-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors font-medium"
              >
                Save opening
              </button>
              <button
                onClick={handleCancelPendingOpening}
                className="px-4 py-1.5 rounded-lg border border-amber-300 text-sm hover:bg-amber-100 transition-colors"
              >
                Cancel
              </button>
            </div>

            <div className="mt-3 px-3 py-2 bg-white border border-amber-200 rounded-lg text-xs">
              <div className="font-mono text-amber-800 leading-relaxed">
                <div>
                  <span className="text-amber-500">└─</span> Head (above opening):{' '}
                  <span className="font-semibold">{Math.round(openingHeadHeightMm)}mm</span>{' '}
                  {lintelBlock ? (
                    <span className="text-amber-600">→ Lintel {lintelBlock}</span>
                  ) : (
                    <span className="text-red-600">→ no lintel</span>
                  )}
                </div>
                <div>
                  <span className="text-amber-500">│</span> Opening (computed):{' '}
                  <span className={tooSmall ? 'text-red-600 font-semibold' : 'font-semibold'}>
                    {Math.round(pendingOpening.widthMm)} × {Math.round(computedOpeningHeightMm)}mm
                  </span>
                </div>
                <div>
                  <span className="text-amber-500">└─</span> Sill (wall below):{' '}
                  <span className="font-semibold">{Math.round(openingSillHeightMm)}mm</span>{' '}
                  <span className="text-amber-600">— from floor</span>
                </div>
              </div>
              {tooSmall && (
                <div className="mt-1 text-red-600">
                  Sill + Head leave less than 100mm for the opening on a {Math.round(wallHeightMm)}mm wall.
                  Reduce one of them.
                </div>
              )}
            </div>

            <p className="text-xs text-amber-700 mt-2">
              Typical door: sill <strong>0</strong>, head <strong>300</strong> (gives a 2100mm opening on a 2400mm
              wall). Typical window: sill <strong>900</strong>, head <strong>300</strong> (gives a 1200mm opening
              on a 2400mm wall).
            </p>
          </div>
        )
      })()}

      {/* Pending opening form — brick mode (just height) */}
      {pendingOpening && pendingOpeningWall && mode === 'brick' && (() => {
        const wallHeightMm =
          pendingOpeningWall.heightMmOverride ?? brickSettings.defaultWallHeightMm
        const lintelLength = brickLintelTotalLengthMm(pendingOpening.widthMm)
        const bearing = brickLintelBearingMm(pendingOpening.widthMm)
        const tooSmall = brickOpeningHeightMm < 100
        const tooTall = brickOpeningHeightMm > wallHeightMm
        return (
          <div className="mb-3 px-4 py-3 bg-amber-50 border border-amber-300 rounded-lg text-sm text-amber-800">
            <div className="font-medium mb-3">
              Opening on a {Math.round(wallHeightMm)}mm wall ·{' '}
              {Math.round(pendingOpening.widthMm)}mm wide
            </div>
            <div className="flex flex-wrap items-end gap-3">
              <label className="text-sm">
                <span className="block text-amber-700 mb-1">Opening height (mm)</span>
                <input
                  type="number"
                  min="100"
                  step="50"
                  value={brickOpeningHeightMm}
                  onChange={(e) =>
                    setBrickOpeningHeightMm(parseInt(e.target.value || '0', 10))
                  }
                  className="px-3 py-1.5 border border-amber-300 rounded-lg text-sm bg-white w-32 focus:outline-none focus:border-amber-500"
                  autoFocus
                />
              </label>
              <button
                onClick={handleSavePendingOpening}
                disabled={tooSmall || tooTall}
                className="px-4 py-1.5 rounded-lg bg-amber-600 text-white text-sm hover:bg-amber-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors font-medium"
              >
                Save opening
              </button>
              <button
                onClick={handleCancelPendingOpening}
                className="px-4 py-1.5 rounded-lg border border-amber-300 text-sm hover:bg-amber-100 transition-colors"
              >
                Cancel
              </button>
            </div>

            <div className="mt-3 px-3 py-2 bg-white border border-amber-200 rounded-lg text-xs text-amber-800">
              <div>
                Opening{' '}
                <span className="font-semibold">
                  {Math.round(pendingOpening.widthMm)} × {Math.round(brickOpeningHeightMm)}mm
                </span>
              </div>
              <div className="mt-1">
                Required lintel: <span className="font-semibold">{Math.round(lintelLength)}mm</span>{' '}
                ({bearing}mm bearing each side){' '}
                {(() => {
                  const sel = selectBrickLintelSize(lintelLength)
                  return sel ? (
                    <span className="text-amber-600">
                      → supply <span className="font-semibold">{sel.lengthMm}mm {sel.profile}</span>
                    </span>
                  ) : (
                    <span className="text-red-600">
                      → exceeds stock sizes (max 6000mm), custom needed
                    </span>
                  )
                })()}
              </div>
              {tooSmall && (
                <div className="mt-1 text-red-600">Opening height must be at least 100mm.</div>
              )}
              {tooTall && (
                <div className="mt-1 text-red-600">
                  Opening height ({brickOpeningHeightMm}mm) exceeds the wall height ({Math.round(wallHeightMm)}mm).
                </div>
              )}
            </div>

            <p className="text-xs text-amber-700 mt-2">
              Typical door <strong>2100mm</strong>, typical window <strong>1200mm</strong>.
            </p>
          </div>
        )
      })()}

      {/* Selected opening banner — same banner, mode-aware lintel info */}
      {(mode === 'block' || mode === 'brick') &&
        selectedOpening &&
        !placingOpening &&
        !drawingMode &&
        (() => {
          const selWall = currentPageWalls.find((w) => w.id === selectedOpening.wallId)
          const selMakeup = selWall ? makeupsById[selWall.makeupId] : undefined
          const selWallHeightMm =
            selWall?.heightMmOverride ??
            selMakeup?.heightMm ??
            (mode === 'brick' ? brickSettings.defaultWallHeightMm : 0)
          const selHead = selWallHeightMm - selectedOpening.sillHeightMm - selectedOpening.heightMm
          const selBlockLintel =
            mode === 'block' && selHead > 0 ? selectBlockLintel(selHead).code : null
          const brickLintelLength =
            mode === 'brick' ? brickLintelTotalLengthMm(selectedOpening.widthMm) : null
          const brickBearing =
            mode === 'brick' ? brickLintelBearingMm(selectedOpening.widthMm) : null
          const brickStockLintel =
            mode === 'brick' && brickLintelLength != null
              ? selectBrickLintelSize(brickLintelLength)
              : null
          return (
            <div className="mb-3 px-4 py-3 bg-blue-50 border border-blue-300 rounded-lg text-sm text-blue-700 flex items-center justify-between flex-wrap gap-3">
              <div>
                <div className="font-medium">
                  Opening: {Math.round(selectedOpening.widthMm)} ×{' '}
                  {Math.round(selectedOpening.heightMm)} mm
                </div>
                <div className="text-xs text-blue-600 mt-0.5">
                  Sill {Math.round(selectedOpening.sillHeightMm)}mm · Head{' '}
                  {Math.round(selHead)}mm
                  {mode === 'block' && selBlockLintel && (
                    <span> · Lintel {selBlockLintel}</span>
                  )}
                  {mode === 'brick' && brickLintelLength != null && (
                    <span>
                      {' '}
                      · Lintel required {Math.round(brickLintelLength)}mm ({brickBearing}mm bearing
                      each side)
                      {brickStockLintel ? (
                        <span>
                          {' '}
                          → <span className="font-semibold">{brickStockLintel.lengthMm}mm {brickStockLintel.profile}</span>
                        </span>
                      ) : (
                        <span className="text-red-600"> → custom (exceeds 6000mm)</span>
                      )}
                    </span>
                  )}{' '}
                  · on a {Math.round(selWallHeightMm)}mm wall
                </div>
                <div className="text-xs text-blue-600 mt-0.5">
                  Press{' '}
                  <kbd className="px-1.5 py-0.5 rounded border border-blue-300 bg-white text-xs font-mono">
                    Del
                  </kbd>{' '}
                  to remove.
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => handleOpeningDelete(selectedOpening.id)}
                  className="px-3 py-1.5 rounded-lg bg-red-600 text-white text-sm hover:bg-red-700 transition-colors"
                >
                  Delete opening
                </button>
                <button
                  onClick={() => setSelectedOpeningId(null)}
                  className="px-3 py-1.5 rounded-lg border border-neutral-300 text-sm hover:bg-neutral-100 transition-colors"
                >
                  Deselect
                </button>
              </div>
            </div>
          )
        })()}

      {(mode === 'block' || mode === 'brick') && selectedWall && !drawingMode && (
        <div className="mb-3 px-4 py-3 bg-blue-50 border border-blue-300 rounded-lg text-sm text-blue-700 flex items-center justify-between flex-wrap gap-2">
          <span>
            1 wall selected. Drag its endpoints to reposition, or press{' '}
            <kbd className="px-1.5 py-0.5 rounded border border-blue-300 bg-white text-xs font-mono">Del</kbd> to remove.
          </span>
          <div className="flex items-center gap-2 flex-wrap">
            {mode === 'block' && (
              <label className="flex items-center gap-2 text-sm text-blue-700">
                <span>Wall type:</span>
                <select
                  value={selectedWall.makeupId}
                  onChange={(e) => handleReassignWallMakeup(selectedWall.id, e.target.value)}
                  className="px-2 py-1 border border-blue-300 rounded text-sm bg-white"
                >
                  {makeups.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {mode === 'brick' && (
              <label className="flex items-center gap-2 text-sm text-blue-700">
                <span>Height:</span>
                <input
                  type="number"
                  min="200"
                  step="50"
                  value={selectedWall.heightMmOverride ?? brickSettings.defaultWallHeightMm}
                  onChange={(e) =>
                    handleWallHeightChange(
                      selectedWall.id,
                      parseInt(e.target.value || '0', 10)
                    )
                  }
                  className="px-2 py-1 border border-blue-300 rounded text-sm bg-white w-24"
                />
                <span>mm</span>
              </label>
            )}
            <button
              onClick={() => handleWallDelete(selectedWall.id)}
              className="px-3 py-1.5 rounded-lg bg-red-600 text-white text-sm hover:bg-red-700 transition-colors"
            >
              Delete wall
            </button>
            <button
              onClick={() => setSelectedWallId(null)}
              className="px-3 py-1.5 rounded-lg border border-neutral-300 text-sm hover:bg-neutral-100 transition-colors"
            >
              Deselect
            </button>
          </div>
        </div>
      )}

      </div>
      {/* End of sticky action bar */}

      {/* Wall types management panel (block mode) */}
      {mode === 'block' && (
        <WallTypesPanel
          makeups={makeups}
          activeMakeupId={activeMakeupId}
          wallCountsByMakeupId={wallCountsByMakeupId}
          onSetActive={setActiveMakeupId}
          onAddMakeup={handleAddMakeup}
          onUpdateMakeup={handleUpdateMakeup}
          onDeleteMakeup={handleDeleteMakeup}
        />
      )}

      {/* Brick settings panel (brick mode) */}
      {mode === 'brick' && (
        <BrickSettingsPanel settings={brickSettings} onChange={setBrickSettings} />
      )}

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
        style={{ cursor: calibrating || drawingMode || placingOpening ? 'crosshair' : 'grab' }}
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

            {/* Wall drawing layer (block + brick modes) */}
            {(mode === 'block' || mode === 'brick') && visualPageHeight !== null && currentScale && (
              <WallDrawingLayer
                walls={currentPageWalls}
                openings={currentPageOpenings}
                visualWidth={visualPageWidth}
                visualHeight={visualPageHeight}
                pxPerMmAtCurrentZoom={currentScale * zoom}
                drawingMode={drawingMode}
                placingOpening={placingOpening}
                selectedWallId={selectedWallId}
                selectedOpeningId={selectedOpeningId}
                onWallAdded={handleWallAdded}
                onWallSelect={(id) => {
                  setSelectedWallId(id)
                  if (id) setSelectedOpeningId(null)
                }}
                onWallEndpointMoved={handleWallEndpointMoved}
                onOpeningPlaced={handleOpeningPlaced}
                onOpeningSelect={(id) => {
                  setSelectedOpeningId(id)
                  if (id) setSelectedWallId(null)
                }}
                onCancelDraw={() => {
                  setDrawingMode(false)
                  setPlacingOpening(false)
                }}
              />
            )}
          </div>
        </div>
      </div>
      </div>

      {/* Block tally panel (block mode) */}
      {mode === 'block' && (
        <BlockTallyPanel walls={allWalls} makeupsById={makeupsById} openings={allOpenings} />
      )}

      {/* Brick tally panel (brick mode) */}
      {mode === 'brick' && (
        <BrickTallyPanel walls={allWalls} openings={allOpenings} settings={brickSettings} />
      )}

      {/* Brick export panel (brick mode) */}
      {mode === 'brick' && (
        <BrickExportPanel
          projectDetails={projectDetails}
          inclusions={exportInclusions}
          onChangeInclusions={setExportInclusions}
          settings={brickSettings}
          walls={allWalls}
          openings={allOpenings}
        />
      )}
    </div>
  )
}
