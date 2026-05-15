import { Link } from 'react-router-dom'

export default function Header() {
  return (
    <header className="border-b border-neutral-200">
      <div className="max-w-6xl mx-auto px-8 py-6 flex items-baseline justify-between">
        <Link to="/" className="block hover:opacity-80 transition-opacity">
          <h1 className="text-4xl font-bold text-beme-600 tracking-tight">beme</h1>
          <p className="text-sm text-beme-500 italic">Block Estimates Made Easy</p>
        </Link>
        <p className="text-xs text-neutral-400">Masonry Estimating · Australia</p>
      </div>
    </header>
  )
}
