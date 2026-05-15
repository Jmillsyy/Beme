function App() {
  return (
    <div className="min-h-screen bg-white text-neutral-900">
      <header className="border-b border-neutral-200">
        <div className="max-w-6xl mx-auto px-8 py-6 flex items-baseline justify-between">
          <div>
            <h1 className="text-4xl font-bold text-beme-600 tracking-tight">beme</h1>
            <p className="text-sm text-beme-500 italic">Block Estimates Made Easy</p>
          </div>
          <p className="text-xs text-neutral-400">Masonry Estimating · Australia</p>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-8 py-16">
        <h2 className="text-5xl font-bold mb-4">Welcome to beme</h2>
        <p className="text-lg text-neutral-600 max-w-2xl">
          Import a building plan, draw or trace walls, and produce an itemised masonry takeoff in minutes.
        </p>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mt-16">
          <button className="border border-neutral-200 rounded-xl p-8 text-left hover:border-beme-500 hover:shadow-lg transition-all">
            <h3 className="text-2xl font-bold text-beme-600 mb-2">Brick Estimate</h3>
            <p className="text-neutral-600">
              Trace brick walls over a plan, set heights, subtract openings, auto-add lintels and ties.
            </p>
          </button>

          <button className="border border-neutral-200 rounded-xl p-8 text-left hover:border-beme-500 hover:shadow-lg transition-all">
            <h3 className="text-2xl font-bold text-beme-600 mb-2">Block Estimate</h3>
            <p className="text-neutral-600">
              Define wall makeups, draw walls over a plan, auto-tally blocks by code with corners, fractions, and openings.
            </p>
          </button>
        </div>
      </main>
    </div>
  )
}

export default App