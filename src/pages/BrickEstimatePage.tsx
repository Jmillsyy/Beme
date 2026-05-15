import { Link } from 'react-router-dom'
import Header from '../components/Header'
import PdfWorkspace from '../components/PdfWorkspace'

export default function BrickEstimatePage() {
  return (
    <div className="min-h-screen bg-white text-neutral-900">
      <Header />

      <main className="max-w-6xl mx-auto px-8 py-12">
        <Link to="/" className="text-sm text-beme-600 hover:text-beme-700 hover:underline">
          ← Back to projects
        </Link>

        <h2 className="text-4xl font-bold mt-4 mb-2">Brick Estimate</h2>
        <p className="text-neutral-600 mb-12">
          Trace brick walls over an imported building plan, set wall heights, subtract openings,
          and let beme auto-add lintels, brick ties, and plascourse to your takeoff.
        </p>

        <PdfWorkspace />
      </main>
    </div>
  )
}
