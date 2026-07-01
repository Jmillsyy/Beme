import { describe, it, expect } from 'vitest'
import { openingHardAgainstEnd } from '../openingCorner'

// 4000mm wall; threshold 300 (e.g. a 200-series corner module ~200 plus
// part of a body block).
const LEN = 4000
const T = 300

describe('openingHardAgainstEnd', () => {
  it('is true when an opening starts right at the start corner', () => {
    const ops = [{ startAlongWallMm: 200, widthMm: 900 }]
    expect(openingHardAgainstEnd('start', LEN, ops, T)).toBe(true)
    expect(openingHardAgainstEnd('end', LEN, ops, T)).toBe(false)
  })

  it('is true when an opening runs up to the end corner', () => {
    const ops = [{ startAlongWallMm: 2900, widthMm: 900 }] // ends at 3800
    expect(openingHardAgainstEnd('end', LEN, ops, T)).toBe(true)
    expect(openingHardAgainstEnd('start', LEN, ops, T)).toBe(false)
  })

  it('is false for an opening that leaves room for a body block at each end', () => {
    const ops = [{ startAlongWallMm: 1000, widthMm: 900 }] // 1000..1900
    expect(openingHardAgainstEnd('start', LEN, ops, T)).toBe(false)
    expect(openingHardAgainstEnd('end', LEN, ops, T)).toBe(false)
  })

  it('checks every opening on the wall', () => {
    const ops = [
      { startAlongWallMm: 1500, widthMm: 600 },
      { startAlongWallMm: 250, widthMm: 800 }, // this one is hard against start
    ]
    expect(openingHardAgainstEnd('start', LEN, ops, T)).toBe(true)
  })

  it('is false with no openings', () => {
    expect(openingHardAgainstEnd('start', LEN, [], T)).toBe(false)
    expect(openingHardAgainstEnd('end', LEN, [], T)).toBe(false)
  })
})
