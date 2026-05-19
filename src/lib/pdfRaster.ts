/**
 * PDF page rasterisation helper shared between the block and brick exports.
 *
 * Both exports embed a PDF page as the SVG background of their Wall Layout
 * pages so the printed estimate shows the actual plan with the drawn walls
 * overlaid. The rasterisation step is identical for both — render the
 * page to a canvas via pdfjs, then export as a data URL the SVG can use
 * as an <image>.
 *
 * Worker is shared with the workspace's react-pdf instance (configured in
 * PdfWorkspace.tsx at module load), so we don't need to re-init pdfjs here.
 */

import { pdfjs } from 'react-pdf'

/**
 * Rasterise a single page from a PDF file at the given scale factor.
 *
 * Returns a data URL plus the page's intrinsic real-world dimensions (in
 * mm, derived from the PDF's user-space units of 1/72 inch). When the PDF
 * can't be opened, the page number is out of range, or the canvas context
 * isn't available, returns null — the caller renders the wall layout
 * without a background image in that case.
 *
 * `scale = 2` doubles the canvas resolution relative to the PDF's native
 * size, which gives a sharper raster for print export. Higher values
 * trade memory + time for crispness; 2 is a reasonable default for A4.
 */
export async function rasterisePdfPage(
  pdfFile: File,
  pageNumber: number,
  scale = 2
): Promise<{ dataUrl: string; widthMm: number; heightMm: number } | null> {
  try {
    const buffer = await pdfFile.arrayBuffer()
    const pdf = await pdfjs.getDocument({ data: buffer }).promise
    const page = await pdf.getPage(pageNumber)
    const baseViewport = page.getViewport({ scale: 1 })
    const widthMm = (baseViewport.width / 72) * 25.4
    const heightMm = (baseViewport.height / 72) * 25.4

    const renderViewport = page.getViewport({ scale })
    const canvas = document.createElement('canvas')
    canvas.width = Math.floor(renderViewport.width)
    canvas.height = Math.floor(renderViewport.height)
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    // White background — PDF.js renders on transparent by default but
    // most plans assume a white sheet. Without this, dark PDFs would
    // show black through the transparency where there's no ink.
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    // react-pdf's pdfjs typings are loose around the render params shape,
    // so cast through any to keep this building cleanly.
    await page.render({
      canvasContext: ctx,
      viewport: renderViewport,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any).promise
    return { dataUrl: canvas.toDataURL('image/png'), widthMm, heightMm }
  } catch {
    return null
  }
}
