import { useEffect, useState } from 'react'
import { Stage, Layer, Line, Circle, Text, Group } from 'react-konva'
import type Konva from 'konva'
import type { Wall } from '../types/walls'

interface Point {
  x: number
  y: number
}

interface WallDrawingLayerProps {
  /** Walls currently drawn (start/end stored in real-world mm). */
  walls: Wall[]
  /** Pixel dimensions of the current visual PDF view. */
  visualWidth: number
  visualHeight: number
  /** Conversion factor: visual pixels per mm at the current zoom level. */
  pxPerMmAtCurrentZoom: number
  /** Whether drawing mode is active. */
  drawingMode: boolean
  /** Called when the user completes a wall (coords in mm). */
  onWallAdded: (startMm: Point, endMm: Point) => void
  /** Called when the user cancels mid-draw (Esc, or external cancel). */
  onCancel?: () => void
}

/**
 * Konva overlay for drawing and displaying walls on top of a calibrated PDF page.
 *
 * - When drawingMode is true, clicks set start/end points to create a new wall.
 *   Esc cancels mid-draw.
 * - When drawingMode is false, the layer is non-interactive (pointer-events: none)
 *   and just shows the existing walls with their lengths.
 *
 * All wall coordinates are stored in mm (real world) so they survive zoom changes.
 * The layer converts to visual pixels for display using pxPerMmAtCurrentZoom.
 */
export default function WallDrawingLayer({
  walls,
  visualWidth,
  visualHeight,
  pxPerMmAtCurrentZoom,
  drawingMode,
  onWallAdded,
  onCancel,
}: WallDrawingLayerProps) {
  const [startPx, setStartPx] = useState<Point | null>(null)
  const [mousePx, setMousePx] = useState<Point | null>(null)

  const pxToMm = (px: number) => px / pxPerMmAtCurrentZoom
  const mmToPx = (mm: number) => mm * pxPerMmAtCurrentZoom

  // Reset in-progress draw whenever drawing mode is toggled off
  useEffect(() => {
    if (!drawingMode) {
      setStartPx(null)
      setMousePx(null)
    }
  }, [drawingMode])

  // Esc cancels the current draw
  useEffect(() => {
    if (!drawingMode) return
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setStartPx(null)
        setMousePx(null)
        onCancel?.()
      }
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [drawingMode, onCancel])

  function handleStageClick(e: Konva.KonvaEventObject<MouseEvent>) {
    if (!drawingMode) return
    const stage = e.target.getStage()
    if (!stage) return
    const pos = stage.getPointerPosition()
    if (!pos) return

    if (!startPx) {
      setStartPx(pos)
      setMousePx(pos)
      return
    }

    // Reject too-short walls (treat as accidental double click)
    const dx = pos.x - startPx.x
    const dy = pos.y - startPx.y
    const pxDist = Math.sqrt(dx * dx + dy * dy)
    if (pxDist < 5) return

    onWallAdded(
      { x: pxToMm(startPx.x), y: pxToMm(startPx.y) },
      { x: pxToMm(pos.x), y: pxToMm(pos.y) }
    )
    setStartPx(null)
    setMousePx(null)
  }

  function handleStageMouseMove(e: Konva.KonvaEventObject<MouseEvent>) {
    if (!drawingMode || !startPx) return
    const stage = e.target.getStage()
    if (!stage) return
    const pos = stage.getPointerPosition()
    if (!pos) return
    setMousePx(pos)
  }

  function lengthMm(a: Point, b: Point) {
    const dx = b.x - a.x
    const dy = b.y - a.y
    return Math.sqrt(dx * dx + dy * dy)
  }

  function formatMm(mm: number) {
    return `${Math.round(mm)} mm`
  }

  return (
    <Stage
      width={visualWidth}
      height={visualHeight}
      listening={drawingMode}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        pointerEvents: drawingMode ? 'auto' : 'none',
        cursor: drawingMode ? 'crosshair' : 'default',
      }}
      onClick={handleStageClick}
      onMouseMove={handleStageMouseMove}
    >
      <Layer>
        {/* Existing walls */}
        {walls.map((wall) => {
          const sx = mmToPx(wall.startX)
          const sy = mmToPx(wall.startY)
          const ex = mmToPx(wall.endX)
          const ey = mmToPx(wall.endY)
          const len = lengthMm(
            { x: wall.startX, y: wall.startY },
            { x: wall.endX, y: wall.endY }
          )
          const midX = (sx + ex) / 2
          const midY = (sy + ey) / 2
          return (
            <Group key={wall.id}>
              <Line points={[sx, sy, ex, ey]} stroke="#ED7D31" strokeWidth={4} />
              <Circle x={sx} y={sy} radius={5} fill="#ED7D31" stroke="white" strokeWidth={2} />
              <Circle x={ex} y={ey} radius={5} fill="#ED7D31" stroke="white" strokeWidth={2} />
              <Text
                x={midX + 8}
                y={midY - 18}
                text={formatMm(len)}
                fontSize={14}
                fill="#C5530A"
                fontStyle="bold"
              />
            </Group>
          )
        })}

        {/* Drawing preview */}
        {drawingMode && startPx && (
          <Group>
            <Circle
              x={startPx.x}
              y={startPx.y}
              radius={5}
              fill="#ED7D31"
              stroke="white"
              strokeWidth={2}
            />
            {mousePx && (
              <>
                <Line
                  points={[startPx.x, startPx.y, mousePx.x, mousePx.y]}
                  stroke="#ED7D31"
                  strokeWidth={3}
                  dash={[6, 4]}
                />
                <Text
                  x={(startPx.x + mousePx.x) / 2 + 8}
                  y={(startPx.y + mousePx.y) / 2 - 18}
                  text={formatMm(
                    lengthMm(
                      { x: pxToMm(startPx.x), y: pxToMm(startPx.y) },
                      { x: pxToMm(mousePx.x), y: pxToMm(mousePx.y) }
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
      </Layer>
    </Stage>
  )
}
