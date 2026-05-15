import { useEffect, useMemo, useState } from 'react'
import { Stage, Layer, Line, Circle, Rect, Text, Group } from 'react-konva'
import type Konva from 'konva'
import type { Opening, Wall } from '../types/walls'

interface Point {
  x: number
  y: number
}

interface WallDrawingLayerProps {
  walls: Wall[]
  /** Openings on the current page (across all walls). */
  openings: Opening[]
  visualWidth: number
  visualHeight: number
  /** Visual pixels per mm at the current zoom. */
  pxPerMmAtCurrentZoom: number
  /** Whether drawing-wall mode is active. */
  drawingMode: boolean
  /** Whether placing-opening mode is active. */
  placingOpening: boolean
  /** Currently selected wall id (null = nothing selected). */
  selectedWallId: string | null
  /** Currently selected opening id (null = nothing selected). */
  selectedOpeningId: string | null
  onWallAdded: (startMm: Point, endMm: Point) => void
  onWallSelect: (wallId: string | null) => void
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
  onCancelDraw?: () => void
}

const SNAP_THRESHOLD_PX = 12
/** Max distance from a click to a wall line for opening-placement projection to snap to that wall. */
const WALL_SNAP_THRESHOLD_PX = 20

interface EndpointPixel {
  x: number
  y: number
  wallId: string
  end: 'start' | 'end'
}

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
 * Konva overlay for drawing/selecting/editing walls + placing/displaying openings.
 */
export default function WallDrawingLayer({
  walls,
  openings,
  visualWidth,
  visualHeight,
  pxPerMmAtCurrentZoom,
  drawingMode,
  placingOpening,
  selectedWallId,
  selectedOpeningId,
  onWallAdded,
  onWallSelect,
  onWallEndpointMoved,
  onOpeningPlaced,
  onOpeningSelect,
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
  const [cursorMm, setCursorMm] = useState<Point | null>(null)
  const [snapTarget, setSnapTarget] = useState<EndpointPixel | null>(null)
  const [hoveredWallId, setHoveredWallId] = useState<string | null>(null)
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

  const endpointsPx: EndpointPixel[] = useMemo(
    () =>
      walls.flatMap((w) => [
        { x: mmToPx(w.startX), y: mmToPx(w.startY), wallId: w.id, end: 'start' as const },
        { x: mmToPx(w.endX), y: mmToPx(w.endY), wallId: w.id, end: 'end' as const },
      ]),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [walls, pxPerMmAtCurrentZoom]
  )

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
      if (proj.distFromLinePx > WALL_SNAP_THRESHOLD_PX) continue
      if (!best || proj.distFromLinePx < best.distFromLinePx) {
        best = proj
      }
    }
    return best
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

  function findSnap(cursor: Point, excludeWallId?: string, excludeEnd?: 'start' | 'end'): EndpointPixel | null {
    let closest: EndpointPixel | null = null
    let closestDist = SNAP_THRESHOLD_PX
    for (const ep of endpointsPx) {
      if (ep.wallId === excludeWallId && ep.end === excludeEnd) continue
      const d = distance(cursor, ep)
      if (d < closestDist) {
        closest = ep
        closestDist = d
      }
    }
    return closest
  }

  // ---------- Cleanup on mode toggle ----------
  useEffect(() => {
    if (!drawingMode) {
      setStartMm(null)
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
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        if (drawingMode) {
          setStartMm(null)
          setCursorMm(null)
          setSnapTarget(null)
          onCancelDraw?.()
        } else if (placingOpening) {
          setOpeningPlacementStart(null)
          setOpeningHoverProjection(null)
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
  }, [drawingMode, placingOpening, selectedWallId, selectedOpeningId, onCancelDraw, onWallSelect, onOpeningSelect])

  function setCursor(stage: Konva.Stage | null, cursor: string) {
    if (stage) stage.container().style.cursor = cursor
  }

  function resolveSnap(pos: Point, excludeWallId?: string, excludeEnd?: 'start' | 'end'): Point {
    const snap = findSnap(pos, excludeWallId, excludeEnd)
    return snap ? { x: snap.x, y: snap.y } : pos
  }

  // ---------- Stage events ----------

  function handleStageClick(e: Konva.KonvaEventObject<MouseEvent>) {
    const stage = e.target.getStage()
    if (!stage) return
    const raw = stage.getPointerPosition()
    if (!raw) return

    if (drawingMode) {
      const pos = resolveSnap(raw)
      const posMm: Point = { x: pxToMm(pos.x), y: pxToMm(pos.y) }
      if (!startMm) {
        setStartMm(posMm)
        setCursorMm(posMm)
        return
      }
      if (distance(startPx!, pos) < 5) return
      onWallAdded(startMm, posMm)
      setStartMm(null)
      setCursorMm(null)
      setSnapTarget(null)
      return
    }

    if (placingOpening) {
      const onlyWall = openingPlacementStart?.wallId
      const proj = findClosestWallProjection(raw, onlyWall)
      if (!proj) return
      if (!openingPlacementStart) {
        setOpeningPlacementStart({ wallId: proj.wallId, alongMm: proj.alongMm })
        return
      }
      // Second click — compute opening start + width
      const a = openingPlacementStart.alongMm
      const b = proj.alongMm
      const startAlong = Math.min(a, b)
      const widthMm = Math.abs(b - a)
      if (widthMm < 100) return // ignore degenerate
      onOpeningPlaced(proj.wallId, startAlong, widthMm)
      setOpeningPlacementStart(null)
      setOpeningHoverProjection(null)
      return
    }

    // View mode: clicking on empty stage area deselects. Konva only fires onClick when
    // there's no significant drag, so a click+drag (pan) won't trigger deselect.
    if (e.target === e.target.getStage()) {
      if (selectedWallId) onWallSelect(null)
      if (selectedOpeningId) onOpeningSelect(null)
    }
  }

  function handleStageMouseMove(e: Konva.KonvaEventObject<MouseEvent>) {
    const stage = e.target.getStage()
    if (!stage) return
    const raw = stage.getPointerPosition()
    if (!raw) return

    if (drawingMode) {
      setSnapTarget(findSnap(raw))
      const resolved = resolveSnap(raw)
      setCursorMm({ x: pxToMm(resolved.x), y: pxToMm(resolved.y) })
    } else if (placingOpening) {
      const onlyWall = openingPlacementStart?.wallId
      const proj = findClosestWallProjection(raw, onlyWall)
      setOpeningHoverProjection(proj)
    }
  }

  function handleStageMouseDown(_e: Konva.KonvaEventObject<MouseEvent>) {
    // Empty intentionally: deselect is handled by the click handler (so it only fires when
    // there's no drag), and pan is started by the container's mousedown bubbling from here.
  }

  // ---------- Endpoint drag ----------

  function handleEndpointDragMove(
    e: Konva.KonvaEventObject<DragEvent>,
    wallId: string,
    which: 'start' | 'end'
  ) {
    const pos = e.target.position()
    const snap = findSnap(pos, wallId, which)
    const resolved = snap ? { x: snap.x, y: snap.y } : pos
    if (snap) e.target.position(resolved)
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
    const snap = findSnap(pos, wallId, which)
    const finalPx = snap ? { x: snap.x, y: snap.y } : pos
    onWallEndpointMoved(wallId, which, { x: pxToMm(finalPx.x), y: pxToMm(finalPx.y) })
    setSnapTarget(null)
    setDragPreviewMm(null)
  }

  function formatMm(mm: number) {
    return `${Math.round(mm)} mm`
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

  const containerCursor = drawingMode || placingOpening ? 'crosshair' : 'inherit'

  return (
    <Stage
      width={visualWidth}
      height={visualHeight}
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
          const len = distance(
            { x: pxToMm(start.x), y: pxToMm(start.y) },
            { x: pxToMm(end.x), y: pxToMm(end.y) }
          )
          const midX = (start.x + end.x) / 2
          const midY = (start.y + end.y) / 2

          const isSelected = wall.id === selectedWallId
          const isHovered = wall.id === hoveredWallId && !drawingMode && !placingOpening
          const strokeColor = isSelected ? '#3b82f6' : '#ED7D31'
          const strokeWidth = isSelected ? 5 : isHovered ? 5 : 4
          const startIsCorner = wall.startJunction.type === 'corner'
          const endIsCorner = wall.endJunction.type === 'corner'

          return (
            <Group
              key={wall.id}
              onClick={(e) => {
                if (drawingMode || placingOpening) return
                onWallSelect(wall.id)
                e.cancelBubble = true
              }}
              onMouseDown={(e) => {
                if (drawingMode || placingOpening) return
                e.evt.stopPropagation()
              }}
            >
              <Line
                points={[start.x, start.y, end.x, end.y]}
                stroke={strokeColor}
                strokeWidth={strokeWidth}
                hitStrokeWidth={14}
                onMouseEnter={(e) => {
                  if (!drawingMode && !placingOpening) {
                    setHoveredWallId(wall.id)
                    setCursor(e.target.getStage(), 'pointer')
                  }
                }}
                onMouseLeave={(e) => {
                  setHoveredWallId(null)
                  setCursor(e.target.getStage(), containerCursor)
                }}
              />

              {renderEndpointMarker({
                pos: start,
                isCorner: startIsCorner,
                isSelected,
                draggable: isSelected,
                onDragMove: (ev) => handleEndpointDragMove(ev, wall.id, 'start'),
                onDragEnd: (ev) => handleEndpointDragEnd(ev, wall.id, 'start'),
                onMouseEnterStage: (ev) => setCursor(ev.target.getStage(), isSelected ? 'move' : 'inherit'),
                onMouseLeaveStage: (ev) => setCursor(ev.target.getStage(), containerCursor),
              })}

              {renderEndpointMarker({
                pos: end,
                isCorner: endIsCorner,
                isSelected,
                draggable: isSelected,
                onDragMove: (ev) => handleEndpointDragMove(ev, wall.id, 'end'),
                onDragEnd: (ev) => handleEndpointDragEnd(ev, wall.id, 'end'),
                onMouseEnterStage: (ev) => setCursor(ev.target.getStage(), isSelected ? 'move' : 'inherit'),
                onMouseLeaveStage: (ev) => setCursor(ev.target.getStage(), containerCursor),
              })}

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
          const isSelected = opening.id === selectedOpeningId

          return (
            <Group
              key={opening.id}
              onClick={(e) => {
                if (drawingMode || placingOpening) return
                onOpeningSelect(opening.id)
                e.cancelBubble = true
              }}
              onMouseDown={(e) => {
                if (drawingMode || placingOpening) return
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

        {/* Wall drawing preview */}
        {drawingMode && startPx && (
          <Group listening={false}>
            <Circle x={startPx.x} y={startPx.y} radius={5} fill="#ED7D31" stroke="white" strokeWidth={2} />
            {cursorPx && (
              <>
                <Line
                  points={[startPx.x, startPx.y, cursorPx.x, cursorPx.y]}
                  stroke="#ED7D31"
                  strokeWidth={3}
                  dash={[6, 4]}
                />
                <Text
                  x={(startPx.x + cursorPx.x) / 2 + 8}
                  y={(startPx.y + cursorPx.y) / 2 - 18}
                  text={formatMm(
                    distance(
                      { x: pxToMm(startPx.x), y: pxToMm(startPx.y) },
                      { x: pxToMm(cursorPx.x), y: pxToMm(cursorPx.y) }
                    )
                  )}
                  fontSize={14}
                  fill="#C5530A"
                  fontStyle="bold"
                />
              </>
            )}
          </Group>
        )}

        {/* Snap indicator */}
        {snapTarget && (
          <Circle
            x={snapTarget.x}
            y={snapTarget.y}
            radius={10}
            stroke="#10b981"
            strokeWidth={2.5}
            fill="rgba(16, 185, 129, 0.18)"
            listening={false}
          />
        )}
      </Layer>
    </Stage>
  )
}

interface EndpointMarkerProps {
  pos: Point
  isCorner: boolean
  isSelected: boolean
  draggable: boolean
  onDragMove: (e: Konva.KonvaEventObject<DragEvent>) => void
  onDragEnd: (e: Konva.KonvaEventObject<DragEvent>) => void
  onMouseEnterStage: (e: Konva.KonvaEventObject<MouseEvent>) => void
  onMouseLeaveStage: (e: Konva.KonvaEventObject<MouseEvent>) => void
}

function renderEndpointMarker({
  pos,
  isCorner,
  isSelected,
  draggable,
  onDragMove,
  onDragEnd,
  onMouseEnterStage,
  onMouseLeaveStage,
}: EndpointMarkerProps) {
  const radius = isSelected ? 7 : 5
  const fill = isSelected ? '#3b82f6' : isCorner ? '#10b981' : '#ED7D31'

  if (isCorner && !isSelected) {
    const size = 12
    return (
      <Rect
        x={pos.x - size / 2}
        y={pos.y - size / 2}
        width={size}
        height={size}
        fill={fill}
        stroke="white"
        strokeWidth={2}
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
      strokeWidth={2}
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
