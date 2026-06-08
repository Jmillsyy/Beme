// Verify the modular-fit lintel selector for the AU 200-series library.
// Pretends to know about 20.13 (190mm), 20.25 (290mm), 20.18 (390mm).

const TOLERANCE_MM = 20
const BODY_VERTICAL_MODULE_MM = 200
const LINTELS = [
  { code: '20.13', face: 190, nominal: 200 },
  { code: '20.25', face: 290, nominal: 300 },
  { code: '20.18', face: 390, nominal: 400 },
]

function pick(headMm: number) {
  const fits = LINTELS.filter((l) => l.face <= headMm + TOLERANCE_MM)
  if (fits.length === 0) return { code: 'none', remainder: 0, bodyAbove: 0, waste: headMm }
  let best = fits[0]
  let bestDist = Infinity
  for (const l of fits) {
    const remainder = Math.max(0, headMm - l.face)
    const modulo = remainder % BODY_VERTICAL_MODULE_MM
    const dist = Math.min(modulo, BODY_VERTICAL_MODULE_MM - modulo)
    if (
      dist < bestDist ||
      (dist === bestDist && l.face > best.face)
    ) {
      bestDist = dist
      best = l
    }
  }
  const remainder = Math.max(0, headMm - best.face)
  const bodyAbove = Math.round(remainder / BODY_VERTICAL_MODULE_MM)
  const waste = Math.abs(headMm - (best.face + bodyAbove * BODY_VERTICAL_MODULE_MM))
  return { code: best.code, remainder, bodyAbove, waste }
}

console.log('Head | Pick   | Body courses above | Waste (mm)')
console.log('-----|--------|--------------------|-----------')
for (const head of [100, 150, 200, 250, 300, 400, 500, 600, 700, 800, 900, 1000, 1100, 1200, 1300, 1500, 1700, 1900, 2100]) {
  const r = pick(head)
  console.log(
    String(head).padStart(4) + ' | ' +
    r.code.padEnd(6) + ' | ' +
    String(r.bodyAbove).padStart(3) + ' courses        | ' +
    String(r.waste).padStart(3)
  )
}
