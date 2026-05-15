import { Link } from 'react-router-dom'
import Header from '../components/Header'

export default function BlockEstimatePage() {
  return (
    <div className="min-h-screen bg-white text-neutral-900">
      <Header />

      <main className="max-w-6xl mx-auto px-8 py-12">
        <Link to="/" className="text-sm text-beme-600 hover:text-beme-700 hover:underline">
          ← Back to projects
        </Link>

        <h2 className="text-4xl font-bold mt-4 mb-2">Block Estimate</h2>
        <p className="text-neutral-600 mb-12">
          Define your wall makeups, draw walls over an imported building plan, and let beme auto-tally
          blocks across the project with full corner, T-junction, fraction, and opening logic.
        </p>

        <div className="border-2 border-dashed border-neutral-300 rounded-xl p-16 text-center bg-neutral-50">
          <p className="text-neutral-500">Wall types panel, plan importer, and drawing tools coming soon.</p>
          <p className="text-xs text-neutral-400 mt-2">Next: PDF viewer with scale calibration, then the wall makeup model.</p>
        </div>
      </main>
    </div>
  )
}
