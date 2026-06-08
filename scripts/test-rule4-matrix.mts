const MORTAR = 10
const FRACTIONS_200 = [{ code: '20.03', modular: 200 }, { code: '20.02', modular: 300 }]
const FRACTIONS_300 = [{ code: '30.03', modular: 300 }, { code: '30.02', modular: 400 }]

interface Fit { bodyCount: number; fractions: number; cuts: number; actualLengthMm: number }

function fitCourseLength(wallLengthMm: number, endsTotalModular: number, bodyModular: number, fractions: Array<{ code: string; modular: number }>, useFractions = true): Fit {
  const targetTotal = wallLengthMm + MORTAR
  if (targetTotal - endsTotalModular <= 0) return { bodyCount: 0, fractions: 0, cuts: 0, actualLengthMm: Math.max(endsTotalModular - MORTAR, 0) }
  const TINY = 30
  const nFloor = Math.max(0, Math.floor((targetTotal - endsTotalModular) / bodyModular))
  const baseModular = endsTotalModular + nFloor * bodyModular
  const baseActual = baseModular - MORTAR
  const gap = wallLengthMm - baseActual
  if (gap <= TINY) return { bodyCount: nFloor, fractions: 0, cuts: 0, actualLengthMm: baseActual }
  if (useFractions) {
    let best: { code: string; modular: number } | null = null
    for (const f of fractions) {
      if (f.modular - MORTAR > gap + 20) continue
      if (!best || f.modular > best.modular) best = f
    }
    if (best) return { bodyCount: nFloor, fractions: 1, cuts: 0, actualLengthMm: baseActual + best.modular }
  }
  return { bodyCount: nFloor + 1, fractions: 0, cuts: 1, actualLengthMm: baseActual + bodyModular }
}

interface Series { label: string; fullEndModular: number; halfEndModular: number; bodyModular: number; fractions: Array<{ code: string; modular: number }> }
const SERIES: Series[] = [
  { label: '200', fullEndModular: 400, halfEndModular: 200, bodyModular: 400, fractions: FRACTIONS_200 },
  { label: '300', fullEndModular: 500, halfEndModular: 300, bodyModular: 500, fractions: FRACTIONS_300 },
]

function planEnd(isCorner: boolean, s: Series) {
  if (isCorner) return { oddModular: s.fullEndModular, evenModular: s.fullEndModular }
  return { oddModular: s.fullEndModular, evenModular: s.halfEndModular }
}

interface Scenario { lengthMm: number; startIsCorner: boolean; endIsCorner: boolean; ownsC1: boolean; series: Series }

function decide(s: Scenario) {
  const startEnd = planEnd(s.startIsCorner, s.series)
  const endEnd = planEnd(s.endIsCorner, s.series)
  const cubeMod = 200
  const flipTarget: 'start' | 'end' | null = !s.endIsCorner ? 'end' : !s.startIsCorner ? 'start' : null
  const ownsC2 = s.startIsCorner || s.endIsCorner ? !s.ownsC1 : true

  function startMod(arrangement: 'sync' | 'inv', isOdd: boolean, owns: boolean): number {
    if (s.startIsCorner) return owns ? startEnd.oddModular : cubeMod
    const flipped = arrangement === 'inv' && flipTarget === 'start'
    return flipped ? (isOdd ? startEnd.evenModular : startEnd.oddModular) : (isOdd ? startEnd.oddModular : startEnd.evenModular)
  }
  function endMod(arrangement: 'sync' | 'inv', isOdd: boolean, owns: boolean): number {
    if (s.endIsCorner) return owns ? endEnd.oddModular : cubeMod
    const flipped = arrangement === 'inv' && flipTarget === 'end'
    return flipped ? (isOdd ? endEnd.evenModular : endEnd.oddModular) : (isOdd ? endEnd.oddModular : endEnd.evenModular)
  }
  function evalArr(arrangement: 'sync' | 'inv') {
    const c1Ends = startMod(arrangement, true, s.ownsC1) + endMod(arrangement, true, s.ownsC1)
    const c2Ends = startMod(arrangement, false, ownsC2) + endMod(arrangement, false, ownsC2)
    const c1Fit = fitCourseLength(s.lengthMm, c1Ends, s.series.bodyModular, s.series.fractions)
    const c2Fit = fitCourseLength(s.lengthMm, c2Ends, s.series.bodyModular, s.series.fractions)
    const total = c1Fit.fractions + c1Fit.cuts + c2Fit.fractions + c2Fit.cuts
    return { arrangement, c1Fit, c2Fit, total }
  }
  const sync = evalArr('sync')
  if (flipTarget === null) return sync
  const inv = evalArr('inv')
  if (inv.total < sync.total) return inv
  if (inv.total === sync.total) {
    const sg = Math.max(Math.abs(s.lengthMm - sync.c1Fit.actualLengthMm), Math.abs(s.lengthMm - sync.c2Fit.actualLengthMm))
    const ig = Math.max(Math.abs(s.lengthMm - inv.c1Fit.actualLengthMm), Math.abs(s.lengthMm - inv.c2Fit.actualLengthMm))
    if (ig < sg) return inv
  }
  return sync
}

const LENGTHS = [400, 800, 1000, 1200, 1400, 1600, 1800, 2000, 2400, 2800, 3000, 3400, 4000, 4400, 4800]
const PAIRS: Array<[boolean, boolean, string]> = [[false, false, 'free+free'], [true, false, 'corner+free'], [false, true, 'free+corner'], [true, true, 'corner+corner']]

let total = 0, clean = 0
const dirty: string[] = []

for (const series of SERIES) {
  console.log('\n=== ' + series.label + '-series (body modular ' + series.bodyModular + 'mm) ===\n')
  for (const [si, ei, label] of PAIRS) {
    const ownerPerms: boolean[] = (si || ei) ? [true, false] : [true]
    for (const owns of ownerPerms) {
      const ownerSuffix = (si || ei) ? (owns ? ' (own)' : ' (other)') : ''
      console.log(label + ownerSuffix + ':')
      for (const len of LENGTHS) {
        const d = decide({ lengthMm: len, startIsCorner: si, endIsCorner: ei, ownsC1: owns, series })
        const isClean = d.total === 0
        total++
        if (isClean) clean++
        else dirty.push(series.label + ' ' + len + 'mm ' + label + (si || ei ? (owns ? ' own' : ' other') : '') + ' ' + d.arrangement + ' frac=' + d.total)
        const marker = isClean ? '✓' : '✗'
        console.log('  ' + String(len).padStart(4) + 'mm  ' + d.arrangement.toUpperCase() + '  C1:' + d.c1Fit.bodyCount + 'b+' + d.c1Fit.fractions + 'f+' + d.c1Fit.cuts + 'c  C2:' + d.c2Fit.bodyCount + 'b+' + d.c2Fit.fractions + 'f+' + d.c2Fit.cuts + '  ' + marker)
      }
    }
  }
}

console.log('\n=== SUMMARY ===')
console.log(clean + '/' + total + ' clean (no fractions, no cuts)')
if (dirty.length > 0) {
  console.log('\nDirty cases:')
  for (const d of dirty) console.log('  ' + d)
}
