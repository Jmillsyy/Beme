/**
 * Single-source foundation: the estimate, counted FROM the render's
 * positioned blocks (tallyFromRenderBoxes), must equal today's trusted
 * calculateProjectTally - exactly, including paired tiles. This is what
 * lets us later switch the estimate to count the render's output, so the
 * 3D and the estimate can never diverge.
 */
import { describe, it, expect } from 'vitest'
import type { Wall, WallMakeup, Opening, BlockTally } from '../../types/walls'
import { calculateProjectTally, cornerOwnershipFor } from '../blockCalc'
import { getEffectiveWallThicknessMm } from '../makeups'
import {
  segmentsForStraightWall,
  resolveWallCourses,
  adjustOpeningForRender,
  tallyFromRenderBoxes,
} from '../wallSegments'
import { BLOCK_LIBRARY } from '../../data/blockLibrary'

const MAKEUP: WallMakeup = {
  id: 'mk', name: 'std', bondType: 'stretcher', heightMm: 2400,
  baseCourseBlockCode: '20.45', bodyBlockCode: '20.48', topCourseBlockCode: '20.48',
  cornerBlockCode: '20.01', halfBlockCode: '20.03', useFractions: false,
}
const makeupsById = { mk: MAKEUP }
const T = getEffectiveWallThicknessMm(MAKEUP, BLOCK_LIBRARY)

function boxWalls(w = 4000, h = 4000): Wall[] {
  const j = (ids: string[]) => ({ type: 'corner' as const, connectedWallIds: ids })
  return [
    { id: 'wA', makeupId: 'mk', startX: 0, startY: 0, endX: w, endY: 0, startJunction: j(['wD']), endJunction: j(['wB']) },
    { id: 'wB', makeupId: 'mk', startX: w, startY: 0, endX: w, endY: h, startJunction: j(['wA']), endJunction: j(['wC']) },
    { id: 'wC', makeupId: 'mk', startX: w, startY: h, endX: 0, endY: h, startJunction: j(['wB']), endJunction: j(['wD']) },
    { id: 'wD', makeupId: 'mk', startX: 0, startY: h, endX: 0, endY: 0, startJunction: j(['wC']), endJunction: j(['wA']) },
  ]
}
function win(wallId: string, startMm: number): Opening {
  return { id: 'op', wallId, startAlongWallMm: startMm, widthMm: 1200, heightMm: 1200, sillHeightMm: 900, kind: 'window' }
}
function projectRenderTally(walls: Wall[], openings: Opening[]): BlockTally {
  const thick: Record<string, number> = {}; walls.forEach((w) => (thick[w.id] = T))
  const byId: Record<string, Wall> = {}; walls.forEach((w) => (byId[w.id] = w))
  const summed: BlockTally = {}
  for (const wall of walls) {
    const { courses, totalHeightM } = resolveWallCourses(wall, makeupsById, BLOCK_LIBRARY)
    const adj = openings.filter((o) => o.wallId === wall.id).map((o) => adjustOpeningForRender(o, MAKEUP.heightMm))
    const boxes = segmentsForStraightWall(
      wall, adj, T, courses, totalHeightM, 'stretcher', new Map(), BLOCK_LIBRARY, thick, byId,
      false, undefined, undefined, cornerOwnershipFor(wall, byId, thick), 0.01,
    )
    const t = tallyFromRenderBoxes(boxes, BLOCK_LIBRARY)
    for (const [c, n] of Object.entries(t)) summed[c] = (summed[c] ?? 0) + (n ?? 0)
  }
  return summed
}

function expectEqualTallies(a: BlockTally, b: BlockTally) {
  for (const code of new Set([...Object.keys(a), ...Object.keys(b)])) {
    expect({ code, n: a[code] ?? 0 }).toEqual({ code, n: b[code] ?? 0 })
  }
}

describe('estimate-from-render === calculateProjectTally', () => {
  it('4-wall box, no openings', () => {
    const walls = boxWalls()
    expectEqualTallies(projectRenderTally(walls, []), calculateProjectTally(walls, makeupsById))
  })

  it('4-wall box, window mid-wall', () => {
    const walls = boxWalls()
    const op = win('wA', 1400)
    expectEqualTallies(projectRenderTally(walls, [op]), calculateProjectTally(walls, makeupsById, [op]))
  })

  it('4-wall box, window hard against a corner', () => {
    const walls = boxWalls()
    const op = win('wA', 200)
    expectEqualTallies(projectRenderTally(walls, [op]), calculateProjectTally(walls, makeupsById, [op]))
  })
})
