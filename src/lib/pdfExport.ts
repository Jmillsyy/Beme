/**
 * HTML → PDF download helper.
 *
 * Opens the styled export HTML in a new tab. A small floating button at the
 * top of the page triggers `window.print()` so the user gets the browser's
 * native print dialog where they can pick "Save as PDF" (or send to a real
 * printer). The button is `@media print { display: none }`-d so it doesn't
 * end up in the output.
 *
 * This is intentionally a two-step flow rather than an auto-print:
 *
 *   - The user can scroll through the preview and confirm everything looks
 *     right before committing to a print.
 *   - The tab stays open after printing — useful for re-printing, copying
 *     numbers out of the schedule, or sharing the URL during a phone call.
 *   - No race between page-render-ready and auto-trigger-print (which
 *     previously caused fonts to fall back to system defaults on Chrome).
 *
 * Why not html2pdf.js / jsPDF? Three earlier attempts produced either blank
 * pages or unstyled text dumps. Those libraries can't read computed styles
 * consistently across iframes / scoped stylesheets, and rasterised output
 * makes block codes uncopyable. The browser's native print engine produces
 * a true vector PDF with selectable text and identical layout to the
 * preview — that's worth the extra click.
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
 * Open the styled HTML in a new tab. The page renders with a small "Print
 * / Save as PDF" button floating in the top right corner; clicking it (or
 * pressing Cmd+P / Ctrl+P) triggers the browser's print dialog. The tab
 * stays open after printing so the user can re-print or close it manually.
 *
 * Resolves once the new window has been written; rejects if a pop-up
 * blocker stops the open.
 */
export async function downloadPdfFromHtml({ html, filename }: PdfDownloadOptions): Promise<void> {
  const baseName = filename.replace(/\.pdf$/i, '')

  const win = window.open('', '_blank')
  if (!win) {
    throw new Error('Pop-up blocked — allow pop-ups for this site and try again.')
  }

  // Inject:
  //   - the project title (becomes the print dialog's default filename)
  //   - a small fixed-position print button + the @media-print CSS to hide
  //     it from the printed output
  //   - a Cmd+P keyboard hint so the user knows they don't have to use the
  //     button if they don't want to
  const withTitle = ensureTitle(html, baseName)
  const printButtonHtml = `
    <style>
      .beme-print-cta {
        position: fixed;
        top: 16px;
        right: 16px;
        z-index: 9999;
        background: #ff7a2d;
        color: #0e0e10;
        font-family: Inter, system-ui, sans-serif;
        font-weight: 600;
        font-size: 14px;
        padding: 10px 16px;
        border: none;
        border-radius: 8px;
        cursor: pointer;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
      }
      .beme-print-cta:hover {
        background: #ed6d1a;
      }
      .beme-print-hint {
        position: fixed;
        top: 60px;
        right: 16px;
        z-index: 9999;
        font-family: Inter, system-ui, sans-serif;
        font-size: 11px;
        color: #6d717a;
        text-align: right;
        max-width: 200px;
        line-height: 1.4;
      }
      @media print {
        .beme-print-cta, .beme-print-hint { display: none !important; }
      }
    </style>
  `
  const printButtonScript = `
    <button class="beme-print-cta" onclick="window.print()">
      Print / Save as PDF
    </button>
    <div class="beme-print-hint">
      or press Cmd&nbsp;+&nbsp;P / Ctrl&nbsp;+&nbsp;P<br/>
      <span style="font-size: 10px; opacity: 0.85;">
        In the print dialog, uncheck&nbsp;<em>Headers&nbsp;and&nbsp;footers</em>
        for the cleanest output.
      </span>
    </div>
  `
  const finalHtml = withTitle
    .replace(/<\/head>/i, `${printButtonHtml}</head>`)
    .replace(/<body([^>]*)>/i, `<body$1>${printButtonScript}`)

  win.document.open()
  win.document.write(finalHtml)
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
