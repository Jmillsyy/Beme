import { useSearchParams } from 'react-router-dom'
import LeftNav from '../components/LeftNav'
import PdfWorkspace from '../components/PdfWorkspace'

export default function BrickEstimatePage() {
  const [searchParams] = useSearchParams()
  const projectId = searchParams.get('id')

  return (
    // See BlockEstimatePage for the layout rationale.
    <div className="min-h-screen bg-ink-900 text-ink-50 flex">
      <LeftNav defaultCollapsed />
      <div className="flex-1 min-w-0 pt-3">
        <PdfWorkspace mode="brick" projectId={projectId} />
      </div>
    </div>
  )
}
