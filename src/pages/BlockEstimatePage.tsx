import { useSearchParams } from 'react-router-dom'
import Header from '../components/Header'
import PdfWorkspace from '../components/PdfWorkspace'

export default function BlockEstimatePage() {
  const [searchParams] = useSearchParams()
  const projectId = searchParams.get('id')

  return (
    // Page is taller than the viewport: the Beme header + ProjectBar sit
    // in normal flow above the workspace, and the workspace area inside
    // PdfWorkspace uses `position: sticky` so it stays pinned to the top
    // of the viewport while the header + project bar scroll OFF when the
    // user scrolls down. min-h-[100vh/0.88] is the visual viewport (with
    // html zoom 0.88), so the page is at least viewport-tall and grows
    // by the height of the header + project bar — that's the scroll
    // budget. No overflow-hidden so the scroll actually works.
    <div className="min-h-[calc(100vh/0.88)] bg-ink-900 text-ink-50">
      <Header />
      <PdfWorkspace mode="block" projectId={projectId} />
    </div>
  )
}
