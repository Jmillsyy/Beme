import { useSearchParams } from 'react-router-dom'
import Header from '../components/Header'
import PdfWorkspace from '../components/PdfWorkspace'

export default function BrickEstimatePage() {
  const [searchParams] = useSearchParams()
  const projectId = searchParams.get('id')

  return (
    <div className="min-h-screen bg-ink-900 text-ink-50">
      <Header />
      <PdfWorkspace mode="brick" projectId={projectId} />
    </div>
  )
}
