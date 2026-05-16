/**
 * HTML → PDF download helper.
 *
 * Uses the browser's native print engine via `window.print()` after opening
 * the styled export HTML in a new tab. Three attempts at html2pdf.js +
 * html2canvas all produced either blank pages or unstyled text dumps — the
 * library can't read computed styles consistently across iframes / scoped
 * stylesheets, and rasterised output makes block codes uncopyable anyway.
 *
 * The print-engine path is rock solid:
 *
 *   - Browser renders the HTML with its real layout engine. Every CSS rule
 *     applies exactly the way it did in the preview, including the orange
 *     brand colours, page breaks, mm-based padding, the works.
 *   - Output is a true vector PDF with selectable text.
 *   - Filename comes from the document title — we set that to the project
 *     name so "Save as PDF" defaults to a sensible name.
 *   - Works identically in Chrome, Safari, Firefox, Edge.
 *
 * Trade-off: one extra click in the print dialog vs a true one-click download.
 * We accept this for the reliability + selectable text wins.
 */

export interface PdfDownloadOptions {
  /** Full `<!DOCTYPE html>…</html>` document built by the export module. */
  html: string
  /**
   * Filename without extension. Becomes the document title in the print
   * dialog, which most browsers use as the default save filename.
   */
  filename: string
}

/**
 * Open the styled HTML in a new tab and auto-trigger the print dialog.
 * Resolves once the new window has been written; rejects if a pop-up blocker
 * stops the open.
 *
 * The user then picks "Save as PDF" (or any other print destination) in the
 * native print dialog.
 */
export async function downloadPdfFromHtml({ html, filename }: PdfDownloadOptions): Promise<void> {
  const baseName = filename.replace(/\.pdf$/i, '')

  const win = window.open('', '_blank')
  if (!win) {
    throw new Error('Pop-up blocked — allow pop-ups for this site and try again.')
  }

  // Inject the project title, an auto-print script, and an auto-close hook
  // just before </body>. The 200ms delay gives fonts and any images a moment
  // to load before the print dialog opens; without it Chrome sometimes prints
  // with system-font fallbacks instead of Inter.
  //
  // window.onafterprint fires after the user either saves or cancels — we
  // close the tab so the user isn't left with the preview hanging around.
  // Browsers only allow window.close() on tabs that were opened by script,
  // which this one was, so it works in Chrome / Edge / Firefox. Safari
  // ignores it but no harm done — user closes the tab themselves.
  const withTitle = ensureTitle(html, baseName)
  const withAutoPrint = withTitle.replace(
    /<\/body>/i,
    `
    <script>
      (function () {
        function go() {
          window.focus();
          window.print();
        }
        window.addEventListener('afterprint', function () {
          // Slight delay so the save flow finishes before we yank the tab.
          setTimeout(function () { window.close(); }, 100);
        });
        // Wait for fonts (best effort) + a short delay so layout has settled.
        if (document.fonts && document.fonts.ready && typeof document.fonts.ready.then === 'function') {
          document.fonts.ready.then(function () { setTimeout(go, 200); });
        } else {
          window.addEventListener('load', function () { setTimeout(go, 200); });
        }
      })();
    </script>
    </body>`
  )

  win.document.open()
  win.document.write(withAutoPrint)
  win.document.close()
}

/** Replace or insert a `<title>` element so the print dialog uses it. */
function ensureTitle(html: string, title: string): string {
  const escaped = escapeHtmlText(title)
  if (/<title>[\s\S]*?<\/title>/i.test(html)) {
    return html.replace(/<title>[\s\S]*?<\/title>/i, `<title>${escaped}</title>`)
  }
  return html.replace(/<head[^>]*>/i, (m) => `${m}<title>${escaped}</title>`)
}

function escapeHtmlText(s: string): string {
  return s.replace(/[<>&"']/g, (c) => {
    switch (c) {
      case '<':
        return '&lt;'
      case '>':
        return '&gt;'
      case '&':
        return '&amp;'
      case '"':
        return '&quot;'
      case "'":
        return '&#039;'
      default:
        return c
    }
  })
}
