import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Document, Page, pdfjs } from 'react-pdf'
import 'react-pdf/dist/Page/AnnotationLayer.css'
import 'react-pdf/dist/Page/TextLayer.css'
import WallDrawingLayer from './WallDrawingLayer'
import BlockLibraryPanel from './BlockLibraryPanel'
import BlockTallyPanel from './BlockTallyPanel'
import BrickLibraryPanel from './BrickLibraryPanel'
import PierTypesPanel from './PierTypesPanel'
import WallTypesPanel from './WallTypesPanel'
import BrickSettingsPanel from './BrickSettingsPanel'
import BrickTallyPanel from './BrickTallyPanel'
import ProjectBar from './ProjectBar'
import ProjectDetailsDrawer from './ProjectDetailsDrawer'
import BrickExportPanel from './BrickExportPanel'
import BlockExportPanel from './BlockExportPanel'
import {
  type ProjectStatus,
  type SavedProject,
  deleteProject as deleteProjectFromStore,
  generateProjectId,
  getProject,
  saveProject as saveProjectToStore,
} from '../lib/projectStorage'
import type {
  BlockExportInclusions,
  BrickExportInclusions,
  BrickSettings,
  Opening,
  Pier,
  PierMakeup,
  ProjectDetails,
  Wall,
  WallMakeup,
} from '../types/walls'
import {
  createDefaultPierMakeups,
  createDefaultTiedPierMakeup,
  createDefaultWallMakeup,
} from '../lib/makeups'
import { BLOCK_LIBRARY, useBlockLibrary } from '../data/blockLibrary'
import { BRICK_LIBRARY, useBrickLibrary } from '../data/brickLibrary'
import { getUserSettings } from '../lib/userSettings'

/** Fallback brick-wall thickness (mm) — single skin — used when no brick type is selected. */
const DEFAULT_BRICK_WALL_THICKNESS_MM = 110

/**
 * Per-wall physical thickness in mm. Block walls take their thickness from the makeup's
 * body-block depth; brick walls use the active brick type's depth, falling back to
 * single-skin 110mm if nothing's selected. Available outside React's render loop so
 * event handlers (wall-add, junction recompute) can use it before the next render lands.
 */
function computeWallThicknessByWallId(
  walls: Wall[],
  makeupsById: Record<string, WallMakeup>,
  mode: 'block' | 'brick' | undefined,
  brickTypeCode?: string
): Record<string, number> {
  // Look up the brick type's depth once per call. Falls back to single-skin
  // 110mm when no type is set or it can't be resolved.
  const brickThicknessMm =
    (brickTypeCode && BRICK_LIBRARY[brickTypeCode]?.depthMm) ||
    DEFAULT_BRICK_WALL_THICKNESS_MM

  const map: Record<string, number> = {}
  for (const w of walls) {
    if (mode === 'brick') {
      map[w.id] = brickThicknessMm
      continue
    }
    const makeup = makeupsById[w.makeupId]
    // Drawn footprint = the WIDEST block any course of this wall actually uses.
    // With course-series ranges (e.g. 300 series for the bottom 5 courses, 200
    // series above) the wall is physically stepped — but its plan-view
    // footprint is the wider course, since narrower courses sit inside it. We
    // walk the makeup's body, base, top and any range overrides and pick the
    // largest depth from the library, falling back to 190 mm.
    let depth = 190
    if (makeup) {
      const candidateCodes = [
        makeup.bodyBlockCode,
        makeup.baseCourseBlockCode,
        makeup.topCourseBlockCode,
        ...(makeup.courseSeriesRanges?.flatMap((r) => [
          r.bodyBlockCode,
          r.cornerBlockCode,
          r.baseCourseBlockCode,
          r.heightMakeup71BlockCode,
        ]) ?? []),
      ].filter((c): c is string => !!c)
      for (const code of candidateCodes) {
        const d = BLOCK_LIBRARY[code]?.dimensions.depthMm
        if (typeof d === 'number' && d > depth) depth = d
      }
    }
    map[w.id] = depth
  }
  return map
}
import { createDefaultBrickSettings, selectBrickLintelSize } from '../lib/brickCalc'
import {
  createDefaultExportInclusions,
  createDefaultProjectDetails,
} from '../lib/brickExport'
import { createDefaultBlockExportInclusions } from '../lib/blockExport'
import { recomputeAllJunctions, snapEndpointToThroughWallFace } from '../lib/junctions'
import { selectBlockLintel, brickLintelBearingMm, brickLintelTotalLengthMm } from '../lib/lintels'
import { getEstimateRequestByProjectId } from '../lib/estimateRequests'
import type { EstimateRequest } from '../types/estimateRequests'
import { Link } from 'react-router-dom'

// Use the matching pdf.js worker from the CDN — version pinned to react-pdf's bundled version
pdfjs.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`

type Point = { x: number; y: number }

type PageData = {
  /**
   * Page scale ratio — e.g. 100 means 1:100 (one mm on the printed page
   * represents 100 mm in the real world).
   *
   * This is the canonical scale invariant for a project. It's *window-
   * independent* — the canvas pixel scale used by the wall layer is derived
   * at render time from this ratio + the PDF's intrinsic `pageWidthMm` +
   * the current canvas width (`baseWidth`).
   *
   * Storing px-per-mm directly (as the older `scalePxPerMm` field below
   * did) coupled the saved scale to the canvas pixel width at the moment
   * of calibration. If the browser was a different size on the next load
   * — different display, devtools opened, sidebar widened — the saved
   * scale no longer matched the rendered PDF and walls drifted relative
   * to the plan underneath them. Storing the ratio fixes that: walls are
   * always anchored to the PDF, regardless of viewport size.
   */
  pageScaleRatio?: number
  /**
   * @deprecated Pre-fix scale (px per mm at zoom = 1, canvas-pixel-relative).
   * Still read for projects saved before the page-ratio refactor — on first
   * load we derive `pageScaleRatio` from this value + the current `baseWidth`
   * and save it back. Once migrated, this field is no longer written.
   */
  scalePxPerMm?: number
  pageWidthMm?: number // intrinsic page width in mm (from PDF metadata)
  pageHeightMm?: number
}

const POINTS_PER_INCH = 72
const MM_PER_INCH = 25.4

const MIN_ZOOM = 0.25
const MAX_ZOOM = 8
const ZOOM_LEVELS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4]

/**
 * Cap on how high the PDF + Konva canvases will rasterise.
 *
 * Without this, zooming to 8× on a ~880-wide base produces a 7040-wide
 * rasterised canvas (14080 on a retina display once Konva multiplies by
 * `pixelRatio`). Every wall hover or mouse move triggers a re-raster of
 * the whole Konva layer, which is GPU-expensive at that size — especially
 * with lots of walls on the page, since each wall's mitre/T-junction
 * geometry has to be recomputed and stroked.
 *
 * At 3.5 the underlying canvas tops out at ~3080 px wide on a typical
 * 880-wide base, which keeps the plan crisp through the mid-zoom range
 * where most pinpointing happens, while CSS transform takes over for
 * extreme zoom (4×+). The PDF export path is unaffected (it uses the
 * original PDF, not the rasterised canvas).
 *
 * Was 2.5 — the plan looked soft when zooming in for detail work. 3.5
 * roughly doubles pixel density at the cap (3.5²/2.5² ≈ 2× pixels) but
 * the per-frame Konva work scales with on-screen elements, not canvas
 * size, so wall hover/move latency is essentially unchanged.
 */
const MAX_RENDERED_ZOOM = 3.5

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
   * below the PDF view. 'brick' enables the brick workflow.
   */
  mode?: 'block' | 'brick'
  /** When set, loads the matching saved project from IndexedDB on mount. */
  projectId?: string | null
}

export default function PdfWorkspace({ mode, projectId }: PdfWorkspaceProps = {}) {
  const [pdfFile, setPdfFile] = useState<File | null>(null)
  const [numPages, setNumPages] = useState<number>(0)
  const [currentPage, setCurrentPage] = useState<number>(1)
  const [isDragging, setIsDragging] = useState(false)

  // ---------- Wall drawing state (block mode) ----------
  const [wallsByPage, setWallsByPage] = useState<Record<number, Wall[]>>({})
  const [drawingMode, setDrawingMode] = useState(false)
  /** Curved wall drawing mode (3-click: pick wall A → pick wall B → pick midpoint). */
  const [drawingCurveMode, setDrawingCurveMode] = useState(false)
  // Selection model: Sets of ids per item type so the user can multi-select with
  // Shift+click for batch delete and (for walls) batch wall-type reassignment.
  // The single-ID wrappers below preserve the existing single-select call sites
  // (side-panel single-item UI, endpoint drag handles, etc.); they collapse to
  // null whenever zero or multiple items are selected, which is exactly the
  // "don't show single-item UI" semantic we want.
  const [selectedWallIds, _setSelectedWallIds] = useState<Set<string>>(new Set())
  const selectedWallId =
    selectedWallIds.size === 1 ? Array.from(selectedWallIds)[0]! : null
  // useCallback-wrapped so the reference is stable across PdfWorkspace
  // re-renders. Critical for the memoised WallDrawingLayer to skip
  // re-renders during zoom — without this, every rAF tick of the zoom
  // gesture creates a new function reference, the memo sees "different"
  // props, and Konva re-rasterises the whole layer.
  const setSelectedWallId = useCallback((id: string | null) => {
    _setSelectedWallIds(id ? new Set([id]) : new Set())
  }, [])
  const toggleSelectedWallId = useCallback((id: string) => {
    _setSelectedWallIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])
  const drawingModeRef = useRef(false)

  // ---------- Control-joint placement mode (block mode) ----------
  // When active, clicking on a wall splits it into two halves at the click point. Each
  // half gets its own end termination at the joint (junction.type = 'control-joint').
  const [placingControlJoint, setPlacingControlJoint] = useState(false)
  const placingControlJointRef = useRef(false)

  // ---------- Pier state (block mode) ----------
  const [piersByPage, setPiersByPage] = useState<Record<number, Pier[]>>({})
  /** Library of pier makeups available in this project (seeded with two defaults). */
  const [pierMakeups, setPierMakeups] = useState<PierMakeup[]>(() => createDefaultPierMakeups())
  /** True while the user is choosing a wall to drop a tied pier onto. */
  const [placingTiedPier, setPlacingTiedPier] = useState(false)
  /** True while the user is choosing a point on the plan to drop a freestanding pier. */
  const [placingFreestandingPier, setPlacingFreestandingPier] = useState(false)
  /** Pier currently selected (for inspection / height / makeup edit). */
  const [selectedPierIds, _setSelectedPierIds] = useState<Set<string>>(new Set())
  const selectedPierId =
    selectedPierIds.size === 1 ? Array.from(selectedPierIds)[0]! : null
  const setSelectedPierId = useCallback((id: string | null) => {
    _setSelectedPierIds(id ? new Set([id]) : new Set())
  }, [])
  const toggleSelectedPierId = useCallback((id: string) => {
    _setSelectedPierIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])
  /** Default height (mm) for newly-placed freestanding piers — multiple of 200. */
  const [freestandingPierHeightMm, setFreestandingPierHeightMm] = useState(2400)

  const pierMakeupsById = useMemo(
    () => Object.fromEntries(pierMakeups.map((m) => [m.id, m])),
    [pierMakeups]
  )

  /** First pier makeup whose suggestedPlacement matches, or the first overall. */
  function defaultPierMakeupId(placement: 'tied' | 'freestanding'): string | undefined {
    const match = pierMakeups.find((m) => m.suggestedPlacement === placement)
    return (match ?? pierMakeups[0])?.id
  }

  // ---------- Opening state (block mode) ----------
  const [openingsByPage, setOpeningsByPage] = useState<Record<number, Opening[]>>({})
  const [placingOpening, setPlacingOpening] = useState(false)
  const [selectedOpeningIds, _setSelectedOpeningIds] = useState<Set<string>>(new Set())
  const selectedOpeningId =
    selectedOpeningIds.size === 1 ? Array.from(selectedOpeningIds)[0]! : null
  const setSelectedOpeningId = useCallback((id: string | null) => {
    _setSelectedOpeningIds(id ? new Set([id]) : new Set())
  }, [])
  const toggleSelectedOpeningId = useCallback((id: string) => {
    _setSelectedOpeningIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])
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

  // Brick-mode settings — seeded with the user's defaults from settings, so a
  // new project picks up their default wall height + preferred brick type.
  const [brickSettings, setBrickSettings] = useState<BrickSettings>(() => {
    const seed = createDefaultBrickSettings()
    // getUserSettings() not useUserSettings() — we only want the value once,
    // at init. Settings changes after that flow through the SettingsPage.
    const us = getUserSettings()
    return {
      ...seed,
      defaultWallHeightMm: us.defaults.defaultWallHeightMm,
      brickTypeCode: us.defaults.defaultBrickTypeCode || seed.brickTypeCode,
    }
  })

  // Project details + export inclusion tickboxes (brick mode)
  const [projectDetails, setProjectDetails] = useState<ProjectDetails>(() =>
    createDefaultProjectDetails()
  )
  const [exportInclusions, setExportInclusions] = useState<BrickExportInclusions>(() =>
    createDefaultExportInclusions()
  )
  const [blockExportInclusions, setBlockExportInclusions] = useState<BlockExportInclusions>(
    () => createDefaultBlockExportInclusions()
  )

  // ---------- Saved-project tracking ----------
  /** ID of the currently-loaded saved project (null if this is a fresh, unsaved workspace). */
  const [currentProjectId, setCurrentProjectId] = useState<string | null>(projectId ?? null)
  const [projectStatus, setProjectStatus] = useState<ProjectStatus>('in-progress')
  /** Outcome ('won' | 'lost' | undefined). Set from the dashboard, round-tripped here so saves preserve it. */
  const [projectOutcome, setProjectOutcome] = useState<'won' | 'lost' | undefined>(undefined)
  const [projectCreatedAt, setProjectCreatedAt] = useState<string | null>(null)
  const [projectCompletedAt, setProjectCompletedAt] = useState<string | null>(null)
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null)
  const [detailsDrawerOpen, setDetailsDrawerOpen] = useState(false)

  /**
   * Source request — set when this project was created via the "pick up"
   * flow on an estimate request. Drives the breadcrumb at the top of the
   * workspace ("← Request from {customer}") so the estimator can flip back
   * to the spec without losing their place. Null for personal projects or
   * any project not originating from a request.
   */
  const [sourceRequest, setSourceRequest] = useState<EstimateRequest | null>(null)

  // Look up the request that produced this project (if any) so we can show
  // the breadcrumb. Best-effort: failures are silent because the breadcrumb
  // is a nice-to-have, not load-blocking.
  useEffect(() => {
    if (!currentProjectId) {
      setSourceRequest(null)
      return
    }
    let cancelled = false
    getEstimateRequestByProjectId(currentProjectId).then((req) => {
      if (!cancelled) setSourceRequest(req)
    })
    return () => {
      cancelled = true
    }
  }, [currentProjectId])

  // Load a saved project on mount if projectId was provided
  useEffect(() => {
    if (!projectId) return
    let cancelled = false
    getProject(projectId)
      .then((proj) => {
        if (cancelled || !proj) return
        // Reconstruct File from saved Blob (only when a PDF was actually saved — projects
        // can now be created and saved before a PDF is uploaded).
        if (proj.pdfBlob && proj.pdfFileName) {
          const file = new File([proj.pdfBlob], proj.pdfFileName, {
            type: proj.pdfBlob.type || 'application/pdf',
          })
          setPdfFile(file)
        }
        setProjectDetails(proj.projectDetails)
        setPagesData(proj.pagesData)
        setWallsByPage(proj.wallsByPage)
        setOpeningsByPage(proj.openingsByPage)
        if (proj.piersByPage) setPiersByPage(proj.piersByPage)
        if (proj.pierMakeups && proj.pierMakeups.length > 0) setPierMakeups(proj.pierMakeups)
        setCurrentPage(proj.currentPage || 1)
        if (proj.makeups && proj.makeups.length > 0) {
          setMakeups(proj.makeups)
          if (proj.activeMakeupId) setActiveMakeupId(proj.activeMakeupId)
        }
        if (proj.brickSettings) setBrickSettings(proj.brickSettings)
        if (proj.exportInclusions) setExportInclusions(proj.exportInclusions)
        if (proj.blockExportInclusions) setBlockExportInclusions(proj.blockExportInclusions)

        setCurrentProjectId(proj.id)
        setProjectStatus(proj.status)
        setProjectOutcome(proj.outcome)
        setProjectCreatedAt(proj.createdAt)
        setProjectCompletedAt(proj.completedAt ?? null)
        setLastSavedAt(proj.updatedAt)
      })
      .catch((err) => {
        console.error('Failed to load project', err)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

  // Reasons save might be blocked, evaluated each render. A PDF is NO LONGER required —
  // users can save a project with just a name (and pre-configured wall / pier types),
  // then upload the PDF later.
  const saveBlockedReason = useMemo<string | null>(() => {
    if (!projectDetails.projectName.trim() && !projectDetails.siteAddress.trim()) {
      return 'Fill in a project name or site address in Project details before saving.'
    }
    return null
  }, [projectDetails.projectName, projectDetails.siteAddress])
  const canSave = saveBlockedReason === null

  async function handleSaveProject() {
    if (!mode) return
    const now = new Date().toISOString()
    const id = currentProjectId ?? generateProjectId()
    const project: SavedProject = {
      id,
      type: mode,
      status: projectStatus,
      createdAt: projectCreatedAt ?? now,
      updatedAt: now,
      completedAt: projectCompletedAt ?? undefined,
      outcome: projectOutcome,
      projectDetails,
      // pdfBlob + pdfFileName are optional now — a project can be saved without a PDF
      ...(pdfFile ? { pdfBlob: pdfFile, pdfFileName: pdfFile.name } : {}),
      pagesData,
      wallsByPage,
      openingsByPage,
      piersByPage,
      currentPage,
      ...(mode === 'block'
        ? { makeups, activeMakeupId, blockExportInclusions, pierMakeups }
        : {}),
      ...(mode === 'brick' ? { brickSettings, exportInclusions } : {}),
    }
    try {
      await saveProjectToStore(project)
      setCurrentProjectId(id)
      setProjectCreatedAt(project.createdAt)
      setLastSavedAt(now)
      // Update URL with the project id (so refresh keeps you in the saved project)
      if (typeof window !== 'undefined') {
        const url = new URL(window.location.href)
        if (url.searchParams.get('id') !== id) {
          url.searchParams.set('id', id)
          window.history.replaceState({}, '', url.toString())
        }
      }
    } catch (err) {
      console.error('Failed to save project', err)
      alert('Failed to save the project. Your browser may be low on storage.')
    }
  }

  async function handleToggleProjectStatus() {
    if (!currentProjectId) return
    const now = new Date().toISOString()
    const nextStatus: ProjectStatus =
      projectStatus === 'completed' ? 'in-progress' : 'completed'
    setProjectStatus(nextStatus)
    if (nextStatus === 'completed') setProjectCompletedAt(now)
    // Persist immediately. PDF is optional now.
    if (mode) {
      const project: SavedProject = {
        id: currentProjectId,
        type: mode,
        status: nextStatus,
        createdAt: projectCreatedAt ?? now,
        updatedAt: now,
        completedAt: nextStatus === 'completed' ? now : projectCompletedAt ?? undefined,
        outcome: projectOutcome,
        projectDetails,
        ...(pdfFile ? { pdfBlob: pdfFile, pdfFileName: pdfFile.name } : {}),
        pagesData,
        wallsByPage,
        openingsByPage,
        piersByPage,
        currentPage,
        ...(mode === 'block' ? { makeups, activeMakeupId, pierMakeups } : {}),
        ...(mode === 'brick' ? { brickSettings, exportInclusions } : {}),
      }
      try {
        await saveProjectToStore(project)
        setLastSavedAt(now)
      } catch (err) {
        console.error('Failed to update project status', err)
      }
    }
  }

  // Stable callbacks for WallDrawingLayer — wrapped in useCallback with empty deps so
  // their reference doesn't change every render. Combined with WallDrawingLayer being
  // memoised, this means the wall overlay doesn't re-render on every wheel-zoom tick.
  const handleWallSelect = useCallback((id: string | null) => {
    setSelectedWallId(id)
    if (id) setSelectedOpeningId(null)
  }, [])
  const handleOpeningSelect = useCallback((id: string | null) => {
    setSelectedOpeningId(id)
    if (id) setSelectedWallId(null)
  }, [])
  const handleCancelDraw = useCallback(() => {
    setDrawingMode(false)
    setPlacingOpening(false)
    setDrawingCurveMode(false)
    setPlacingControlJoint(false)
    setPlacingTiedPier(false)
    setPlacingFreestandingPier(false)
  }, [])

  async function handleDeleteProject() {
    if (!currentProjectId) return
    if (!window.confirm('Delete this project? This cannot be undone.')) return
    try {
      await deleteProjectFromStore(currentProjectId)
      setCurrentProjectId(null)
      setProjectStatus('in-progress')
      setProjectOutcome(undefined)
      setProjectCreatedAt(null)
      setProjectCompletedAt(null)
      setLastSavedAt(null)
      if (typeof window !== 'undefined') {
        const url = new URL(window.location.href)
        url.searchParams.delete('id')
        window.history.replaceState({}, '', url.toString())
      }
    } catch (err) {
      console.error('Failed to delete project', err)
    }
  }

  // Keep drawingMode ref in sync for pan handler
  useEffect(() => {
    drawingModeRef.current = drawingMode
  }, [drawingMode])

  useEffect(() => {
    placingOpeningRef.current = placingOpening
  }, [placingOpening])

  useEffect(() => {
    placingControlJointRef.current = placingControlJoint
  }, [placingControlJoint])

  const allWalls = useMemo(() => Object.values(wallsByPage).flat(), [wallsByPage])
  const currentPageWalls = wallsByPage[currentPage] ?? []
  const allOpenings = useMemo(() => Object.values(openingsByPage).flat(), [openingsByPage])
  const currentPageOpenings = openingsByPage[currentPage] ?? []
  const allPiers = useMemo(() => Object.values(piersByPage).flat(), [piersByPage])
  const currentPagePiers = piersByPage[currentPage] ?? []
  const selectedPier = useMemo(
    () => (selectedPierId ? currentPagePiers.find((p) => p.id === selectedPierId) : null),
    [selectedPierId, currentPagePiers]
  )
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

  const pierCountsByMakeupId = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const p of allPiers) {
      if (!p.pierMakeupId) continue
      counts[p.pierMakeupId] = (counts[p.pierMakeupId] ?? 0) + 1
    }
    return counts
  }, [allPiers])

  /**
   * Per-wall physical thickness in mm. For block walls, derived from the makeup's body
   * block depth (e.g. 190mm for a 20.48). For brick walls, a default single-skin width.
   * Drives the rendered wall-rectangle thickness in WallDrawingLayer.
   */
  // Subscribe to the block + brick libraries so wall thickness re-derives when
  // the user edits a block's depth, swaps the active brick type, or changes a
  // brick type's depth in the library panel.
  const { version: blockLibraryVersion } = useBlockLibrary()
  const { version: brickLibraryVersion } = useBrickLibrary()
  const wallThicknessByWallId = useMemo(
    () =>
      computeWallThicknessByWallId(allWalls, makeupsById, mode, brickSettings.brickTypeCode),
    // Library versions are intentional: when the user edits library dimensions,
    // the canvas wall thickness should reflect it immediately.
    [
      allWalls,
      makeupsById,
      mode,
      brickSettings.brickTypeCode,
      blockLibraryVersion,
      brickLibraryVersion,
    ]
  )

  const selectedWall = useMemo(
    () => (selectedWallId ? currentPageWalls.find((w) => w.id === selectedWallId) : null),
    [selectedWallId, currentPageWalls]
  )

  // useCallback wrappers around the wall-layer event handlers. During a zoom
  // gesture none of the dependency values change, so the callback references
  // stay stable and the memoised WallDrawingLayer can skip re-renders. Without
  // these, every rAF tick of the zoom gesture creates new function refs and
  // the layer rasterises afresh — felt smooth on light projects but visible
  // on anything with many walls. The deps are deliberately broad so the
  // behaviour is identical to the previous plain-function form when the
  // underlying state DOES change (adding walls, switching modes, etc.).
  const handleWallAdded = useCallback(function handleWallAdded(startMm: { x: number; y: number }, endMm: { x: number; y: number }) {
    const isBrick = mode === 'brick'
    const existing = wallsByPage[currentPage] ?? []

    // Thicknesses for snapping — based on the existing walls (the new wall's own
    // thickness isn't relevant here; we're only checking which through-wall the
    // new endpoint lies inside of).
    const existingThicknesses = computeWallThicknessByWallId(
      existing,
      makeupsById,
      mode,
      brickSettings.brickTypeCode
    )

    // If either endpoint landed strictly inside another wall's body, pull it onto the
    // through-wall's face on the side facing the opposite endpoint. Otherwise the wall
    // is stored half-a-thickness longer than it visually appears, which then surfaces
    // as confusing length labels later. See snapEndpointToThroughWallFace for full
    // rationale. We feed each call the ORIGINAL opposite endpoint so the two snaps
    // are independent of evaluation order.
    const snappedStart = snapEndpointToThroughWallFace(
      startMm,
      endMm,
      existing,
      existingThicknesses
    )
    const snappedEnd = snapEndpointToThroughWallFace(
      endMm,
      startMm,
      existing,
      existingThicknesses
    )

    const rawWall: Wall = {
      id:
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `w-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      // Brick walls don't reference a WallMakeup — they use brickSettings instead.
      makeupId: isBrick ? '' : activeMakeupId,
      startX: snappedStart.x,
      startY: snappedStart.y,
      endX: snappedEnd.x,
      endY: snappedEnd.y,
      startJunction: { type: 'free' },
      endJunction: { type: 'free' },
      heightMmOverride: isBrick ? brickSettings.defaultWallHeightMm : undefined,
    }

    // Junction detection only matters for block walls (corners + T-junctions affect tally).
    // We run a full recompute across all walls on the page so detection picks up both
    // directions: the new wall butting into an existing wall's body (T-junction on new),
    // AND an existing wall's free endpoint now lying on the new wall's body (T on existing).
    const newWalls = [...existing, rawWall]
    const thicknesses = computeWallThicknessByWallId(newWalls, makeupsById, mode, brickSettings.brickTypeCode)
    const recomputed = recomputeAllJunctions(newWalls, thicknesses)

    setWallsByPage((prev) => ({
      ...prev,
      [currentPage]: recomputed,
    }))
  }, [wallsByPage, currentPage, makeupsById, mode, brickSettings, activeMakeupId])

  /**
   * Add a curved wall from three points (start, mid, end) anchored to two existing walls.
   * Junction detection runs after so the curve's endpoints inherit corner-tagging from
   * the walls it connects to.
   */
  const handleCurvedWallAdded = useCallback(function handleCurvedWallAdded(
    startMm: { x: number; y: number },
    midMm: { x: number; y: number },
    endMm: { x: number; y: number }
  ) {
    if (mode !== 'block') return // Brick mode doesn't support curves yet
    const rawWall: Wall = {
      id:
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `w-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      makeupId: activeMakeupId,
      startX: startMm.x,
      startY: startMm.y,
      endX: endMm.x,
      endY: endMm.y,
      startJunction: { type: 'free' },
      endJunction: { type: 'free' },
      kind: 'curved',
      midX: midMm.x,
      midY: midMm.y,
    }
    const existing = wallsByPage[currentPage] ?? []
    const newWalls = [...existing, rawWall]
    const thicknesses = computeWallThicknessByWallId(newWalls, makeupsById, mode, brickSettings.brickTypeCode)
    const recomputed = recomputeAllJunctions(newWalls, thicknesses)
    setWallsByPage((prev) => ({ ...prev, [currentPage]: recomputed }))
  }, [mode, wallsByPage, currentPage, makeupsById, brickSettings, activeMakeupId])

  /**
   * Split a wall at a click point along its centreline. Replaces the original wall with
   * two halves, each carrying its own end terminations. The two halves share a
   * 'control-joint' junction at the split point (with connectedWallIds pointing at each
   * other).
   *
   * Openings on the original wall are reassigned to whichever half they sit on; an opening
   * that straddles the split is dropped (it would otherwise be ambiguous).
   *
   * Curved walls are not split — control joints are a straight-wall concept here.
   */
  const handleControlJointPlaced = useCallback(function handleControlJointPlaced(wallId: string, alongMm: number) {
    if (mode !== 'block') return
    const existing = wallsByPage[currentPage] ?? []
    const wall = existing.find((w) => w.id === wallId)
    if (!wall) return
    if (wall.kind === 'curved') return // not supported for curves

    // Compute the split point in mm. Clamp away from the very ends so we don't make a
    // zero-length sliver.
    const MIN_HALF_LENGTH_MM = 100
    const dx = wall.endX - wall.startX
    const dy = wall.endY - wall.startY
    const fullLengthMm = Math.sqrt(dx * dx + dy * dy)
    if (fullLengthMm < 2 * MIN_HALF_LENGTH_MM) return
    const clampedAlong = Math.max(
      MIN_HALF_LENGTH_MM,
      Math.min(fullLengthMm - MIN_HALF_LENGTH_MM, alongMm)
    )
    const t = clampedAlong / fullLengthMm
    const splitX = wall.startX + t * dx
    const splitY = wall.startY + t * dy

    function newId() {
      return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `w-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    }

    const firstId = newId()
    const secondId = newId()

    const firstHalf: Wall = {
      ...wall,
      id: firstId,
      // First half keeps the original start point + start junction.
      startX: wall.startX,
      startY: wall.startY,
      endX: splitX,
      endY: splitY,
      startJunction: { ...wall.startJunction },
      endJunction: { type: 'control-joint', connectedWallIds: [secondId] },
    }
    const secondHalf: Wall = {
      ...wall,
      id: secondId,
      startX: splitX,
      startY: splitY,
      endX: wall.endX,
      endY: wall.endY,
      startJunction: { type: 'control-joint', connectedWallIds: [firstId] },
      endJunction: { ...wall.endJunction },
    }

    // The two halves replace the original wall in the page's wall list.
    const remainingWalls = existing.filter((w) => w.id !== wallId)
    const newWalls = [...remainingWalls, firstHalf, secondHalf]
    const thicknesses = computeWallThicknessByWallId(newWalls, makeupsById, mode, brickSettings.brickTypeCode)
    const recomputed = recomputeAllJunctions(newWalls, thicknesses)
    setWallsByPage((prev) => ({ ...prev, [currentPage]: recomputed }))

    // Re-bucket openings on the split wall: keep the ones fully on one side; drop any
    // that straddle the split point.
    setOpeningsByPage((prev) => {
      const pageOpenings = prev[currentPage] ?? []
      const updated: Opening[] = []
      for (const op of pageOpenings) {
        if (op.wallId !== wallId) {
          updated.push(op)
          continue
        }
        const opStart = op.startAlongWallMm
        const opEnd = op.startAlongWallMm + op.widthMm
        if (opEnd <= clampedAlong) {
          // Fully on first half — keep position, just rebind to the new wall id.
          updated.push({ ...op, wallId: firstId })
        } else if (opStart >= clampedAlong) {
          // Fully on second half — rebind and shift along.
          updated.push({
            ...op,
            wallId: secondId,
            startAlongWallMm: opStart - clampedAlong,
          })
        }
        // Straddling openings are dropped (would otherwise be ambiguous).
      }
      return { ...prev, [currentPage]: updated }
    })

    // Selection: if the original wall was selected, switch to the first half so the user
    // doesn't end up with a stale selectedWallId pointing at a deleted wall.
    if (selectedWallId === wallId) setSelectedWallId(firstId)

    // Exit the placement mode after a successful split — match how + Add opening works.
    setPlacingControlJoint(false)
  }, [mode, wallsByPage, currentPage, makeupsById, brickSettings, selectedWallId, setSelectedWallId])

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
    // 1. Update the makeup list. The block tally re-derives from makeupsById on
    //    every render, so block-code changes propagate to every wall of this
    //    type automatically.
    setMakeups((prev) => prev.map((m) => (m.id === updated.id ? updated : m)))

    // 2. If the wall's effective thickness changed (e.g. body block went from
    //    20.48 to a narrower or wider block), corner / T-junction matching
    //    against this wall needs to be re-evaluated, because the snap-to-face
    //    geometry depends on halfThickness. Recompute every page's junctions
    //    against the new makeup so walls of this type pick up the change.
    //    Cheap: just iterates each wall pair on the page.
    setWallsByPage((prev) => {
      const nextMakeups = makeups.map((m) => (m.id === updated.id ? updated : m))
      const nextMakeupsById = Object.fromEntries(
        nextMakeups.map((m) => [m.id, m])
      ) as Record<string, WallMakeup>
      const next: Record<number, Wall[]> = {}
      for (const [pageStr, walls] of Object.entries(prev)) {
        const pageNum = Number(pageStr)
        const thicknesses = computeWallThicknessByWallId(
          walls,
          nextMakeupsById,
          mode,
          brickSettings.brickTypeCode
        )
        next[pageNum] = recomputeAllJunctions(walls, thicknesses)
      }
      return next
    })
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

  const handleOpeningPlaced = useCallback((wallId: string, startAlongWallMm: number, widthMm: number) => {
    setPendingOpening({ wallId, startAlongWallMm, widthMm })
    setPlacingOpening(false)
  }, [])

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
    setOpeningsByPage({})
    setPiersByPage({})
    setDrawingMode(false)
    setSelectedWallId(null)
    setSelectedPierId(null)
  }

  // ---------- Pier placement handlers ----------

  /** Place a tied pier on a wall at the click point along it. */
  const handleTiedPierPlaced = useCallback(function handleTiedPierPlaced(wallId: string, alongMm: number) {
    if (mode !== 'block') return
    const wall = (wallsByPage[currentPage] ?? []).find((w) => w.id === wallId)
    if (!wall) return
    if (wall.kind === 'curved') return // piers only on straight walls for v1
    const dx = wall.endX - wall.startX
    const dy = wall.endY - wall.startY
    const len = Math.sqrt(dx * dx + dy * dy)
    if (len === 0) return
    const clamped = Math.max(200, Math.min(len - 200, alongMm))
    const pier: Pier = {
      id:
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `p-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type: 'tied',
      wallId,
      alongMm: clamped,
      pierMakeupId: defaultPierMakeupId('tied'),
    }
    setPiersByPage((prev) => ({
      ...prev,
      [currentPage]: [...(prev[currentPage] ?? []), pier],
    }))
    setPlacingTiedPier(false)
  }, [mode, wallsByPage, currentPage, pierMakeups])

  /** Place a freestanding pier at the click coordinates. Inherits the current default height. */
  const handleFreestandingPierPlaced = useCallback(function handleFreestandingPierPlaced(xMm: number, yMm: number) {
    if (mode !== 'block') return
    const pier: Pier = {
      id:
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `p-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type: 'freestanding',
      x: xMm,
      y: yMm,
      heightMm: freestandingPierHeightMm,
      pierMakeupId: defaultPierMakeupId('freestanding'),
    }
    setPiersByPage((prev) => ({
      ...prev,
      [currentPage]: [...(prev[currentPage] ?? []), pier],
    }))
    setPlacingFreestandingPier(false)
  }, [mode, currentPage, freestandingPierHeightMm, pierMakeups])

  const handlePierSelect = useCallback(
    (pierId: string | null) => {
      setSelectedPierId(pierId)
      if (pierId) {
        setSelectedWallId(null)
        setSelectedOpeningId(null)
      }
    },
    [setSelectedPierId, setSelectedWallId, setSelectedOpeningId]
  )

  function handleDeletePier(pierId: string) {
    setPiersByPage((prev) => {
      const pagePiers = prev[currentPage] ?? []
      return { ...prev, [currentPage]: pagePiers.filter((p) => p.id !== pierId) }
    })
    if (selectedPierId === pierId) setSelectedPierId(null)
  }

  // ---------- Pier makeup CRUD ----------

  function handleAddPierMakeup() {
    const next = createDefaultTiedPierMakeup('New pier type')
    setPierMakeups((prev) => [...prev, next])
  }

  function handleUpdatePierMakeup(updated: PierMakeup) {
    setPierMakeups((prev) => prev.map((m) => (m.id === updated.id ? updated : m)))
  }

  function handleDeletePierMakeup(id: string) {
    setPierMakeups((prev) => {
      if (prev.length <= 1) return prev // always keep at least one
      const remaining = prev.filter((m) => m.id !== id)
      // Re-assign any piers using the deleted makeup to the first remaining one of
      // matching suggestedPlacement (or the first overall).
      setPiersByPage((pp) => {
        const next: Record<number, Pier[]> = {}
        for (const [pageStr, piers] of Object.entries(pp)) {
          const pageNum = Number(pageStr)
          next[pageNum] = piers.map((pier) => {
            if (pier.pierMakeupId !== id) return pier
            const replacement =
              remaining.find((m) => m.suggestedPlacement === pier.type) ?? remaining[0]
            return { ...pier, pierMakeupId: replacement?.id }
          })
        }
        return next
      })
      return remaining
    })
  }

  function handleReassignPierMakeup(pierId: string, pierMakeupId: string) {
    setPiersByPage((prev) => {
      const pagePiers = prev[currentPage] ?? []
      const updated = pagePiers.map((p) => (p.id === pierId ? { ...p, pierMakeupId } : p))
      return { ...prev, [currentPage]: updated }
    })
  }

  function handleUpdateFreestandingPierHeight(pierId: string, heightMm: number) {
    setPiersByPage((prev) => {
      const pagePiers = prev[currentPage] ?? []
      const updated = pagePiers.map((p) =>
        p.id === pierId && p.type === 'freestanding' ? { ...p, heightMm } : p
      )
      return { ...prev, [currentPage]: updated }
    })
  }


  const handleWallEndpointMoved = useCallback(function handleWallEndpointMoved(
    wallId: string,
    which: 'start' | 'end',
    newPositionMm: { x: number; y: number }
  ) {
    setWallsByPage((prev) => {
      const pageWalls = prev[currentPage] ?? []
      const draggedWall = pageWalls.find((w) => w.id === wallId)
      if (!draggedWall) return prev

      // If the drag finished strictly inside another wall's body, pull the endpoint
      // onto that wall's face on the side facing the dragged wall's opposite end.
      // Mirrors the new-wall handler — see snapEndpointToThroughWallFace for the
      // rationale. Excludes the dragged wall itself so we don't try to snap onto
      // its own body if the drag wiggled the endpoint past it.
      const oppositeEnd =
        which === 'start'
          ? { x: draggedWall.endX, y: draggedWall.endY }
          : { x: draggedWall.startX, y: draggedWall.startY }
      const existingThicknesses = computeWallThicknessByWallId(
        pageWalls,
        makeupsById,
        mode,
        brickSettings.brickTypeCode
      )
      const snapped = snapEndpointToThroughWallFace(
        newPositionMm,
        oppositeEnd,
        pageWalls,
        existingThicknesses,
        wallId
      )

      const updated = pageWalls.map((w) => {
        if (w.id !== wallId) return w
        if (which === 'start') {
          return { ...w, startX: snapped.x, startY: snapped.y }
        }
        return { ...w, endX: snapped.x, endY: snapped.y }
      })
      const thicknesses = computeWallThicknessByWallId(updated, makeupsById, mode, brickSettings.brickTypeCode)
      return { ...prev, [currentPage]: recomputeAllJunctions(updated, thicknesses) }
    })
  }, [currentPage, makeupsById, mode, brickSettings])

  function handleWallDelete(wallId: string) {
    setWallsByPage((prev) => {
      const pageWalls = prev[currentPage] ?? []
      const remaining = pageWalls.filter((w) => w.id !== wallId)
      const thicknesses = computeWallThicknessByWallId(remaining, makeupsById, mode, brickSettings.brickTypeCode)
      return { ...prev, [currentPage]: recomputeAllJunctions(remaining, thicknesses) }
    })
    // Drop any tied piers that were attached to this wall — they're not meaningful
    // without their parent wall.
    setPiersByPage((prev) => {
      const pagePiers = prev[currentPage] ?? []
      const filtered = pagePiers.filter((p) => !(p.type === 'tied' && p.wallId === wallId))
      if (filtered.length === pagePiers.length) return prev
      return { ...prev, [currentPage]: filtered }
    })
    // Drop any openings tied to this wall.
    setOpeningsByPage((prev) => {
      const pageOpenings = prev[currentPage] ?? []
      const filtered = pageOpenings.filter((o) => o.wallId !== wallId)
      if (filtered.length === pageOpenings.length) return prev
      return { ...prev, [currentPage]: filtered }
    })
    setSelectedWallId(null)
  }

  // Delete / Backspace removes every selected wall, opening, and pier — single-
  // or multi-selection. Walls are deleted last (so attached openings/piers vanish
  // along the way without us needing to special-case them).
  useEffect(() => {
    if (selectedWallIds.size === 0 && selectedOpeningIds.size === 0 && selectedPierIds.size === 0) return
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Delete' || e.key === 'Backspace') {
        const tgt = e.target as HTMLElement | null
        if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA')) return
        e.preventDefault()
        // Snapshot ids before any deletion handler clears the selection sets.
        const wallIds = Array.from(selectedWallIds)
        const openingIds = Array.from(selectedOpeningIds)
        const pierIds = Array.from(selectedPierIds)
        for (const id of pierIds) handleDeletePier(id)
        for (const id of openingIds) handleOpeningDelete(id)
        for (const id of wallIds) handleWallDelete(id)
      }
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedWallIds, selectedOpeningIds, selectedPierIds])

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
  // Canvas width sizing — favours landscape plans because that's what most
  // building drawings are. The cap (1140px) is sized so on a typical 24"
  // monitor the canvas fills most of the available horizontal room rather
  // than leaving it empty, but the right rail (~360px on lg+) still sits
  // beside it instead of getting pushed below the canvas.
  //
  // Math behind the constants:
  //   container is max-w-[1600px] mx-auto, with px-6 inner padding (= 48 total)
  //   right rail is 360px on lg+, with a 16px gap before it
  //   so canvas area = min(1600, window.innerWidth) − 360 − 16 − 48 = window − 424
  //   plus ~16px scrollbar slack = window − 440
  //
  // Tailwind `lg` = 1024px. At/above lg the right rail is side-by-side; below
  // lg it stacks beneath and the canvas takes the full width.
  const baseWidth = (() => {
    if (typeof window === 'undefined') return 1140
    return window.innerWidth >= 1024
      ? Math.min(1140, window.innerWidth - 440)
      : Math.min(900, window.innerWidth - 120)
  })()
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
  /**
   * Canvas-pixels per real-world-mm at zoom = 1.
   *
   * Derived from the page ratio + the PDF's intrinsic page width + the
   * current canvas width, so it adapts automatically when the browser is
   * resized. Falls back to the legacy `scalePxPerMm` for projects saved
   * before the page-ratio refactor (until the migration in the PDF
   * onLoadSuccess handler converts them).
   */
  const currentScale =
    pageData?.pageWidthMm && pageData?.pageScaleRatio
      ? baseWidth / (pageData.pageWidthMm * pageData.pageScaleRatio)
      : pageData?.scalePxPerMm

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
  // so the canvas is crisp instead of relying on the CSS transform upscale —
  // but cap the rasterisation at MAX_RENDERED_ZOOM. Beyond that, the canvas
  // stays at the cap and the CSS transform handles further visual scaling.
  // Cap rationale lives in the MAX_RENDERED_ZOOM jsdoc above.
  //
  // The debounce is generous (300ms) so it doesn't fire mid-pinch — a re-raster mid-zoom
  // causes a visible snap (blurry transformed canvas → crisp native canvas). We'd rather
  // keep the canvas in CSS-transform mode for the whole gesture and snap once at the end.
  useEffect(() => {
    const target = Math.min(zoom, MAX_RENDERED_ZOOM)
    if (target === renderedZoom) return
    const timer = setTimeout(() => {
      setRenderedZoom(target)
    }, 300)
    return () => clearTimeout(timer)
  }, [zoom, renderedZoom])

  useEffect(() => {
    if (calPoint1 && calPoint2) {
      inputRef.current?.focus()
    }
  }, [calPoint1, calPoint2])

  // ---------- Mouse wheel / trackpad zoom ----------
  //
  // Wheel events get throttled to one update per animation frame via requestAnimationFrame.
  // A trackpad pinch fires 60–120 wheel events/sec; without throttling each one triggers a
  // full React re-render of the workspace (including every wall on the canvas), which blows
  // the frame budget and feels jittery. Batching deltaY within a frame and applying once on
  // the next rAF tick keeps it pinned to 60fps even with lots of walls on screen.
  //
  // Non-passive listener so we can preventDefault() and avoid the page also scrolling.
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    let pendingDeltaY = 0
    let pendingClientX = 0
    let pendingClientY = 0
    let pendingCtrlKey = false
    let rafId: number | null = null

    const applyZoom = () => {
      rafId = null
      const delta = pendingDeltaY
      pendingDeltaY = 0
      if (delta === 0) return

      const oldZoom = zoomRef.current
      const sensitivity = pendingCtrlKey ? 0.01 : 0.002
      const factor = Math.exp(-delta * sensitivity)
      const newZoom = clamp(oldZoom * factor, MIN_ZOOM, MAX_ZOOM)
      if (newZoom === oldZoom) return

      // Zoom-to-cursor: keep the point under the cursor stationary across the zoom change.
      // We have to account for the `flex justify-center` wrapper: when the page is narrower
      // than the container, the page is centred with a margin on each side. As we zoom in,
      // the page grows and the margin shrinks (to 0 once the page exceeds the container).
      // The cursor-anchor math has to work in PAGE coords (i.e. minus the centring margin),
      // not raw scroll coords — otherwise the anchor drifts at low zoom levels where the
      // margin is non-zero.
      const rect = container.getBoundingClientRect()
      const cursorXInViewport = pendingClientX - rect.left
      const cursorYInViewport = pendingClientY - rect.top

      // The page wrapper is centred HORIZONTALLY by the `flex justify-center` wrapper when
      // it's narrower than the container — so subtract that centring margin before scaling
      // and add the new one back. Vertically, the page is top-aligned (flex's main axis is
      // horizontal, no vertical centring), so there's no Y margin to deal with.
      const containerW = container.clientWidth
      const oldPageW = baseWidth * oldZoom
      const newPageW = baseWidth * newZoom
      const oldMarginX = Math.max(0, (containerW - oldPageW) / 2)
      const newMarginX = Math.max(0, (containerW - newPageW) / 2)

      // CRITICAL: on fast scrolls, the wheel fires faster than React can
      // commit zoom state changes — so the DOM's scrollLeft hasn't yet
      // caught up to the previous tick's pendingScrollRef target. Reading
      // container.scrollLeft directly would feed stale data into the
      // cursor-anchor math, which is what causes the "cursor jumps around"
      // feel when wheeling rapidly. Prefer the most recently *intended*
      // scroll target (set by a previous tick of this same handler) when
      // there is one; fall back to the DOM's current scroll otherwise.
      const scrollLeft = pendingScrollRef.current?.x ?? container.scrollLeft
      const scrollTop = pendingScrollRef.current?.y ?? container.scrollTop

      // Cursor position on the page itself (in current visual pixels).
      const pageX = scrollLeft + cursorXInViewport - oldMarginX
      const pageY = scrollTop + cursorYInViewport // top-aligned, no margin

      const ratio = newZoom / oldZoom
      const newPageX = pageX * ratio
      const newPageY = pageY * ratio

      // Convert back to scrollable-content coords (with the new horizontal centring margin).
      const newContentX = newPageX + newMarginX
      const newContentY = newPageY

      // Scroll can't go negative; if the page is still narrower than the container after
      // zooming, the cursor anchor saturates at the page's edge.
      pendingScrollRef.current = {
        x: Math.max(0, newContentX - cursorXInViewport),
        y: Math.max(0, newContentY - cursorYInViewport),
      }

      // Synchronously bump the zoom ref so the NEXT wheel tick (which might
      // fire before React commits this update) reads our new zoom, not the
      // stale committed one. Without this, multiple wheel events in flight
      // all compute against the same `oldZoom` and the zoom levels stack
      // up wrong — another source of the "jumps around" behaviour.
      zoomRef.current = newZoom
      setZoom(newZoom)
    }

    const handler = (e: WheelEvent) => {
      e.preventDefault()
      pendingDeltaY += e.deltaY
      pendingClientX = e.clientX
      pendingClientY = e.clientY
      pendingCtrlKey = e.ctrlKey
      if (rafId === null) rafId = requestAnimationFrame(applyZoom)
    }

    container.addEventListener('wheel', handler, { passive: false })
    return () => {
      container.removeEventListener('wheel', handler)
      if (rafId !== null) cancelAnimationFrame(rafId)
    }
  }, [pdfFile, baseWidth])

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
    // The SVG lives inside the CSS-scale-transformed wrapper. Its visual size on screen
    // is rendered × visualScale, but its internal coordinate system goes 0..renderedPageWidth.
    // To draw lines/circles at the click position, we need the internal coord — so divide
    // the cursor-relative-to-element offset by visualScale to undo the parent's CSS scale.
    const rect = svgRef.current!.getBoundingClientRect()
    return {
      x: (e.clientX - rect.left) / visualScale,
      y: (e.clientY - rect.top) / visualScale,
    }
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
    // Click points are in the SVG's internal coord system, which spans
    // 0..renderedPageWidth (= baseWidth × renderedZoom). The full PDF page
    // is `pageWidthMm` mm wide on paper, so each canvas pixel represents
    //   pageWidthMm / (baseWidth × renderedZoom)
    // mm on the page. The user has told us the click-to-click distance is
    // `mm` mm in the *real world*, so the ratio (real-world mm per page mm)
    // is straightforward to derive — and it's window-independent, which is
    // the whole point of storing the ratio instead of px/mm.
    const pageWidthMm = pagesData[currentPage]?.pageWidthMm
    if (!pageWidthMm) return
    const pxAtRenderedZoom = distance(calPoint1, calPoint2)
    if (pxAtRenderedZoom < 2) return
    const pageMmBetweenClicks =
      (pxAtRenderedZoom * pageWidthMm) / (baseWidth * renderedZoom)
    const ratio = mm / pageMmBetweenClicks
    setPagesData((prev) => ({
      ...prev,
      [currentPage]: {
        ...prev[currentPage],
        pageScaleRatio: ratio,
        // Drop the legacy field so it can't shadow the new ratio. Mixing
        // both is what caused walls to drift on reload in the first place.
        scalePxPerMm: undefined,
      },
    }))
    cancelCalibration()
  }

  // ---------- Calibration: ratio ----------

  function applyRatioScale(ratio: number) {
    if (!Number.isFinite(ratio) || ratio <= 0) return
    const data = pagesData[currentPage]
    if (!data?.pageWidthMm) return
    // Ratio (e.g. 100 for 1:100) IS the canonical scale invariant — write it
    // straight through. The canvas-pixel scale is derived at render time
    // from this ratio + pageWidthMm + the current `baseWidth`.
    setPagesData((prev) => ({
      ...prev,
      [currentPage]: {
        ...prev[currentPage],
        pageScaleRatio: ratio,
        scalePxPerMm: undefined,
      },
    }))
    cancelCalibration()
  }

  // ---------- Render: upload zone ----------

  if (!pdfFile) {
    return (
      <div className="max-w-[1600px] mx-auto">
        {sourceRequest && <RequestBreadcrumb request={sourceRequest} />}
        {/* Slim project bar — visible even before a PDF is uploaded so saving / details still work */}
        {(mode === 'block' || mode === 'brick') && (
          <ProjectBar
            details={projectDetails}
            isSaved={currentProjectId !== null}
            status={projectStatus}
            lastSavedAt={lastSavedAt}
            canSave={canSave}
            saveBlockedReason={saveBlockedReason}
            onSave={handleSaveProject}
            onToggleStatus={handleToggleProjectStatus}
            onDelete={handleDeleteProject}
            onOpenDetails={() => setDetailsDrawerOpen(true)}
          />
        )}

        {/* Project details drawer (overlay) */}
        <ProjectDetailsDrawer
          open={detailsDrawerOpen}
          details={projectDetails}
          onChange={setProjectDetails}
          onClose={() => setDetailsDrawerOpen(false)}
        />

        <div className="px-6 py-6">
          <WorkspacePageHeading mode={mode} />

          <div className="flex flex-col lg:flex-row gap-4 items-start">

            {/* ── Left: drop zone + onboarding hints ── */}
            <div className="flex-1 min-w-0 w-full">
              <div
                onDrop={handleDrop}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                className={`border-2 border-dashed rounded-xl p-12 text-center bg-ink-800 transition-colors ${
                  isDragging
                    ? 'border-beme-500 bg-beme-500/10'
                    : 'border-ink-600 hover:border-beme-400'
                }`}
              >
                <div className="mx-auto w-12 h-12 rounded-full bg-beme-500/15 border border-beme-500/40 flex items-center justify-center mb-4 text-2xl">
                  📄
                </div>
                <p className="text-lg text-ink-100 mb-1 font-semibold">
                  Drop your building plan PDF here
                </p>
                <p className="text-sm text-ink-400 mb-5">
                  or upload a file to start drawing walls over the plan
                </p>
                <label className="inline-block px-6 py-2.5 bg-beme-500 text-black rounded-lg cursor-pointer hover:bg-beme-400 transition-colors font-semibold text-sm">
                  Choose a PDF
                  <input
                    type="file"
                    accept="application/pdf"
                    className="hidden"
                    onChange={handleFileChange}
                  />
                </label>
                <p className="text-xs text-ink-500 mt-5">
                  Multi-page plans are supported. Each page is calibrated separately.
                </p>
              </div>

              {/* Quick-start steps */}
              <div className="mt-4 border border-ink-600 rounded-xl bg-ink-800 p-5">
                <h3 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-400 mb-3">
                  How a {mode === 'brick' ? 'brick' : 'block'} estimate works
                </h3>
                <ol className="space-y-3 text-sm text-ink-200">
                  <li className="flex gap-3">
                    <span className="flex-shrink-0 w-6 h-6 rounded-full bg-beme-500/15 border border-beme-500/40 text-beme-300 flex items-center justify-center text-xs font-bold">
                      1
                    </span>
                    <span>
                      {mode === 'block'
                        ? 'Define wall types in the side rail — bond, height, body / corner blocks, fractions.'
                        : 'Set defaults in the side rail — wall height, bricks per m², ties, plascourse.'}
                      {' '}You can do this before uploading a plan.
                    </span>
                  </li>
                  <li className="flex gap-3">
                    <span className="flex-shrink-0 w-6 h-6 rounded-full bg-beme-500/15 border border-beme-500/40 text-beme-300 flex items-center justify-center text-xs font-bold">
                      2
                    </span>
                    <span>Upload the building-plan PDF and calibrate the scale by clicking two points of a known dimension.</span>
                  </li>
                  <li className="flex gap-3">
                    <span className="flex-shrink-0 w-6 h-6 rounded-full bg-beme-500/15 border border-beme-500/40 text-beme-300 flex items-center justify-center text-xs font-bold">
                      3
                    </span>
                    <span>
                      {mode === 'block'
                        ? 'Draw walls over the plan — Beme handles corners, T-junctions, control joints, and openings automatically.'
                        : 'Trace brick walls over the plan and subtract openings — Beme calculates the brickwork area (length × height) from your dimensions.'}
                    </span>
                  </li>
                  <li className="flex gap-3">
                    <span className="flex-shrink-0 w-6 h-6 rounded-full bg-beme-500/15 border border-beme-500/40 text-beme-300 flex items-center justify-center text-xs font-bold">
                      4
                    </span>
                    <span>
                      {mode === 'block'
                        ? <>The block tally updates live in the side rail. Click <em>Export estimate</em> when you're ready to print.</>
                        : <>Bricks (m² × bricks per m²), ties, plascourse, and lintels are tallied automatically. Click <em>Export estimate</em> to print.</>}
                    </span>
                  </li>
                </ol>
              </div>
            </div>

            {/* ── Right: side rail (block: wall + pier types · brick: settings) ── */}
            <aside className="w-full lg:w-[360px] lg:flex-shrink-0">
              {mode === 'block' && (
                <>
                  <WallTypesPanel
                    makeups={makeups}
                    activeMakeupId={activeMakeupId}
                    wallCountsByMakeupId={wallCountsByMakeupId}
                    onSetActive={setActiveMakeupId}
                    onAddMakeup={handleAddMakeup}
                    onUpdateMakeup={handleUpdateMakeup}
                    onDeleteMakeup={handleDeleteMakeup}
                  />
                  <PierTypesPanel
                    pierMakeups={pierMakeups}
                    pierCountsByMakeupId={pierCountsByMakeupId}
                    onAddMakeup={handleAddPierMakeup}
                    onUpdateMakeup={handleUpdatePierMakeup}
                    onDeleteMakeup={handleDeletePierMakeup}
                  />
                  <BlockLibraryPanel />
                </>
              )}
              {mode === 'brick' && (
                <>
                  <BrickSettingsPanel settings={brickSettings} onChange={setBrickSettings} />
                  <BrickLibraryPanel />
                </>
              )}
            </aside>
          </div>
        </div>
      </div>
    )
  }

  // ---------- Render: workspace ----------

  return (
    <div className="max-w-[1600px] mx-auto">
      {sourceRequest && <RequestBreadcrumb request={sourceRequest} />}
      {/* Slim project bar — Studio Black header */}
      {(mode === 'block' || mode === 'brick') && (
        <ProjectBar
          details={projectDetails}
          isSaved={currentProjectId !== null}
          status={projectStatus}
          lastSavedAt={lastSavedAt}
          canSave={canSave}
          saveBlockedReason={saveBlockedReason}
          onSave={handleSaveProject}
          onToggleStatus={handleToggleProjectStatus}
          onDelete={handleDeleteProject}
          onOpenDetails={() => setDetailsDrawerOpen(true)}
        />
      )}

      {/* Project details drawer (overlay) */}
      <ProjectDetailsDrawer
        open={detailsDrawerOpen}
        details={projectDetails}
        onChange={setProjectDetails}
        onClose={() => setDetailsDrawerOpen(false)}
      />

      <div className="px-6 py-6">

      <WorkspacePageHeading mode={mode} />

      {/* Compact toolbar row — filename · page nav · zoom · scale all in one bar */}
      <div className="flex items-center mb-3 px-3 py-2 bg-ink-800 border border-ink-600 rounded-lg gap-4 flex-wrap">
        {/* PDF filename + Replace */}
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-sm font-medium text-ink-200 truncate max-w-[16rem]">
            {pdfFile.name}
          </span>
          <button
            onClick={() => {
              setPdfFile(null)
              setNumPages(0)
              setCurrentPage(1)
              setPagesData({})
              setZoom(1)
              cancelCalibration()
            }}
            className="text-xs text-beme-400 hover:text-beme-300 hover:underline whitespace-nowrap"
          >
            Replace
          </button>
        </div>

        <div className="h-5 w-px bg-ink-600" />

        {/* Page nav */}
        <div className="flex items-center gap-1">
          <button
            onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
            disabled={currentPage <= 1}
            className="px-2 py-1 rounded border border-ink-600 text-sm hover:bg-ink-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            aria-label="Previous page"
          >
            ←
          </button>
          <span className="text-sm text-ink-300 tabular-nums px-1 min-w-[5.5rem] text-center">
            Page {currentPage} / {numPages || '…'}
          </span>
          <button
            onClick={() => setCurrentPage((p) => Math.min(numPages, p + 1))}
            disabled={currentPage >= numPages}
            className="px-2 py-1 rounded border border-ink-600 text-sm hover:bg-ink-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            aria-label="Next page"
          >
            →
          </button>
        </div>

        <div className="h-5 w-px bg-ink-600" />

        {/* Zoom */}
        <div className="flex items-center gap-1">
          <button
            onClick={zoomOutButton}
            disabled={zoom <= MIN_ZOOM + 0.001}
            className="px-2 py-1 rounded border border-ink-600 text-sm hover:bg-ink-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            aria-label="Zoom out"
          >
            −
          </button>
          <button
            onClick={resetZoom}
            className="px-2 py-1 rounded border border-ink-600 text-sm hover:bg-ink-700 transition-colors min-w-[3.5rem] tabular-nums"
            title="Scroll to zoom · Click and drag to pan · Click to reset"
          >
            {Math.round(zoom * 100)}%
          </button>
          <button
            onClick={zoomInButton}
            disabled={zoom >= MAX_ZOOM - 0.001}
            className="px-2 py-1 rounded border border-ink-600 text-sm hover:bg-ink-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            aria-label="Zoom in"
          >
            +
          </button>
        </div>

        <div className="h-5 w-px bg-ink-600" />

        {/* Scale — collapsed inline when set, expanded controls when not OR
            when the user has hit Recalibrate. Showing the ratio dropdown
            *and* the two-click button during recalibration is important:
            most users want to swap "this is 1:100 not 1:50" with a single
            click, not click two points and type a number. The dropdown
            applies instantly; the click flow remains for cases where the
            plan's ratio isn't a standard preset (e.g. a printed copy at
            an oddball scale). */}
        {currentScale && !calibrating ? (
          <div className="flex items-center gap-2 text-sm">
            <span className="text-ink-200">
              Scale:{' '}
              {pageData?.pageScaleRatio ? (
                <span className="font-semibold tabular-nums">
                  1:{Math.round(pageData.pageScaleRatio)}
                </span>
              ) : (
                <>
                  <span className="font-semibold tabular-nums">
                    {currentScale.toFixed(3)}
                  </span>{' '}
                  <span className="text-ink-400">px/mm</span>
                </>
              )}
            </span>
            <button
              onClick={startCalibration}
              className="text-xs text-beme-400 hover:text-beme-300 hover:underline whitespace-nowrap"
            >
              Recalibrate
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm text-ink-400">
              {currentScale ? 'Recalibrating —' : 'No scale set.'}
            </span>
            <select
              value=""
              onChange={(e) => {
                const v = e.target.value
                if (!v) return
                applyRatioScale(parseFloat(v))
                e.target.value = ''
              }}
              disabled={!pageData?.pageWidthMm}
              className="px-2 py-1 border border-ink-600 rounded text-sm bg-ink-900 text-ink-50 disabled:opacity-50 focus:outline-none focus:border-beme-400"
            >
              <option value="">Pick a ratio…</option>
              {RATIO_PRESETS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
            <span className="text-xs text-ink-400">or</span>
            <button
              onClick={startCalibration}
              disabled={calibrating}
              className="px-3 py-1 rounded bg-beme-500 text-black text-sm hover:bg-beme-400 font-medium disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {calibrating ? 'Click two points on the plan…' : 'Set by clicking'}
            </button>
            {calibrating && (
              <button
                onClick={cancelCalibration}
                className="px-2 py-1 rounded border border-ink-600 text-xs hover:bg-ink-700 transition-colors"
              >
                Cancel
              </button>
            )}
          </div>
        )}
      </div>

      {/* ──────────────────── Two-column workspace body ────────────────────
          Left column = canvas + drawing controls (where your eyes/hands live).
          Right rail = setup + reference panels (wall types, tally, export).
          Stacks vertically on screens narrower than `lg`. */}
      <div className="flex flex-col lg:flex-row gap-4 items-start">

      {/* ───── Left column: canvas area ───── */}
      <div className="flex-1 min-w-0 w-full">

      {/* Sticky action bar — keeps drawing controls + banners glued to the top of the
          viewport while the user scrolls, so they don't need to scroll up to start a new
          wall/opening. Wraps the wall-drawing toolbar and all contextual banners/forms. */}
      <div className="sticky top-0 z-20 bg-ink-900 pt-2 pb-1 -mx-1 px-1 mb-2 shadow-[0_1px_0_rgba(255,255,255,0.06)]">

      {/* Wall drawing toolbar (block + brick modes) */}
      {(mode === 'block' || mode === 'brick') && (() => {
        // In block mode, every wall references a wall type (makeup) by id — drawing
        // without one selected silently produces a broken wall (no body block, no
        // height, no tally entry). Block the draw buttons until the user picks one.
        const blockModeNeedsType = mode === 'block'
        const activeMakeup = blockModeNeedsType ? makeupsById[activeMakeupId] : null
        const missingActiveType = blockModeNeedsType && !activeMakeup
        return (
        <div className="flex items-center justify-between mb-3 px-4 py-3 bg-ink-800 border border-ink-600 rounded-lg flex-wrap gap-3">
          <div className="text-sm">
            {!currentScale ? (
              <span className="text-ink-400">
                Calibrate the scale on this page before drawing walls.
              </span>
            ) : missingActiveType ? (
              <span className="text-amber-300">
                Select a wall type above before drawing.
              </span>
            ) : (
              <span className="text-ink-200">
                {currentPageWalls.length}{' '}
                wall{currentPageWalls.length === 1 ? '' : 's'} on this page
                {allWalls.length !== currentPageWalls.length && (
                  <span className="text-ink-400">
                    {' '}
                    · {allWalls.length} total in project
                  </span>
                )}
                {activeMakeup && (
                  <span className="text-ink-400"> · drawing as {activeMakeup.name}</span>
                )}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={() => {
                setDrawingMode((v) => !v)
                setPlacingOpening(false)
                setDrawingCurveMode(false)
                setPlacingControlJoint(false)
                setPlacingTiedPier(false)
                setPlacingFreestandingPier(false)
                setSelectedWallId(null)
                setSelectedOpeningId(null)
                setSelectedPierId(null)
              }}
              disabled={!currentScale || calibrating || missingActiveType}
              title={
                missingActiveType
                  ? 'Pick a wall type in the Wall types panel before drawing.'
                  : undefined
              }
              className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                drawingMode
                  ? 'bg-beme-400 text-black hover:bg-beme-300'
                  : 'bg-beme-500 text-black hover:bg-beme-400 disabled:opacity-40 disabled:cursor-not-allowed'
              }`}
            >
              {drawingMode ? 'Stop drawing' : 'Draw wall'}
            </button>
            {mode === 'block' && (
              <button
                onClick={() => {
                  setDrawingCurveMode((v) => !v)
                  setDrawingMode(false)
                  setPlacingOpening(false)
                  setPlacingControlJoint(false)
                  setPlacingTiedPier(false)
                  setPlacingFreestandingPier(false)
                  setSelectedWallId(null)
                  setSelectedOpeningId(null)
                  setSelectedPierId(null)
                }}
                disabled={
                  !currentScale ||
                  calibrating ||
                  currentPageWalls.length < 2 ||
                  missingActiveType
                }
                title={
                  missingActiveType
                    ? 'Pick a wall type in the Wall types panel before drawing.'
                    : currentPageWalls.length < 2
                    ? 'Draw two straight walls first — a curve goes between them'
                    : undefined
                }
                className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                  drawingCurveMode
                    ? 'bg-violet-700 text-white hover:bg-violet-800'
                    : 'bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-40 disabled:cursor-not-allowed'
                }`}
              >
                {drawingCurveMode ? 'Cancel curve' : '↷ Curved wall'}
              </button>
            )}
            <button
              onClick={() => {
                setPlacingOpening((v) => !v)
                setDrawingMode(false)
                setDrawingCurveMode(false)
                setPlacingControlJoint(false)
                setPlacingTiedPier(false)
                setPlacingFreestandingPier(false)
                setSelectedWallId(null)
                setSelectedOpeningId(null)
                setSelectedPierId(null)
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
            {mode === 'block' && (
              <button
                onClick={() => {
                  setPlacingControlJoint((v) => !v)
                  setDrawingMode(false)
                  setDrawingCurveMode(false)
                  setPlacingOpening(false)
                  setPlacingTiedPier(false)
                  setPlacingFreestandingPier(false)
                  setSelectedWallId(null)
                  setSelectedOpeningId(null)
                  setSelectedPierId(null)
                }}
                disabled={!currentScale || calibrating || currentPageWalls.length === 0}
                title="Click on a wall to split it at that point with a control joint"
                className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                  placingControlJoint
                    ? 'bg-rose-700 text-white hover:bg-rose-800'
                    : 'bg-rose-600 text-white hover:bg-rose-700 disabled:opacity-40 disabled:cursor-not-allowed'
                }`}
              >
                {placingControlJoint ? 'Cancel control joint' : '+ Control joint'}
              </button>
            )}
            {mode === 'block' && (
              <button
                onClick={() => {
                  // Unified pier placement: the same mode covers both tied (on a
                  // wall) and freestanding (off any wall). The decision is made at
                  // click time in WallDrawingLayer based on whether the click lands
                  // inside a wall's body. We reuse the existing
                  // placingFreestandingPier state as the carrier flag so the rest
                  // of the component (hover preview, banner visibility, etc.) can
                  // continue to key off it.
                  setPlacingFreestandingPier((v) => !v)
                  setPlacingTiedPier(false)
                  setDrawingMode(false)
                  setDrawingCurveMode(false)
                  setPlacingOpening(false)
                  setPlacingControlJoint(false)
                  setSelectedWallId(null)
                  setSelectedOpeningId(null)
                  setSelectedPierId(null)
                }}
                disabled={!currentScale || calibrating}
                title="Click on a wall for a tied pier; anywhere else for a freestanding pier."
                className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                  placingFreestandingPier
                    ? 'bg-teal-800 text-white hover:bg-teal-900'
                    : 'bg-teal-700 text-white hover:bg-teal-800 disabled:opacity-40 disabled:cursor-not-allowed'
                }`}
              >
                {placingFreestandingPier ? 'Cancel pier' : '+ Pier'}
              </button>
            )}
            {allWalls.length > 0 && (
              <button
                onClick={clearAllWalls}
                className="px-3 py-1.5 rounded-lg border border-ink-600 text-sm hover:bg-ink-700 transition-colors"
              >
                Clear all walls
              </button>
            )}
          </div>
        </div>
        )
      })()}

      {drawingMode && (
        <div className="mb-3 px-4 py-3 bg-beme-500/10 border border-beme-500/40 rounded-lg text-sm text-beme-200">
          Click two points on the plan to draw a wall. Press <kbd className="px-1.5 py-0.5 rounded border border-beme-300 bg-ink-900 text-ink-100 text-xs font-mono">Esc</kbd> to cancel.
        </div>
      )}

      {drawingCurveMode && (
        <div className="mb-3 px-4 py-3 bg-violet-500/10 border border-violet-500/40 rounded-lg text-sm text-violet-200">
          Curved wall: click the <strong>first wall</strong>, then the <strong>second wall</strong>, then a <strong>midpoint</strong> on the arc between them. Press{' '}
          <kbd className="px-1.5 py-0.5 rounded border border-violet-300 bg-ink-900 text-ink-100 text-xs font-mono">Esc</kbd> to cancel.
        </div>
      )}

      {placingOpening && (
        <div className="mb-3 px-4 py-3 bg-amber-500/10 border border-amber-500/40 rounded-lg text-sm text-amber-200">
          Click two points along the same wall to define the opening. Press{' '}
          <kbd className="px-1.5 py-0.5 rounded border border-amber-300 bg-ink-900 text-ink-100 text-xs font-mono">Esc</kbd> to cancel.
        </div>
      )}

      {placingControlJoint && (
        <div className="mb-3 px-4 py-3 bg-rose-500/10 border border-rose-500/40 rounded-lg text-sm text-rose-200">
          Click a wall where you want a <strong>control joint</strong>. The wall will be split into two walls there — each gets its own end termination. Press{' '}
          <kbd className="px-1.5 py-0.5 rounded border border-rose-300 bg-ink-900 text-ink-100 text-xs font-mono">Esc</kbd> to cancel.
        </div>
      )}

      {placingFreestandingPier && (
        <div className="mb-3 px-4 py-3 bg-teal-500/10 border border-teal-500/40 rounded-lg text-sm text-teal-200">
          Click on a wall for a <strong>tied pier</strong> (built into the wall, 40.925 / 20.01 alternating courses) — or click anywhere else for a <strong>freestanding pier</strong> ({freestandingPierHeightMm}mm tall, 40.925 stacked; change height in the side panel after placing). Press{' '}
          <kbd className="px-1.5 py-0.5 rounded border border-teal-300 bg-ink-900 text-ink-100 text-xs font-mono">Esc</kbd> to cancel.
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
          <div className="mb-3 px-4 py-3 bg-amber-500/10 border border-amber-500/40 rounded-lg text-sm text-amber-200">
            <div className="font-medium mb-3">
              Opening on a {Math.round(wallHeightMm)}mm wall · {Math.round(pendingOpening.widthMm)}mm wide
            </div>
            <div className="flex flex-wrap items-end gap-3">
              <label className="text-sm">
                <span className="block text-amber-200 mb-1">Sill height (mm)</span>
                <input
                  type="number"
                  min="0"
                  step="50"
                  value={openingSillHeightMm}
                  onChange={(e) => setOpeningSillHeightMm(parseInt(e.target.value || '0', 10))}
                  className="px-3 py-1.5 border border-amber-500/40 rounded-lg text-sm bg-ink-900 text-ink-50 w-28 focus:outline-none focus:border-amber-400"
                />
              </label>
              <label className="text-sm">
                <span className="block text-amber-200 mb-1">Head height (mm)</span>
                <input
                  type="number"
                  min="0"
                  step="50"
                  value={openingHeadHeightMm}
                  onChange={(e) => setOpeningHeadHeightMm(parseInt(e.target.value || '0', 10))}
                  className="px-3 py-1.5 border border-amber-500/40 rounded-lg text-sm bg-ink-900 text-ink-50 w-28 focus:outline-none focus:border-amber-400"
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
                className="px-4 py-1.5 rounded-lg border border-amber-500/40 text-sm text-amber-100 hover:bg-amber-500/15 transition-colors"
              >
                Cancel
              </button>
            </div>

            <div className="mt-3 px-3 py-2 bg-ink-900/70 border border-amber-500/30 rounded-lg text-xs">
              <div className="font-mono text-amber-100 leading-relaxed">
                <div>
                  <span className="text-amber-500">└─</span> Head (above opening):{' '}
                  <span className="font-semibold">{Math.round(openingHeadHeightMm)}mm</span>{' '}
                  {lintelBlock ? (
                    <span className="text-amber-300">→ Lintel {lintelBlock}</span>
                  ) : (
                    <span className="text-rose-400">→ no lintel</span>
                  )}
                </div>
                <div>
                  <span className="text-amber-500">│</span> Opening (computed):{' '}
                  <span className={tooSmall ? 'text-rose-400 font-semibold' : 'font-semibold'}>
                    {Math.round(pendingOpening.widthMm)} × {Math.round(computedOpeningHeightMm)}mm
                  </span>
                </div>
                <div>
                  <span className="text-amber-500">└─</span> Sill (wall below):{' '}
                  <span className="font-semibold">{Math.round(openingSillHeightMm)}mm</span>{' '}
                  <span className="text-amber-300">— from floor</span>
                </div>
              </div>
              {tooSmall && (
                <div className="mt-1 text-rose-400">
                  Sill + Head leave less than 100mm for the opening on a {Math.round(wallHeightMm)}mm wall.
                  Reduce one of them.
                </div>
              )}
            </div>

            <p className="text-xs text-amber-200 mt-2">
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
          <div className="mb-3 px-4 py-3 bg-amber-500/10 border border-amber-500/40 rounded-lg text-sm text-amber-200">
            <div className="font-medium mb-3">
              Opening on a {Math.round(wallHeightMm)}mm wall ·{' '}
              {Math.round(pendingOpening.widthMm)}mm wide
            </div>
            <div className="flex flex-wrap items-end gap-3">
              <label className="text-sm">
                <span className="block text-amber-200 mb-1">Opening height (mm)</span>
                <input
                  type="number"
                  min="100"
                  step="50"
                  value={brickOpeningHeightMm}
                  onChange={(e) =>
                    setBrickOpeningHeightMm(parseInt(e.target.value || '0', 10))
                  }
                  className="px-3 py-1.5 border border-amber-300 rounded-lg text-sm bg-ink-900 text-ink-50 w-32 focus:outline-none focus:border-amber-400"
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
                className="px-4 py-1.5 rounded-lg border border-amber-500/40 text-sm text-amber-100 hover:bg-amber-500/15 transition-colors"
              >
                Cancel
              </button>
            </div>

            <div className="mt-3 px-3 py-2 bg-ink-900/70 border border-amber-500/30 rounded-lg text-xs text-amber-100">
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
                    <span className="text-amber-300">
                      → supply <span className="font-semibold">{sel.lengthMm}mm {sel.profile}</span>
                    </span>
                  ) : (
                    <span className="text-rose-400">
                      → exceeds stock sizes (max 6000mm), custom needed
                    </span>
                  )
                })()}
              </div>
              {tooSmall && (
                <div className="mt-1 text-rose-400">Opening height must be at least 100mm.</div>
              )}
              {tooTall && (
                <div className="mt-1 text-rose-400">
                  Opening height ({brickOpeningHeightMm}mm) exceeds the wall height ({Math.round(wallHeightMm)}mm).
                </div>
              )}
            </div>

            <p className="text-xs text-amber-200 mt-2">
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
            <div className="mb-3 px-4 py-3 bg-sky-500/10 border border-sky-500/40 rounded-lg text-sm text-sky-200 flex items-center justify-between flex-wrap gap-3">
              <div>
                <div className="font-medium">
                  Opening: {Math.round(selectedOpening.widthMm)} ×{' '}
                  {Math.round(selectedOpening.heightMm)} mm
                </div>
                <div className="text-xs text-sky-300 mt-0.5">
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
                        <span className="text-rose-400"> → custom (exceeds 6000mm)</span>
                      )}
                    </span>
                  )}{' '}
                  · on a {Math.round(selWallHeightMm)}mm wall
                </div>
                <div className="text-xs text-sky-300 mt-0.5">
                  Press{' '}
                  <kbd className="px-1.5 py-0.5 rounded border border-sky-500/40 bg-ink-900 text-ink-100 text-xs font-mono">
                    Del
                  </kbd>{' '}
                  to remove.
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => handleOpeningDelete(selectedOpening.id)}
                  className="px-3 py-1.5 rounded-lg bg-rose-500 text-ink-50 text-sm hover:bg-rose-400 font-medium transition-colors"
                >
                  Delete opening
                </button>
                <button
                  onClick={() => setSelectedOpeningId(null)}
                  className="px-3 py-1.5 rounded-lg border border-ink-600 text-sm hover:bg-ink-700 transition-colors"
                >
                  Deselect
                </button>
              </div>
            </div>
          )
        })()}

      {mode === 'block' && selectedPier && !drawingMode && (() => {
        const selPierMakeup = selectedPier.pierMakeupId
          ? pierMakeupsById[selectedPier.pierMakeupId]
          : undefined
        const patternStr = selPierMakeup
          ? selPierMakeup.coursePattern.join(' / ')
          : selectedPier.type === 'tied'
            ? '40.925 / 20.01'
            : '40.925'
        return (
          <div className="mb-3 px-4 py-3 bg-emerald-500/10 border border-emerald-500/40 rounded-lg text-sm text-emerald-200 flex items-center justify-between flex-wrap gap-2">
            <div>
              {selectedPier.type === 'tied' ? (
                <>1 <strong>tied pier</strong> selected — built into its wall, course pattern: <span className="font-mono">{patternStr}</span>.</>
              ) : (
                <>1 <strong>freestanding pier</strong> selected — course pattern: <span className="font-mono">{patternStr}</span>.</>
              )}
              <div className="text-xs text-emerald-200 mt-0.5">
                Press <kbd className="px-1.5 py-0.5 rounded border border-emerald-300 bg-ink-900 text-ink-100 text-xs font-mono">Del</kbd> to remove.
              </div>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <label className="flex items-center gap-2 text-sm">
                <span>Pier type:</span>
                <select
                  value={selectedPier.pierMakeupId ?? ''}
                  onChange={(e) => handleReassignPierMakeup(selectedPier.id, e.target.value)}
                  className="px-2 py-1 border border-emerald-300 rounded text-sm bg-ink-900 text-ink-50"
                >
                  {pierMakeups.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </label>
              {selectedPier.type === 'freestanding' && (
                <label className="flex items-center gap-2 text-sm">
                  <span>Height:</span>
                  <input
                    type="number"
                    min="200"
                    step="200"
                    value={selectedPier.heightMm}
                    onChange={(e) =>
                      handleUpdateFreestandingPierHeight(
                        selectedPier.id,
                        Math.max(200, parseInt(e.target.value || '0', 10))
                      )
                    }
                    className="w-20 px-2 py-1 border border-emerald-300 rounded text-sm bg-ink-900 text-ink-50"
                  />
                  <span className="text-xs text-emerald-200">mm</span>
                </label>
              )}
              <button
                onClick={() => handleDeletePier(selectedPier.id)}
                className="px-3 py-1.5 rounded-lg bg-rose-500 text-ink-50 text-sm hover:bg-rose-400 font-medium transition-colors"
              >
                Delete pier
              </button>
              <button
                onClick={() => setSelectedPierId(null)}
                className="px-3 py-1.5 rounded-lg border border-ink-600 text-sm hover:bg-ink-700 transition-colors"
              >
                Deselect
              </button>
            </div>
          </div>
        )
      })()}

      {/* Batch multi-selection banner. Shows when 2+ items across walls/openings/
          piers are selected. Single-item banners only render when their respective
          "single-selected" ID is non-null (selectedWall, selectedOpening, etc.),
          which is exactly the case when the user has exactly one of THAT type
          selected and nothing else. So this batch banner never overlaps with the
          single-item ones. */}
      {(() => {
        const totalSelected =
          selectedWallIds.size + selectedOpeningIds.size + selectedPierIds.size
        if (totalSelected < 2) return null
        const wallCount = selectedWallIds.size
        const openingCount = selectedOpeningIds.size
        const pierCount = selectedPierIds.size
        const parts: string[] = []
        if (wallCount > 0) parts.push(`${wallCount} wall${wallCount === 1 ? '' : 's'}`)
        if (openingCount > 0)
          parts.push(`${openingCount} opening${openingCount === 1 ? '' : 's'}`)
        if (pierCount > 0) parts.push(`${pierCount} pier${pierCount === 1 ? '' : 's'}`)
        function batchDelete() {
          const wallIds = Array.from(selectedWallIds)
          const openingIds = Array.from(selectedOpeningIds)
          const pierIds = Array.from(selectedPierIds)
          for (const id of pierIds) handleDeletePier(id)
          for (const id of openingIds) handleOpeningDelete(id)
          for (const id of wallIds) handleWallDelete(id)
        }
        function batchClear() {
          setSelectedWallId(null)
          setSelectedOpeningId(null)
          setSelectedPierId(null)
        }
        function batchReassignMakeup(makeupId: string) {
          for (const wallId of Array.from(selectedWallIds)) {
            handleReassignWallMakeup(wallId, makeupId)
          }
        }
        return (
          <div className="mb-3 px-4 py-3 bg-sky-500/10 border border-sky-500/40 rounded-lg text-sm text-sky-200 flex items-center justify-between flex-wrap gap-2">
            <span>
              {parts.join(' + ')} selected. Press{' '}
              <kbd className="px-1.5 py-0.5 rounded border border-sky-500/40 bg-ink-900 text-ink-100 text-xs font-mono">Del</kbd>{' '}
              to remove all, or Shift+click to add/remove items.
            </span>
            <div className="flex items-center gap-2 flex-wrap">
              {mode === 'block' && wallCount > 0 && (
                <label className="flex items-center gap-2 text-sm text-sky-200">
                  <span>Wall type ({wallCount}):</span>
                  <select
                    value=""
                    onChange={(e) => {
                      if (e.target.value) batchReassignMakeup(e.target.value)
                    }}
                    className="px-2 py-1 border border-sky-500/40 rounded text-sm bg-ink-900 text-ink-50"
                  >
                    <option value="" disabled>
                      Reassign to…
                    </option>
                    {makeups.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <button
                onClick={batchDelete}
                className="px-3 py-1.5 rounded-lg bg-rose-500 text-ink-50 text-sm hover:bg-rose-400 font-medium transition-colors"
              >
                Delete all
              </button>
              <button
                onClick={batchClear}
                className="px-3 py-1.5 rounded-lg border border-ink-600 text-sm hover:bg-ink-700 transition-colors"
              >
                Deselect
              </button>
            </div>
          </div>
        )
      })()}

      {(mode === 'block' || mode === 'brick') && selectedWall && !drawingMode && (
        <div className="mb-3 px-4 py-3 bg-sky-500/10 border border-sky-500/40 rounded-lg text-sm text-sky-200 flex items-center justify-between flex-wrap gap-2">
          <span>
            1 wall selected. Drag its endpoints to reposition, or press{' '}
            <kbd className="px-1.5 py-0.5 rounded border border-sky-500/40 bg-ink-900 text-ink-100 text-xs font-mono">Del</kbd> to remove.
          </span>
          <div className="flex items-center gap-2 flex-wrap">
            {mode === 'block' && (
              <label className="flex items-center gap-2 text-sm text-sky-200">
                <span>Wall type:</span>
                <select
                  value={selectedWall.makeupId}
                  onChange={(e) => handleReassignWallMakeup(selectedWall.id, e.target.value)}
                  className="px-2 py-1 border border-sky-500/40 rounded text-sm bg-ink-900 text-ink-50"
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
              <label className="flex items-center gap-2 text-sm text-sky-200">
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
                  className="px-2 py-1 border border-sky-500/40 rounded text-sm bg-ink-900 text-ink-50 w-24"
                />
                <span>mm</span>
              </label>
            )}
            <button
              onClick={() => handleWallDelete(selectedWall.id)}
              className="px-3 py-1.5 rounded-lg bg-rose-500 text-ink-50 text-sm hover:bg-rose-400 font-medium transition-colors"
            >
              Delete wall
            </button>
            <button
              onClick={() => setSelectedWallId(null)}
              className="px-3 py-1.5 rounded-lg border border-ink-600 text-sm hover:bg-ink-700 transition-colors"
            >
              Deselect
            </button>
          </div>
        </div>
      )}

      </div>
      {/* End of sticky action bar */}

      {/* Calibration instructions banner */}
      {calibrating && !(calPoint1 && calPoint2) && (
        <div className="mb-3 px-4 py-3 bg-beme-500/10 border border-beme-500/40 rounded-lg text-sm text-beme-200">
          {!calPoint1
            ? 'Click the first point along a known dimension on the plan. Zoom in for accuracy.'
            : 'Click the second point.'}
        </div>
      )}

      {/* Calibration distance input */}
      {calibrating && calPoint1 && calPoint2 && (
        <div className="mb-3 px-4 py-3 bg-beme-500/10 border border-beme-500/40 rounded-lg flex items-center gap-3 flex-wrap">
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
            className="px-3 py-1.5 border border-beme-300 rounded-lg text-sm w-32 focus:outline-none focus:border-beme-400"
          />
          <span className="text-sm text-beme-700">mm</span>
          <button
            onClick={submitCalibration}
            disabled={!calInput || parseFloat(calInput) <= 0}
            className="px-4 py-1.5 rounded-lg bg-beme-500 text-black text-sm hover:bg-beme-400 font-medium disabled:opacity-40 disabled:cursor-not-allowed transition-colors font-medium"
          >
            Save scale
          </button>
        </div>
      )}

      {/* Page thumbnails + main PDF view */}
      <div className="flex gap-3">
        {/* Thumbnail sidebar (multi-page only). Extracted into a memoised
            component so zoom-driven re-renders of PdfWorkspace don't ripple
            through the per-page <Page> rendering — without this, each zoom
            tick reconciled `numPages` PDF pages, which was the bottleneck on
            multi-page plans. */}
        {numPages > 1 && (
          <ThumbnailSidebar
            sidebarRef={sidebarRef}
            pdfFile={pdfFile}
            numPages={numPages}
            currentPage={currentPage}
            pagesData={pagesData}
            onSelectPage={setCurrentPage}
          />
        )}

      {/* PDF + overlay (scrollable container with wheel-zoom and click-drag pan) */}
      <div
        ref={containerRef}
        onMouseDown={handlePanMouseDown}
        className="flex-1 border border-ink-600 rounded-xl overflow-auto bg-ink-800 min-h-[400px] max-h-[80vh]"
        style={{
          cursor:
            calibrating ||
            drawingMode ||
            placingOpening ||
            placingControlJoint ||
            placingTiedPier ||
            placingFreestandingPier
              ? 'crosshair'
              : 'grab',
        }}
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
            {/* Inner wrapper is at the rendered (canvas) resolution and gets CSS-scaled.
                The PDF canvas, calibration overlay, AND the Konva wall layer all live INSIDE
                this transformed wrapper — they all scale together with one transform. The
                Konva layer is sized at renderedPageWidth × renderedPageHeight (a stable size
                across interactive zoom), so its props don't change on every wheel tick and
                React skips re-rendering it. The CSS transform handles the visual scaling
                "for free" between rasterisations. */}
            <div
              style={{
                width: renderedPageWidth,
                height: renderedPageHeight ?? undefined,
                position: 'relative',
                // Always apply the transform (even at scale 1) so the element stays on its
                // own GPU compositor layer across the whole gesture. Toggling the transform
                // property on and off forces the compositor to rebuild the layer.
                transform: `scale(${visualScale})`,
                transformOrigin: '0 0',
                willChange: 'transform',
              }}
            >
              <Document
                file={pdfFile}
                onLoadSuccess={({ numPages: n }) => setNumPages(n)}
                loading={<p className="text-ink-400 p-12">Loading PDF…</p>}
                error={<p className="text-rose-400 p-12">Couldn't load that PDF. Is it a valid file?</p>}
              >
                <Page
                  pageNumber={currentPage}
                  width={renderedPageWidth}
                  renderAnnotationLayer={false}
                  renderTextLayer={false}
                  onLoadSuccess={(page) => {
                    const widthMm = (page.originalWidth / POINTS_PER_INCH) * MM_PER_INCH
                    const heightMm = (page.originalHeight / POINTS_PER_INCH) * MM_PER_INCH
                    setPagesData((prev) => {
                      const existing = prev[currentPage] ?? {}
                      // Migration for projects saved before the page-ratio
                      // refactor: convert the legacy canvas-pixel-relative
                      // `scalePxPerMm` into the window-independent
                      // `pageScaleRatio` now that we know the PDF's true
                      // `pageWidthMm`. Best-effort — it assumes the current
                      // baseWidth roughly matches the one at save time. After
                      // this migration the ratio is the source of truth and
                      // subsequent reloads are stable regardless of viewport
                      // size.
                      const needsMigration =
                        existing.scalePxPerMm !== undefined &&
                        existing.pageScaleRatio === undefined
                      const migratedRatio = needsMigration
                        ? baseWidth / (widthMm * existing.scalePxPerMm!)
                        : existing.pageScaleRatio
                      return {
                        ...prev,
                        [currentPage]: {
                          ...existing,
                          pageWidthMm: widthMm,
                          pageHeightMm: heightMm,
                          pageScaleRatio: migratedRatio,
                          // Clear the legacy field once migrated so future
                          // saves don't carry the now-stale value forward.
                          scalePxPerMm: needsMigration ? undefined : existing.scalePxPerMm,
                        },
                      }
                    })
                  }}
                />
              </Document>

              {/* Calibration overlay — at renderedZoom resolution; scales with parent. */}
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

              {/* Wall drawing layer — at renderedZoom resolution; scales with parent. */}
              {(mode === 'block' || mode === 'brick') && renderedPageHeight !== null && currentScale && (
                <WallDrawingLayer
                  walls={currentPageWalls}
                  openings={currentPageOpenings}
                  wallThicknessByWallId={wallThicknessByWallId}
                  visualWidth={renderedPageWidth}
                  visualHeight={renderedPageHeight}
                  pxPerMmAtCurrentZoom={currentScale * renderedZoom}
                  // True during the 300 ms debounce after a wheel event,
                  // when the canvas is CSS-scaling ahead of the rasterised
                  // zoom. The wall layer uses this to suppress hover state
                  // updates that would otherwise stutter the gesture.
                  //
                  // IMPORTANT: compare against the CLAMPED target, not raw
                  // `zoom`. `renderedZoom` caps at MAX_RENDERED_ZOOM, so a
                  // raw `zoom !== renderedZoom` comparison stays true forever
                  // whenever the user is zoomed in past the cap — which would
                  // permanently disable hit-testing on the stage and silently
                  // break wall selection / delete. Using the clamped target
                  // means the flag resets to false the moment the re-raster
                  // debounce completes, regardless of how high zoom goes.
                  isZooming={Math.min(zoom, MAX_RENDERED_ZOOM) !== renderedZoom}
                  drawingMode={drawingMode}
                  drawingCurveMode={drawingCurveMode}
                  placingOpening={placingOpening}
                  placingControlJoint={placingControlJoint}
                  placingTiedPier={placingTiedPier}
                  placingFreestandingPier={placingFreestandingPier}
                  piers={currentPagePiers}
                  selectedWallId={selectedWallId}
                  selectedOpeningId={selectedOpeningId}
                  selectedPierId={selectedPierId}
                  selectedWallIds={selectedWallIds}
                  selectedOpeningIds={selectedOpeningIds}
                  selectedPierIds={selectedPierIds}
                  onWallToggleSelect={toggleSelectedWallId}
                  onOpeningToggleSelect={toggleSelectedOpeningId}
                  onPierToggleSelect={toggleSelectedPierId}
                  onWallAdded={handleWallAdded}
                  onCurvedWallAdded={handleCurvedWallAdded}
                  onWallSelect={handleWallSelect}
                  onWallEndpointMoved={handleWallEndpointMoved}
                  onOpeningPlaced={handleOpeningPlaced}
                  onOpeningSelect={handleOpeningSelect}
                  onControlJointPlaced={handleControlJointPlaced}
                  onTiedPierPlaced={handleTiedPierPlaced}
                  onFreestandingPierPlaced={handleFreestandingPierPlaced}
                  onPierSelect={handlePierSelect}
                  onCancelDraw={handleCancelDraw}
                />
              )}
            </div>
          </div>
        </div>
      </div>
      </div>

      </div>
      {/* ───── End of left column ───── */}

      {/* ───── Right rail: setup + reference panels ─────
          ~340px wide on lg+ screens, full-width stacked below the canvas on smaller.
          Each panel handles its own collapse state, so users can hide what they're
          not actively using and the rail can absorb new panels (selection details,
          piers, control joints, etc.) without making the page taller. */}
      <aside className="w-full lg:w-[360px] lg:flex-shrink-0 -mt-4 lg:mt-0">

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

        {/* Pier types management panel (block mode) */}
        {mode === 'block' && (
          <PierTypesPanel
            pierMakeups={pierMakeups}
            pierCountsByMakeupId={pierCountsByMakeupId}
            onAddMakeup={handleAddPierMakeup}
            onUpdateMakeup={handleUpdatePierMakeup}
            onDeleteMakeup={handleDeletePierMakeup}
          />
        )}

        {/* Block library (block mode) — user-editable catalogue of every block */}
        {mode === 'block' && <BlockLibraryPanel />}

        {/* Brick settings + library (brick mode) */}
        {mode === 'brick' && (
          <>
            <BrickSettingsPanel settings={brickSettings} onChange={setBrickSettings} />
            <BrickLibraryPanel />
          </>
        )}

        {/* Block tally panel (block mode) */}
        {mode === 'block' && (
          <BlockTallyPanel
            walls={allWalls}
            makeupsById={makeupsById}
            openings={allOpenings}
            piers={allPiers}
            pierMakeupsById={pierMakeupsById}
          />
        )}

        {/* Brick tally panel (brick mode) */}
        {mode === 'brick' && (
          <BrickTallyPanel walls={allWalls} openings={allOpenings} settings={brickSettings} />
        )}

        {/* Block export panel (block mode) */}
        {mode === 'block' && (
          <BlockExportPanel
            projectDetails={projectDetails}
            inclusions={blockExportInclusions}
            onChangeInclusions={setBlockExportInclusions}
            walls={allWalls}
            makeups={makeups}
            openings={allOpenings}
            piers={allPiers}
            pierMakeups={pierMakeups}
            pdfFile={pdfFile}
            // One PageInfo per PDF page that actually has walls — the export
            // builds a separate Wall Layout overview page for each, so
            // multi-floor projects get one labelled diagram per floor instead
            // of trying to cram every floor onto one overview. Page order
            // follows numeric order so the export reads bottom-up the way the
            // building is built.
            pagesInfo={Object.keys(wallsByPage)
              .map((n) => parseInt(n, 10))
              .filter((n) => (wallsByPage[n]?.length ?? 0) > 0)
              .sort((a, b) => a - b)
              .map((n) => ({
                pageNumber: n,
                pageWidthMm: pagesData[n]?.pageWidthMm,
                pageHeightMm: pagesData[n]?.pageHeightMm,
                pageScaleRatio: pagesData[n]?.pageScaleRatio,
                walls: wallsByPage[n] ?? [],
                openings: openingsByPage[n] ?? [],
                piers: piersByPage[n] ?? [],
              }))}
          />
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
      </aside>

      </div>
      {/* ─────────────────── End of two-column body ─────────────────── */}

      </div>{/* End workspace padding wrapper */}
    </div>
  )
}

/**
 * Slim breadcrumb shown above the ProjectBar when the current project was
 * created from an estimate request. Lets the estimator pop back to the
 * request page to re-read the sales spec or check the customer's notes
 * without losing their place in the workspace (the router-link preserves
 * the project in the back history).
 */
/**
 * Multi-page PDF thumbnail rail. Extracted from PdfWorkspace and memoised
 * because the per-page <Page> rendering is the most expensive part of the
 * workspace render — without memoisation, every zoom tick reconciled all
 * `numPages` PDF page components, which is what made the lag scale with
 * page count on plans with many sheets.
 *
 * Props are deliberately narrow: only the values the sidebar actually
 * depends on are passed in, so the memo holds during zoom (none of these
 * change while the user is wheeling).
 */
interface ThumbnailSidebarProps {
  sidebarRef: React.RefObject<HTMLDivElement | null>
  pdfFile: File
  numPages: number
  currentPage: number
  pagesData: Record<number, { pageScaleRatio?: number; scalePxPerMm?: number }>
  onSelectPage: (pageNum: number) => void
}

const ThumbnailSidebar = memo(function ThumbnailSidebar({
  sidebarRef,
  pdfFile,
  numPages,
  currentPage,
  pagesData,
  onSelectPage,
}: ThumbnailSidebarProps) {
  return (
    <div
      ref={sidebarRef}
      className="w-40 flex-shrink-0 max-h-[80vh] overflow-y-auto bg-ink-800 border border-ink-600 rounded-xl p-2"
    >
      <Document file={pdfFile} loading={null} error={null}>
        <div className="space-y-2">
          {Array.from({ length: numPages }, (_, i) => i + 1).map((pageNum) => {
            const isCurrent = pageNum === currentPage
            // "Scaled" if either the new page-ratio is set (post-fix projects)
            // or the legacy px/mm field is present (legacy projects, until
            // migration runs on PDF load).
            const hasScale =
              !!pagesData[pageNum]?.pageScaleRatio ||
              !!pagesData[pageNum]?.scalePxPerMm
            return (
              <button
                key={pageNum}
                onClick={() => onSelectPage(pageNum)}
                className={`block w-full p-1 rounded-md transition-colors text-left ${
                  isCurrent
                    ? 'ring-2 ring-beme-500 bg-beme-500/10'
                    : 'ring-1 ring-ink-600 hover:ring-beme-500/60 bg-ink-700/40'
                }`}
              >
                <div
                  className="bg-ink-800 flex justify-center overflow-hidden rounded-sm"
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
                    isCurrent ? 'text-beme-300 font-semibold' : 'text-ink-300'
                  }`}
                >
                  <span>Page {pageNum}</span>
                  {hasScale && (
                    <span className="text-emerald-300" title="Scale set">
                      ✓
                    </span>
                  )}
                </div>
              </button>
            )
          })}
        </div>
      </Document>
    </div>
  )
})

function RequestBreadcrumb({ request }: { request: EstimateRequest }) {
  return (
    <div className="px-6 pt-4">
      <Link
        to={`/requests/${request.id}`}
        className="inline-flex items-center gap-2 text-xs text-ink-300 hover:text-beme-300 transition-colors"
      >
        <span>←</span>
        <span>
          Request from{' '}
          <span className="text-ink-100 font-medium">{request.customerName}</span>
          {request.customerCompany && (
            <span className="text-ink-400"> · {request.customerCompany}</span>
          )}
        </span>
      </Link>
    </div>
  )
}

/**
 * Page heading for the workspace — matches the Dashboard's typography on the
 * home page. Sits below the ProjectBar so the user always knows whether
 * they're in a brick or block workspace.
 */
function WorkspacePageHeading({ mode }: { mode: 'block' | 'brick' | undefined }) {
  if (mode === 'brick') {
    return (
      <div className="mb-6">
        <h2 className="text-4xl font-extrabold tracking-tight text-ink-50">Brick estimate</h2>
        <p className="text-ink-300 text-sm mt-1">
          Trace brick walls over a plan — area × bricks/m² plus ties, plascourse, and lintels.
        </p>
      </div>
    )
  }
  if (mode === 'block') {
    return (
      <div className="mb-6">
        <h2 className="text-4xl font-extrabold tracking-tight text-ink-50">Block estimate</h2>
        <p className="text-ink-300 text-sm mt-1">
          Walls, piers, openings — auto-tallied to a printable schedule.
        </p>
      </div>
    )
  }
  return null
}
