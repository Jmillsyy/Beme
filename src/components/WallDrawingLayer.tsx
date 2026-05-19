import { memo, useEffect, useMemo, useState } from 'react'
import { Stage, Layer, Line, Circle, Rect, Text, Group } from 'react-konva'
import type Konva from 'konva'
import type { Opening, Pier, Wall } from '../types/walls'
import { arcFromThreePoints, isCurvedWall, sampleArc } from '../lib/curveGeom'
import { formatLengthShort } from '../lib/units'
import { useUserSettings } from '../lib/userSettings'
import { hexToRgba } from '../lib/wallTypeColors'

interface Point {
  x: number
  y: number
}

interface WallDrawingLayerProps {
  walls: Wall[]
  /** Openings on the current page (across all walls). */
  openings: Opening[]
  /**
   * Physical wall thickness per wall id (mm). For block walls this comes from the makeup's
   * body block depth (e.g. 190mm for 20.48); for brick walls it's the configured brick wall
   * thickness (110mm default). Drives the rendered rectangle width.
   */
  wallThicknessByWallId: Record<string, number>
  visualWidth: number
  visualHeight: number
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
   * Per-wall stroke colour, keyed by wall id — set by the parent based on the
   * wall type's palette colour. Falls back to the brand orange if missing.
   */
  wallColorByWallId?: Record<string, string>
  /**
   * Currently-active wall makeup id. Walls whose `makeupId` matches this get
   * the same visual halo as a selected wall, so the user sees "these are the
   * walls of the type I just clicked in the side panel" without those walls
   * actually being selected (which would flip the toolbar into multi-select
   * mode). Pass undefined to disable the highlight treatment entirely.
   */
  activeMakeupIdForHighlight?: string | null
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
 *  Kept tight so close-but-distinct endpoints (parallel walls a few mm apart)
 *  don't get pulled into one. The user can hold Shift to bypass snap entirely. */
const SNAP_THRESHOLD_PX = 5
/** Pixel radius for projecting a click onto a wall when placing openings, control joints
 *  and piers. Used in `findClosestWallProjection`. Kept in pixels because it represents
 *  click precision against a visible wall — the user targets the wall on screen. Tightened
 *  so two adjacent walls don't both claim the cursor on a single click. */
const WALL_PROJECTION_THRESHOLD_PX = 8
/**
 * Real-world distance at which a cursor near an existing wall's *face* will snap onto it
 * to form a T-junction. Expressed in mm so the snap feels the same at every zoom level
 * and on every plan. Tightened to 10 mm so users can lay two parallel walls a few cm
 * apart without the first wall's snap zone swallowing the cursor — the previous 20 mm
 * caused stickiness in dense junctions. Shift bypasses the snap entirely.
 */
const WALL_FACE_SNAP_MM = 10

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
 * Wall length, opening width, control-joint offset, and pier position all
 * snap to multiples of this many millimetres. Real masonry is laid out on
 * coarse increments — nothing's ever spec'd at 357 mm — so always rounding
 * to the nearest 5 mm makes every measurement land cleanly.
 *
 * Applied AFTER wall-snap (endpoints / faces) and axis-snap so neither gets
 * overridden, and bypassed by holding Shift the same way axis-snap is, for
 * the rare measurement that genuinely needs an off-grid value.
 */
const WALL_LENGTH_SNAP_MM = 5

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
 * Round a mm length to the nearest WALL_LENGTH_SNAP_MM. Shared by all the
 * placement code paths (walls, openings, control joints, piers) so the user
 * sees a consistent grid no matter what they're dropping onto the plan.
 */
function snapMmToGrid(mm: number): number {
  return Math.round(mm / WALL_LENGTH_SNAP_MM) * WALL_LENGTH_SNAP_MM
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
function rectanglePxForSegment(
  startMm: Point,
  endMm: Point,
  thicknessMm: number,
  mmToPx: (mm: number) => number
): number[] {
  const dx = endMm.x - startMm.x
  const dy = endMm.y - startMm.y
  const len = Math.sqrt(dx * dx + dy * dy)
  if (len === 0) return []
  const ux = dx / len
  const uy = dy / len
  // Perpendicular (rotated 90° CCW): (-uy, ux)
  const nx = -uy
  const ny = ux
  const half = thicknessMm / 2
  return [
    mmToPx(startMm.x + nx * half), mmToPx(startMm.y + ny * half),
    mmToPx(endMm.x + nx * half), mmToPx(endMm.y + ny * half),
    mmToPx(endMm.x - nx * half), mmToPx(endMm.y - ny * half),
    mmToPx(startMm.x - nx * half), mmToPx(startMm.y - ny * half),
  ]
}

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
  walls,
  openings,
  wallThicknessByWallId,
  visualWidth,
  visualHeight,
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
  activeMakeupIdForHighlight = null,
  placingRuler = false,
  rulerAnchorMm = null,
  measurements = [],
  onRulerClick,
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
          // Pull the snap target halfThickness in from the data endpoint along the wall
          // direction, into the body — that's where the centre of the corner block sits
          // for clean masonry alignment.
          const farX = end === 'start' ? w.endX : w.startX
          const farY = end === 'start' ? w.endY : w.startY
          const dx = dataX - farX
          const dy = dataY - farY
          const len = Math.sqrt(dx * dx + dy * dy)
          if (len > 0) {
            const offset = Math.min(thickness / 2, len)
            const ux = dx / len
            const uy = dy / len
            snapX = dataX - ux * offset
            snapY = dataY - uy * offset
          }
        }

        // Snap radius: large enough to catch the cursor anywhere in the end-block area.
        // halfThickness covers from the snap target out to either the wall's end face or
        // its inner edge, plus a small buffer.
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
    // fall through to a 'free' anchor at the raw cursor position so the user
    // can draw a curve between any two points without needing existing walls
    // to anchor on — that's the dominant case now that free placement is
    // supported, so over-snapping costs more than under-snapping.
    const CURVE_ANCHOR_THRESHOLD_PX = 25

    let best: { wallId: string; distPx: number; tUnclamped: number } | null = null
    for (const wall of walls) {
      const sx = mmToPx(wall.startX)
      const sy = mmToPx(wall.startY)
      const ex = mmToPx(wall.endX)
      const ey = mmToPx(wall.endY)
      const dx = ex - sx
      const dy = ey - sy
      const lenSq = dx * dx + dy * dy
      if (lenSq === 0) continue
      const tUnclamped = ((cursorPx.x - sx) * dx + (cursorPx.y - sy) * dy) / lenSq
      const tClamped = Math.max(0, Math.min(1, tUnclamped))
      const projX = sx + tClamped * dx
      const projY = sy + tClamped * dy
      const distPx = Math.hypot(cursorPx.x - projX, cursorPx.y - projY)
      if (distPx > CURVE_ANCHOR_THRESHOLD_PX) continue
      if (!best || distPx < best.distPx) {
        best = { wallId: wall.id, distPx, tUnclamped }
      }
    }
    // No wall nearby → free anchor at the cursor. The curve still works
    // geometrically; it just isn't tied to a wall.
    if (!best) {
      return {
        wallId: null,
        xMm: pxToMm(cursorPx.x),
        yMm: pxToMm(cursorPx.y),
      }
    }

    const wall = walls.find((w) => w.id === best!.wallId)
    if (!wall) {
      return {
        wallId: null,
        xMm: pxToMm(cursorPx.x),
        yMm: pxToMm(cursorPx.y),
      }
    }
    const lengthMm = wallLengthMmOf(wall)
    if (lengthMm <= 0) {
      return {
        wallId: null,
        xMm: pxToMm(cursorPx.x),
        yMm: pxToMm(cursorPx.y),
      }
    }

    // End-face anchors: cursor is past the wall's tip in the wall's own
    // direction. Anchor sits on the centreline endpoint with no perpendicular
    // offset, so a curve drawn from here visually continues off the end of
    // the wall rather than peeling off one of its sides.
    if (best.tUnclamped > 1) {
      return { wallId: wall.id, xMm: wall.endX, yMm: wall.endY }
    }
    if (best.tUnclamped < 0) {
      return { wallId: wall.id, xMm: wall.startX, yMm: wall.startY }
    }

    // Side-face anchor: existing behaviour for cursor alongside the wall.
    // The anchor sits on the cursor's side of the wall, half-thickness off
    // the centreline projection.
    const cursorXmm = pxToMm(cursorPx.x)
    const cursorYmm = pxToMm(cursorPx.y)
    const dxMm = wall.endX - wall.startX
    const dyMm = wall.endY - wall.startY
    const projXmm = wall.startX + best.tUnclamped * dxMm
    const projYmm = wall.startY + best.tUnclamped * dyMm
    const dirXmm = dxMm / lengthMm
    const dirYmm = dyMm / lengthMm
    const normXmm = -dirYmm
    const normYmm = dirXmm
    const dot =
      (cursorXmm - projXmm) * normXmm + (cursorYmm - projYmm) * normYmm
    const sign = dot >= 0 ? 1 : -1
    const halfTmm = (wallThicknessByWallId[wall.id] ?? 190) / 2
    return {
      wallId: wall.id,
      xMm: projXmm + sign * halfTmm * normXmm,
      yMm: projYmm + sign * halfTmm * normYmm,
    }
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
    // 1. Endpoint snap (corner candidate) — preferred when in range.
    //
    // The snap zone is anisotropic: GENEROUS along the wall axis (full
    // snapRadiusPx, which on a thick wall is roughly halfThickness, so the
    // whole end-block area snaps) but TIGHT across it (SNAP_THRESHOLD_PX,
    // 12 px). That way a cursor parked beside the wall's end face — i.e.
    // the user trying to T-junction at the very tip — escapes the corner
    // snap and lets the face snap below fire instead. A round radius would
    // swallow a halfThickness-wide cone of sideways space and force every
    // wall starting near another wall's end to be a corner.
    let closestEp: EndpointPixel | null = null
    let closestEpScore = Infinity
    for (const ep of endpointsPx) {
      if (ep.wallId === excludeWallId && ep.end === excludeEnd) continue
      const vx = cursor.x - ep.x
      const vy = cursor.y - ep.y
      // Decompose cursor offset into along/across the wall axis.
      const alongAbs = Math.abs(vx * ep.dirX + vy * ep.dirY)
      const perpAbs = Math.abs(vx * -ep.dirY + vy * ep.dirX)
      if (alongAbs > ep.snapRadiusPx) continue
      if (perpAbs > SNAP_THRESHOLD_PX) continue
      // Pick the closest by combined offset so the tightest endpoint wins
      // when multiple are eligible (e.g. corner junctions where two snap
      // targets coincide).
      const score = alongAbs + perpAbs
      if (score < closestEpScore) {
        closestEp = ep
        closestEpScore = score
      }
    }
    if (closestEp) {
      return {
        kind: 'endpoint',
        x: closestEp.x,
        y: closestEp.y,
        wallId: closestEp.wallId,
        end: closestEp.end,
      }
    }

    // 2. Wall-FACE snap (T-junction candidate). With thick walls, the right snap target is
    // the nearest face — not the centreline. The user clicks somewhere near or inside the
    // wall body; we snap to the closest face point so the new wall's endpoint lands at the
    // through-wall's edge.
    //
    // No along-wall dead-zone here: a T-junction at the very END of an
    // existing wall is a legitimate construction (new wall coming off the
    // side of the host wall's end-face), so face snap is allowed to fire
    // anywhere along the host's length. The endpoint snap above already
    // dominates when the cursor is on-axis with the wall end, so this only
    // kicks in when the cursor is genuinely off to the side.
    let closestBody: { x: number; y: number; wallId: string; distPx: number } | null = null
    for (const wall of walls) {
      if (wall.id === excludeWallId) continue
      if (isCurvedWall(wall)) continue // curves only connect at endpoints
      const proj = projectOntoWall(cursor, wall)
      if (!proj) continue
      const wallLenMm = wallLengthMmOf(wall)
      if (wallLenMm === 0) continue

      // Half-thickness in pixels. Convert via mmToPx so it scales with the current zoom.
      const thicknessMm = wallThicknessByWallId[wall.id] ?? 190
      const halfThicknessPx = mmToPx(thicknessMm / 2)

      // Cursor's perpendicular offset from the centreline projection.
      const perpX = cursor.x - proj.px.x
      const perpY = cursor.y - proj.px.y
      const perpDist = Math.sqrt(perpX * perpX + perpY * perpY)

      // Distance from cursor to the nearest face line. Inside the wall: halfThickness−perp.
      // Outside the wall: perp−halfThickness. Either way: |perp − halfThickness|.
      // Threshold lives in mm (WALL_FACE_SNAP_MM) and gets converted to the current zoom
      // here, so the snap range stays a fixed real-world distance no matter how far the
      // user has zoomed in or out — see WALL_FACE_SNAP_MM jsdoc for rationale.
      const distToFace = Math.abs(perpDist - halfThicknessPx)
      if (distToFace > mmToPx(WALL_FACE_SNAP_MM)) continue

      // Snap target is the face point: centreline projection + perpendicular_dir × halfThickness.
      // If perp is near zero (cursor sits ON the centreline), default to one side arbitrarily.
      let dirX = 0
      let dirY = 1
      if (perpDist > 0.01) {
        dirX = perpX / perpDist
        dirY = perpY / perpDist
      }
      const faceX = proj.px.x + dirX * halfThicknessPx
      const faceY = proj.px.y + dirY * halfThicknessPx

      if (!closestBody || distToFace < closestBody.distPx) {
        closestBody = { x: faceX, y: faceY, wallId: wall.id, distPx: distToFace }
      }
    }
    if (closestBody) {
      return {
        kind: 'body',
        x: closestBody.x,
        y: closestBody.y,
        wallId: closestBody.wallId,
      }
    }

    return null
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
      // typing overrides the distance.
      if (!inField && drawingMode && startMm) {
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
        if (e.key === 'Backspace') {
          e.preventDefault()
          setTypedLengthMm((prev) => prev.slice(0, -1))
          return
        }
        if (e.key === 'Enter' && typedLengthMm.trim()) {
          e.preventDefault()
          const lengthMm = parseFloat(typedLengthMm)
          if (
            cursorMm &&
            Number.isFinite(lengthMm) &&
            lengthMm > 0
          ) {
            const dx = cursorMm.x - startMm.x
            const dy = cursorMm.y - startMm.y
            const cursorDist = Math.sqrt(dx * dx + dy * dy)
            if (cursorDist > 0.001) {
              const ux = dx / cursorDist
              const uy = dy / cursorDist
              onWallAdded(startMm, {
                x: startMm.x + ux * lengthMm,
                y: startMm.y + uy * lengthMm,
              })
              setStartMm(null)
              setCursorMm(null)
              setSnapTarget(null)
              setTypedLengthMm('')
            }
          }
          return
        }
      }

      if (e.key === 'Escape') {
        if (drawingMode) {
          setStartMm(null)
          setCursorMm(null)
          setSnapTarget(null)
          setTypedLengthMm('')
          onCancelDraw?.()
        } else if (drawingCurveMode) {
          setCurveAnchorA(null)
          setCurveAnchorB(null)
          setCurveCursorMm(null)
          setCurveAnchorHoverMm(null)
          onCancelDraw?.()
        } else if (placingOpening) {
          setOpeningPlacementStart(null)
          setOpeningHoverProjection(null)
          onCancelDraw?.()
        } else if (placingControlJoint) {
          setControlJointHover(null)
          onCancelDraw?.()
        } else if (placingTiedPier) {
          setTiedPierHover(null)
          onCancelDraw?.()
        } else if (placingFreestandingPier) {
          setFreestandingPierHoverMm(null)
          onCancelDraw?.()
        } else if (placingRuler) {
          // Cancel any in-progress measurement and exit ruler mode entirely.
          onCancelDraw?.()
        } else if (selectedWallId) {
          onWallSelect(null)
        } else if (selectedOpeningId) {
          onOpeningSelect(null)
        }
      }
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [drawingMode, drawingCurveMode, placingOpening, placingControlJoint, placingTiedPier, placingFreestandingPier, placingRuler, selectedWallId, selectedOpeningId, onCancelDraw, onWallSelect, onOpeningSelect, startMm, cursorMm, typedLengthMm, onWallAdded])

  function setCursor(stage: Konva.Stage | null, cursor: string) {
    if (stage) stage.container().style.cursor = cursor
  }

  function resolveSnap(pos: Point, excludeWallId?: string, excludeEnd?: 'start' | 'end'): Point {
    const snap = findSnap(pos, excludeWallId, excludeEnd)
    return snap ? { x: snap.x, y: snap.y } : pos
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
    excludeEnd?: 'start' | 'end'
  ): { point: Point; snap: SnapResult | null } {
    // Shift bypasses ALL snaps — wall-snap, axis-snap, length-snap. This is
    // the escape hatch the user reaches for when a nearby wall's endpoint
    // is "eating" a length they want to draw past (the endpoint snap zone
    // covers half-thickness of along-axis cursor space, which on a 290 mm
    // wall is 145 mm — wide enough that the cursor can be pulled to the
    // snap target for a chunk of cursor movement, making the length appear
    // to skip values). Hold Shift to draw freely past any snap target.
    if (shiftKey) return { point: pos, snap: null }

    const snap = findSnap(pos, excludeWallId, excludeEnd)
    if (snap) {
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
    const snappedMm = snapMmToGrid(lenMm)
    if (snappedMm < WALL_LENGTH_SNAP_MM) {
      return { point: axisSnapped, snap: null }
    }
    const scale = snappedMm / lenMm
    return {
      point: {
        x: anchor.x + dxPx * scale,
        y: anchor.y + dyPx * scale,
      },
      snap: null,
    }
  }

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
    const raw = stage.getPointerPosition()
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
      const { point } = resolveDrawSnap(raw, startPxAnchor, e.evt.shiftKey)
      if (distance(startPxAnchor, point) < 5) return
      let posMm: Point = { x: pxToMm(point.x), y: pxToMm(point.y) }
      // If the user typed a length while aiming, override the cursor-distance
      // with the typed value while keeping the cursor's direction (which is
      // already axis-snapped via resolveDrawSnap above).
      const typedNum = parseFloat(typedLengthMm)
      if (typedLengthMm.trim() && Number.isFinite(typedNum) && typedNum > 0) {
        const dx = posMm.x - startMm.x
        const dy = posMm.y - startMm.y
        const cursorDist = Math.sqrt(dx * dx + dy * dy)
        if (cursorDist > 0.001) {
          const ux = dx / cursorDist
          const uy = dy / cursorDist
          posMm = {
            x: startMm.x + ux * typedNum,
            y: startMm.y + uy * typedNum,
          }
        }
      }
      onWallAdded(startMm, posMm)
      setStartMm(null)
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
      const proj = findClosestWallProjection(raw, onlyWall)
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
      return
    }

    if (placingControlJoint) {
      const proj = findClosestWallProjection(raw)
      if (!proj) return
      // Curved walls aren't splittable here.
      const wall = walls.find((w) => w.id === proj.wallId)
      if (!wall || isCurvedWall(wall)) return
      onControlJointPlaced?.(
        proj.wallId,
        useGrid ? snapMmToGrid(proj.alongMm) : proj.alongMm
      )
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
        useGrid ? snapMmToGrid(proj.alongMm) : proj.alongMm
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
          useGrid ? snapMmToGrid(tiedAlongMm) : tiedAlongMm
        )
      } else {
        const xMm = pxToMm(raw.x)
        const yMm = pxToMm(raw.y)
        onFreestandingPierPlaced?.(
          useGrid ? snapMmToGrid(xMm) : xMm,
          useGrid ? snapMmToGrid(yMm) : yMm
        )
      }
      setFreestandingPierHoverMm(null)
      setTiedPierHover(null)
      return
    }

    if (placingRuler) {
      // Each click drops a measurement point. Parent state tracks whether
      // this is the first (sets the anchor) or second (commits a measurement
      // and clears the anchor for the next pair).
      const posMm = {
        x: useGrid ? snapMmToGrid(pxToMm(raw.x)) : pxToMm(raw.x),
        y: useGrid ? snapMmToGrid(pxToMm(raw.y)) : pxToMm(raw.y),
      }
      onRulerClick?.(posMm)
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
    }
  }

  function handleStageMouseMove(e: Konva.KonvaEventObject<MouseEvent>) {
    const stage = e.target.getStage()
    if (!stage) return
    const raw = stage.getPointerPosition()
    if (!raw) return

    if (drawingMode) {
      // While the user is moving the cursor for the second click, anchor
      // axis-snap to startMm. Before the first click there's no anchor,
      // so axis-snap is a no-op (wall-snap still runs). Shift bypasses
      // the ortho lock.
      const startPxAnchor = startMm
        ? { x: mmToPx(startMm.x), y: mmToPx(startMm.y) }
        : null
      const { point, snap } = resolveDrawSnap(
        raw,
        startPxAnchor,
        e.evt.shiftKey
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
      } else {
        setOpeningHoverProjection(null)
      }
    } else if (placingControlJoint) {
      const proj = findClosestWallProjection(raw)
      // Don't preview splits on curved walls — control joints only apply to straight walls.
      if (proj) {
        const wall = walls.find((w) => w.id === proj.wallId)
        if (wall && isCurvedWall(wall)) {
          setControlJointHover(null)
          return
        }
      }
      setControlJointHover(proj)
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
      // Track the cursor in mm so the in-progress measurement line follows
      // the cursor between anchor and click. Snap to the grid for repeatable
      // measurements when the user is doing layout checks at round numbers.
      const xMm = useGrid ? snapMmToGrid(pxToMm(raw.x)) : pxToMm(raw.x)
      const yMm = useGrid ? snapMmToGrid(pxToMm(raw.y)) : pxToMm(raw.y)
      setCursorMm({ x: xMm, y: yMm })
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
    placingFreestandingPier
      ? 'crosshair'
      : 'inherit'

  return (
    <Stage
      width={visualWidth}
      height={visualHeight}
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
        top: 0,
        left: 0,
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

          const isCurved = isCurvedWall(wall)

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
            !placingFreestandingPier
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
          const strokeWidth = isSelected || isCurveAnchor ? 5 : isHovered ? 5 : 4
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
                  placingFreestandingPier
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
                  placingFreestandingPier
                ) return
                e.evt.stopPropagation()
              }}
            >
              <Line
                points={polygonPx}
                closed
                fill={
                  isSelected
                    ? hexToRgba(wallTypeStroke, 0.6)
                    : isCurveAnchor
                      ? 'rgba(139, 92, 246, 0.22)'
                      : hexToRgba(wallTypeStroke, 0.2)
                }
                stroke={strokeColor}
                strokeWidth={isSelected ? 5 : isCurveAnchor ? 2.5 : isHovered ? 2 : 1.5}
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
                // modes.
                shadowColor={isSelected ? wallTypeStroke : undefined}
                shadowBlur={isSelected ? 16 : 0}
                shadowOpacity={isSelected ? 0.85 : 0}
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
                    !placingFreestandingPier
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

              <Text
                x={midX + 8}
                y={midY - 18}
                text={formatMm(len)}
                fontSize={14}
                fill={isSelected ? '#1e40af' : '#C5530A'}
                fontStyle="bold"
                listening={false}
              />
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
                  placingFreestandingPier
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
                  placingFreestandingPier
                ) return
                e.evt.stopPropagation()
              }}
            >
              {/* Background "gap" rectangle covering the wall segment */}
              <Line
                points={[start.x, start.y, end.x, end.y]}
                stroke={isSelected ? '#1e40af' : '#FEF3C7'}
                strokeWidth={isSelected ? 8 : 8}
                hitStrokeWidth={14}
              />
              {/* Outline */}
              <Line
                points={[start.x, start.y, end.x, end.y]}
                stroke={isSelected ? '#1e40af' : '#D97706'}
                strokeWidth={2}
                dash={[8, 4]}
                listening={false}
              />
              <Circle x={start.x} y={start.y} radius={4} fill={isSelected ? '#1e40af' : '#D97706'} stroke="white" strokeWidth={1.5} listening={false} />
              <Circle x={end.x} y={end.y} radius={4} fill={isSelected ? '#1e40af' : '#D97706'} stroke="white" strokeWidth={1.5} listening={false} />
              <Text
                x={midX - 35}
                y={midY + 10}
                text={`${Math.round(opening.widthMm)} × ${Math.round(opening.heightMm)}`}
                fontSize={12}
                fill={isSelected ? '#1e40af' : '#92400E'}
                fontStyle="bold"
                listening={false}
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
                radius={6}
                fill="#D97706"
                stroke="white"
                strokeWidth={2}
              />
              {openingHoverProjection && openingHoverProjection.wallId === openingPlacementStart.wallId && (
                <>
                  <Line
                    points={[
                      startPosPx.x,
                      startPosPx.y,
                      openingHoverProjection.px.x,
                      openingHoverProjection.px.y,
                    ]}
                    stroke="#D97706"
                    strokeWidth={6}
                    opacity={0.5}
                  />
                  <Text
                    x={(startPosPx.x + openingHoverProjection.px.x) / 2 + 8}
                    y={(startPosPx.y + openingHoverProjection.px.y) / 2 + 10}
                    text={`${Math.round(Math.abs(openingHoverProjection.alongMm - openingPlacementStart.alongMm))} mm wide`}
                    fontSize={12}
                    fill="#92400E"
                    fontStyle="bold"
                  />
                </>
              )}
            </Group>
          )
        })()}
        {placingOpening && !openingPlacementStart && openingHoverProjection && (
          <Circle
            x={openingHoverProjection.px.x}
            y={openingHoverProjection.px.y}
            radius={6}
            stroke="#D97706"
            strokeWidth={2}
            fill="rgba(217, 119, 6, 0.3)"
            listening={false}
          />
        )}

        {/* Piers — rendered above wall polygons. Tied piers as 390×390 squares on the wall;
            freestanding piers as standalone 390×390 squares at their (x, y). */}
        {piers.map((pier) => {
          const isSelected =
            (selectedPierIds && selectedPierIds.has(pier.id)) || pier.id === selectedPierId
          // Pier face size: 390mm × 390mm (block 40.925 footprint).
          const sizeMm = 390
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

          const sizePx = mmToPx(sizeMm)
          const fillColor = pier.type === 'tied'
            ? (isSelected ? 'rgba(5, 150, 105, 0.45)' : 'rgba(16, 185, 129, 0.35)')
            : (isSelected ? 'rgba(13, 148, 136, 0.45)' : 'rgba(20, 184, 166, 0.35)')
          const strokeColor = pier.type === 'tied' ? '#065f46' : '#0f766e'

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
                  placingFreestandingPier
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
                  placingFreestandingPier
                ) return
                e.evt.stopPropagation()
              }}
            >
              <Rect
                x={cxPx}
                y={cyPx}
                width={sizePx}
                height={sizePx}
                offsetX={sizePx / 2}
                offsetY={sizePx / 2}
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
          const sizePx = mmToPx(390)
          return (
            <Rect
              x={tiedPierHover.px.x}
              y={tiedPierHover.px.y}
              width={sizePx}
              height={sizePx}
              offsetX={sizePx / 2}
              offsetY={sizePx / 2}
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
          const sizePx = mmToPx(390)
          return (
            <Rect
              x={cxPx}
              y={cyPx}
              width={sizePx}
              height={sizePx}
              offsetX={sizePx / 2}
              offsetY={sizePx / 2}
              fill="rgba(20, 184, 166, 0.25)"
              stroke="#0f766e"
              strokeWidth={2}
              dash={[6, 4]}
              listening={false}
            />
          )
        })()}

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

        {/* Wall drawing preview */}
        {drawingMode && startPx && (
          <Group listening={false}>
            <Circle x={startPx.x} y={startPx.y} radius={5} fill="#ED7D31" stroke="white" strokeWidth={2} />
            {cursorPx && (() => {
              // If the user typed a length, project the preview line along the
              // cursor direction at exactly the typed magnitude — that way the
              // dashed preview matches what the click will commit.
              const typedNum = parseFloat(typedLengthMm)
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
              let endPx = cursorPx
              if (hasTyped && cursorDistMm > 0.001) {
                const ux = dx / cursorDistMm
                const uy = dy / cursorDistMm
                endPx = {
                  x: mmToPx(startMmFromPx.x + ux * typedNum),
                  y: mmToPx(startMmFromPx.y + uy * typedNum),
                }
              }
              const previewLengthMm = hasTyped ? typedNum : cursorDistMm
              return (
                <>
                  <Line
                    points={[startPx.x, startPx.y, endPx.x, endPx.y]}
                    stroke="#ED7D31"
                    strokeWidth={3}
                    dash={[6, 4]}
                  />
                  {/* When the user is typing, show the digits they've entered
                      so far in a chunky badge so they know the system has
                      registered their input. Otherwise show the standard
                      cursor-distance read-out. */}
                  <Text
                    x={(startPx.x + endPx.x) / 2 + 8}
                    y={(startPx.y + endPx.y) / 2 - 18}
                    text={
                      hasTyped
                        ? `${typedLengthMm} mm ⏎`
                        : typedLengthMm.trim()
                          ? `${typedLengthMm} mm …`
                          : formatMm(previewLengthMm)
                    }
                    fontSize={14}
                    fill={hasTyped ? '#3B82F6' : '#C5530A'}
                    fontStyle="bold"
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
            {/* Arc preview through anchor A → cursor → anchor B */}
            {curveAnchorA && curveAnchorB && curveCursorMm && (() => {
              const geom = arcFromThreePoints(
                { x: curveAnchorA.xMm, y: curveAnchorA.yMm },
                curveCursorMm,
                { x: curveAnchorB.xMm, y: curveAnchorB.yMm }
              )
              if (!geom) {
                // Collinear — show a dashed straight line as a fallback hint.
                return (
                  <Line
                    points={[
                      mmToPx(curveAnchorA.xMm),
                      mmToPx(curveAnchorA.yMm),
                      mmToPx(curveAnchorB.xMm),
                      mmToPx(curveAnchorB.yMm),
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
                    x={mmToPx(curveCursorMm.x) + 10}
                    y={mmToPx(curveCursorMm.y) - 22}
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
            mistaken for in-progress drawing. */}
        {measurements.map((m) => {
          const startPx = { x: mmToPx(m.startMm.x), y: mmToPx(m.startMm.y) }
          const endPx = { x: mmToPx(m.endMm.x), y: mmToPx(m.endMm.y) }
          const lengthMm = distance(m.startMm, m.endMm)
          const midPx = {
            x: (startPx.x + endPx.x) / 2,
            y: (startPx.y + endPx.y) / 2,
          }
          return (
            <Group key={m.id} listening={false}>
              <Line
                points={[startPx.x, startPx.y, endPx.x, endPx.y]}
                stroke="#d946ef"
                strokeWidth={2}
                dash={[6, 4]}
              />
              <Circle x={startPx.x} y={startPx.y} radius={4} fill="#d946ef" stroke="white" strokeWidth={1.5} />
              <Circle x={endPx.x} y={endPx.y} radius={4} fill="#d946ef" stroke="white" strokeWidth={1.5} />
              <Text
                x={midPx.x + 8}
                y={midPx.y - 18}
                text={formatMm(lengthMm)}
                fontSize={14}
                fill="#a21caf"
                fontStyle="bold"
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
                strokeWidth={2}
                dash={[6, 4]}
                opacity={0.85}
              />
              <Circle x={startPx.x} y={startPx.y} radius={5} fill="#d946ef" stroke="white" strokeWidth={2} />
              <Text
                x={(startPx.x + endPx.x) / 2 + 8}
                y={(startPx.y + endPx.y) / 2 - 18}
                text={formatMm(lengthMm)}
                fontSize={14}
                fill="#a21caf"
                fontStyle="bold"
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
  // get larger ones. Clamped to [4, 12] px so a wall that's effectively
  // invisible at low zoom still gets a clickable marker, and so a wall at
  // 4× zoom doesn't end up with a marker the size of a coin obscuring the
  // PDF underneath. Selected markers get a slight bump so the drag handle
  // is easy to find without obscuring the plan.
  const baseSize = Math.max(4, Math.min(12, wallThicknessPx * 0.95))
  const radius = (isSelected ? baseSize * 1.3 : baseSize) / 2
  const cornerSquareSize = isSelected ? Math.min(12, baseSize * 1.2) : baseSize
  const tjunctionDiamondSize = cornerSquareSize
  const controlJointOuterRadius = baseSize * 0.6
  const controlJointInnerRadius = Math.max(1.25, baseSize * 0.22)
  const fill = isSelected
    ? '#3b82f6'
    : isCorner
    ? '#10b981' // green = corner
    : isTjunction
    ? '#8b5cf6' // purple = T-junction
    : isControlJoint
    ? '#e11d48' // rose = control joint
    : '#ED7D31' // orange = free

  // Control joint: rose ring with a small dot at the centre — visually reads as a "split
  // here" pin distinct from the other end markers. Both halves' endpoints overlap at the
  // joint coordinates, so the two pins draw on top of each other (no dedup needed).
  if (isControlJoint && !isSelected) {
    return (
      <>
        <Circle
          x={pos.x}
          y={pos.y}
          radius={controlJointOuterRadius}
          stroke={fill}
          strokeWidth={1.5}
          fill="white"
          listening={false}
        />
        <Circle
          x={pos.x}
          y={pos.y}
          radius={controlJointInnerRadius}
          fill={fill}
          listening={false}
        />
      </>
    )
  }

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
