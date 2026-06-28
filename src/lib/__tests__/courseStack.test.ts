/**
 * Course-stack picker tests + drift guard.
 *
 * These lock in the height-makeup behaviour we fixed (a 900mm AU wall
 * gets a 20.71 90mm course, not a 20.140 and not a fat joint) AND guard
 * the two course-building paths against ever drifting apart again:
 * - the calc path (calculateCourseStack, used by planWallLayout + tally)
 * - the bands path (convertMakeupToBands, used by the wall envelope, cap,
 *   mortar and opening cell-grid)
 * must always agree on the stack. They drifted once and opened a fat
 * joint above the makeup course; this suite fails loudly if it recurs.
 */
import { describe, it, expect } from 'vitest'
import type { Wall, WallMakeup } from '../../types/walls'
import {
  calculateCourseStack,
  resolveHmModules,
  COURSE_MODULE_MM,
} from '../courseStack'
import { calculateWallTally } from '../blockCalc'
import {
  convertMakeupToBands,
  getEffectiveWallThicknessMm,
} from '../makeups'
import { resolveWallCourses } from '../wallSegments'
import { BLOCK_LIBRARY } from '../../data/blockLibrary'

// Standard AU 200-series makeup. heightMm overridden per test.
function auMakeup(heightMm: number): WallMakeup {
  return {
    id: 'mk',
    name: 'AU 200',
    bondType: 'stretcher',
    heightMm,
    baseCourseBlockCode: '20.45',
    bodyBlockCode: '20.48',
    topCourseBlockCode: '20.48',
    cornerBlockCode: '20.01',
    halfBlockCode: '20.03',
    useFractions: false,
  }
}

function freeWall(heightMm: number): Wall {
  return {
    id: 'w',
    makeupId: 'mk',
    startX: 0,
    startY: 0,
    endX: 4000,
    endY: 0,
    startJunction: { type: 'free' },
    endJunction: { type: 'free' },
    heightMmOverride: heightMm,
  }
}

// AU height-makeup modules resolved from the live library: 90mm -> 100,
// 140mm -> 150.
const AU = resolveHmModules(auMakeup(2400))

describe('resolveHmModules (AU library)', () => {
  it('targets the makeup blocks by module, not by code nickname', () => {
    expect(AU.hm71ModuleMm).toBe(100) // 90mm block + 10mm joint
    expect(AU.hm140ModuleMm).toBe(150) // 140mm block + 10mm joint
  })
})

describe('calculateCourseStack: makeup-course selection (AU)', () => {
  it('900mm = 4 standard + one 20.71 (90mm), landing exactly', () => {
    const s = calculateCourseStack(900, COURSE_MODULE_MM, AU.hm140ModuleMm, AU.hm71ModuleMm)
    expect(s.has71).toBe(true)
    expect(s.has140).toBe(false)
    expect(s.standardCount).toBe(4)
    expect(s.actualHeightMm).toBe(900)
  })

  it('950mm uses a 20.140 (closest fit), not a 20.71', () => {
    const s = calculateCourseStack(950, COURSE_MODULE_MM, AU.hm140ModuleMm, AU.hm71ModuleMm)
    expect(s.has140).toBe(true)
    expect(s.has71).toBe(false)
  })

  it('2400mm needs no makeup course', () => {
    const s = calculateCourseStack(2400, COURSE_MODULE_MM, AU.hm140ModuleMm, AU.hm71ModuleMm)
    expect(s.has71).toBe(false)
    expect(s.has140).toBe(false)
    expect(s.standardCount).toBe(12)
  })

  it('a library with no makeup blocks never adds one', () => {
    const s = calculateCourseStack(900, COURSE_MODULE_MM, undefined, undefined)
    expect(s.has71).toBe(false)
    expect(s.has140).toBe(false)
  })
})

describe('a 900mm AU wall renders and tallies the 20.71', () => {
  it('the 20.71 appears in the wall tally (and the 20.140 does not)', () => {
    const wall = freeWall(900)
    const makeup = auMakeup(900)
    const thick = { w: getEffectiveWallThicknessMm(makeup, BLOCK_LIBRARY) }
    const tally = calculateWallTally(wall, makeup, [], thick, { w: wall })
    expect(tally['20.71'] ?? 0).toBeGreaterThan(0)
    expect(tally['20.140'] ?? 0).toBe(0)
  })

  it('the bands path sizes the makeup course at 90mm (no fat joint)', () => {
    const makeupsById = { mk: auMakeup(900) }
    const { courses } = resolveWallCourses(freeWall(900), makeupsById, BLOCK_LIBRARY)
    const hm = courses.find((c) => c.bodyCode === '20.71')
    expect(hm).toBeDefined()
    // Course face height = block height (90mm), not a full 200mm slot.
    expect(Math.round((hm!.y1 - hm!.y0) * 1000)).toBe(90)
  })
})

describe('drift guard: the calc path and the bands path agree', () => {
  it('agree on which makeup courses exist for every height 400..3200mm', () => {
    for (let H = 400; H <= 3200; H += 10) {
      const calc = calculateCourseStack(H, COURSE_MODULE_MM, AU.hm140ModuleMm, AU.hm71ModuleMm)
      const bands = convertMakeupToBands(auMakeup(H)).bands
      const has71 = bands.some((b) => b.blockCode === '20.71')
      const has140 = bands.some((b) => b.blockCode === '20.140')
      expect({ H, has71, has140 }).toEqual({ H, has71: calc.has71, has140: calc.has140 })
    }
  })
})
