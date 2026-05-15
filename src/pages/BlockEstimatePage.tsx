import { Link, useSearchParams } from 'react-router-dom'
import Header from '../components/Header'
import PdfWorkspace from '../components/PdfWorkspace'

export default function BlockEstimatePage() {
  const [searchParams] = useSearchParams()
  const projectId = searchParams.get('id')

  return (
    <div className="min-h-screen bg-white text-neutral-900">
      <Header />

      <main className="max-w-[1500px] mx-auto px-6 py-8">
        <Link to="/" className="text-sm text-beme-600 hover:text-beme-700 hover:underline">
          ← Back to projects
        </Link>

        <h2 className="text-3xl font-bold mt-3 mb-1">Block Estimate</h2>
        <p className="text-sm text-neutral-600 mb-6 max-w-3xl">
          Define your wall makeups, draw walls over an imported building plan, and let beme auto-tally
          blocks across the project with full corner, T-junction, fraction, and opening logic.
        </p>

        <PdfWorkspace mode="block" projectId={projectId} />
      </main>
    </div>
  )
}
