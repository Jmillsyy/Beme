import { useSearchParams } from 'react-router-dom'
import Header from '../components/Header'
import PdfWorkspace from '../components/PdfWorkspace'

export default function BrickEstimatePage() {
  const [searchParams] = useSearchParams()
  const projectId = searchParams.get('id')

  return (
    // h-[calc(100vh/0.88)] + overflow-hidden locks the workspace to a
    // single visual viewport (compensates for `html { zoom: 0.88 }` in
    // index.css). The canvas pan container inside has its own internal
    // scrolling so the PDF pans freely without the page itself ever
    // scrolling — dragging the plan to any edge stays reliable.
    <div className="h-[calc(100vh/0.88)] flex flex-col bg-ink-900 text-ink-50 overflow-hidden">
      <Header />
      <div className="flex-1 min-h-0 relative flex flex-col">
        <PdfWorkspace mode="brick" projectId={projectId} />
      </div>
    </div>
  )
}
