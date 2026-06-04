import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, lazy, Suspense } from 'react'
import type { ComponentType } from 'react'

// 3D view is lazy-loaded so users who never open it pay zero bundle cost
// (Three.js + r3f + drei add ~150 KB gzipped on top of the main bundle).
// Only resolves on the first toggle to '3d'.
//
// `lazyWithReload` wraps the dynamic import so that if Vite has redeployed
// since this tab loaded (which is the common case — the old index.html
// references a chunk filename that no longer exists, e.g.
// WorkspaceView3D-Des9c_dv.js), we trigger a one-shot full page reload
// to pick up the new asset manifest instead of surfacing
// "Failed to fetch dynamically imported module" to the user. sessionStorage
// flag prevents an infinite reload loop if the failure isn't actually a
// stale chunk (e.g. user is offline).
function lazyWithReload<T extends ComponentType<any>>(
  factory: () => Promise<{ default: T }>
) {
  return lazy(async () => {
    try {
      return await factory()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const isStaleChunk =
        /Failed to fetch dynamically imported module/i.test(message) ||
        /Importing a module script failed/i.test(message) ||
        /error loading dynamically imported module/i.test(message)
      const RELOAD_KEY = 'beme:lazy-reload-attempted'
      if (
        isStaleChunk &&
        typeof window !== 'undefined' &&
        !sessionStorage.getItem(RELOAD_KEY)
      ) {
        sessionStorage.setItem(RELOAD_KEY, '1')
        window.location.reload()
        // Return a never-resolving promise so React's Suspense fallback
        // stays visible during the in-flight reload instead of flashing
        // an error boundary in the gap.
        return new Promise<never>(() => {})
      }
      throw err
    }
  })
}

const WorkspaceView3D = lazyWithReload(() => import('./WorkspaceView3D'))
import { PDFDocument } from 'pdf-lib'
import { Document, Page, pdfjs } from 'react-pdf'
import 'react-pdf/dist/Page/AnnotationLayer.css'
import 'react-pdf/dist/Page/TextLayer.css'
import WallDrawingLayer from './WallDrawingLayer'
import SupplyItemsPanel from './SupplyItemsPanel'
import TradeRail from './TradeRail'
import AreaTabs from './AreaTabs'
import { calculateProjectTally } from '../lib/blockCalc'
import { calculateBrickTally } from '../lib/brickCalc'
import BlockTallyPanel from './BlockTallyPanel'
import WallTypesPanel from './WallTypesPanel'
import BrickTypesPanel from './BrickTypesPanel'
import BrickTallyPanel from './BrickTallyPanel'
import ProjectBar from './ProjectBar'
import ProjectDetailsDrawer from './ProjectDetailsDrawer'
import UnifiedExportPanel from './UnifiedExportPanel'
import ReferencePagePickerModal from './ReferencePagePickerModal'
import {
  type ProjectArea,
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
  createDefaultBrickMakeup,
  createDefaultBrickMakeups,
  createDefaultFreestandingPierMakeup,
  createDefaultTiedPierMakeup,
  createDefaultWallMakeup,
  getMakeupHeightMm,
} from '../lib/makeups'
import { BLOCK_LIBRARY, pickPierBlock, useBlockLibrary } from '../data/blockLibrary'
import { resolveBlockByRole } from '../lib/blockRoles'
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
    // largest depth from the library.
    //
    // The fallback (190 mm — AU 190-series default) is ONLY used when the
    // makeup doesn't resolve to any library block at all. Previously the
    // function seeded `depth = 190` and only replaced it if a library entry
    // was wider, which meant any region whose blocks are narrower than 190 mm
    // (UK 100 mm block, US 4" CMU, etc.) ignored the library entirely and
    // rendered as 190 mm AU walls. Now the floor only kicks in when there's
    // genuinely nothing to read.
    let depth: number | null = null
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
        if (typeof d === 'number' && (depth === null || d > depth)) {
          depth = d
        }
      }
    }
    map[w.id] = depth ?? 190
  }
  return map
}
import { createDefaultBrickSettings } from '../lib/brickCalc'
import {
  createDefaultExportInclusions,
  createDefaultProjectDetails,
} from '../lib/brickExport'
import { createDefaultBlockExportInclusions } from '../lib/blockExport'
import { recomputeAllJunctions } from '../lib/junctions'
import { masonryTypeColor, wallTypeColor } from '../lib/wallTypeColors'
import { useTheme } from '../lib/theme'
import { selectBlockLintel } from '../lib/lintels'
import { getCurrentOrgId, listOrgMembers } from '../lib/organisations'
import { useAuth } from '../lib/auth'
import { useUnsavedChangesPrompt } from '../lib/useUnsavedChangesPrompt'
import { toast } from '../lib/toast'
import { confirm } from '../lib/confirm'
import {
  saveDraft,
  getDraft,
  clearDraft,
  formatDraftAge,
} from '../lib/draftStore'

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
 * Raster "stops" — the PDF + Konva canvases only rasterise at these zoom
 * levels. When the user's zoom settles, we pick the smallest stop ≥ the
 * target and rasterise at that. Anything in between snaps to the higher
 * stop and gets visually scaled by the GPU via `transform: scale(...)`.
 *
 * Why this exists — mipmap-style caching, the way Bluebeam / PlanSwift
 * do it. Without stops, every distinct settled zoom triggers a re-raster
 * of the whole page. With stops, a user pinching back and forth between
 * (say) 1.1× and 1.6× only re-rasters once (crossing 1→2) instead of on
 * every gesture, because both values quantise to the same 2× stop. The
 * GPU's downscale from 2× canvas to 1.1× visual is essentially lossless
 * on modern displays so there's no perceptible softness.
 *
 * Stop choice:
 *   1.0  — covers fit-page through ~1.5× detail work
 *   2.0  — covers ~1.5× through 2.5× (the "looking at a wall" range)
 *   3.5  — covers 2.5× through MAX_ZOOM (extreme detail; same as the
 *          existing cap, so behaviour above MAX_RENDERED_ZOOM is
 *          unchanged — GPU stretches the 3.5× canvas further).
 *
 * Trade-off: a single zoom that crosses two stops in one gesture (e.g.
 * 1× → 3×) will re-raster twice instead of once. We accept this because
 * continuous-pinch traffic between two CLOSE values is by far the more
 * common pattern in takeoff work (pinpointing dimensions, hovering walls).
 */
const RENDER_ZOOM_STOPS = [1, 2, MAX_RENDERED_ZOOM]
function quantiseRenderZoom(target: number): number {
  for (const stop of RENDER_ZOOM_STOPS) {
    if (stop >= target) return stop
  }
  return RENDER_ZOOM_STOPS[RENDER_ZOOM_STOPS.length - 1]
}

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
/**
 * Best-effort resolution of a friendly estimator name from the available
 * signed-in user data. Tries (in order):
 *
 *   1. Settings → Profile → displayName  (the user's chosen name)
 *   2. Supabase auth user metadata full_name / name  (from OAuth)
 *   3. The email's local part  (everything before @)
 *
 * Returns the empty string when none resolve, so callers can early-return
 * cleanly. Wrapped in try / catch around getUserSettings so a call before
 * the settings init resolves doesn't blow up the workspace mount.
 */
function resolveEstimatorName(
  authUser: import('@supabase/supabase-js').User | null | undefined
): string {
  try {
    const us = getUserSettings()
    const profileName = us.profile?.displayName?.trim() ?? ''
    if (profileName) return profileName
  } catch {
    /* fall through to auth-based fallbacks */
  }
  if (authUser) {
    const meta = authUser.user_metadata as
      | { full_name?: string; name?: string }
      | undefined
    const metaName = meta?.full_name?.trim() || meta?.name?.trim() || ''
    if (metaName) return metaName
    if (authUser.email) {
      const local = authUser.email.split('@')[0]
      if (local) return local
    }
  }
  return ''
}

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
   * Estimate mode. The PROP is the INITIAL trade the workspace opens in;
   * once mounted the user can swap between block and brick via the trade
   * rail on the left without unmounting the workspace. Walls drawn while
   * a given trade is active get that trade stamped on their `trade`
   * field, so switching back and forth preserves work on both sides.
   *
   * Old block/brick routes still pass this prop the way they always
   * have — it just stops being the *only* source of truth.
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

export default function PdfWorkspace({ mode: initialMode, projectId }: PdfWorkspaceProps = {}) {
  // Mode is local state initialised from the prop. The TradeRail on the
  // left changes it without unmounting the workspace — all existing
  // `mode === 'block'` / `'brick'` branches keep working unchanged.
  // We deliberately don't sync to `initialMode` after mount: the user's
  // active-trade choice should survive across re-renders of the parent
  // route. If the route changes project id entirely, React unmounts and
  // remounts so the new initialMode wins automatically.
  const [mode, setMode] = useState<'block' | 'brick' | undefined>(initialMode)
  // Read theme so the 3D viewer wrapper bg can flip with the rest of
  // the app — otherwise a dark slate "frame" surrounds the canvas in
  // light mode and vice-versa.
  const [theme] = useTheme()
  // Project Areas — user-defined buckets ("Balcony", "Staircase", etc.)
  // that subdivide a single project's work. `areas` is the canonical
  // list (persisted on save); `activeAreaId` is per-session UI state
  // (null = "All" tab). Hydrated from the loaded project below; new
  // walls drawn while an area is active get its id stamped on them.
  const [areas, setAreas] = useState<ProjectArea[]>([])
  const [activeAreaId, setActiveAreaId] = useState<string | null>(null)
  // Workspace view mode — '2d' is the Konva canvas (editing surface); '3d'
  // is the mass-model 3D viewer (read-only orbit camera). Per-session UI
  // state, never persisted. Toggle button in the unified toolbar flips it.
  const [viewMode, setViewMode] = useState<'2d' | '3d'>('2d')
  const { user: currentUser } = useAuth()
  // Resolve the author's user id to a friendly display name. For org-scoped
  // projects we ask the org-members RPC (which returns full names + emails
  // for everyone in the org). For personal projects, if the author is the
  // signed-in user we use their own display name; otherwise we surface
  // "you" / nothing and let the ProjectBar handle the empty case.
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
  /**
   * Per-page calibration + intrinsic dimensions. Has to be declared up here
   * with the rest of the workspace state so the dirty-tracker effect below
   * can include it in its dep array without hitting JavaScript's temporal
   * dead zone — `useState` declarations are block-scoped `const`s and
   * reading one before its line throws a ReferenceError at runtime, which
   * crashes the workspace to a blank screen.
   */
  const [pagesData, setPagesData] = useState<Record<number, PageData>>({})
  /**
   * Whether walls of the currently active wall type should glow on the canvas.
   * Turned ON when the user activates a type (clicking it in the side panel or
   * clicking a wall on the PDF). Turned OFF when the user presses Esc with
   * nothing else to cancel — gives them a "clear the canvas" affordance without
   * losing the active type itself (so they can still draw).
   */
  const [showActiveMakeupHighlight, setShowActiveMakeupHighlight] = useState(true)

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
  /**
   * Stable per-doc id used to key the per-reference scale + measurement
   * maps below. Parallel to referencePdfFiles. Allocated client-side
   * on import (or seeded from the cloud row's id on load) so removing
   * a reference earlier in the list doesn't shuffle the slices.
   */
  const [referencePdfIds, setReferencePdfIds] = useState<string[]>([])
  /**
   * Per-reference page-scale calibration. Outer key is the doc id from
   * referencePdfIds; inner is the SOURCE PDF's page number. Each entry
   * has the same shape the primary's pagesData uses (pageScaleRatio +
   * intrinsic page dims) so the canvas can swap between primary and
   * reference slices transparently.
   */
  const [referencePdfPagesDataById, setReferencePdfPagesDataById] = useState<
    Record<string, Record<number, PageData>>
  >({})
  /**
   * Per-reference ruler measurements, persisted across sessions (the
   * primary's measurements stay session-only by design — the user's
   * looking at quick checks, not permanent annotations). Same keying
   * as `referencePdfPagesDataById`.
   */
  const [referencePdfMeasurementsByPageById, setReferencePdfMeasurementsByPageById] =
    useState<
      Record<
        string,
        Record<
          number,
          Array<{
            id: string
            startMm: { x: number; y: number }
            endMm: { x: number; y: number }
          }>
        >
      >
    >({})
  /**
   * Per-reference subset of page numbers the user picked at import time
   * via {@link ReferencePagePickerModal}. Parallel to referencePdfFiles
   * + referencePdfPaths. Undefined or empty means "show all pages" —
   * the back-compat fallback for older projects predating the picker.
   */
  const [referencePdfSelectedPages, setReferencePdfSelectedPages] = useState<
    (number[] | undefined)[]
  >([])
  /**
   * Drag-and-drop visual state. True only while a real file (not text /
   * an internal element) is being dragged over the reference tab strip.
   * Used to glow the drop zone — switching off the moment the drag
   * leaves the strip's bounds or the file is dropped.
   */
  const [isDraggingReferenceFile, setIsDraggingReferenceFile] = useState(false)
  /**
   * Files queued for the page-picker modal. Each entry shows the
   * picker in sequence; pressing Import on one advances to the next.
   * Cancel pops the rest of the queue (a "Cancel All" semantic — we
   * could let users page through individually, but a multi-file drop
   * is rare and queueing modals is good enough.)
   */
  const [pendingReferenceFiles, setPendingReferenceFiles] = useState<File[]>([])
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
   * Stable id of the reference doc currently being viewed (null when
   * the primary is showing). Used to key the per-doc scale + ruler
   * slices below — without it, the activeX helpers wouldn't know
   * which slot to write to.
   */
  const activeReferenceDocId: string | null = isReferenceView
    ? referencePdfIds[activeReferenceIndex!] ?? null
    : null

  /**
   * Effective pages-data slice for the currently-displayed PDF. The
   * canvas, scale-calibration UI, and page rail all read scale +
   * intrinsic-dims from here without caring whether the user's on
   * the primary or a reference. Falls back to an empty record when
   * a reference has no slice yet (first scale write creates it via
   * setActivePagesData).
   */
  const activePagesData: Record<number, PageData> = activeReferenceDocId
    ? referencePdfPagesDataById[activeReferenceDocId] ?? {}
    : pagesData
  /**
   * View-aware setter for the active doc's pages-data. Routes writes
   * to the primary's pagesData when in primary view, and to the
   * matching slice under referencePdfPagesDataById when in reference
   * view. Mirrors React's setState shape so existing call sites
   * (functional + replacement updates) keep working unchanged.
   */
  const setActivePagesData: React.Dispatch<
    React.SetStateAction<Record<number, PageData>>
  > = (updater) => {
    if (activeReferenceDocId) {
      setReferencePdfPagesDataById((prev) => {
        const current = prev[activeReferenceDocId] ?? {}
        const next =
          typeof updater === 'function'
            ? (updater as (p: Record<number, PageData>) => Record<number, PageData>)(
                current
              )
            : updater
        return { ...prev, [activeReferenceDocId]: next }
      })
    } else {
      setPagesData(updater)
    }
  }
  /**
   * The picked-pages subset for the active reference (undefined for
   * primary or for a reference where the user didn't restrict).
   * Drives the page-nav filtering so the user only steps through
   * the pages they care about.
   */
  const activeReferenceSelectedPages: number[] | undefined = isReferenceView
    ? referencePdfSelectedPages[activeReferenceIndex!]
    : undefined
  // `activeMeasurementsByPage` + `setActiveMeasurementsByPage` are
  // declared further down, AFTER the `measurementsByPage` state, so
  // they can read/fall-back to it without a temporal-dead-zone error.

  /**
   * Enqueue one or more freshly-acquired PDFs for the page-picker
   * modal. Files arrive here from three places: the drag-and-drop
   * handler on the tab strip, the "+ Add reference" button's file
   * input, and (potentially in future) a paste / share-target intent.
   *
   * Non-PDF files are silently dropped so a mixed multi-file drop
   * (e.g. a folder pulled in from Finder) doesn't pop a modal for
   * the wrong content type.
   */
  function queueReferenceFiles(files: File[]) {
    // Empty drop → silent no-op (the browser sometimes fires drop
    // with no files for a stray gesture; nothing to surface).
    if (files.length === 0) return
    const pdfs = files.filter(
      (f) => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf')
    )
    // Non-PDF drop → tell the user instead of swallowing it silently.
    // Common cause: someone drops a .docx or .png and wonders why
    // nothing happened.
    if (pdfs.length === 0) {
      toast.info(
        `Only PDF files can be added as references — dropped ${files.length} file(s) of a different type.`
      )
      return
    }
    setPendingReferenceFiles((prev) => [...prev, ...pdfs])
  }

  /**
   * Commit a reference file to the project with the user-picked subset
   * of pages. Pops the first entry off the picker queue so the next
   * file (if any) shows its picker.
   */
  function commitReferenceFile(file: File, selectedPages: number[]) {
    const id =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `ref-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    setReferencePdfFiles((prev) => [...prev, file])
    setReferencePdfPaths((prev) => [...prev, undefined])
    setReferencePdfIds((prev) => [...prev, id])
    setReferencePdfSelectedPages((prev) => [...prev, selectedPages])
    // No need to seed pagesDataByDocId / measurementsByDocId entries —
    // the wrappers fall back to `{}` when a doc id has no slice yet,
    // and the setters create the entry on first write.
    setPendingReferenceFiles((prev) => prev.slice(1))
  }

  /** Cancel the currently-shown picker AND any queued behind it. */
  function cancelReferenceImport() {
    setPendingReferenceFiles([])
  }

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

    // Reference PDFs are read-only (only the ruler is usable on them) so
    // any drawing mode the user had active on the primary needs to be
    // turned off before we flip — otherwise the cursor stays crosshair'd
    // and clicks attempt actions the layer no longer accepts.
    if (index !== null) {
      setDrawingMode(false)
      setDrawingCurveMode(false)
      setPlacingOpening(false)
      setPlacingControlJoint(false)
      setPlacingTiedPier(false)
      setPlacingFreestandingPier(false)
    }
    // Clear ruler anchor whenever the file changes — leftover anchor mm
    // values are interpreted in the new file's coordinate space, which
    // is meaningless. Measurements themselves are NOT wiped any more
    // because each doc keeps its own slice (per-doc storage on
    // references; session-only on the primary), so switching back to
    // a doc still shows the rulers the user dropped on it before.
    setRulerAnchorMm(null)

    // Re-entering primary → restore its page. Entering a reference:
    // jump to the first visible page (the user's first picked page,
    // or page 1 when nothing was picked).
    if (index === null) {
      setCurrentPage(primaryCurrentPage)
    } else {
      const picked = referencePdfSelectedPages[index]
      const firstVisible = picked && picked.length > 0 ? picked[0] : 1
      setCurrentPage(firstVisible)
    }
  }

  /**
   * Promote a reference PDF to the new primary plan. Used when sales attached
   * the wrong file as the primary (or the engineering set arrived after the
   * estimator started) and the estimator wants to start over on a different
   * plan without losing the references.
   *
   * Because the new plan has its own scale + its own page layout, every wall,
   * opening, pier, and page calibration tied to the OLD primary is invalid —
   * we wipe that state on confirm. The old primary moves into the references
   * list so it's still one click away (e.g. for cross-checking dimensions).
   *
   * Confirmation is mandatory and the dialog spells out exactly what gets
   * deleted, because there's no undo for the wipe — the project would have
   * to be reloaded from a previous save to recover.
   */
  function promoteReferenceToPrimary(index: number) {
    if (index < 0 || index >= referencePdfFiles.length) return
    const newPrimary = referencePdfFiles[index]
    const oldPrimary = pdfFile

    // Count what we're about to nuke so the warning is honest about scale.
    const wallCount = Object.values(wallsByPage).reduce((s, ws) => s + ws.length, 0)
    const openingCount = Object.values(openingsByPage).reduce(
      (s, os) => s + os.length,
      0
    )
    const pierCount = Object.values(piersByPage).reduce((s, ps) => s + ps.length, 0)
    const total = wallCount + openingCount + pierCount

    const lines = [
      `Make "${newPrimary.name}" the primary plan?`,
      '',
      total > 0
        ? `This will delete all ${total} drawn item${total === 1 ? '' : 's'} from the current primary (${wallCount} wall${wallCount === 1 ? '' : 's'}, ${openingCount} opening${openingCount === 1 ? '' : 's'}, ${pierCount} pier${pierCount === 1 ? '' : 's'}) because the new plan has its own scale and walls would land in the wrong places.`
        : 'There are no drawn items on the current primary, so nothing will be lost.',
      '',
      'The current primary will move into the references list so it stays one click away.',
    ]
    if (!window.confirm(lines.join('\n'))) return

    // Build the new references list: the selected ref gets removed (it's
    // being promoted), and the old primary slots in at the end (if there
    // was one — fresh projects without a primary skip this).
    const nextRefs = referencePdfFiles.filter((_, i) => i !== index)
    const nextRefPaths = referencePdfPaths.filter((_, i) => i !== index)
    if (oldPrimary) {
      nextRefs.push(oldPrimary)
      // Old primary's storage path is the row's `pdf_path`, which isn't
      // tracked per-file in workspace state — leave the path undefined so
      // the next save re-uploads it as a fresh reference. Slightly wasteful
      // but correct; the old `pdf_path` object stays orphaned in storage
      // until project delete cleans it up.
      nextRefPaths.push(undefined)
    }
    setReferencePdfFiles(nextRefs)
    setReferencePdfPaths(nextRefPaths)

    // Swap the primary.
    setPdfFile(newPrimary)

    // Wipe everything tied to the old primary's scale + page layout.
    setWallsByPage({})
    setOpeningsByPage({})
    setPiersByPage({})
    setPagesData({})

    // Reset page navigation — we're now showing the new primary from page 1.
    setActiveReferenceIndex(null)
    setCurrentPage(1)
    setPrimaryCurrentPage(1)
    // Force numPages to refresh — the new Document will set it on load. Keep
    // it at the current value briefly so the page-nav shell doesn't flicker
    // empty between primaries.
    setNumPages(0)

    // Mark dirty so Save changes lights up — the project has materially
    // changed and the user needs to persist the swap.
    setHasUnsavedChanges(true)
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
  /**
   * View-aware measurement selectors — declared here (not next to
   * `isReferenceView` and the other reference helpers) so they can
   * fall back to `measurementsByPage` / `setMeasurementsByPage`
   * without a temporal-dead-zone reference error. Primary view reads
   * from the session-only `measurementsByPage` state above; reference
   * view reads from the persistent per-doc slice keyed by the active
   * reference's id.
   */
  const activeMeasurementsByPage: Record<
    number,
    Array<{
      id: string
      startMm: { x: number; y: number }
      endMm: { x: number; y: number }
    }>
  > = activeReferenceDocId
    ? referencePdfMeasurementsByPageById[activeReferenceDocId] ?? {}
    : measurementsByPage
  const setActiveMeasurementsByPage: React.Dispatch<
    React.SetStateAction<
      Record<
        number,
        Array<{
          id: string
          startMm: { x: number; y: number }
          endMm: { x: number; y: number }
        }>
      >
    >
  > = (updater) => {
    if (activeReferenceDocId) {
      setReferencePdfMeasurementsByPageById((prev) => {
        const current = prev[activeReferenceDocId] ?? {}
        const next =
          typeof updater === 'function'
            ? (updater as (p: typeof current) => typeof current)(current)
            : updater
        return { ...prev, [activeReferenceDocId]: next }
      })
    } else {
      setMeasurementsByPage(updater)
    }
  }
  const [rulerAnchorMm, setRulerAnchorMm] = useState<{ x: number; y: number } | null>(null)
  /**
   * Which persistent measurement is currently selected. Clicking a
   * measurement on the canvas selects it (visual halo); Delete removes
   * it; Esc deselects. Single-selection — measurements are lightweight
   * markers, no need for multi-select.
   */
  const [selectedMeasurementId, setSelectedMeasurementId] = useState<string | null>(null)

  // ---------- Pier state (block mode) ----------
  const [piersByPage, setPiersByPage] = useState<Record<number, Pier[]>>({})
  /**
   * Library of pier makeups available in this project. Starts EMPTY — the
   * Pier types list only populates once the user places a pier (or
   * explicitly clicks + Add). Drawing the first pier auto-creates a
   * matching makeup via the fallback path in handleTiedPierPlaced /
   * handleFreestandingPierPlaced.
   */
  const [pierMakeups, setPierMakeups] = useState<PierMakeup[]>([])
  /**
   * Which pier makeup is "active" — i.e. the one used when the user clicks
   * to place the next pier. Parallels activeMakeupId for walls. Clicking a
   * pier type in the right-rail panel sets this; drawing a pier honours it.
   * Null until the user adds or auto-creates a pier type.
   */
  const [activePierMakeupId, setActivePierMakeupId] = useState<string | null>(null)
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
  /**
   * Seed height (mm) for newly-placed freestanding piers. Always 2400 at
   * placement; the user adjusts per pier from the pier inspector after
   * placing (parallel to walls, which inherit makeup height and can be
   * overridden per-wall). Tied piers ignore this entirely — they inherit
   * the host wall's height.
   */
  const FREESTANDING_PIER_INITIAL_HEIGHT_MM = 2400
  /**
   * Default height (mm) used the *first* time a curve in a given zone is drawn
   * — that height seeds the new makeup. Subsequent curves that dedup into an
   * existing makeup inherit the makeup's existing height (the user can still
   * edit the makeup in the Wall Types panel). Surfaced as an input in the
   * "Drawing curve" banner so the user can pick the height up front.
   */
  const [newCurveHeightMm, setNewCurveHeightMm] = useState(2400)

  const pierMakeupsById = useMemo(
    () => Object.fromEntries(pierMakeups.map((m) => [m.id, m])),
    [pierMakeups]
  )

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
    // Pull the singleton settings at init so the seed wall type respects
    // the user's DefaultsByRole map (e.g. their preferred body / corner
    // block). One-shot read — once the workspace is open, the user owns
    // the makeup. Same getUserSettings() pattern as brickSettings below.
    createDefaultWallMakeup({
      name: 'Block wall 2400mm',
      settings: getUserSettings(),
    }),
  ])
  const [activeMakeupId, setActiveMakeupId] = useState<string>(() => makeups[0].id)
  /**
   * Which kind of type the user most recently activated — drives the
   * shared toolbar's behaviour. When 'wall', Draw wall toggles
   * two-click wall draw mode (the historical default). When 'pier',
   * the same Draw wall button toggles single-click pier placement
   * using `activePierMakeupId`. Selecting a card in WallTypesPanel
   * is the only thing that flips this; clicking on the canvas or
   * pressing Esc never changes it.
   */
  const [activeTypeKind, setActiveTypeKind] = useState<'wall' | 'pier'>('wall')

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

  // Project details + export inclusion tickboxes (brick mode).
  // Seeds estimatorName with the user's display name (from Settings →
  // Profile) so the field doesn't start blank for every new estimate.
  // Falls back to auth metadata's full name, then the email's local part,
  // then empty. Pulled via getUserSettings() / currentUser at mount only
  // — once the workspace is open, the user owns the field.
  const [projectDetails, setProjectDetails] = useState<ProjectDetails>(() => {
    const base = createDefaultProjectDetails()
    const resolved = resolveEstimatorName(currentUser)
    return resolved ? { ...base, estimatorName: resolved } : base
  })

  // Auth state can resolve a beat after the workspace mounts (Supabase
  // hydrates the session from localStorage asynchronously). When that
  // happens we run a one-shot effect to fill estimatorName from the
  // freshly-arrived user — but only when nothing's been typed yet AND
  // we're on a fresh workspace (no projectId in the URL), so we never
  // clobber a name that was loaded from a saved project or typed in.
  useEffect(() => {
    if (projectId) return // not a fresh workspace — never touch
    if (projectDetails.estimatorName.trim().length > 0) return
    const resolved = resolveEstimatorName(currentUser)
    if (!resolved) return
    setProjectDetails((prev) =>
      prev.estimatorName.trim().length > 0
        ? prev
        : { ...prev, estimatorName: resolved }
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUser])
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
  /**
   * Per-project supply-item include / exclude map. See SavedProject.
   * Keys are supply-item ids; missing keys default to included, so this
   * starts empty for a fresh project (= include everything by default).
   * The user ticks items off in the tally panel to drop them from this
   * specific estimate, and the choice rides with the project on save.
   */
  const [supplyItemSelections, setSupplyItemSelections] = useState<Record<string, boolean>>({})
  /**
   * Per-project rate overrides for supply items. Same key/value shape as
   * the SavedProject field — an empty map means "use the library default
   * rate for every item." See {@link SavedProject.supplyItemRateOverrides}.
   */
  const [supplyItemRateOverrides, setSupplyItemRateOverrides] = useState<
    Record<string, number>
  >({})

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
  /**
   * Who started this project — the original estimator's user id. Stamped
   * once when the project is first saved, preserved through every later
   * save so the field stays as the original author even when another team
   * member edits the project. Surfaced as the "Started by {name}" pill in
   * the ProjectBar.
   */
  const [createdByUserId, setCreatedByUserId] = useState<string | null>(null)
  /**
   * Owner user id — the person whose dashboard the project shows up
   * under in "Your projects". Set once on first save (defaults to the
   * creator) and preserved through every later save so a teammate
   * opening the project, tweaking something, and saving doesn't
   * "steal" ownership.
   *
   * The old estimate-request flow used to transfer ownership on
   * pickup; with that gone, owner is now sticky for the project's
   * lifetime (an admin transfer UI can flip it later if needed).
   * Null until the first save / project load.
   */
  const [ownerUserId, setOwnerUserId] = useState<string | null>(null)
  /**
   * Six-digit human-readable reference number. Allocated server-side by a
   * Postgres sequence on the project's first INSERT and returned on the
   * upsert response, so the workspace shows the real number from the
   * moment of save (no reload required). Null until the first save resolves.
   */
  const [referenceNumber, setReferenceNumber] = useState<number | null>(null)
  /**
   * Display name for the project author — resolved from org membership once
   * the createdByUserId is known. Falls back to the email portion when no
   * full name is in the directory. Null = unknown / not yet resolved.
   */
  const [createdByDisplayName, setCreatedByDisplayName] = useState<string | null>(null)
  const [projectCompletedAt, setProjectCompletedAt] = useState<string | null>(null)
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null)
  const [detailsDrawerOpen, setDetailsDrawerOpen] = useState(false)
  /**
   * Export-modal open state. Lifted to the workspace so two entry
   * points share the same dialog instance: the big rail-side
   * "Export estimate" button at the bottom of the right rail, and the
   * compact "Export" button in the top ProjectBar sitting next to
   * Save changes / Mark as completed. Both write to this state; the
   * controlled-mode UnifiedExportPanel reads it as `open`.
   */
  const [exportModalOpen, setExportModalOpen] = useState(false)

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
          const ids: string[] = []
          const selectedPagesList: (number[] | undefined)[] = []
          const pagesDataById: Record<string, Record<number, PageData>> = {}
          const measurementsById: Record<
            string,
            Record<
              number,
              Array<{
                id: string
                startMm: { x: number; y: number }
                endMm: { x: number; y: number }
              }>
            >
          > = {}
          for (const ref of proj.referencePdfs) {
            if (!ref.blob) continue
            files.push(
              new File([ref.blob], ref.fileName, {
                type: ref.blob.type || 'application/pdf',
              })
            )
            paths.push(ref.path)
            // Generate an id for legacy references that pre-date the
            // id field — once allocated client-side, the next save
            // will persist it so the slice keys stay stable across
            // reloads.
            const refId =
              ref.id ??
              (typeof crypto !== 'undefined' &&
              typeof crypto.randomUUID === 'function'
                ? crypto.randomUUID()
                : `ref-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
            ids.push(refId)
            // Empty array round-trips as "show all pages" so legacy
            // projects predating the picker keep their existing
            // behaviour (every page visible). selectedPages from a
            // post-picker save is honoured verbatim.
            selectedPagesList.push(
              ref.selectedPages && ref.selectedPages.length > 0
                ? ref.selectedPages
                : undefined
            )
            if (ref.pagesData) pagesDataById[refId] = ref.pagesData
            if (ref.measurementsByPage)
              measurementsById[refId] = ref.measurementsByPage
          }
          setReferencePdfFiles(files)
          setReferencePdfPaths(paths)
          setReferencePdfIds(ids)
          setReferencePdfSelectedPages(selectedPagesList)
          setReferencePdfPagesDataById(pagesDataById)
          setReferencePdfMeasurementsByPageById(measurementsById)
        }
        setProjectDetails(proj.projectDetails)
        // Loading a saved project bypasses the startup gate — the details
        // already exist, no need to ask for them again.
        setStartupGateOpen(false)
        // Defensive `?? {}` guards: projects saved via the create-time
        // gate save (no PDF, no walls, no pages) sometimes serialise
        // these record fields without them, and a hot reload then opens
        // the project against state that expects `pagesData[currentPage]`
        // to be an object. An undefined state value would blank the
        // workspace on next render because `pagesData[currentPage]`
        // throws. Fall back to an empty record so an empty project loads
        // into the upload zone cleanly.
        setPagesData(proj.pagesData ?? {})
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
        // ── Migrate per-area scope for makeups ────────────────────────
        // Older projects saved makeups without an areaId — every wall
        // type was shared across all areas. The model is now per-area:
        // each makeup is exclusive to one ProjectArea (only visible in
        // that area's panel and on All). Migrate any makeup whose
        // areaId is missing OR points to an area that no longer
        // exists (e.g. the area was deleted but the makeup's areaId
        // was left dangling). Without the stale-id check those
        // makeups would only ever appear in the 'All' view, never in
        // a specific area's panel — exactly the orphan-makeup bug
        // the user reported.
        const hydratedAreas: ProjectArea[] =
          proj.areas && proj.areas.length > 0
            ? [...proj.areas]
            : []
        const validAreaIds = new Set(hydratedAreas.map((a) => a.id))
        const isOrphanAreaId = (id: string | undefined) =>
          !id || !validAreaIds.has(id)
        const needsAreaForMigration =
          (proj.makeups ?? []).some((m) => isOrphanAreaId(m.areaId)) ||
          (proj.brickMakeups ?? []).some((m) => isOrphanAreaId(m.areaId))
        if (needsAreaForMigration && hydratedAreas.length === 0) {
          // Create a starter area to receive the legacy makeups. Named
          // 'New Area' so it lines up with what the user sees when they
          // click '+ New area' on a fresh project — same label, no
          // surprise. Rename afterwards if the user wants something
          // more specific (Front, Back, Garage, etc.).
          const newAreaId =
            typeof crypto !== 'undefined' &&
            typeof crypto.randomUUID === 'function'
              ? crypto.randomUUID()
              : `area-${Date.now()}`
          hydratedAreas.push({ id: newAreaId, name: 'New Area' })
          validAreaIds.add(newAreaId)
        }
        const migrationAreaId = hydratedAreas[0]?.id
        const migrateMakeup = <T extends { areaId?: string }>(m: T): T =>
          isOrphanAreaId(m.areaId)
            ? ({ ...m, areaId: migrationAreaId } as T)
            : m

        // Brick walls used to be saved with makeupId === '' because they
        // had no per-wall type. Now they reference a BrickMakeup the same way
        // block walls reference a WallMakeup. Migrate on load: hydrate the
        // saved brickMakeups (or fall back to the defaults), then rewrite
        // any wall.makeupId === '' to the default brick makeup so the calc
        // engine + selection UI find a real makeup. Block walls are unaffected.
        const hydratedBrickMakeups =
          proj.brickMakeups && proj.brickMakeups.length > 0
            ? proj.brickMakeups.map(migrateMakeup)
            : createDefaultBrickMakeups().map(migrateMakeup)
        const defaultBrickMakeupId = hydratedBrickMakeups[0]?.id ?? ''
        setBrickMakeups(hydratedBrickMakeups)
        setActiveBrickMakeupId(proj.activeBrickMakeupId ?? defaultBrickMakeupId)
        const migratedWallsByPage = proj.type === 'brick'
          ? migrateBrickWalls(proj.wallsByPage, defaultBrickMakeupId)
          : proj.wallsByPage
        setWallsByPage(migratedWallsByPage ?? {})
        setOpeningsByPage(proj.openingsByPage ?? {})
        if (proj.piersByPage) setPiersByPage(proj.piersByPage)
        // Hydrate pier makeups from save (or reset to empty if the project
        // has none — switching from a project WITH piers to one WITHOUT
        // mustn't carry the previous project's pier types over).
        const savedPiers = proj.pierMakeups ?? []
        setPierMakeups(savedPiers)
        const savedActive = proj.activePierMakeupId
        const resolvedActive =
          savedActive && savedPiers.some((m) => m.id === savedActive)
            ? savedActive
            : savedPiers[0]?.id ?? null
        setActivePierMakeupId(resolvedActive)
        setCurrentPage(proj.currentPage || 1)
        // Hydrate project Areas (including any synthesised Default area
        // from the migration block above). activeAreaId stays as its
        // default (null → "All" tab) on load — landing in a specific
        // area on every reopen would be surprising. User picks the
        // area to focus on after the project loads.
        if (hydratedAreas.length > 0) setAreas(hydratedAreas)
        if (proj.makeups && proj.makeups.length > 0) {
          setMakeups(proj.makeups.map(migrateMakeup))
          if (proj.activeMakeupId) setActiveMakeupId(proj.activeMakeupId)
        }
        if (proj.brickSettings) setBrickSettings(proj.brickSettings)
        if (proj.exportInclusions) {
          // Merge with defaults so projects saved before a new inclusion
          // toggle was added still get the new section (defaulted on).
          // Mirrors the block-side merge — without it, e.g. wallLayout
          // missing on an older save silently leaves it unchecked.
          setExportInclusions({
            ...createDefaultExportInclusions(),
            ...proj.exportInclusions,
            // Wall layout pages should be ticked by default for every brick
            // export — the diagram is the most useful page in the PDF.
            // Force it ON regardless of what the saved project carried, so
            // any old project where it was off comes back ticked on next
            // load. Users can still untick it before exporting if they
            // don't want it for a specific job.
            wallLayout: true,
          })
        }
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
        setCreatedByUserId(proj.createdByUserId ?? null)
        // Hydrate ownerUserId from the cloud row. Without this, a
        // later save would have no in-state value to send, the
        // projectStorage save layer would fall back to the current
        // user as owner, and the project would migrate out of the
        // team's column into the saver's "Your projects" — the bug
        // the user reported.
        setOwnerUserId(proj.ownerUserId ?? proj.createdByUserId ?? null)
        setReferenceNumber(proj.referenceNumber ?? null)
        setSupplyItemSelections(proj.supplyItemSelections ?? {})
        setSupplyItemRateOverrides(proj.supplyItemRateOverrides ?? {})
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

  // Crash / refresh recovery — if there's a localStorage draft for this
  // project (or 'new:{mode}' for an unsaved workspace) whose timestamp
  // is newer than the cloud row's updatedAt, the user had unsaved work
  // when they last left. Prompt to restore once, after the load settles.
  // Tracks whether we've already prompted in this session so flipping
  // projects doesn't re-prompt for the same draft repeatedly.
  const restorePromptedRef = useRef<string | null>(null)
  useEffect(() => {
    if (!mode) return
    // Wait for either: a saved project loaded (lastSavedAt set) OR a
    // fresh workspace past the startup gate (gate closed).
    if (projectId && !lastSavedAt) return
    const key = projectId ?? `new:${mode}`
    if (restorePromptedRef.current === key) return
    const draft = getDraft(projectId ?? null, mode)
    if (!draft) return
    // For saved projects: only restore if the draft is newer than the
    // last cloud save. For brand-new workspaces: any draft wins.
    if (projectId && lastSavedAt) {
      const cloudMs = new Date(lastSavedAt).getTime()
      if (draft.savedAt <= cloudMs) {
        // Draft is older than cloud — cloud already has the latest.
        // Discard the stale draft to avoid prompting again.
        clearDraft(projectId, mode)
        restorePromptedRef.current = key
        return
      }
    }
    restorePromptedRef.current = key
    void (async () => {
      const ok = await confirm({
        title: 'Restore unsaved work?',
        message: `Beme found a draft from ${formatDraftAge(draft.savedAt)} that wasn't saved. Restore it now, or discard?`,
        confirmLabel: 'Restore',
        cancelLabel: 'Discard',
      })
      if (!ok) {
        clearDraft(projectId ?? null, mode)
        return
      }
      // Re-apply the draft's data slices. Cast each to its expected
      // shape — we trust ourselves to have written valid data.
      const d = draft.data as Record<string, unknown>
      if (d.wallsByPage) setWallsByPage(d.wallsByPage as typeof wallsByPage)
      if (d.openingsByPage) setOpeningsByPage(d.openingsByPage as typeof openingsByPage)
      if (d.piersByPage) setPiersByPage(d.piersByPage as typeof piersByPage)
      if (d.makeups) setMakeups(d.makeups as typeof makeups)
      if (d.pierMakeups) setPierMakeups(d.pierMakeups as typeof pierMakeups)
      if (typeof d.activeMakeupId === 'string') setActiveMakeupId(d.activeMakeupId)
      if (d.activePierMakeupId !== undefined)
        setActivePierMakeupId(d.activePierMakeupId as typeof activePierMakeupId)
      if (d.brickMakeups) setBrickMakeups(d.brickMakeups as typeof brickMakeups)
      if (typeof d.activeBrickMakeupId === 'string')
        setActiveBrickMakeupId(d.activeBrickMakeupId)
      if (d.brickSettings) setBrickSettings(d.brickSettings as typeof brickSettings)
      if (d.projectDetails) setProjectDetails(d.projectDetails as typeof projectDetails)
      if (d.projectStatus) setProjectStatus(d.projectStatus as typeof projectStatus)
      if (d.projectOutcome !== undefined)
        setProjectOutcome(d.projectOutcome as typeof projectOutcome)
      if (d.pagesData) setPagesData(d.pagesData as typeof pagesData)
      if (d.supplyItemSelections)
        setSupplyItemSelections(d.supplyItemSelections as typeof supplyItemSelections)
      if (d.supplyItemRateOverrides)
        setSupplyItemRateOverrides(d.supplyItemRateOverrides as typeof supplyItemRateOverrides)
      if (typeof d.isEmptyWorkspace === 'boolean')
        setIsEmptyWorkspace(d.isEmptyWorkspace)
      if (typeof d.currentPage === 'number') setCurrentPage(d.currentPage)
      if (d.measurementsByPage)
        setMeasurementsByPage(d.measurementsByPage as typeof measurementsByPage)
      toast.success('Draft restored', {
        description: 'Unsaved work has been re-applied. Save to commit it to the cloud.',
      })
      // Don't clear the draft yet — we want it to survive until the
      // next successful save in case the restore itself crashes the
      // workspace and they need it again on the next mount.
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, mode, lastSavedAt])

  // Resolve the author's user id to a friendly display name whenever the
  // id (or org context) changes. Three paths:
  //   1. Author is the signed-in user → use their own display name from
  //      auth metadata. No network call.
  //   2. Author is someone else in the project's org → look them up via
  //      the org-members RPC, which returns full_name + email for every
  //      member visible to the current user.
  //   3. No author / no match → null.
  useEffect(() => {
    let cancelled = false
    if (!createdByUserId) {
      setCreatedByDisplayName(null)
      return
    }
    if (currentUser && createdByUserId === currentUser.id) {
      const meta = currentUser.user_metadata as
        | { full_name?: string; name?: string }
        | undefined
      const name = meta?.full_name || meta?.name || currentUser.email || null
      setCreatedByDisplayName(name)
      return
    }
    const orgId = projectOrganisationId ?? getCurrentOrgId()
    if (!orgId) {
      setCreatedByDisplayName(null)
      return
    }
    listOrgMembers(orgId)
      .then((members) => {
        if (cancelled) return
        const m = members.find((x) => x.userId === createdByUserId)
        setCreatedByDisplayName(m?.displayName || m?.email || null)
      })
      .catch(() => {
        if (cancelled) return
        setCreatedByDisplayName(null)
      })
    return () => {
      cancelled = true
    }
  }, [createdByUserId, currentUser, projectOrganisationId])

  // Tracks whether the in-memory project differs from the last-saved (or
  // last-loaded) state. Set true by the useEffect below whenever any key
  // state reference changes, set false after a save/load.
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false)
  // Guard tab close / back / in-app navigation when there's unsaved work.
  // Reuses the workspace's own dirty flag so the prompt fires exactly when
  // ProjectBar's Save button is highlighted. Project-flavour copy keeps
  // the message specific so the user knows what's at stake.
  // Stable wrapper around handleSaveProject for the unsaved-changes
  // prompt's onSave option. handleSaveProject is defined further down,
  // so we route the call through a ref the matching effect keeps fresh.
  // Without this the hook would close over an undefined identifier
  // (TDZ) and throw on render.
  const promptSaveHandlerRef = useRef<() => Promise<void> | void>(() => {})
  const handleSaveFromPrompt = useCallback(async () => {
    await promptSaveHandlerRef.current()
  }, [])
  useUnsavedChangesPrompt(hasUnsavedChanges, {
    message:
      'You have unsaved changes to this estimate. Save before leaving, or discard?',
    onSave: handleSaveFromPrompt,
  })

  // Cmd+S (Mac) / Ctrl+S (Win / Linux) → save the current project.
  // Pre-empts the browser's "Save page as…" dialog. Skipped while the
  // user is typing into a contenteditable so we don't hijack save in
  // an inline rich-text field (currently none, but safer). Calls
  // through the same ref the unsaved-changes prompt uses so we always
  // hit the latest handleSaveProject without re-binding the listener.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const isSaveChord = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's'
      if (!isSaveChord) return
      const target = e.target as HTMLElement | null
      if (target && target.isContentEditable) return
      e.preventDefault()
      void promptSaveHandlerRef.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
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
    supplyItemSelections: typeof supplyItemSelections
    supplyItemRateOverrides: typeof supplyItemRateOverrides
    // Plan attachments + workspace mode have to live in the snapshot too
    // — uploading a PDF, switching into the empty-workspace mode, or
    // attaching a reference PDF all materially change what the project
    // looks like at next load, so they should flip `hasUnsavedChanges`
    // and unblock the Save button just like drawing a wall does.
    pdfFile: typeof pdfFile
    pagesData: typeof pagesData
    referencePdfFiles: typeof referencePdfFiles
    referencePdfPaths: typeof referencePdfPaths
    referencePdfIds: typeof referencePdfIds
    referencePdfSelectedPages: typeof referencePdfSelectedPages
    referencePdfPagesDataById: typeof referencePdfPagesDataById
    referencePdfMeasurementsByPageById: typeof referencePdfMeasurementsByPageById
    isEmptyWorkspace: typeof isEmptyWorkspace
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
  // Mirror savingRef into React state so the ProjectBar can render a
  // "Saving…" pill. The ref is the source of truth for concurrency
  // guarding (synchronous; survives re-renders); this state is purely
  // for visual feedback.
  const [isSaving, setIsSaving] = useState(false)
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
      supplyItemSelections,
      supplyItemRateOverrides,
      pdfFile,
      pagesData,
      referencePdfFiles,
      referencePdfPaths,
      referencePdfIds,
      referencePdfSelectedPages,
      referencePdfPagesDataById,
      referencePdfMeasurementsByPageById,
      isEmptyWorkspace,
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
      current.brickMakeups !== snap.brickMakeups ||
      current.supplyItemSelections !== snap.supplyItemSelections ||
      current.supplyItemRateOverrides !== snap.supplyItemRateOverrides ||
      current.pdfFile !== snap.pdfFile ||
      current.pagesData !== snap.pagesData ||
      current.referencePdfFiles !== snap.referencePdfFiles ||
      current.referencePdfPaths !== snap.referencePdfPaths ||
      current.referencePdfIds !== snap.referencePdfIds ||
      current.referencePdfSelectedPages !== snap.referencePdfSelectedPages ||
      current.referencePdfPagesDataById !== snap.referencePdfPagesDataById ||
      current.referencePdfMeasurementsByPageById !==
        snap.referencePdfMeasurementsByPageById ||
      current.isEmptyWorkspace !== snap.isEmptyWorkspace
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
    supplyItemSelections,
    supplyItemRateOverrides,
    pdfFile,
    pagesData,
    referencePdfFiles,
    referencePdfPaths,
    referencePdfIds,
    referencePdfSelectedPages,
    referencePdfPagesDataById,
    referencePdfMeasurementsByPageById,
    isEmptyWorkspace,
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

  async function handleSaveProject(opts: { silent?: boolean } = {}) {
    if (!mode) return
    // Re-entrance guard: if a previous save is still awaiting, drop this
    // call. Without this, rapid double-clicks on Save (or Save + autosave
    // racing) generate fresh UUIDs each time and insert duplicate rows.
    if (savingRef.current) return
    // Multi-tab / multi-device conflict guard: if this is a saved project
    // and the cloud row's updatedAt is newer than what we loaded, another
    // tab (or teammate) edited the project after us. Refuse to clobber.
    //
    //   - Manual save (opts.silent === false): prompt the user to Reload
    //     or Overwrite. Reload does a hard reload (next mount pulls the
    //     freshest version + the local draft offers their unsaved work).
    //     Overwrite proceeds with the save as-is.
    //   - Autosave (opts.silent === true): skip the save and surface a
    //     non-blocking toast. The user resolves by clicking Save manually.
    if (currentProjectId && lastSavedAt) {
      try {
        const cloud = await getProject(currentProjectId)
        const cloudUpdated = cloud?.updatedAt
        const localUpdated = lastSavedAt
        if (
          cloudUpdated &&
          new Date(cloudUpdated).getTime() > new Date(localUpdated).getTime()
        ) {
          if (opts.silent) {
            toast.info('Project updated elsewhere', {
              description:
                'Another window saved this project after you opened it. Click Save to choose how to resolve.',
            })
            return
          }
          const ok = await confirm({
            title: 'This project was edited elsewhere',
            message:
              'Another window or teammate saved a newer version after you opened this one. Reload to see their changes (your unsaved work stays as a recoverable draft), or overwrite their save with yours.',
            confirmLabel: 'Overwrite',
            cancelLabel: 'Reload',
            variant: 'destructive',
          })
          if (!ok) {
            // User picked Reload — hard refresh so the next mount pulls
            // the cloud version and the restore prompt surfaces any local
            // draft they want to merge back in.
            window.location.reload()
            return
          }
          // Else: user picked Overwrite — fall through to the regular
          // save path.
        }
      } catch (err) {
        // Conflict-check is best-effort. If we can't reach the server
        // (offline, RLS), proceed with the save — it'll fail downstream
        // if there's a real problem, and the user gets the actual error.
        console.warn('[saveProject] Conflict check failed; proceeding', err)
      }
    }
    savingRef.current = true
    setIsSaving(true)
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
    // Author stamp — set once on first save, preserved through every later
    // save by reading the in-state value first. Even when another org
    // member edits this project, the original author stays.
    const authorUserId = createdByUserId ?? currentUser?.id
    // Owner stamp — same sticky semantics. Hydrated from the cloud
    // row on project load (see setOwnerUserId in the loader above);
    // on first save it falls back to the saving user. Sending it on
    // every save prevents projectStorage's `owner_user_id: ownerUserId
    // ?? userId` default from re-assigning the project to whoever
    // happened to save it last.
    const persistedOwnerUserId = ownerUserId ?? authorUserId
    // Derive `trades` from "which trades have walls in this project".
    // This reflects what the user has actually drawn; a fresh project
    // that's only been opened in block mode but hasn't been drawn on
    // gets `trades=['block']` (from the initial mode) so the rail still
    // shows the right starter trade.
    const tradesWithWalls = new Set<'block' | 'brick'>()
    for (const walls of Object.values(wallsByPage)) {
      for (const w of walls) {
        tradesWithWalls.add(w.trade ?? 'block')
      }
    }
    if (tradesWithWalls.size === 0 && mode) tradesWithWalls.add(mode)
    const trades = Array.from(tradesWithWalls)
    const project: SavedProject = {
      id,
      type: mode,
      trades,
      status: projectStatus,
      organisationId,
      createdAt: projectCreatedAt ?? now,
      updatedAt: now,
      completedAt: projectCompletedAt ?? undefined,
      outcome: projectOutcome,
      createdByUserId: authorUserId,
      ownerUserId: persistedOwnerUserId,
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
            referencePdfs: referencePdfFiles.map((f, i) => {
              const id = referencePdfIds[i]
              return {
                id,
                fileName: f.name,
                blob: f,
                path: referencePdfPaths[i],
                // Persist the user's page pick so the reference reopens
                // with the same visible-pages set. Undefined / empty
                // round-trips as "show all pages" via the loader's
                // back-compat fallback.
                selectedPages: referencePdfSelectedPages[i],
                // Per-doc scale + measurements travel inside their
                // owning reference so a project with many references
                // doesn't bloat the top-level pagesData / measurements
                // fields (which stay primary-only).
                pagesData: id ? referencePdfPagesDataById[id] : undefined,
                measurementsByPage: id
                  ? referencePdfMeasurementsByPageById[id]
                  : undefined,
              }
            }),
          }
        : {}),
      pagesData,
      wallsByPage,
      openingsByPage,
      piersByPage,
      currentPage,
      supplyItemSelections,
      supplyItemRateOverrides,
      // Persist project Areas (Balcony / Staircase / etc.). Stored on
      // every save so a project's organisational structure round-trips
      // even when no walls were touched in the session.
      ...(areas.length > 0 ? { areas } : {}),
      // ALWAYS persist both trades' setup so a multi-trade project doesn't
      // lose the work on the inactive trade when saved from the active
      // trade's perspective. Pre-unification this was conditional on `mode`
      // because a project could only be one trade — now both pools can
      // legitimately have content.
      makeups,
      activeMakeupId,
      blockExportInclusions,
      pierMakeups,
      activePierMakeupId: activePierMakeupId ?? undefined,
      brickSettings,
      brickMakeups,
      activeBrickMakeupId,
      exportInclusions,
    }
    try {
      const persisted = await saveProjectToStore(project)
      setCurrentProjectId(id)
      setProjectOrganisationId(organisationId ?? null)
      setProjectCreatedAt(project.createdAt)
      if (authorUserId && !createdByUserId) setCreatedByUserId(authorUserId)
      // Same one-shot seed for ownerUserId — first save sets it; later
      // saves are no-ops because the state already matches.
      if (persistedOwnerUserId && !ownerUserId) setOwnerUserId(persistedOwnerUserId)
      // Capture the DB-allocated reference number on first save so the
      // project bar + exports show the real value immediately. Subsequent
      // saves preserve the number (cloud upsert returns the same row).
      if (persisted.referenceNumber !== undefined) {
        setReferenceNumber(persisted.referenceNumber)
      }
      setLastSavedAt(now)
      // Refresh the dirty-state baseline so the Save changes button greys
      // out until the user actually edits something next. Keep this shape
      // in sync with the dirty-tracker useEffect above — fields missing
      // here would always read as different from `current` and the project
      // would stay perpetually 'dirty' after save.
      savedSnapshotRef.current = {
        walls: wallsByPage,
        openings: openingsByPage,
        piers: piersByPage,
        makeups,
        pierMakeups,
        details: projectDetails,
        brick: brickSettings,
        brickMakeups,
        supplyItemSelections,
        supplyItemRateOverrides,
        pdfFile,
        pagesData,
        referencePdfFiles,
        referencePdfPaths,
        isEmptyWorkspace,
      }
      setHasUnsavedChanges(false)
      // Save persisted to the cloud — discard the local draft so a
      // future restore prompt doesn't offer to re-apply data that's
      // already in the saved row.
      if (mode) clearDraft(id, mode)
      toast.success('Saved')
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
      // Surface the underlying error in a toast — most failures here are
      // server-side (RLS rejection, storage quota, network blip during
      // PDF upload). Recognise common failure flavours and add a hint so
      // the toast does more than parrot the raw Postgres / Supabase
      // message back at the user.
      const msg = (err as Error)?.message ?? String(err)
      const looksLikeQuota =
        /quota|QuotaExceeded|storage|exceeded/i.test(msg)
      const looksLikeRls =
        /row.level security|RLS|violates.*policy/i.test(msg)
      let description: string
      if (looksLikeQuota) {
        description = `${msg} — your browser or storage bucket may be out of space.`
      } else if (looksLikeRls) {
        description =
          `${msg}\n\nThis is a database permission rejection. Most common cause: the project row's ` +
          `owner_user_id column is empty (legacy row predating the share migration) or the org-membership ` +
          `row for this org is missing. Open Supabase → SQL editor and run the diagnostic block we noted ` +
          `in SETUP.md (look up the project by reference number and inspect owner_user_id + organisation_id).`
      } else {
        description = msg
      }
      toast.error('Save failed', { description })
    } finally {
      // Release the guards regardless of outcome — a failed save should
      // still allow the user to retry. The in-flight id ref stays set on
      // success (currentProjectId state will catch up) and gets cleared
      // here only on success to avoid a stale id surviving across failed
      // retries; on success the state version takes over anyway.
      savingRef.current = false
      setIsSaving(false)
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
  // Refs the localStorage draft writer reads — current project id, mode,
  // and the data payload (walls/openings/etc.) frozen as a plain object.
  // Kept as refs because the autosave interval is set up once and would
  // otherwise close over stale values.
  const currentProjectIdRef = useRef<string | null>(currentProjectId)
  const modeRef = useRef<'block' | 'brick' | undefined>(mode)
  const draftDataRef = useRef<Record<string, unknown>>({})
  useEffect(() => {
    autosaveHandlerRef.current = handleSaveProject
    autosaveCanSaveRef.current = canSave
    autosaveDirtyRef.current = hasUnsavedChanges
    autosaveGateRef.current = startupGateOpen
    promptSaveHandlerRef.current = handleSaveProject
    currentProjectIdRef.current = currentProjectId
    modeRef.current = mode
    // Snapshot a plain-JSON view of the dirty workspace. PDF blobs are
    // intentionally omitted (won't fit localStorage). The restore code
    // re-applies these state slices; the user re-attaches the PDF.
    draftDataRef.current = {
      wallsByPage,
      openingsByPage,
      piersByPage,
      makeups,
      pierMakeups,
      activeMakeupId,
      activePierMakeupId,
      brickMakeups,
      activeBrickMakeupId,
      brickSettings,
      projectDetails,
      projectStatus,
      projectOutcome,
      pagesData,
      supplyItemSelections,
      supplyItemRateOverrides,
      isEmptyWorkspace,
      currentPage,
      measurementsByPage,
    }
  })
  useEffect(() => {
    // 2-minute autosave tick. Local crash-recovery draft still
    // snapshots on every dirty tick (see saveDraft below), so the
    // user-recoverable window stays small; the longer cadence just
    // cuts the cloud write rate. Was 30s — felt chatty for an
    // estimator who's drawing for an hour straight.
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
      // Always snapshot a draft when dirty, even if we can't reach the
      // cloud save. localStorage survives tab close / refresh, so a
      // crashed save still gives the user a recovery path.
      if (modeRef.current) {
        saveDraft(currentProjectIdRef.current, modeRef.current, draftDataRef.current)
      }
      if (!autosaveCanSaveRef.current) return
      if (savingRef.current) return
      void autosaveHandlerRef.current({ silent: true })
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
      const authorUserId = createdByUserId ?? currentUser?.id
      // Same ownership-preservation as the main save — without
      // ownerUserId on the patch, projectStorage would default-assign
      // the project to whoever toggled status. Status flips happen
      // from the project bar so a teammate marking someone else's
      // project complete would otherwise migrate it into their
      // "Your projects".
      const persistedOwnerUserId = ownerUserId ?? authorUserId
      const project: SavedProject = {
        id: currentProjectId,
        type: mode,
        status: nextStatus,
        organisationId,
        createdAt: projectCreatedAt ?? now,
        updatedAt: now,
        completedAt: nextStatus === 'completed' ? now : projectCompletedAt ?? undefined,
        outcome: projectOutcome,
        createdByUserId: authorUserId,
        ownerUserId: persistedOwnerUserId,
        projectDetails,
        ...(pdfFile ? { pdfBlob: pdfFile, pdfFileName: pdfFile.name } : {}),
        ...(isEmptyWorkspace ? { emptyWorkspace: true } : {}),
      // Carry reference PDFs through every save so the cloud-storage layer
      // knows about new ones (no path yet → upload) and skips reuploads for
      // ones that haven't changed (path already set).
      ...(referencePdfFiles.length > 0
        ? {
            referencePdfs: referencePdfFiles.map((f, i) => {
              const id = referencePdfIds[i]
              return {
                id,
                fileName: f.name,
                blob: f,
                path: referencePdfPaths[i],
                // Persist the user's page pick so the reference reopens
                // with the same visible-pages set. Undefined / empty
                // round-trips as "show all pages" via the loader's
                // back-compat fallback.
                selectedPages: referencePdfSelectedPages[i],
                // Per-doc scale + measurements travel inside their
                // owning reference so a project with many references
                // doesn't bloat the top-level pagesData / measurements
                // fields (which stay primary-only).
                pagesData: id ? referencePdfPagesDataById[id] : undefined,
                measurementsByPage: id
                  ? referencePdfMeasurementsByPageById[id]
                  : undefined,
              }
            }),
          }
        : {}),
        pagesData,
        wallsByPage,
        openingsByPage,
        piersByPage,
        currentPage,
        ...(areas.length > 0 ? { areas } : {}),
        // Always persist both trades' setup — see handleSaveProject for
        // why. Multi-trade projects need both pools on every save or
        // the inactive trade's work gets wiped on the next round-trip.
        makeups,
        activeMakeupId,
        pierMakeups,
        activePierMakeupId: activePierMakeupId ?? undefined,
        brickSettings,
        brickMakeups,
        activeBrickMakeupId,
        exportInclusions,
      }
      try {
        const persisted = await saveProjectToStore(project)
        if (persisted.referenceNumber !== undefined) {
          setReferenceNumber(persisted.referenceNumber)
        }
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
    if (id) {
      setSelectedOpeningId(null)
      setSelectedMeasurementId(null)
      // Clicking a SINGLE wall should highlight only that wall, not every
      // wall of the same type. The active-makeup glow is reserved for the
      // sidebar's wall-type click — that's an explicit "show me everything
      // of this type" action. Keeping it off here means a click on one wall
      // gives a focused selection halo on that wall alone, even though we
      // still surface its makeup as the active one in the panel below.
      setShowActiveMakeupHighlight(false)
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
    if (id) {
      setSelectedWallId(null)
      setSelectedMeasurementId(null)
    }
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
    // Also clear any pending-opening modal so Esc dismisses it the same
    // way it dismisses every other placement mode. Without this, a
    // pending opening modal would have no keyboard escape — the user
    // would have to find the Cancel button or click the backdrop.
    setPendingOpening(null)
    // Esc with nothing to cancel funnels through here too (see
    // WallDrawingLayer's keydown). Use that as the signal to dismiss the
    // active-makeup highlight — the user is saying "I'm not focused on
    // anything right now". The active type itself stays, so drawing the
    // next wall just lights it back up via handleWallSelect / handleActivate.
    setShowActiveMakeupHighlight(false)
  }, [])

  async function handleDeleteProject() {
    if (!currentProjectId) return
    const ok = await confirm({
      title: 'Delete this project?',
      message: 'You can undo within a few seconds from the toast.',
      confirmLabel: 'Delete project',
      variant: 'destructive',
    })
    if (!ok) return
    const deletedId = currentProjectId
    // Pre-fetch the full project (PDF blob + reference PDFs included) so
    // Undo can resurrect it byte-for-byte. Best-effort: a fetch failure
    // means no Undo, but the delete still goes through.
    let cached: SavedProject | undefined
    try {
      cached = await getProject(deletedId)
    } catch (err) {
      console.warn('[handleDeleteProject] Pre-fetch for Undo failed', err)
    }
    try {
      await deleteProjectFromStore(deletedId)
      setCurrentProjectId(null)
      setProjectStatus('in-progress')
      setProjectOutcome(undefined)
      setProjectCreatedAt(null)
      setCreatedByUserId(null)
      setOwnerUserId(null)
      setCreatedByDisplayName(null)
      setProjectCompletedAt(null)
      setLastSavedAt(null)
      if (typeof window !== 'undefined') {
        const url = new URL(window.location.href)
        url.searchParams.delete('id')
        window.history.replaceState({}, '', url.toString())
      }
      if (mode) clearDraft(deletedId, mode)
    } catch (err) {
      console.error('Failed to delete project', err)
      toast.error('Delete failed', {
        description: (err as Error)?.message ?? 'Unknown error',
      })
      return
    }
    if (cached) {
      // 8-second sticky toast with Undo. The handler re-saves via
      // saveProjectToStore (which on cloud accounts upserts the row),
      // then navigates back into the workspace at the same id so the
      // user lands exactly where they were before the delete.
      toast.success('Project deleted', {
        durationMs: 8000,
        action: {
          label: 'Undo',
          onClick: () => {
            void (async () => {
              try {
                await saveProjectToStore(cached!)
                const route = cached!.type === 'brick'
                  ? `/project/brick?id=${cached!.id}`
                  : `/project/block?id=${cached!.id}`
                window.location.assign(route)
              } catch (err) {
                toast.error('Could not restore project', {
                  description: (err as Error)?.message ?? 'Unknown error',
                })
              }
            })()
          },
        },
      })
    } else {
      toast.success('Project deleted', {
        description: "Undo not available — the project couldn't be snapshotted.",
      })
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

  // Walls visible to the workspace right now — filtered by BOTH the
  // active trade AND the active area. With multi-trade + multi-area
  // unification, `wallsByPage` can hold walls from multiple trades AND
  // multiple areas in parallel. The workspace only ever shows walls
  // matching the current view: active trade + active area (or any area
  // when `activeAreaId` is null = the "All" tab).
  //
  // Legacy walls (saved before unification) have no `trade` field —
  // treated as 'block'. Walls drawn before Areas existed have no
  // `areaId` — they only show in the All view, never under a specific
  // area tab.
  //
  // Note: write sites (handleWallPlaced, handleControlJoint, etc.) still
  // read from `wallsByPage[currentPage]` directly so they see ALL walls
  // — never use these filtered views to compute writes or other-trade /
  // other-area walls would get wiped.
  const matchesActiveView = (w: Wall): boolean => {
    if (mode && (w.trade ?? 'block') !== mode) return false
    if (activeAreaId !== null && w.areaId !== activeAreaId) return false
    return true
  }
  const allWalls = useMemo(
    () => Object.values(wallsByPage).flat().filter(matchesActiveView),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [wallsByPage, mode, activeAreaId]
  )
  // Raw walls across every trade — for the combined export card which
  // needs to see both trades regardless of the active view filter.
  const allWallsRaw = useMemo(
    () => Object.values(wallsByPage).flat(),
    [wallsByPage]
  )
  const currentPageWalls = useMemo(
    () => (wallsByPage[currentPage] ?? []).filter(matchesActiveView),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [wallsByPage, currentPage, mode, activeAreaId]
  )
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
    // Count across EVERY wall in the project, not just the area-filtered
    // view. The Wall Types panel's "X walls using this" / Delete gate
    // needs to reflect global truth so a wall type that's still in use
    // by walls in another area can't be silently deleted — that would
    // orphan those walls (dangling makeupId). The visible count then
    // also accurately reads "1 wall using this" even when the user is
    // viewing a different area.
    const counts: Record<string, number> = {}
    for (const w of allWallsRaw) counts[w.makeupId] = (counts[w.makeupId] ?? 0) + 1
    return counts
  }, [allWallsRaw])

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

  // Auto-prune ORPHANED pier makeups. Every pier makeup is auto-created (on
  // first pier placement or via + Add then immediate use), so a makeup with
  // zero piers using it is just visual clutter. Whenever the pier counts
  // change we drop any makeup that no longer has a pier. The active pier id
  // is re-pointed at the first remaining makeup so the next placement still
  // has a valid target.
  useEffect(() => {
    setPierMakeups((prev) => {
      const inUse = prev.filter((m) => (pierCountsByMakeupId[m.id] ?? 0) > 0)
      if (inUse.length === prev.length) return prev
      return inUse
    })
  }, [pierCountsByMakeupId])

  useEffect(() => {
    if (activePierMakeupId && !pierMakeups.some((m) => m.id === activePierMakeupId)) {
      setActivePierMakeupId(pierMakeups[0]?.id ?? null)
    }
  }, [pierMakeups, activePierMakeupId])

  // Auto-prune ORPHANED curve wall makeups. A curve makeup is identified by
  // having a curveRadiusMm — those are always auto-created when the user
  // draws a curve. If the last wall using one is deleted, the makeup is
  // visual clutter (no other curve will exactly match its radius). Same
  // active-id repoint guard as for piers.
  useEffect(() => {
    setMakeups((prev) => {
      const filtered = prev.filter((m) => {
        const isCurveMakeup = typeof m.curveRadiusMm === 'number'
        if (!isCurveMakeup) return true
        return (wallCountsByMakeupId[m.id] ?? 0) > 0
      })
      if (filtered.length === prev.length) return prev
      return filtered
    })
  }, [wallCountsByMakeupId])

  // Migrate legacy wedge curve makeups in-place. Old wedge curves were
  // created with the default 20.45 cleanout + 50.45 tile base course
  // because createDefaultWallMakeup seeds them and the wedge override
  // didn't reach the base / tile fields. A wedge wall has no 200-series
  // cleanout — every block is the same 20.03CW. We detect any wedge
  // makeup (curveRadiusMm set + body is 20.03CW) that still carries the
  // legacy base/tile and normalise it so the wall preview + calc engine
  // see a uniform stacked-wedge column. Runs once per `makeups` change;
  // the early-return when nothing needs fixing keeps it cheap.
  useEffect(() => {
    setMakeups((prev) => {
      let changed = false
      const next = prev.map((m) => {
        const isWedge =
          typeof m.curveRadiusMm === 'number' && m.bodyBlockCode === '20.03CW'
        if (!isWedge) return m
        const needsBaseFix = m.baseCourseBlockCode !== '20.03CW'
        const needsTileFix = m.baseCourseTileCode !== undefined
        const needsCornerFix = m.cornerBlockCode !== '20.03CW'
        const needsHalfFix = m.halfBlockCode !== '20.03CW'
        const needsTopFix = m.topCourseBlockCode !== '20.03CW'
        const needsBondFix = m.bondType !== 'stack'
        if (
          !needsBaseFix &&
          !needsTileFix &&
          !needsCornerFix &&
          !needsHalfFix &&
          !needsTopFix &&
          !needsBondFix
        ) {
          return m
        }
        changed = true
        return {
          ...m,
          baseCourseBlockCode: '20.03CW' as const,
          baseCourseTileCode: undefined,
          cornerBlockCode: '20.03CW' as const,
          halfBlockCode: '20.03CW' as const,
          topCourseBlockCode: '20.03CW' as const,
          bondType: 'stack' as const,
        }
      })
      return changed ? next : prev
    })
    // We only want to react to the makeups identity changing — running
    // setMakeups in here with the same value short-circuits via the
    // early `return prev`, so this is safe against infinite loops.
  }, [makeups])

  useEffect(() => {
    if (mode !== 'block') return
    if (!makeups.some((m) => m.id === activeMakeupId)) {
      const next = makeups[0]?.id
      if (next) setActiveMakeupId(next)
    }
  }, [makeups, activeMakeupId, mode])

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

  /**
   * Headline numbers the SupplyItemsPanel needs to compute live quantities.
   * Same math the export uses: net wall area (gross minus opening voids),
   * total run length, and the block / brick count for per-unit rates.
   * Mode picks the relevant tally function. Memoised on every input that
   * could shift the totals so the panel updates in lockstep with the
   * workspace.
   */
  const supplyMetrics = useMemo(() => {
    if (mode === 'brick') {
      // Pass brickMakeups so per-makeup course bands (e.g. single-height
      // bottom course + double-height above) feed into the supply-items
      // metrics. Brick library version is referenced below so the memo
      // re-runs when a brick definition changes.
      void brickLibraryVersion
      const tally = calculateBrickTally(allWalls, allOpenings, brickSettings, brickMakeups)
      return {
        mode: 'brick' as const,
        areaSqM: tally.totalAreaSqMm / 1_000_000,
        lengthM: tally.totalLinealMm / 1000,
        brickCount: tally.brickCount,
        blockCount: 0,
        openingCount: tally.openingCount,
        // Individual opening widths so width-ranged supply items
        // (Galintels et al.) count only the openings they cover.
        openingWidthsMm: allOpenings.map((o) => o.widthMm),
      }
    }
    // Block mode (or any unknown — fall back to block math which yields 0s).
    const tally = calculateProjectTally(
      allWalls,
      makeupsById,
      allOpenings,
      allPiers,
      pierMakeupsById
    )
    const blockCount = Object.values(tally).reduce<number>(
      (s, c) => s + (c ?? 0),
      0
    )
    let lengthMm = 0
    let areaSqMm = 0
    for (const w of allWalls) {
      const lenMm = Math.hypot(w.endX - w.startX, w.endY - w.startY)
      lengthMm += lenMm
      const h = w.heightMmOverride ?? makeupsById[w.makeupId]?.heightMm ?? 0
      areaSqMm += lenMm * h
    }
    for (const o of allOpenings) areaSqMm -= o.widthMm * o.heightMm
    return {
      mode: 'block' as const,
      areaSqM: Math.max(0, areaSqMm) / 1_000_000,
      lengthM: lengthMm / 1000,
      brickCount: 0,
      blockCount,
      openingCount: allOpenings.length,
      openingWidthsMm: allOpenings.map((o) => o.widthMm),
    }
    // blockLibraryVersion is a tally-engine dependency (calculateProjectTally
    // reaches into the live BLOCK_LIBRARY); listing it here re-runs the memo
    // when the user edits the block catalogue.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    mode,
    allWalls,
    allOpenings,
    brickSettings,
    makeupsById,
    allPiers,
    pierMakeupsById,
    blockLibraryVersion,
    brickLibraryVersion,
  ])
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

  // Per-pier colour from the shared wall+pier palette. Uses
  // masonryTypeColor so a pier's colour can never collide with a
  // wall's — the engine offsets pier indices by wall count, so
  // walls own slots 0..N-1 and piers own N..N+M-1. The canvas reads
  // this to fill each pier in its type's distinctive shade so the
  // 2D plan reads as colour-coded across both kinds.
  const pierColorByPierId = useMemo(() => {
    const map: Record<string, string> = {}
    for (const p of allPiers) {
      const id = p.pierMakeupId
      if (!id) continue
      map[p.id] = masonryTypeColor(id, makeups, pierMakeups)
    }
    return map
  }, [allPiers, makeups, pierMakeups])

  // Per-pier dimensions (width × depth) derived from each pier's OWN
  // makeup's first-course block. Without this, the canvas reads a
  // single pierFootprintMm prop and every placed pier reflects the
  // active type — so activating a second pier type after placing the
  // first re-renders the first at the wrong size.
  const pierSizeByPierId = useMemo(() => {
    const map: Record<string, { widthMm: number; depthMm: number }> = {}
    const pierMakeupsById = new Map(pierMakeups.map((pm) => [pm.id, pm]))
    for (const p of allPiers) {
      const pm = p.pierMakeupId ? pierMakeupsById.get(p.pierMakeupId) : null
      const firstCode = pm?.coursePattern?.[0]
      const block = firstCode ? BLOCK_LIBRARY[firstCode] : undefined
      if (block?.dimensions.widthMm && block?.dimensions.depthMm) {
        map[p.id] = {
          widthMm: block.dimensions.widthMm,
          depthMm: block.dimensions.depthMm,
        }
      }
    }
    return map
  }, [allPiers, pierMakeups])

  // useCallback wrappers around the wall-layer event handlers. During a zoom
  // gesture none of the dependency values change, so the callback references
  // stay stable and the memoised WallDrawingLayer can skip re-renders. Without
  // these, every rAF tick of the zoom gesture creates new function refs and
  // the layer rasterises afresh — felt smooth on light projects but visible
  // on anything with many walls. The deps are deliberately broad so the
  // behaviour is identical to the previous plain-function form when the
  // underlying state DOES change (adding walls, switching modes, etc.).
  const handleWallAdded = useCallback(function handleWallAdded(
    startMm: { x: number; y: number },
    endMm: { x: number; y: number },
  ) {
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

    // Endpoint positions are taken as-is from the draw flow. The live face
    // snap already put them on a face (if the user snapped to one), so no
    // post-placement adjustment.
    const snappedStart = startMm
    const snappedEnd = endMm

    // Resolve the new wall's makeup id. Height is intentionally NOT
    // stamped here: heightMmOverride is reserved for "the user has
    // explicitly set a different height on THIS wall, ignore the wall
    // type's height for it". Draw time has no explicit override yet,
    // so the calc engine (brickCalc.calculateBrickTally /
    // blockCalc) falls through `wall.heightMmOverride → makeup.heightMm
    // → settings.defaultWallHeightMm` — which means editing the wall
    // type's heightMm in the BrickTypesPanel / WallTypesPanel
    // afterwards propagates to every wall of that type automatically.
    //
    // Previously brick walls stamped the active makeup's heightMm into
    // heightMmOverride at draw time. That made the override win
    // forever, so subsequent wall-type height edits looked like they
    // did nothing on existing brick walls — same bug we already fixed
    // in calculateBrickTally's precedence chain.
    const rawWall: Wall = {
      id:
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `w-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      makeupId: isBrick ? activeBrickMakeupId : activeMakeupId,
      // Stamp the trade so the unified workspace knows which makeup pool
      // to look the id up in, and so switching trades doesn't make this
      // wall disappear into the wrong filter.
      trade: isBrick ? 'brick' : 'block',
      // Stamp the active area (if any) so the wall lives in that bucket.
      // Drawn while the "All" tab is active → no area → only visible
      // under All going forward. User can bulk-reassign later (v2 work).
      ...(activeAreaId ? { areaId: activeAreaId } : {}),
      startX: snappedStart.x,
      startY: snappedStart.y,
      endX: snappedEnd.x,
      endY: snappedEnd.y,
      // Junction types are derived from geometry in recomputeAllJunctions
      // below — corners (endpoints coincide), T-junctions (endpoint lands
      // on another wall's body), or free. Control joints exist only when
      // placed explicitly via the Control Joint tool.
      startJunction: { type: 'free' },
      endJunction: { type: 'free' },
      heightMmOverride: undefined,
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
    // activeAreaId is read at line ~2309 to stamp the new wall's areaId.
    // Without it in deps, the callback captures the activeAreaId at
    // mount (null) and never updates when the user switches to a
    // different area — walls drawn into "Ground Floor" end up
    // unassigned (only visible under "All areas"). That was the bug
    // the user hit when walls disappeared from their new area.
    activeAreaId,
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

    // Use the user's active wall type as-is when it's a normal
    // (user-configured) makeup — no `curveRadiusMm` means the user
    // built it through the wall type modal, including the Curved
    // path that drops them into curve-draw against the new type.
    // Bypass the auto-create-a-curve-makeup branch in that case so
    // the drawn curve carries the exact composition the user picked
    // (blocks, bond, height, etc.). The calc engine still adapts the
    // chosen blocks to the curve geometry on render / tally.
    const userActiveMakeup = makeupsById[activeMakeupId]
    if (userActiveMakeup && typeof userActiveMakeup.curveRadiusMm !== 'number') {
      const newWallId =
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `wall-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const targetAreaId =
        userActiveMakeup.areaId ??
        activeAreaId ??
        (areas.length > 0 ? areas[0].id : undefined)
      const curvedWall: Wall = {
        id: newWallId,
        trade: 'block',
        ...(targetAreaId ? { areaId: targetAreaId } : {}),
        makeupId: userActiveMakeup.id,
        startX: startMm.x,
        startY: startMm.y,
        endX: endMm.x,
        endY: endMm.y,
        kind: 'curved',
        midX: midMm.x,
        midY: midMm.y,
        startJunction: { type: 'free' },
        endJunction: { type: 'free' },
      }
      const existing = wallsByPage[currentPage] ?? []
      const newWalls = [...existing, curvedWall]
      const thicknesses = computeWallThicknessByWallId(
        newWalls,
        makeupsById,
        mode,
        brickSettings.brickTypeCode
      )
      const recomputed = recomputeAllJunctions(newWalls, thicknesses)
      setWallsByPage((prev) => ({ ...prev, [currentPage]: recomputed }))
      setDrawingCurveMode(false)
      return
    }

    // Curve drawing uses whatever wall type the user has ACTIVE in the
    // Wall Types panel — same as straight walls. The radius doesn't
    // pre-select the body block any more: if the user wants 20.03CW
    // they set it on the active wall type and every curve they draw
    // inherits it; if they want plain 20.48 they leave it as-is.
    //
    // Previously we ran a `curveZoneForRadius` classifier here and
    // auto-created a separate makeup per zone (standard / cut / wedge /
    // custom). That ignored the user's composition setting, which made
    // curves drawn from a 20.03CW wall type still come out as 20.48
    // body whenever the radius landed in the "standard" zone. Removed.
    //
    // Resolve target area: same chain as handleAddMakeup. Used only to
    // stamp the wall (not a new makeup — we reuse the active one).
    let targetAreaId: string | null = activeAreaId
      ? activeAreaId
      : areas.length > 0
        ? areas[0].id
        : null
    let nextAreas = areas
    if (!targetAreaId) {
      const newAreaId =
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `area-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      nextAreas = [...areas, { id: newAreaId, name: 'New Area' }]
      setAreas(nextAreas)
      setActiveAreaId(newAreaId)
      targetAreaId = newAreaId
    }

    let makeupId: string = activeMakeupId
    let nextMakeups = makeups
    let nextMakeupsById = makeupsById
    const activeMakeup = makeupsById[activeMakeupId]
    if (!activeMakeup) {
      // Defensive: no valid active makeup (shouldn't happen because the
      // toolbar's draw button requires one). Auto-create a neutral
      // default so the curve still lands somewhere reasonable.
      const fallback = createDefaultWallMakeup({
        name: 'Curved wall',
        heightMm: newCurveHeightMm,
        bondType: 'stretcher',
        settings: getUserSettings(),
      })
      if (targetAreaId) fallback.areaId = targetAreaId
      makeupId = fallback.id
      nextMakeups = [...makeups, fallback]
      nextMakeupsById = { ...makeupsById, [fallback.id]: fallback }
      setMakeups(nextMakeups)
    }

    const rawWall: Wall = {
      id:
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `w-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      makeupId,
      // Curved walls are block-only today (the brick toolbar doesn't
      // expose the curve tool), but stamp the trade defensively so a
      // future brick curve doesn't accidentally render as a block wall.
      trade: mode === 'brick' ? 'brick' : 'block',
      // Stamp the resolved target area — keeps wall and its makeup
      // anchored to the same area. Using activeAreaId here directly
      // would diverge from the makeup's areaId in the auto-create-an-
      // area branch (which advances targetAreaId past whatever
      // activeAreaId was on entry).
      ...(targetAreaId ? { areaId: targetAreaId } : {}),
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
    const thicknesses = computeWallThicknessByWallId(newWalls, nextMakeupsById, mode, brickSettings.brickTypeCode)
    const recomputed = recomputeAllJunctions(newWalls, thicknesses)
    setWallsByPage((prev) => ({ ...prev, [currentPage]: recomputed }))
  }, [
    mode,
    wallsByPage,
    currentPage,
    makeups,
    makeupsById,
    brickSettings,
    newCurveHeightMm,
    // Same reason as handleWallAdded: the curve stamps activeAreaId
    // (and now resolves a target area from `areas`), so a stale
    // closure here would silently drop the area assignment.
    activeAreaId,
    areas,
  ])

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

    // Inner ends tagged 'control-joint' — that marker is the ONLY
    // way the junction survives recomputeAllJunctions intact. If we
    // used 'free' here, the junction recompute pass would see the
    // two halves' coincident endpoints and re-derive them as a
    // CORNER (corners = endpoints coincide). That collapses the
    // seam into a single full-corner column, no alternation.
    //
    // The 'control-joint' marker keeps recomputeAllJunctions away
    // from it. Downstream, planEnd / resolveEndForCourse /
    // segmentsForStraightWall treat 'control-joint' the same as
    // 'free' — alternating full/half stretcher pattern — so each
    // half emits its own end termination at the seam.
    //
    // connectedWallIds keeps the relationship so future operations
    // (delete one half, drag endpoints, etc.) can find the partner.
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

    // Repoint any OTHER wall's connectedWallIds that reference the wall
    // we're about to split. Without this, an existing control-joint
    // partner (or future corner partner) still references the OLD
    // wallId — recomputeAllJunctions sees the dangling ref and
    // downgrades that endpoint to 'free', breaking symmetry on the
    // partner's side of an already-placed control joint.
    //
    // Geographically: if the partner wall's junction sits NEAR the
    // original wall's START point, it belongs with firstHalf. If
    // near the END point, with secondHalf.
    const startPt = { x: wall.startX, y: wall.startY }
    const endPt = { x: wall.endX, y: wall.endY }
    const sqDist = (a: { x: number; y: number }, b: { x: number; y: number }) =>
      (a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y)
    const repointJunction = (j: { type: string; connectedWallIds?: string[] }, jx: number, jy: number) => {
      const ids = j.connectedWallIds
      if (!ids || !ids.includes(wallId)) return j
      const at = { x: jx, y: jy }
      const replacement = sqDist(at, startPt) <= sqDist(at, endPt) ? firstId : secondId
      return {
        ...j,
        connectedWallIds: ids.map((id) => (id === wallId ? replacement : id)),
      }
    }
    const remainingWalls = existing
      .filter((w) => w.id !== wallId)
      .map((w) => ({
        ...w,
        startJunction: repointJunction(
          w.startJunction as unknown as { type: string; connectedWallIds?: string[] },
          w.startX,
          w.startY,
        ) as typeof w.startJunction,
        endJunction: repointJunction(
          w.endJunction as unknown as { type: string; connectedWallIds?: string[] },
          w.endX,
          w.endY,
        ) as typeof w.endJunction,
      }))
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

  function handleAddMakeup(makeup: WallMakeup) {
    // Resolve an areaId for the new makeup. Without this every
    // makeup needs SOME area to belong to — otherwise it shows under
    // 'All areas' but never appears in any specific area panel,
    // which is the orphan-makeup bug the user reported.
    //
    // Resolution order:
    //   1. makeup.areaId (caller provided one already — uncommon)
    //   2. activeAreaId (we're inside a specific area)
    //   3. areas[0]?.id (we're on All view; pick the first area)
    //   4. auto-create a 'New Area' (no areas exist at all)
    let stamped: WallMakeup
    if (makeup.areaId) {
      stamped = makeup
    } else if (activeAreaId) {
      stamped = { ...makeup, areaId: activeAreaId }
    } else if (areas.length > 0) {
      stamped = { ...makeup, areaId: areas[0].id }
    } else {
      // No areas yet — spawn one named 'New Area' to receive this
      // makeup. Same pattern the project-load migration uses.
      const newAreaId =
        typeof crypto !== 'undefined' &&
        typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `area-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      setAreas((prev) => [...prev, { id: newAreaId, name: 'New Area' }])
      setActiveAreaId(newAreaId)
      stamped = { ...makeup, areaId: newAreaId }
    }
    setMakeups((prev) => [...prev, stamped])
    setActiveMakeupId(stamped.id)
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
    // Flip the kind tracker so the shared toolbar's Draw wall button
    // returns to wall-draw mode after the user previously had a pier
    // type active.
    setActiveTypeKind('wall')
    // Picking a type in the panel is an explicit signal of intent to work
    // with it — light up the matching walls again even if the user had
    // pressed Esc earlier to dismiss the highlight.
    setShowActiveMakeupHighlight(true)
  }
  /**
   * Companion to handleActivateMakeup for pier types. Setting the
   * active pier on its own would leave activeTypeKind stuck on
   * 'wall', so the shared toolbar Draw wall button wouldn't know the
   * user wanted to drop a pier next. Wrapped here so every pier-card
   * click goes through the same kind-flip.
   */
  function handleActivatePierMakeup(id: string) {
    setActivePierMakeupId(id)
    setActiveTypeKind('pier')
    // Same UX nicety as the wall path — turn the highlight back on
    // so the user can spot any existing piers of this type.
    setShowActiveMakeupHighlight(true)
  }

  // ---------- Brick makeup CRUD ----------

  function handleAddBrickMakeup(makeup: BrickMakeup) {
    // Same area-resolution chain as handleAddMakeup — see comment
    // there for the reasoning. Auto-creates a 'New Area' if the
    // project has none, so a brick wall type can never end up
    // orphaned (areaId undefined).
    let stamped: BrickMakeup
    if (makeup.areaId) {
      stamped = makeup
    } else if (activeAreaId) {
      stamped = { ...makeup, areaId: activeAreaId }
    } else if (areas.length > 0) {
      stamped = { ...makeup, areaId: areas[0].id }
    } else {
      const newAreaId =
        typeof crypto !== 'undefined' &&
        typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `area-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      setAreas((prev) => [...prev, { id: newAreaId, name: 'New Area' }])
      setActiveAreaId(newAreaId)
      stamped = { ...makeup, areaId: newAreaId }
    }
    setBrickMakeups((prev) => [...prev, stamped])
    setActiveBrickMakeupId(stamped.id)
  }

  function handleUpdateBrickMakeup(updated: BrickMakeup) {
    // Capture prev BEFORE applying the update so we can detect a height
    // change and propagate it. Two reasons we need this propagation:
    //
    //  1. Legacy projects (and any walls drawn before the draw-time
    //     stamp was removed) carry heightMmOverride set to whatever
    //     the makeup height was at draw time. That override wins
    //     forever in the calc precedence chain, so the user editing
    //     the wall type's height does nothing for those walls without
    //     this sweep.
    //  2. There's no per-wall height-override UI for brick walls right
    //     now — every heightMmOverride on a brick wall today is a
    //     stale draw-time stamp, never user-explicit. Safe to clear
    //     unconditionally when the wall type's height changes. If a
    //     per-wall override surface ever lands, this sweep needs a
    //     "user-set" flag to avoid clobbering deliberate overrides.
    const prevMakeup = brickMakeups.find((m) => m.id === updated.id)
    setBrickMakeups((prev) => prev.map((m) => (m.id === updated.id ? updated : m)))

    const heightChanged =
      prevMakeup &&
      typeof prevMakeup.heightMm === 'number' &&
      typeof updated.heightMm === 'number' &&
      prevMakeup.heightMm !== updated.heightMm

    if (heightChanged) {
      setWallsByPage((pages) => {
        const next: Record<number, Wall[]> = {}
        let changed = false
        for (const [pageStr, pageWalls] of Object.entries(pages)) {
          const pageNum = Number(pageStr)
          next[pageNum] = pageWalls.map((w) => {
            if (
              w.makeupId === updated.id &&
              w.heightMmOverride !== undefined
            ) {
              changed = true
              const { heightMmOverride: _drop, ...rest } = w
              void _drop
              return { ...rest, heightMmOverride: undefined } as Wall
            }
            return w
          })
        }
        return changed ? next : pages
      })
    }
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
    setShowActiveMakeupHighlight(true)
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
      // Brick mode: user types height directly; sill irrelevant for
      // tally (just stored as 0). 0mm is allowed — lintel-only
      // marker (counts the per-opening supply item without removing
      // any wall area). Reject negative only.
      if (brickOpeningHeightMm < 0) return
      openingHeightForSave = brickOpeningHeightMm
      sillForSave = 0
    } else {
      // Block mode: opening height = wall − sill − head. 0 allowed
      // (lintel-only marker — same rationale as brick mode).
      const makeup = makeupsById[wall.makeupId]
      const wallHeightMm = wall.heightMmOverride ?? (makeup ? getMakeupHeightMm(makeup) : 0)
      const computed = wallHeightMm - openingSillHeightMm - openingHeadHeightMm
      if (computed < 0) return
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
    // Use whatever pier makeup the user has active — even if its
    // `suggestedPlacement` is 'freestanding'. The hint controls the
    // unified-placement default at the toolbar, but if the user has
    // explicitly activated this type and clicked inside a wall body
    // we use ITS block, not a generic AU 40.925 fallback that
    // discarded their choice and made the placed pier render at the
    // wrong size.
    //
    // The legacy fallback path (find a tied-default makeup or create
    // one) only fires when there's no active pier at all — every
    // other case respects the user's pick.
    let makeupId = activePierMakeupId
    const active = makeupId
      ? pierMakeups.find((m) => m.id === makeupId)
      : null
    if (!active) {
      const us = getUserSettings()
      const defaultPattern = createDefaultTiedPierMakeup(undefined, us).coursePattern
      const dedup = pierMakeups.find(
        (m) =>
          m.suggestedPlacement === 'tied' &&
          m.coursePattern.length === defaultPattern.length &&
          m.coursePattern.every((c, i) => c === defaultPattern[i])
      )
      const fallback = dedup ?? pierMakeups.find((m) => m.suggestedPlacement === 'tied')
      if (fallback) {
        makeupId = fallback.id
      } else {
        const fresh = createDefaultTiedPierMakeup('Tied pier 1', us)
        setPierMakeups((prev) => [...prev, fresh])
        makeupId = fresh.id
      }
      setActivePierMakeupId(makeupId)
    }
    const pier: Pier = {
      id:
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `p-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type: 'tied',
      wallId,
      alongMm: clamped,
      pierMakeupId: makeupId!,
    }
    setPiersByPage((prev) => ({
      ...prev,
      [currentPage]: [...(prev[currentPage] ?? []), pier],
    }))
    setPlacingTiedPier(false)
  }, [mode, wallsByPage, currentPage, pierMakeups, activePierMakeupId])

  /** Place a freestanding pier at the click coordinates. Pier height comes
   *  from the active makeup (`makeup.heightMm`) so two freestanding piers of
   *  the same type are always the same height — edit the type's height in
   *  its modal to change them all together. */
  const handleFreestandingPierPlaced = useCallback(function handleFreestandingPierPlaced(xMm: number, yMm: number) {
    if (mode !== 'block') return
    let makeupId = activePierMakeupId
    let makeup = makeupId
      ? pierMakeups.find((m) => m.id === makeupId) ?? null
      : null
    // Respect the user's explicit active pier type regardless of its
    // suggestedPlacement hint — see the matching note in
    // handleTiedPierPlaced. The fallback only runs when no pier
    // makeup is active at all.
    if (!makeup) {
      const us = getUserSettings()
      const defaultPattern = createDefaultFreestandingPierMakeup(undefined, us).coursePattern
      const dedup = pierMakeups.find(
        (m) =>
          m.suggestedPlacement === 'freestanding' &&
          m.coursePattern.length === defaultPattern.length &&
          m.coursePattern.every((c, i) => c === defaultPattern[i])
      )
      const fallback = dedup ?? pierMakeups.find((m) => m.suggestedPlacement === 'freestanding')
      if (fallback) {
        makeupId = fallback.id
        makeup = fallback
      } else {
        const fresh = createDefaultFreestandingPierMakeup('Freestanding pier 1', us)
        setPierMakeups((prev) => [...prev, fresh])
        makeupId = fresh.id
        makeup = fresh
      }
      setActivePierMakeupId(makeupId)
    }
    const pier: Pier = {
      id:
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `p-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type: 'freestanding',
      x: xMm,
      y: yMm,
      // Inherit the type's height. Legacy fallback to 2400 if the makeup
      // predates the type-level height field.
      heightMm: makeup?.heightMm ?? FREESTANDING_PIER_INITIAL_HEIGHT_MM,
      pierMakeupId: makeupId!,
    }
    setPiersByPage((prev) => ({
      ...prev,
      [currentPage]: [...(prev[currentPage] ?? []), pier],
    }))
    setPlacingFreestandingPier(false)
  }, [mode, currentPage, pierMakeups, activePierMakeupId])

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

  // Ref mirror of the current anchor so handleRulerClick can read it
  // WITHOUT being inside a state updater. Critical: React 19 + Strict
  // Mode dev-invokes state updaters twice to detect impurity, and the
  // old version of this handler triggered setActiveMeasurementsByPage
  // INSIDE setRulerAnchorMm's updater — so every ruler got added
  // twice on a single placement. That manifested as a "Delete only
  // works on the second press" symptom (first press removed one
  // copy, second press removed the duplicate).
  const rulerAnchorRef = useRef(rulerAnchorMm)
  useLayoutEffect(() => {
    rulerAnchorRef.current = rulerAnchorMm
  }, [rulerAnchorMm])

  /**
   * Called by the canvas on a measurement click. First call sets the anchor;
   * second call commits a measurement and clears the anchor (ready for the
   * next one). Stays in ruler mode after each commit so the user can drop
   * multiple measurements in a row without re-clicking the tool button.
   *
   * Reads the previous anchor from a REF (not the closure) so the
   * function can call setRulerAnchorMm and setActiveMeasurementsByPage
   * as two independent, side-effect-free state setters — Strict Mode's
   * double-invoke pass would otherwise duplicate the measurement.
   */
  const handleRulerClick = useCallback(function handleRulerClick(posMm: { x: number; y: number }) {
    const prevAnchor = rulerAnchorRef.current
    if (prevAnchor === null) {
      setRulerAnchorMm(posMm)
      return
    }
    // Commit a new measurement and clear the anchor.
    const newId =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `m-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    // Route to whichever doc is active. References get persisted
    // measurements via setActiveMeasurementsByPage; primary stays
    // session-only as designed.
    setActiveMeasurementsByPage((all) => {
      const page = all[currentPage] ?? []
      return {
        ...all,
        [currentPage]: [...page, { id: newId, startMm: prevAnchor, endMm: posMm }],
      }
    })
    setRulerAnchorMm(null)
  }, [currentPage])

  function handleClearMeasurements() {
    setActiveMeasurementsByPage((all) => ({ ...all, [currentPage]: [] }))
    setRulerAnchorMm(null)
  }

  // ---------- Pier makeup CRUD ----------

  function handleAddPierMakeup(makeup?: PierMakeup) {
    // The new merged WallTypesPanel pier modal builds the PierMakeup
    // itself (name, pattern, placement) and passes it through. Older
    // call paths that just want a blank default still work — we fall
    // back to createDefaultTiedPierMakeup when no makeup is supplied,
    // threading user settings through so the seed uses their preferred
    // pier + corner blocks (not the AU 40.925 / 20.01 literals).
    const next = makeup ?? createDefaultTiedPierMakeup('New pier type', getUserSettings())
    setPierMakeups((prev) => [...prev, next])
  }

  function handleUpdatePierMakeup(updated: PierMakeup) {
    setPierMakeups((prev) => prev.map((m) => (m.id === updated.id ? updated : m)))
    // Propagate the type's heightMm to every freestanding pier of this type
    // so the modal's height field is the single editing surface. Tied piers
    // are unaffected (they always inherit the host wall's height).
    if (updated.suggestedPlacement === 'freestanding' && typeof updated.heightMm === 'number') {
      const newHeight = updated.heightMm
      setPiersByPage((prev) => {
        const next: Record<number, Pier[]> = {}
        let changed = false
        for (const [pageStr, piers] of Object.entries(prev)) {
          const pageNum = Number(pageStr)
          next[pageNum] = piers.map((p) => {
            if (p.type === 'freestanding' && p.pierMakeupId === updated.id && p.heightMm !== newHeight) {
              changed = true
              return { ...p, heightMm: newHeight }
            }
            return p
          })
        }
        return changed ? next : prev
      })
    }
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
      // If the deleted makeup was the active one, switch the active id to
      // the first remaining makeup so the next pier-draw has a valid target.
      if (activePierMakeupId === id) {
        setActivePierMakeupId(remaining[0]?.id ?? null)
      }
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

      // No through-wall face pull. Drag position is taken as-is; the live
      // face snap during drag already put the cursor on the face.
      const snapped = newPositionMm

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

  // Delete / Backspace removes every selected wall, opening, pier, and
  // measurement — single- or multi-selection. Walls are deleted last (so
  // attached openings/piers vanish along the way without us needing to
  // special-case them). A ref mirrors the current selection so the
  // (always-registered) keydown handler reads fresh values without
  // depending on effect re-registration timing — previously the first
  // Delete after clicking a measurement could miss because the listener
  // hadn't re-registered with the new selection in its closure yet.
  const selectionRef = useRef({
    wallIds: selectedWallIds,
    openingIds: selectedOpeningIds,
    pierIds: selectedPierIds,
    measurementId: selectedMeasurementId,
    currentPage,
  })
  // useLayoutEffect (not useEffect) so the ref is mirrored synchronously
  // after every render — before the browser can paint or process the next
  // keystroke. Stops the keydown listener from reading a stale selection
  // even if Delete fires immediately after a click.
  useLayoutEffect(() => {
    selectionRef.current = {
      wallIds: selectedWallIds,
      openingIds: selectedOpeningIds,
      pierIds: selectedPierIds,
      measurementId: selectedMeasurementId,
      currentPage,
    }
  }, [selectedWallIds, selectedOpeningIds, selectedPierIds, selectedMeasurementId, currentPage])

  // Refs to the latest deletion handlers — handleWallDelete and friends
  // close over component-scope state (currentPage, makeupsById, mode, ...)
  // which changes between renders. If the keydown listener (registered
  // once with [] deps) called the handlers DIRECTLY, it'd be calling the
  // initial-render versions with stale closures — leading to "select +
  // Backspace clears selection but doesn't delete" because the stale
  // closure operates on the wrong page / makeup data. Routing through
  // refs that we update every render keeps the listener using fresh
  // logic without re-registering the listener on every keystroke.
  const handleWallDeleteRef = useRef(handleWallDelete)
  const handleOpeningDeleteRef = useRef(handleOpeningDelete)
  const handleDeletePierRef = useRef(handleDeletePier)
  handleWallDeleteRef.current = handleWallDelete
  handleOpeningDeleteRef.current = handleOpeningDelete
  handleDeletePierRef.current = handleDeletePier
  // Same trick for the view-aware measurement setter. Without the
  // ref, the always-registered keydown listener captured render 1's
  // closure (activeReferenceDocId=null) and routed every Delete to
  // the primary's session-only measurementsByPage — so deleting a
  // ruler dropped on a reference page silently filtered the wrong
  // slice on the first press, only working once the user pressed
  // Delete a second time after reselecting.
  const setActiveMeasurementsByPageRef = useRef(setActiveMeasurementsByPage)
  setActiveMeasurementsByPageRef.current = setActiveMeasurementsByPage

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      // Both Delete and Backspace remove selected items — macOS has no
      // standalone Delete key on most keyboards, and Backspace is the
      // universal "remove" gesture. The typed-length editor while drawing
      // a wall only fires when there's an in-progress wall AND no item is
      // selected (its handler in WallDrawingLayer runs first and consumes
      // the event in that mode), so the two uses don't conflict in
      // practice.
      if (e.key !== 'Delete' && e.key !== 'Backspace') return
      const tgt = e.target as HTMLElement | null
      if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA')) return
      const sel = selectionRef.current
      if (
        sel.wallIds.size === 0 &&
        sel.openingIds.size === 0 &&
        sel.pierIds.size === 0 &&
        !sel.measurementId
      ) return
      e.preventDefault()
      const wallIds = Array.from(sel.wallIds)
      const openingIds = Array.from(sel.openingIds)
      const pierIds = Array.from(sel.pierIds)
      const measurementId = sel.measurementId
      for (const id of pierIds) handleDeletePierRef.current(id)
      for (const id of openingIds) handleOpeningDeleteRef.current(id)
      for (const id of wallIds) handleWallDeleteRef.current(id)
      if (measurementId) {
        // Route through the ref so the setter reflects the CURRENT
        // active doc — primary's measurementsByPage when on primary,
        // the right reference's per-doc slice when on a reference.
        setActiveMeasurementsByPageRef.current((all) => {
          const page = sel.currentPage
          const pageMs = all[page] ?? []
          const remaining = pageMs.filter((m) => m.id !== measurementId)
          if (remaining.length === pageMs.length) return all
          return { ...all, [page]: remaining }
        })
        setSelectedMeasurementId(null)
      }
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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

  // Per-page calibration + intrinsic dimensions used to be declared here;
  // hoisted up to the top of the component so the dirty-tracker effect
  // can include it in its dep array without hitting the TDZ.

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
  /**
   * Ref on the INNER (transformed) page wrapper — the div whose CSS
   * `transform: scale(visualScale)` provides the smooth visual zoom
   * between PDF re-rasters. The wheel handler mutates its style.transform
   * directly so the visual zoom updates without waiting for React to
   * re-render the (very large) PdfWorkspace tree. Keep in sync with the
   * JSX site at the bottom of this file.
   */
  const innerPageWrapperRef = useRef<HTMLDivElement>(null)
  const sidebarRef = useRef<HTMLDivElement>(null)
  /**
   * Refs the wheel handler reads to compute the new visual size +
   * transform without going through React state. Updated by an effect
   * whenever the source values change so they're always current.
   */
  const renderedZoomRef = useRef(1)
  const renderedPageWidthRef = useRef(0)
  const renderedPageHeightRef = useRef<number | null>(null)
  /**
   * Debounced React commit timer for zoom. The wheel handler updates
   * the DOM immediately on every rAF tick and queues a setZoom() that
   * fires once the user pauses, so the rest of the React tree only
   * re-renders at the END of the gesture instead of on every frame.
   */
  const zoomCommitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
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

  // Swap to the active-doc slice so reference-page scale + intrinsic
  // dims show up correctly when the user has flipped to a reference;
  // primary view falls back to the primary's pagesData via the
  // selector.
  const pageData = activePagesData[currentPage]
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
        let activeMakeupForW: WallMakeup | undefined
        if (mode === 'block') {
          activeMakeupForW = makeupsById[activeMakeupId]
          if (!activeMakeupForW) return
        }
        e.preventDefault()
        // Route to curve-draw when the active makeup is configured
        // for curves (kind: 'curved' or legacy curveRadiusMm set);
        // otherwise straight wall draw. Mirrors the toolbar button.
        const isCurveType =
          !!activeMakeupForW &&
          (activeMakeupForW.kind === 'curved' ||
            typeof activeMakeupForW.curveRadiusMm === 'number')
        if (isCurveType) {
          const next = !drawingCurveMode
          clearOtherModes()
          setDrawingCurveMode(next)
        } else {
          const next = !drawingMode
          clearOtherModes()
          setDrawingMode(next)
        }
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

  // Keep the rendered-zoom / rendered-page-size refs in sync so the
  // wheel handler can compute the new visual transform + width/height
  // without going through React state. These are written on every
  // commit but read on every wheel tick.
  useEffect(() => {
    renderedZoomRef.current = renderedZoom
    renderedPageWidthRef.current = renderedPageWidth
    renderedPageHeightRef.current = renderedPageHeight
  }, [renderedZoom, renderedPageWidth, renderedPageHeight])

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
    // Quantise to the nearest raster STOP (mipmap-style) so we only
    // re-raster when crossing a stop boundary, not on every settled
    // zoom value. See RENDER_ZOOM_STOPS for the rationale.
    const target = quantiseRenderZoom(Math.min(zoom, MAX_RENDERED_ZOOM))
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

      // ── Zoom-to-cursor anchor ──────────────────────────────────
      // Read the page wrapper's actual DOM position via
      // getBoundingClientRect so the anchor is robust against any
      // flex / padding / centring layout the browser computed.
      //
      // Steps:
      //   1. Capture the cursor's WORLD position over the page (in the
      //      zoom-independent baseWidth units) at the current zoom.
      //   2. Mutate the page wrapper's DOM dimensions + inner transform
      //      DIRECTLY (no React) so the visual update lands this rAF
      //      tick instead of waiting for a full PdfWorkspace re-render.
      //   3. Re-read the page rect after mutation and shift scroll so
      //      the same world point lands back under the cursor.
      //   4. Debounce a setZoom() commit so the rest of the React tree
      //      (sidebars, toolbar zoom %, etc.) updates ONCE when the
      //      gesture pauses instead of on every frame.
      const pageEl = pageWrapperRef.current
      const innerEl = innerPageWrapperRef.current
      const container = containerRef.current
      if (!pageEl || !innerEl || !container) {
        // Page wrapper not mounted (upload zone, etc.) — just apply
        // zoom through React state and skip the DOM-mutation path.
        zoomRef.current = newZoom
        if (zoomCommitTimerRef.current) clearTimeout(zoomCommitTimerRef.current)
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

      // 1) Synchronously bump the zoom ref so the NEXT wheel tick reads
      //    our new zoom, not the (still-stale) React state.
      zoomRef.current = newZoom

      // 2) Direct DOM mutation for the wrapper sizes + inner transform.
      //    Bypasses React so each rAF tick gets a visual update in <1ms
      //    instead of waiting for the (large) PdfWorkspace tree to
      //    reconcile.
      const renderedZ = renderedZoomRef.current || 1
      const renderedW = renderedPageWidthRef.current
      const renderedH = renderedPageHeightRef.current
      const visualScaleNow = newZoom / renderedZ
      const visualWidthNow = renderedW * visualScaleNow
      const visualHeightNow = renderedH != null ? renderedH * visualScaleNow : null
      pageEl.style.width = `${visualWidthNow}px`
      if (visualHeightNow != null) {
        pageEl.style.height = `${visualHeightNow}px`
      }
      innerEl.style.transform = `scale(${visualScaleNow})`

      // 3) Reconcile scroll so the cursor's world point stays put.
      //    Re-reading the rect after the DOM mutation gives us the
      //    actual new position (which depends on flex centring etc.).
      const newPageRect = pageEl.getBoundingClientRect()
      const currentWorldVisualLeft = newPageRect.left + worldX * newZoom
      const currentWorldVisualTop = newPageRect.top + worldY * newZoom
      const deltaX = currentWorldVisualLeft - pendingClientX
      const deltaY = currentWorldVisualTop - pendingClientY
      const maxLeft = Math.max(0, container.scrollWidth - container.clientWidth)
      const maxTop = Math.max(0, container.scrollHeight - container.clientHeight)
      container.scrollLeft = Math.max(0, Math.min(maxLeft, container.scrollLeft + deltaX))
      container.scrollTop = Math.max(0, Math.min(maxTop, container.scrollTop + deltaY))

      // 4) Debounce the React state commit so consumers that depend on
      //    `zoom` (toolbar %, layout effects, render of giant subtrees)
      //    only re-run once the user pauses. 80 ms is short enough to
      //    feel instantaneous when the gesture ends and long enough to
      //    coalesce a continuous trackpad pinch into a single render.
      //
      //    Also stash the anchor for the post-commit useLayoutEffect to
      //    consume — it re-anchors after the PDF re-rasters at 300 ms,
      //    keeping the cursor pinned through the canvas swap.
      zoomAnchorRef.current = {
        cursorClientX: pendingClientX,
        cursorClientY: pendingClientY,
        worldX,
        worldY,
      }
      if (zoomCommitTimerRef.current) clearTimeout(zoomCommitTimerRef.current)
      zoomCommitTimerRef.current = setTimeout(() => {
        zoomCommitTimerRef.current = null
        setZoom(newZoom)
      }, 80)
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
      if (zoomCommitTimerRef.current) {
        clearTimeout(zoomCommitTimerRef.current)
        zoomCommitTimerRef.current = null
      }
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
    // Pan / wheel handlers attach for both PDF mode AND empty-workspace
    // mode — the latter has no pdfFile but still has a pannable virtual
    // page inside the same container. Without this, empty workspace was
    // mountable but the page wouldn't move on drag.
    if (!pdfFile && !isEmptyWorkspace) return

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
  }, [pdfFile, isEmptyWorkspace])

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
    // Only re-anchor after the FINAL pass (renderedZoom has caught up
    // to the clamped target). The interactive wheel handler already
    // anchored on every rAF tick via direct DOM mutation, so running
    // again here on every intermediate `zoom` commit would double-
    // shift the scroll and yank the page sideways. We only need this
    // effect to handle the PDF re-raster snap that happens 300 ms
    // after the gesture ends — the canvas swap can nudge the wrapper
    // a sub-pixel amount and the anchor pulls the cursor back onto its
    // world point.
    // Compare against the QUANTISED target — renderedZoom now snaps to
    // discrete RENDER_ZOOM_STOPS, not the raw clamped zoom, so a raw
    // comparison would never agree once stops are in play.
    if (renderedZoom !== quantiseRenderZoom(Math.min(zoom, MAX_RENDERED_ZOOM))) return
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
    zoomAnchorRef.current = null
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
      // Copy through a freshly-constructed ArrayBuffer so BlobPart's
      // strict ArrayBuffer type accepts it. outBytes is typed as
      // Uint8Array<ArrayBufferLike> in TS 5.x (which includes
      // SharedArrayBuffer), but File/Blob constructors want a strict
      // ArrayBuffer. Building a fresh one + copying the bytes is the
      // cleanest way through that without an `as` cast.
      const safeBuffer = new ArrayBuffer(outBytes.byteLength)
      new Uint8Array(safeBuffer).set(outBytes)
      const newFile = new File([safeBuffer], pagePicker.file.name, {
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
    // Use the SVG's native client → user coord transform. createSVGPoint +
    // getScreenCTM().inverse() handles every CSS transform up the ancestor
    // chain natively, including the visualScale on the parent wrapper. The
    // previous (clientX − rect.left) / visualScale form depended on the
    // ancestor chain only having one scale transform, which broke in subtle
    // ways when ratios fell out of sync. Falls back to the bounding-rect
    // calculation if the browser can't resolve a CTM (very rare).
    const svg = svgRef.current
    if (!svg) return { x: 0, y: 0 }
    const ctm = svg.getScreenCTM()
    if (ctm) {
      const pt = svg.createSVGPoint()
      pt.x = e.clientX
      pt.y = e.clientY
      const local = pt.matrixTransform(ctm.inverse())
      return { x: local.x, y: local.y }
    }
    const rect = svg.getBoundingClientRect()
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
    // Route the read + write through the active-doc slice so
    // calibrating a reference page writes into that reference's
    // pagesDataByDocId slot, not the primary's pagesData.
    const pageWidthMm = activePagesData[currentPage]?.pageWidthMm
    if (!pageWidthMm) return
    const pxAtRenderedZoom = distance(calPoint1, calPoint2)
    if (pxAtRenderedZoom < 2) return
    const pageMmBetweenClicks =
      (pxAtRenderedZoom * pageWidthMm) / (baseWidth * renderedZoom)
    const ratio = mm / pageMmBetweenClicks
    setActivePagesData((prev) => ({
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
    const data = activePagesData[currentPage]
    if (!data?.pageWidthMm) return
    // Ratio (e.g. 100 for 1:100) IS the canonical scale invariant — write it
    // straight through. The canvas-pixel scale is derived at render time
    // from this ratio + pageWidthMm + the current `baseWidth`.
    setActivePagesData((prev) => ({
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
            </div>
            <div className="px-6 py-4 border-t border-ink-600 flex items-center justify-between gap-2">
              <span className="text-xs text-ink-400">
                You can edit these later from Project details.
              </span>
              <button
                onClick={() => {
                  // Drop the gate first so the workspace renders immediately,
                  // then persist in the background. This is the moment the
                  // project officially "exists" — saving it now means it shows
                  // up on the dashboard's Projects list even if the user
                  // closes the tab before uploading a PDF or drawing
                  // anything. handleSaveProject is safe with no pdfFile +
                  // empty walls/pages, and the savingRef guard keeps a
                  // racing autosave at bay.
                  setStartupGateOpen(false)
                  void handleSaveProject()
                }}
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
      // Upload zone mirrors the workspace layout: ProjectBar in normal flow,
      // sticky workspace area below it taking one visual viewport. The
      // header + ProjectBar scroll OFF when the user scrolls; the sticky
      // drop zone + right rail stay pinned.
      <div className="w-full">
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
            createdByDisplayName={createdByDisplayName}
            referenceNumber={referenceNumber}
            isSaving={isSaving}
            onSave={handleSaveProject}
            onToggleStatus={handleToggleProjectStatus}
            onDelete={handleDeleteProject}
            onOpenDetails={() => setDetailsDrawerOpen(true)}
            onExport={() => setExportModalOpen(true)}
            canExport={allWallsRaw.length > 0}
          />
        )}

        {/* Project details drawer (overlay) */}
        <ProjectDetailsDrawer
          open={detailsDrawerOpen}
          details={projectDetails}
          onChange={setProjectDetails}
          onClose={() => setDetailsDrawerOpen(false)}
        />

        <div className="sticky top-0 h-[calc(100vh/0.88)] relative flex flex-col px-20 pt-2 pb-4 bg-ink-900">
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
            <aside className="w-full mt-3 space-y-4 lg:w-[340px] lg:flex-shrink-0 lg:mt-0 lg:min-h-0 lg:overflow-y-auto">
              {mode === 'block' && (
                <WallTypesPanel
                  // Per-area filter — same as the main render below.
                  makeups={
                    activeAreaId
                      ? makeups.filter((m) => m.areaId === activeAreaId)
                      : makeups
                  }
                  activeMakeupId={activeMakeupId}
                  wallCountsByMakeupId={wallCountsByMakeupId}
                  onSetActive={handleActivateMakeup}
                  onAddMakeup={handleAddMakeup}
                  onUpdateMakeup={handleUpdateMakeup}
                  onDeleteMakeup={handleDeleteMakeup}
                  pierMakeups={pierMakeups}
                  pierCountsByMakeupId={pierCountsByMakeupId}
                  activePierMakeupId={activePierMakeupId}
                  onSetActivePier={handleActivatePierMakeup}
            activeTypeKind={activeTypeKind}
                  onAddPierMakeup={handleAddPierMakeup}
                  onUpdatePierMakeup={handleUpdatePierMakeup}
                  onDeletePierMakeup={handleDeletePierMakeup}
                />
              )}
              {mode === 'brick' && (
                <BrickTypesPanel
                  makeups={
                    activeAreaId
                      ? brickMakeups.filter((m) => m.areaId === activeAreaId)
                      : brickMakeups
                  }
                  activeMakeupId={activeBrickMakeupId}
                  wallCountsByMakeupId={wallCountsByMakeupId}
                  onSetActive={handleActivateBrickMakeup}
                  onAddMakeup={handleAddBrickMakeup}
                  onUpdateMakeup={handleUpdateBrickMakeup}
                  onDeleteMakeup={handleDeleteBrickMakeup}
                />
              )}
            </aside>
          </div>
        </div>
      </div>
    )
  }

  // ---------- Render: workspace ----------

  return (
    // Outer is just normal flow inside the scrollable page wrapper —
    // ProjectBar takes its natural height, then the workspace area below
    // sticks to the top of the viewport so it stays visible while the
    // Beme header + ProjectBar scroll OFF the top when the user scrolls
    // down. No flex chain needed at this level.
    //
    // bg-ink-900 here so the page-bg white never bleeds through ANY gap
    // around the sticky workspace area (whose 113.6vh height can differ
    // from the viewport at various scroll positions). Also belt-and-
    // braces in case the canvas-area or 3D wrapper ever has unfilled
    // space — the parent dark bg masks it instead of showing white.
    <div className="w-full bg-ink-900">
      {pagePickerModal}
      {/* Slim project bar — sits in normal flow above the workspace so it
          scrolls away on page-scroll-down, freeing more visual height for
          the canvas + right rail below. */}
      {(mode === 'block' || mode === 'brick') && (
        <ProjectBar
          details={projectDetails}
          isSaved={currentProjectId !== null}
          status={projectStatus}
          lastSavedAt={lastSavedAt}
          canSave={canSave}
          saveBlockedReason={saveBlockedReason}
          mode={mode}
          createdByDisplayName={createdByDisplayName}
          isSaving={isSaving}
          onSave={handleSaveProject}
          onToggleStatus={handleToggleProjectStatus}
          onDelete={handleDeleteProject}
          onOpenDetails={() => setDetailsDrawerOpen(true)}
          onExport={() => setExportModalOpen(true)}
          canExport={allWallsRaw.length > 0}
        />
      )}

      {/* Project details drawer (overlay) */}
      <ProjectDetailsDrawer
        open={detailsDrawerOpen}
        details={projectDetails}
        onChange={setProjectDetails}
        onClose={() => setDetailsDrawerOpen(false)}
      />

      {/* Reference-PDF page picker. Renders the first file in the
          pending queue; importing or cancelling pops it. Multi-file
          drops process one at a time so the user sees a separate
          picker per PDF (rare in practice — usually one file at a
          time). */}
      {pendingReferenceFiles.length > 0 && (
        <ReferencePagePickerModal
          file={pendingReferenceFiles[0]}
          onImport={(selectedPages) =>
            commitReferenceFile(pendingReferenceFiles[0], selectedPages)
          }
          onCancel={cancelReferenceImport}
        />
      )}

      {/* Workspace area — `position: sticky top-0` so it stays pinned to
          the top of the viewport while the Beme header + ProjectBar
          scroll OFF when the user scrolls down. Explicit height = one
          visual viewport (compensates for html zoom 0.88) so the canvas
          and right rail below take up the full visible area once the
          header chrome has scrolled away. The PDF pan container still has
          its own internal scroll for the plan content. */}
      <div className="sticky top-0 h-[calc(100vh/0.88)] relative flex flex-col px-20 pt-2 pb-4 bg-ink-900">

      {/* Unified toolbar — file tabs · page nav · zoom · scale · replace in
          one row. The old separate file-switcher row was redundant because
          its PRIMARY tab already shows the active file name; merging into
          this row saves ~40px of vertical space above the canvas.

          Doubles as the reference-PDF drop zone — drop a file anywhere on
          the bar and the page-picker fires. The drop handler lives at the
          OUTER toolbar (not just on the file-tab strip) because the inner
          strip's overflow-x-auto and narrow flex-children make it a
          finicky drop target; the whole row is a more forgiving hit area.
          Non-PDFs are filtered inside queueReferenceFiles so dropping the
          wrong type is a silent no-op. */}
      <div
        onDragEnter={(e) => {
          // Files come over from outside the page; internal drags (text,
          // an element) don't carry a `Files` type, so check effectiveAllowed
          // / items defensively before lighting up the visual feedback.
          e.preventDefault()
          if (!isDraggingReferenceFile) setIsDraggingReferenceFile(true)
        }}
        onDragOver={(e) => {
          e.preventDefault()
          e.dataTransfer.dropEffect = 'copy'
          if (!isDraggingReferenceFile) setIsDraggingReferenceFile(true)
        }}
        onDragLeave={(e) => {
          if (e.currentTarget.contains(e.relatedTarget as Node)) return
          setIsDraggingReferenceFile(false)
        }}
        onDrop={(e) => {
          e.preventDefault()
          setIsDraggingReferenceFile(false)
          queueReferenceFiles(Array.from(e.dataTransfer.files))
        }}
        className={`flex items-center mb-2 px-3 py-1.5 bg-ink-800 border rounded-lg gap-3 flex-wrap transition-colors ${
          isDraggingReferenceFile
            ? 'border-beme-500 bg-beme-500/10'
            : 'border-ink-600'
        }`}
      >

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
          // Drop handlers moved up to the outer toolbar wrapper so
          // the whole bar is a forgiving drop target; here we just
          // keep the inner strip's flex/overflow layout.
          // File tabs row. Streamlined for screen widths that have
          // every other toolbar group (page nav, zoom, scale, 2D/3D)
          // competing for the same horizontal space:
          //   - dropped the standalone "FILE" eyebrow (decorative)
          //   - dropped the per-tab "PRIMARY" / "REF" inline labels
          //     (the active-state styling already differentiates)
          //   - tightened filename truncation max-w to 9rem
          // Hovering any tab still shows the full filename via title.
          <div className="flex items-center gap-1.5 min-w-0 overflow-x-auto">
            <button
              onClick={() => switchPdf(null)}
              className={`px-2.5 py-1 rounded-md text-sm border whitespace-nowrap transition-colors ${
                !isReferenceView
                  ? 'bg-beme-500/15 border-beme-500/40 text-beme-300 font-medium'
                  : 'border-ink-600 text-ink-200 hover:bg-ink-700'
              }`}
              title={pdfFile?.name ?? 'Primary plan'}
            >
              <span className="truncate max-w-[9rem] inline-block align-middle">
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
                    className={`pl-2.5 pr-1 py-1 text-sm ${active ? 'font-medium' : ''}`}
                    title={f.name}
                  >
                    <span className="truncate max-w-[9rem] inline-block align-middle">
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
                      const removedId = referencePdfIds[i]
                      setReferencePdfFiles((prev) => prev.filter((_, idx) => idx !== i))
                      setReferencePdfPaths((prev) => prev.filter((_, idx) => idx !== i))
                      setReferencePdfIds((prev) => prev.filter((_, idx) => idx !== i))
                      setReferencePdfSelectedPages((prev) =>
                        prev.filter((_, idx) => idx !== i)
                      )
                      // Drop the removed doc's per-doc slices so we
                      // don't leak stale scale / measurement data into
                      // future saves.
                      if (removedId) {
                        setReferencePdfPagesDataById((prev) => {
                          const { [removedId]: _drop, ...rest } = prev
                          void _drop
                          return rest
                        })
                        setReferencePdfMeasurementsByPageById((prev) => {
                          const { [removedId]: _drop, ...rest } = prev
                          void _drop
                          return rest
                        })
                      }
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
                // Route through the page-picker queue rather than
                // adding files directly — the picker decides which
                // pages of each PDF land in the project.
                queueReferenceFiles(Array.from(e.target.files ?? []))
                // Reset the input so picking the same file again still fires change.
                e.target.value = ''
              }}
            />
            <button
              onClick={() =>
                document.getElementById('reference-pdf-input')?.click()
              }
              className="px-2.5 py-1 rounded-md text-sm border border-dashed border-ink-600 text-ink-300 hover:border-beme-500/60 hover:text-beme-300 transition-colors whitespace-nowrap shrink-0"
              title="Attach another PDF — engineering, architectural, etc. (also accepts drag-and-drop)"
            >
              + Reference
            </button>
            {isReferenceView && activeReferenceIndex !== null && (
              // Promote: take the active reference and make it the new
              // primary. Wipes drawn quantities tied to the old primary
              // (new plan = new scale = walls in wrong places). The old
              // primary moves into references so it's not lost. The
              // "scale + rulers only" hint that used to live alongside
              // has been folded into this button's tooltip — the row
              // was getting cluttered on narrow viewports.
              <button
                onClick={() => promoteReferenceToPrimary(activeReferenceIndex)}
                className="px-2.5 py-1 rounded-md text-sm border border-beme-500/40 bg-beme-500/[0.08] text-beme-200 hover:bg-beme-500/[0.15] hover:border-beme-500/70 transition-colors whitespace-nowrap shrink-0"
                title="Promote this reference to the primary plan (clears all drawn walls). Until then, only scale + rulers are editable on references — drawing tools stay on the primary."
              >
                Make primary
              </button>
            )}
          </div>
        )}

        <div className="h-5 w-px bg-ink-600" />

        {/* Page nav — hidden in empty-workspace mode (single virtual page).
            In reference view with a picked-pages subset, the < > buttons
            step through only the picked pages, and the counter reads
            "Page 2 of 3 picked" instead of the raw PDF page count. */}
        {!isEmptyWorkspace && (() => {
          // Build the visible-pages list once per render. In primary
          // view (or a reference with no pick) it's the full [1..N];
          // otherwise it's the picked subset. The page-nav math
          // collapses to identical behaviour for the unfiltered case.
          const visiblePages: number[] =
            activeReferenceSelectedPages && activeReferenceSelectedPages.length > 0
              ? activeReferenceSelectedPages
              : Array.from({ length: numPages }, (_, i) => i + 1)
          const visibleIndex = visiblePages.indexOf(currentPage)
          const safeIndex = visibleIndex >= 0 ? visibleIndex : 0
          const atStart = safeIndex <= 0
          const atEnd = safeIndex >= visiblePages.length - 1
          const goPrev = () => {
            if (atStart) return
            setCurrentPage(visiblePages[safeIndex - 1])
          }
          const goNext = () => {
            if (atEnd) return
            setCurrentPage(visiblePages[safeIndex + 1])
          }
          return (
          <>
            <div className="flex items-center gap-1">
              <button
                onClick={goPrev}
                disabled={atStart}
                className="px-2 py-1 rounded border border-ink-600 text-sm hover:bg-ink-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                aria-label="Previous page"
              >
                ←
              </button>
              <span
                className="text-sm text-ink-300 tabular-nums px-1 min-w-[3.5rem] text-center"
                title={
                  numPages
                    ? `Page ${currentPage} of ${visiblePages.length}`
                    : undefined
                }
              >
                {numPages ? `${currentPage} / ${visiblePages.length}` : '…'}
              </span>
              <button
                onClick={goNext}
                disabled={atEnd}
                className="px-2 py-1 rounded border border-ink-600 text-sm hover:bg-ink-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                aria-label="Next page"
              >
                →
              </button>
            </div>

            <div className="h-5 w-px bg-ink-600" />
          </>
          )
        })()}

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

        {/* 2D / 3D view toggle — flips the workspace between the Konva
            editing canvas and the mass-model 3D viewer. 3D is read-only
            (orbit camera, no editing) and lazy-loaded on first toggle so
            users who never open it pay zero bundle cost. */}
        <div className="inline-flex rounded-md border border-ink-600 overflow-hidden text-sm">
          <button
            onClick={() => setViewMode('2d')}
            className={`px-2.5 py-1 transition-colors ${
              viewMode === '2d'
                ? 'bg-beme-500/20 text-beme-300 font-medium'
                : 'text-ink-300 hover:bg-ink-700'
            }`}
            title="Edit walls on the 2D plan"
            aria-pressed={viewMode === '2d'}
          >
            2D
          </button>
          <button
            onClick={() => setViewMode('3d')}
            className={`px-2.5 py-1 border-l border-ink-600 transition-colors ${
              viewMode === '3d'
                ? 'bg-beme-500/20 text-beme-300 font-medium'
                : 'text-ink-300 hover:bg-ink-700'
            }`}
            title="Mass-model 3D view (read-only)"
            aria-pressed={viewMode === '3d'}
          >
            3D
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
          three areas are clean columns side by side — no overlap.
          flex-1 + min-h-0 throughout lets the canvas pan container fill
          to the bottom of its fixed-height parent. No page-level scroll —
          all PDF panning happens inside the canvas's own scrollable area,
          which keeps dragging the plan to any edge reliable.

          The horizontal Trade switcher sits at the top of the right
          rail (just above WallTypesPanel) — see below. */}
      <div className="flex-1 min-h-0 flex flex-col gap-3 lg:flex-row">

      {/* ───── Canvas area ─────
          Takes the remaining horizontal space between the thumbnails (if
          any) and the right rail. Flex column inside so the sticky drawing
          toolbar sits above the pan container which flex-fills the height. */}
      <div className="flex-1 min-w-0 min-h-0 w-full flex flex-col">

      {/* Sticky action bar — keeps drawing controls + banners glued to the top of the
          viewport while the user scrolls, so they don't need to scroll up to start a new
          wall/opening. Wraps the wall-drawing toolbar and all contextual banners/forms.

          Hidden in 3D mode. The toolbar contains drawing tools (Draw wall,
          Add opening, Pier, Ruler, etc.) that are inert in the read-only
          3D viewer, AND it eats ~100px of vertical space above the canvas
          area — leaving the 3D viewport short by exactly that amount vs.
          the right rail aside (which has no equivalent toolbar above it).
          Hiding the toolbar in 3D lets thumbnails+view (and therefore the
          3D wrapper) claim the full canvas-area height so the 3D viewport
          matches the rail's height. User flips back to 2D to draw. */}
      {viewMode !== '3d' && (
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
                  <span className="ml-2">Cut wall</span>
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
            {mode === 'block' && (
              <div>
                <kbd className="px-1.5 py-0.5 rounded border border-ink-600 bg-ink-900 text-ink-100 text-xs font-mono">Alt</kbd>
                <span className="text-ink-400 mx-1">+</span>
                <kbd className="px-1.5 py-0.5 rounded border border-ink-600 bg-ink-900 text-ink-100 text-xs font-mono">click</kbd>
                <span className="ml-2">Butt-joint at endpoint (no corner)</span>
              </div>
            )}
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
          <div className="text-sm flex-1 min-w-0">
            {/* The left slot of the toolbar is the *announcement zone* —
                whatever mode the user is in surfaces here (calibrate, draw,
                opening, ruler, etc.) replacing the stats summary. When the
                user exits the mode the stats come back. Earlier the
                various Click-here banners rendered as separate rows under
                this toolbar; that meant the toolbar height jumped each
                time. Folding everything into this single slot keeps the
                chrome the same height regardless of state.
                Priority order: calibrate input > calibrate click prompt >
                multi-select > drawing/placing modes > setup hints > stats. */}
            {calibrating && calPoint1 && calPoint2 ? (
              <div className="flex items-center gap-2 flex-wrap text-beme-200">
                <span className="font-medium whitespace-nowrap">
                  Real-world length of that line:
                </span>
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
                  className="px-2 py-1 border border-beme-500/40 rounded text-sm w-28 bg-ink-900 text-ink-50 focus:outline-none focus:border-beme-400"
                />
                <span>mm</span>
                <button
                  onClick={submitCalibration}
                  disabled={!calInput || parseFloat(calInput) <= 0}
                  className="px-3 py-1 rounded bg-beme-500 text-black text-xs font-medium hover:bg-beme-400 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  Save scale
                </button>
                <button
                  onClick={cancelCalibration}
                  className="px-2 py-1 rounded border border-ink-600 text-xs hover:bg-ink-700 transition-colors"
                >
                  Cancel
                </button>
              </div>
            ) : calibrating ? (
              <span className="text-beme-200">
                {!calPoint1
                  ? 'Click the first point along a known dimension on the plan. Zoom in for accuracy.'
                  : 'Click the second point.'}
              </span>
            ) : totalSelected >= 2 ? (
              <span className="text-sky-200">
                {selectionParts.join(' + ')} selected. Press{' '}
                <kbd className="px-1.5 py-0.5 rounded border border-sky-500/40 bg-ink-900 text-ink-100 text-xs font-mono">
                  Del
                </kbd>{' '}
                to remove all, or Shift+click to add/remove items.
              </span>
            ) : drawingMode ? (
              <span className="text-ink-50">
                Click two points on the plan to draw a wall. Press{' '}
                <kbd className="px-1.5 py-0.5 rounded border border-ink-600 bg-ink-900 text-ink-100 text-xs font-mono">
                  Esc
                </kbd>{' '}
                to cancel.
              </span>
            ) : drawingCurveMode ? (
              <span className="text-ink-50 inline-flex items-center gap-2 flex-wrap">
                <span>
                  Curved wall: click the <strong>first wall</strong>, then the{' '}
                  <strong>second wall</strong>, then a <strong>midpoint</strong> on the arc.
                </span>
                <label className="inline-flex items-center gap-1.5 text-xs">
                  <span className="text-ink-400">Height</span>
                  <input
                    type="number"
                    min={200}
                    step={200}
                    value={newCurveHeightMm}
                    onChange={(e) => {
                      const n = Number(e.target.value)
                      if (Number.isFinite(n) && n > 0) setNewCurveHeightMm(n)
                    }}
                    title="Height for newly-created curved-wall types. Existing types keep their own height."
                    className="w-20 px-1.5 py-0.5 rounded border border-ink-600 bg-ink-900 text-ink-50 text-xs font-mono"
                  />
                  <span className="text-ink-400">mm</span>
                </label>
                <span>
                  Press{' '}
                  <kbd className="px-1.5 py-0.5 rounded border border-ink-600 bg-ink-900 text-ink-100 text-xs font-mono">
                    Esc
                  </kbd>{' '}
                  to cancel.
                </span>
              </span>
            ) : placingOpening ? (
              <span className="text-ink-50">
                Click two points along the same wall to define the opening. Press{' '}
                <kbd className="px-1.5 py-0.5 rounded border border-ink-600 bg-ink-900 text-ink-100 text-xs font-mono">
                  Esc
                </kbd>{' '}
                to cancel.
              </span>
            ) : placingControlJoint ? (
              <span className="text-ink-50">
                Click a wall where you want to <strong>cut</strong> it. The wall splits
                in two at that point, each side ending with its own termination. Press{' '}
                <kbd className="px-1.5 py-0.5 rounded border border-ink-600 bg-ink-900 text-ink-100 text-xs font-mono">
                  Esc
                </kbd>{' '}
                to cancel.
              </span>
            ) : placingFreestandingPier ? (
              <span className="text-ink-50">
                Click on a wall for a <strong>tied pier</strong> (height inherits
                the wall) or anywhere else for a <strong>freestanding pier</strong>
                {' '}(edit its height in the inspector after placing). Press{' '}
                <kbd className="px-1.5 py-0.5 rounded border border-ink-600 bg-ink-900 text-ink-100 text-xs font-mono">
                  Esc
                </kbd>{' '}
                to cancel.
              </span>
            ) : placingRuler ? (
              <span className="text-ink-50">
                Click two points on the plan to measure the distance between them. Press{' '}
                <kbd className="px-1.5 py-0.5 rounded border border-ink-600 bg-ink-900 text-ink-100 text-xs font-mono">
                  Esc
                </kbd>{' '}
                to cancel.
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
            {/* Unified placement button. When a wall type is active
                (activeTypeKind === 'wall'), this toggles two-click
                wall-draw mode. When a pier type is active, it
                toggles single-click pier-placement mode using the
                active pier makeup. Same button, same colour, same
                spot — the panel decides which mode you're in by
                which card you clicked. Disabled gates apply to
                both modes (need a scale, can't be on a reference,
                etc.). */}
            <button
              onClick={() => {
                if (activeTypeKind === 'pier') {
                  setPlacingFreestandingPier((v) => !v)
                  setPlacingTiedPier(false)
                  setDrawingMode(false)
                  setDrawingCurveMode(false)
                } else {
                  // Route to curve-draw when the active wall type is
                  // configured for curves (kind === 'curved' or has
                  // a legacy curveRadiusMm); otherwise straight-draw.
                  // Same button, the active type's kind decides which
                  // draw mode toggles on.
                  const m = makeupsById[activeMakeupId]
                  const isCurveType =
                    !!m &&
                    (m.kind === 'curved' ||
                      typeof m.curveRadiusMm === 'number')
                  if (isCurveType) {
                    setDrawingCurveMode((v) => !v)
                    setDrawingMode(false)
                  } else {
                    setDrawingMode((v) => !v)
                    setDrawingCurveMode(false)
                  }
                  setPlacingFreestandingPier(false)
                  setPlacingTiedPier(false)
                }
                setPlacingOpening(false)
                setPlacingControlJoint(false)
                setSelectedWallId(null)
                setSelectedOpeningId(null)
                setSelectedPierId(null)
              }}
              disabled={
                !currentScale ||
                calibrating ||
                isReferenceView ||
                (activeTypeKind === 'wall' &&
                  (missingActiveType || activeIsCurveMakeup)) ||
                (activeTypeKind === 'pier' && !activePierMakeupId)
              }
              title={
                isReferenceView
                  ? 'Drawing is disabled on reference PDFs — only the ruler is available. Switch back to the primary plan to draw.'
                  : activeTypeKind === 'pier'
                  ? 'Click on a wall for a tied pier; anywhere else for a freestanding pier. Uses the active pier type from the panel.'
                  : missingActiveType
                  ? 'Pick a wall type in the Wall types panel before drawing.'
                  : activeIsCurveMakeup
                  ? 'This wall type is bound to a curve — pick a straight wall type or use the Curved wall tool.'
                  : undefined
              }
              className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                drawingMode || placingFreestandingPier || placingTiedPier
                  ? 'bg-beme-400 text-black hover:bg-beme-300'
                  : 'bg-beme-500 text-black hover:bg-beme-400 disabled:opacity-40 disabled:cursor-not-allowed'
              }`}
            >
              {activeTypeKind === 'pier'
                ? placingFreestandingPier || placingTiedPier
                  ? 'Cancel pier'
                  : 'Place pier'
                : drawingMode
                ? 'Stop drawing'
                : 'Draw wall'}
            </button>
            {/* Curved wall + Pier triggers moved into the Wall types
                panel — see WallTypesPanel's onToggleCurvedWall and
                onTogglePierPlacement props. Keeps the toolbar focused
                on the two universal actions (Draw wall, Add opening)
                plus the situational tools (Cut wall, Ruler). */}
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
              disabled={
                !currentScale ||
                calibrating ||
                currentPageWalls.length === 0 ||
                isReferenceView
              }
              title={
                isReferenceView
                  ? 'Reference PDFs are read-only — switch to the primary plan to add openings.'
                  : undefined
              }
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
                disabled={
                  !currentScale ||
                  calibrating ||
                  currentPageWalls.length === 0 ||
                  isReferenceView
                }
                title={
                  isReferenceView
                    ? 'Reference PDFs are read-only — switch to the primary plan to split walls.'
                    : 'Click on a wall to cut it at that point (creates two independent walls with a sealant gap).'
                }
                className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                  placingControlJoint
                    ? 'bg-rose-700 text-white hover:bg-rose-800'
                    : 'bg-rose-600 text-white hover:bg-rose-700 disabled:opacity-40 disabled:cursor-not-allowed'
                }`}
              >
                {placingControlJoint ? 'Cancel cut' : '+ Cut wall'}
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
              {placingRuler ? 'Stop measuring' : 'Ruler'}
            </button>
            {((activeMeasurementsByPage[currentPage] ?? []).length > 0) && (
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

      {/* drawingMode / drawingCurveMode / placingOpening / placingControlJoint /
          placingFreestandingPier / placingRuler banners all moved INTO the
          wall-drawing toolbar's left slot. Chrome height stays the same
          regardless of which mode the user is in. */}

      {/* Pending opening form — block mode (sill + head, opening height computed) */}
      {pendingOpening && pendingOpeningWall && mode === 'block' && (() => {
        const pendingMakeup = makeupsById[pendingOpeningWall.makeupId]
        const wallHeightMm =
          pendingOpeningWall.heightMmOverride ?? pendingMakeup?.heightMm ?? 0
        const computedOpeningHeightMm = wallHeightMm - openingSillHeightMm - openingHeadHeightMm
        // 0mm openings are explicitly allowed — lets the user place a
        // lintel-only marker (counts toward the lintel supply item but
        // doesn't remove any wall area). Anything negative is still
        // invalid (sill + head exceeds the wall height).
        const tooSmall = computedOpeningHeightMm < 0
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
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
            onClick={handleCancelPendingOpening}
            role="dialog"
            aria-modal="true"
            aria-label="New opening"
          >
            <div
              className="w-full max-w-2xl bg-ink-800 border border-ink-600 rounded-xl shadow-xl shadow-black/40 overflow-hidden flex flex-col max-h-[90vh]"
              onClick={(e) => e.stopPropagation()}
            >
              {/* Header — matches the wall type / block editor modal pattern:
                  title + subtitle on the left, close button on the right. */}
              <header className="px-6 py-3.5 border-b border-ink-600 flex items-center justify-between bg-ink-900/40">
                <div className="min-w-0">
                  <h3 className="font-semibold text-ink-50">New opening</h3>
                  <p className="text-[11px] text-ink-500 mt-0.5">
                    On a {Math.round(wallHeightMm)} mm wall · {Math.round(pendingOpening.widthMm)} mm wide
                  </p>
                </div>
                <button
                  onClick={handleCancelPendingOpening}
                  className="text-ink-400 hover:text-ink-100 text-xl leading-none"
                  aria-label="Close"
                >
                  ×
                </button>
              </header>

              <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5 text-sm">
                {/* Presets — same blockOpeningPresets list as before, one
                    click sets both sill + head. Disabled when the preset
                    can't fit on this wall. */}
                <section>
                  <h4 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-400 mb-2">
                    Presets
                  </h4>
                  <div className="flex flex-wrap gap-1.5">
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
                          className="px-2.5 py-1 rounded-md border border-ink-600 bg-ink-900 text-ink-200 text-xs hover:border-beme-500/50 hover:text-beme-300 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                        >
                          {p.label}
                        </button>
                      )
                    })}
                  </div>
                </section>

                {/* Sill + Head inputs — manual override on top of (or
                    instead of) a preset. */}
                <section>
                  <h4 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-400 mb-2">
                    Dimensions
                  </h4>
                  <div className="grid grid-cols-2 gap-3">
                    <label className="block">
                      <span className="block text-ink-300 text-xs mb-1">Sill height (mm)</span>
                      <input
                        type="number"
                        min="0"
                        step="50"
                        value={openingSillHeightMm}
                        onChange={(e) => setOpeningSillHeightMm(parseInt(e.target.value || '0', 10))}
                        className="w-full px-3 py-2 border border-ink-600 rounded-lg text-sm bg-ink-900 text-ink-50 focus:outline-none focus:border-beme-400"
                      />
                    </label>
                    <label className="block">
                      <span className="block text-ink-300 text-xs mb-1">Head height (mm)</span>
                      <input
                        type="number"
                        min="0"
                        step="50"
                        value={openingHeadHeightMm}
                        onChange={(e) => setOpeningHeadHeightMm(parseInt(e.target.value || '0', 10))}
                        className="w-full px-3 py-2 border border-ink-600 rounded-lg text-sm bg-ink-900 text-ink-50 focus:outline-none focus:border-beme-400"
                      />
                    </label>
                  </div>
                </section>

                {/* Inline error when the sill + head exceed the wall
                    height — same signal that disables the Save button.
                    A 0mm opening is allowed (lintel-only marker) so
                    only negative space triggers the error. */}
                {tooSmall && (
                  <p className="text-[11px] text-rose-400 leading-relaxed">
                    Sill + Head exceed the {Math.round(wallHeightMm)}mm wall height.
                    Reduce one of them.
                  </p>
                )}
                {!tooSmall && computedOpeningHeightMm === 0 && (
                  <p className="text-[11px] text-ink-400 leading-relaxed">
                    0mm opening — counts toward lintel supply items but no
                    wall area is removed.
                  </p>
                )}
              </div>

              {/* Footer — Cancel / Save matches the wall type modal. */}
              <footer className="px-6 py-3 border-t border-ink-600 bg-ink-900/40 flex justify-end gap-2">
                <button
                  onClick={handleCancelPendingOpening}
                  className="px-4 py-1.5 rounded-lg border border-ink-600 text-ink-200 text-sm hover:bg-ink-700 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSavePendingOpening}
                  disabled={tooSmall}
                  className="px-4 py-1.5 rounded-lg bg-beme-500 text-black text-sm hover:bg-beme-400 disabled:opacity-40 disabled:cursor-not-allowed transition-colors font-semibold"
                >
                  Save opening
                </button>
              </footer>
            </div>
          </div>
        )
      })()}

      {/* Pending opening form — brick mode (just height) */}
      {pendingOpening && pendingOpeningWall && mode === 'brick' && (() => {
        // Mirror brickCalc's height precedence: per-wall override → wall
        // type's heightMm → project default. Keeps this modal's "Opening
        // on a {N}mm wall" caption in lockstep with the tallied area.
        const pendingMakeup = pendingOpeningWall.makeupId
          ? brickMakeups.find((m) => m.id === pendingOpeningWall.makeupId)
          : undefined
        const wallHeightMm =
          pendingOpeningWall.heightMmOverride ??
          pendingMakeup?.heightMm ??
          brickSettings.defaultWallHeightMm
        // 0mm allowed — see block-mode rationale above. Negative
        // values are still rejected (the input clamps to min=0 but
        // belt-and-braces guard here too).
        const tooSmall = brickOpeningHeightMm < 0
        const tooTall = brickOpeningHeightMm > wallHeightMm
        return (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
            onClick={handleCancelPendingOpening}
            role="dialog"
            aria-modal="true"
            aria-label="New opening"
          >
            <div
              className="w-full max-w-xl bg-ink-800 border border-ink-600 rounded-xl shadow-xl shadow-black/40 overflow-hidden flex flex-col max-h-[90vh]"
              onClick={(e) => e.stopPropagation()}
            >
              <header className="px-6 py-3.5 border-b border-ink-600 flex items-center justify-between bg-ink-900/40">
                <div className="min-w-0">
                  <h3 className="font-semibold text-ink-50">New opening</h3>
                  <p className="text-[11px] text-ink-500 mt-0.5">
                    On a {Math.round(wallHeightMm)} mm wall · {Math.round(pendingOpening.widthMm)} mm wide
                  </p>
                </div>
                <button
                  onClick={handleCancelPendingOpening}
                  className="text-ink-400 hover:text-ink-100 text-xl leading-none"
                  aria-label="Close"
                >
                  ×
                </button>
              </header>

              <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5 text-sm">
                <section>
                  <h4 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-400 mb-2">
                    Presets
                  </h4>
                  <div className="flex flex-wrap gap-1.5">
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
                        className="px-2.5 py-1 rounded-md border border-ink-600 bg-ink-900 text-ink-200 text-xs hover:border-beme-500/50 hover:text-beme-300 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                      >
                        {p.label}
                      </button>
                    ))}
                  </div>
                </section>

                <section>
                  <h4 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-400 mb-2">
                    Dimensions
                  </h4>
                  <label className="block">
                    <span className="block text-ink-300 text-xs mb-1">Opening height (mm)</span>
                    <input
                      type="number"
                      min="0"
                      step="50"
                      value={brickOpeningHeightMm}
                      onChange={(e) =>
                        setBrickOpeningHeightMm(parseInt(e.target.value || '0', 10))
                      }
                      className="w-40 px-3 py-2 border border-ink-600 rounded-lg text-sm bg-ink-900 text-ink-50 focus:outline-none focus:border-beme-400"
                      autoFocus
                    />
                    <span className="block text-[11px] text-ink-500 mt-1 leading-snug">
                      Use 0mm to place a lintel-only marker (counts the
                      lintel supply item without removing wall area).
                    </span>
                  </label>
                </section>

                {tooSmall && (
                  <p className="text-[11px] text-rose-400 leading-relaxed">
                    Opening height can't be negative.
                  </p>
                )}
                {tooTall && (
                  <p className="text-[11px] text-rose-400 leading-relaxed">
                    Opening height ({brickOpeningHeightMm}mm) exceeds the wall height ({Math.round(wallHeightMm)}mm).
                  </p>
                )}
              </div>

              <footer className="px-6 py-3 border-t border-ink-600 bg-ink-900/40 flex justify-end gap-2">
                <button
                  onClick={handleCancelPendingOpening}
                  className="px-4 py-1.5 rounded-lg border border-ink-600 text-ink-200 text-sm hover:bg-ink-700 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSavePendingOpening}
                  disabled={tooSmall || tooTall}
                  className="px-4 py-1.5 rounded-lg bg-beme-500 text-black text-sm hover:bg-beme-400 disabled:opacity-40 disabled:cursor-not-allowed transition-colors font-semibold"
                >
                  Save opening
                </button>
              </footer>
            </div>
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
          // Brick walls reference brick makeups, not block ones — pick
          // the right id map based on mode so the per-makeup height
          // actually gets surfaced (was previously falling through to
          // the project default in brick mode because brickMakeupsById
          // wasn't consulted).
          const selMakeup = selWall
            ? mode === 'brick'
              ? brickMakeupsById[selWall.makeupId]
              : makeupsById[selWall.makeupId]
            : undefined
          const selWallHeightMm =
            selWall?.heightMmOverride ??
            selMakeup?.heightMm ??
            (mode === 'brick' ? brickSettings.defaultWallHeightMm : 0)
          const selHead = selWallHeightMm - selectedOpening.sillHeightMm - selectedOpening.heightMm
          const selBlockLintel =
            mode === 'block' && selHead > 0
              ? selectBlockLintel(selHead)?.code ?? null
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
        // Pattern string for the selection banner. Resolve from the
        // pier's makeup when set; otherwise fall back to a generic
        // description so US / UK projects without a makeup yet don't
        // see AU codes ("40.925 / 20.01") in their banner.
        const patternStr = selPierMakeup
          ? selPierMakeup.coursePattern.join(' / ')
          : selectedPier.type === 'tied'
            ? 'pier / corner alternating'
            : 'pier stacked'
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
      )}
      {/* End of sticky action bar */}

      {/* Calibration prompts + distance input moved INTO the wall-drawing
          toolbar's left slot, so the toolbar height doesn't change while
          calibrating. */}

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

      {/* 3D viewport — renders as a flex-1 sibling of the 2D container
          (replacing it when active). min-w-0 + min-h-0 critical: without
          them the wrapper would expand to fit any intrinsic content
          size, pushing the right rail off the right edge. flex-1 +
          relative gives it a definite-size positioned parent for the
          Canvas inside to anchor against.

          Lazy-loaded so users who never open 3D pay zero bundle cost.
          The 2D containerRef below switches to display:none in 3D
          mode — that removes it from layout entirely so the 3D wrapper
          (the only remaining flex child besides the optional thumbnail
          sidebar) gets all the available row width via flex-1. */}
      {viewMode === '3d' && (
        // bg color matches the Canvas's clearColor (#1a1d24) so any
        // sub-pixel mismatch between the wrapper and the WebGL canvas
        // surface reads as dark not white.
        //
        // Border + rounded-xl removed in 3D — they were creating a
        // visible 'dark border' frame around the 3D Canvas which the
        // user wanted gone. Without the border, the wrapper's dark bg
        // butts flush against whatever's around it (rail / page bg),
        // and the Canvas inside fills the wrapper edge to edge.
        <div
          className="flex-1 min-w-0 min-h-0 relative overflow-hidden"
          // Wrapper bg doubles as the visible "frame" around the 3D
          // Canvas (the Canvas is absolute-inset-0). Flip with theme so
          // it matches the scene clearColor in either mode — dark slate
          // in dark, warm off-white in light — and stays seamless with
          // the surrounding chrome.
          style={{ backgroundColor: theme === 'light' ? '#f7f4ec' : '#1a1d24' }}
        >
          <Suspense
            fallback={
              <div className="absolute inset-0 flex items-center justify-center text-ink-400 text-sm">
                Loading 3D view…
              </div>
            }
          >
            <WorkspaceView3D
              walls={currentPageWalls}
              openings={currentPageOpenings}
              makeupsById={makeupsById}
              brickMakeupsById={brickMakeupsById}
              wallThicknessByWallId={wallThicknessByWallId}
              areas={areas}
              library={BLOCK_LIBRARY}
              piers={currentPagePiers}
              pierMakeupsById={pierMakeupsById}
              pierColorByPierId={pierColorByPierId}
              pdfFile={pdfFile}
              currentPageNumber={currentPage}
              pageWidthMm={activePagesData[currentPage]?.pageWidthMm}
              pageHeightMm={activePagesData[currentPage]?.pageHeightMm}
              pageScaleRatio={activePagesData[currentPage]?.pageScaleRatio}
            />
          </Suspense>
        </div>
      )}

      {/* PDF + overlay (scrollable container with wheel-zoom and click-drag pan).

          Stays mounted at all times — when in 3D mode it gets
          `display: none` (the 'hidden' class). The 3D wrapper is now
          a true flex sibling, so removing this from layout doesn't
          break the parent's sizing (the 3D wrapper takes over the
          flex-1 allocation instead). containerRef + its wheel/pan
          listeners stay valid across mode toggles because the React
          node is the same. */}
      <div
        ref={containerRef}
        onMouseDown={handlePanMouseDown}
        className={`flex-1 min-h-0 border border-ink-600 rounded-xl overflow-auto bg-ink-800 ${viewMode === '3d' ? 'hidden' : ''}`}
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
                "for free" between rasterisations.

                The ref gives the wheel handler a direct DOM target to mutate
                `style.transform` between rAF ticks WITHOUT going through React,
                so smoothness doesn't depend on how fast the (large) workspace
                tree reconciles. React still owns the committed value once the
                gesture ends. */}
            <div
              ref={innerPageWrapperRef}
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
                  // `key` forces a full unmount/remount of Document whenever
                  // the active file changes. Without it react-pdf can leave
                  // the previous file's canvas on screen — when you toggle
                  // between primary and a reference PDF, the worker hangs on
                  // to the prior PDFDocumentProxy and the displayed Page
                  // doesn't actually re-rasterise. Keying off the file
                  // selector (primary vs ref-N) makes React's diff treat
                  // them as separate elements and react-pdf spins up a
                  // fresh load every time.
                  key={isReferenceView ? `ref-${activeReferenceIndex}` : 'primary'}
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
                      // Write intrinsic page dimensions + any legacy
                      // migration into the ACTIVE doc's pages-data
                      // slice — primary in primary view, reference's
                      // own slice in reference view. The per-doc
                      // slices are keyed by doc id so reference page
                      // 1 no longer collides with the primary's page
                      // 1 (the bug the old "view-only" comment was
                      // working around).
                      const widthMm = (page.originalWidth / POINTS_PER_INCH) * MM_PER_INCH
                      const heightMm = (page.originalHeight / POINTS_PER_INCH) * MM_PER_INCH
                      setActivePagesData((prev) => {
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

              {/* Wall drawing layer — at renderedZoom resolution; scales with
                  parent. On reference PDFs the layer ONLY mounts when the user
                  has the ruler active, so they can measure things on the
                  reference (e.g. window sizes on an engineering sheet) while
                  every other tool stays inert. The walls / openings / piers
                  passed to the layer are empty in reference mode so nothing
                  from the primary's geometry overlays the reference. */}
              {(mode === 'block' || mode === 'brick') &&
                (!isReferenceView || placingRuler) &&
                renderedPageHeight !== null &&
                currentScale && (
                <WallDrawingLayer
                  walls={isReferenceView ? [] : currentPageWalls}
                  openings={isReferenceView ? [] : currentPageOpenings}
                  wallThicknessByWallId={wallThicknessByWallId}
                  // Live-preview thickness for the in-progress draw —
                  // active makeup's body block depth in block mode,
                  // active brick type's depth in brick mode. Falls
                  // back to 190 mm if neither resolves.
                  activeWallThicknessMm={(() => {
                    if (mode === 'brick') {
                      // brickTypeCode can be empty / undefined for fresh
                      // brick projects until the user picks a type — guard
                      // the library index so tsc's strict undefined check
                      // is satisfied. Empty code falls through to the
                      // project default thickness.
                      const code = brickSettings.brickTypeCode
                      return (
                        (code ? BRICK_LIBRARY[code]?.depthMm : undefined) ??
                        DEFAULT_BRICK_WALL_THICKNESS_MM
                      )
                    }
                    const am = makeupsById[activeMakeupId]
                    const body =
                      am?.bodyBlockCode &&
                      BLOCK_LIBRARY[am.bodyBlockCode]?.dimensions.depthMm
                    return body ?? 190
                  })()}
                  // Pier footprint for on-canvas pier tiles — read from
                  // the library's pier-tagged block (or the user's
                  // Cursor footprint follows the ACTIVE pier type's first
                  // course block — so swapping the modal to a 290 mm
                  // pier block immediately shrinks the hover preview.
                  // Width and depth resolved independently so non-cubic
                  // blocks (e.g. 20.01 = 390 × 190) render as their
                  // real long-and-thin shape, not a square.
                  pierFootprintMm={(() => {
                    const activePier = activePierMakeupId
                      ? pierMakeups.find((p) => p.id === activePierMakeupId)
                      : null
                    const firstCode = activePier?.coursePattern?.[0]
                    const firstBlock = firstCode
                      ? BLOCK_LIBRARY[firstCode]
                      : undefined
                    if (firstBlock?.dimensions.widthMm) {
                      return firstBlock.dimensions.widthMm
                    }
                    const pierBlock = pickPierBlock({ settings: getUserSettings() })
                    return pierBlock?.dimensions.widthMm ?? 390
                  })()}
                  pierFootprintDepthMm={(() => {
                    const activePier = activePierMakeupId
                      ? pierMakeups.find((p) => p.id === activePierMakeupId)
                      : null
                    const firstCode = activePier?.coursePattern?.[0]
                    const firstBlock = firstCode
                      ? BLOCK_LIBRARY[firstCode]
                      : undefined
                    if (firstBlock?.dimensions.depthMm) {
                      return firstBlock.dimensions.depthMm
                    }
                    const pierBlock = pickPierBlock({ settings: getUserSettings() })
                    return pierBlock?.dimensions.depthMm ?? 190
                  })()}
                  visualWidth={renderedPageWidth}
                  visualHeight={renderedPageHeight}
                  pxPerMmAtCurrentZoom={currentScale * renderedZoom}
                  // True during the 300 ms debounce after a wheel event,
                  // when the canvas is CSS-scaling ahead of the rasterised
                  // zoom. The wall layer uses this to suppress hover state
                  // updates that would otherwise stutter the gesture.
                  //
                  // IMPORTANT: compare against the QUANTISED target.
                  // renderedZoom now snaps to discrete RENDER_ZOOM_STOPS,
                  // so a raw `zoom !== renderedZoom` comparison would stay
                  // true permanently for any zoom not exactly at a stop —
                  // which would disable hit-testing on the stage and
                  // silently break wall selection / delete. The quantised
                  // form returns false the moment the re-raster debounce
                  // completes, regardless of where between stops the user
                  // settled.
                  isZooming={quantiseRenderZoom(Math.min(zoom, MAX_RENDERED_ZOOM)) !== renderedZoom}
                  drawingMode={drawingMode}
                  drawingCurveMode={drawingCurveMode}
                  placingOpening={placingOpening}
                  placingControlJoint={placingControlJoint}
                  placingTiedPier={placingTiedPier}
                  placingFreestandingPier={placingFreestandingPier}
                  placingRuler={placingRuler}
                  rulerAnchorMm={rulerAnchorMm}
                  measurements={activeMeasurementsByPage[currentPage] ?? []}
                  onRulerClick={handleRulerClick}
                  selectedMeasurementId={selectedMeasurementId}
                  onMeasurementSelect={(id) => {
                    setSelectedMeasurementId(id)
                    if (id) {
                      // Selecting a measurement clears any other selection
                      // — measurements are mutually exclusive with walls /
                      // openings / piers so Delete targets the right thing.
                      setSelectedWallId(null)
                      setSelectedOpeningId(null)
                      setSelectedPierId(null)
                    }
                  }}
                  piers={currentPagePiers}
                  selectedWallId={selectedWallId}
                  selectedOpeningId={selectedOpeningId}
                  selectedPierId={selectedPierId}
                  selectedWallIds={selectedWallIds}
                  selectedOpeningIds={selectedOpeningIds}
                  selectedPierIds={selectedPierIds}
                  wallColorByWallId={wallColorByWallId}
                  pierColorByPierId={pierColorByPierId}
                  pierSizeByPierId={pierSizeByPierId}
                  activeWallColor={
                    mode === 'block' && activeMakeupId
                      ? wallTypeColor(activeMakeupId, makeups)
                      : mode === 'brick' && activeBrickMakeupId
                        ? wallTypeColor(activeBrickMakeupId, brickMakeups)
                        : undefined
                  }
                  activeMakeupIdForHighlight={
                    showActiveMakeupHighlight
                      ? mode === 'brick'
                        ? activeBrickMakeupId
                        : activeMakeupId
                      : null
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

              {/* Calibration overlay — rendered AFTER WallDrawingLayer so it
                  sits on top of the Konva canvas. The Konva Stage has
                  `pointerEvents: 'auto'` and would otherwise intercept the
                  mouse events the SVG needs for click-to-set-point and the
                  live preview line. This SVG sets `pointerEvents: 'auto'`
                  only while calibrating, so it doesn't steal clicks from
                  walls during normal use.

                  Visuals deliberately mirror the wall-draw preview in
                  WallDrawingLayer: same dash pattern (6 4), same stroke
                  width (3), same #ED7D31 orange, same endpoint circles,
                  same midpoint length badge. The label shows the pixel
                  distance until the second click lands; if there's an
                  existing scale on this page (the recalibrate case), we
                  ALSO show the current-scale mm equivalent so the user has
                  context for what they're about to replace. */}
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
                  const dx = b.x - a.x
                  const dy = b.y - a.y
                  const pxDist = Math.sqrt(dx * dx + dy * dy)
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
          canvas on smaller screens.

          Stays visible in BOTH 2D and 3D modes. */}
      <aside className="w-full mt-3 space-y-4 lg:w-[340px] lg:flex-shrink-0 lg:mt-0 lg:min-h-0 lg:overflow-y-auto">

        {/* Area tabs — named subdivisions of the project ("Balcony",
            "Staircase", "Level 1", etc.). Sits at the TOP of the right
            rail so the rail reads top-down as "where (area) → what
            (trade) → how (wall types)". The active area filters the
            canvas + tally; new walls drawn while an area is active get
            its id stamped on them. "All" tab (activeAreaId=null) shows
            everything regardless. Only shown in block/brick workspace
            views, not on the empty-state / upload-zone gate.

            Wrapped with pt-1 + pb-1 to mirror the canvas-side toolbar's
            sticky wrapper so the chip group lines up on the same
            horizontal Y as the "Draw wall / Ruler / etc." toolbar to
            its left. The rail's space-y-4 owns the gap to the next
            panel below, so no extra bottom margin here. */}
        {(mode === 'block' || mode === 'brick') && viewMode !== '3d' && (
          <div className="pt-1 pb-1">
            <AreaTabs
              areas={areas}
              activeAreaId={activeAreaId}
              onSelect={setActiveAreaId}
              onCreate={(name) => {
                // Generate the id client-side — uses the same UUID helper
                // as project ids so it's stable across saves and unique
                // across users in the cloud.
                const id =
                  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
                    ? crypto.randomUUID()
                    : `area-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
                const newArea: ProjectArea = { id, name }
                setAreas((prev) => [...prev, newArea])
                // Seed one baseline wall type per trade so the new area
                // opens with a working starting wall instead of an
                // empty panel. Block and brick each get a single
                // generic makeup scoped to this area. The user can
                // edit / rename / add more from the panel afterwards.
                const seededBlock = createDefaultWallMakeup({})
                seededBlock.areaId = id
                const seededBrick = createDefaultBrickMakeup({
                  name: `Brickwork ${seededBlock.heightMm}mm`,
                  heightMm: seededBlock.heightMm,
                })
                seededBrick.areaId = id
                setMakeups((prev) => [...prev, seededBlock])
                setBrickMakeups((prev) => [...prev, seededBrick])
                // Activate the freshly-created area + its seed wall
                // type so new walls flow into it immediately. Most
                // common workflow: "+ New area", type name, start
                // drawing — without these activations the user would
                // have to pick both manually.
                setActiveAreaId(id)
                if (mode === 'brick') {
                  setActiveBrickMakeupId(seededBrick.id)
                } else {
                  setActiveMakeupId(seededBlock.id)
                }
              }}
              onRename={(areaId, newName) => {
                setAreas((prev) =>
                  prev.map((a) => (a.id === areaId ? { ...a, name: newName } : a))
                )
              }}
              onDelete={(areaId) => {
                setAreas((prev) => prev.filter((a) => a.id !== areaId))
                // If the deleted area was active, fall back to All so the
                // user doesn't land on a now-empty filter that hides
                // everything. The deleted area's walls keep their old
                // areaId — they become "orphaned" but still visible in
                // All. Could prune them too but that's destructive on a
                // simple delete click; user can re-create an area and
                // bulk-assign in v2.
                if (activeAreaId === areaId) setActiveAreaId(null)
              }}
            />
          </div>
        )}

        {/* Trade switcher — sits right above the wall-types panel it
            drives. Active trade dictates which panels render below,
            which makeup pool walls reference, and which walls the
            canvas filters in. */}
        {(mode === 'block' || mode === 'brick') && (
          <TradeRail
            trades={['block', 'brick']}
            activeTrade={mode}
            onChangeTrade={(t) => setMode(t)}
          />
        )}

        {/* Wall types management panel (block mode) — pier types live
            inside this panel too, listed below the wall types.
            Makeups filtered to the active area so each area only shows
            its own wall types; 'All' shows every makeup across areas. */}
        {mode === 'block' && (
          <WallTypesPanel
            makeups={
              activeAreaId
                ? makeups.filter((m) => m.areaId === activeAreaId)
                : makeups
            }
            activeMakeupId={activeMakeupId}
            wallCountsByMakeupId={wallCountsByMakeupId}
            onSetActive={handleActivateMakeup}
            onAddMakeup={handleAddMakeup}
            onUpdateMakeup={handleUpdateMakeup}
            onDeleteMakeup={handleDeleteMakeup}
            pierMakeups={pierMakeups}
            pierCountsByMakeupId={pierCountsByMakeupId}
            activePierMakeupId={activePierMakeupId}
            onSetActivePier={handleActivatePierMakeup}
            activeTypeKind={activeTypeKind}
            onAddPierMakeup={handleAddPierMakeup}
            onUpdatePierMakeup={handleUpdatePierMakeup}
            onDeletePierMakeup={handleDeletePierMakeup}
            selectedPier={selectedPier ?? null}
            onReassignPierMakeup={handleReassignPierMakeup}
            onDeletePier={handleDeletePier}
            onDeselectPier={() => setSelectedPierId(null)}
            // Curved-wall trigger lives in the editor modal's TYPE
            // picker. Only wire in block mode (brick has no curves).
            // Sets curve-draw mode ON unconditionally (was a toggle
            // — but the only caller is the modal's Save handler post-
            // configure, where the user has explicitly picked Curved
            // and expects to land in curve-draw mode every time, not
            // be flipped back off if curve mode happened to be on
            // already).
            onToggleCurvedWall={
              mode === 'block'
                ? () => {
                    setDrawingCurveMode(true)
                    setDrawingMode(false)
                    setPlacingOpening(false)
                    setPlacingControlJoint(false)
                    setPlacingTiedPier(false)
                    setPlacingFreestandingPier(false)
                    setSelectedWallId(null)
                    setSelectedOpeningId(null)
                    setSelectedPierId(null)
                  }
                : undefined
            }
          />
        )}

        {/* Brick wall types (brick mode). Brick library is edited
            from the Material library page; we don't show it in the
            workspace right-rail any more. Same per-area filtering as
            block. */}
        {mode === 'brick' && (
          <BrickTypesPanel
            makeups={
              activeAreaId
                ? brickMakeups.filter((m) => m.areaId === activeAreaId)
                : brickMakeups
            }
            activeMakeupId={activeBrickMakeupId}
            wallCountsByMakeupId={wallCountsByMakeupId}
            onSetActive={handleActivateBrickMakeup}
            onAddMakeup={handleAddBrickMakeup}
            onUpdateMakeup={handleUpdateBrickMakeup}
            onDeleteMakeup={handleDeleteBrickMakeup}
          />
        )}

        {/* Supply items panel — same component in both modes. Lists the
            library items applicable to this estimate, with per-item
            checkbox + editable rate + live qty. Replaces the legacy
            BrickAdditionsPanel (ties/plascourse only) and unifies the
            workflow across brick + block. */}
        {(mode === 'block' || mode === 'brick') && (
          <SupplyItemsPanel
            metrics={supplyMetrics}
            selections={supplyItemSelections}
            rateOverrides={supplyItemRateOverrides}
            onToggle={(id, included) =>
              setSupplyItemSelections((prev) => ({ ...prev, [id]: included }))
            }
            onRateChange={(id, rate) =>
              setSupplyItemRateOverrides((prev) => {
                const next = { ...prev }
                if (rate === undefined) delete next[id]
                else next[id] = rate
                return next
              })
            }
          />
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
          <BrickTallyPanel
            walls={allWalls}
            openings={allOpenings}
            settings={brickSettings}
            makeups={brickMakeups}
          />
        )}

        {/* Unified export panel. Auto-routes to combined / block-only /
            brick-only based on which trades have walls after the area
            filter. Replaces the legacy BlockExportPanel / BrickExportPanel
            / CombinedExportCard combo. */}
        <UnifiedExportPanel
          projectDetails={projectDetails}
          referenceNumber={referenceNumber}
          supplyItemSelections={supplyItemSelections}
          supplyItemRateOverrides={supplyItemRateOverrides}
          pdfFile={pdfFile}
          open={exportModalOpen}
          onOpenChange={setExportModalOpen}
          allWalls={allWallsRaw}
          allOpenings={Object.values(openingsByPage).flat()}
          allPiers={Object.values(piersByPage).flat()}
          blockMakeups={makeups}
          pierMakeups={pierMakeups}
          brickMakeups={brickMakeups}
          brickSettings={brickSettings}
          areas={areas}
          activeAreaId={activeAreaId}
          rawPagesInfo={Object.keys(wallsByPage)
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
              measurements: measurementsByPage[n] ?? [],
            }))}
        />
      </aside>

      </div>
      {/* ─────────────────── End of two-column body ─────────────────── */}

      </div>{/* End workspace padding wrapper */}
    </div>
  )
}

/**
 * Multi-page PDF thumbnail rail. Extracted from PdfWorkspace and memoised
 * because the per-page <Page> rendering is the most expensive part of the
 * workspace render.
 */
interface ThumbnailSidebarProps {
  sidebarRef: React.RefObject<HTMLDivElement | null>
  pdfFile: File
  numPages: number
  currentPage: number
  pagesData: Record<number, { pageScaleRatio?: number; scalePxPerMm?: number }>
  onSelectPage: (pageNum: number) => void
  wallCountsByPage?: Record<number, number>
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
      <Document
        key={pdfFile?.name ?? 'no-file'}
        file={pdfFile}
        loading={null}
        error={null}
      >
        <div className="space-y-2.5">
          {Array.from({ length: numPages }, (_, i) => i + 1).map((pageNum) => {
            const isCurrent = pageNum === currentPage
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


