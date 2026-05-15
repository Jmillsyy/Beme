import { useEffect, useMemo, useState } from 'react'
import { Stage, Layer, Line, Circle, Rect, Text, Group } from 'react-konva'
import type Konva from 'konva'
import type { Wall } from '../types/walls'

interface Point {
  x: number
  y: number
}

interface WallDrawingLayerProps {
  walls: Wall[]
  visualWidth: number
  visualHeight: number
  /** Visual pixels per mm at the current zoom. */
  pxPerMmAtCurrentZoom: number
  /** Whether drawing mode is active (clicking creates walls). */
  drawingMode: boolean
  /** Currently selected wall id (null = nothing selected). */
  selectedWallId: string | null
  onWallAdded: (startMm: Point, endMm: Point) => void
  onWallSelect: (wallId: string | null) => void
  onWallEndpointMoved: (
    wallId: string,
    which: 'start' | 'end',
    newPositionMm: Point
  ) => void
  onCancel?: () => void
}

const SNAP_THRESHOLD_PX = 12

interface EndpointPixel {
  x: number
  y: number
  wallId: string
  end: 'start' | 'end'
}

function distance(a: Point, b: Point) {
  const dx = b.x - a.x
  const dy = b.y - a.y
  return Math.sqrt(dx * dx + dy * dy)
}

/**
 * Konva overlay for drawing, displaying, selecting and editing walls.
 *
 *   - drawingMode = true  →  click two points to create a new wall
 *   - drawingMode = false →  click a wall to select it, drag its endpoint handles
 *
 * All wall coordinates are stored in mm; the layer converts to current visual pixels.
 */
export default function WallDrawingLayer({
  walls,
  visualWidth,
  visualHeight,
  pxPerMmAtCurrentZoom,
  drawingMode,
  selectedWallId,
  onWallAdded,
  onWallSelect,
  onWallEndpointMoved,
  onCancel,
}: WallDrawingLayerProps) {
  const [startPx, setStartPx] = useState<Point | null>(null)
  const [cursorPx, setCursorPx] = useState<Point | null>(null)
  const [snapTarget, setSnapTarget] = useState<EndpointPixel | null>(null)
  const [hoveredWallId, setHoveredWallId] = useState<string | null>(null)
  /** Live preview while dragging an endpoint (so the line follows the cursor). */
  const [dragPreview, setDragPreview] = useState<{
    wallId: string
    which: 'start' | 'end'
    px: Point
  } | null>(null)

  const pxToMm = (px: number) => px / pxPerMmAtCurrentZoom
  const mmToPx = (mm: number) => mm * pxPerMmAtCurrentZoom

  const endpointsPx: EndpointPixel[] = useMemo(
    () =>
      walls.flatMap((w) => [
        { x: mmToPx(w.startX), y: mmToPx(w.startY), wallId: w.id, end: 'start' as const },
        { x: mmToPx(w.endX), y: mmToPx(w.endY), wallId: w.id, end: 'end' as const },
      ]),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [walls, pxPerMmAtCurrentZoom]
  )

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

  // Reset in-progress draw whenever drawing mode toggles off
  useEffect(() => {
    if (!drawingMode) {
      setStartPx(null)
      setCursorPx(null)
      setSnapTarget(null)
    }
  }, [drawingMode])

  // Esc cancels the current draw or deselects
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        if (drawingMode) {
          setStartPx(null)
          setCursorPx(null)
          setSnapTarget(null)
          onCancel?.()
        } else if (selectedWallId) {
          onWallSelect(null)
        }
      }
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [drawingMode, selectedWallId, onCancel, onWallSelect])

  function setCursor(stage: Konva.Stage | null, cursor: string) {
    if (stage) stage.container().style.cursor = cursor
  }

  /** Resolve raw stage coords through snap (returns the snapped position if any). */
  function resolveSnap(pos: Point, excludeWallId?: string, excludeEnd?: 'start' | 'end'): Point {
    const snap = findSnap(pos, excludeWallId, excludeEnd)
    return snap ? { x: snap.x, y: snap.y } : pos
  }

  // ---- Drawing mode events ----

  function handleStageClick(e: Konva.KonvaEventObject<MouseEvent>) {
    if (!drawingMode) return
    const stage = e.target.getStage()
    if (!stage) return
    const raw = stage.getPointerPosition()
    if (!raw) return
    const pos = resolveSnap(raw)

    if (!startPx) {
      setStartPx(pos)
      setCursorPx(pos)
      return
    }

    const pxDist = distance(startPx, pos)
    if (pxDist < 5) return

    onWallAdded(
      { x: pxToMm(startPx.x), y: pxToMm(startPx.y) },
      { x: pxToMm(pos.x), y: pxToMm(pos.y) }
    )
    setStartPx(null)
    setCursorPx(null)
    setSnapTarget(null)
  }

  function handleStageMouseMove(e: Konva.KonvaEventObject<MouseEvent>) {
    const stage = e.target.getStage()
    if (!stage) return
    const raw = stage.getPointerPosition()
    if (!raw) return

    if (drawingMode) {
      setSnapTarget(findSnap(raw))
      setCursorPx(resolveSnap(raw))
    }
  }

  /**
   * Click on empty stage area:
   *   - Drawing mode: handled by handleStageClick
   *   - Selection mode: deselect any selected wall
   * The DOM event still bubbles to the container for pan to work.
   */
  function handleStageMouseDown(e: Konva.KonvaEventObject<MouseEvent>) {
    if (drawingMode) return
    // Click landed on the Stage itself, not a shape
    if (e.target === e.target.getStage()) {
      if (selectedWallId) onWallSelect(null)
      // Don't stopPropagation — let it bubble for pan
    }
  }

  // ---- Endpoint drag ----

  function handleEndpointDragMove(
    e: Konva.KonvaEventObject<DragEvent>,
    wallId: string,
    which: 'start' | 'end'
  ) {
    const pos = e.target.position()
    const snap = findSnap(pos, wallId, which)
    const resolved = snap ? { x: snap.x, y: snap.y } : pos
    // Keep handle visually pinned to the snap target if snapped
    if (snap) e.target.position(resolved)
    setSnapTarget(snap)
    setDragPreview({ wallId, which, px: resolved })
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
    setDragPreview(null)
  }

  function formatMm(mm: number) {
    return `${Math.round(mm)} mm`
  }

  /** Effective position for a wall's endpoint, considering live drag preview. */
  function effectiveEndpoint(wall: Wall, which: 'start' | 'end'): Point {
    if (dragPreview?.wallId === wall.id && dragPreview.which === which) {
      return dragPreview.px
    }
    return which === 'start'
      ? { x: mmToPx(wall.startX), y: mmToPx(wall.startY) }
      : { x: mmToPx(wall.endX), y: mmToPx(wall.endY) }
  }

  return (
    <Stage
      width={visualWidth}
      height={visualHeight}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        pointerEvents: 'auto',
        cursor: drawingMode ? 'crosshair' : 'inherit',
      }}
      onClick={handleStageClick}
      onMouseMove={handleStageMouseMove}
      onMouseDown={handleStageMouseDown}
    >
      <Layer>
        {/* Existing walls */}
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
          const isHovered = wall.id === hoveredWallId && !drawingMode
          const strokeColor = isSelected ? '#3b82f6' : '#ED7D31'
          const strokeWidth = isSelected ? 5 : isHovered ? 5 : 4
          const startIsCorner = wall.startJunction.type === 'corner'
          const endIsCorner = wall.endJunction.type === 'corner'

          return (
            <Group
              key={wall.id}
              onClick={(e) => {
                if (drawingMode) return
                onWallSelect(wall.id)
                e.cancelBubble = true
              }}
              onMouseDown={(e) => {
                if (drawingMode) return
                // Prevent the pan handler on the container from firing when interacting
                // with anything inside this wall (line or endpoint markers).
                e.evt.stopPropagation()
              }}
            >
              <Line
                points={[start.x, start.y, end.x, end.y]}
                stroke={strokeColor}
                strokeWidth={strokeWidth}
                hitStrokeWidth={14}
                onMouseEnter={(e) => {
                  if (!drawingMode) {
                    setHoveredWallId(wall.id)
                    setCursor(e.target.getStage(), 'pointer')
                  }
                }}
                onMouseLeave={(e) => {
                  setHoveredWallId(null)
                  setCursor(e.target.getStage(), drawingMode ? 'crosshair' : 'inherit')
                }}
              />

              {/* Start endpoint marker */}
              {renderEndpointMarker({
                pos: start,
                isCorner: startIsCorner,
                isSelected,
                draggable: isSelected,
                onDragMove: (ev) => handleEndpointDragMove(ev, wall.id, 'start'),
                onDragEnd: (ev) => handleEndpointDragEnd(ev, wall.id, 'start'),
                onMouseEnterStage: (ev) => setCursor(ev.target.getStage(), isSelected ? 'move' : 'inherit'),
                onMouseLeaveStage: (ev) => setCursor(ev.target.getStage(), drawingMode ? 'crosshair' : 'inherit'),
              })}

              {/* End endpoint marker */}
              {renderEndpointMarker({
                pos: end,
                isCorner: endIsCorner,
                isSelected,
                draggable: isSelected,
                onDragMove: (ev) => handleEndpointDragMove(ev, wall.id, 'end'),
                onDragEnd: (ev) => handleEndpointDragEnd(ev, wall.id, 'end'),
                onMouseEnterStage: (ev) => setCursor(ev.target.getStage(), isSelected ? 'move' : 'inherit'),
                onMouseLeaveStage: (ev) => setCursor(ev.target.getStage(), drawingMode ? 'crosshair' : 'inherit'),
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

        {/* Drawing preview line */}
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

  // Corner ends use a square marker; free ends use a circle
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
