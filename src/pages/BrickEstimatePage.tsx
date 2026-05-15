import { Link } from 'react-router-dom'
import Header from '../components/Header'

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

        <div className="border-2 border-dashed border-neutral-300 rounded-xl p-16 text-center bg-neutral-50">
          <p className="text-neutral-500">Plan importer and tracing tools coming soon.</p>
          <p className="text-xs text-neutral-400 mt-2">Next: PDF viewer with scale calibration.</p>
        </div>
      </main>
    </div>
  )
}
