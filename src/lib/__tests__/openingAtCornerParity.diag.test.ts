/**
 * Render <-> estimate parity for an opening jammed hard against a corner.
 *
 * When an opening sits right at a corner, that wall's end reads as a half
 * termination. This locks in that the 3D enumeration and the export tally
 * agree on every (non-paired) block code there - so the picture can't drift
 * from the estimate at opening-at-corner conditions.
 */
import { describe, it, expect } from 'vitest'
import type { Wall, WallMakeup, Opening, BlockTally } from '../../types/walls'
import { calculateProjectTally, cornerOwnershipFor } from '../blockCalc'
import { getEffectiveWallThicknessMm } from '../makeups'
import {
  segmentsForStraightWall,
  resolveWallCourses,
  adjustOpeningForRender,
} from '../wallSegments'
import { BLOCK_LIBRARY } from '../../data/blockLibrary'

const MAKEUP: WallMakeup = {
  id: 'mk', name: 'std', bondType: 'stretcher', heightMm: 2400,
  baseCourseBlockCode: '20.45', bodyBlockCode: '20.48', topCourseBlockCode: '20.48',
  cornerBlockCode: '20.01', halfBlockCode: '20.03', useFractions: false,
}
const makeupsById = { mk: MAKEUP }
const T = getEffectiveWallThicknessMm(MAKEUP, BLOCK_LIBRARY)
const PAIRED = new Set(
  Object.values(BLOCK_LIBRARY)
    .map((b) => b.pairedWith)
    .filter((c): c is string => !!c),
)

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
function renderTally(wall: Wall, ops: Opening[], walls: Wall[]): BlockTally {
  const thick: Record<string, number> = {}; walls.forEach((w) => (thick[w.id] = T))
  const byId: Record<string, Wall> = {}; walls.forEach((w) => (byId[w.id] = w))
  const { courses, totalHeightM } = resolveWallCourses(wall, makeupsById, BLOCK_LIBRARY)
  const adj = ops.filter((o) => o.wallId === wall.id).map((o) => adjustOpeningForRender(o, MAKEUP.heightMm))
  const boxes = segmentsForStraightWall(
    wall, adj, T, courses, totalHeightM, 'stretcher', new Map(), BLOCK_LIBRARY, thick, byId,
    false, undefined, undefined, cornerOwnershipFor(wall, byId, thick), 0.01,
  )
  const t: BlockTally = {}
  for (const b of boxes) if (b.code) t[b.code] = (t[b.code] ?? 0) + 1
  return t
}

describe('opening hard against a corner: render === estimate', () => {
  it('window jammed to a box corner — counts match (paired tiles excepted)', () => {
    const walls = boxWalls()
    const op = win('wA', 200) // near jamb at the corner-block edge
    const project = calculateProjectTally(walls, makeupsById, [op])
    const summed: BlockTally = {}
    for (const w of walls) {
      const r = renderTally(w, [op], walls)
      for (const [c, n] of Object.entries(r)) summed[c] = (summed[c] ?? 0) + (n ?? 0)
    }
    for (const code of new Set([...Object.keys(project), ...Object.keys(summed)])) {
      if (PAIRED.has(code)) continue
      expect({ code, n: project[code] ?? 0 }).toEqual({ code, n: summed[code] ?? 0 })
    }
  })
})
