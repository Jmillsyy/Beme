/**
 * Viewport-region PDF rendering — the "sharp at any zoom" path.
 *
 * The workspace rasterises the WHOLE page at capped zoom stops (see
 * MAX_RENDERED_ZOOM in PdfWorkspace) because a full-page canvas at deep
 * zoom would be enormous. Above that cap the page canvas is CSS-
 * stretched and goes soft. This module renders just the VISIBLE crop of
 * a page at the true target resolution into a viewport-sized canvas —
 * constant memory regardless of zoom depth, the way Bluebeam / PlanSwift
 * stay sharp.
 *
 * Documents are cached per File (WeakMap) so repeated crops after pans /
 * zooms skip the parse; render tasks are cancellable so a superseded
 * crop never paints over a newer one.
 */
import { pdfjs } from 'react-pdf'

interface PdfPageLike {
  getViewport(params: {
    scale: number
    offsetX?: number
    offsetY?: number
  }): { width: number; height: number }
  render(params: unknown): { promise: Promise<unknown>; cancel(): void }
}
interface PdfDocLike {
  getPage(n: number): Promise<PdfPageLike>
}

const docCache = new WeakMap<File, Promise<PdfDocLike>>()

function getDoc(file: File): Promise<PdfDocLike> {
  let cached = docCache.get(file)
  if (!cached) {
    cached = file
      .arrayBuffer()
      .then(
        (buf) =>
          pdfjs.getDocument({ data: buf }).promise as unknown as PdfDocLike
      )
    docCache.set(file, cached)
  }
  return cached
}

export interface PdfRegionRequest {
  file: File
  pageNumber: number
  /** Crop origin within the page, in zoomed-page CSS px (the page laid
   *  out at `zoomedPageWidthPx` wide). */
  cropX: number
  cropY: number
  /** Crop size in zoomed-page CSS px (normally the viewport size). */
  cropW: number
  cropH: number
  /** Full page width at the target zoom, in CSS px. */
  zoomedPageWidthPx: number
  /** Device pixel ratio multiplier for the canvas backing store. */
  dpr: number
  canvas: HTMLCanvasElement
}

export interface PdfRegionTask {
  cancel(): void
  /** Resolves true when the crop painted, false if cancelled/failed. */
  done: Promise<boolean>
}

export function renderPdfRegion(req: PdfRegionRequest): PdfRegionTask {
  let cancelled = false
  let renderTask: { cancel(): void } | null = null
  const done = (async (): Promise<boolean> => {
    try {
      const doc = await getDoc(req.file)
      if (cancelled) return false
      const page = await doc.getPage(req.pageNumber)
      if (cancelled) return false
      const base = page.getViewport({ scale: 1 })
      if (base.width <= 0) return false
      const scale = (req.zoomedPageWidthPx / base.width) * req.dpr
      const viewport = page.getViewport({
        scale,
        offsetX: -req.cropX * req.dpr,
        offsetY: -req.cropY * req.dpr,
      })
      const canvas = req.canvas
      canvas.width = Math.max(1, Math.round(req.cropW * req.dpr))
      canvas.height = Math.max(1, Math.round(req.cropH * req.dpr))
      const ctx = canvas.getContext('2d')
      if (!ctx) return false
      // White sheet under the ink — matches the base <Page> render so
      // the overlay is indistinguishable apart from sharpness.
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      const task = page.render({ canvasContext: ctx, viewport })
      renderTask = task
      await task.promise
      return !cancelled
    } catch {
      // RenderingCancelledException lands here — treated as "didn't paint".
      return false
    }
  })()
  return {
    cancel() {
      cancelled = true
      renderTask?.cancel()
    },
    done,
  }
}
