import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { Stage, Layer, Line, Circle, Rect, Text, Group } from 'react-konva'
import type Konva from 'konva'
import type { Opening, Pier, Wall } from '../types/walls'
import { arcFromThreePoints, isCurvedWall, projectOntoArc, sampleArc } from '../lib/curveGeom'
import { formatLengthShort, parseLengthInput } from '../lib/units'
import { getUserSettings, useUserSettings } from '../lib/userSettings'
import { DEFAULT_MORTAR_JOINT_MM } from '../types/blocks'
import { hexToRgba } from '../lib/wallTypeColors'
import { BLOCK_LIBRARY } from '../data/blockLibrary'
import {
  computeAutoWallLengthSnapMm,
  WALL_LENGTH_SNAP_FALLBACK_MM,
} from '../lib/wallLengthSnap'

interface Point {
  x: number
  y: number
}

/**
 * Sharp crosshair-style ruler endpoint marker.
 *
 * The earlier solid-circle marker (radius 4–5 with a thick white
 * stroke) read as a fat dot, which made it hard to tell exactly
 * where the user clicked when measuring tight features (door
 * jambs, head clearances, lintel widths). This renders a precise
 * "+" target made of two thin lines through a tiny solid dot,
 * with a faint white halo behind each arm so the marker reads on
 * both pale and dark plan backgrounds.
 *
 * Selected state nudges the size up slightly so the user can still
 * spot which committed measurement is active without losing the
 * pinpoint feel.
 */
function renderRulerMarker(pos: { x: number; y: number }, isSelected: boolean) {
  const arm = isSelected ? 8 : 7
  const dot = isSelected ? 1.5 : 1.25
  const stroke = isSelected ? '#a21caf' : '#d946ef'
  return (
    <Group x={pos.x} y={pos.y} listening={false}>
      {/* White halo arms for contrast against dark plan content. */}
      <Line points={[-arm, 0, arm, 0]} stroke="white" strokeWidth={2.5} lineCap="round" />
      <Line points={[0, -arm, 0, arm]} stroke="white" strokeWidth={2.5} lineCap="round" />
      {/* Sharp coloured cross over the halo. */}
      <Line points={[-arm, 0, arm, 0]} stroke={stroke} strokeWidth={1} lineCap="round" />
      <Line points={[0, -arm, 0, arm]} stroke={stroke} strokeWidth={1} lineCap="round" />
      {/* Centre dot anchors the user's eye on the exact click point. */}
      <Circle radius={dot} fill={stroke} listening={false} />
    </Group>
  )
}

/**
 * Shared measurement label — bare black text with a thin white halo
 * for legibility against any PDF background. Centralised so font +
 * sizing stay consistent across every drawing (wall lengths, opening
 * dimensions, ruler distances, in-progress previews).
 *
 * The `bg` prop is retained on the signature for back-compat with
 * call sites that still pass a colour, but it's now ignored — the
 * design call is "always black, always readable" rather than
 * per-tool tinting that washed out on light plans.
 */
function MeasurementChip({
  x,
  y,
  text,
  fontSize = 13,
  align = 'left',
  rotation,
  listening = false,
}: {
  x: number
  y: number
  text: string
  /** @deprecated retained for caller back-compat; ignored. */
  bg?: string
  fontSize?: number
  align?: 'left' | 'center' | 'right'
  rotation?: number
  listening?: boolean
}) {
  // Centred / right-aligned labels need the text offset by half / full
  // width respectively. Konva's Text doesn't measure until render so
  // we estimate from glyph count × fontSize × ~0.55 char-width ratio.
  const dx =
    align === 'center'
      ? -text.length * fontSize * 0.28
      : align === 'right'
      ? -text.length * fontSize * 0.55
      : 0
  // White stroke painted under the black fill so the label reads on
  // dark engineering plans without being obviously haloed on white
  // architectural plans. Konva's `fillAfterStrokeEnabled` keeps the
  // black glyph crisp on top — without it the stroke would also
  // paint over the fill and the text would look bold-and-blurry.
  return (
    <Text
      x={x + dx}
      y={y}
      text={text}
      fontSize={fontSize}
      fill="#000000"
      fontStyle="700"
      fontFamily="'Helvetica Neue', 'Arial', 'system-ui', sans-serif"
      stroke="#ffffff"
      strokeWidth={3}
      fillAfterStrokeEnabled
      listening={listening}
      rotation={rotation}
    />
  )
}

interface WallDrawingLayerProps {
  /**
   * Surfaces the underlying Konva.Stage to the workspace. Used by the
   * hi-res settle overlay to snapshot the visible stage region at true
   * screen resolution when zoom exceeds the raster cap (the stage
   * itself rasterises at renderedZoom and gets CSS-stretched beyond
   * it). Optional — omitted by callers that predate the overlay.
   */
  onStageRef?: (stage: Konva.Stage | null) => void
  walls: Wall[]
  /** Openings on the current page (across all walls). */
  openings: Opening[]
  /**
   * Physical wall thickness per wall id (mm). For block walls this comes from the makeup's
   * body block depth (e.g. 190mm for 20.48); for brick walls it's the configured brick wall
   * thickness (110mm default). Drives the rendered rectangle width.
   */
  wallThicknessByWallId: Record<string, number>
  /**
   * Thickness in mm to render the IN-PROGRESS drawing preview at —
   * driven by the active makeup's body block depth (block mode) or the
   * active brick type's depth (brick mode). Lets the live preview
   * silhouette match what the committed wall will look like rather
   * than rendering as a thin line. Falls back to 190 mm if not passed.
   */
  activeWallThicknessMm?: number
  /**
   * Footprint of a pier in mm — used to render tied / freestanding pier
   * tiles on the canvas. Defaults to 390 (AU 40.925 block) so projects
   * predating this prop keep their visual. Parent computes this from
   * the user's pier-tagged library block so US / UK / etc. piers render
   * at their actual size instead of the AU square.
   */
  pierFootprintMm?: number
  /**
   * Pier depth (the axis PERPENDICULAR to the wall, or the y-axis for
   * freestanding piers). Splitting width vs depth lets non-cubic
   * blocks render their actual proportions — a 20.01 pier is 390 long
   * × 190 deep, not a 390 square. Optional + defaults to
   * `pierFootprintMm` so legacy callers keep their old square shape.
   */
  pierFootprintDepthMm?: number
  /**
   * Colour used for the live wall-draw preview (silhouette fill,
   * centreline, measurement chip, cursor box). Lets the in-flight
   * wall match the colour swatch shown next to its wall type in the
   * right rail. Falls back to the legacy beme orange (#ED7D31) when
   * not supplied — same colour committed walls use as their default.
   */
  activeWallColor?: string
  visualWidth: number
  visualHeight: number
  /**
   * Optional render-window crop, in stage-content (rendered-page) px.
   * When set, the Stage canvas covers ONLY this window of the page —
   * positioned at (cropX, cropY) inside the transformed wrapper and
   * offset internally so content coordinates are unchanged — and
   * `pixelRatio` raises the canvas backing density to true screen
   * resolution. PdfWorkspace drives this above the whole-page raster
   * cap so walls, previews and snap chrome stay SHARP while drawing at
   * deep zoom, with viewport-bounded memory. Omitted -> full-page
   * stage at default density (the original behaviour).
   */
  cropX?: number
  cropY?: number
  cropW?: number
  cropH?: number
  pixelRatio?: number
  /** Visual pixels per mm at the current zoom. */
  pxPerMmAtCurrentZoom: number
  /** Whether drawing-wall mode is active. */
  drawingMode: boolean
  /** Whether 3-click curved-wall drawing mode is active. */
  drawingCurveMode: boolean
  /** Whether placing-opening mode is active. */
  placingOpening: boolean
  /** Whether placing-control-joint mode is active. Clicking on a wall splits it. */
  placingControlJoint?: boolean
  /** Whether placing-tied-pier mode is active. Click a wall to add a tied pier. */
  placingTiedPier?: boolean
  /** Whether placing-freestanding-pier mode is active. Click anywhere on the canvas. */
  placingFreestandingPier?: boolean
  /**
   * True while the user is actively wheel-zooming (the visual zoom is ahead of
   * the rasterised zoom). When true the layer suppresses hover state updates,
   * because cursor enter/leave events fire spuriously during a zoom gesture:
   * the canvas CSS-scales but the cursor doesn't move on screen, so different
   * walls come under it in stage coords and trigger setState cascades that
   * stutter the zoom. Hover comes back instantly the moment the gesture ends.
   */
  isZooming?: boolean
  /** Piers on the current page. */
  piers?: Pier[]
  /** Currently selected wall id (null = nothing selected). */
  selectedWallId: string | null
  /** Currently selected opening id (null = nothing selected). */
  selectedOpeningId: string | null
  /** Currently selected pier id (null = nothing selected). */
  selectedPierId?: string | null
  /**
   * Full multi-selection sets. Optional so a parent that doesn't care about
   * multi-select can omit them; when present, the visual highlight and shift-click
   * additive selection light up. The single selectedXxxId stays as the source of
   * truth for "is the side-panel single-item UI showing" and drag-handle enablement.
   */
  selectedWallIds?: ReadonlySet<string>
  selectedOpeningIds?: ReadonlySet<string>
  selectedPierIds?: ReadonlySet<string>
  /**
   * Ruler / measurement tool. When `placingRuler` is true the cursor drops
   * measurement points on click — first click sets the anchor (rendered
   * live via `rulerAnchorMm`), second click commits a measurement (handed
   * back to the parent via `onRulerClick`, which the parent stores in
   * `measurements` so it persists across cursor moves).
   */
  placingRuler?: boolean
  rulerAnchorMm?: Point | null
  measurements?: ReadonlyArray<{
    id: string
    startMm: Point
    endMm: Point
  }>
  onRulerClick?: (posMm: Point) => void
  /**
   * Selected measurement id — when set, that measurement is rendered with
   * a thicker stroke + halo so the user can see it's picked. Delete key
   * removes it (handled by the parent's global delete listener).
   */
  selectedMeasurementId?: string | null
  onMeasurementSelect?: (id: string | null) => void
  /**
   * Per-wall stroke colour, keyed by wall id — set by the parent based on the
   * wall type's palette colour. Falls back to the brand orange if missing.
   */
  wallColorByWallId?: Record<string, string>
  /**
   * Per-pier fill colour, keyed by pier id. Set by the parent from
   * the shared wall+pier palette via masonryTypeColor so a pier's
   * colour never collides with a wall's. Missing → falls back to
   * the historical tied / freestanding green-tone fills.
   */
  pierColorByPierId?: Record<string, string>
  /**
   * Per-pier dimensions, keyed by pier id. Each pier has its OWN
   * width × depth derived from its makeup's first-course block, so
   * placing a 290 mm pier and then activating a 390 mm pier type
   * doesn't re-render the 290 as a 390. `pierFootprintMm` /
   * `pierFootprintDepthMm` are still used for the hover preview
   * (driven by the currently active type) and as a fallback when
   * a pier's id isn't in this map (e.g. legacy rows without a
   * matching makeup).
   */
  pierSizeByPierId?: Record<string, { widthMm: number; depthMm: number }>
  /**
   * Currently-active wall makeup id. Walls whose `makeupId` matches this get
   * the same visual halo as a selected wall, so the user sees "these are the
   * walls of the type I just clicked in the side panel" without those walls
   * actually being selected (which would flip the toolbar into multi-select
   * mode). Pass undefined to disable the highlight treatment entirely.
   */
  activeMakeupIdForHighlight?: string | null
  /**
   * Add a new wall. Junction types (corner / T-junction / free) are derived
   * purely from geometry in recomputeAllJunctions — no force-butt flag.
   * Walls that snap to a face become T-junctions; walls whose endpoints
   * coincide at the corner-block-centre become corners. Control joints
   * exist only when placed explicitly by the user via the Control Joint
   * tool (which splits a wall into two halves).
   */
  onWallAdded: (startMm: Point, endMm: Point) => void
  /** Called when all three clicks are made: anchor A, anchor B, midpoint on arc. */
  onCurvedWallAdded: (startMm: Point, midMm: Point, endMm: Point) => void
  onWallSelect: (wallId: string | null) => void
  /**
   * Shift+click handlers — additive selection. Toggle the id in/out of the set
   * without disturbing the rest. Optional: if omitted, shift+click falls back to
   * the plain select behaviour.
   */
  onWallToggleSelect?: (wallId: string) => void
  onOpeningToggleSelect?: (openingId: string) => void
  onPierToggleSelect?: (pierId: string) => void
  onWallEndpointMoved: (
    wallId: string,
    which: 'start' | 'end',
    newPositionMm: Point
  ) => void
  /** Called when both placement clicks are done. Width is the distance between the projected points along the wall. */
  onOpeningPlaced: (
    wallId: string,
    startAlongWallMm: number,
    widthMm: number
  ) => void
  onOpeningSelect: (openingId: string | null) => void
  /** Called when a control-joint click on a wall is confirmed. The wall is split at alongMm. */
  onControlJointPlaced?: (wallId: string, alongMm: number) => void
  /** Called when a tied pier is placed on a wall at alongMm. */
  onTiedPierPlaced?: (wallId: string, alongMm: number) => void
  /** Called when a freestanding pier is placed at a real-world (x, y) in mm. */
  onFreestandingPierPlaced?: (xMm: number, yMm: number) => void
  onPierSelect?: (pierId: string | null) => void
  onCancelDraw?: () => void
}

/** Pixel radius for snapping to an existing wall's endpoint (corner candidate).
 *  Used as the PERPENDICULAR-to-wall tolerance during the corner-snap check —
 *  the along-wall direction is handled separately with a larger radius (see
 *  `snapRadiusPx` below) so a click at the visible end face still hits. 8 px
 *  is the comfortable aim margin: close-but-distinct parallel endpoints stay
 *  separable but the user doesn't need pixel-precise targeting. Shift bypasses
 *  snap entirely. */
const SNAP_THRESHOLD_PX = 8
/** Pixel radius for projecting a click onto a wall when placing openings, control joints
 *  and piers. Used in `findClosestWallProjection`. Kept in pixels because it represents
 *  click precision against a visible wall — the user targets the wall on screen. Tightened
 *  so two adjacent walls don't both claim the cursor on a single click. */
const WALL_PROJECTION_THRESHOLD_PX = 8
/**
 * Real-world distance at which a cursor near an existing wall's *face* will snap onto it
 * to form a T-junction. Expressed in mm so the snap feels the same at every zoom level
 * and on every plan. Widened to 25 mm so the T-junction snap catches the cursor from a
 * comfortable margin — earlier values were precise but required pixel-perfect aim,
 * especially at low zoom. Closest-snap-wins ranking in findSnap means a wider face zone
 * doesn't steal cursors that are geometrically closer to a corner or tip target — it
 * just gives the user more comfortable reach to the face itself. Shift bypasses entirely.
 */
const WALL_FACE_SNAP_MM = 25

/**
 * Angular tolerance for orthogonal snap, in degrees.
 *
 * When drawing a new wall (or dragging an endpoint), if the segment is within
 * ±this-many degrees of horizontal or vertical, it snaps cleanly to that axis.
 * Most plans are drawn on a grid so the *intent* is almost always ortho — this
 * removes a frustrating class of "wall is 1° off and I have to nudge it" bugs
 * without locking out walls that are genuinely on an angle.
 *
 * Hold Shift while drawing or dragging to bypass the snap.
 */
const AXIS_SNAP_DEGREES = 4

/**
 * Ruler-specific axis snap window. Wider than the wall-drawing AXIS_SNAP_DEGREES
 * because the ruler is a quick measurement tool — users want a near-horizontal
 * drag to lock to horizontal without having to be pixel-precise. Set to 8°,
 * which catches "I dragged across the page roughly horizontally" without
 * accidentally snapping a deliberate 30° measurement.
 */
const RULER_AXIS_SNAP_DEGREES = 8

/**
 * Snap a ruler endpoint to horizontal / vertical relative to its anchor when
 * the line between them is within RULER_AXIS_SNAP_DEGREES of an axis. Holding
 * Shift bypasses the snap so genuine angled measurements still work.
 *
 * Used by both the live preview line (so the user can see the snap happening)
 * and the commit click (so the stored measurement matches what they saw).
 */
function snapRulerToAxis(
  anchor: Point,
  cursorMm: Point,
  bypass: boolean
): Point {
  if (bypass) return cursorMm
  const dx = cursorMm.x - anchor.x
  const dy = cursorMm.y - anchor.y
  if (dx === 0 && dy === 0) return cursorMm
  // |angle| from atan2 wraps in [0, π]. We compare absolute values against
  // 0 (horizontal) and π/2 (vertical) and the wrap-around at π (also
  // horizontal).
  const absAngle = Math.abs(Math.atan2(dy, dx))
  const threshold = (RULER_AXIS_SNAP_DEGREES * Math.PI) / 180
  // Horizontal — drop the cursor onto the anchor's y.
  if (absAngle < threshold || Math.abs(absAngle - Math.PI) < threshold) {
    return { x: cursorMm.x, y: anchor.y }
  }
  // Vertical — drop the cursor onto the anchor's x.
  if (Math.abs(absAngle - Math.PI / 2) < threshold) {
    return { x: anchor.x, y: cursorMm.y }
  }
  return cursorMm
}

/**
 * Wall length, opening width, control-joint offset, and pier position all
 * snap to multiples of this many millimetres. Real masonry is laid out on
 * coarse increments — nothing's ever spec'd at 357 mm — so always rounding
 * to the nearest 5 mm makes every measurement land cleanly.
 *
 * Applied AFTER wall-snap (endpoints / faces) and axis-snap so neither gets
 * overridden, and bypassed by holding Shift the same way axis-snap is, for
 * the rare measurement that genuinely needs an off-grid value.
 */
/**
 * Hardcoded last-resort wall-length snap. Used only when both the user
 * settings AND the auto-derivation from the active block library fail
 * (e.g. an empty library). The active value comes from
 * `userSettings.defaults.wallLengthSnapMm` first, then falls back to
 * the derived value from {@link computeAutoWallLengthSnapMm}.
 *
 * 50 mm matches the AU SEQ block library's modular GCD across full /
 * 7-8 / 3-4 / half blocks and is the historical default.
 */
const WALL_LENGTH_SNAP_MM = WALL_LENGTH_SNAP_FALLBACK_MM

/**
 * Openings (doors / windows / brickwork voids) use a coarser 10 mm grid
 * than walls themselves. Real openings are spec'd in 10 mm steps — 900 mm
 * doors, 1200 mm windows, never something like 925 mm — and the coarser
 * grid keeps the user from accidentally landing on an awkward 905 mm width
 * after a click+drag at a slightly off cursor. Walls still snap to 5 mm
 * because corner blocks (190 mm + 10 mm mortar) need that finer increment
 * to absorb leftover length cleanly.
 */
const OPENING_SNAP_MM = 10

/**
 * Round a mm length to the nearest snap increment. Shared by every
 * placement path (wall length, control joint position, tied/freestanding
 * pier coords) so the user sees a consistent grid no matter what they're
 * dropping onto the plan.
 *
 * `snapMm` defaults to WALL_LENGTH_SNAP_MM (50). Callers inside the
 * component override it with the live user-settings value so a user who
 * changes the snap in Settings sees the new grid take effect on the
 * next draw.
 */
function snapMmToGrid(mm: number, snapMm: number = WALL_LENGTH_SNAP_MM): number {
  return Math.round(mm / snapMm) * snapMm
}

/** Round to the coarser opening grid — see OPENING_SNAP_MM. */
function snapOpeningMm(mm: number): number {
  return Math.round(mm / OPENING_SNAP_MM) * OPENING_SNAP_MM
}

/**
 * If the segment from `from` → `to` is near horizontal or vertical, return a
 * snapped `to` that lies exactly on the axis. Otherwise return `to` unchanged.
 * Operates in any coordinate system since the comparison is purely angular.
 */
function applyAxisSnap(from: Point, to: Point): Point {
  const dx = to.x - from.x
  const dy = to.y - from.y
  if (dx === 0 && dy === 0) return to
  // atan2(|dy|, |dx|) → 0 = horizontal, π/2 = vertical. Comparing against a
  // small threshold catches both axes symmetrically regardless of direction.
  const angleDeg = (Math.atan2(Math.abs(dy), Math.abs(dx)) * 180) / Math.PI
  if (angleDeg < AXIS_SNAP_DEGREES) {
    // Near horizontal — flatten the segment by collapsing y to the anchor.
    return { x: to.x, y: from.y }
  }
  if (angleDeg > 90 - AXIS_SNAP_DEGREES) {
    // Near vertical — collapse x.
    return { x: from.x, y: to.y }
  }
  return to
}

interface EndpointPixel {
  x: number
  y: number
  wallId: string
  end: 'start' | 'end'
  /** Per-endpoint snap radius in px. Larger for thick walls so the user can land
   *  anywhere in the end-block area and the snap fires. */
  snapRadiusPx: number
  /** Unit vector in pixel space pointing from the far end of the wall *outward*
   *  through this endpoint. Used to make the endpoint snap zone anisotropic —
   *  generous along the wall axis (covers the whole end-block) but tight across
   *  it, so the cursor a few millimetres off to the side of the wall's end
   *  doesn't get swallowed into a corner snap and prevent the user from making
   *  a T-junction at the very tip of the wall. */
  dirX: number
  dirY: number
}

/** Result of snapping the cursor to an existing wall — either its endpoint, or a point on its body. */
type SnapResult =
  | { kind: 'endpoint'; x: number; y: number; wallId: string; end: 'start' | 'end' }
  | { kind: 'body'; x: number; y: number; wallId: string }

interface WallProjection {
  wallId: string
  /** Distance along the wall from its start, in mm. */
  alongMm: number
  /** Projected point in pixel coords. */
  px: Point
  /** Distance from the click to the wall line, in pixels. */
  distFromLinePx: number
}

function distance(a: Point, b: Point) {
  const dx = b.x - a.x
  const dy = b.y - a.y
  return Math.sqrt(dx * dx + dy * dy)
}

function wallLengthMmOf(wall: Wall) {
  // Curved walls report true arc length along their centreline so
  // alongMm values returned by projectOntoWall live in the same
  // measurement space as the wall's overall length. Falls back to
  // chord distance if the curve geometry is degenerate.
  if (isCurvedWall(wall) && wall.midX !== undefined && wall.midY !== undefined) {
    const geom = arcFromThreePoints(
      { x: wall.startX, y: wall.startY },
      { x: wall.midX, y: wall.midY },
      { x: wall.endX, y: wall.endY },
    )
    if (geom) return geom.arcLengthMm
  }
  const dx = wall.endX - wall.startX
  const dy = wall.endY - wall.startY
  return Math.sqrt(dx * dx + dy * dy)
}

/**
 * Compute the four corner points (px) of a straight wall's physical rectangle, given the
 * (possibly trimmed) centreline endpoints in mm. Width is `thicknessMm`, perpendicular to
 * the segment, centred on the centreline. Returns a flat `[x1, y1, x2, y2, x3, y3, x4, y4]`
 * array for a closed Konva Line.
 */

/** A 2D line in point-and-direction form. */
interface LineMm {
  px: number
  py: number
  dx: number
  dy: number
}

/**
 * Intersection point of two lines (each given as a point + direction). Returns null if
 * the lines are parallel (no unique intersection).
 */
function intersectLinesMm(l1: LineMm, l2: LineMm): Point | null {
  const det = l1.dx * -l2.dy - l1.dy * -l2.dx
  if (Math.abs(det) < 1e-6) return null
  const dx = l2.px - l1.px
  const dy = l2.py - l1.py
  const s = (-l2.dy * dx - -l2.dx * dy) / det
  return { x: l1.px + s * l1.dx, y: l1.py + s * l1.dy }
}

/**
 * Compute the two long face lines of a straight wall (each as a LineMm).
 * - posFace is on the +N side (perpendicular rotated 90° CCW from wall direction).
 * - negFace is on the -N side.
 */
function wallFaceLines(wall: Wall, thicknessMm: number): { posFace: LineMm; negFace: LineMm } | null {
  const dx = wall.endX - wall.startX
  const dy = wall.endY - wall.startY
  const len = Math.sqrt(dx * dx + dy * dy)
  if (len === 0) return null
  const ux = dx / len
  const uy = dy / len
  const nx = -uy
  const ny = ux
  const half = thicknessMm / 2
  return {
    posFace: { px: wall.startX + nx * half, py: wall.startY + ny * half, dx: ux, dy: uy },
    negFace: { px: wall.startX - nx * half, py: wall.startY - ny * half, dx: ux, dy: uy },
  }
}

/**
 * For a wall endpoint, return either:
 *   - 'skip' if this wall should NOT render an endpoint marker here (because the connected
 *     wall at the same corner is the "primary" — has the alphabetically lower id — and is
 *     responsible for rendering the single shared corner marker)
 *   - a Point (in pixels) where the marker should render. For corner endpoints, this is
 *     the centreline-centreline intersection of the two cornered walls (the geometric
 *     centre of the L corner). For free or T-junction endpoints, this is the wall's
 *     data endpoint as before.
 */
function cornerMarkerPosOrSkip(
  wall: Wall,
  end: 'start' | 'end',
  isCornerJunction: boolean,
  walls: Wall[],
  mmToPx: (mm: number) => number,
  fallback: Point
): Point | 'skip' {
  if (!isCornerJunction) return fallback
  const junction = end === 'start' ? wall.startJunction : wall.endJunction
  const otherId = junction.connectedWallIds?.[0]
  if (!otherId) return fallback
  // Only the alphabetically-lower id wall renders the shared corner marker.
  if (wall.id > otherId) return 'skip'
  const other = walls.find((w) => w.id === otherId)
  if (!other || isCurvedWall(other)) return fallback
  const intersection = intersectLinesMm(
    {
      px: wall.startX,
      py: wall.startY,
      dx: wall.endX - wall.startX,
      dy: wall.endY - wall.startY,
    },
    {
      px: other.startX,
      py: other.startY,
      dx: other.endX - other.startX,
      dy: other.endY - other.startY,
    }
  )
  if (!intersection) return fallback
  return { x: mmToPx(intersection.x), y: mmToPx(intersection.y) }
}

/**
 * For a wall with a 'corner' junction endpoint, compute the two mitred polygon-corner
 * points so the wall tiles cleanly into an L with the connected wall:
 *   - posCorner: where THIS wall's +N face line meets the appropriate face of the OTHER wall
 *   - negCorner: where THIS wall's -N face line meets the appropriate face of the OTHER wall
 *
 * "Appropriate" face is decided by the angle bisector at the corner — the inner face of each
 * wall meets the inner face of the other (= L's inner corner), outer meets outer (= L's outer
 * corner). The result is two points forming a diagonal across the wall at the corner end,
 * which both walls' polygons share — giving a perfectly tiled L.
 *
 * Returns null if the geometry is degenerate (no connected wall, parallel walls, etc.).
 */
function mitredCornerPointsMm(
  wall: Wall,
  end: 'start' | 'end',
  walls: Wall[],
  thicknessByWallId: Record<string, number>
): { posCorner: Point; negCorner: Point } | null {
  const junction = end === 'start' ? wall.startJunction : wall.endJunction
  if (junction.type !== 'corner') return null
  const otherId = junction.connectedWallIds?.[0]
  if (!otherId) return null
  const other = walls.find((w) => w.id === otherId)
  if (!other || isCurvedWall(other)) return null

  const wallThickness = thicknessByWallId[wall.id] ?? 190
  const otherThickness = thicknessByWallId[otherId] ?? 190
  const wallFaces = wallFaceLines(wall, wallThickness)
  const otherFaces = wallFaceLines(other, otherThickness)
  if (!wallFaces || !otherFaces) return null

  // Intersections of all 4 face combinations.
  const i_pp = intersectLinesMm(wallFaces.posFace, otherFaces.posFace)
  const i_pn = intersectLinesMm(wallFaces.posFace, otherFaces.negFace)
  const i_np = intersectLinesMm(wallFaces.negFace, otherFaces.posFace)
  const i_nn = intersectLinesMm(wallFaces.negFace, otherFaces.negFace)
  if (!i_pp || !i_pn || !i_np || !i_nn) return null

  // Determine which end of OTHER is the corner end by following the connectedWallIds back
  // to THIS wall (NOT by comparing positions — with the new "preserve wall length" model
  // the two corner endpoints sit at different positions on each other's faces, so a
  // position check would pick the wrong end).
  const otherStartIsCornerHere =
    other.startJunction.type === 'corner' &&
    (other.startJunction.connectedWallIds?.includes(wall.id) ?? false)
  const otherEndIsCornerHere =
    other.endJunction.type === 'corner' &&
    (other.endJunction.connectedWallIds?.includes(wall.id) ?? false)
  if (!otherStartIsCornerHere && !otherEndIsCornerHere) return null
  // OTHER's "far" direction = from the corner end toward the OPPOSITE end. Use the wall's
  // own start/end coords directly (no offset issues from non-coincident endpoints).
  const otherDirX = otherStartIsCornerHere
    ? other.endX - other.startX
    : other.startX - other.endX
  const otherDirY = otherStartIsCornerHere
    ? other.endY - other.startY
    : other.startY - other.endY
  const otherDirLen = Math.sqrt(otherDirX * otherDirX + otherDirY * otherDirY)
  if (otherDirLen === 0) return null
  const ubX = otherDirX / otherDirLen
  const ubY = otherDirY / otherDirLen

  // u_a: from this corner end toward this wall's far end.
  const wallDirX = end === 'start' ? wall.endX - wall.startX : wall.startX - wall.endX
  const wallDirY = end === 'start' ? wall.endY - wall.startY : wall.startY - wall.endY
  const wallDirLen = Math.sqrt(wallDirX * wallDirX + wallDirY * wallDirY)
  if (wallDirLen === 0) return null
  const uaX = wallDirX / wallDirLen
  const uaY = wallDirY / wallDirLen

  // Angle bisector — direction the inner-of-L points.
  const bisectorX = uaX + ubX
  const bisectorY = uaY + ubY
  const bLen = Math.sqrt(bisectorX * bisectorX + bisectorY * bisectorY)
  if (bLen < 1e-6) return null // walls are anti-parallel — no L
  const bX = bisectorX / bLen
  const bY = bisectorY / bLen

  // For each wall, +N is "inner" if it points along the bisector.
  const wdx = wall.endX - wall.startX
  const wdy = wall.endY - wall.startY
  const wlen = Math.sqrt(wdx * wdx + wdy * wdy)
  const wnx = -wdy / wlen
  const wny = wdx / wlen
  const odx = other.endX - other.startX
  const ody = other.endY - other.startY
  const olen = Math.sqrt(odx * odx + ody * ody)
  const onx = -ody / olen
  const ony = odx / olen
  const wallPosIsInner = wnx * bX + wny * bY > 0
  const otherPosIsInner = onx * bX + ony * bY > 0

  // Inner corner = intersection of inner faces. Outer corner = intersection of outer faces.
  const innerCorner = wallPosIsInner
    ? otherPosIsInner
      ? i_pp
      : i_pn
    : otherPosIsInner
      ? i_np
      : i_nn
  const outerCorner = wallPosIsInner
    ? otherPosIsInner
      ? i_nn
      : i_np
    : otherPosIsInner
      ? i_pn
      : i_pp

  return wallPosIsInner
    ? { posCorner: innerCorner, negCorner: outerCorner }
    : { posCorner: outerCorner, negCorner: innerCorner }
}

/**
 * For a stem wall with a t-junction endpoint, find where the stem's centreline crosses
 * the through-wall's NEAR FACE — that's where the rendered rectangle should end. Works
 * for both legacy data (endpoint at the through-wall's centreline) and new data (endpoint
 * already snapped to the face) — in either case we clip to the face line.
 *
 * Geometry: parameterise the stem as `farEnd + s × (original − farEnd)` for s ∈ [0, 1].
 * Solve `(stemPoint − facePoint) · throughNormal = 0` for s. Clamp to [0, 1] so we
 * never extend past the original endpoint or wrap back beyond the stem's far end.
 */
function trimmedEndpointMm(
  wall: Wall,
  end: 'start' | 'end',
  walls: Wall[],
  thicknessByWallId: Record<string, number>
): Point {
  const original: Point =
    end === 'start'
      ? { x: wall.startX, y: wall.startY }
      : { x: wall.endX, y: wall.endY }
  const junction = end === 'start' ? wall.startJunction : wall.endJunction
  if (junction.type !== 't-junction') return original
  const throughId = junction.connectedWallIds?.[0]
  if (!throughId) return original
  const through = walls.find((w) => w.id === throughId)
  if (!through || isCurvedWall(through)) return original

  const farEnd: Point =
    end === 'start'
      ? { x: wall.endX, y: wall.endY }
      : { x: wall.startX, y: wall.startY }

  // Through-wall direction & normal.
  const tdx = through.endX - through.startX
  const tdy = through.endY - through.startY
  const tLen = Math.sqrt(tdx * tdx + tdy * tdy)
  if (tLen === 0) return original
  const nDirX = -tdy / tLen
  const nDirY = tdx / tLen

  // Determine which side of the through-wall the stem sits on (using the FAR endpoint as
  // a reference point that's safely off the wall).
  const signedPerp =
    (farEnd.x - through.startX) * nDirX + (farEnd.y - through.startY) * nDirY
  const side = signedPerp >= 0 ? 1 : -1

  const throughHalfThickness = (thicknessByWallId[throughId] ?? 190) / 2

  // A point on the through-wall's near face (the face on the stem's side).
  const facePtX = through.startX + side * throughHalfThickness * nDirX
  const facePtY = through.startY + side * throughHalfThickness * nDirY

  // Find s where the stem's centreline crosses the face line:
  //   alpha + s × beta = 0, where
  //   alpha = (farEnd − facePt) · N,  beta = (original − farEnd) · N
  const alpha = (farEnd.x - facePtX) * nDirX + (farEnd.y - facePtY) * nDirY
  const beta = (original.x - farEnd.x) * nDirX + (original.y - farEnd.y) * nDirY
  if (Math.abs(beta) < 0.001) return original // stem parallel to through-wall

  const s = Math.max(0, Math.min(1, -alpha / beta))
  return {
    x: farEnd.x + s * (original.x - farEnd.x),
    y: farEnd.y + s * (original.y - farEnd.y),
  }
}

/**
 * Compute the outline of a curved wall's physical band: the outer arc forward followed by
 * the inner arc reversed, closing into a polygon. `thicknessMm` is the band width.
 */
function bandPxForCurvedWall(
  wall: Wall,
  thicknessMm: number,
  mmToPx: (mm: number) => number
): number[] {
  if (wall.midX === undefined || wall.midY === undefined) return []
  const geom = arcFromThreePoints(
    { x: wall.startX, y: wall.startY },
    { x: wall.midX, y: wall.midY },
    { x: wall.endX, y: wall.endY }
  )
  if (!geom) return []
  const half = thicknessMm / 2
  const outerR = geom.radiusMm + half
  const innerR = Math.max(0.01, geom.radiusMm - half)
  const samples = 48
  const out: number[] = []
  // Outer arc (start → end).
  for (let i = 0; i < samples; i++) {
    const t = i / (samples - 1)
    const a = geom.startAngle + t * geom.sweepAngle
    out.push(mmToPx(geom.centerX + outerR * Math.cos(a)))
    out.push(mmToPx(geom.centerY + outerR * Math.sin(a)))
  }
  // Inner arc (end → start), to close the band.
  for (let i = samples - 1; i >= 0; i--) {
    const t = i / (samples - 1)
    const a = geom.startAngle + t * geom.sweepAngle
    out.push(mmToPx(geom.centerX + innerR * Math.cos(a)))
    out.push(mmToPx(geom.centerY + innerR * Math.sin(a)))
  }
  return out
}

/**
 * Konva overlay for drawing/selecting/editing walls + placing/displaying openings.
 */
function WallDrawingLayerInner({
  onStageRef,
  walls,
  openings,
  wallThicknessByWallId,
  activeWallThicknessMm = 190,
  pierFootprintMm = 390,
  pierFootprintDepthMm,
  activeWallColor = '#ED7D31',
  visualWidth,
  visualHeight,
  cropX = 0,
  cropY = 0,
  cropW,
  cropH,
  pixelRatio,
  pxPerMmAtCurrentZoom,
  drawingMode,
  drawingCurveMode,
  placingOpening,
  placingControlJoint = false,
  placingTiedPier = false,
  placingFreestandingPier = false,
  isZooming = false,
  piers = [],
  selectedWallId,
  selectedOpeningId,
  selectedPierId = null,
  selectedWallIds,
  selectedOpeningIds,
  selectedPierIds,
  wallColorByWallId,
  pierColorByPierId,
  pierSizeByPierId,
  activeMakeupIdForHighlight = null,
  placingRuler = false,
  rulerAnchorMm = null,
  measurements = [],
  onRulerClick,
  selectedMeasurementId = null,
  onMeasurementSelect,
  onWallAdded,
  onCurvedWallAdded,
  onWallSelect,
  onWallToggleSelect,
  onOpeningToggleSelect,
  onPierToggleSelect,
  onWallEndpointMoved,
  onOpeningPlaced,
  onOpeningSelect,
  onControlJointPlaced,
  onTiedPierPlaced,
  onFreestandingPierPlaced,
  onPierSelect,
  onCancelDraw,
}: WallDrawingLayerProps) {
  const pxToMm = (px: number) => px / pxPerMmAtCurrentZoom
  const mmToPx = (mm: number) => mm * pxPerMmAtCurrentZoom

  /**
   * In-progress drawing state is stored in MM (real-world coordinates on the plan), not pixels.
   * Pixel positions are derived at render time using the current zoom, so anything you've
   * already placed stays anchored to the same physical point on the plan even if you zoom or pan.
   */
  const [startMm, setStartMm] = useState<Point | null>(null)
  /**
   * CAD-style typed length while drawing a wall. After the first click anchors
   * `startMm`, the user can type digits to override the cursor-distance length
   * — direction still comes from the cursor (and axis-snap), but the magnitude
   * is whatever they type. `Enter` commits, `Esc` clears, `Backspace` edits.
   * Empty string means "use the cursor distance as the length" (default).
   */
  const [typedLengthMm, setTypedLengthMm] = useState<string>('')
  /**
   * CAD-style typed width while placing an opening. After the first click
   * sets `openingPlacementStart`, the user can type digits to override
   * the cursor-distance width — direction (left or right of the first
   * point along the wall) still comes from the cursor. `Enter` commits,
   * `Esc` clears, `Backspace` edits. Same model as `typedLengthMm` for
   * walls.
   */
  const [typedOpeningWidthMm, setTypedOpeningWidthMm] = useState<string>('')
  /**
   * CAD-style typed radius while curve-drawing. After the two endpoint
   * clicks have anchored both ends of the chord, the user can type the
   * desired arc radius. Direction (which side of the chord the arc
   * bulges) still comes from the cursor position relative to the chord,
   * so the user can flip the curve by sweeping the cursor across.
   * `Enter` commits with that radius; `Esc` clears; `Backspace` edits.
   * Empty string means "use the cursor midpoint as the third arc
   * point" (legacy three-click flow).
   */
  const [typedCurveRadiusMm, setTypedCurveRadiusMm] = useState<string>('')
  const [cursorMm, setCursorMm] = useState<Point | null>(null)
  const [snapTarget, setSnapTarget] = useState<SnapResult | null>(null)
  const [hoveredWallId, setHoveredWallId] = useState<string | null>(null)

  /**
   * Anchor selections for curve drawing. Each anchor records a point on an existing
   * wall — either snapped to the wall's start/end (for clean endpoint-to-endpoint
   * curves), or anywhere along the wall's centreline (for curves that tie into the
   * middle of a wall, like a curved bay opening off a straight wall). The `wallId`
   * is kept around so the renderer can highlight the parent wall and so future
   * junction-aware logic can know which wall to tie into.
   */
  const [curveAnchorA, setCurveAnchorA] = useState<{
    /** Null when the anchor isn't snapped to any wall — free placement. */
    wallId: string | null
    xMm: number
    yMm: number
  } | null>(null)
  const [curveAnchorB, setCurveAnchorB] = useState<{
    /** Null when the anchor isn't snapped to any wall — free placement. */
    wallId: string | null
    xMm: number
    yMm: number
  } | null>(null)
  /** Hover preview during curve mode — projected position on the nearest wall, in MM. */
  const [curveAnchorHoverMm, setCurveAnchorHoverMm] = useState<Point | null>(null)
  /** Live cursor position during curve-midpoint hover, in MM. */
  const [curveCursorMm, setCurveCursorMm] = useState<Point | null>(null)
  const [dragPreviewMm, setDragPreviewMm] = useState<{
    wallId: string
    which: 'start' | 'end'
    mm: Point
  } | null>(null)

  /** First click during opening placement — stored by wall id + alongMm only. */
  const [openingPlacementStart, setOpeningPlacementStart] = useState<{
    wallId: string
    alongMm: number
  } | null>(null)
  /** Live projection while placing an opening (hover preview). */
  const [openingHoverProjection, setOpeningHoverProjection] = useState<WallProjection | null>(null)
  /** Live projection while placing a control joint (hover preview marker). */
  const [controlJointHover, setControlJointHover] = useState<WallProjection | null>(null)
  /** Live projection while placing a tied pier (hover preview). */
  const [tiedPierHover, setTiedPierHover] = useState<WallProjection | null>(null)
  /** Live cursor in mm while placing a freestanding pier. */
  const [freestandingPierHoverMm, setFreestandingPierHoverMm] = useState<Point | null>(null)

  // Derive current pixel positions from mm state — these recompute automatically on zoom.
  const startPx: Point | null = startMm ? { x: mmToPx(startMm.x), y: mmToPx(startMm.y) } : null
  const cursorPx: Point | null = cursorMm ? { x: mmToPx(cursorMm.x), y: mmToPx(cursorMm.y) } : null
  const dragPreview = dragPreviewMm
    ? {
        wallId: dragPreviewMm.wallId,
        which: dragPreviewMm.which,
        px: { x: mmToPx(dragPreviewMm.mm.x), y: mmToPx(dragPreviewMm.mm.y) },
      }
    : null

  /**
   * Snap target positions for each wall endpoint. The target depends on the junction:
   *
   * - **Corner**: at the centreline-centreline intersection of the two cornered walls
   *   (the geometric centre of the L corner area = the centre of the corner block for
   *   equal-thickness 90° L's).
   *
   * - **Free**: at the centre of the wall's LAST BLOCK — halfThickness IN from the wall's
   *   data endpoint, along the wall direction toward the body. Matches masonry practice:
   *   when you draw a new wall to corner with an existing one, you align with the centre
   *   of the existing wall's corner block, not its very end.
   *
   * - **T-junction**: at the data endpoint (which is already at a face).
   *
   * The snap radius is enlarged for thick walls so the user can point anywhere in the
   * end-block area and the snap still fires.
   */
  const endpointsPx: EndpointPixel[] = useMemo(() => {
    const result: EndpointPixel[] = []
    for (const w of walls) {
      for (const end of ['start', 'end'] as const) {
        const junction = end === 'start' ? w.startJunction : w.endJunction
        const dataX = end === 'start' ? w.startX : w.endX
        const dataY = end === 'start' ? w.startY : w.endY

        let snapX = dataX
        let snapY = dataY

        const thickness = wallThicknessByWallId[w.id] ?? 190
        const halfThicknessPx = mmToPx(thickness / 2)

        if (junction.type === 'corner') {
          const otherId = junction.connectedWallIds?.[0]
          if (otherId) {
            const other = walls.find((o) => o.id === otherId)
            if (other && !isCurvedWall(other)) {
              const intersection = intersectLinesMm(
                {
                  px: w.startX,
                  py: w.startY,
                  dx: w.endX - w.startX,
                  dy: w.endY - w.startY,
                },
                {
                  px: other.startX,
                  py: other.startY,
                  dx: other.endX - other.startX,
                  dy: other.endY - other.startY,
                }
              )
              if (intersection) {
                snapX = intersection.x
                snapY = intersection.y
              }
            }
          }
        } else if (junction.type === 'free') {
          // Pull the snap target halfThickness in from the data endpoint
          // along the wall direction — that's the exact geometric point
          // where the outer corner of the new wall will land. Matches the
          // overlap formula in wallLengthMm (which adds halfThickness at
          // a corner), so the typed length equals the final wall length:
          //   typed 2400 → centreline 2305 → wallLengthMm 2305 + 95 = 2400.
          // Earlier this was halfModular for modular-grid alignment but
          // the 5 mm gap between snap target and wall corner showed up as
          // both a visual offset at the L and a 5 mm shortfall in every
          // typed length.
          const farX = end === 'start' ? w.endX : w.startX
          const farY = end === 'start' ? w.endY : w.startY
          const dx = dataX - farX
          const dy = dataY - farY
          const len = Math.sqrt(dx * dx + dy * dy)
          if (len > 0) {
            const halfThicknessMm = thickness / 2
            const offset = Math.min(halfThicknessMm, len)
            const ux = dx / len
            const uy = dy / len
            snapX = dataX - ux * offset
            snapY = dataY - uy * offset
          }
        }

        // Snap radius (along-wall direction): snap target sits
        // halfThickness IN from the data endpoint, so a zone of
        // halfThickness covers from the data endpoint all the way to
        // 2× halfThickness inside the wall — anything deeper is
        // T-junction (face-snap) territory anyway. SNAP_THRESHOLD_PX
        // is the floor for very-low-zoom views where everything in mm
        // collapses to sub-pixel.
        const snapRadiusPx = Math.max(SNAP_THRESHOLD_PX, halfThicknessPx)

        // Direction vector (unit, in pixels) pointing from the far end outward
        // through this endpoint. For a free end we already have farX/farY in
        // scope; recompute for corner/T ends too. Used to project the cursor
        // offset into along-wall vs across-wall components in findSnap.
        const farXmm = end === 'start' ? w.endX : w.startX
        const farYmm = end === 'start' ? w.endY : w.startY
        const wDxMm = dataX - farXmm
        const wDyMm = dataY - farYmm
        const wLenMm = Math.sqrt(wDxMm * wDxMm + wDyMm * wDyMm)
        const dirX = wLenMm > 0 ? wDxMm / wLenMm : 1
        const dirY = wLenMm > 0 ? wDyMm / wLenMm : 0

        result.push({
          x: mmToPx(snapX),
          y: mmToPx(snapY),
          wallId: w.id,
          end,
          snapRadiusPx,
          dirX,
          dirY,
        })
      }
    }
    return result
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walls, pxPerMmAtCurrentZoom, wallThicknessByWallId])

  // ---------- Wall geometry helpers ----------

  function projectOntoWall(clickPx: Point, wall: Wall): WallProjection | null {
    // Curved walls — project radially onto the arc, returning the
    // along-arc distance in mm (so cut-wall / opening tools see the
    // same alongMm coordinate space they use for straight walls).
    if (isCurvedWall(wall) && wall.midX !== undefined && wall.midY !== undefined) {
      const geom = arcFromThreePoints(
        { x: wall.startX, y: wall.startY },
        { x: wall.midX, y: wall.midY },
        { x: wall.endX, y: wall.endY },
      )
      if (!geom) {
        // Degenerate (collinear) — fall through to straight-wall projection.
      } else {
        const clickMm = { x: pxToMm(clickPx.x), y: pxToMm(clickPx.y) }
        const arcProj = projectOntoArc(clickMm, geom)
        return {
          wallId: wall.id,
          alongMm: arcProj.alongMm,
          px: { x: mmToPx(arcProj.point.x), y: mmToPx(arcProj.point.y) },
          distFromLinePx: mmToPx(arcProj.distFromArcMm),
        }
      }
    }
    const sx = mmToPx(wall.startX)
    const sy = mmToPx(wall.startY)
    const ex = mmToPx(wall.endX)
    const ey = mmToPx(wall.endY)
    const dx = ex - sx
    const dy = ey - sy
    const lenSq = dx * dx + dy * dy
    if (lenSq === 0) return null
    const t = ((clickPx.x - sx) * dx + (clickPx.y - sy) * dy) / lenSq
    const tClamped = Math.max(0, Math.min(1, t))
    const projX = sx + tClamped * dx
    const projY = sy + tClamped * dy
    const distFromLinePx = Math.sqrt((clickPx.x - projX) ** 2 + (clickPx.y - projY) ** 2)
    const alongMm = tClamped * wallLengthMmOf(wall)
    return { wallId: wall.id, alongMm, px: { x: projX, y: projY }, distFromLinePx }
  }

  function findClosestWallProjection(
    clickPx: Point,
    only?: string
  ): WallProjection | null {
    let best: WallProjection | null = null
    for (const wall of walls) {
      if (only && wall.id !== only) continue
      const proj = projectOntoWall(clickPx, wall)
      if (!proj) continue
      if (proj.distFromLinePx > WALL_PROJECTION_THRESHOLD_PX) continue
      if (!best || proj.distFromLinePx < best.distFromLinePx) {
        best = proj
      }
    }
    return best
  }

  /**
   * Compute where a curve anchor would land for a given raw cursor position.
   *
   * Two anchor styles depending on where the cursor sits relative to the wall:
   *
   *   - **Side face** (cursor *alongside* the wall): the centreline projection
   *     at the cursor's along-wall position, offset half-thickness perpendicular
   *     toward the cursor's side. Used when the user is hugging the long edge
   *     of a wall — most curves that wrap around a corner.
   *
   *   - **End face** (cursor *past* either tip of the wall): the wall's
   *     centreline endpoint, no perpendicular offset. Lets the user extend a
   *     wall straight off its end with a curve, which is the natural move
   *     when continuing a wall around a curved corner of the building.
   *
   * The threshold here is more generous than the regular wall-snap radius —
   * curves are usually started a noticeable distance away from the wall,
   * unlike straight-wall snaps where the click sits right on the face.
   *
   * Returns null if the cursor is too far from any wall.
   */
  function resolveCurveAnchorAtCursor(
    cursorPx: Point
  ): { wallId: string | null; xMm: number; yMm: number } {
    // Modest threshold so the curve picks up an existing wall when the user
    // is clearly targeting one (cursor within ~25 px of the wall's drawn
    // line), but doesn't reach across dense layouts. Outside this radius we
    // fall through to a 'free' anchor at the raw cursor position.
    const CURVE_ANCHOR_THRESHOLD_PX = 25
    // END anchors snap at the same tight radius as the straight-wall
    // tool (SNAP_THRESHOLD_PX). The generous 25px radius is for SIDE
    // anchors only — peeling a curve off a wall face benefits from
    // reach, but endpoint snapping from 300mm away (at 1:100) made the
    // ends grab the cursor across half the drawing.
    const cursorMm = { x: pxToMm(cursorPx.x), y: pxToMm(cursorPx.y) }

    let best: {
      wallId: string
      distPx: number
      xMm: number
      yMm: number
    } | null = null
    const consider = (
      wallId: string,
      distPx: number,
      xMm: number,
      yMm: number,
      thresholdPx = CURVE_ANCHOR_THRESHOLD_PX
    ) => {
      if (distPx > thresholdPx) return
      if (!best || distPx < best.distPx) best = { wallId, distPx, xMm, yMm }
    }

    for (const wall of walls) {
      const halfTmm = (wallThicknessByWallId[wall.id] ?? 190) / 2

      // Curved walls: measure against the ACTUAL ARC, not the chord. The
      // chord of a deep arc runs through empty space far from the drawn
      // wall, so chord-distance snapping grabbed the cursor from way
      // outside the visible curve — and the straight-wall side-anchor
      // normal doesn't apply to an arc anyway.
      if (
        isCurvedWall(wall) &&
        wall.midX !== undefined &&
        wall.midY !== undefined
      ) {
        const geom = arcFromThreePoints(
          { x: wall.startX, y: wall.startY },
          { x: wall.midX, y: wall.midY },
          { x: wall.endX, y: wall.endY }
        )
        if (!geom) continue
        const arcProj = projectOntoArc(cursorMm, geom)
        const distPx = mmToPx(arcProj.distFromArcMm)
        // End anchors: projectOntoArc clamps to the arc's ends, so a
        // boundary hit means the cursor sits past that tip.
        const END_ZONE_MM = 1
        if (arcProj.alongMm <= END_ZONE_MM) {
          consider(wall.id, distPx, wall.startX, wall.startY, SNAP_THRESHOLD_PX)
        } else if (arcProj.alongMm >= geom.arcLengthMm - END_ZONE_MM) {
          consider(wall.id, distPx, wall.endX, wall.endY, SNAP_THRESHOLD_PX)
        } else {
          // Side-face anchor on the cursor's side of the arc: offset the
          // centreline projection radially — outward when the cursor is
          // outside the arc's radius, inward when inside.
          const rdx = arcProj.point.x - geom.centerX
          const rdy = arcProj.point.y - geom.centerY
          const rLen = Math.hypot(rdx, rdy)
          if (rLen < 1e-9) continue
          const cursorR = Math.hypot(
            cursorMm.x - geom.centerX,
            cursorMm.y - geom.centerY
          )
          const sign = cursorR >= geom.radiusMm ? 1 : -1
          consider(
            wall.id,
            distPx,
            arcProj.point.x + (rdx / rLen) * sign * halfTmm,
            arcProj.point.y + (rdy / rLen) * sign * halfTmm
          )
        }
        continue
      }

      // Straight walls: chord projection (the chord IS the wall).
      const sx = mmToPx(wall.startX)
      const sy = mmToPx(wall.startY)
      const ex = mmToPx(wall.endX)
      const ey = mmToPx(wall.endY)
      const dx = ex - sx
      const dy = ey - sy
      const lenSq = dx * dx + dy * dy
      if (lenSq === 0) continue
      const tUnclamped =
        ((cursorPx.x - sx) * dx + (cursorPx.y - sy) * dy) / lenSq
      const tClamped = Math.max(0, Math.min(1, tUnclamped))
      const projX = sx + tClamped * dx
      const projY = sy + tClamped * dy
      const distPx = Math.hypot(cursorPx.x - projX, cursorPx.y - projY)

      // End-face anchors: cursor past the wall's tip — anchor on the
      // centreline endpoint so a curve drawn from here continues
      // straight off the end of the wall.
      if (tUnclamped > 1) {
        consider(wall.id, distPx, wall.endX, wall.endY, SNAP_THRESHOLD_PX)
        continue
      }
      if (tUnclamped < 0) {
        consider(wall.id, distPx, wall.startX, wall.startY, SNAP_THRESHOLD_PX)
        continue
      }
      // Side-face anchor: half-thickness off the centreline projection,
      // on the cursor's side of the wall.
      const dxMm = wall.endX - wall.startX
      const dyMm = wall.endY - wall.startY
      const lenMm = Math.hypot(dxMm, dyMm)
      if (lenMm <= 0) continue
      const projXmm = wall.startX + tUnclamped * dxMm
      const projYmm = wall.startY + tUnclamped * dyMm
      const normXmm = -dyMm / lenMm
      const normYmm = dxMm / lenMm
      const dot =
        (cursorMm.x - projXmm) * normXmm + (cursorMm.y - projYmm) * normYmm
      const sign = dot >= 0 ? 1 : -1
      consider(
        wall.id,
        distPx,
        projXmm + sign * halfTmm * normXmm,
        projYmm + sign * halfTmm * normYmm
      )
    }

    if (!best) {
      return { wallId: null, xMm: cursorMm.x, yMm: cursorMm.y }
    }
    const resolved: { wallId: string; distPx: number; xMm: number; yMm: number } = best
    return { wallId: resolved.wallId, xMm: resolved.xMm, yMm: resolved.yMm }
  }

  /** A point along a wall, in pixel coords, given start-along-wall in mm. */
  function pointAlongWallPx(wall: Wall, alongMm: number): Point {
    const length = wallLengthMmOf(wall)
    const t = length === 0 ? 0 : alongMm / length
    const sx = mmToPx(wall.startX)
    const sy = mmToPx(wall.startY)
    const ex = mmToPx(wall.endX)
    const ey = mmToPx(wall.endY)
    return { x: sx + t * (ex - sx), y: sy + t * (ey - sy) }
  }

  function findSnap(
    cursor: Point,
    excludeWallId?: string,
    excludeEnd?: 'start' | 'end'
  ): SnapResult | null {
    // Unified snap ranking — collect every snap target whose acceptance
    // zone the cursor falls inside, then pick the ONE that's geometrically
    // closest to the cursor. Previously each snap kind ran in order (tip
    // → endpoint → face) and the first match won, so at the end of a
    // wall where 3 face snaps and a corner snap all sat within their
    // respective zones, the user couldn't reach the back ones — the
    // earlier-checked snap always claimed the cursor first. Picking the
    // closest target instead means moving the cursor a few px toward
    // your preferred snap target makes it win, no priority order to
    // fight against.
    type Candidate = {
      kind: 'endpoint' | 'body'
      x: number
      y: number
      wallId: string
      end?: 'start' | 'end'
      // Euclidean distance from cursor to snap target — the sort key.
      distance: number
    }
    const candidates: Candidate[] = []

    // 1. Endpoint (corner-block-centre) candidates — anisotropic zone:
    // generous along the wall axis (so the whole end-block area is a
    // corner candidate) but tight across (so a cursor parked beside the
    // end-face still ranks against face snaps below). Final win/lose is
    // resolved by total distance-to-target, not by being checked first.
    for (const ep of endpointsPx) {
      if (ep.wallId === excludeWallId && ep.end === excludeEnd) continue
      const vx = cursor.x - ep.x
      const vy = cursor.y - ep.y
      const alongAbs = Math.abs(vx * ep.dirX + vy * ep.dirY)
      const perpAbs = Math.abs(vx * -ep.dirY + vy * ep.dirX)
      if (alongAbs > ep.snapRadiusPx) continue
      if (perpAbs > SNAP_THRESHOLD_PX) continue
      candidates.push({
        kind: 'endpoint',
        x: ep.x,
        y: ep.y,
        wallId: ep.wallId,
        end: ep.end,
        distance: Math.sqrt(vx * vx + vy * vy),
      })
    }

    // 2. Face candidates — all FOUR faces of every existing wall (the two
    // long side faces and the two short end faces). Each face is treated
    // as a line segment in pixel space; the candidate is the closest point
    // on the segment to the cursor. The closest-snap-wins ranking below
    // then picks whichever face the cursor is closest to.
    const faceSnapPx = mmToPx(WALL_FACE_SNAP_MM)
    for (const wall of walls) {
      if (wall.id === excludeWallId) continue
      if (isCurvedWall(wall)) continue
      const thicknessMm = wallThicknessByWallId[wall.id] ?? 190
      const halfThicknessPx = mmToPx(thicknessMm / 2)
      const sx = mmToPx(wall.startX)
      const sy = mmToPx(wall.startY)
      const ex = mmToPx(wall.endX)
      const ey = mmToPx(wall.endY)
      const wDx = ex - sx
      const wDy = ey - sy
      const wLen = Math.sqrt(wDx * wDx + wDy * wDy)
      if (wLen === 0) continue
      // Wall direction (unit) and its perpendicular (unit) in pixel space.
      const ux = wDx / wLen
      const uy = wDy / wLen
      const nx = -uy
      const ny = ux
      // The four face segments — each defined by two endpoints in px.
      const faces: Array<{ a: Point; b: Point }> = [
        // Long side face +N (perpendicular outward, positive)
        {
          a: { x: sx + nx * halfThicknessPx, y: sy + ny * halfThicknessPx },
          b: { x: ex + nx * halfThicknessPx, y: ey + ny * halfThicknessPx },
        },
        // Long side face −N
        {
          a: { x: sx - nx * halfThicknessPx, y: sy - ny * halfThicknessPx },
          b: { x: ex - nx * halfThicknessPx, y: ey - ny * halfThicknessPx },
        },
        // Start end face (short edge at the start endpoint)
        {
          a: { x: sx + nx * halfThicknessPx, y: sy + ny * halfThicknessPx },
          b: { x: sx - nx * halfThicknessPx, y: sy - ny * halfThicknessPx },
        },
        // End end face (short edge at the end endpoint)
        {
          a: { x: ex + nx * halfThicknessPx, y: ey + ny * halfThicknessPx },
          b: { x: ex - nx * halfThicknessPx, y: ey - ny * halfThicknessPx },
        },
      ]
      for (const face of faces) {
        const fdx = face.b.x - face.a.x
        const fdy = face.b.y - face.a.y
        const fLenSq = fdx * fdx + fdy * fdy
        if (fLenSq <= 0) continue
        // Closest point on face segment to cursor.
        let t = ((cursor.x - face.a.x) * fdx + (cursor.y - face.a.y) * fdy) / fLenSq
        if (t < 0) t = 0
        if (t > 1) t = 1
        const cx = face.a.x + t * fdx
        const cy = face.a.y + t * fdy
        const ddx = cursor.x - cx
        const ddy = cursor.y - cy
        const dist = Math.sqrt(ddx * ddx + ddy * ddy)
        if (dist > faceSnapPx) continue
        candidates.push({
          kind: 'body',
          x: cx,
          y: cy,
          wallId: wall.id,
          distance: dist,
        })
      }
    }

    if (candidates.length === 0) return null
    // Lowest-distance candidate wins. Stable across redraws because the
    // distance is the unambiguous tiebreaker — same cursor position →
    // same winner.
    candidates.sort((a, b) => a.distance - b.distance)
    const best = candidates[0]
    if (best.kind === 'endpoint' && best.end) {
      return {
        kind: 'endpoint',
        x: best.x,
        y: best.y,
        wallId: best.wallId,
        end: best.end,
      }
    }
    return {
      kind: 'body',
      x: best.x,
      y: best.y,
      wallId: best.wallId,
    }
  }

  // ---------- Cleanup on mode toggle ----------
  useEffect(() => {
    if (!drawingMode) {
      setStartMm(null)
      setTypedLengthMm('')
      setCursorMm(null)
      setSnapTarget(null)
    }
  }, [drawingMode])

  useEffect(() => {
    if (!placingOpening) {
      setOpeningPlacementStart(null)
      setOpeningHoverProjection(null)
      setTypedOpeningWidthMm('')
    }
  }, [placingOpening])

  useEffect(() => {
    if (!placingControlJoint) setControlJointHover(null)
  }, [placingControlJoint])

  useEffect(() => {
    if (!placingTiedPier) setTiedPierHover(null)
  }, [placingTiedPier])

  useEffect(() => {
    if (!placingFreestandingPier) setFreestandingPierHoverMm(null)
  }, [placingFreestandingPier])

  useEffect(() => {
    if (!drawingCurveMode) {
      setCurveAnchorA(null)
      setCurveAnchorB(null)
      setCurveCursorMm(null)
      setCurveAnchorHoverMm(null)
    }
  }, [drawingCurveMode])

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      // Don't intercept anything while the user is typing in an input/textarea
      // — wall-type names, dimension fields etc. would be ruined.
      const tgt = e.target as HTMLElement | null
      const inField =
        !!tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' || tgt.isContentEditable)

      // CAD-style typed length while drawing — only valid once the first
      // click has anchored startMm. Direction still comes from the cursor;
      // typing overrides the distance. Now accepts feet-inches notation
      // (8'-6", 8'6 1/2") in addition to mm — parseLengthInput handles
      // both formats and returns mm.
      if (!inField && drawingMode && startMm) {
        // Allowed keystrokes: digits, decimal point/comma, and the
        // imperial markers ('", /, -, space). Anything else (including
        // letters) passes through so existing shortcuts still fire.
        if (e.key >= '0' && e.key <= '9') {
          e.preventDefault()
          setTypedLengthMm((prev) => prev + e.key)
          return
        }
        if (e.key === '.' || e.key === ',') {
          e.preventDefault()
          setTypedLengthMm((prev) => (prev.includes('.') ? prev : prev + '.'))
          return
        }
        if (
          e.key === "'" ||
          e.key === '"' ||
          e.key === '/' ||
          e.key === '-' ||
          e.key === ' '
        ) {
          e.preventDefault()
          setTypedLengthMm((prev) => prev + e.key)
          return
        }
        if (e.key === 'Backspace') {
          e.preventDefault()
          setTypedLengthMm((prev) => prev.slice(0, -1))
          return
        }
        if (e.key === 'Enter' && typedLengthMm.trim()) {
          e.preventDefault()
          const lengthMm = parseLengthInput(
            typedLengthMm,
            getUserSettings().preferences.units,
          )
          if (
            cursorMm &&
            lengthMm !== null &&
            Number.isFinite(lengthMm) &&
            lengthMm > 0
          ) {
            const dx = cursorMm.x - startMm.x
            const dy = cursorMm.y - startMm.y
            const cursorDist = Math.sqrt(dx * dx + dy * dy)
            if (cursorDist > 0.001) {
              const ux = dx / cursorDist
              const uy = dy / cursorDist
              // Typed value = intended DISPLAYED length. When the start
              // is at another wall's corner-block-centre, the corner
              // adds halfThickness to the displayed length, so the
              // stored centreline is shorter by that amount.
              const startAdjust = cornerLengthAdjustAt(startMm)
              const centreLength = Math.max(0, lengthMm - startAdjust)
              const endMm: Point = {
                x: startMm.x + ux * centreLength,
                y: startMm.y + uy * centreLength,
              }
              onWallAdded(startMm, endMm)
              // Continuous draw — chain from the corner-block-centre of
              // the just-committed wall's free end, same offset as the
              // click-commit path above. Typed-length commits are always
              // "free" (no snap target on Enter), so always pull back.
              const halfT = activeWallThicknessMm / 2
              setStartMm({
                x: endMm.x - ux * halfT,
                y: endMm.y - uy * halfT,
              })
              setCursorMm(null)
              setSnapTarget(null)
              setTypedLengthMm('')
            }
          }
          return
        }
      }

      // Same typed-value model for openings — once the first click has
      // anchored openingPlacementStart, digits / dot / backspace edit a
      // typed width that overrides the cursor distance on Enter. Direction
      // (which side of the anchor along the wall) still comes from the
      // current hover position so the user can flip it just by moving the
      // cursor past the anchor before pressing Enter.
      if (!inField && placingOpening && openingPlacementStart) {
        if (e.key >= '0' && e.key <= '9') {
          e.preventDefault()
          setTypedOpeningWidthMm((prev) => prev + e.key)
          return
        }
        if (e.key === '.' || e.key === ',') {
          e.preventDefault()
          setTypedOpeningWidthMm((prev) => (prev.includes('.') ? prev : prev + '.'))
          return
        }
        if (e.key === 'Backspace') {
          e.preventDefault()
          setTypedOpeningWidthMm((prev) => prev.slice(0, -1))
          return
        }
        if (e.key === 'Enter' && typedOpeningWidthMm.trim()) {
          e.preventDefault()
          const widthMm = parseFloat(typedOpeningWidthMm)
          if (Number.isFinite(widthMm) && widthMm >= 100) {
            // Direction from cursor: openingHoverProjection.alongMm > start
            // means cursor is "past" the anchor → opening extends in that
            // direction. If the cursor sits on or before the anchor, fall
            // back to "extend forward" (alongMm + width) which gives the
            // user a sensible default and matches the typical workflow of
            // clicking at the opening's left edge.
            const startAlong = openingPlacementStart.alongMm
            const cursorAlong = openingHoverProjection?.alongMm ?? startAlong + widthMm
            const finalStart = cursorAlong >= startAlong
              ? startAlong
              : startAlong - widthMm
            onOpeningPlaced(openingPlacementStart.wallId, finalStart, widthMm)
            setOpeningPlacementStart(null)
            setOpeningHoverProjection(null)
            setTypedOpeningWidthMm('')
          }
          return
        }
      }

      // Curve-radius typing: after both endpoints have been clicked, digits
      // edit a target radius. On Enter, we compute the arc midpoint that
      // makes A→M→B a circular arc of that radius, with the bulge
      // direction determined by which side of the chord the cursor is
      // currently sitting on. Lets the user dial in an exact radius
      // (e.g. R1200) instead of trying to land a midpoint click that
      // happens to produce the right arc.
      if (!inField && drawingCurveMode && curveAnchorA && curveAnchorB) {
        if (e.key >= '0' && e.key <= '9') {
          e.preventDefault()
          setTypedCurveRadiusMm((prev) => prev + e.key)
          return
        }
        if (e.key === '.' || e.key === ',') {
          e.preventDefault()
          setTypedCurveRadiusMm((prev) => (prev.includes('.') ? prev : prev + '.'))
          return
        }
        if (e.key === 'Backspace') {
          e.preventDefault()
          setTypedCurveRadiusMm((prev) => prev.slice(0, -1))
          return
        }
        if (e.key === 'Enter' && typedCurveRadiusMm.trim()) {
          e.preventDefault()
          const radiusMm = parseFloat(typedCurveRadiusMm)
          if (
            Number.isFinite(radiusMm) &&
            radiusMm > 0 &&
            curveCursorMm
          ) {
            // Chord geometry between the two anchors.
            const A = { x: curveAnchorA.xMm, y: curveAnchorA.yMm }
            const B = { x: curveAnchorB.xMm, y: curveAnchorB.yMm }
            const dx = B.x - A.x
            const dy = B.y - A.y
            const chordLen = Math.sqrt(dx * dx + dy * dy)
            // For an arc to exist, the chord can't exceed the circle's
            // diameter (2R). When the user types a too-small radius we
            // could either clamp or reject — rejecting feels safer
            // because clamping silently produces an arc that doesn't
            // match the typed number.
            if (chordLen > 0 && 2 * radiusMm >= chordLen - 0.001) {
              const halfChord = chordLen / 2
              // sagitta = R - sqrt(R² - half²) — the perpendicular
              // distance from chord midpoint to arc midpoint.
              const sag = radiusMm - Math.sqrt(Math.max(0, radiusMm * radiusMm - halfChord * halfChord))
              // Perpendicular unit vector to the chord (one of two
              // possible directions; the cursor's side picks which).
              const perpX = -dy / chordLen
              const perpY = dx / chordLen
              // 2D cross product (B-A) × (cursor-A) tells us which side
              // of the chord the cursor sits on. Positive → one side,
              // negative → the other. We flip the perpendicular to
              // match so the arc bulges toward the cursor.
              const cx = curveCursorMm.x - A.x
              const cy = curveCursorMm.y - A.y
              const cross = dx * cy - dy * cx
              const side = cross >= 0 ? 1 : -1
              const midX = (A.x + B.x) / 2
              const midY = (A.y + B.y) / 2
              const M = {
                x: midX + perpX * sag * side,
                y: midY + perpY * sag * side,
              }
              onCurvedWallAdded(A, M, B)
              setCurveAnchorA(null)
              setCurveAnchorB(null)
              setCurveCursorMm(null)
              setTypedCurveRadiusMm('')
            }
          }
          return
        }
      }

      if (e.key === 'Escape') {
        // Esc is the universal "back to neutral" key — one press exits any
        // active drawing/placing mode AND clears any in-progress geometry
        // AND drops any selection AND dismisses the active-makeup glow.
        // Unconditional so the user can mash Esc from any state and know
        // they're back to the free-hand view, ready to click around again.

        // Clear in-progress wall draw state
        setStartMm(null)
        setCursorMm(null)
        setSnapTarget(null)
        setTypedLengthMm('')

        // Clear in-progress curve draw state
        setCurveAnchorA(null)
        setCurveAnchorB(null)
        setCurveCursorMm(null)
        setCurveAnchorHoverMm(null)
        setTypedCurveRadiusMm('')

        // Clear in-progress placement hovers
        setOpeningPlacementStart(null)
        setOpeningHoverProjection(null)
        setTypedOpeningWidthMm('')
        setControlJointHover(null)
        setTiedPierHover(null)
        setFreestandingPierHoverMm(null)

        // Drop any selection so the canvas is in pure view mode
        const hasWallSelection =
          !!selectedWallId || (selectedWallIds && selectedWallIds.size > 0)
        const hasOpeningSelection =
          !!selectedOpeningId || (selectedOpeningIds && selectedOpeningIds.size > 0)
        const hasPierSelection =
          !!selectedPierId || (selectedPierIds && selectedPierIds.size > 0)
        if (hasWallSelection) onWallSelect(null)
        if (hasOpeningSelection) onOpeningSelect(null)
        if (hasPierSelection && onPierSelect) onPierSelect(null)
        if (selectedMeasurementId && onMeasurementSelect) onMeasurementSelect(null)

        // Tell the parent to exit every drawing mode and dismiss the
        // active-makeup glow. Safe to call unconditionally — when nothing
        // is active it's a no-op.
        onCancelDraw?.()
      }
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [drawingMode, drawingCurveMode, placingOpening, placingControlJoint, placingTiedPier, placingFreestandingPier, placingRuler, selectedWallId, selectedOpeningId, selectedPierId, selectedWallIds, selectedOpeningIds, selectedPierIds, selectedMeasurementId, onCancelDraw, onWallSelect, onOpeningSelect, onPierSelect, onMeasurementSelect, startMm, cursorMm, typedLengthMm, onWallAdded, openingPlacementStart, openingHoverProjection, typedOpeningWidthMm, onOpeningPlaced, curveAnchorA, curveAnchorB, curveCursorMm, typedCurveRadiusMm, onCurvedWallAdded])

  function setCursor(stage: Konva.Stage | null, cursor: string) {
    if (stage) stage.container().style.cursor = cursor
  }

  /**
   * If `pointMm` coincides with another wall's free-end corner-block-centre
   * (the inset snap target where corners form), return halfThickness of
   * that wall — the same value the post-placement length label adds for
   * the corner block extension. Zero otherwise. Used by the live wall-draw
   * preview to show the same length the wall will read after the click
   * commits it.
   */
  function cornerLengthAdjustAt(pointMm: Point): number {
    for (const w of walls) {
      if (isCurvedWall(w)) continue
      // halfThickness — matches both the snap-target offset (drawn
      // halfThickness IN from the data endpoint) and the corner
      // overlap formula in wallLengthMm (which adds halfThickness back
      // for the outer corner extension). Subtracting halfThickness from
      // the user's typed length here gives a centreline that, after
      // wallLengthMm's add-back, lands exactly on the typed value.
      const halfThickness = (wallThicknessByWallId[w.id] ?? 190) / 2
      for (const which of ['start' as const, 'end' as const]) {
        const junction = which === 'start' ? w.startJunction : w.endJunction
        if (junction.type !== 'free') continue
        const dataX = which === 'start' ? w.startX : w.endX
        const dataY = which === 'start' ? w.startY : w.endY
        const farX = which === 'start' ? w.endX : w.startX
        const farY = which === 'start' ? w.endY : w.startY
        const ddx = dataX - farX
        const ddy = dataY - farY
        const len = Math.sqrt(ddx * ddx + ddy * ddy)
        if (len < 0.001) continue
        const insetX = dataX - (ddx / len) * halfThickness
        const insetY = dataY - (ddy / len) * halfThickness
        if (
          Math.abs(pointMm.x - insetX) < 1 &&
          Math.abs(pointMm.y - insetY) < 1
        ) {
          return halfThickness
        }
      }
    }
    return 0
  }


  /**
   * Wall-snap first, axis-snap second. If the cursor is in range of an
   * existing wall's endpoint or face, snapping to that wins outright —
   * users always want geometric continuity over a small angular tweak.
   * Otherwise, if the resulting segment from `anchor` → cursor is within
   * a few degrees of horizontal or vertical, flatten it to the axis.
   *
   * Returns the resolved point plus a hint about which (if any) snap fired,
   * so callers can mirror it into the snap-target state for the visual
   * indicator.
   *
   * The `shiftKey` argument bypasses axis-snap (wall-snap still applies) —
   * useful for tracing a plan where one wall is genuinely on an angle but
   * happens to point within a few degrees of horizontal.
   */

  function resolveDrawSnap(
    pos: Point,
    anchor: Point | null,
    shiftKey: boolean,
    excludeWallId?: string,
    excludeEnd?: 'start' | 'end',
  ): { point: Point; snap: SnapResult | null } {
    // Shift bypasses ALL snaps — wall-snap, axis-snap, length-snap. Escape
    // hatch for when the endpoint snap is "eating" a length the user wants
    // to draw past.
    if (shiftKey) {
      return { point: pos, snap: null }
    }

    const snap = findSnap(pos, excludeWallId, excludeEnd)
    if (snap) {
      // Snap target is the corner-block-centre (for endpoint snaps) or the
      // wall's face (for body snaps). Both come straight out of findSnap;
      // no special-case adjustment.
      return { point: { x: snap.x, y: snap.y }, snap }
    }

    if (!anchor) return { point: pos, snap: null }

    // Axis snap first — pulls a near-orthogonal segment cleanly onto h/v.
    const axisSnapped = applyAxisSnap(anchor, pos)

    // Length snap — pull the segment's real-world length to the nearest 5 mm
    // grid line and rescale the vector. Preserves the (axis-snapped)
    // direction so a diagonal wall stays diagonal; only the length changes.
    // Skip when the rounded length would be 0 (cursor effectively on the
    // anchor) — collapsing to zero would leave the preview wall stuck on
    // its origin.
    const dxPx = axisSnapped.x - anchor.x
    const dyPx = axisSnapped.y - anchor.y
    const lenPx = Math.sqrt(dxPx * dxPx + dyPx * dyPx)
    if (lenPx <= 0) return { point: axisSnapped, snap: null }
    const lenMm = pxToMm(lenPx)
    // Grid-snap the DISPLAYED (outer) length, not the raw centreline.
    // An anchor that will form a corner sits halfThickness inside the
    // outer corner, and wallLengthMm adds that extension back after
    // placement — so snapping the centreline to 50s made the displayed
    // length read 1045 / 1095 / ... off a 190-thick corner. Same
    // correction the typed-length path applies via
    // cornerLengthAdjustAt: snap (length + extension) to the grid,
    // then store the centreline remainder.
    const startAdjust = cornerLengthAdjustAt({
      x: pxToMm(anchor.x),
      y: pxToMm(anchor.y),
    })
    const snappedDisplayMm = snapMmToGrid(lenMm + startAdjust, wallSnapMm)
    const snappedMm = snappedDisplayMm - startAdjust
    if (snappedMm < Math.min(wallSnapMm, 50) || snappedMm <= 0) {
      return { point: axisSnapped, snap: null }
    }
    const scale = snappedMm / lenMm
    const lengthSnapped = {
      x: anchor.x + dxPx * scale,
      y: anchor.y + dyPx * scale,
    }
    return { point: lengthSnapped, snap: null }
  }

  // ── Render-window canvas density ──
  // When PdfWorkspace supplies a crop + pixelRatio (deep zoom), raise
  // every layer's canvas backing density so the live stage rasterises
  // at true screen resolution. Konva re-applies the canvas size from
  // (stage size x pixelRatio) inside setPixelRatio, so this is safe to
  // run after any crop/size commit. Default density (devicePixelRatio)
  // is restored when the crop is dropped.
  const stageSelfRef = useRef<Konva.Stage | null>(null)
  useEffect(() => {
    const stage = stageSelfRef.current
    if (!stage) return
    const ratio =
      pixelRatio ??
      (typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1)
    for (const layer of stage.getLayers()) {
      layer.getCanvas().setPixelRatio(ratio)
    }
    stage.batchDraw()
  }, [pixelRatio, cropX, cropY, cropW, cropH, visualWidth, visualHeight])

  // ---------- Stage events ----------

  function handleStageClick(e: Konva.KonvaEventObject<MouseEvent>) {
    // Konva fires the synthetic 'click' event for ANY mouse button, not just
    // left. Right-click is reserved here for the container's pan handler
    // (PdfWorkspace), so any non-left click should be a no-op at this layer
    // — otherwise releasing a right-drag-pan would still drop a wall point
    // / opening / calibration mark at the cursor's final position.
    if (e.evt.button !== 0) return
    const stage = e.target.getStage()
    if (!stage) return
    // Transform-aware pointer: with a render-window crop the stage
    // carries an x/y offset, so the RELATIVE position is the
    // rendered-page-space coordinate all the maths below expect.
    // Identity transform without a crop — same value as before.
    const raw = stage.getRelativePointerPosition()
    if (!raw) return

    if (drawingMode) {
      // First click: just record the anchor (axis-snap has nothing to anchor
      // to yet; wall-snap is still active so corners and T-junctions snap).
      // Second click: snap relative to startMm, with shiftKey overriding the
      // ortho lock — see resolveDrawSnap.
      if (!startMm) {
        const { point } = resolveDrawSnap(raw, null, e.evt.shiftKey)
        const posMm: Point = { x: pxToMm(point.x), y: pxToMm(point.y) }
        setStartMm(posMm)
        setCursorMm(posMm)
        return
      }
      const startPxAnchor = { x: mmToPx(startMm.x), y: mmToPx(startMm.y) }
      const { point, snap: clickSnap } = resolveDrawSnap(
        raw,
        startPxAnchor,
        e.evt.shiftKey,
      )
      if (distance(startPxAnchor, point) < 5) return
      let posMm: Point = { x: pxToMm(point.x), y: pxToMm(point.y) }
      // Typed value = intended DISPLAYED length. Subtract start corner
      // extension to get the stored centreline so the post-placement
      // label reads exactly what the user typed. parseLengthInput
      // handles both metric (2400, 2.4m) and imperial (8'-6") notation.
      const parsedTyped = parseLengthInput(
        typedLengthMm,
        getUserSettings().preferences.units,
      )
      const typedNum = parsedTyped ?? NaN
      if (typedLengthMm.trim() && Number.isFinite(typedNum) && typedNum > 0) {
        const dx = posMm.x - startMm.x
        const dy = posMm.y - startMm.y
        const cursorDist = Math.sqrt(dx * dx + dy * dy)
        if (cursorDist > 0.001) {
          const ux = dx / cursorDist
          const uy = dy / cursorDist
          const startAdjust = cornerLengthAdjustAt(startMm)
          const centreLength = Math.max(0, typedNum - startAdjust)
          posMm = {
            x: startMm.x + ux * centreLength,
            y: startMm.y + uy * centreLength,
          }
        }
      }
      onWallAdded(startMm, posMm)
      // Continuous wall draw: chain the next segment from the just-
      // committed wall's free end. The user can press Esc to actually
      // exit drawing mode (handled in the global keydown below — clears
      // startMm + onCancelDraw). This matches CAD-style polyline tools.
      //
      // Where to anchor the next wall depends on what posMm represents:
      //   - If the click HIT a snap target (another wall's corner /
      //     T-junction / wall body), posMm is already a snap point and
      //     the next wall should chain from there as-is.
      //   - Otherwise the click is a free end. resolveDrawSnap returned
      //     the data endpoint, but the visual outer-corner point sits
      //     halfThickness IN from there along the wall's direction —
      //     matching endpointsPx's snap target for existing walls AND
      //     junctions.ts's endpointsFormCorner check (both use
      //     halfThickness now). Mismatching halfModular vs halfThickness
      //     here puts the next wall 5 mm off the corner-detection
      //     window so corners stop forming and the two free ends just
      //     overlap — the exact bug the user reported on chained draws.
      let chainAnchor: Point = posMm
      if (!clickSnap) {
        const dx = posMm.x - startMm.x
        const dy = posMm.y - startMm.y
        const dist = Math.sqrt(dx * dx + dy * dy)
        if (dist > 0.001) {
          const ux = dx / dist
          const uy = dy / dist
          const halfT = activeWallThicknessMm / 2
          chainAnchor = {
            x: posMm.x - ux * halfT,
            y: posMm.y - uy * halfT,
          }
        }
      }
      setStartMm(chainAnchor)
      // Clear the cursor so we don't render a zero-length silhouette at
      // the moment of commit. Next mousemove repopulates it.
      setCursorMm(null)
      setSnapTarget(null)
      setTypedLengthMm('')
      return
    }

    // Shift on any non-wall placement bypasses the 5 mm grid so the user can
    // drop something at an off-grid spot if they truly need to.
    const useGrid = !e.evt.shiftKey

    if (placingOpening) {
      const onlyWall = openingPlacementStart?.wallId
      // Try a fresh projection first; if the cursor has wandered off
      // the wall mid-placement, fall back to the last valid hover so a
      // brief drag-off doesn't lose the in-progress opening. The first
      // click still requires a real wall hit (otherwise we have no
      // anchor to project against).
      const projFresh = findClosestWallProjection(raw, onlyWall)
      const proj =
        projFresh ?? (openingPlacementStart ? openingHoverProjection : null)
      if (!proj) return
      // Round alongMm to the 10 mm OPENING grid so both edges of every
      // opening land on a clean increment and the width comes out as a
      // multiple of 10 mm — matches how doors and windows are spec'd in
      // the real world. Shift-click bypasses for an off-grid placement.
      const snappedAlong = useGrid ? snapOpeningMm(proj.alongMm) : proj.alongMm
      if (!openingPlacementStart) {
        setOpeningPlacementStart({ wallId: proj.wallId, alongMm: snappedAlong })
        return
      }
      // Second click — compute opening start + width
      const a = openingPlacementStart.alongMm
      const b = snappedAlong
      const startAlong = Math.min(a, b)
      const widthMm = Math.abs(b - a)
      if (widthMm < 100) return // ignore degenerate
      onOpeningPlaced(proj.wallId, startAlong, widthMm)
      setOpeningPlacementStart(null)
      setOpeningHoverProjection(null)
      setTypedOpeningWidthMm('')
      return
    }

    if (placingControlJoint) {
      const proj = findClosestWallProjection(raw)
      if (!proj) return
      const wall = walls.find((w) => w.id === proj.wallId)
      if (!wall) return
      // Both straight and curved walls are splittable now — projectOntoWall
      // returns alongMm in arc-length units for curves, and
      // handleControlJointPlaced uses splitArcAtParameter to derive
      // the two sub-arcs. Grid snap is skipped on curves (snapping an
      // arc-length to a 10 mm grid doesn't translate visually the way
      // it does for a straight wall).
      const snapped =
        isCurvedWall(wall) || !useGrid
          ? proj.alongMm
          : snapMmToGrid(proj.alongMm, wallSnapMm)
      onControlJointPlaced?.(proj.wallId, snapped)
      setControlJointHover(null)
      return
    }

    if (placingTiedPier) {
      const proj = findClosestWallProjection(raw)
      if (!proj) return
      const wall = walls.find((w) => w.id === proj.wallId)
      if (!wall || isCurvedWall(wall)) return
      onTiedPierPlaced?.(
        proj.wallId,
        useGrid ? snapMmToGrid(proj.alongMm, wallSnapMm) : proj.alongMm
      )
      setTiedPierHover(null)
      return
    }

    if (placingFreestandingPier) {
      // Single "+ Pier" mode routes the click based on whether it lands inside a
      // wall's body:
      //   - inside wall body (perpendicular distance from centreline ≤ halfThickness)
      //     → tied pier on that wall at the projected along-wall position;
      //   - otherwise → freestanding pier at the click coordinates.
      // Curved walls are excluded for tied piers (piers don't ride curves yet),
      // so a click on a curve falls through to freestanding.
      let tiedWallId: string | null = null
      let tiedAlongMm = 0
      for (const wall of walls) {
        if (isCurvedWall(wall)) continue
        const proj = projectOntoWall(raw, wall)
        if (!proj) continue
        const thicknessMm = wallThicknessByWallId[wall.id] ?? 190
        const halfThicknessPx = mmToPx(thicknessMm / 2)
        if (proj.distFromLinePx <= halfThicknessPx) {
          tiedWallId = wall.id
          tiedAlongMm = proj.alongMm
          break
        }
      }
      if (tiedWallId !== null) {
        onTiedPierPlaced?.(
          tiedWallId,
          useGrid ? snapMmToGrid(tiedAlongMm, wallSnapMm) : tiedAlongMm
        )
      } else {
        const xMm = pxToMm(raw.x)
        const yMm = pxToMm(raw.y)
        onFreestandingPierPlaced?.(
          useGrid ? snapMmToGrid(xMm, wallSnapMm) : xMm,
          useGrid ? snapMmToGrid(yMm, wallSnapMm) : yMm
        )
      }
      setFreestandingPierHoverMm(null)
      setTiedPierHover(null)
      return
    }

    if (placingRuler) {
      // Ruler doesn't snap to existing walls / endpoints — but DOES snap
      // to horizontal / vertical once an anchor is down, so a near-
      // axis-aligned drag locks to the exact axis. Shift bypasses the
      // axis snap for genuinely angled measurements.
      const rawMm = { x: pxToMm(raw.x), y: pxToMm(raw.y) }
      const committed = rulerAnchorMm
        ? snapRulerToAxis(rulerAnchorMm, rawMm, e.evt.shiftKey)
        : rawMm
      onRulerClick?.(committed)
      return
    }

    if (drawingCurveMode) {
      // Clicks 1 & 2: anchor on the nearest wall's centreline if one is in
      // range (endpoint snap kicks in when the click is close to either end),
      // OTHERWISE free placement at the cursor's mm coords. The user can
      // draw a curve between any two points; existing-wall snap is a
      // convenience, not a requirement.
      if (!curveAnchorA || !curveAnchorB) {
        const anchor = resolveCurveAnchorAtCursor(raw)
        if (!curveAnchorA) {
          setCurveAnchorA(anchor)
        } else {
          setCurveAnchorB(anchor)
        }
        setCurveAnchorHoverMm(null)
        return
      }
      // Click 3: midpoint of the arc (free position, no snap to existing walls).
      const midMm: Point = { x: pxToMm(raw.x), y: pxToMm(raw.y) }
      onCurvedWallAdded(
        { x: curveAnchorA.xMm, y: curveAnchorA.yMm },
        midMm,
        { x: curveAnchorB.xMm, y: curveAnchorB.yMm }
      )
      setCurveAnchorA(null)
      setCurveAnchorB(null)
      setCurveCursorMm(null)
      return
    }

    // View mode: clicking on empty stage area deselects. Konva only fires onClick when
    // there's no significant drag, so a click+drag (pan) won't trigger deselect.
    if (e.target === e.target.getStage()) {
      if (selectedWallId) onWallSelect(null)
      if (selectedOpeningId) onOpeningSelect(null)
      if (selectedPierId && onPierSelect) onPierSelect(null)
      if (selectedMeasurementId && onMeasurementSelect) onMeasurementSelect(null)
    }
  }

  function handleStageMouseMove(e: Konva.KonvaEventObject<MouseEvent>) {
    const stage = e.target.getStage()
    if (!stage) return
    const raw = stage.getRelativePointerPosition()
    if (!raw) return

    if (drawingMode) {
      // While the user is moving the cursor for the second click, anchor
      // axis-snap to startMm. Before the first click there's no anchor,
      // so axis-snap is a no-op (wall-snap still runs). Shift bypasses
      // the ortho lock.
      const startPxAnchor = startMm
        ? { x: mmToPx(startMm.x), y: mmToPx(startMm.y) }
        : null
      // Alt held during the cursor move also routes through resolveDrawSnap
      const { point, snap } = resolveDrawSnap(
        raw,
        startPxAnchor,
        e.evt.shiftKey,
      )
      setSnapTarget(snap)
      setCursorMm({ x: pxToMm(point.x), y: pxToMm(point.y) })
    } else if (drawingCurveMode) {
      if (curveAnchorA && curveAnchorB) {
        // Both anchors set — follow the cursor for the arc-midpoint preview.
        setCurveCursorMm({ x: pxToMm(raw.x), y: pxToMm(raw.y) })
      } else {
        // Still picking anchors — show where the click would land. Snaps
        // to the nearest wall edge when within range, otherwise tracks
        // the cursor's mm position for free placement.
        const preview = resolveCurveAnchorAtCursor(raw)
        setCurveAnchorHoverMm({ x: preview.xMm, y: preview.yMm })
      }
    } else if (placingOpening) {
      const onlyWall = openingPlacementStart?.wallId
      const proj = findClosestWallProjection(raw, onlyWall)
      if (proj) {
        // Snap the hover preview to the same 10 mm grid the click uses so
        // the live width readout climbs in 10 mm steps — matches how doors
        // and windows are spec'd and lets the user dial in 900 / 1200 mm
        // by sliding the cursor a few millimetres rather than chasing a
        // sub-pixel position. Shift bypasses the snap for off-grid
        // placements, mirroring handleStageClick. Also re-project the
        // snapped alongMm onto the wall so the preview line lands on the
        // grid visually, not just numerically.
        const useGrid = !e.evt.shiftKey
        const snappedAlong = useGrid ? snapOpeningMm(proj.alongMm) : proj.alongMm
        const wall = wallsById.get(proj.wallId)
        const snappedPx = wall ? pointAlongWallPx(wall, snappedAlong) : proj.px
        setOpeningHoverProjection({
          ...proj,
          alongMm: snappedAlong,
          px: snappedPx,
        })
      } else if (!openingPlacementStart) {
        // No anchor yet → no preview to keep alive.
        setOpeningHoverProjection(null)
      }
      // Cursor left the wall mid-placement: deliberately DON'T clear
      // the hover. Holding the last valid projection means a brief
      // wander off the wall (mouse jitter, dragging past an end, etc.)
      // doesn't abort the in-progress opening — the live width readout
      // and the second-click commit both keep using the last snap.
    } else if (placingControlJoint) {
      // Cut wall now works on both straight AND curved walls.
      // projectOntoWall returns a curve-aware projection (radial onto
      // the arc, alongMm in arc length), so the hover dot lands on
      // the curve where the cursor sits and the split point will
      // match.
      setControlJointHover(findClosestWallProjection(raw))
    } else if (placingTiedPier) {
      const proj = findClosestWallProjection(raw)
      if (proj) {
        const wall = walls.find((w) => w.id === proj.wallId)
        if (wall && isCurvedWall(wall)) {
          setTiedPierHover(null)
          return
        }
      }
      setTiedPierHover(proj)
    } else if (placingRuler) {
      // Ruler hover: once an anchor is down, the live preview line
      // axis-snaps to horizontal / vertical when within the snap
      // window. Shift bypasses. Before the anchor is set the cursor
      // tracks the raw pointer (nothing to snap relative to).
      setSnapTarget(null)
      const rawMm = { x: pxToMm(raw.x), y: pxToMm(raw.y) }
      const shiftDown = !!(e.evt as MouseEvent & { shiftKey?: boolean }).shiftKey
      setCursorMm(
        rulerAnchorMm ? snapRulerToAxis(rulerAnchorMm, rawMm, shiftDown) : rawMm
      )
    } else if (placingFreestandingPier) {
      // Unified pier mode — preview matches what the click would actually do:
      // show the tied-pier hover when the cursor sits inside a straight wall's
      // body, otherwise the freestanding preview at the cursor position.
      let bodyHit: WallProjection | null = null
      for (const wall of walls) {
        if (isCurvedWall(wall)) continue
        const proj = projectOntoWall(raw, wall)
        if (!proj) continue
        const thicknessMm = wallThicknessByWallId[wall.id] ?? 190
        const halfThicknessPx = mmToPx(thicknessMm / 2)
        if (proj.distFromLinePx <= halfThicknessPx) {
          bodyHit = proj
          break
        }
      }
      if (bodyHit) {
        setTiedPierHover(bodyHit)
        setFreestandingPierHoverMm(null)
      } else {
        setTiedPierHover(null)
        setFreestandingPierHoverMm({ x: pxToMm(raw.x), y: pxToMm(raw.y) })
      }
    }
  }

  function handleStageMouseDown(_e: Konva.KonvaEventObject<MouseEvent>) {
    // Empty intentionally: deselect is handled by the click handler (so it only fires when
    // there's no drag), and pan is started by the container's mousedown bubbling from here.
  }

  // ---------- Endpoint drag ----------

  /**
   * The opposite-end anchor for axis-snap during an endpoint drag, in pixels.
   * `null` if the wall has gone missing somehow — caller falls back to no
   * axis-snap in that case.
   */
  function oppositeEndPx(wallId: string, dragging: 'start' | 'end'): Point | null {
    const wall = wallsById.get(wallId)
    if (!wall) return null
    const opp = dragging === 'start'
      ? { x: wall.endX, y: wall.endY }
      : { x: wall.startX, y: wall.startY }
    return { x: mmToPx(opp.x), y: mmToPx(opp.y) }
  }

  function handleEndpointDragMove(
    e: Konva.KonvaEventObject<DragEvent>,
    wallId: string,
    which: 'start' | 'end'
  ) {
    const pos = e.target.position()
    // Wall-snap wins over axis-snap (same precedence as during drawing).
    // Holding Shift bypasses the ortho lock for walls that genuinely sit on
    // a slight angle.
    const anchor = oppositeEndPx(wallId, which)
    const shiftKey = !!(e.evt as DragEvent & { shiftKey?: boolean }).shiftKey
    const { point: resolved, snap } = resolveDrawSnap(
      pos,
      anchor,
      shiftKey,
      wallId,
      which
    )
    // Push the dragged marker back to the snapped position so it visually
    // tracks the snap target (the user sees the endpoint click into place).
    if (resolved.x !== pos.x || resolved.y !== pos.y) {
      e.target.position(resolved)
    }
    setSnapTarget(snap)
    setDragPreviewMm({
      wallId,
      which,
      mm: { x: pxToMm(resolved.x), y: pxToMm(resolved.y) },
    })
  }

  function handleEndpointDragEnd(
    e: Konva.KonvaEventObject<DragEvent>,
    wallId: string,
    which: 'start' | 'end'
  ) {
    const pos = e.target.position()
    const anchor = oppositeEndPx(wallId, which)
    const shiftKey = !!(e.evt as DragEvent & { shiftKey?: boolean }).shiftKey
    const { point: finalPx } = resolveDrawSnap(pos, anchor, shiftKey, wallId, which)
    onWallEndpointMoved(wallId, which, { x: pxToMm(finalPx.x), y: pxToMm(finalPx.y) })
    setSnapTarget(null)
    setDragPreviewMm(null)
  }

  // Respect the user's unit preference for length labels on the canvas.
  // Metric (default) renders the bare number; imperial renders "X' Y\""
  // — the suffix is implied by the units toggle / settings.
  const { settings: __userSettings } = useUserSettings()
  function formatMm(mm: number) {
    return formatLengthShort(mm, __userSettings.preferences.units)
  }
  // Wall-length snap, configurable per-account. When the user hasn't
  // explicitly set a value (older settings blobs / fresh accounts),
  // derive a sensible default from the active block library + mortar
  // so libraries with non-standard widths (e.g. 250 mm units) get a
  // grid that actually lands on block multiples. The hardcoded
  // WALL_LENGTH_SNAP_MM is only used if even the derivation fails
  // (e.g. empty library on first boot).
  const wallSnapMm = useMemo(() => {
    const explicit = __userSettings.defaults.wallLengthSnapMm
    if (typeof explicit === 'number' && explicit > 0) return explicit
    return (
      computeAutoWallLengthSnapMm(
        BLOCK_LIBRARY,
        __userSettings.defaults.defaultMortarJointMm ?? DEFAULT_MORTAR_JOINT_MM
      ) || WALL_LENGTH_SNAP_MM
    )
  }, [
    __userSettings.defaults.wallLengthSnapMm,
    __userSettings.defaults.defaultMortarJointMm,
  ])

  function effectiveEndpoint(wall: Wall, which: 'start' | 'end'): Point {
    if (dragPreview?.wallId === wall.id && dragPreview.which === which) {
      return dragPreview.px
    }
    return which === 'start'
      ? { x: mmToPx(wall.startX), y: mmToPx(wall.startY) }
      : { x: mmToPx(wall.endX), y: mmToPx(wall.endY) }
  }

  const wallsById = useMemo(() => new Map(walls.map((w) => [w.id, w])), [walls])

  /**
   * Per-wall precomputed geometry (polygon vertices, outer-edge length, label
   * anchor in pixels). Hover/selection state changes cause WallDrawingLayer
   * to re-render constantly as the cursor crosses walls — and each render
   * was recomputing every wall's mitre intersections + connected-wall lookups
   * inline inside the JSX, which is O(N²) for N corner-connected walls.
   *
   * Caching by `[walls, wallThicknessByWallId, dragPreview, pxPerMmAtCurrentZoom]`
   * means hover and snap state can change freely without re-running the heavy
   * math. Konva still re-rasterises the layer (that's structural), but the
   * JavaScript portion drops out of the hot path, which is the difference
   * between fluid and laggy when there are lots of walls on the plan.
   */
  const wallGeometry = useMemo(() => {
    const out = new Map<
      string,
      { polygonPx: number[]; lengthMm: number; labelPx: Point }
    >()
    for (const wall of walls) {
      const isCurved = isCurvedWall(wall)
      const thicknessMm = wallThicknessByWallId[wall.id] ?? 190

      const startEff =
        dragPreview?.wallId === wall.id && dragPreview.which === 'start'
          ? { x: pxToMm(dragPreview.px.x), y: pxToMm(dragPreview.px.y) }
          : { x: wall.startX, y: wall.startY }
      const endEff =
        dragPreview?.wallId === wall.id && dragPreview.which === 'end'
          ? { x: pxToMm(dragPreview.px.x), y: pxToMm(dragPreview.px.y) }
          : { x: wall.endX, y: wall.endY }

      let polygonPx: number[] = []
      if (isCurved) {
        polygonPx = bandPxForCurvedWall(wall, thicknessMm, mmToPx)
      } else {
        const dx = endEff.x - startEff.x
        const dy = endEff.y - startEff.y
        const wlen = Math.sqrt(dx * dx + dy * dy)
        if (wlen > 0) {
          const nx = -dy / wlen
          const ny = dx / wlen
          const half = thicknessMm / 2

          let startPos: Point
          let startNeg: Point
          if (wall.startJunction.type === 'corner') {
            const m = mitredCornerPointsMm(wall, 'start', walls, wallThicknessByWallId)
            if (m) {
              startPos = m.posCorner
              startNeg = m.negCorner
            } else {
              startPos = { x: startEff.x + nx * half, y: startEff.y + ny * half }
              startNeg = { x: startEff.x - nx * half, y: startEff.y - ny * half }
            }
          } else {
            const trim =
              wall.startJunction.type === 't-junction'
                ? trimmedEndpointMm(wall, 'start', walls, wallThicknessByWallId)
                : { x: startEff.x, y: startEff.y }
            startPos = { x: trim.x + nx * half, y: trim.y + ny * half }
            startNeg = { x: trim.x - nx * half, y: trim.y - ny * half }
          }

          let endPos: Point
          let endNeg: Point
          if (wall.endJunction.type === 'corner') {
            const m = mitredCornerPointsMm(wall, 'end', walls, wallThicknessByWallId)
            if (m) {
              endPos = m.posCorner
              endNeg = m.negCorner
            } else {
              endPos = { x: endEff.x + nx * half, y: endEff.y + ny * half }
              endNeg = { x: endEff.x - nx * half, y: endEff.y - ny * half }
            }
          } else {
            const trim =
              wall.endJunction.type === 't-junction'
                ? trimmedEndpointMm(wall, 'end', walls, wallThicknessByWallId)
                : { x: endEff.x, y: endEff.y }
            endPos = { x: trim.x + nx * half, y: trim.y + ny * half }
            endNeg = { x: trim.x - nx * half, y: trim.y - ny * half }
          }

          polygonPx = [
            mmToPx(startPos.x), mmToPx(startPos.y),
            mmToPx(endPos.x), mmToPx(endPos.y),
            mmToPx(endNeg.x), mmToPx(endNeg.y),
            mmToPx(startNeg.x), mmToPx(startNeg.y),
          ]
        }
      }

      // Outer-edge length (matches what a tape measure reads on the outside
      // of the wall — see the original inline comment for the corner/T
      // adjustment rationale).
      let lengthMm: number
      if (isCurved) {
        lengthMm =
          arcFromThreePoints(
            { x: wall.startX, y: wall.startY },
            { x: wall.midX ?? 0, y: wall.midY ?? 0 },
            { x: wall.endX, y: wall.endY }
          )?.arcLengthMm ?? 0
      } else {
        const centrelineLen = Math.sqrt(
          (endEff.x - startEff.x) ** 2 + (endEff.y - startEff.y) ** 2
        )
        let adjust = 0
        for (const which of ['start', 'end'] as const) {
          const j = which === 'start' ? wall.startJunction : wall.endJunction
          if (j.type !== 'corner' && j.type !== 't-junction') continue
          const otherId = j.connectedWallIds?.[0]
          if (!otherId) continue
          const otherThickness = wallThicknessByWallId[otherId]
          if (!otherThickness) continue
          const other = wallsById.get(otherId)
          if (!other) continue
          const dataX = which === 'start' ? wall.startX : wall.endX
          const dataY = which === 'start' ? wall.startY : wall.endY
          const odx = other.endX - other.startX
          const ody = other.endY - other.startY
          const oLen = Math.sqrt(odx * odx + ody * ody)
          if (oLen === 0) continue
          const onx = -ody / oLen
          const ony = odx / oLen
          const perpDist = Math.abs(
            (dataX - other.startX) * onx + (dataY - other.startY) * ony
          )
          const overlap = Math.max(0, otherThickness / 2 - perpDist)
          adjust += j.type === 'corner' ? overlap : -overlap
        }
        lengthMm = Math.max(0, centrelineLen + adjust)
      }

      // Label anchor — chord midpoint for straight, user-clicked arc midpoint for curved.
      const labelPx: Point = isCurved
        ? {
            x: mmToPx(wall.midX ?? (wall.startX + wall.endX) / 2),
            y: mmToPx(wall.midY ?? (wall.startY + wall.endY) / 2),
          }
        : {
            x: (mmToPx(startEff.x) + mmToPx(endEff.x)) / 2,
            y: (mmToPx(startEff.y) + mmToPx(endEff.y)) / 2,
          }

      out.set(wall.id, { polygonPx, lengthMm, labelPx })
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walls, wallThicknessByWallId, dragPreviewMm, pxPerMmAtCurrentZoom])

  const containerCursor =
    drawingMode ||
    placingOpening ||
    drawingCurveMode ||
    placingControlJoint ||
    placingTiedPier ||
    placingFreestandingPier ||
    placingRuler
      ? 'crosshair'
      : 'inherit'

  return (
    <Stage
      ref={(stage: Konva.Stage | null) => {
        stageSelfRef.current = stage
        onStageRef?.(stage)
      }}
      width={cropW ?? visualWidth}
      height={cropH ?? visualHeight}
      // Offset the content by the crop origin so content coordinates
      // (rendered-page px) are unchanged — the canvas just shows the
      // [cropX, cropX+cropW] x [cropY, cropY+cropH] window of the page.
      x={-cropX}
      y={-cropY}
      // listening=false during zoom turns off Konva's hit-detection entirely.
      // Each pointer-position change otherwise costs O(walls) — Konva runs a
      // hit test against every shape on the layer to figure out which one
      // owns the pointer for enter/leave dispatch. The cursor doesn't move on
      // screen during a wheel zoom but its position in stage coords does,
      // which fires that hit test on every tick. With many walls and a thin
      // brick wall geometry, that work is the visible stutter. Disabling
      // listening while zooming makes the gesture's per-frame work constant
      // regardless of wall count; it flips back on the moment the gesture
      // ends so clicks / hover work normally again.
      listening={!isZooming}
      style={{
        position: 'absolute',
        top: cropY,
        left: cropX,
        pointerEvents: 'auto',
        cursor: containerCursor,
      }}
      onClick={handleStageClick}
      onMouseMove={handleStageMouseMove}
      onMouseDown={handleStageMouseDown}
    >
      <Layer>
        {/* Walls */}
        {walls.map((wall) => {
          const start = effectiveEndpoint(wall, 'start')
          const end = effectiveEndpoint(wall, 'end')

          // Geometry (polygon vertices, outer-edge length, label anchor) is
          // precomputed and memoised in `wallGeometry` so re-renders driven by
          // hover/selection state don't re-run mitre intersection math for
          // every wall. See the `wallGeometry` useMemo above for details.
          const geom = wallGeometry.get(wall.id)
          const polygonPx = geom?.polygonPx ?? []
          const len = geom?.lengthMm ?? 0
          const midX = geom?.labelPx.x ?? (start.x + end.x) / 2
          const midY = geom?.labelPx.y ?? (start.y + end.y) / 2

          // `isSelected` covers BOTH a real selection (the user explicitly
          // clicked/shift-clicked the wall) AND the "highlighted because its
          // makeup is the currently-active one" state. Visually identical —
          // glowing halo, beefier stroke — so the user gets immediate feedback
          // when they activate a wall type in the side panel. The toolbar's
          // multi-select check still uses `selectedWallIds` only, so this
          // visual doesn't promote the toolbar into multi-select mode.
          const isHighlightedByActive =
            !!activeMakeupIdForHighlight && wall.makeupId === activeMakeupIdForHighlight
          const isSelected =
            (selectedWallIds && selectedWallIds.has(wall.id)) ||
            wall.id === selectedWallId ||
            isHighlightedByActive
          const isHovered =
            wall.id === hoveredWallId &&
            !drawingMode &&
            !placingOpening &&
            !drawingCurveMode &&
            !placingControlJoint &&
            !placingTiedPier &&
            !placingFreestandingPier &&
            !placingRuler
          const isCurveAnchor =
            drawingCurveMode &&
            (curveAnchorA?.wallId === wall.id || curveAnchorB?.wallId === wall.id)
          // Default wall colour comes from the wall-type palette so multiple
          // wall types in the same project are visually distinct on the plan.
          // The selection highlight now LEANS INTO that colour rather than
          // overriding it — a green-coded wall lights up bright green, an
          // amber-coded wall lights up amber, etc. Same for the halo / glow
          // shadow further down the Line render. Curve anchors keep their
          // purple override since that's a tool state, not a wall type.
          const wallTypeStroke = wallColorByWallId?.[wall.id] ?? '#ED7D31'
          const strokeColor = isCurveAnchor
            ? '#8b5cf6'
            : wallTypeStroke
          const startIsCorner = wall.startJunction.type === 'corner'
          const endIsCorner = wall.endJunction.type === 'corner'
          const startIsTjunction = wall.startJunction.type === 't-junction'
          const endIsTjunction = wall.endJunction.type === 't-junction'
          const startIsControlJoint = wall.startJunction.type === 'control-joint'
          const endIsControlJoint = wall.endJunction.type === 'control-joint'
          // Pixel thickness of this wall at the current zoom — feeds the
          // endpoint marker so brick walls (thin) get tighter markers than
          // block walls (chunky).
          const wallThicknessPx =
            (wallThicknessByWallId[wall.id] ?? 190) * pxPerMmAtCurrentZoom

          return (
            <Group
              key={wall.id}
              onClick={(e) => {
                // Right-click is reserved for pan — never selects walls.
                if (e.evt.button !== 0) return
                // Curve / control-joint / pier modes: clicks bubble up to the stage handler
                // (which picks anchors / splits / drops piers). Selection is suppressed.
                if (
                  drawingMode ||
                  placingOpening ||
                  drawingCurveMode ||
                  placingControlJoint ||
                  placingTiedPier ||
                  placingFreestandingPier ||
                  placingRuler
                ) return
                // Shift+click = additive multi-select (toggle this wall in/out of the
                // selection). Plain click = replace whole selection with just this wall.
                if (e.evt.shiftKey && onWallToggleSelect) onWallToggleSelect(wall.id)
                else onWallSelect(wall.id)
                e.cancelBubble = true
              }}
              onMouseDown={(e) => {
                if (
                  drawingMode ||
                  placingOpening ||
                  drawingCurveMode ||
                  placingControlJoint ||
                  placingTiedPier ||
                  placingFreestandingPier ||
                  placingRuler
                ) return
                e.evt.stopPropagation()
              }}
            >
              <Line
                points={polygonPx}
                closed
                fill={
                  isSelected
                    ? hexToRgba(wallTypeStroke, 0.55)
                    : isCurveAnchor
                      ? 'rgba(139, 92, 246, 0.32)'
                      : hexToRgba(wallTypeStroke, 0.38)
                }
                stroke={strokeColor}
                strokeWidth={isSelected ? 3.5 : isCurveAnchor ? 2.5 : isHovered ? 2.5 : 2}
                hitStrokeWidth={8}
                lineJoin="miter"
                // Selected walls get a soft glow IN THEIR OWN COLOUR so the
                // user can pick them out at a glance — green-coded walls glow
                // green, amber walls glow amber, etc. — whether selected
                // from a canvas click or from the Wall types panel.
                // Non-selected walls skip shadow entirely (perf).
                // shadowForStrokeEnabled flips on ONLY when selected so the
                // highlight stroke itself casts the halo — on thick block
                // walls the fill alone wasn't visible enough against the PDF
                // underneath, but a glowing stroke reads cleanly in both
                // modes. Dialled the blur and opacity down from
                // 16/0.85 → 8/0.45 because the original glow was overpowering
                // when the user activates a wall type and every wall of that
                // type lights up at once — felt aggressive. The current
                // values still clearly differentiate selected walls from
                // unselected without dominating the canvas.
                shadowColor={isSelected ? wallTypeStroke : undefined}
                shadowBlur={isSelected ? 8 : 0}
                shadowOpacity={isSelected ? 0.45 : 0}
                // Konva perf flags. perfectDrawEnabled forces an offscreen
                // buffer when a shape has both fill and stroke (so the stroke
                // doesn't tint the fill at the edges); with semi-transparent
                // fills it's barely visible but the buffer cost shows up in
                // every redraw. shadowForStrokeEnabled — see selection comment
                // above.
                perfectDrawEnabled={false}
                shadowForStrokeEnabled={isSelected}
                onMouseEnter={(e) => {
                  // During an active zoom gesture the cursor doesn't move on
                  // screen but the canvas CSS-scales — different walls slide
                  // under the stage pointer, firing onMouseEnter spuriously
                  // and stuttering the zoom with setState cascades. Suppress
                  // hover updates while isZooming; the cursor style change
                  // also doesn't matter because the user can see they're
                  // zooming.
                  if (isZooming) return
                  if (
                    !drawingMode &&
                    !placingOpening &&
                    !drawingCurveMode &&
                    !placingControlJoint &&
                    !placingTiedPier &&
                    !placingFreestandingPier &&
                    !placingRuler
                  ) {
                    setHoveredWallId(wall.id)
                    setCursor(e.target.getStage(), 'pointer')
                  } else if (drawingCurveMode || placingControlJoint || placingTiedPier) {
                    setCursor(e.target.getStage(), 'pointer')
                  }
                }}
                onMouseLeave={(e) => {
                  // Same zoom-guard as onMouseEnter — see comment above.
                  if (isZooming) return
                  setHoveredWallId(null)
                  setCursor(e.target.getStage(), containerCursor)
                }}
              />

              {/* Endpoint markers. For corner-tagged endpoints, render ONE marker per
                  corner pair at the centreline-centreline intersection (the geometric
                  centre of the L). The "primary" wall — the one with the lower id —
                  renders the marker; the other wall skips it to avoid duplicates. */}
              {(() => {
                const result = cornerMarkerPosOrSkip(
                  wall,
                  'start',
                  startIsCorner,
                  walls,
                  mmToPx,
                  start
                )
                if (result === 'skip') return null
                return renderEndpointMarker({
                  pos: result,
                  isCorner: startIsCorner,
                  isTjunction: startIsTjunction,
                  isControlJoint: startIsControlJoint,
                  isSelected,
                  draggable: isSelected && !startIsCorner && !startIsControlJoint,
                  wallThicknessPx,
                  onDragMove: (ev) => handleEndpointDragMove(ev, wall.id, 'start'),
                  onDragEnd: (ev) => handleEndpointDragEnd(ev, wall.id, 'start'),
                  onMouseEnterStage: (ev) =>
                    setCursor(ev.target.getStage(), isSelected ? 'move' : 'inherit'),
                  onMouseLeaveStage: (ev) =>
                    setCursor(ev.target.getStage(), containerCursor),
                })
              })()}

              {(() => {
                const result = cornerMarkerPosOrSkip(
                  wall,
                  'end',
                  endIsCorner,
                  walls,
                  mmToPx,
                  end
                )
                if (result === 'skip') return null
                return renderEndpointMarker({
                  pos: result,
                  isCorner: endIsCorner,
                  isTjunction: endIsTjunction,
                  isControlJoint: endIsControlJoint,
                  isSelected,
                  draggable: isSelected && !endIsCorner && !endIsControlJoint,
                  wallThicknessPx,
                  onDragMove: (ev) => handleEndpointDragMove(ev, wall.id, 'end'),
                  onDragEnd: (ev) => handleEndpointDragEnd(ev, wall.id, 'end'),
                  onMouseEnterStage: (ev) =>
                    setCursor(ev.target.getStage(), isSelected ? 'move' : 'inherit'),
                  onMouseLeaveStage: (ev) =>
                    setCursor(ev.target.getStage(), containerCursor),
                })
              })()}

              {/* Wall length only shows when the wall is selected —
                  keeps the plan view clean while drawing / panning,
                  surfaces the dimension on demand. */}
              {isSelected && (
                <MeasurementChip
                  x={midX + 8}
                  y={midY - 20}
                  text={formatMm(len)}
                  bg="#1e40af"
                />
              )}
            </Group>
          )
        })}

        {/* Openings */}
        {openings.map((opening) => {
          const wall = wallsById.get(opening.wallId)
          if (!wall) return null
          const start = pointAlongWallPx(wall, opening.startAlongWallMm)
          const end = pointAlongWallPx(wall, opening.startAlongWallMm + opening.widthMm)
          const midX = (start.x + end.x) / 2
          const midY = (start.y + end.y) / 2
          const isSelected =
            (selectedOpeningIds && selectedOpeningIds.has(opening.id)) ||
            opening.id === selectedOpeningId
          // Render the opening at the host wall's THICKNESS, not a
          // fixed 8px stroke. Matches what the user sees on a real
          // architectural drawing — the opening fills the full width
          // of the wall band, regardless of whether the wall is
          // block (190mm) or brick (230mm). Clamped to a 4px minimum
          // so very-low-zoom views still have a hittable target.
          const wallThicknessMm = wallThicknessByWallId[wall.id] ?? 190
          const openingStrokePx = Math.max(
            4,
            wallThicknessMm * pxPerMmAtCurrentZoom
          )
          // Kind-based colours: windows keep the original amber; doors
          // render teal so the two read apart at a glance on the plan
          // (brick mode tags openings with `kind`; block openings
          // without one stay amber — unchanged). Selection blue wins.
          const isDoor = opening.kind === 'door'
          const openingAccent = isDoor ? '#0D9488' : '#D97706'
          const openingFill = isDoor ? '#CCFBF1' : '#FEF3C7'

          return (
            <Group
              key={opening.id}
              onClick={(e) => {
                // Right-click is reserved for pan — never selects openings.
                if (e.evt.button !== 0) return
                if (
                  drawingMode ||
                  placingOpening ||
                  placingControlJoint ||
                  placingTiedPier ||
                  placingFreestandingPier ||
                  placingRuler
                ) return
                if (e.evt.shiftKey && onOpeningToggleSelect) onOpeningToggleSelect(opening.id)
                else onOpeningSelect(opening.id)
                e.cancelBubble = true
              }}
              onMouseDown={(e) => {
                if (
                  drawingMode ||
                  placingOpening ||
                  placingControlJoint ||
                  placingTiedPier ||
                  placingFreestandingPier ||
                  placingRuler
                ) return
                e.evt.stopPropagation()
              }}
            >
              {/* Background "gap" rectangle covering the wall segment.
                  StrokeWidth scales with the wall's real thickness so
                  the opening visually fills the full width of the wall
                  band (block 190mm and brick 230mm both look correct
                  at any zoom). */}
              <Line
                points={[start.x, start.y, end.x, end.y]}
                stroke={isSelected ? '#1e40af' : openingFill}
                strokeWidth={openingStrokePx}
                hitStrokeWidth={Math.max(openingStrokePx + 6, 14)}
              />
              {/* Outline — also scales with the wall thickness so the
                  dashed border traces the actual edges of the opening
                  band, not a fixed 8px strip. */}
              <Line
                points={[start.x, start.y, end.x, end.y]}
                stroke={isSelected ? '#1e40af' : openingAccent}
                strokeWidth={openingStrokePx}
                dash={[8, 4]}
                listening={false}
                fillEnabled={false}
                // Konva tip: a dashed Line with strokeWidth equal to
                // the band thickness gives the "two parallel dashed
                // edges along the band" look without needing a
                // separate Rect. The center of the line sits on the
                // wall centerline, so the dashes appear on both faces.
                opacity={0.0}
              />
              {/* Faces — explicit parallel dashed lines along the
                  two long edges of the opening band so the user
                  reads the gap as a "doorway cut" rather than a
                  shaded patch. */}
              {(() => {
                const dx = end.x - start.x
                const dy = end.y - start.y
                const len = Math.sqrt(dx * dx + dy * dy)
                if (len < 0.5) return null
                const nx = -dy / len
                const ny = dx / len
                const half = openingStrokePx / 2
                const fStartA = { x: start.x + nx * half, y: start.y + ny * half }
                const fEndA = { x: end.x + nx * half, y: end.y + ny * half }
                const fStartB = { x: start.x - nx * half, y: start.y - ny * half }
                const fEndB = { x: end.x - nx * half, y: end.y - ny * half }
                return (
                  <>
                    <Line
                      points={[fStartA.x, fStartA.y, fEndA.x, fEndA.y]}
                      stroke={isSelected ? '#1e40af' : openingAccent}
                      strokeWidth={2}
                      dash={[8, 4]}
                      listening={false}
                    />
                    <Line
                      points={[fStartB.x, fStartB.y, fEndB.x, fEndB.y]}
                      stroke={isSelected ? '#1e40af' : openingAccent}
                      strokeWidth={2}
                      dash={[8, 4]}
                      listening={false}
                    />
                  </>
                )
              })()}
              <Circle x={start.x} y={start.y} radius={2.5} fill={isSelected ? '#1e40af' : openingAccent} stroke="white" strokeWidth={1} listening={false} />
              <Circle x={end.x} y={end.y} radius={2.5} fill={isSelected ? '#1e40af' : openingAccent} stroke="white" strokeWidth={1} listening={false} />
              <MeasurementChip
                x={midX}
                y={midY + openingStrokePx / 2 + 6}
                text={`${Math.round(opening.widthMm)} × ${Math.round(opening.heightMm)}`}
                bg={isSelected ? 'rgba(30, 64, 175, 0.95)' : 'rgba(146, 64, 14, 0.95)'}
                align="center"
              />
            </Group>
          )
        })}

        {/* Opening placement preview — derive pixel positions from wall + alongMm at current zoom */}
        {placingOpening && openingPlacementStart && (() => {
          const startWall = wallsById.get(openingPlacementStart.wallId)
          if (!startWall) return null
          const startPosPx = pointAlongWallPx(startWall, openingPlacementStart.alongMm)
          return (
            <Group listening={false}>
              <Circle
                x={startPosPx.x}
                y={startPosPx.y}
                radius={4}
                fill="#D97706"
                stroke="white"
                strokeWidth={1.5}
              />
              {openingHoverProjection && openingHoverProjection.wallId === openingPlacementStart.wallId && (() => {
                // When the user is typing a width, the preview line snaps to
                // the typed value (projected from the anchor in the
                // direction the cursor sits). Cursor-distance width otherwise.
                const typedNum = parseFloat(typedOpeningWidthMm)
                const hasTyped =
                  !!typedOpeningWidthMm.trim() &&
                  Number.isFinite(typedNum) &&
                  typedNum > 0
                const cursorWidthMm = Math.abs(
                  openingHoverProjection.alongMm - openingPlacementStart.alongMm
                )
                let endPx = openingHoverProjection.px
                if (hasTyped) {
                  // Build the typed end position along the wall in the
                  // direction the cursor is past the anchor.
                  const wall = wallsById.get(openingPlacementStart.wallId)
                  if (wall) {
                    const direction =
                      openingHoverProjection.alongMm >= openingPlacementStart.alongMm
                        ? 1
                        : -1
                    const endAlong =
                      openingPlacementStart.alongMm + direction * typedNum
                    endPx = pointAlongWallPx(wall, endAlong)
                  }
                }
                const previewWidth = hasTyped ? typedNum : cursorWidthMm
                return (
                  <>
                    <Line
                      points={[
                        startPosPx.x,
                        startPosPx.y,
                        endPx.x,
                        endPx.y,
                      ]}
                      stroke="#D97706"
                      strokeWidth={6}
                      opacity={0.5}
                    />
                    <MeasurementChip
                      x={(startPosPx.x + endPx.x) / 2 + 8}
                      y={(startPosPx.y + endPx.y) / 2 + 6}
                      text={
                        hasTyped
                          ? `${typedOpeningWidthMm} mm ⏎`
                          : typedOpeningWidthMm.trim()
                            ? `${typedOpeningWidthMm} mm …`
                            : `${Math.round(previewWidth)} mm wide`
                      }
                      bg={hasTyped ? 'rgba(59, 130, 246, 0.95)' : 'rgba(146, 64, 14, 0.95)'}
                    />
                  </>
                )
              })()}
            </Group>
          )
        })()}
        {placingOpening && !openingPlacementStart && openingHoverProjection && (
          <Circle
            x={openingHoverProjection.px.x}
            y={openingHoverProjection.px.y}
            radius={4}
            stroke="#D97706"
            strokeWidth={1.5}
            fill="rgba(217, 119, 6, 0.3)"
            listening={false}
          />
        )}

        {/* Piers — rendered above wall polygons. Footprint comes from the
            project's pier block (via the `pierFootprintMm` prop) so US /
            UK / etc. piers don't render at the AU 390mm size — falls
            back to 390 when the prop isn't supplied. */}
        {piers.map((pier) => {
          const isSelected =
            (selectedPierIds && selectedPierIds.has(pier.id)) || pier.id === selectedPierId
          // Per-pier dimensions when available — without these,
          // every placed pier reflected the CURRENTLY active type's
          // footprint, so activating pier type B made every pier
          // from type A re-render at B's size.
          const perPierSize = pierSizeByPierId?.[pier.id]
          const sizeMm = perPierSize?.widthMm ?? pierFootprintMm
          const sizeDepthMm =
            perPierSize?.depthMm ?? pierFootprintDepthMm ?? sizeMm
          let cxPx = 0
          let cyPx = 0
          let rotationDeg = 0

          if (pier.type === 'tied') {
            const wall = wallsById.get(pier.wallId)
            if (!wall || isCurvedWall(wall)) return null
            const pos = pointAlongWallPx(wall, pier.alongMm)
            cxPx = pos.x
            cyPx = pos.y
            const dx = wall.endX - wall.startX
            const dy = wall.endY - wall.startY
            rotationDeg = (Math.atan2(dy, dx) * 180) / Math.PI
          } else {
            cxPx = mmToPx(pier.x)
            cyPx = mmToPx(pier.y)
          }

          const widthPx = mmToPx(sizeMm)
          const depthPx = mmToPx(sizeDepthMm)
          // Pier fill comes from the shared palette via the parent's
          // pierColorByPierId map, so a Tied vs Free pier of the same
          // makeup id renders in its TYPE's distinctive colour rather
          // than a generic green/teal. Falls back to the historical
          // green-tone fills when no palette colour is wired (older
          // calls or pier rows missing a pierMakeupId).
          const paletteColor = pierColorByPierId?.[pier.id]
          const fillColor = paletteColor
            ? hexToRgba(paletteColor, isSelected ? 0.55 : 0.35)
            : pier.type === 'tied'
              ? (isSelected ? 'rgba(5, 150, 105, 0.45)' : 'rgba(16, 185, 129, 0.35)')
              : (isSelected ? 'rgba(13, 148, 136, 0.45)' : 'rgba(20, 184, 166, 0.35)')
          const strokeColor = paletteColor
            ? paletteColor
            : pier.type === 'tied'
              ? '#065f46'
              : '#0f766e'

          return (
            <Group
              key={pier.id}
              onClick={(e) => {
                // Right-click is reserved for pan — never selects piers.
                if (e.evt.button !== 0) return
                if (
                  drawingMode ||
                  placingOpening ||
                  drawingCurveMode ||
                  placingControlJoint ||
                  placingTiedPier ||
                  placingFreestandingPier ||
                  placingRuler
                ) return
                if (e.evt.shiftKey && onPierToggleSelect) onPierToggleSelect(pier.id)
                else if (onPierSelect) onPierSelect(pier.id)
                e.cancelBubble = true
              }}
              onMouseDown={(e) => {
                if (
                  drawingMode ||
                  placingOpening ||
                  drawingCurveMode ||
                  placingControlJoint ||
                  placingTiedPier ||
                  placingFreestandingPier ||
                  placingRuler
                ) return
                e.evt.stopPropagation()
              }}
            >
              <Rect
                x={cxPx}
                y={cyPx}
                width={widthPx}
                height={depthPx}
                offsetX={widthPx / 2}
                offsetY={depthPx / 2}
                rotation={rotationDeg}
                fill={fillColor}
                stroke={strokeColor}
                strokeWidth={isSelected ? 2.5 : 1.5}
                hitStrokeWidth={6}
              />
              <Text
                x={cxPx - 14}
                y={cyPx - 6}
                text={pier.type === 'tied' ? 'T' : 'P'}
                fontSize={13}
                fill={strokeColor}
                fontStyle="bold"
                listening={false}
              />
            </Group>
          )
        })}

        {/* Tied pier hover preview — square at the wall projection.
            Renders in both legacy `placingTiedPier` mode AND the unified pier
            mode (placingFreestandingPier), where the hover handler decides
            tied-vs-freestanding based on whether the cursor is in a wall body. */}
        {(placingTiedPier || placingFreestandingPier) && tiedPierHover && (() => {
          const wall = walls.find((w) => w.id === tiedPierHover.wallId)
          if (!wall || isCurvedWall(wall)) return null
          const dx = wall.endX - wall.startX
          const dy = wall.endY - wall.startY
          const rotationDeg = (Math.atan2(dy, dx) * 180) / Math.PI
          // Honour the active pier type's footprint instead of a
          // literal 390. Width = along the wall, depth = perpendicular,
          // so non-cubic blocks (e.g. 20.01 = 390 × 190) render as a
          // long-and-thin rectangle hugging the wall rather than a
          // misleading 390 square.
          const widthPx = mmToPx(pierFootprintMm)
          const depthPx = mmToPx(pierFootprintDepthMm ?? pierFootprintMm)
          return (
            <Rect
              x={tiedPierHover.px.x}
              y={tiedPierHover.px.y}
              width={widthPx}
              height={depthPx}
              offsetX={widthPx / 2}
              offsetY={depthPx / 2}
              rotation={rotationDeg}
              fill="rgba(16, 185, 129, 0.25)"
              stroke="#065f46"
              strokeWidth={2}
              dash={[6, 4]}
              listening={false}
            />
          )
        })()}

        {/* Freestanding pier hover preview — axis-aligned 390×390 square at the cursor. */}
        {placingFreestandingPier && freestandingPierHoverMm && (() => {
          const cxPx = mmToPx(freestandingPierHoverMm.x)
          const cyPx = mmToPx(freestandingPierHoverMm.y)
          // Match the active pier type's footprint (width × depth),
          // same shape as the tied-pier hover above. Freestanding
          // piers don't snap to a wall direction so the rectangle
          // sits axis-aligned at the cursor.
          const widthPx = mmToPx(pierFootprintMm)
          const depthPx = mmToPx(pierFootprintDepthMm ?? pierFootprintMm)
          return (
            <Rect
              x={cxPx}
              y={cyPx}
              width={widthPx}
              height={depthPx}
              offsetX={widthPx / 2}
              offsetY={depthPx / 2}
              fill="rgba(20, 184, 166, 0.25)"
              stroke="#0f766e"
              strokeWidth={2}
              dash={[6, 4]}
              listening={false}
            />
          )
        })()}

        {/* Bluebeam-style full-canvas crosshair guide.
            Two solid black lines spanning the canvas at the cursor —
            horizontal at cursor Y, vertical at cursor X. Stroke is
            0.75 px so it reads as a touch thinner than the OS CSS
            crosshair cursor at the centre (the centre still feels
            like the "real" cursor). Solid + full opacity so the
            line is a clean ruler, not a dashed guideline.
            Listening: false so it doesn't intercept clicks. */}
        {cursorPx &&
          (drawingMode ||
            drawingCurveMode ||
            placingOpening ||
            placingControlJoint ||
            placingTiedPier ||
            placingFreestandingPier ||
            placingRuler) && (
            <Group listening={false}>
              <Line
                points={[0, cursorPx.y, visualWidth, cursorPx.y]}
                stroke="#000000"
                strokeWidth={0.75}
                listening={false}
              />
              <Line
                points={[cursorPx.x, 0, cursorPx.x, visualHeight]}
                stroke="#000000"
                strokeWidth={0.75}
                listening={false}
              />
            </Group>
          )}

        {/* Control-joint hover preview — show where the click would split the wall. */}
        {placingControlJoint && controlJointHover && (() => {
          const wall = walls.find((w) => w.id === controlJointHover.wallId)
          if (!wall || isCurvedWall(wall)) return null
          const thicknessMm = wallThicknessByWallId[wall.id] ?? 190
          // Perpendicular tick across the wall thickness at the projected point.
          const dx = wall.endX - wall.startX
          const dy = wall.endY - wall.startY
          const wlen = Math.sqrt(dx * dx + dy * dy)
          if (wlen === 0) return null
          const nx = -dy / wlen
          const ny = dx / wlen
          const half = thicknessMm / 2 + 30 // mm — overhang a touch outside the wall for visibility
          const cx = controlJointHover.px.x
          const cy = controlJointHover.px.y
          const tx = mmToPx(nx * half)
          const ty = mmToPx(ny * half)
          return (
            <Group listening={false}>
              <Line
                points={[cx - tx, cy - ty, cx + tx, cy + ty]}
                stroke="#e11d48"
                strokeWidth={2}
                dash={[6, 4]}
              />
              <Circle x={cx} y={cy} radius={7} stroke="#e11d48" strokeWidth={2} fill="white" />
              <Circle x={cx} y={cy} radius={2.5} fill="#e11d48" />
            </Group>
          )
        })()}

        {/* Pre-anchor cursor box: shown while drawingMode is on but the
            user hasn't dropped the first click yet. A small square sized
            to the active wall's real thickness, centred on the cursor, in
            the active type's colour. Gives the user a tangible sense of
            how thick the wall they're about to draw will be before they
            commit to a position. */}
        {/* Wall drawing preview */}
        {drawingMode && startPx && (
          <Group listening={false}>
            <Circle x={startPx.x} y={startPx.y} radius={5} fill={activeWallColor} stroke="white" strokeWidth={2} />
            {cursorPx && (() => {
              // If the user typed a length, project the preview line along the
              // cursor direction at exactly the typed magnitude — that way the
              // dashed preview matches what the click will commit.
              // parseLengthInput accepts both metric (2400) and imperial
              // (8'-6") notation; the displayed-length preview matches the
              // commit math at line 1854.
              const previewParsed = parseLengthInput(
                typedLengthMm,
                getUserSettings().preferences.units,
              )
              const typedNum = previewParsed ?? NaN
              const hasTyped =
                !!typedLengthMm.trim() && Number.isFinite(typedNum) && typedNum > 0
              const cursorMmFromPx = {
                x: pxToMm(cursorPx.x),
                y: pxToMm(cursorPx.y),
              }
              const startMmFromPx = {
                x: pxToMm(startPx.x),
                y: pxToMm(startPx.y),
              }
              const dx = cursorMmFromPx.x - startMmFromPx.x
              const dy = cursorMmFromPx.y - startMmFromPx.y
              const cursorDistMm = Math.sqrt(dx * dx + dy * dy)
              const startAdjust = cornerLengthAdjustAt(startMmFromPx)
              // Typed value represents the WALL'S DISPLAYED LENGTH (the
              // number a tape measure would read along the outer face),
              // so the stored centreline has to be SHORTER than the typed
              // value by any corner extension at the start. End-side
              // adjust is left alone when typing — the end position is
              // determined by the typed centreline, and if it happens to
              // also land on a corner-block-centre the displayed value
              // will be larger than typed; that's a less common case.
              let endPx = cursorPx
              if (hasTyped && cursorDistMm > 0.001) {
                const ux = dx / cursorDistMm
                const uy = dy / cursorDistMm
                const centreLength = Math.max(0, typedNum - startAdjust)
                endPx = {
                  x: mmToPx(startMmFromPx.x + ux * centreLength),
                  y: mmToPx(startMmFromPx.y + uy * centreLength),
                }
              }
              // Cursor-driven (untyped) label = cursorDist + corner extensions.
              // Typed-driven label is just the typed value (handled below).
              const endAdjust = cornerLengthAdjustAt(cursorMmFromPx)
              const previewLengthMm = hasTyped
                ? typedNum
                : cursorDistMm + startAdjust + endAdjust
              // Build a thickness silhouette: offset the centreline by
              // half the active wall thickness (block depth or brick
              // wall thickness) on either side, in screen pixels at the
              // current zoom. Result is a 4-point polygon along the
              // wall direction so the user sees exactly where the wall
              // will sit on the plan — not a thin line.
              const segDx = endPx.x - startPx.x
              const segDy = endPx.y - startPx.y
              const segLen = Math.sqrt(segDx * segDx + segDy * segDy)
              const halfThicknessPx =
                (activeWallThicknessMm * pxPerMmAtCurrentZoom) / 2
              const nx = segLen > 0 ? -segDy / segLen : 0
              const ny = segLen > 0 ? segDx / segLen : 0
              const ox = nx * halfThicknessPx
              const oy = ny * halfThicknessPx
              const silhouettePoints = [
                startPx.x + ox,
                startPx.y + oy,
                endPx.x + ox,
                endPx.y + oy,
                endPx.x - ox,
                endPx.y - oy,
                startPx.x - ox,
                startPx.y - oy,
              ]
              return (
                <>
                  <Line
                    points={silhouettePoints}
                    closed
                    fill={hexToRgba(activeWallColor, 0.22)}
                    stroke={activeWallColor}
                    strokeWidth={1.5}
                    dash={[6, 4]}
                  />
                  {/* Centreline guide — keeps the visual cue of the
                      line snap point while the rectangle shows real
                      thickness around it. Thin + 70% opaque so it
                      doesn't fight the fill. */}
                  <Line
                    points={[startPx.x, startPx.y, endPx.x, endPx.y]}
                    stroke={activeWallColor}
                    strokeWidth={1}
                    opacity={0.7}
                    dash={[2, 3]}
                  />
                  {/* Live label shows the wall's final DISPLAYED length —
                      centreline + corner extension at either end. When
                      cursor-driven, that means a typed-not-yet-committed
                      label shows the cursor + extension. When typed, the
                      typed value IS the intended displayed length, so the
                      label echoes it back as-is. */}
                  <MeasurementChip
                    x={(startPx.x + endPx.x) / 2 + 8}
                    y={(startPx.y + endPx.y) / 2 - 20}
                    text={
                      hasTyped
                        ? `${typedLengthMm} mm ⏎`
                        : typedLengthMm.trim()
                          ? `${typedLengthMm} mm …`
                          : formatMm(previewLengthMm)
                    }
                    bg={hasTyped ? 'rgba(59, 130, 246, 0.95)' : hexToRgba(activeWallColor, 0.95)}
                  />
                </>
              )
            })()}
          </Group>
        )}

        {/* Curve drawing preview */}
        {drawingCurveMode && (
          <Group listening={false}>
            {curveAnchorA && (
              <Circle
                x={mmToPx(curveAnchorA.xMm)}
                y={mmToPx(curveAnchorA.yMm)}
                radius={6}
                fill="#8b5cf6"
                stroke="white"
                strokeWidth={1.5}
              />
            )}
            {curveAnchorB && (
              <Circle
                x={mmToPx(curveAnchorB.xMm)}
                y={mmToPx(curveAnchorB.yMm)}
                radius={6}
                fill="#8b5cf6"
                stroke="white"
                strokeWidth={1.5}
              />
            )}
            {/* Hollow hover ring — only while the user is still picking anchors and
                the cursor is over a wall. Disappears once both anchors are placed. */}
            {curveAnchorHoverMm && !(curveAnchorA && curveAnchorB) && (
              <Circle
                x={mmToPx(curveAnchorHoverMm.x)}
                y={mmToPx(curveAnchorHoverMm.y)}
                radius={7}
                stroke="#8b5cf6"
                strokeWidth={2}
                fill="rgba(139, 92, 246, 0.18)"
              />
            )}
            {/* Arc preview — both anchors set, mid follows the cursor
                for the third-click commit. */}
            {curveAnchorA && curveAnchorB && curveCursorMm && (() => {
              const A = { x: curveAnchorA.xMm, y: curveAnchorA.yMm }
              const B = { x: curveAnchorB.xMm, y: curveAnchorB.yMm }
              const midPointMm: Point = curveCursorMm
              const geom = arcFromThreePoints(A, midPointMm, B)
              if (!geom) {
                // Collinear or invalid — show a dashed straight line as
                // a fallback hint.
                return (
                  <Line
                    points={[
                      mmToPx(A.x),
                      mmToPx(A.y),
                      mmToPx(B.x),
                      mmToPx(B.y),
                    ]}
                    stroke="#8b5cf6"
                    strokeWidth={2}
                    dash={[6, 4]}
                  />
                )
              }
              const pts = sampleArc(geom, 48)
              const flat: number[] = []
              for (const p of pts) flat.push(mmToPx(p.x), mmToPx(p.y))
              return (
                <>
                  <Line
                    points={flat}
                    stroke="#8b5cf6"
                    strokeWidth={3}
                    dash={[8, 4]}
                    lineCap="round"
                    lineJoin="round"
                  />
                  <Text
                    x={mmToPx(B.x) + 10}
                    y={mmToPx(B.y) - 22}
                    text={`R ${Math.round(geom.radiusMm)} · arc ${Math.round(geom.arcLengthMm)}mm`}
                    fontSize={13}
                    fill="#6d28d9"
                    fontStyle="bold"
                  />
                </>
              )
            })()}
          </Group>
        )}

        {/* Snap indicator — green ring = endpoint (corner), purple ring = body (T-junction).
            Kept small so the ring doesn't obscure the exact pixel the user is trying to land on. */}
        {snapTarget && (
          <Circle
            x={snapTarget.x}
            y={snapTarget.y}
            radius={8}
            stroke={snapTarget.kind === 'body' ? '#8b5cf6' : '#10b981'}
            strokeWidth={2}
            fill={
              snapTarget.kind === 'body'
                ? 'rgba(139, 92, 246, 0.18)'
                : 'rgba(16, 185, 129, 0.18)'
            }
            listening={false}
          />
        )}


        {/* Persistent measurements + in-progress measurement preview. Drawn
            in fuchsia so they pop against the orange walls and don't get
            mistaken for in-progress drawing. The Line is clickable (wide
            hit-stroke so the user doesn't have to land pixel-perfectly on
            the dashed segment) and selecting a measurement halos it so
            Delete can target it. Suppressed while in any placement mode
            so clicks pass through to the active tool. */}
        {measurements.map((m) => {
          const startPx = { x: mmToPx(m.startMm.x), y: mmToPx(m.startMm.y) }
          const endPx = { x: mmToPx(m.endMm.x), y: mmToPx(m.endMm.y) }
          const lengthMm = distance(m.startMm, m.endMm)
          const midPx = {
            x: (startPx.x + endPx.x) / 2,
            y: (startPx.y + endPx.y) / 2,
          }
          const isSelected = m.id === selectedMeasurementId
          const interactive =
            !drawingMode &&
            !placingOpening &&
            !drawingCurveMode &&
            !placingControlJoint &&
            !placingTiedPier &&
            !placingFreestandingPier &&
            !placingRuler
          return (
            <Group key={m.id} listening={interactive}>
              <Line
                points={[startPx.x, startPx.y, endPx.x, endPx.y]}
                stroke={isSelected ? '#a21caf' : '#d946ef'}
                strokeWidth={isSelected ? 2 : 1.25}
                dash={[4, 3]}
                hitStrokeWidth={14}
                shadowColor={isSelected ? '#d946ef' : undefined}
                shadowBlur={isSelected ? 8 : 0}
                shadowOpacity={isSelected ? 0.5 : 0}
                onClick={(e) => {
                  if (e.evt.button !== 0) return
                  e.cancelBubble = true
                  onMeasurementSelect?.(m.id)
                }}
                onMouseEnter={(ev) => {
                  if (!interactive) return
                  const stage = ev.target.getStage()
                  if (stage) stage.container().style.cursor = 'pointer'
                }}
                onMouseLeave={(ev) => {
                  if (!interactive) return
                  const stage = ev.target.getStage()
                  if (stage) stage.container().style.cursor = containerCursor
                }}
              />
              {renderRulerMarker(startPx, isSelected)}
              {renderRulerMarker(endPx, isSelected)}
              <MeasurementChip
                x={midPx.x + 8}
                y={midPx.y - 20}
                text={formatMm(lengthMm)}
                bg={isSelected ? 'rgba(162, 28, 175, 0.95)' : 'rgba(217, 70, 239, 0.92)'}
                listening={false}
              />
            </Group>
          )
        })}
        {placingRuler && rulerAnchorMm && cursorMm && (() => {
          const startPx = {
            x: mmToPx(rulerAnchorMm.x),
            y: mmToPx(rulerAnchorMm.y),
          }
          const endPx = { x: mmToPx(cursorMm.x), y: mmToPx(cursorMm.y) }
          const lengthMm = distance(rulerAnchorMm, cursorMm)
          return (
            <Group listening={false}>
              <Line
                points={[startPx.x, startPx.y, endPx.x, endPx.y]}
                stroke="#d946ef"
                strokeWidth={1.25}
                dash={[4, 3]}
                opacity={0.95}
              />
              {renderRulerMarker(startPx, false)}
              {renderRulerMarker(endPx, false)}
              <MeasurementChip
                x={(startPx.x + endPx.x) / 2 + 8}
                y={(startPx.y + endPx.y) / 2 - 20}
                text={formatMm(lengthMm)}
                bg="rgba(217, 70, 239, 0.92)"
              />
            </Group>
          )
        })()}
      </Layer>
    </Stage>
  )
}

/**
 * Memoised export — re-renders only when props change by shallow-compare. Combined with
 * stable useCallback handlers and renderedZoom-based dimensions in the parent, this means
 * the wall overlay does NOT re-render on every wheel-zoom tick. The visual scaling happens
 * via the parent's CSS transform instead.
 */
const WallDrawingLayer = memo(WallDrawingLayerInner)
export default WallDrawingLayer

interface EndpointMarkerProps {
  pos: Point
  isCorner: boolean
  isTjunction: boolean
  isControlJoint?: boolean
  isSelected: boolean
  draggable: boolean
  /**
   * Wall thickness in pixels at the current zoom. The marker is sized to
   * roughly match the wall's on-screen thickness so it doesn't visually
   * overflow a thin brick wall (110mm ≈ 5–7 px at typical residential
   * scales), while still being clickable on chunky 190 mm block walls and
   * at low zoom. Clamped to [4, 12] px so it never gets too small to click
   * or so big it obscures the plan.
   */
  wallThicknessPx: number
  onDragMove: (e: Konva.KonvaEventObject<DragEvent>) => void
  onDragEnd: (e: Konva.KonvaEventObject<DragEvent>) => void
  onMouseEnterStage: (e: Konva.KonvaEventObject<MouseEvent>) => void
  onMouseLeaveStage: (e: Konva.KonvaEventObject<MouseEvent>) => void
}

function renderEndpointMarker({
  pos,
  isCorner,
  isTjunction,
  isControlJoint = false,
  isSelected,
  draggable,
  wallThicknessPx,
  onDragMove,
  onDragEnd,
  onMouseEnterStage,
  onMouseLeaveStage,
}: EndpointMarkerProps) {
  // Marker sizes are derived from the wall's on-screen thickness so brick
  // walls (thin) get correspondingly small markers and block walls (chunky)
  // get larger ones. Clamped to [3, 7] px so a wall that's effectively
  // invisible at low zoom still gets a clickable marker, and so a wall at
  // 4× zoom doesn't end up with markers obscuring the wall ends or PDF
  // detail underneath. Selected markers get a slight bump so the drag
  // handle is easy to find without dominating the plan.
  const baseSize = Math.max(3, Math.min(7, wallThicknessPx * 0.55))
  const radius = (isSelected ? baseSize * 1.2 : baseSize) / 2
  const cornerSquareSize = isSelected ? Math.min(8, baseSize * 1.15) : baseSize
  const tjunctionDiamondSize = cornerSquareSize
  const controlJointOuterRadius = baseSize * 0.55
  const controlJointInnerRadius = Math.max(1, baseSize * 0.2)
  const fill = isSelected
    ? '#3b82f6'
    : isCorner
    ? '#10b981' // green = corner
    : isTjunction
    ? '#8b5cf6' // purple = T-junction
    : isControlJoint
    ? '#e11d48' // rose = control joint
    : '#ED7D31' // orange = free

  // Control joint: no marker. After a cut the two halves should read
  // as two regular walls butting up against each other — same as any
  // other corner / butt joint in the plan. Render nothing so the cut
  // point is invisible at rest. (Both halves' endpoints overlap at
  // the same coordinate, so even a hairline would double-stack.)
  // When the wall is SELECTED the code falls through to the regular
  // fallback handle below so the user can still drag the seam if
  // needed — selecting a wall is an explicit action so showing a
  // handle there isn't visual noise.
  if (isControlJoint && !isSelected) {
    return null
  }
  // Silence the unused-variable lint that survives now that the rose
  // ring no longer references these size tokens. Leaving the tokens
  // in place keeps the corner / T-junction sizing block intact.
  void controlJointOuterRadius
  void controlJointInnerRadius

  // T-junction: purple diamond (square rotated 45°). Visually distinct from corners
  // without being noisy.
  if (isTjunction && !isSelected) {
    const size = tjunctionDiamondSize
    return (
      <Rect
        x={pos.x}
        y={pos.y}
        width={size}
        height={size}
        offsetX={size / 2}
        offsetY={size / 2}
        rotation={45}
        fill={fill}
        stroke="white"
        strokeWidth={1.5}
        draggable={draggable}
        onDragMove={onDragMove}
        onDragEnd={onDragEnd}
        onMouseDown={(e) => {
          if (draggable) e.evt.stopPropagation()
        }}
        onMouseEnter={onMouseEnterStage}
        onMouseLeave={onMouseLeaveStage}
      />
    )
  }

  if (isCorner && !isSelected) {
    const size = cornerSquareSize
    return (
      <Rect
        x={pos.x - size / 2}
        y={pos.y - size / 2}
        width={size}
        height={size}
        fill={fill}
        stroke="white"
        strokeWidth={1.5}
        draggable={draggable}
        onDragMove={onDragMove}
        onDragEnd={onDragEnd}
        onMouseDown={(e) => {
          if (draggable) e.evt.stopPropagation()
        }}
        onMouseEnter={onMouseEnterStage}
        onMouseLeave={onMouseLeaveStage}
      />
    )
  }

  return (
    <Circle
      x={pos.x}
      y={pos.y}
      radius={radius}
      fill={fill}
      stroke="white"
      strokeWidth={1.5}
      draggable={draggable}
      onDragMove={onDragMove}
      onDragEnd={onDragEnd}
      onMouseDown={(e) => {
        if (draggable) e.evt.stopPropagation()
      }}
      onMouseEnter={onMouseEnterStage}
      onMouseLeave={onMouseLeaveStage}
    />
  )
}
