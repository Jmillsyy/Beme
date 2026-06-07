// Verify wall-aware lintel selection.
const TOLERANCE_MM = 20
const BODY = 200
const LINTELS = [
  { code: '20.13', face: 190, nominal: 200 },
  { code: '20.25', face: 290, nominal: 300 },
  { code: '20.18', face: 390, nominal: 400 },
]

function computeDistance(remainder: number, extras: number[]): number {
  let minDist = Infinity
  const masks = 1 << extras.length
  for (let mask = 0; mask < masks; mask++) {
    let sumExtras = 0
    for (let i = 0; i < extras.length; i++) {
      if (mask & (1 << i)) sumExtras += extras[i]
    }
    const after = remainder - sumExtras
    if (after < -BODY) continue
    const mod = ((after % BODY) + BODY) % BODY
    const d = Math.min(mod, BODY - mod)
    if (d < minDist) minDist = d
  }
  return minDist
}

function pick(head: number, extras: number[]): string {
  const fits = LINTELS.filter((l) => l.face <= head + TOLERANCE_MM)
  if (fits.length === 0) return 'none'
  let best = fits[0]
  let bestD = Infinity
  for (const l of fits) {
    const r = Math.max(0, head - l.face)
    const d = computeDistance(r, extras)
    if (d < bestD || (d === bestD && l.face > best.face)) {
      bestD = d
      best = l
    }
  }
  return best.code
}

const SCENARIOS = [
  { head: 300, extras: [] as number[], desc: 'standard wall' },
  { head: 1500, extras: [] as number[], desc: 'standard wall' },
  { head: 1500, extras: [100], desc: '20.71 makeup in head' },
  { head: 1500, extras: [150], desc: '20.140 makeup in head' },
  { head: 900, extras: [100], desc: '20.71 in head' },
  { head: 900, extras: [150], desc: '20.140 in head' },
  { head: 600, extras: [100], desc: '20.71 in head' },
  { head: 400, extras: [100], desc: '20.71 in head' },
]
console.log('Head | Extras       | Pick')
console.log('-----|--------------|------')
for (const s of SCENARIOS) {
  console.log(
    String(s.head).padStart(4) + ' | ' +
    (s.extras.length ? '[' + s.extras.join(',') + '] ' + s.desc : 'none           ').padEnd(28) + '| ' +
    pick(s.head, s.extras)
  )
}
