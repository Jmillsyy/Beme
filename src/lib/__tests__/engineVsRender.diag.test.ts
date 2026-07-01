/**
 * DIAGNOSTIC (temporary): map the gap between the ENGINE (planWallLayout,
 * the intended source of truth) and today's correct RENDER
 * (segmentsForStraightWall). Goal: make the engine emit the exact same
 * positioned blocks the render draws, so the 3D becomes a 1:1 echo.
 *
 * - Plain wall (no openings): they SHOULD already agree - proves the
 *   comparison frame is valid.
 * - Opening wall: engine ignores openings today, so this shows the gap
 *   we're closing (missing carve / jambs / lintels).
 */
import { describe, it } from 'vitest'
import type { Wall, WallMakeup, Opening, BlockTally } from '../../types/walls'
import { planWallLayout, tallyFromLayout, cornerOwnershipFor } from '../blockCalc'
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

function engineTally(wall: Wall, ops: Opening[], byId: Record<string, Wall>, thick: Record<string, number>): BlockTally {
  const layout = planWallLayout(wall, MAKEUP, ops.filter((o) => o.wallId === wall.id), thick, byId, cornerOwnershipFor(wall, byId, thick))
  return tallyFromLayout(layout)
}
function renderTally(wall: Wall, ops: Opening[], byId: Record<string, Wall>, thick: Record<string, number>): BlockTally {
  const { courses, totalHeightM } = resolveWallCourses(wall, makeupsById, BLOCK_LIBRARY)
  const adj = ops.filter((o) => o.wallId === wall.id).map((o) => adjustOpeningForRender(o, MAKEUP.heightMm))
  const boxes = segmentsForStraightWall(
    wall, adj, thick[wall.id], courses, totalHeightM, 'stretcher', new Map(), BLOCK_LIBRARY, thick, byId,
    false, undefined, undefined, cornerOwnershipFor(wall, byId, thick), 0.01,
  )
  return tallyFromRenderBoxes(boxes, BLOCK_LIBRARY)
}
function showDiff(label: string, eng: BlockTally, ren: BlockTally) {
  const codes = [...new Set([...Object.keys(eng), ...Object.keys(ren)])].sort()
  const rows = codes.map((c) => `${c}: engine=${eng[c] ?? 0} render=${ren[c] ?? 0}${(eng[c] ?? 0) !== (ren[c] ?? 0) ? '  <-- DIFF' : ''}`)
  console.log(`\n=== ${label} ===\n${rows.join('\n')}`)
}

describe('DIAG engine (planWallLayout) vs render (segmentsForStraightWall)', () => {
  it('plain wall — should already agree', () => {
    const walls = boxWalls()
    const byId: Record<string, Wall> = {}; walls.forEach((w) => (byId[w.id] = w))
    const thick: Record<string, number> = {}; walls.forEach((w) => (thick[w.id] = T))
    showDiff('wA plain (no openings)', engineTally(walls[0], [], byId, thick), renderTally(walls[0], [], byId, thick))
  })
  it('wall with a window — shows the opening gap', () => {
    const walls = boxWalls()
    const byId: Record<string, Wall> = {}; walls.forEach((w) => (byId[w.id] = w))
    const thick: Record<string, number> = {}; walls.forEach((w) => (thick[w.id] = T))
    const op = win('wA', 1400)
    showDiff('wA + window @1400', engineTally(walls[0], [op], byId, thick), renderTally(walls[0], [op], byId, thick))
    // Per-course body (20.48) dump to locate the residual body gap.
    const layout = planWallLayout(walls[0], MAKEUP, [op], thick, byId, cornerOwnershipFor(walls[0], byId, thick))
    const engBody = new Map<number, number>()
    for (const b of layout.blocks) if (b.code === '20.48') engBody.set(b.courseIdx + 1, (engBody.get(b.courseIdx + 1) ?? 0) + 1)
    const { courses, totalHeightM } = resolveWallCourses(walls[0], makeupsById, BLOCK_LIBRARY)
    const adj = [op].map((o) => adjustOpeningForRender(o, MAKEUP.heightMm))
    const boxes = segmentsForStraightWall(walls[0], adj, thick.wA, courses, totalHeightM, 'stretcher', new Map(), BLOCK_LIBRARY, thick, byId, false, undefined, undefined, cornerOwnershipFor(walls[0], byId, thick), 0.01)
    const renBody = new Map<number, number>()
    for (const b of boxes) if (b.code === '20.48' && b.courseNumber !== undefined) renBody.set(b.courseNumber, (renBody.get(b.courseNumber) ?? 0) + 1)
    const allC = [...new Set([...engBody.keys(), ...renBody.keys()])].sort((a, b) => a - b)
    console.log('\nPER-COURSE 20.48 body (course: engine/render):')
    for (const c of allC) console.log(`  c${c}: ${engBody.get(c) ?? 0}/${renBody.get(c) ?? 0}${(engBody.get(c) ?? 0) !== (renBody.get(c) ?? 0) ? '  <-- DIFF' : ''}`)
  })
})
