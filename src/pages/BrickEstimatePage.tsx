import { useSearchParams } from 'react-router-dom'
import Header from '../components/Header'
import PdfWorkspace from '../components/PdfWorkspace'

export default function BrickEstimatePage() {
  const [searchParams] = useSearchParams()
  const projectId = searchParams.get('id')

  return (
    // h-[calc(100vh/0.88)] compensates for the global `html { zoom: 0.88 }`
    // in index.css: 100vh × 0.88 = 88% of the visual viewport, which would
    // leave a strip of dead space at the bottom. Dividing 100vh by the
    // zoom factor yields a layout-pixel height that renders as exactly the
    // visual viewport — canvas / thumbnails / rail reach the taskbar.
    // Update both numbers together if the zoom in index.css changes.
    <div className="h-[calc(100vh/0.88)] flex flex-col bg-ink-900 text-ink-50 overflow-hidden">
      <Header />
      <div className="flex-1 min-h-0 relative flex flex-col">
        <PdfWorkspace mode="brick" projectId={projectId} />
      </div>
    </div>
  )
}
