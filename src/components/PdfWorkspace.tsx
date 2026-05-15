import { useCallback, useState } from 'react'
import { Document, Page, pdfjs } from 'react-pdf'
import 'react-pdf/dist/Page/AnnotationLayer.css'
import 'react-pdf/dist/Page/TextLayer.css'

// Use the matching pdf.js worker from the CDN — version pinned to react-pdf's bundled version
pdfjs.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`

export default function PdfWorkspace() {
  const [pdfFile, setPdfFile] = useState<File | null>(null)
  const [numPages, setNumPages] = useState<number>(0)
  const [currentPage, setCurrentPage] = useState<number>(1)
  const [isDragging, setIsDragging] = useState(false)

  const acceptFile = (file: File | undefined | null) => {
    if (file && file.type === 'application/pdf') {
      setPdfFile(file)
      setCurrentPage(1)
      setNumPages(0)
    }
  }

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    acceptFile(e.target.files?.[0])
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
    acceptFile(e.dataTransfer.files?.[0])
  }, [])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(true)
  }, [])

  const handleDragLeave = useCallback(() => {
    setIsDragging(false)
  }, [])

  if (!pdfFile) {
    return (
      <div
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        className={`border-2 border-dashed rounded-xl p-16 text-center bg-neutral-50 transition-colors ${
          isDragging ? 'border-beme-500 bg-beme-50' : 'border-neutral-300 hover:border-beme-400'
        }`}
      >
        <p className="text-lg text-neutral-700 mb-2 font-medium">Drop your building plan PDF here</p>
        <p className="text-sm text-neutral-500 mb-6">or</p>
        <label className="inline-block px-6 py-3 bg-beme-600 text-white rounded-lg cursor-pointer hover:bg-beme-700 transition-colors font-medium">
          Choose a PDF
          <input
            type="file"
            accept="application/pdf"
            className="hidden"
            onChange={handleFileChange}
          />
        </label>
        <p className="text-xs text-neutral-400 mt-6">
          Multi-page plans are supported. Scale calibration per page is coming next.
        </p>
      </div>
    )
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
        <div>
          <p className="text-sm font-medium text-neutral-700">{pdfFile.name}</p>
          <button
            onClick={() => {
              setPdfFile(null)
              setNumPages(0)
              setCurrentPage(1)
            }}
            className="text-xs text-beme-600 hover:text-beme-700 hover:underline"
          >
            Replace PDF
          </button>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
            disabled={currentPage <= 1}
            className="px-4 py-2 rounded-lg border border-neutral-300 text-sm hover:bg-neutral-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            ← Prev
          </button>
          <span className="text-sm text-neutral-600 tabular-nums min-w-[6rem] text-center">
            Page {currentPage} of {numPages || '…'}
          </span>
          <button
            onClick={() => setCurrentPage((p) => Math.min(numPages, p + 1))}
            disabled={currentPage >= numPages}
            className="px-4 py-2 rounded-lg border border-neutral-300 text-sm hover:bg-neutral-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            Next →
          </button>
        </div>
      </div>

      <div className="border border-neutral-200 rounded-xl overflow-auto bg-neutral-100 flex justify-center p-4 min-h-[400px]">
        <Document
          file={pdfFile}
          onLoadSuccess={({ numPages: n }) => setNumPages(n)}
          loading={<p className="text-neutral-500 p-12">Loading PDF…</p>}
          error={<p className="text-red-600 p-12">Couldn't load that PDF. Is it a valid file?</p>}
        >
          <Page
            pageNumber={currentPage}
            width={Math.min(900, window.innerWidth - 120)}
            renderAnnotationLayer={false}
            renderTextLayer={false}
          />
        </Document>
      </div>
    </div>
  )
}
