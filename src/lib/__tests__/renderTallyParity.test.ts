/**
 * Render <-> tally parity tests.
 *
 * The invariant under test: every block the 3D view renders for a
 * straight block wall is a counted block in the export tally, and
 * vice versa (paired tiles excepted — they are counted but ride hidden
 * inside their host blocks; caps excepted on the layout path — they
 * render as one continuous strip but count per tile).
 */
import { describe, it, expect } from 'vitest'
import type { Wall, WallMakeup, Opening } from '../../types/walls'
import {
  calculateWallTally,
  calculateProjectTally,
  cornerOwnershipFor,
  planWallLayout,
  tallyFromLayout,
  type BlockTally,
} from '../blockCalc'
import { getEffectiveWallThicknessMm } from '../makeups'
import {
  segmentsForStraightWall,
  resolveWallCourses,
  adjustOpeningForRender,
} from '../wallSegments'
import { BLOCK_LIBRARY } from '../../data/blockLibrary'

// ---------- Fixtures ----------

const MAKEUP: WallMakeup = {
  id: 'mk-std',
  name: 'Standard 200 series',
  bondType: 'stretcher',
  heightMm: 2400,
  baseCourseBlockCode: '20.45',
  bodyBlockCode: '20.48',
  topCourseBlockCode: '20.48',
  cornerBlockCode: '20.01',
  halfBlockCode: '20.03',
  useFractions: false,
}

const makeupsById = { [MAKEUP.id]: MAKEUP }

function freeWall(id: string, lengthMm: number): Wall {
  return {
    id,
    makeupId: MAKEUP.id,
    startX: 0,
    startY: 0,
    endX: lengthMm,
    endY: 0,
    startJunction: { type: 'free' },
    endJunction: { type: 'free' },
  }
}

/** 4-wall rectangular box with shared corners (corner junctions). */
function boxWalls(w = 4000, h = 4000): Wall[] {
  const mk = MAKEUP.id
  const j = (ids: string[]) => ({ type: 'corner' as const, connectedWallIds: ids })
  return [
    { id: 'wA', makeupId: mk, startX: 0, startY: 0, endX: w, endY: 0,
      startJunction: j(['wD']), endJunction: j(['wB']) },
    { id: 'wB', makeupId: mk, startX: w, startY: 0, endX: w, endY: h,
      startJunction: j(['wA']), endJunction: j(['wC']) },
    { id: 'wC', makeupId: mk, startX: w, startY: h, endX: 0, endY: h,
      startJunction: j(['wB']), endJunction: j(['wD']) },
    { id: 'wD', makeupId: mk, startX: 0, startY: h, endX: 0, endY: 0,
      startJunction: j(['wC']), endJunction: j(['wA']) },
  ]
}

function window_(wallId: string, startMm: number, wMm: number, hMm: number, sillMm: number, id = 'op1'): Opening {
  return {
    id,
    wallId,
    startAlongWallMm: startMm,
    widthMm: wMm,
    heightMm: hMm,
    sillHeightMm: sillMm,
    kind: 'window',
  }
}

function thicknessMap(walls: Wall[]): Record<string, number> {
  const m: Record<string, number> = {}
  for (const w of walls) m[w.id] = getEffectiveWallThicknessMm(MAKEUP, BLOCK_LIBRARY)
  return m
}

function wallsByIdMap(walls: Wall[]): Record<string, Wall> {
  const m: Record<string, Wall> = {}
  for (const w of walls) m[w.id] = w
  return m
}

/** Enumerate the boxes the 3D renderer would draw for a straight wall
 *  (the openings path), and count them by code. */
function renderedBoxTally(
  wall: Wall,
  openings: Opening[],
  walls: Wall[],
  withOwnership: boolean
): BlockTally {
  const thicknessByWallId = thicknessMap(walls)
  const wallsById = wallsByIdMap(walls)
  const { courses, totalHeightM } = resolveWallCourses(wall, makeupsById, BLOCK_LIBRARY)
  const wallHeightMm = wall.heightMmOverride ?? MAKEUP.heightMm
  const adjusted = openings
    .filter((o) => o.wallId === wall.id)
    .map((o) => adjustOpeningForRender(o, wallHeightMm))
  const boxes = segmentsForStraightWall(
    wall, adjusted, thicknessByWallId[wall.id], courses, totalHeightM,
    'stretcher', new Map(), BLOCK_LIBRARY, thicknessByWallId, wallsById,
    false, undefined, undefined,
    withOwnership ? cornerOwnershipFor(wall, wallsById) : () => true
  )
  const tally: BlockTally = {}
  for (const b of boxes) {
    if (!b.code) continue
    tally[b.code] = (tally[b.code] ?? 0) + 1
  }
  return tally
}

function total(t: BlockTally): number {
  return Object.values(t).reduce((s, n) => s + (n ?? 0), 0)
}

const PAIRED_CODES = new Set(
  Object.values(BLOCK_LIBRARY)
    .map((b) => b.pairedWith)
    .filter((c): c is string => !!c)
)

// ---------- Tests ----------

describe('opening walls: tally === rendered boxes (+ paired tiles)', () => {
  it('free wall with one window', () => {
    const wall = freeWall('w1', 4800)
    const op = window_('w1', 1800, 1200, 1200, 900)
    const tally = calculateWallTally(wall, MAKEUP, [op], thicknessMap([wall]), wallsByIdMap([wall]))
    const rendered = renderedBoxTally(wall, [op], [wall], false)
    // Every non-paired code must match the rendered box count exactly.
    const codes = new Set([...Object.keys(tally), ...Object.keys(rendered)])
    for (const code of codes) {
      if (PAIRED_CODES.has(code)) continue
      expect({ code, n: tally[code] ?? 0 }).toEqual({ code, n: rendered[code] ?? 0 })
    }
  })

  it('two close openings (narrow pier) still match', () => {
    const wall = freeWall('w1', 6000)
    const ops = [
      window_('w1', 1200, 1200, 1200, 900, 'op1'),
      window_('w1', 2800, 1200, 1200, 900, 'op2'), // 400mm pier between
    ]
    const tally = calculateWallTally(wall, MAKEUP, ops, thicknessMap([wall]), wallsByIdMap([wall]))
    const rendered = renderedBoxTally(wall, ops, [wall], false)
    for (const code of new Set([...Object.keys(tally), ...Object.keys(rendered)])) {
      if (PAIRED_CODES.has(code)) continue
      expect({ code, n: tally[code] ?? 0 }).toEqual({ code, n: rendered[code] ?? 0 })
    }
  })

  it('door forces sill to 0 in both render and tally', () => {
    const wall = freeWall('w1', 4800)
    const door: Opening = { ...window_('w1', 1800, 900, 2100, 500), kind: 'door' }
    const tallyA = calculateWallTally(wall, MAKEUP, [door], thicknessMap([wall]), wallsByIdMap([wall]))
    const tallyB = calculateWallTally(wall, MAKEUP, [{ ...door, sillHeightMm: 0 }], thicknessMap([wall]), wallsByIdMap([wall]))
    expect(tallyA).toEqual(tallyB)
  })

  it('window sill auto-anchors to head 300mm below wall top', () => {
    const wall = freeWall('w1', 4800)
    // 2400 wall, 1200 window -> rendered sill = 2400-300-1200 = 900
    const atUserSill = calculateWallTally(wall, MAKEUP, [window_('w1', 1800, 1200, 1200, 500)], thicknessMap([wall]), wallsByIdMap([wall]))
    const atRenderSill = calculateWallTally(wall, MAKEUP, [window_('w1', 1800, 1200, 1200, 900)], thicknessMap([wall]), wallsByIdMap([wall]))
    expect(atUserSill).toEqual(atRenderSill)
  })
})

describe('project totals: corners deduplicated like the render', () => {
  it('4-wall box, no openings: exactly one corner block per corner per course', () => {
    const walls = boxWalls()
    const tally = calculateProjectTally(walls, makeupsById)
    // 2400mm = 12 courses; 4 corners; one 20.01 per corner per course.
    expect(tally['20.01']).toBe(4 * 12)
  })

  it('4-wall box with a window on one wall: corner count unchanged', () => {
    const walls = boxWalls()
    const op = window_('wA', 1400, 1200, 1200, 900)
    const tally = calculateProjectTally(walls, makeupsById, [op])
    expect(tally['20.01']).toBeGreaterThanOrEqual(4 * 12)
    // The window adds jamb columns (full 20.01 on odd courses): the
    // corner contribution itself must stay 48 — verify by subtracting
    // the no-window jamb-free project and an isolated-wall delta.
    const noOp = calculateProjectTally(walls, makeupsById)
    const free = freeWall('iso', 4000 + 190) // same outer length as wA
    const isoNoOp = calculateWallTally(free, MAKEUP, [], { iso: 190 }, { iso: free })
    const isoOp = calculateWallTally(free, MAKEUP, [window_('iso', 1400, 1200, 1200, 900)], { iso: 190 }, { iso: free })
    // Corner-block delta caused by the window on an isolated wall:
    const jambDelta = (isoOp['20.01'] ?? 0) - (isoNoOp['20.01'] ?? 0)
    expect((tally['20.01'] ?? 0) - (noOp['20.01'] ?? 0)).toBe(jambDelta)
  })

  it('project tally equals the sum of per-wall render enumerations', () => {
    const walls = boxWalls()
    const op = window_('wA', 1400, 1200, 1200, 900)
    const project = calculateProjectTally(walls, makeupsById, [op])

    const thicknessByWallId = thicknessMap(walls)
    const wallsById = wallsByIdMap(walls)
    const summed: BlockTally = {}
    const add = (t: BlockTally) => {
      for (const [c, n] of Object.entries(t)) summed[c] = (summed[c] ?? 0) + (n ?? 0)
    }
    for (const wall of walls) {
      if (wall.id === 'wA') {
        add(renderedBoxTally(wall, [op], walls, true))
      } else {
        // No openings: the 3D renders planWallLayout's positioned blocks.
        const layout = planWallLayout(wall, MAKEUP, [], thicknessByWallId, wallsById, cornerOwnershipFor(wall, wallsById))
        add(tallyFromLayout(layout))
      }
    }
    for (const code of new Set([...Object.keys(project), ...Object.keys(summed)])) {
      if (PAIRED_CODES.has(code)) continue
      expect({ code, n: project[code] ?? 0 }).toEqual({ code, n: summed[code] ?? 0 })
    }
  })

  it('blocks with a window are fewer than without', () => {
    const walls = boxWalls()
    const op = window_('wA', 1400, 1800, 1200, 900)
    const withOp = calculateProjectTally(walls, makeupsById, [op])
    const noOp = calculateProjectTally(walls, makeupsById)
    expect(total(withOp)).toBeLessThan(total(noOp))
  })
})
