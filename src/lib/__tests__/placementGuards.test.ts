import { describe, it, expect } from 'vitest'
import {
  isPointPlacementValid,
  isOpeningPlacementValid,
  isOverOpening,
  DEFAULT_END_CLEARANCE_MM,
  type PlacementContext,
} from '../placementGuards'

const C = DEFAULT_END_CLEARANCE_MM // 200

function ctx(over: Partial<PlacementContext> = {}): PlacementContext {
  return {
    wallLengthMm: 4000,
    openings: [],
    stepAlongMms: [],
    ...over,
  }
}

describe('isPointPlacementValid (control joint / step)', () => {
  it('accepts a clear mid-wall point', () => {
    expect(isPointPlacementValid(2000, ctx())).toBe(true)
  })

  it('rejects a point crowded against the start end', () => {
    expect(isPointPlacementValid(C - 50, ctx())).toBe(false)
    expect(isPointPlacementValid(0, ctx())).toBe(false)
  })

  it('rejects a point crowded against the far end', () => {
    expect(isPointPlacementValid(4000 - (C - 50), ctx())).toBe(false)
    expect(isPointPlacementValid(4000, ctx())).toBe(false)
  })

  it('rejects a point sitting on an opening (incl. its edges)', () => {
    const c = ctx({ openings: [{ startAlongWallMm: 1000, widthMm: 900 }] })
    expect(isPointPlacementValid(1450, c)).toBe(false) // middle
    expect(isPointPlacementValid(1000, c)).toBe(false) // left edge
    expect(isPointPlacementValid(1900, c)).toBe(false) // right edge
  })

  it('accepts a point just clear of an opening', () => {
    const c = ctx({ openings: [{ startAlongWallMm: 1000, widthMm: 900 }] })
    expect(isPointPlacementValid(800, c)).toBe(true)
    expect(isPointPlacementValid(2100, c)).toBe(true)
  })

  it('rejects a point dropped on top of an existing step', () => {
    const c = ctx({ stepAlongMms: [2000] })
    expect(isPointPlacementValid(2000, c)).toBe(false)
    expect(isPointPlacementValid(2000 + C - 10, c)).toBe(false)
    expect(isPointPlacementValid(2000 + C + 50, c)).toBe(true)
  })
})

describe('isOverOpening', () => {
  const ops = [{ startAlongWallMm: 1000, widthMm: 900 }]
  it('is true inside and at the edges of an opening', () => {
    expect(isOverOpening(1450, ops)).toBe(true)
    expect(isOverOpening(1000, ops)).toBe(true)
    expect(isOverOpening(1900, ops)).toBe(true)
  })
  it('is false clear of every opening', () => {
    expect(isOverOpening(500, ops)).toBe(false)
    expect(isOverOpening(2100, ops)).toBe(false)
    expect(isOverOpening(1450, [])).toBe(false)
  })
})

describe('isOpeningPlacementValid', () => {
  it('accepts a clear mid-wall opening', () => {
    expect(isOpeningPlacementValid(1000, 900, ctx())).toBe(true)
  })

  it('rejects a zero / negative width', () => {
    expect(isOpeningPlacementValid(1000, 0, ctx())).toBe(false)
  })

  it('rejects an opening running into the start end', () => {
    expect(isOpeningPlacementValid(C - 100, 900, ctx())).toBe(false)
  })

  it('rejects an opening running past the far end', () => {
    expect(isOpeningPlacementValid(3000, 900, ctx())).toBe(false) // ends at 3900 > 3800
  })

  it('rejects an opening straddling a height step', () => {
    const c = ctx({ stepAlongMms: [1500] })
    expect(isOpeningPlacementValid(1200, 900, c)).toBe(false) // 1200..2100 crosses 1500
  })

  it('accepts an opening that stops short of a step', () => {
    const c = ctx({ stepAlongMms: [2200] })
    expect(isOpeningPlacementValid(1000, 900, c)).toBe(true) // 1000..1900, step at 2200
  })

  it('rejects an opening overlapping an existing opening', () => {
    const c = ctx({ openings: [{ startAlongWallMm: 1000, widthMm: 900 }] })
    expect(isOpeningPlacementValid(1500, 900, c)).toBe(false) // overlaps
    expect(isOpeningPlacementValid(600, 600, c)).toBe(false) // 600..1200 overlaps left
  })

  it('accepts an opening butting up to but not overlapping another', () => {
    const c = ctx({ openings: [{ startAlongWallMm: 1000, widthMm: 900 }] })
    // 2000..2800: starts exactly at the prior opening's right edge (1900) + gap
    expect(isOpeningPlacementValid(2000, 800, c)).toBe(true)
  })
})

describe('per-end clearance (corner vs free end)', () => {
  it('reserves each end independently', () => {
    // e.g. corner at start (105mm centreline reserves a 200mm tape module),
    // free end (200mm centreline) at the far end.
    const c = ctx({ startClearanceMm: 105, endClearanceMm: 200 })
    expect(isPointPlacementValid(110, c)).toBe(true) // just past start
    expect(isPointPlacementValid(100, c)).toBe(false) // inside start corner
    expect(isPointPlacementValid(3790, c)).toBe(true) // clear of far end (3800)
    expect(isPointPlacementValid(3810, c)).toBe(false) // inside far-end block
  })

  it('applies per-end clearance to openings too', () => {
    const c = ctx({ startClearanceMm: 105, endClearanceMm: 200 })
    expect(isOpeningPlacementValid(110, 800, c)).toBe(true) // 110..910
    expect(isOpeningPlacementValid(100, 800, c)).toBe(false) // starts in start corner
    expect(isOpeningPlacementValid(3000, 805, c)).toBe(false) // ends 3805 > 3800
  })

  it('falls back to clearanceMm when a per-end value is unset', () => {
    const c = ctx({ clearanceMm: 300 })
    expect(isPointPlacementValid(250, c)).toBe(false)
    expect(isPointPlacementValid(350, c)).toBe(true)
  })
})
