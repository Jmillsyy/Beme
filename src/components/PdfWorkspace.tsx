import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { PDFDocument } from 'pdf-lib'
import { Document, Page, pdfjs } from 'react-pdf'
import 'react-pdf/dist/Page/AnnotationLayer.css'
import 'react-pdf/dist/Page/TextLayer.css'
import WallDrawingLayer from './WallDrawingLayer'
import BlockLibraryPanel from './BlockLibraryPanel'
import BlockTallyPanel from './BlockTallyPanel'
import BrickLibraryPanel from './BrickLibraryPanel'
import PierTypesPanel from './PierTypesPanel'
import WallTypesPanel from './WallTypesPanel'
import BrickAdditionsPanel from './BrickAdditionsPanel'
import BrickTypesPanel from './BrickTypesPanel'
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
  BrickMakeup,
  BrickSettings,
  Opening,
  Pier,
  PierMakeup,
  ProjectDetails,
  Wall,
  WallMakeup,
} from '../types/walls'
import {
  createDefaultBrickMakeups,
  createDefaultPierMakeups,
  createDefaultTiedPierMakeup,
  createDefaultWallMakeup,
} from '../lib/makeups'
import { arcFromThreePoints } from '../lib/curveGeom'
import { curveZoneForRadius } from '../lib/blockCalc'
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
/**
 * Migrate legacy brick walls (saved with `makeupId === ''`) so every wall
 * references a real BrickMakeup. Without this, the new wall-types panel
 * would show "0 walls using this" for every makeup on an existing brick
 * project, and click-to-select-walls-of-type wouldn't find anything.
 *
 * Block walls (or any non-empty makeupId) are passed through unchanged.
 */
function migrateBrickWalls(
  wallsByPage: Record<number, Wall[]>,
  defaultBrickMakeupId: string
): Record<number, Wall[]> {
  if (!defaultBrickMakeupId) return wallsByPage
  const out: Record<number, Wall[]> = {}
  for (const [pageStr, walls] of Object.entries(wallsByPage)) {
    out[Number(pageStr)] = walls.map((w) =>
      w.makeupId === '' ? { ...w, makeupId: defaultBrickMakeupId } : w
    )
  }
  return out
}

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
import { wallTypeColor } from '../lib/wallTypeColors'
import { selectBlockLintel, brickLintelBearingMm, brickLintelTotalLengthMm } from '../lib/lintels'
import {
  getEstimateRequestByProjectId,
  updateEstimateRequest,
} from '../lib/estimateRequests'
import { getCurrentOrgId } from '../lib/organisations'
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

/**
 * Scale-ratio presets covering the common Australian / metric architectural
 * + engineering set. Ordered ascending so the dropdown reads naturally.
 * "Custom…" at the bottom (handled in the dropdown's onChange) prompts the
 * user to type any integer ratio for plans printed at oddball scales.
 */
const RATIO_PRESETS = [
  { label: '1:5', value: 5 },
  { label: '1:10', value: 10 },
  { label: '1:20', value: 20 },
  { label: '1:25', value: 25 },
  { label: '1:50', value: 50 },
  { label: '1:75', value: 75 },
  { label: '1:100', value: 100 },
  { label: '1:125', value: 125 },
  { label: '1:150', value: 150 },
  { label: '1:200', value: 200 },
  { label: '1:250', value: 250 },
  { label: '1:300', value: 300 },
  { label: '1:400', value: 400 },
  { label: '1:500', value: 500 },
  { label: '1:750', value: 750 },
  { label: '1:1000', value: 1000 },
  { label: '1:2000', value: 2000 },
  { label: '1:5000', value: 5000 },
]

/**
 * Prompt the user for an arbitrary integer ratio and return the parsed value.
 * Returns null if cancelled or invalid (so the caller can no-op the change).
 * Bounded to a sane range — anything outside it is almost certainly a typo.
 */
function promptCustomRatio(): number | null {
  if (typeof window === 'undefined') return null
  const raw = window.prompt(
    'Enter the scale ratio denominator (e.g. 80 for 1:80).',
    '100'
  )
  if (raw === null) return null
  const n = parseInt(raw.replace(/[^\d]/g, ''), 10)
  if (!isFinite(n) || n < 1 || n > 100000) {
    window.alert('Please enter a whole number between 1 and 100000.')
    return null
  }
  return n
}

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

/**
 * Virtual page dimensions used by empty-workspace mode. Treats the canvas like
 * an A1 sheet (841 × 594 mm) so the proportions match what a printed plan
 * would look like, and seeds pageScaleRatio so currentScale resolves on first
 * render — no calibration step required. The user can still flip to a
 * different ratio (1:50, 1:200…) from the toolbar dropdown.
 */
const EMPTY_WORKSPACE_PAGE_WIDTH_MM = 841
const EMPTY_WORKSPACE_PAGE_HEIGHT_MM = 594
const EMPTY_WORKSPACE_DEFAULT_RATIO = 100

export default function PdfWorkspace({ mode, projectId }: PdfWorkspaceProps = {}) {
  const [pdfFile, setPdfFile] = useState<File | null>(null)
  const [numPages, setNumPages] = useState<number>(0)
  const [currentPage, setCurrentPage] = useState<number>(1)
  const [isDragging, setIsDragging] = useState(false)
  /**
   * True when the project was started without uploading a PDF — we're drawing
   * on a blank canvas at a fixed ratio. Persisted on the SavedProject so
   * reloads land back in this mode instead of bouncing back to the upload zone.
   */
  const [isEmptyWorkspace, setIsEmptyWorkspace] = useState(false)

  // ---------- Multi-PDF support ----------
  // `pdfFile` above is the PRIMARY plan — the file walls / openings / piers
  // are drawn against. `referencePdfFiles` is a parallel list of additional
  // PDFs attached to the project (engineering specs etc.) that the estimator
  // can flip to but doesn't draw on. `activeReferenceIndex` is null when the
  // primary is showing, otherwise the index into referencePdfFiles of the
  // file currently displayed. Walls + pages + calibration all stay tied to
  // the primary regardless of what's on screen; reference PDFs are view-only.
  const [referencePdfFiles, setReferencePdfFiles] = useState<File[]>([])
  // Parallel to referencePdfFiles — storage path for each reference PDF, so
  // re-saves don't re-upload bytes that haven't changed. Populated when the
  // project is loaded from cloud; undefined entries mean "freshly attached,
  // upload on next save". Always the same length as referencePdfFiles.
  const [referencePdfPaths, setReferencePdfPaths] = useState<(string | undefined)[]>([])
  const [activeReferenceIndex, setActiveReferenceIndex] = useState<number | null>(null)
  // When the user flips to a reference PDF we save the primary's current page
  // here so we can drop them back on that page when they switch back. Without
  // it, navigating pages inside the engineering PDF would scribble over the
  // primary's page state and lose their spot.
  const [primaryCurrentPage, setPrimaryCurrentPage] = useState<number>(1)
  const isReferenceView = activeReferenceIndex !== null
  const displayedPdfFile: File | null = isReferenceView
    ? referencePdfFiles[activeReferenceIndex!] ?? null
    : pdfFile

  /**
   * Switch the workspace's displayed PDF. `index === null` means flip back to
   * the primary; otherwise jumps to the matching reference. Page state is
   * saved/restored across the switch so navigating pages inside a reference
   * doesn't clobber where the user was on the primary.
   */
  function switchPdf(index: number | null) {
    if (index === activeReferenceIndex) return
    // Leaving primary → save its page.
    if (activeReferenceIndex === null && index !== null) {
      setPrimaryCurrentPage(currentPage)
    }
    setActiveReferenceIndex(index)
    // Re-entering primary → restore its page.
    if (index === null) {
      setCurrentPage(primaryCurrentPage)
    } else {
      // Reference PDFs start on page 1 — the user is flipping in to look at
      // something, not resuming a deep dive.
      setCurrentPage(1)
    }
  }

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

  // ---------- Ruler / measurement state ----------
  // Transient on-canvas measurements. NOT persisted to the project — they're
  // a quick-check tool: drop two points to see how far apart they are on
  // the plan, useful before drawing a wall, verifying calibration, or
  // sizing something the plan doesn't dimension. Keyed by page so a measure
  // on page 2 doesn't show on page 1.
  const [placingRuler, setPlacingRuler] = useState(false)
  const [measurementsByPage, setMeasurementsByPage] = useState<
    Record<number, Array<{ id: string; startMm: { x: number; y: number }; endMm: { x: number; y: number } }>>
  >({})
  const [rulerAnchorMm, setRulerAnchorMm] = useState<{ x: number; y: number } | null>(null)

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

  // ---------- Undo / redo ----------
  // A snapshot is the tuple of every page-keyed data state we let the user
  // undo: walls, openings, piers. We track them as a single object so one
  // undo step rolls them all back together (deleting a wall also drops
  // attached openings + tied piers, and the user should get all three back
  // on Ctrl+Z, not just the wall).
  type EditSnapshot = {
    wallsByPage: Record<number, Wall[]>
    openingsByPage: Record<number, Opening[]>
    piersByPage: Record<number, Pier[]>
  }
  const UNDO_LIMIT = 50
  const [undoStack, setUndoStack] = useState<EditSnapshot[]>([])
  const [redoStack, setRedoStack] = useState<EditSnapshot[]>([])
  // Last snapshot we observed — used by the auto-snapshot effect below to
  // decide whether the latest render reflects a new edit (push to undo) or
  // a state restoration we just performed (skip).
  const lastEditSnapshotRef = useRef<EditSnapshot | null>(null)
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

  /**
   * Brick wall types — parallel to block `makeups`. New brick projects
   * seed with two sensible defaults ("Facework", "Rendered") which the
   * user can rename / add to. Each drawn brick wall references a makeup
   * by id, and the calc engine reads height + brick-type from the makeup
   * with a fall-back to project-level brickSettings.
   */
  const [brickMakeups, setBrickMakeups] = useState<BrickMakeup[]>(() =>
    createDefaultBrickMakeups()
  )
  const [activeBrickMakeupId, setActiveBrickMakeupId] = useState<string>(
    () => brickMakeups[0]?.id ?? ''
  )

  // Project details + export inclusion tickboxes (brick mode)
  const [projectDetails, setProjectDetails] = useState<ProjectDetails>(() =>
    createDefaultProjectDetails()
  )
  /**
   * Gate: show a startup modal that captures project + customer info BEFORE
   * the workspace becomes interactive. Previously the project-details drawer
   * was hidden in a corner of the project bar, so users would draw a whole
   * estimate, hit Save, and get a cryptic "Fill in a project name or site
   * address" message they didn't know how to act on. This gate makes the
   * required step the first one. It's only relevant for brand-new projects
   * (no id in the URL); loaded projects bypass it since they already have
   * details. Once the user enters a project name and clicks Start, the
   * modal closes and they can edit further via the existing drawer.
   */
  const [startupGateOpen, setStartupGateOpen] = useState<boolean>(() => !projectId)
  const [exportInclusions, setExportInclusions] = useState<BrickExportInclusions>(() =>
    createDefaultExportInclusions()
  )
  const [blockExportInclusions, setBlockExportInclusions] = useState<BlockExportInclusions>(
    () => createDefaultBlockExportInclusions()
  )

  // ---------- Saved-project tracking ----------
  /** ID of the currently-loaded saved project (null if this is a fresh, unsaved workspace). */
  const [currentProjectId, setCurrentProjectId] = useState<string | null>(projectId ?? null)
  /**
   * organisation_id this project belongs to. Set from the loaded SavedProject
   * on hydrate, so a project that's already attached to an org keeps that
   * link even if the user has since switched their active org context.
   * Saves re-use this value (falling back to the current org for brand-new
   * projects that haven't been saved yet). Personal-track projects keep this
   * as null and stay personal.
   */
  const [projectOrganisationId, setProjectOrganisationId] = useState<string | null>(null)
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
        // Empty-workspace flag — hydrate so reload skips the upload zone. Also
        // seed numPages = 1 since there's no Document.onLoadSuccess to do it.
        if (proj.emptyWorkspace) {
          setIsEmptyWorkspace(true)
          setNumPages(1)
        }
        // Reference PDFs (engineering specs etc.) — reconstruct File objects
        // from each saved Blob, parallel to a list of storage paths so re-
        // saves don't re-upload bytes that haven't changed. Entries whose
        // blob failed to download are skipped (the file isn't reachable, so
        // showing a tab for it would just open a broken view).
        if (proj.referencePdfs && proj.referencePdfs.length > 0) {
          const files: File[] = []
          const paths: (string | undefined)[] = []
          for (const ref of proj.referencePdfs) {
            if (!ref.blob) continue
            files.push(
              new File([ref.blob], ref.fileName, {
                type: ref.blob.type || 'application/pdf',
              })
            )
            paths.push(ref.path)
          }
          setReferencePdfFiles(files)
          setReferencePdfPaths(paths)
        }
        setProjectDetails(proj.projectDetails)
        // Loading a saved project bypasses the startup gate — the details
        // already exist, no need to ask for them again.
        setStartupGateOpen(false)
        setPagesData(proj.pagesData)
        // Loading a project replaces the workspace state wholesale — wipe the
        // undo / redo stacks so the user can't accidentally "undo" all the way
        // back to the previous project's blank state. Also seed the snapshot
        // ref to match the incoming data so the auto-snapshot effect doesn't
        // immediately push it as if it were an edit.
        setUndoStack([])
        setRedoStack([])
        lastEditSnapshotRef.current = {
          wallsByPage: proj.wallsByPage,
          openingsByPage: proj.openingsByPage,
          piersByPage: proj.piersByPage ?? {},
        }
        // Brick walls used to be saved with makeupId === '' because they
        // had no per-wall type. Now they reference a BrickMakeup the same way
        // block walls reference a WallMakeup. Migrate on load: hydrate the
        // saved brickMakeups (or fall back to the defaults), then rewrite
        // any wall.makeupId === '' to the default brick makeup so the calc
        // engine + selection UI find a real makeup. Block walls are unaffected.
        const hydratedBrickMakeups =
          proj.brickMakeups && proj.brickMakeups.length > 0
            ? proj.brickMakeups
            : createDefaultBrickMakeups()
        const defaultBrickMakeupId = hydratedBrickMakeups[0]?.id ?? ''
        setBrickMakeups(hydratedBrickMakeups)
        setActiveBrickMakeupId(proj.activeBrickMakeupId ?? defaultBrickMakeupId)
        const migratedWallsByPage = proj.type === 'brick'
          ? migrateBrickWalls(proj.wallsByPage, defaultBrickMakeupId)
          : proj.wallsByPage
        setWallsByPage(migratedWallsByPage)
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
        if (proj.blockExportInclusions) {
          // Merge with defaults so projects saved before a new inclusion
          // toggle was added still get the new section (defaulted on). Without
          // this an older project loads with the new toggle = undefined →
          // falsy, and the section silently vanishes.
          setBlockExportInclusions({
            ...createDefaultBlockExportInclusions(),
            ...proj.blockExportInclusions,
          })
        }

        setCurrentProjectId(proj.id)
        setProjectOrganisationId(proj.organisationId ?? null)
        setProjectStatus(proj.status)
        setProjectOutcome(proj.outcome)
        setProjectCreatedAt(proj.createdAt)
        setProjectCompletedAt(proj.completedAt ?? null)
        setLastSavedAt(proj.updatedAt)
        // Loading a project resets the dirty baseline — fresh open means
        // nothing's been edited yet, so Save changes should be greyed out.
        // The snapshot effect will seed the ref from the loaded state on
        // its next pass (because we just nulled it here).
        savedSnapshotRef.current = null
        setHasUnsavedChanges(false)
      })
      .catch((err) => {
        console.error('Failed to load project', err)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

  // Tracks whether the in-memory project differs from the last-saved (or
  // last-loaded) state. Set true by the useEffect below whenever any key
  // state reference changes, set false after a save/load.
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false)
  /**
   * Snapshot of the key state references at the last load/save. We compare by
   * reference because every state setter we use returns a fresh object/array
   * via `(prev) => ...`, so any real edit changes a reference. Storing the
   * snapshot in a ref keeps the comparison effect from looping.
   */
  const savedSnapshotRef = useRef<{
    walls: typeof wallsByPage
    openings: typeof openingsByPage
    piers: typeof piersByPage
    makeups: typeof makeups
    pierMakeups: typeof pierMakeups
    details: typeof projectDetails
    brick: typeof brickSettings
    brickMakeups: typeof brickMakeups
  } | null>(null)

  /**
   * In-flight save guard. Both handleSaveProject and handleToggleProjectStatus
   * generate a fresh UUID if currentProjectId is null. setCurrentProjectId
   * only commits AFTER the awaited save returns, so two clicks in quick
   * succession both see `null` and both generate a fresh UUID — resulting in
   * two separate rows in `projects` for what should be one project. Using a
   * ref (synchronously updated, no React re-render lag) plus stashing the
   * just-generated id in another ref so subsequent invocations reuse it
   * even before state has committed.
   */
  const savingRef = useRef(false)
  const inFlightProjectIdRef = useRef<string | null>(null)

  useEffect(() => {
    const current = {
      walls: wallsByPage,
      openings: openingsByPage,
      piers: piersByPage,
      makeups,
      pierMakeups,
      details: projectDetails,
      brick: brickSettings,
      brickMakeups,
    }
    if (!savedSnapshotRef.current) {
      // First render — seed the snapshot so the very first effect run doesn't
      // mark the project dirty before anyone's touched it.
      savedSnapshotRef.current = current
      return
    }
    const snap = savedSnapshotRef.current
    const dirty =
      current.walls !== snap.walls ||
      current.openings !== snap.openings ||
      current.piers !== snap.piers ||
      current.makeups !== snap.makeups ||
      current.pierMakeups !== snap.pierMakeups ||
      current.details !== snap.details ||
      current.brick !== snap.brick ||
      current.brickMakeups !== snap.brickMakeups
    if (dirty !== hasUnsavedChanges) setHasUnsavedChanges(dirty)
  }, [
    wallsByPage,
    openingsByPage,
    piersByPage,
    makeups,
    pierMakeups,
    projectDetails,
    brickSettings,
    brickMakeups,
    hasUnsavedChanges,
  ])

  // Reasons save might be blocked, evaluated each render. A PDF is NO LONGER required —
  // users can save a project with just a name (and pre-configured wall / pier types),
  // then upload the PDF later. For projects that have been saved at least once we ALSO
  // require unsaved changes — no point pretending the button does something when it
  // would just rewrite the same data.
  const saveBlockedReason = useMemo<string | null>(() => {
    if (!projectDetails.projectName.trim() && !projectDetails.siteAddress.trim()) {
      return 'Fill in a project name or site address in Project details before saving.'
    }
    if (currentProjectId !== null && !hasUnsavedChanges) {
      return 'No unsaved changes.'
    }
    return null
  }, [
    projectDetails.projectName,
    projectDetails.siteAddress,
    currentProjectId,
    hasUnsavedChanges,
  ])
  const canSave = saveBlockedReason === null

  async function handleSaveProject() {
    if (!mode) return
    // Re-entrance guard: if a previous save is still awaiting, drop this
    // call. Without this, rapid double-clicks on Save (or Save + autosave
    // racing) generate fresh UUIDs each time and insert duplicate rows.
    if (savingRef.current) return
    savingRef.current = true
    const now = new Date().toISOString()
    // Resolve the project id in priority order:
    //   1. The id from React state (committed by a previous save).
    //   2. The id from this hook's in-flight ref (generated by a save that
    //      hasn't returned yet — guards against concurrent generation).
    //   3. A fresh UUID — and stash it on the ref synchronously so any
    //      handler that fires before this await resolves picks it up.
    let id = currentProjectId ?? inFlightProjectIdRef.current
    if (!id) {
      id = generateProjectId()
      inFlightProjectIdRef.current = id
    }
    // Use the project's existing org link if it has one (loaded from cloud),
    // otherwise stamp the current org context. Means a project created from
    // a fresh '+ Brick estimate' click while signed into an org gets shared
    // with the team automatically — no manual SQL update afterwards. Null
    // means truly personal, which is the right outcome for users not in any
    // org or who explicitly want a private project.
    const organisationId = projectOrganisationId ?? getCurrentOrgId() ?? undefined
    const project: SavedProject = {
      id,
      type: mode,
      status: projectStatus,
      organisationId,
      createdAt: projectCreatedAt ?? now,
      updatedAt: now,
      completedAt: projectCompletedAt ?? undefined,
      outcome: projectOutcome,
      projectDetails,
      // pdfBlob + pdfFileName are optional now — a project can be saved without a PDF
      ...(pdfFile ? { pdfBlob: pdfFile, pdfFileName: pdfFile.name } : {}),
      // Empty-workspace projects skip the PDF entirely; persist the flag so a
      // reload lands back on the canvas instead of bouncing to the upload zone.
      ...(isEmptyWorkspace ? { emptyWorkspace: true } : {}),
      // Carry reference PDFs through every save so the cloud-storage layer
      // knows about new ones (no path yet → upload) and skips reuploads for
      // ones that haven't changed (path already set).
      ...(referencePdfFiles.length > 0
        ? {
            referencePdfs: referencePdfFiles.map((f, i) => ({
              fileName: f.name,
              blob: f,
              path: referencePdfPaths[i],
            })),
          }
        : {}),
      pagesData,
      wallsByPage,
      openingsByPage,
      piersByPage,
      currentPage,
      ...(mode === 'block'
        ? { makeups, activeMakeupId, blockExportInclusions, pierMakeups }
        : {}),
      ...(mode === 'brick'
        ? {
            brickSettings,
            brickMakeups,
            activeBrickMakeupId,
            exportInclusions,
          }
        : {}),
    }
    try {
      await saveProjectToStore(project)
      setCurrentProjectId(id)
      setProjectOrganisationId(organisationId ?? null)
      setProjectCreatedAt(project.createdAt)
      setLastSavedAt(now)
      // Refresh the dirty-state baseline so the Save changes button greys
      // out until the user actually edits something next.
      savedSnapshotRef.current = {
        walls: wallsByPage,
        openings: openingsByPage,
        piers: piersByPage,
        makeups,
        pierMakeups,
        details: projectDetails,
        brick: brickSettings,
        brickMakeups,
      }
      setHasUnsavedChanges(false)
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
    } finally {
      // Release the guards regardless of outcome — a failed save should
      // still allow the user to retry. The in-flight id ref stays set on
      // success (currentProjectId state will catch up) and gets cleared
      // here only on success to avoid a stale id surviving across failed
      // retries; on success the state version takes over anyway.
      savingRef.current = false
      inFlightProjectIdRef.current = null
    }
  }

  // ---------- Autosave ----------
  //
  // Persist every 2 minutes while there are unsaved changes and the project
  // is in a saveable state. We keep refs to the latest handler + flags so the
  // interval (set up once) always reads the current version, avoiding stale
  // closures over projectDetails / walls / etc.
  const autosaveHandlerRef = useRef(handleSaveProject)
  const autosaveCanSaveRef = useRef(false)
  const autosaveDirtyRef = useRef(false)
  const autosaveGateRef = useRef(false)
  useEffect(() => {
    autosaveHandlerRef.current = handleSaveProject
    autosaveCanSaveRef.current = canSave
    autosaveDirtyRef.current = hasUnsavedChanges
    autosaveGateRef.current = startupGateOpen
  })
  useEffect(() => {
    const AUTOSAVE_INTERVAL_MS = 2 * 60 * 1000
    const id = window.setInterval(() => {
      // Belt-and-braces: dirty + canSave guard each tick. If the project
      // has no unsaved changes (idle workspace) we skip, so we don't grind
      // through identical-content writes. canSave guards the same "name is
      // required" rule the manual save uses. Gate-open means the user is
      // still in the startup modal — autosaving a project that has nothing
      // but a name in it isn't useful, so we hold off until they enter the
      // workspace proper.
      if (autosaveGateRef.current) return
      if (!autosaveDirtyRef.current) return
      if (!autosaveCanSaveRef.current) return
      if (savingRef.current) return
      void autosaveHandlerRef.current()
    }, AUTOSAVE_INTERVAL_MS)
    return () => window.clearInterval(id)
  }, [])

  async function handleToggleProjectStatus() {
    if (!currentProjectId) return
    const now = new Date().toISOString()
    const nextStatus: ProjectStatus =
      projectStatus === 'completed' ? 'in-progress' : 'completed'
    setProjectStatus(nextStatus)
    if (nextStatus === 'completed') setProjectCompletedAt(now)
    // Persist immediately. PDF is optional now.
    if (mode) {
      // Same org-id rule as handleSaveProject — preserve any existing link
      // or stamp the current org for brand-new projects flipping status.
      const organisationId = projectOrganisationId ?? getCurrentOrgId() ?? undefined
      const project: SavedProject = {
        id: currentProjectId,
        type: mode,
        status: nextStatus,
        organisationId,
        createdAt: projectCreatedAt ?? now,
        updatedAt: now,
        completedAt: nextStatus === 'completed' ? now : projectCompletedAt ?? undefined,
        outcome: projectOutcome,
        projectDetails,
        ...(pdfFile ? { pdfBlob: pdfFile, pdfFileName: pdfFile.name } : {}),
        ...(isEmptyWorkspace ? { emptyWorkspace: true } : {}),
      // Carry reference PDFs through every save so the cloud-storage layer
      // knows about new ones (no path yet → upload) and skips reuploads for
      // ones that haven't changed (path already set).
      ...(referencePdfFiles.length > 0
        ? {
            referencePdfs: referencePdfFiles.map((f, i) => ({
              fileName: f.name,
              blob: f,
              path: referencePdfPaths[i],
            })),
          }
        : {}),
        pagesData,
        wallsByPage,
        openingsByPage,
        piersByPage,
        currentPage,
        ...(mode === 'block' ? { makeups, activeMakeupId, pierMakeups } : {}),
        ...(mode === 'brick'
          ? { brickSettings, brickMakeups, activeBrickMakeupId, exportInclusions }
          : {}),
      }
      try {
        await saveProjectToStore(project)
        setLastSavedAt(now)
      } catch (err) {
        console.error('Failed to update project status', err)
      }
      // If this project came from an estimate request, propagate the status
      // change up to the request so the Recently Completed band on the
      // dashboard (which lists completed requests) sees it. Without this,
      // marking a project complete from the workspace left the originating
      // request stuck at 'in_progress' forever.
      if (sourceRequest) {
        try {
          await updateEstimateRequest(
            sourceRequest.id,
            nextStatus === 'completed'
              ? { status: 'completed', completedAt: now }
              : { status: 'in_progress', completedAt: null }
          )
        } catch (err) {
          // Surfaced via console; not load-blocking — the project status
          // is already saved at this point and the request can be flipped
          // manually if the propagation fails.
          console.error('Failed to propagate status to estimate request', err)
        }
      }
    }
  }

  // Stable callbacks for WallDrawingLayer — wrapped in useCallback with empty deps so
  // their reference doesn't change every render. Combined with WallDrawingLayer being
  // memoised, this means the wall overlay doesn't re-render on every wheel-zoom tick.
  const handleWallSelect = useCallback((id: string | null) => {
    setSelectedWallId(id)
    if (id) {
      setSelectedOpeningId(null)
      // Surface the selected wall's makeup in the Wall types panel so the
      // user can see at a glance which type the wall belongs to (and tweak
      // it in place). Looks the wall up across every page since the
      // selection-id callback doesn't carry the page index.
      let foundMakeupId: string | undefined
      for (const ws of Object.values(wallsByPage)) {
        const w = ws.find((x) => x.id === id)
        if (w) {
          foundMakeupId = w.makeupId
          break
        }
      }
      if (foundMakeupId) {
        if (mode === 'brick') setActiveBrickMakeupId(foundMakeupId)
        else setActiveMakeupId(foundMakeupId)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallsByPage, mode])
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
    setPlacingRuler(false)
    setRulerAnchorMm(null)
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

  // If the user switches to a curve-bound makeup mid-draw, cancel the
  // straight-wall draw — curve makeups aren't valid for the regular Draw
  // wall tool, and leaving the tool live would let a stray click create a
  // straight wall against the curve makeup.
  useEffect(() => {
    if (mode !== 'block') return
    const active = makeupsById[activeMakeupId]
    if (active && typeof active.curveRadiusMm === 'number') {
      if (drawingMode) setDrawingMode(false)
    }
  }, [activeMakeupId, makeupsById, mode, drawingMode])

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

  /** Brick makeups keyed by id. Used by the calc engine + the wall-rendering
   *  layer to resolve wall.heightMmOverride defaults and per-wall brick types. */
  const brickMakeupsById = useMemo(() => {
    const map: Record<string, BrickMakeup> = {}
    for (const m of brickMakeups) map[m.id] = m
    return map
  }, [brickMakeups])

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

  // Per-wall colour from the wall-type palette. Brick walls (no makeupId) get
  // the brand orange fallback. The canvas reads this to colour each wall's
  // body so users can tell types apart at a glance; the WallTypesPanel reads
  // the same helper directly for the swatches in its list.
  const wallColorByWallId = useMemo(() => {
    const map: Record<string, string> = {}
    // Pick the right makeup list for the active mode — block walls colour by
    // WallMakeup, brick walls colour by BrickMakeup. Without this brick walls
    // all fell back to the placeholder orange because their makeupId never
    // appeared in the block `makeups` list.
    const palette = mode === 'brick' ? brickMakeups : makeups
    for (const w of allWalls) {
      map[w.id] = w.makeupId ? wallTypeColor(w.makeupId, palette) : '#ED7D31'
    }
    return map
  }, [allWalls, makeups, brickMakeups, mode])

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
    // Belt-and-braces: a curve makeup is bound to a specific arc geometry —
    // drawing a straight wall against it would produce a 20.03CW wall with no
    // radius, which the calc engine can't tally meaningfully. The UI also
    // disables the Draw wall button when this is the case (see the wall-draw
    // toolbar below), but a stale keyboard shortcut or a quick double-click
    // could still get through, so we guard at the action level too.
    if (!isBrick) {
      const active = makeupsById[activeMakeupId]
      if (active && typeof active.curveRadiusMm === 'number') {
        return
      }
    }
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

    // Resolve the new wall's makeup id + initial height override based on mode.
    // Brick walls now reference a BrickMakeup the same way block walls reference
    // a WallMakeup, and inherit the active makeup's height as the wall's initial
    // override so per-makeup heights actually apply at draw time. Falls back to
    // brickSettings.defaultWallHeightMm if no active brick makeup exists yet
    // (eg. older projects that still need to be migrated).
    const activeBrickMakeup = brickMakeupsById[activeBrickMakeupId]
    const rawWall: Wall = {
      id:
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `w-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      makeupId: isBrick ? activeBrickMakeupId : activeMakeupId,
      startX: snappedStart.x,
      startY: snappedStart.y,
      endX: snappedEnd.x,
      endY: snappedEnd.y,
      startJunction: { type: 'free' },
      endJunction: { type: 'free' },
      heightMmOverride: isBrick
        ? activeBrickMakeup?.heightMm ?? brickSettings.defaultWallHeightMm
        : undefined,
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
  }, [
    wallsByPage,
    currentPage,
    makeupsById,
    mode,
    brickSettings,
    activeMakeupId,
    activeBrickMakeupId,
    brickMakeupsById,
  ])

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

    // Pick a body block based on the curve's radius so the user doesn't have
    // to think about it: tight radii get the wedge (20.03CW), mid radii get
    // standard body with a cut allowance noted in assumptions, large radii
    // get plain standard body. The same threshold logic is used by the calc
    // engine downstream — we're just pre-stamping the makeup so the user
    // sees the right block in the Wall Types panel from the moment they
    // draw the curve.
    const geom = arcFromThreePoints(startMm, midMm, endMm)
    const radiusMm = geom?.radiusMm ?? Infinity
    const zone = isFinite(radiusMm) ? curveZoneForRadius(radiusMm) : 'standard'
    // 'standard' (R ≥ 6000mm): plain 20.48, no cuts.
    // 'cut' (1500-6000mm): 20.48 with rear-corner cuts (noted in assumptions).
    // 'wedge' (665-1500mm): 20.03CW wedge.
    // 'custom' (< 665mm): wedge is closest stock; calc-engine + assumptions
    //    flag that custom blocks are really needed.
    const bodyBlock = zone === 'wedge' || zone === 'custom' ? '20.03CW' : '20.48'
    const radiusLabel = isFinite(radiusMm)
      ? `R${Math.round(radiusMm)}mm`
      : 'straight-ish'

    // Auto-create a wall type for this curve. Each curve gets its own
    // makeup so the user can rename it / set a specific height in the
    // Wall Types panel without affecting other curves. Default height
    // 2400mm — the user can override per-curve via the wall's
    // heightMmOverride or by editing the makeup.
    const curveMakeup = createDefaultWallMakeup({
      name: `Curved wall — ${radiusLabel}`,
      heightMm: 2400,
    })
    curveMakeup.bodyBlockCode = bodyBlock
    // Stamp the radius so the Wall Types panel can render the dual
    // wedge / normal-block composition UI for this makeup and pick
    // the right section to enable based on the curve's zone.
    if (isFinite(radiusMm)) {
      curveMakeup.curveRadiusMm = radiusMm
    }

    const rawWall: Wall = {
      id:
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `w-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      makeupId: curveMakeup.id,
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
    // Add the makeup BEFORE adding the wall so the wall's makeupId always
    // resolves to a real row, even if React batches the two state writes.
    const nextMakeups = [...makeups, curveMakeup]
    const nextMakeupsById = { ...makeupsById, [curveMakeup.id]: curveMakeup }
    setMakeups(nextMakeups)
    const existing = wallsByPage[currentPage] ?? []
    const newWalls = [...existing, rawWall]
    const thicknesses = computeWallThicknessByWallId(newWalls, nextMakeupsById, mode, brickSettings.brickTypeCode)
    const recomputed = recomputeAllJunctions(newWalls, thicknesses)
    setWallsByPage((prev) => ({ ...prev, [currentPage]: recomputed }))
  }, [mode, wallsByPage, currentPage, makeups, makeupsById, brickSettings])

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

  /**
   * Setting a wall type active just sets the active makeup id — nothing
   * else. The earlier behaviour also multi-selected every wall of the type
   * on the current page, but that promoted the toolbar into multi-select
   * mode (Reassign / Delete all) every time the user just wanted to pick
   * the type they were about to draw with. Now activation is purely a
   * "what type will I draw next" toggle and doesn't touch the selection.
   */
  function handleActivateMakeup(id: string) {
    setActiveMakeupId(id)
  }

  // ---------- Brick makeup CRUD ----------

  function handleAddBrickMakeup(makeup: BrickMakeup) {
    setBrickMakeups((prev) => [...prev, makeup])
    setActiveBrickMakeupId(makeup.id)
  }

  function handleUpdateBrickMakeup(updated: BrickMakeup) {
    setBrickMakeups((prev) => prev.map((m) => (m.id === updated.id ? updated : m)))
  }

  function handleDeleteBrickMakeup(id: string) {
    setBrickMakeups((prev) => {
      const remaining = prev.filter((m) => m.id !== id)
      if (remaining.length === 0) return prev
      if (activeBrickMakeupId === id) setActiveBrickMakeupId(remaining[0].id)
      return remaining
    })
  }

  /**
   * Same "click a brick wall type to select all walls of that type" affordance
   * as block. Sets active for newly-drawn walls AND lights up matching walls
   * on the current page so the user sees the mapping at a glance.
   */
  function handleActivateBrickMakeup(id: string) {
    setActiveBrickMakeupId(id)
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

  // ---------- Ruler / measurement handlers ----------

  /**
   * Called by the canvas on a measurement click. First call sets the anchor;
   * second call commits a measurement and clears the anchor (ready for the
   * next one). Stays in ruler mode after each commit so the user can drop
   * multiple measurements in a row without re-clicking the tool button.
   */
  const handleRulerClick = useCallback(function handleRulerClick(posMm: { x: number; y: number }) {
    setRulerAnchorMm((prev) => {
      if (prev === null) return posMm
      // Commit a new measurement and clear the anchor.
      const newId =
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `m-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      setMeasurementsByPage((all) => {
        const page = all[currentPage] ?? []
        return {
          ...all,
          [currentPage]: [...page, { id: newId, startMm: prev, endMm: posMm }],
        }
      })
      return null
    })
  }, [currentPage])

  function handleClearMeasurements() {
    setMeasurementsByPage((all) => ({ ...all, [currentPage]: [] }))
    setRulerAnchorMm(null)
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

  /**
   * Drop every wall, opening, and pier on the given PDF page so a stale
   * earlier-attempt page can be cleared from the project (e.g. user
   * re-imported the plan but the previous attempt's walls were left
   * behind on an old page). Wall types stay in the project — they're a
   * library-level concern and might still be in use on other pages.
   * Selection clears if it was pointing into the page being cleared.
   */
  function handleClearPage(pageNum: number) {
    setWallsByPage((prev) => {
      if (!prev[pageNum] || prev[pageNum].length === 0) return prev
      const next = { ...prev }
      next[pageNum] = []
      return next
    })
    setOpeningsByPage((prev) => {
      if (!prev[pageNum] || prev[pageNum].length === 0) return prev
      const next = { ...prev }
      next[pageNum] = []
      return next
    })
    setPiersByPage((prev) => {
      if (!prev[pageNum] || prev[pageNum].length === 0) return prev
      const next = { ...prev }
      next[pageNum] = []
      return next
    })
    // Clear selection if the user had something selected on the page they
    // just wiped, since those ids no longer point at anything.
    if (currentPage === pageNum) {
      _setSelectedWallIds(new Set())
      _setSelectedOpeningIds(new Set())
      _setSelectedPierIds(new Set())
    }
  }

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

  // Auto-snapshot effect: every time wallsByPage / openingsByPage / piersByPage
  // change, push the PREVIOUS values onto the undo stack and clear the redo
  // stack. Compares by reference — React always returns a fresh object/array
  // from setState callbacks (we use `(prev) => ...` everywhere) so a true edit
  // shows up as a new reference. Restorations from undo/redo update the ref
  // before the state setters fire, so this effect sees "no change" and skips
  // the push.
  useEffect(() => {
    const current: EditSnapshot = {
      wallsByPage,
      openingsByPage,
      piersByPage,
    }
    const prev = lastEditSnapshotRef.current
    if (!prev) {
      lastEditSnapshotRef.current = current
      return
    }
    if (
      prev.wallsByPage === current.wallsByPage &&
      prev.openingsByPage === current.openingsByPage &&
      prev.piersByPage === current.piersByPage
    ) {
      return
    }
    setUndoStack((stack) => {
      const next = [...stack, prev]
      // Trim from the front so the oldest snapshots fall off.
      return next.length > UNDO_LIMIT ? next.slice(next.length - UNDO_LIMIT) : next
    })
    setRedoStack([])
    lastEditSnapshotRef.current = current
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallsByPage, openingsByPage, piersByPage])

  function performUndo() {
    if (undoStack.length === 0) return
    const restore = undoStack[undoStack.length - 1]
    const current: EditSnapshot = { wallsByPage, openingsByPage, piersByPage }
    setRedoStack((s) => [...s, current])
    setUndoStack((s) => s.slice(0, -1))
    // Update the ref BEFORE the state setters so the auto-snapshot effect's
    // next pass sees the new state == ref and skips re-pushing onto undo.
    lastEditSnapshotRef.current = restore
    setWallsByPage(restore.wallsByPage)
    setOpeningsByPage(restore.openingsByPage)
    setPiersByPage(restore.piersByPage)
  }

  function performRedo() {
    if (redoStack.length === 0) return
    const restore = redoStack[redoStack.length - 1]
    const current: EditSnapshot = { wallsByPage, openingsByPage, piersByPage }
    setUndoStack((s) => [...s, current])
    setRedoStack((s) => s.slice(0, -1))
    lastEditSnapshotRef.current = restore
    setWallsByPage(restore.wallsByPage)
    setOpeningsByPage(restore.openingsByPage)
    setPiersByPage(restore.piersByPage)
  }

  // Ctrl+Z = undo, Ctrl+Y or Ctrl+Shift+Z = redo. Mac uses Cmd. Suppressed
  // while typing in inputs so we don't fight the browser's text-field undo.
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      const tgt = e.target as HTMLElement | null
      if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' || tgt.isContentEditable)) return
      const isCmd = e.ctrlKey || e.metaKey
      if (!isCmd) return
      const k = e.key.toLowerCase()
      if (k === 'z' && !e.shiftKey) {
        e.preventDefault()
        performUndo()
      } else if ((k === 'z' && e.shiftKey) || k === 'y') {
        e.preventDefault()
        performRedo()
      }
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [undoStack, redoStack, wallsByPage, openingsByPage, piersByPage])

  // Help-overlay state used by the keyboard-shortcut effect (registered later
  // after currentScale + calibrating have been declared — TS const declarations
  // are in a temporal dead zone here so the effect can't reference them yet).
  const [showShortcutHelp, setShowShortcutHelp] = useState(false)

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
  /**
   * Tracks whether we've already auto-fit zoom for the current PDF file. The
   * first time a PDF's first page reports its intrinsic dimensions we compute
   * the largest zoom that fits the page in the visible canvas and apply it,
   * so the user lands on the biggest possible view of their plan instead of
   * a stamp-sized 100% rendering inside a vast canvas. Reset to false when
   * the PDF file changes (or empty workspace mode is entered).
   */
  const hasAutoFitRef = useRef(false)
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
  /**
   * Ref on the page wrapper div (the element whose explicit width/height
   * holds the page's visual dimensions at the current zoom). Read in the
   * wheel-zoom handler to query the page's real DOM position via
   * getBoundingClientRect, instead of trying to derive it from flex +
   * padding + min-width math — those interactions don't always match the
   * mental model when zoom changes the page size across the centring
   * threshold, which caused the cursor to drift mid-zoom.
   */
  const pageWrapperRef = useRef<HTMLDivElement>(null)
  const sidebarRef = useRef<HTMLDivElement>(null)
  /**
   * Cursor anchor for wheel zoom — stores the world-space (zoom-independent)
   * coordinates of the cursor at wheel time and the cursor's viewport
   * position. The layout effect that fires after the zoom commits reads
   * this and adjusts scrollLeft/scrollTop so that the same world point
   * lands back under the cursor.
   */
  const zoomAnchorRef = useRef<{
    cursorClientX: number
    cursorClientY: number
    worldX: number
    worldY: number
  } | null>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const zoomRef = useRef(zoom)

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

  // Single-letter shortcuts to flip into/out of the drawing modes — saves a
  // round trip to the toolbar every time the user starts another wall or
  // opening. Has to live AFTER currentScale and calibrating are declared
  // because the deps array reads both. Suppressed while focus is in any
  // input/textarea so a wall type name with the letter "w" doesn't trigger
  // Draw mode. Ctrl/Meta/Alt combos pass through so browser shortcuts still
  // work.
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.ctrlKey || e.metaKey || e.altKey) return
      const tgt = e.target as HTMLElement | null
      if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' || tgt.isContentEditable)) return
      if (!(mode === 'block' || mode === 'brick')) return
      function clearOtherModes() {
        setDrawingMode(false)
        setDrawingCurveMode(false)
        setPlacingOpening(false)
        setPlacingControlJoint(false)
        setPlacingTiedPier(false)
        setPlacingFreestandingPier(false)
        setPlacingRuler(false)
        setRulerAnchorMm(null)
        setSelectedWallId(null)
        setSelectedOpeningId(null)
        setSelectedPierId(null)
      }
      const k = e.key.toLowerCase()
      if (k === 'w') {
        if (!currentScale || calibrating) return
        if (mode === 'block') {
          const activeMakeup = makeupsById[activeMakeupId]
          if (!activeMakeup) return
        }
        e.preventDefault()
        const next = !drawingMode
        clearOtherModes()
        setDrawingMode(next)
      } else if (k === 'o') {
        if (!currentScale || calibrating || currentPageWalls.length === 0) return
        e.preventDefault()
        const next = !placingOpening
        clearOtherModes()
        setPlacingOpening(next)
      } else if (k === 'c' && mode === 'block') {
        if (!currentScale || calibrating || currentPageWalls.length < 2) return
        const activeMakeup = makeupsById[activeMakeupId]
        if (!activeMakeup) return
        e.preventDefault()
        const next = !drawingCurveMode
        clearOtherModes()
        setDrawingCurveMode(next)
      } else if (k === 'j' && mode === 'block') {
        if (!currentScale || calibrating || currentPageWalls.length === 0) return
        e.preventDefault()
        const next = !placingControlJoint
        clearOtherModes()
        setPlacingControlJoint(next)
      } else if (k === 'p' && mode === 'block') {
        if (!currentScale || calibrating) return
        e.preventDefault()
        const next = !placingFreestandingPier
        clearOtherModes()
        setPlacingFreestandingPier(next)
      } else if (k === 'r') {
        // Ruler works in any mode as long as we have a scale to convert
        // pixels → real-world mm.
        if (!currentScale || calibrating) return
        e.preventDefault()
        const next = !placingRuler
        clearOtherModes()
        setPlacingRuler(next)
      } else if (k === '?') {
        e.preventDefault()
        setShowShortcutHelp((v) => !v)
      }
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [
    mode,
    drawingMode,
    drawingCurveMode,
    placingOpening,
    placingControlJoint,
    placingFreestandingPier,
    currentScale,
    calibrating,
    currentPageWalls.length,
    activeMakeupId,
    makeupsById,
  ])

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

  // Reset the auto-fit guard whenever the displayed PDF or workspace mode
  // changes — opening a new file or flipping into empty-workspace mode is a
  // fresh "first view" and deserves another fit-to-canvas.
  useEffect(() => {
    hasAutoFitRef.current = false
  }, [pdfFile, isEmptyWorkspace])

  // Auto-fit zoom on first render after page dimensions are known. We watch
  // aspectRatio (and the container ref's measured size via a microtask after
  // layout) and apply the largest zoom that fits the page in the visible
  // canvas. Runs exactly once per PDF load so the user can manually zoom and
  // it won't snap back.
  useEffect(() => {
    if (hasAutoFitRef.current) return
    if (!aspectRatio) return
    // Wait one frame for the container to lay out; clientWidth/Height are
    // 0 if we measure synchronously inside the render that creates them.
    const raf = requestAnimationFrame(() => {
      const fit = computeFitZoom()
      if (fit !== null) {
        hasAutoFitRef.current = true
        setZoom(fit)
      }
    })
    return () => cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aspectRatio, pdfFile, isEmptyWorkspace])

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

      // Zoom-to-cursor: anchor the page point under the cursor so it stays
      // there after the zoom. We do this by reading the page wrapper's
      // ACTUAL DOM position (via getBoundingClientRect) instead of trying
      // to derive it from flex / padding / min-width math. Layout
      // interactions across the centring threshold (small page vs large
      // page) were causing the previous closed-form math to drift; reading
      // the DOM is robust to any layout the browser actually computed.
      //
      // Steps:
      //   1. Capture the cursor's WORLD position over the page (in the
      //      zoom-independent baseWidth units) at the current zoom.
      //   2. Stash that anchor plus the cursor's viewport position.
      //   3. Bump zoom state.
      //   4. After the new zoom commits and the page wrapper resizes
      //      (handled in the layout effect on [zoom]), measure where the
      //      same world point is now and shift scroll so the cursor and
      //      that point realign.
      const pageEl = pageWrapperRef.current
      if (!pageEl) {
        // Page wrapper not mounted (upload zone, etc.) — just apply zoom
        // without anchoring.
        zoomRef.current = newZoom
        setZoom(newZoom)
        return
      }
      const pageRect = pageEl.getBoundingClientRect()
      // Cursor offset from page-start in visual pixels at the current zoom.
      const cursorOnPageVisualX = pendingClientX - pageRect.left
      const cursorOnPageVisualY = pendingClientY - pageRect.top
      // Convert to world (base) units so the anchor is zoom-independent.
      // oldZoom can't be zero (clamped to MIN_ZOOM > 0).
      const worldX = cursorOnPageVisualX / oldZoom
      const worldY = cursorOnPageVisualY / oldZoom

      zoomAnchorRef.current = {
        cursorClientX: pendingClientX,
        cursorClientY: pendingClientY,
        worldX,
        worldY,
      }

      // Synchronously bump the zoom ref so the NEXT wheel tick (which might
      // fire before React commits this update) reads our new zoom, not the
      // stale committed one.
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
  }, [pdfFile, baseWidth, aspectRatio])

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
        // Apply the grabbing class to the whole container so all descendants
        // (Konva stage, PDF canvas) show the hand cursor regardless of their
        // own cursor style. See .beme-pan-active in src/index.css.
        containerRef.current.classList.add('beme-pan-active')
      }

      containerRef.current.scrollLeft = start.scrollLeft - dx
      containerRef.current.scrollTop = start.scrollTop - dy
    }

    const handleDocMouseUp = (e: MouseEvent) => {
      if (isPanningRef.current) {
        isPanningRef.current = false
        if (containerRef.current) {
          containerRef.current.classList.remove('beme-pan-active')
        }
      }
      // Right-click never fires a 'click' event for the capture-phase
      // listener to swallow, so clear the pan-during-press flag here on a
      // right-mouseup — otherwise the next left-click after a right-drag
      // pan would get swallowed by handleContainerClickCapture.
      if (e.button === 2) {
        didPanDuringPressRef.current = false
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

    // Suppress the browser's right-click context menu over the canvas so
    // right-drag pan can use button 2 without a menu popping up underneath.
    // We let the menu through on container chrome by scoping to the
    // container element itself (the menu only appears in workspace areas
    // anyway, since right-click on UI buttons isn't typical).
    const handleContextMenu = (e: MouseEvent) => {
      e.preventDefault()
    }

    document.addEventListener('mousemove', handleDocMouseMove)
    document.addEventListener('mouseup', handleDocMouseUp)
    container.addEventListener('click', handleContainerClickCapture, { capture: true })
    container.addEventListener('contextmenu', handleContextMenu)
    return () => {
      document.removeEventListener('mousemove', handleDocMouseMove)
      document.removeEventListener('mouseup', handleDocMouseUp)
      container.removeEventListener('click', handleContainerClickCapture, { capture: true })
      container.removeEventListener('contextmenu', handleContextMenu)
    }
  }, [pdfFile])

  function handlePanMouseDown(e: React.MouseEvent<HTMLDivElement>) {
    // Left-click pans only when no draw tool is grabbing it — we record the
    // start and let the cursor-move threshold differentiate click vs drag.
    // Right-click ALWAYS pans regardless of which tool is active, so the
    // user can move around the canvas while still holding the Draw wall /
    // Opening / Calibrate tool. We swallow the default contextmenu (the
    // contextmenu listener below) so right-drag isn't fighting with the
    // browser's right-click menu.
    if (e.button !== 0 && e.button !== 2) return
    const container = containerRef.current
    if (!container) return

    // Reset pan-during-press flag for this new mouse press.
    didPanDuringPressRef.current = false

    // For right-button drags, immediately mark the gesture as a pan so even a
    // single-pixel jiggle doesn't fall through to Konva. For left-button we
    // still want the click-vs-drag threshold so a regular click can place a
    // wall point. The threshold check itself lives in handleDocMouseMove.
    if (e.button === 2) {
      didPanDuringPressRef.current = true
      isPanningRef.current = true
      // Show the closed-hand cursor immediately so the user sees the
      // distinction between "tool place" and "pan" the moment they press
      // the right button — even before they've moved the cursor.
      container.classList.add('beme-pan-active')
    }

    panStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      scrollLeft: container.scrollLeft,
      scrollTop: container.scrollTop,
    }
  }

  // Apply cursor-anchored zoom: after the new zoom commits, read where the
  // anchored world point IS NOW and shift scroll so that point lands back
  // under the cursor. The wheel handler stashes the anchor (cursor position
  // + world coords), this effect reconciles the scroll position after
  // layout has updated.
  //
  // We also depend on renderedZoom: 300 ms after the user stops scrolling,
  // renderedZoom debounces to match zoom and the PDF re-rasterises at the
  // new resolution. That re-raster can nudge the page wrapper's position by
  // a sub-pixel amount due to canvas rendering — small but visible as a
  // post-freeze "jump". Re-applying the anchor on renderedZoom transitions
  // keeps the cursor's world point pinned across that re-raster too. The
  // anchor is consumed only after the FINAL pass (renderedZoom = zoom) so
  // it survives the in-between render where zoom has changed but
  // renderedZoom is still catching up.
  useLayoutEffect(() => {
    const anchor = zoomAnchorRef.current
    const container = containerRef.current
    const pageEl = pageWrapperRef.current
    if (!anchor || !container || !pageEl) return
    const pageRect = pageEl.getBoundingClientRect()
    const currentWorldVisualLeft = pageRect.left + anchor.worldX * zoom
    const currentWorldVisualTop = pageRect.top + anchor.worldY * zoom
    const deltaX = currentWorldVisualLeft - anchor.cursorClientX
    const deltaY = currentWorldVisualTop - anchor.cursorClientY
    const targetLeft = container.scrollLeft + deltaX
    const targetTop = container.scrollTop + deltaY
    const maxLeft = Math.max(0, container.scrollWidth - container.clientWidth)
    const maxTop = Math.max(0, container.scrollHeight - container.clientHeight)
    container.scrollLeft = Math.max(0, Math.min(maxLeft, targetLeft))
    container.scrollTop = Math.max(0, Math.min(maxTop, targetTop))
    // Only consume the anchor once renderedZoom has caught up — until then
    // a follow-up effect run can re-anchor against the PDF re-raster.
    if (renderedZoom === Math.min(zoom, MAX_RENDERED_ZOOM)) {
      zoomAnchorRef.current = null
    }
  }, [zoom, renderedZoom])

  // Centre the page horizontally and vertically in the viewport on
  // initial PDF load. The page sits at scroll-content (0,0); without this
  // the user would land at scrollLeft = 0 / scrollTop = 0 with the page
  // top-left at the viewport top-left, which is fine for large pages but
  // visually offset for small ones. We compute the scroll target as
  // "page centre = viewport centre" which lands the user looking at the
  // middle of the page regardless of zoom. Clamped to scroll's [0, max]
  // range so small pages just sit at (0,0) when they can't be centred.
  useLayoutEffect(() => {
    const container = containerRef.current
    const pageEl = pageWrapperRef.current
    if (!container) return
    if (!pdfFile && !isEmptyWorkspace) return
    const raf = requestAnimationFrame(() => {
      if (!container) return
      // Use the page wrapper's actual position in scroll-content coords to
      // align the viewport centre with the page centre. pageEl.offsetLeft
      // depends on offsetParent and isn't reliable when no ancestor is
      // positioned — use bounding rects instead, taking the difference
      // between page and container to get the scroll-content offset.
      let targetLeft = 0
      let targetTop = 0
      if (pageEl) {
        const pageRect = pageEl.getBoundingClientRect()
        const containerRect = container.getBoundingClientRect()
        // Page's left in scroll-content coords:
        //   (page-left in viewport) - (container-left in viewport) + scrollLeft
        const pageInScrollLeft = pageRect.left - containerRect.left + container.scrollLeft
        const pageInScrollTop = pageRect.top - containerRect.top + container.scrollTop
        targetLeft = pageInScrollLeft + pageRect.width / 2 - container.clientWidth / 2
        targetTop = pageInScrollTop + pageRect.height / 2 - container.clientHeight / 2
      } else {
        targetLeft = (container.scrollWidth - container.clientWidth) / 2
        targetTop = (container.scrollHeight - container.clientHeight) / 2
      }
      const maxLeft = Math.max(0, container.scrollWidth - container.clientWidth)
      const maxTop = Math.max(0, container.scrollHeight - container.clientHeight)
      container.scrollLeft = Math.max(0, Math.min(maxLeft, targetLeft))
      container.scrollTop = Math.max(0, Math.min(maxTop, targetTop))
    })
    return () => cancelAnimationFrame(raf)
  }, [pdfFile, currentPage, isEmptyWorkspace])

  // ---------- File handling ----------

  /**
   * Page-picker state: when a multi-page PDF is uploaded, we hold the raw
   * file here while the user picks which pages to import. After they
   * confirm, we use pdf-lib to slice the file down to the chosen pages and
   * load that smaller PDF into the workspace. Single-page uploads skip the
   * picker entirely.
   */
  const [pagePicker, setPagePicker] = useState<{
    file: File
    totalPages: number
    selected: Set<number>
  } | null>(null)
  const [pagePickerBusy, setPagePickerBusy] = useState(false)

  function applyPdfFile(file: File) {
    setPdfFile(file)
    setCurrentPage(1)
    setNumPages(0)
    setPagesData({})
    setZoom(1)
    setRenderedZoom(1)
    cancelCalibration()
  }

  const acceptFile = async (file: File | undefined | null) => {
    if (!file || file.type !== 'application/pdf') return
    // Quick page-count via pdf-lib. Cheap (parses metadata only, no
    // rendering) and lets us decide whether to show the picker before any
    // pages have been painted.
    try {
      const bytes = await file.arrayBuffer()
      const doc = await PDFDocument.load(bytes, { ignoreEncryption: true })
      const pageCount = doc.getPageCount()
      if (pageCount > 1) {
        // Default selection: all pages selected. The user usually wants
        // most of them; deselecting one or two is easier than starting
        // from zero and ticking them all.
        setPagePicker({
          file,
          totalPages: pageCount,
          selected: new Set(Array.from({ length: pageCount }, (_, i) => i + 1)),
        })
        return
      }
    } catch (err) {
      // If pdf-lib can't parse the file (encrypted with a key, malformed,
      // etc.) we fall through to the normal load — react-pdf gets to try
      // and the user sees its error message if that fails too.
      console.warn('Page-count probe failed; loading PDF without page picker', err)
    }
    applyPdfFile(file)
  }

  /**
   * Slice the originally-uploaded PDF down to the pages the user kept, then
   * push the smaller blob into the workspace. We always emit a NEW File
   * (even if the user kept every page) because going through pdf-lib also
   * strips any auxiliary streams that the rest of the app doesn't use,
   * which usually shaves a few % off the saved size.
   */
  const applyPagePick = useCallback(async () => {
    if (!pagePicker) return
    if (pagePicker.selected.size === 0) return
    setPagePickerBusy(true)
    try {
      const bytes = await pagePicker.file.arrayBuffer()
      const src = await PDFDocument.load(bytes, { ignoreEncryption: true })
      const dst = await PDFDocument.create()
      // Preserve the user's chosen order — sorted ascending — so a
      // selection like {3, 1, 5} comes out as pages 1, 3, 5 in the new
      // doc rather than the iteration order of a Set.
      const keepZeroIndexed = Array.from(pagePicker.selected)
        .sort((a, b) => a - b)
        .map((n) => n - 1)
      const copied = await dst.copyPages(src, keepZeroIndexed)
      copied.forEach((p) => dst.addPage(p))
      const outBytes = await dst.save()
      const newFile = new File([outBytes], pagePicker.file.name, {
        type: 'application/pdf',
      })
      applyPdfFile(newFile)
      setPagePicker(null)
    } catch (err) {
      console.error('Failed to slice PDF to selected pages', err)
      alert('Could not extract those pages. Loading the full PDF instead.')
      applyPdfFile(pagePicker.file)
      setPagePicker(null)
    } finally {
      setPagePickerBusy(false)
    }
    // applyPdfFile / setters are stable; only pagePicker changes drive this
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pagePicker])

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    void acceptFile(e.target.files?.[0])
    // Reset the input so re-selecting the same file fires onChange again.
    e.target.value = ''
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
    void acceptFile(e.dataTransfer.files?.[0])
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  /**
   * Compute the largest zoom that fits the current page within the visible
   * canvas viewport (with ~5% breathing room) and return it. Returns null if
   * we don't have enough information yet (page not measured, container not
   * laid out). Doesn't apply the zoom — callers can decide whether to.
   */
  function computeFitZoom(): number | null {
    const cw = containerRef.current?.clientWidth ?? 0
    const ch = containerRef.current?.clientHeight ?? 0
    if (cw <= 0 || ch <= 0 || baseWidth <= 0) return null
    const ar = aspectRatio
    if (!ar) return null
    // Page natural dimensions at zoom = 1: baseWidth × baseWidth*ar.
    const fitW = cw / baseWidth
    const fitH = ch / (baseWidth * ar)
    const fit = Math.min(fitW, fitH) * 0.95
    return clamp(fit, MIN_ZOOM, MAX_ZOOM)
  }

  function resetZoom() {
    // "Reset" now means "fit the page" — the user clicking 100% in a viewport
    // that's bigger than the page itself just leaves a wall of grey on either
    // side, so let them re-fit instead. Falls through to a true 100% if the
    // canvas isn't measured yet (very rare on a sized viewport).
    const fit = computeFitZoom()
    setZoom(fit ?? 1)
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

  /**
   * Apply axis-snap to a calibration point relative to the first click —
   * same 4° orthogonal lock the wall-drawing tool uses. Lets the user
   * calibrate horizontal/vertical dimensions without nudging the cursor
   * to a pixel-perfect position. Shift bypasses the snap for cases where
   * the dimension is genuinely on an angle.
   */
  function calibrationAxisSnap(
    p: Point,
    anchor: Point | null,
    shiftKey: boolean
  ): Point {
    if (!anchor || shiftKey) return p
    const dx = p.x - anchor.x
    const dy = p.y - anchor.y
    if (dx === 0 && dy === 0) return p
    const len = Math.sqrt(dx * dx + dy * dy)
    const angleDeg = (Math.atan2(Math.abs(dy), Math.abs(dx)) * 180) / Math.PI
    // Within 4° of horizontal → lock to the anchor's Y.
    if (angleDeg < 4) {
      return { x: p.x, y: anchor.y }
    }
    // Within 4° of vertical → lock to the anchor's X.
    if (angleDeg > 90 - 4) {
      return { x: anchor.x, y: p.y }
    }
    // Outside the snap band — keep the cursor exactly where it is. Using
    // `len` to silence the unused-variable warning on lint configs that
    // catch dead computations.
    void len
    return p
  }

  function handleSvgClick(e: React.MouseEvent<SVGSVGElement>) {
    if (!calibrating) return
    const raw = svgCoordsFromEvent(e)
    if (!calPoint1) {
      setCalPoint1(raw)
    } else if (!calPoint2) {
      setCalPoint2(calibrationAxisSnap(raw, calPoint1, e.shiftKey))
    }
  }

  function handleSvgMouseMove(e: React.MouseEvent<SVGSVGElement>) {
    if (!calibrating) return
    if (calPoint1 && !calPoint2) {
      const raw = svgCoordsFromEvent(e)
      setMousePos(calibrationAxisSnap(raw, calPoint1, e.shiftKey))
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

  /**
   * Drop into empty-workspace mode — no PDF, fixed 1:100 metric scale on a
   * virtual A1 page. Seeds `pagesData[1]` directly so `currentScale` resolves
   * without going through the calibration flow.
   */
  function startEmptyWorkspace() {
    setIsEmptyWorkspace(true)
    setNumPages(1)
    setCurrentPage(1)
    setZoom(1)
    setPagesData({
      1: {
        pageWidthMm: EMPTY_WORKSPACE_PAGE_WIDTH_MM,
        pageHeightMm: EMPTY_WORKSPACE_PAGE_HEIGHT_MM,
        pageScaleRatio: EMPTY_WORKSPACE_DEFAULT_RATIO,
        scalePxPerMm: undefined,
      },
    })
    cancelCalibration()
  }

  // ---------- Render: PDF page picker ----------
  //
  // After the user drops or selects a multi-page PDF we hold the raw file
  // here and ask which pages they want. The chosen pages get extracted into
  // a smaller PDF via pdf-lib before being loaded as the workspace's
  // primary file — so calibration, walls, and saves only ever deal with
  // pages the user actually cares about. The modal renders on top of the
  // current view (upload zone or workspace) so the user still sees the
  // context they came from.
  const pagePickerModal = pagePicker && (
    <div className="fixed inset-0 z-50 bg-ink-900/90 flex items-center justify-center p-4">
      <div className="max-w-lg w-full bg-ink-800 rounded-xl shadow-xl border border-ink-600 max-h-[85vh] flex flex-col">
        <div className="px-6 py-4 border-b border-ink-600">
          <h2 className="text-lg font-semibold text-ink-50">
            Choose pages to import
          </h2>
          <p className="text-xs text-ink-400 mt-0.5">
            {pagePicker.file.name} has {pagePicker.totalPages} pages — tick the ones you want
            in this estimate. Pages you skip won't be imported.
          </p>
        </div>
        <div className="px-6 py-3 border-b border-ink-600 flex items-center justify-between gap-2 text-xs text-ink-300">
          <span>
            {pagePicker.selected.size} of {pagePicker.totalPages} selected
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() =>
                setPagePicker((p) =>
                  p
                    ? {
                        ...p,
                        selected: new Set(
                          Array.from({ length: p.totalPages }, (_, i) => i + 1)
                        ),
                      }
                    : p
                )
              }
              className="px-2 py-0.5 rounded border border-ink-600 text-ink-200 hover:bg-ink-700"
            >
              Select all
            </button>
            <button
              type="button"
              onClick={() => setPagePicker((p) => (p ? { ...p, selected: new Set() } : p))}
              className="px-2 py-0.5 rounded border border-ink-600 text-ink-200 hover:bg-ink-700"
            >
              Clear
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto px-6 py-3">
          <div className="grid grid-cols-2 gap-2">
            {Array.from({ length: pagePicker.totalPages }, (_, i) => i + 1).map((n) => {
              const checked = pagePicker.selected.has(n)
              return (
                <label
                  key={n}
                  className={`flex items-center gap-2 px-3 py-2 rounded border text-sm cursor-pointer ${
                    checked
                      ? 'border-beme-500 bg-beme-500/10 text-ink-50'
                      : 'border-ink-600 bg-ink-900/40 text-ink-300 hover:border-ink-500'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() =>
                      setPagePicker((p) => {
                        if (!p) return p
                        const next = new Set(p.selected)
                        if (next.has(n)) next.delete(n)
                        else next.add(n)
                        return { ...p, selected: next }
                      })
                    }
                  />
                  <span>Page {n}</span>
                </label>
              )
            })}
          </div>
        </div>
        <div className="px-6 py-4 border-t border-ink-600 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={() => setPagePicker(null)}
            disabled={pagePickerBusy}
            className="px-4 py-1.5 rounded-lg border border-ink-600 text-sm hover:bg-ink-700 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void applyPagePick()}
            disabled={pagePickerBusy || pagePicker.selected.size === 0}
            className="px-4 py-1.5 rounded-lg bg-beme-500 text-black text-sm font-medium hover:bg-beme-400 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {pagePickerBusy
              ? 'Importing…'
              : `Import ${pagePicker.selected.size} page${pagePicker.selected.size === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>
    </div>
  )

  // ---------- Render: startup gate ----------
  //
  // First-step modal that captures project + customer info. Renders for brand-
  // new projects only (no projectId in URL). Blocks the workspace until the
  // user supplies at least a project name — the same value the save flow
  // already required, just collected up front instead of as a mystery error
  // after an hour of drawing. The user can still edit any of these via the
  // Project details drawer later. We render BEFORE either the upload-zone
  // branch or the full workspace, so neither is interactive until the modal
  // is dismissed.
  if (startupGateOpen && (mode === 'block' || mode === 'brick')) {
    return (
      <div className="max-w-[1600px] mx-auto">
        <div className="fixed inset-0 z-50 bg-ink-900/95 flex items-center justify-center p-4">
          <div className="max-w-lg w-full bg-ink-800 rounded-xl shadow-xl border border-ink-600">
            <div className="px-6 py-4 border-b border-ink-600">
              <h2 className="text-lg font-semibold text-ink-50">
                Start a new {mode} estimate
              </h2>
              <p className="text-xs text-ink-400 mt-0.5">
                Fill in the customer + project info first — this lands in the
                header of the exported estimate, and saving needs at least a
                project name.
              </p>
            </div>
            <div className="px-6 py-4 space-y-3">
              <label className="text-sm block">
                <span className="block text-ink-300 mb-1">
                  Project name <span className="text-rose-400">*</span>
                </span>
                <input
                  type="text"
                  autoFocus
                  value={projectDetails.projectName}
                  onChange={(e) =>
                    setProjectDetails({ ...projectDetails, projectName: e.target.value })
                  }
                  placeholder="e.g. Berrinba"
                  className="w-full px-3 py-1.5 border border-ink-600 rounded-lg text-sm bg-ink-900 text-ink-50 focus:outline-none focus:border-beme-400"
                />
              </label>
              <label className="text-sm block">
                <span className="block text-ink-300 mb-1">Site address</span>
                <input
                  type="text"
                  value={projectDetails.siteAddress}
                  onChange={(e) =>
                    setProjectDetails({ ...projectDetails, siteAddress: e.target.value })
                  }
                  placeholder="14 Mothership Drive, Berrinba"
                  className="w-full px-3 py-1.5 border border-ink-600 rounded-lg text-sm bg-ink-900 text-ink-50 focus:outline-none focus:border-beme-400"
                />
              </label>
              <label className="text-sm block">
                <span className="block text-ink-300 mb-1">Client name</span>
                <input
                  type="text"
                  value={projectDetails.clientName}
                  onChange={(e) =>
                    setProjectDetails({ ...projectDetails, clientName: e.target.value })
                  }
                  placeholder="e.g. ABC Group"
                  className="w-full px-3 py-1.5 border border-ink-600 rounded-lg text-sm bg-ink-900 text-ink-50 focus:outline-none focus:border-beme-400"
                />
              </label>
              <label className="text-sm block">
                <span className="block text-ink-300 mb-1">Estimator</span>
                <input
                  type="text"
                  value={projectDetails.estimatorName}
                  onChange={(e) =>
                    setProjectDetails({ ...projectDetails, estimatorName: e.target.value })
                  }
                  placeholder="Your name"
                  className="w-full px-3 py-1.5 border border-ink-600 rounded-lg text-sm bg-ink-900 text-ink-50 focus:outline-none focus:border-beme-400"
                />
              </label>
            </div>
            <div className="px-6 py-4 border-t border-ink-600 flex items-center justify-between gap-2">
              <span className="text-xs text-ink-400">
                You can edit these later from Project details.
              </span>
              <button
                onClick={() => setStartupGateOpen(false)}
                disabled={!projectDetails.projectName.trim()}
                className="px-4 py-1.5 rounded-lg bg-beme-500 text-black text-sm font-medium hover:bg-beme-400 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                Start estimate
              </button>
            </div>
          </div>
        </div>
      </div>
    )
  }

  // ---------- Render: upload zone ----------

  if (!pdfFile && !isEmptyWorkspace) {
    return (
      // Upload zone mirrors the workspace layout: full-bleed flex column with
      // ProjectBar at top, a flex-row body where the drop zone occupies the
      // canvas area on the left and the same right rail (wall types / pier
      // types / library) on the right. Heights stretch all the way to the
      // viewport bottom, matching the post-PDF view so the transition is
      // seamless.
      <div className="flex-1 min-h-0 w-full flex flex-col">
        {pagePickerModal}
        {(mode === 'block' || mode === 'brick') && (
          <ProjectBar
            details={projectDetails}
            isSaved={currentProjectId !== null}
            status={projectStatus}
            lastSavedAt={lastSavedAt}
            canSave={canSave}
            saveBlockedReason={saveBlockedReason}
            mode={mode}
            sourceRequest={sourceRequest ?? null}
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

        <div className="flex-1 min-h-0 relative flex flex-col px-20 pt-2 pb-4">
          <div className="flex-1 min-h-0 flex flex-col gap-3 lg:flex-row">

            {/* ── Canvas area: drop zone fills the height ── */}
            <div className="flex-1 min-w-0 min-h-0 w-full flex flex-col gap-3">
              <div
                onDrop={handleDrop}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                className={`flex-1 min-h-0 border-2 border-dashed rounded-xl flex items-center justify-center bg-ink-800 transition-colors ${
                  isDragging
                    ? 'border-beme-500 bg-beme-500/10'
                    : 'border-ink-600 hover:border-beme-400'
                }`}
              >
                <div className="text-center max-w-md px-6 py-8">
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
                  <div className="mt-6 pt-5 border-t border-ink-700">
                    <p className="text-xs text-ink-400 mb-2">
                      No plan to work from?
                    </p>
                    <button
                      onClick={startEmptyWorkspace}
                      className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-ink-600 text-sm text-ink-200 hover:border-beme-500/60 hover:text-beme-300 transition-colors"
                    >
                      <span className="text-base leading-none">📐</span>
                      Start with an empty workspace
                    </button>
                    <p className="text-[11px] text-ink-500 mt-2">
                      Fixed at 1:100 metric — great for quick what-ifs and
                      sample walls. You can change the ratio anytime.
                    </p>
                  </div>
                </div>
              </div>

              {/* Quick-start steps — compact horizontal strip below the drop
                  zone so the canvas area stays roomy. flex-shrink-0 keeps the
                  drop zone in charge of stretching to fill vertical space. */}
              <div className="flex-shrink-0 border border-ink-600 rounded-xl bg-ink-800 px-4 py-3">
                <h3 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-400 mb-2">
                  How a {mode === 'brick' ? 'brick' : 'block'} estimate works
                </h3>
                <ol className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-x-5 gap-y-2 text-sm text-ink-200">
                  <li className="flex gap-2.5">
                    <span className="flex-shrink-0 w-5 h-5 rounded-full bg-beme-500/15 border border-beme-500/40 text-beme-300 flex items-center justify-center text-[11px] font-bold">
                      1
                    </span>
                    <span className="text-xs leading-relaxed">
                      {mode === 'block'
                        ? 'Define wall types in the side rail — bond, height, body / corner blocks.'
                        : 'Set defaults in the side rail — wall height, bricks per m², ties, plascourse.'}
                    </span>
                  </li>
                  <li className="flex gap-2.5">
                    <span className="flex-shrink-0 w-5 h-5 rounded-full bg-beme-500/15 border border-beme-500/40 text-beme-300 flex items-center justify-center text-[11px] font-bold">
                      2
                    </span>
                    <span className="text-xs leading-relaxed">
                      Upload the plan and calibrate the scale by clicking two
                      points of a known dimension.
                    </span>
                  </li>
                  <li className="flex gap-2.5">
                    <span className="flex-shrink-0 w-5 h-5 rounded-full bg-beme-500/15 border border-beme-500/40 text-beme-300 flex items-center justify-center text-[11px] font-bold">
                      3
                    </span>
                    <span className="text-xs leading-relaxed">
                      {mode === 'block'
                        ? 'Draw walls over the plan — corners, T-junctions, joints, and openings are automatic.'
                        : 'Trace brick walls and subtract openings — area is auto-calculated.'}
                    </span>
                  </li>
                  <li className="flex gap-2.5">
                    <span className="flex-shrink-0 w-5 h-5 rounded-full bg-beme-500/15 border border-beme-500/40 text-beme-300 flex items-center justify-center text-[11px] font-bold">
                      4
                    </span>
                    <span className="text-xs leading-relaxed">
                      {mode === 'block'
                        ? <>Tally updates live. Click <em>Export estimate</em> to print.</>
                        : <>Bricks, ties, plascourse, lintels tally live. Click <em>Export estimate</em>.</>}
                    </span>
                  </li>
                </ol>
              </div>
            </div>

            {/* ── Right rail: same as workspace mode ── */}
            <aside className="w-full mt-3 space-y-3 lg:w-[340px] lg:flex-shrink-0 lg:mt-0 lg:min-h-0 lg:overflow-y-auto">
              {mode === 'block' && (
                <>
                  <WallTypesPanel
                    makeups={makeups}
                    activeMakeupId={activeMakeupId}
                    wallCountsByMakeupId={wallCountsByMakeupId}
                    onSetActive={handleActivateMakeup}
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
                  <BrickTypesPanel
                    makeups={brickMakeups}
                    activeMakeupId={activeBrickMakeupId}
                    wallCountsByMakeupId={wallCountsByMakeupId}
                    onSetActive={handleActivateBrickMakeup}
                    onAddMakeup={handleAddBrickMakeup}
                    onUpdateMakeup={handleUpdateBrickMakeup}
                    onDeleteMakeup={handleDeleteBrickMakeup}
                  />
                  <BrickAdditionsPanel settings={brickSettings} onChange={setBrickSettings} />
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
    <div className="flex-1 min-h-0 w-full flex flex-col">
      {pagePickerModal}
      {/* Slim project bar — sits at the top above the floating-panel
          workspace. Takes its natural height; the workspace area below
          flex-fills the remaining viewport. */}
      {(mode === 'block' || mode === 'brick') && (
        <ProjectBar
          details={projectDetails}
          isSaved={currentProjectId !== null}
          status={projectStatus}
          lastSavedAt={lastSavedAt}
          canSave={canSave}
          saveBlockedReason={saveBlockedReason}
          mode={mode}
          sourceRequest={sourceRequest ?? null}
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

      {/* Workspace area — fills the viewport below the project bar. The
          canvas and right rail sit in a flex row below the top chrome,
          and each flex-fills the remaining vertical space. 80px L/R padding
          + 16px bottom keeps the columns well off the viewport edges (so
          the workspace reads as a contained card with the project bar
          flush above it), with a tighter 8px top so the chrome doesn't
          drift away from the bar. */}
      <div className="flex-1 min-h-0 relative flex flex-col px-20 pt-2 pb-4">

      {/* Unified toolbar — file tabs · page nav · zoom · scale · replace in
          one row. The old separate file-switcher row was redundant because
          its PRIMARY tab already shows the active file name; merging into
          this row saves ~40px of vertical space above the canvas. */}
      <div className="flex items-center mb-2 px-3 py-1.5 bg-ink-800 border border-ink-600 rounded-lg gap-3 flex-wrap">

        {/* File tabs OR empty-workspace label */}
        {isEmptyWorkspace ? (
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-sm font-medium text-ink-200 inline-flex items-center gap-2">
              <span className="text-base leading-none">📐</span>
              Empty workspace
            </span>
            <button
              onClick={() => {
                // Switch out of empty-workspace mode → land back in the upload
                // zone with everything reset. Walls/openings/piers persist so
                // the user can still upload a PDF underneath them later if
                // they change their mind (they'll just need to calibrate).
                setIsEmptyWorkspace(false)
                setNumPages(0)
                setCurrentPage(1)
                setPagesData({})
                setZoom(1)
                cancelCalibration()
              }}
              className="text-xs text-beme-400 hover:text-beme-300 hover:underline whitespace-nowrap"
              title="Attach a PDF instead — drawing keeps any existing walls"
            >
              Attach a PDF
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-2 min-w-0 overflow-x-auto">
            <span className="text-[10px] uppercase tracking-wider text-ink-400 shrink-0">
              File
            </span>
            <button
              onClick={() => switchPdf(null)}
              className={`px-3 py-1 rounded-md text-sm border whitespace-nowrap transition-colors ${
                !isReferenceView
                  ? 'bg-beme-500/15 border-beme-500/40 text-beme-300 font-medium'
                  : 'border-ink-600 text-ink-200 hover:bg-ink-700'
              }`}
              title={pdfFile?.name ?? 'Primary plan'}
            >
              <span className="text-[10px] uppercase tracking-wider mr-1.5 opacity-60">
                Primary
              </span>
              <span className="truncate max-w-[12rem] inline-block align-middle">
                {pdfFile?.name ?? '(no primary)'}
              </span>
            </button>
            {referencePdfFiles.map((f, i) => {
              const active = activeReferenceIndex === i
              return (
                <span
                  key={`${f.name}-${i}`}
                  className={`group inline-flex items-center rounded-md border whitespace-nowrap transition-colors ${
                    active
                      ? 'bg-beme-500/15 border-beme-500/40 text-beme-300'
                      : 'border-ink-600 text-ink-200 hover:bg-ink-700'
                  }`}
                >
                  <button
                    onClick={() => switchPdf(i)}
                    className={`pl-3 pr-1.5 py-1 text-sm ${active ? 'font-medium' : ''}`}
                    title={f.name}
                  >
                    <span className="text-[10px] uppercase tracking-wider mr-1.5 opacity-60">
                      Ref
                    </span>
                    <span className="truncate max-w-[12rem] inline-block align-middle">
                      {f.name}
                    </span>
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      if (!window.confirm(`Remove "${f.name}" from this project?`)) return
                      // If we're currently viewing the one being removed, hop back
                      // to the primary first so we don't end up on a missing index.
                      if (activeReferenceIndex === i) switchPdf(null)
                      else if (activeReferenceIndex !== null && activeReferenceIndex > i) {
                        // Indices after the removed one shift down by 1 — keep
                        // the displayed PDF stable across the change.
                        setActiveReferenceIndex(activeReferenceIndex - 1)
                      }
                      setReferencePdfFiles((prev) => prev.filter((_, idx) => idx !== i))
                      setReferencePdfPaths((prev) => prev.filter((_, idx) => idx !== i))
                    }}
                    title={`Remove ${f.name}`}
                    className="px-2 py-1 text-ink-400 hover:text-rose-300 text-sm"
                    aria-label={`Remove ${f.name}`}
                  >
                    ×
                  </button>
                </span>
              )
            })}
            {/* Hidden file input drives the + Add reference button. Accepts
                multiple PDFs in one shot. */}
            <input
              id="reference-pdf-input"
              type="file"
              accept="application/pdf"
              multiple
              style={{ display: 'none' }}
              onChange={(e) => {
                const picked = Array.from(e.target.files ?? []).filter(
                  (f) => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf')
                )
                if (picked.length === 0) return
                setReferencePdfFiles((prev) => [...prev, ...picked])
                setReferencePdfPaths((prev) => [
                  ...prev,
                  ...picked.map(() => undefined as string | undefined),
                ])
                // Reset the input so picking the same file again still fires change.
                e.target.value = ''
              }}
            />
            <button
              onClick={() =>
                document.getElementById('reference-pdf-input')?.click()
              }
              className="px-3 py-1 rounded-md text-sm border border-dashed border-ink-600 text-ink-300 hover:border-beme-500/60 hover:text-beme-300 transition-colors whitespace-nowrap shrink-0"
              title="Attach another PDF — engineering, architectural, etc."
            >
              + Add reference
            </button>
            {isReferenceView && (
              <span className="text-xs text-ink-400 italic shrink-0 ml-1">
                view-only
              </span>
            )}
          </div>
        )}

        <div className="h-5 w-px bg-ink-600" />

        {/* Page nav — hidden in empty-workspace mode (single virtual page). */}
        {!isEmptyWorkspace && (
          <>
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
          </>
        )}

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
            title="Scroll to zoom · Click and drag to pan · Click to fit page to canvas"
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
            {isEmptyWorkspace ? (
              // Empty workspace has no plan to click against, so the recalibrate
              // flow doesn't apply — give them a ratio dropdown instead. Same
              // applyRatioScale path the PDF mode exposes, but always available.
              <select
                value=""
                onChange={(e) => {
                  const v = e.target.value
                  if (!v) return
                  if (v === 'custom') {
                    const n = promptCustomRatio()
                    if (n !== null) applyRatioScale(n)
                  } else {
                    applyRatioScale(parseFloat(v))
                  }
                  e.target.value = ''
                }}
                className="px-2 py-1 border border-ink-600 rounded text-xs bg-ink-900 text-ink-200 focus:outline-none focus:border-beme-400"
                title="Change drawing ratio"
              >
                <option value="">Change…</option>
                {RATIO_PRESETS.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
                <option value="custom">Custom…</option>
              </select>
            ) : (
              <button
                onClick={startCalibration}
                className="text-xs text-beme-400 hover:text-beme-300 hover:underline whitespace-nowrap"
              >
                Recalibrate
              </button>
            )}
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
                if (v === 'custom') {
                  const n = promptCustomRatio()
                  if (n !== null) applyRatioScale(n)
                } else {
                  applyRatioScale(parseFloat(v))
                }
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
              <option value="custom">Custom…</option>
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

        {/* Replace primary — right-aligned with ml-auto so it sits opposite
            the file tabs at the start of the row. Only meaningful when a
            primary PDF is loaded and the user isn't currently viewing a
            reference (refs are inherited from the originating request and
            aren't editable here). Wipes drawn data on confirm so a fresh PDF
            starts clean. */}
        {!isReferenceView && !isEmptyWorkspace && pdfFile && (
          <button
            onClick={() => {
              const hasDrawnData =
                Object.values(wallsByPage).some((ws) => ws.length > 0) ||
                Object.values(openingsByPage).some((os) => os.length > 0) ||
                Object.values(piersByPage).some((ps) => ps.length > 0)
              if (hasDrawnData) {
                const ok = window.confirm(
                  'Replace the plan? All walls, openings, piers, and page calibrations will be cleared so the new PDF starts fresh. Wall types and pier types stay.'
                )
                if (!ok) return
              }
              setPdfFile(null)
              setNumPages(0)
              setCurrentPage(1)
              setPagesData({})
              setWallsByPage({})
              setOpeningsByPage({})
              setPiersByPage({})
              _setSelectedWallIds(new Set())
              _setSelectedOpeningIds(new Set())
              _setSelectedPierIds(new Set())
              setZoom(1)
              cancelCalibration()
            }}
            className="ml-auto text-xs text-beme-400 hover:text-beme-300 hover:underline whitespace-nowrap"
          >
            Replace primary
          </button>
        )}
      </div>

      {/* ──────────────────── Workspace body ────────────────────
          Flex column on small screens (canvas stacked above right rail),
          flex row on lg+ (canvas centre, thumbnails left, rail right). The
          three areas are clean columns side by side — no overlap. flex-1
          on the body and `min-h-0` on body + children let the canvas fill
          all the way to the viewport bottom. The outer padding is on the
          workspace area; this body just lays its columns out. */}
      <div className="flex-1 min-h-0 flex flex-col gap-3 lg:flex-row">

      {/* ───── Canvas area ─────
          Takes the remaining horizontal space between the thumbnails (if
          any) and the right rail. Flex column inside so the sticky drawing
          toolbar sits above the pan container which flex-fills the height. */}
      <div className="flex-1 min-w-0 min-h-0 w-full flex flex-col">

      {/* Sticky action bar — keeps drawing controls + banners glued to the top of the
          viewport while the user scrolls, so they don't need to scroll up to start a new
          wall/opening. Wraps the wall-drawing toolbar and all contextual banners/forms. */}
      <div className="sticky top-0 z-20 bg-ink-900 pt-1 pb-1 -mx-1 px-1 mb-1.5 shadow-[0_1px_0_rgba(255,255,255,0.06)]">

      {/* Keyboard shortcut help — pinned in the corner of the toolbar area.
          Toggles with the `?` key; click outside the box (or press `?` again)
          to dismiss. Only visible in block / brick mode. */}
      {(mode === 'block' || mode === 'brick') && showShortcutHelp && (
        <div className="mb-3 px-4 py-3 bg-ink-800 border border-ink-600 rounded-lg text-sm text-ink-200">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs uppercase tracking-wider text-ink-400">
              Keyboard shortcuts
            </span>
            <button
              onClick={() => setShowShortcutHelp(false)}
              className="text-xs text-ink-400 hover:text-ink-200"
              aria-label="Close shortcuts"
            >
              ×
            </button>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-x-6 gap-y-1.5">
            <div>
              <kbd className="px-1.5 py-0.5 rounded border border-ink-600 bg-ink-900 text-ink-100 text-xs font-mono">W</kbd>
              <span className="ml-2">Draw wall</span>
            </div>
            <div>
              <kbd className="px-1.5 py-0.5 rounded border border-ink-600 bg-ink-900 text-ink-100 text-xs font-mono">O</kbd>
              <span className="ml-2">Add opening</span>
            </div>
            {mode === 'block' && (
              <>
                <div>
                  <kbd className="px-1.5 py-0.5 rounded border border-ink-600 bg-ink-900 text-ink-100 text-xs font-mono">C</kbd>
                  <span className="ml-2">Curved wall</span>
                </div>
                <div>
                  <kbd className="px-1.5 py-0.5 rounded border border-ink-600 bg-ink-900 text-ink-100 text-xs font-mono">J</kbd>
                  <span className="ml-2">Control joint</span>
                </div>
                <div>
                  <kbd className="px-1.5 py-0.5 rounded border border-ink-600 bg-ink-900 text-ink-100 text-xs font-mono">P</kbd>
                  <span className="ml-2">Pier</span>
                </div>
              </>
            )}
            <div>
              <kbd className="px-1.5 py-0.5 rounded border border-ink-600 bg-ink-900 text-ink-100 text-xs font-mono">Shift</kbd>
              <span className="text-ink-400 mx-1">+</span>
              <kbd className="px-1.5 py-0.5 rounded border border-ink-600 bg-ink-900 text-ink-100 text-xs font-mono">click</kbd>
              <span className="ml-2">Multi-select</span>
            </div>
            <div>
              <kbd className="px-1.5 py-0.5 rounded border border-ink-600 bg-ink-900 text-ink-100 text-xs font-mono">Ctrl</kbd>
              <span className="text-ink-400 mx-1">+</span>
              <kbd className="px-1.5 py-0.5 rounded border border-ink-600 bg-ink-900 text-ink-100 text-xs font-mono">Z</kbd>
              <span className="ml-2">Undo</span>
            </div>
            <div>
              <kbd className="px-1.5 py-0.5 rounded border border-ink-600 bg-ink-900 text-ink-100 text-xs font-mono">Ctrl</kbd>
              <span className="text-ink-400 mx-1">+</span>
              <kbd className="px-1.5 py-0.5 rounded border border-ink-600 bg-ink-900 text-ink-100 text-xs font-mono">Y</kbd>
              <span className="ml-2">Redo</span>
            </div>
            <div>
              <kbd className="px-1.5 py-0.5 rounded border border-ink-600 bg-ink-900 text-ink-100 text-xs font-mono">type</kbd>
              <span className="text-ink-400 mx-1">+</span>
              <kbd className="px-1.5 py-0.5 rounded border border-ink-600 bg-ink-900 text-ink-100 text-xs font-mono">Enter</kbd>
              <span className="ml-2">Wall to exact length</span>
            </div>
            <div>
              <kbd className="px-1.5 py-0.5 rounded border border-ink-600 bg-ink-900 text-ink-100 text-xs font-mono">Del</kbd>
              <span className="ml-2">Delete selected</span>
            </div>
            <div>
              <kbd className="px-1.5 py-0.5 rounded border border-ink-600 bg-ink-900 text-ink-100 text-xs font-mono">Esc</kbd>
              <span className="ml-2">Cancel current tool</span>
            </div>
            <div>
              <kbd className="px-1.5 py-0.5 rounded border border-ink-600 bg-ink-900 text-ink-100 text-xs font-mono">?</kbd>
              <span className="ml-2">Toggle this panel</span>
            </div>
          </div>
        </div>
      )}

      {/* Wall drawing toolbar (block + brick modes) */}
      {(mode === 'block' || mode === 'brick') && (() => {
        // In block mode, every wall references a wall type (makeup) by id — drawing
        // without one selected silently produces a broken wall (no body block, no
        // height, no tally entry). Block the draw buttons until the user picks one.
        const blockModeNeedsType = mode === 'block'
        const activeMakeup = blockModeNeedsType ? makeupsById[activeMakeupId] : null
        const missingActiveType = blockModeNeedsType && !activeMakeup
        // A curve-bound makeup carries the arc radius — drawing a straight
        // wall with it would produce a 20.03CW wall with no curve to match,
        // which the tally can't reason about. Block the straight Draw wall
        // tool while one is active; the user can switch to a regular wall
        // type or use the Curved wall tool to draw another arc.
        const activeIsCurveMakeup =
          !!activeMakeup && typeof activeMakeup.curveRadiusMm === 'number'
        // Multi-select state surfaces inline in this toolbar when 2+ items are
        // selected: prose on the LEFT (replacing the count summary), action
        // buttons on the RIGHT (replacing the draw buttons). The dedicated
        // multi-select banner row below is now empty/null in that state — its
        // content lives here so the user doesn't have an extra row appearing
        // and disappearing.
        const wallSelCount = selectedWallIds.size
        const openingSelCount = selectedOpeningIds.size
        const pierSelCount = selectedPierIds.size
        const totalSelected = wallSelCount + openingSelCount + pierSelCount
        const selectionParts: string[] = []
        if (wallSelCount > 0)
          selectionParts.push(`${wallSelCount} wall${wallSelCount === 1 ? '' : 's'}`)
        if (openingSelCount > 0)
          selectionParts.push(`${openingSelCount} opening${openingSelCount === 1 ? '' : 's'}`)
        if (pierSelCount > 0)
          selectionParts.push(`${pierSelCount} pier${pierSelCount === 1 ? '' : 's'}`)
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
        <div className="flex items-center justify-between mb-2 px-3 py-1.5 bg-ink-800 border border-ink-600 rounded-lg flex-wrap gap-2">
          <div className="text-sm">
            {totalSelected >= 2 ? (
              <span className="text-sky-200">
                {selectionParts.join(' + ')} selected. Press{' '}
                <kbd className="px-1.5 py-0.5 rounded border border-sky-500/40 bg-ink-900 text-ink-100 text-xs font-mono">
                  Del
                </kbd>{' '}
                to remove all, or Shift+click to add/remove items.
              </span>
            ) : !currentScale ? (
              <span className="text-ink-400">
                Calibrate the scale on this page before drawing walls.
              </span>
            ) : missingActiveType ? (
              <span className="text-amber-300">
                Select a wall type above before drawing.
              </span>
            ) : activeIsCurveMakeup ? (
              <span className="text-amber-300">
                "{activeMakeup!.name}" is a curved-wall type — pick a regular wall type to draw a straight wall, or use the Curved wall tool to draw another arc.
              </span>
            ) : (() => {
              // Quick stats — count, run-metres on the current page, and a
              // running count of openings/piers if any. Cheap to compute on
              // every render: just a sum over the current page's walls.
              let totalRunMm = 0
              for (const w of currentPageWalls) {
                if (w.kind === 'curved' && w.midX !== undefined && w.midY !== undefined) {
                  const dx = w.endX - w.startX
                  const dy = w.endY - w.startY
                  // Cheap chord approximation for the inline HUD; the export
                  // / tally calc uses the proper arc length.
                  totalRunMm += Math.sqrt(dx * dx + dy * dy)
                } else {
                  const dx = w.endX - w.startX
                  const dy = w.endY - w.startY
                  totalRunMm += Math.sqrt(dx * dx + dy * dy)
                }
              }
              const totalRunM = totalRunMm / 1000
              return (
                <span className="text-ink-200">
                  {currentPageWalls.length}{' '}
                  wall{currentPageWalls.length === 1 ? '' : 's'}
                  {currentPageWalls.length > 0 && (
                    <span className="text-ink-400">
                      {' '}
                      · <span className="text-ink-100 font-medium">{totalRunM.toFixed(2)} m</span> run
                    </span>
                  )}
                  {currentPageOpenings.length > 0 && (
                    <span className="text-ink-400">
                      {' '}
                      · {currentPageOpenings.length} opening
                      {currentPageOpenings.length === 1 ? '' : 's'}
                    </span>
                  )}
                  {currentPagePiers.length > 0 && (
                    <span className="text-ink-400">
                      {' '}
                      · {currentPagePiers.length} pier
                      {currentPagePiers.length === 1 ? '' : 's'}
                    </span>
                  )}
                  {allWalls.length !== currentPageWalls.length && (
                    <span className="text-ink-400">
                      {' '}
                      · {allWalls.length} walls total in project
                    </span>
                  )}
                  {activeMakeup && (
                    <span className="text-ink-400"> · drawing as {activeMakeup.name}</span>
                  )}
                </span>
              )
            })()}
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {totalSelected >= 2 ? (
              // Multi-select actions take over the toolbar's right side so
              // there's no separate banner row underneath. When the user
              // deselects, the normal draw buttons return.
              <>
                {mode === 'block' && wallSelCount > 0 && (
                  <label className="flex items-center gap-2 text-sm text-sky-200">
                    <span className="whitespace-nowrap">Wall type ({wallSelCount}):</span>
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
              </>
            ) : (
              <>
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
              disabled={
                !currentScale || calibrating || missingActiveType || activeIsCurveMakeup
              }
              title={
                missingActiveType
                  ? 'Pick a wall type in the Wall types panel before drawing.'
                  : activeIsCurveMakeup
                  ? 'This wall type is bound to a curve — pick a straight wall type or use the Curved wall tool.'
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
                disabled={!currentScale || calibrating || missingActiveType}
                title={
                  missingActiveType
                    ? 'Pick a wall type in the Wall types panel before drawing.'
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
            {/* Ruler — transient on-canvas measurement tool. Works in both
                block and brick mode. Active button is fuchsia so it stands
                apart from the colour palette used by drawing tools. */}
            <button
              onClick={() => {
                setPlacingRuler((v) => !v)
                setRulerAnchorMm(null)
                setDrawingMode(false)
                setDrawingCurveMode(false)
                setPlacingOpening(false)
                setPlacingControlJoint(false)
                setPlacingTiedPier(false)
                setPlacingFreestandingPier(false)
                setSelectedWallId(null)
                setSelectedOpeningId(null)
                setSelectedPierId(null)
              }}
              disabled={!currentScale || calibrating}
              title="Two clicks to measure the distance between any two points on the plan. Press R."
              className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                placingRuler
                  ? 'bg-fuchsia-800 text-white hover:bg-fuchsia-900'
                  : 'bg-fuchsia-700 text-white hover:bg-fuchsia-800 disabled:opacity-40 disabled:cursor-not-allowed'
              }`}
            >
              {placingRuler ? 'Cancel ruler' : '📏 Ruler'}
            </button>
            {((measurementsByPage[currentPage] ?? []).length > 0) && (
              <button
                onClick={handleClearMeasurements}
                className="px-3 py-1.5 rounded-lg border border-ink-600 text-sm hover:bg-ink-700 transition-colors"
                title="Remove all measurements on this page."
              >
                Clear measurements
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
              </>
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

      {placingRuler && (
        <div className="mb-3 px-4 py-3 bg-fuchsia-500/10 border border-fuchsia-500/40 rounded-lg text-sm text-fuchsia-100">
          Click two points on the plan to measure the distance between them. Each pair drops a measurement that stays on the canvas until you clear it. Press{' '}
          <kbd className="px-1.5 py-0.5 rounded border border-fuchsia-300 bg-ink-900 text-ink-100 text-xs font-mono">Esc</kbd> to cancel.
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
        // Common opening presets — each spec'd as (sillMm, openingMm). Head is
        // computed at render time from the actual wall height so the same
        // preset works on a 2400 wall or a 3000 wall. Filtered to presets that
        // actually fit (opening + sill ≤ wall height − 100 for the lintel area).
        const blockOpeningPresets: Array<{ label: string; sillMm: number; openingMm: number }> = [
          { label: 'Door 2100', sillMm: 0, openingMm: 2100 },
          { label: 'Door 2040', sillMm: 0, openingMm: 2040 },
          { label: 'Window 1500 (sill 900)', sillMm: 900, openingMm: 1500 },
          { label: 'Window 1200 (sill 900)', sillMm: 900, openingMm: 1200 },
          { label: 'Window 1800 (sill 600)', sillMm: 600, openingMm: 1800 },
        ]
        return (
          <div className="mb-3 px-4 py-3 bg-amber-500/10 border border-amber-500/40 rounded-lg text-sm text-amber-200">
            <div className="font-medium mb-3">
              Opening on a {Math.round(wallHeightMm)}mm wall · {Math.round(pendingOpening.widthMm)}mm wide
            </div>
            {/* Quick-pick presets — one click sets sill + head to a common
                door/window pattern. Disabled when the preset can't fit (head
                would be negative or under 100 mm). */}
            <div className="flex flex-wrap gap-1.5 mb-3">
              <span className="text-[11px] text-amber-300 self-center mr-1">Presets:</span>
              {blockOpeningPresets.map((p) => {
                const computedHead = wallHeightMm - p.sillMm - p.openingMm
                const fits = computedHead >= 0
                return (
                  <button
                    key={p.label}
                    onClick={() => {
                      setOpeningSillHeightMm(p.sillMm)
                      setOpeningHeadHeightMm(Math.max(0, computedHead))
                    }}
                    disabled={!fits}
                    title={
                      fits
                        ? `Sill ${p.sillMm} · Head ${computedHead} · Opening ${p.openingMm}`
                        : `Doesn't fit on a ${Math.round(wallHeightMm)}mm wall`
                    }
                    className="px-2 py-0.5 rounded border border-amber-500/40 text-xs hover:bg-amber-500/15 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                  >
                    {p.label}
                  </button>
                )
              })}
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
            {/* Quick-pick height presets — one click instead of typing the
                same numbers for every door / window. Disabled if the preset
                doesn't fit the wall. */}
            <div className="flex flex-wrap gap-1.5 mb-3">
              <span className="text-[11px] text-amber-300 self-center mr-1">Presets:</span>
              {[
                { label: 'Door 2100', h: 2100 },
                { label: 'Door 2040', h: 2040 },
                { label: 'Window 1500', h: 1500 },
                { label: 'Window 1200', h: 1200 },
                { label: 'Window 1800', h: 1800 },
              ].map((p) => (
                <button
                  key={p.label}
                  onClick={() => setBrickOpeningHeightMm(p.h)}
                  disabled={p.h > wallHeightMm}
                  title={`${p.h}mm tall`}
                  className="px-2 py-0.5 rounded border border-amber-500/40 text-xs hover:bg-amber-500/15 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                >
                  {p.label}
                </button>
              ))}
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

      {/* Multi-select state (prose + action buttons) lives inline in the
          wall-drawing toolbar above when 2+ items are selected — the old
          standalone banner row has been removed so the chrome height
          doesn't change when a selection is made. */}

      {/* Single-wall selection banner removed — clicking a wall now just
          highlights it on the canvas and activates its makeup in the Wall
          types panel (so the user can see at a glance which type it is).
          Press Del to remove, drag endpoints to reposition. The Wall types
          panel handles reassignment; multi-select handles batch ops. */}

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

      {/* Page thumbnails + main PDF view — sits at the top of the canvas
          area's flex column and flex-fills the remaining height. Thumbnails
          on the left, pan container on the right, each a clean column. */}
      <div className="flex gap-3 flex-1 min-h-0">
        {/* Thumbnail sidebar (multi-page only). Extracted into a memoised
            component so zoom-driven re-renders of PdfWorkspace don't ripple
            through the per-page <Page> rendering — without this, each zoom
            tick reconciled `numPages` PDF pages, which was the bottleneck on
            multi-page plans. */}
        {numPages > 1 && displayedPdfFile && (
          <ThumbnailSidebar
            sidebarRef={sidebarRef}
            // Thumbnails follow the displayed PDF — when the user flips to a
            // reference, the sidebar shows that file's pages so they can
            // navigate within it. Calibration / wall indicators only make
            // sense for the primary, hence pagesData stays empty for refs.
            pdfFile={displayedPdfFile}
            numPages={numPages}
            currentPage={currentPage}
            pagesData={isReferenceView ? {} : pagesData}
            onSelectPage={setCurrentPage}
            wallCountsByPage={
              isReferenceView
                ? {}
                : Object.fromEntries(
                    Object.entries(wallsByPage).map(([n, ws]) => [n, ws.length])
                  )
            }
            onClearPage={isReferenceView ? undefined : handleClearPage}
          />
        )}

      {/* PDF + overlay (scrollable container with wheel-zoom and click-drag pan) */}
      <div
        ref={containerRef}
        onMouseDown={handlePanMouseDown}
        className="flex-1 min-h-0 border border-ink-600 rounded-xl overflow-auto bg-ink-800"
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
        {/* Spacer wrapper with generous symmetric padding around the page so
            the user can pan it freely in any direction past its natural
            edges (Figma-style). Flex-centering keeps the page in the middle
            of any "extra" scroll area when the spacer is forced wider than
            its content (e.g. at low zoom where minWidth kicks in) — without
            justify-center the page sticks to the spacer's left edge and the
            extra space ends up only on the right, which is what made
            panning feel one-sided.
            min-width / min-height ensure the scroll area is bigger than
            the viewport even at very low zoom, so scrolling still works. */}
        <div
          style={{
            minWidth: 'calc(100% + 1600px)',
            minHeight: 'calc(100% + 1200px)',
            padding: '600px 800px',
            boxSizing: 'border-box',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {/* Outer wrapper holds the VISUAL (transformed) dimensions so scrolling sizes correctly */}
          <div
            ref={pageWrapperRef}
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
              {isEmptyWorkspace ? (
                // Blank drawing surface — no PDF underneath, just a paper-tinted
                // rectangle so the user can see the page extents. The Konva wall
                // layer (below) gives them the grid, walls, snap markers, etc.
                <div
                  style={{
                    width: renderedPageWidth,
                    height: renderedPageHeight ?? undefined,
                    backgroundColor: '#f6f5ef',
                    backgroundImage:
                      'linear-gradient(rgba(0,0,0,0.04) 1px, transparent 1px), linear-gradient(90deg, rgba(0,0,0,0.04) 1px, transparent 1px)',
                    backgroundSize: '20px 20px, 20px 20px',
                  }}
                />
              ) : (
                <Document
                  file={displayedPdfFile}
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
              )}

              {/* Calibration overlay — at renderedZoom resolution; scales with parent.
                  Visuals deliberately mirror the wall-draw preview in WallDrawingLayer:
                  same dash pattern (6 4), same stroke width (3), same #ED7D31 orange,
                  same endpoint circles, same midpoint length badge. The label shows
                  the pixel distance until the second click lands; if there's an
                  existing scale on this page (the recalibrate case), we ALSO show the
                  current-scale mm equivalent so the user has context for what they're
                  about to replace. */}
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
                {(() => {
                  const showPreview =
                    calibrating && calPoint1 && !calPoint2 && mousePos
                  const showCommitted = !!(calPoint1 && calPoint2)
                  const a = calPoint1
                  const b = showPreview ? mousePos : showCommitted ? calPoint2 : null
                  if (!a || !b) return null
                  // Distance in current renderedZoom px (the SVG coord space).
                  const dx = b.x - a.x
                  const dy = b.y - a.y
                  const pxDist = Math.sqrt(dx * dx + dy * dy)
                  // Convert to real mm if the page already has a scale. This is the
                  // recalibrate case — the user can see what the OLD scale called
                  // this length while drafting the new one. Skips when no scale
                  // exists yet (first calibration on a fresh page).
                  let mmEstimate: number | null = null
                  const pageWidthMm = pageData?.pageWidthMm
                  const pageScaleRatio = pageData?.pageScaleRatio
                  if (
                    pageWidthMm &&
                    pageScaleRatio &&
                    baseWidth > 0 &&
                    renderedZoom > 0
                  ) {
                    const pageMm = (pxDist * pageWidthMm) / (baseWidth * renderedZoom)
                    mmEstimate = pageMm * pageScaleRatio
                  }
                  const midX = (a.x + b.x) / 2
                  const midY = (a.y + b.y) / 2
                  const label =
                    mmEstimate !== null
                      ? `${Math.round(mmEstimate)} mm`
                      : `${Math.round(pxDist)} px`
                  return (
                    <>
                      <line
                        x1={a.x}
                        y1={a.y}
                        x2={b.x}
                        y2={b.y}
                        stroke="#ED7D31"
                        strokeWidth="3"
                        strokeDasharray="6 4"
                      />
                      <text
                        x={midX + 8}
                        y={midY - 12}
                        fontSize="14"
                        fontWeight="bold"
                        fill="#C5530A"
                        style={{ pointerEvents: 'none' }}
                      >
                        {label}
                      </text>
                    </>
                  )
                })()}
                {calPoint1 && (
                  <circle cx={calPoint1.x} cy={calPoint1.y} r="5" fill="#ED7D31" stroke="white" strokeWidth="2" />
                )}
                {calPoint2 && (
                  <circle cx={calPoint2.x} cy={calPoint2.y} r="5" fill="#ED7D31" stroke="white" strokeWidth="2" />
                )}
              </svg>

              {/* Wall drawing layer — at renderedZoom resolution; scales with
                  parent. Hidden when the user is viewing a reference PDF
                  (engineering specs etc.) — walls only live on the primary,
                  so overlaying them on a different page geometry would just
                  be confusing. */}
              {(mode === 'block' || mode === 'brick') && !isReferenceView && renderedPageHeight !== null && currentScale && (
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
                  placingRuler={placingRuler}
                  rulerAnchorMm={rulerAnchorMm}
                  measurements={measurementsByPage[currentPage] ?? []}
                  onRulerClick={handleRulerClick}
                  piers={currentPagePiers}
                  selectedWallId={selectedWallId}
                  selectedOpeningId={selectedOpeningId}
                  selectedPierId={selectedPierId}
                  selectedWallIds={selectedWallIds}
                  selectedOpeningIds={selectedOpeningIds}
                  selectedPierIds={selectedPierIds}
                  wallColorByWallId={wallColorByWallId}
                  activeMakeupIdForHighlight={
                    mode === 'brick' ? activeBrickMakeupId : activeMakeupId
                  }
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

      {/* ───── Right rail: separate column on lg+ ─────
          Fixed-width column sitting beside the canvas, not over it — the
          plan and the panels each get their own space. Scrolls independently
          so a tall panel stack doesn't shrink the canvas. Stacks below the
          canvas on smaller screens. */}
      <aside className="w-full mt-3 space-y-3 lg:w-[340px] lg:flex-shrink-0 lg:mt-0 lg:min-h-0 lg:overflow-y-auto">

        {/* Wall types management panel (block mode) */}
        {mode === 'block' && (
          <WallTypesPanel
            makeups={makeups}
            activeMakeupId={activeMakeupId}
            wallCountsByMakeupId={wallCountsByMakeupId}
            onSetActive={handleActivateMakeup}
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

        {/* Brick wall types + settings + library (brick mode) */}
        {mode === 'brick' && (
          <>
            <BrickTypesPanel
              makeups={brickMakeups}
              activeMakeupId={activeBrickMakeupId}
              wallCountsByMakeupId={wallCountsByMakeupId}
              onSetActive={handleActivateBrickMakeup}
              onAddMakeup={handleAddBrickMakeup}
              onUpdateMakeup={handleUpdateBrickMakeup}
              onDeleteMakeup={handleDeleteBrickMakeup}
            />
            <BrickAdditionsPanel settings={brickSettings} onChange={setBrickSettings} />
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
            makeups={brickMakeups}
            pdfFile={pdfFile}
            // Same pagesInfo shape as the block export so each Wall Layout
            // section maps to one PDF page that has walls drawn on it. Page
            // order follows the numeric sort so the export reads bottom-up.
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
              }))}
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
  /** Wall count per page — drives the "X walls" caption and shows the
   *  Clear button only for pages that have something to clear. */
  wallCountsByPage?: Record<number, number>
  /** Delete every wall, opening, and pier on the given page. Called from
   *  the per-thumbnail Clear button. Confirmation lives at the call site. */
  onClearPage?: (pageNum: number) => void
}

const ThumbnailSidebar = memo(function ThumbnailSidebar({
  sidebarRef,
  pdfFile,
  numPages,
  currentPage,
  pagesData,
  onSelectPage,
  wallCountsByPage,
  onClearPage,
}: ThumbnailSidebarProps) {
  return (
    <div
      ref={sidebarRef}
      className="w-44 flex-shrink-0 max-h-full overflow-y-auto bg-ink-800 border border-ink-600 rounded-xl p-2 shadow-lg"
    >
      <Document file={pdfFile} loading={null} error={null}>
        <div className="space-y-2.5">
          {Array.from({ length: numPages }, (_, i) => i + 1).map((pageNum) => {
            const isCurrent = pageNum === currentPage
            // "Scaled" if either the new page-ratio is set (post-fix projects)
            // or the legacy px/mm field is present (legacy projects, until
            // migration runs on PDF load).
            const hasScale =
              !!pagesData[pageNum]?.pageScaleRatio ||
              !!pagesData[pageNum]?.scalePxPerMm
            const wallCount = wallCountsByPage?.[pageNum] ?? 0
            const canClear = wallCount > 0 && !!onClearPage
            return (
              <div
                key={pageNum}
                className={`relative group block w-full p-1.5 rounded-lg transition-colors text-left ${
                  isCurrent
                    ? 'ring-2 ring-beme-500 bg-beme-500/10'
                    : 'ring-1 ring-ink-600 hover:ring-beme-500/60 bg-ink-700/40'
                }`}
              >
                <button
                  onClick={() => onSelectPage(pageNum)}
                  className="block w-full text-left"
                >
                  <div
                    className="bg-ink-800 flex justify-center overflow-hidden rounded-md"
                    style={{ lineHeight: 0 }}
                  >
                    <Page
                      pageNumber={pageNum}
                      width={148}
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
                  {wallCount > 0 && (
                    <div className="text-[10px] text-ink-400 px-1">
                      {wallCount} wall{wallCount === 1 ? '' : 's'}
                    </div>
                  )}
                </button>
                {/* Clear page: removes every wall, opening, and pier on this
                    page so a stale earlier-attempt page can be dropped
                    permanently. Hover-visible to avoid mis-clicks during
                    normal page navigation; confirmation dialog on click. */}
                {canClear && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      const ok = window.confirm(
                        `Clear all walls, openings and piers from Page ${pageNum}? This can't be undone via the Undo button.`
                      )
                      if (ok) onClearPage?.(pageNum)
                    }}
                    title="Clear walls on this page"
                    className="absolute top-1 right-1 w-5 h-5 rounded bg-ink-900/80 text-rose-300 text-xs leading-none opacity-0 group-hover:opacity-100 hover:bg-rose-500 hover:text-ink-50 transition-opacity transition-colors"
                  >
                    ×
                  </button>
                )}
              </div>
            )
          })}
        </div>
      </Document>
    </div>
  )
})

function RequestBreadcrumb({ request }: { request: EstimateRequest }) {
  return (
    <div className="px-6 pt-4 pb-3">
      <Link
        to={`/requests/${request.id}`}
        className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-ink-600 bg-ink-800/60 text-sm text-ink-200 hover:bg-ink-700 hover:border-beme-500/50 hover:text-beme-300 transition-colors"
      >
        <span className="text-base leading-none">←</span>
        <span>
          Request from{' '}
          <span className="font-medium text-ink-50">{request.customerName}</span>
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
        <h2 className="text-3xl font-extrabold tracking-tight text-ink-50">Brick estimate</h2>
        <p className="text-ink-300 text-sm mt-1">
          Trace brick walls over a plan — area × bricks/m² plus ties, plascourse, and lintels.
        </p>
      </div>
    )
  }
  if (mode === 'block') {
    return (
      <div className="mb-6">
        <h2 className="text-3xl font-extrabold tracking-tight text-ink-50">Block estimate</h2>
        <p className="text-ink-300 text-sm mt-1">
          Walls, piers, openings — auto-tallied to a printable schedule.
        </p>
      </div>
    )
  }
  return null
}
