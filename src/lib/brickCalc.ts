/**
 * Brick estimate calculation engine.
 *
 * Brick estimates are simpler than block — there's no bond pattern, no end
 * terminations, no fraction maths. We count brickwork m², subtract opening
 * areas, apply a "bricks per m²" rate.
 *
 * Per-makeup course composition is supported: when a BrickMakeup carries
 * `courseRanges`, the wall is split into vertical bands (e.g. course 1 =
 * single-height, courses 2+ = double-height) and the tally accumulates
 * counts per brick type. Walls whose makeup has no courseRanges fall back
 * to the single project-level rate so existing projects tally identically
 * to before.
 */

import type {
  BrickCourseRange,
  BrickMakeup,
  BrickSettings,
  Opening,
  Wall,
} from '../types/walls'
import type { BrickCode, BrickType } from '../types/bricks'
import { bricksPerSquareMetreOf, DEFAULT_BRICK_MORTAR_MM } from '../types/bricks'
import { BRICK_LIBRARY } from '../data/brickLibrary'

// ---------- Brick tally ----------
//
// Lintels used to be a first-class concept in this tally, with a hardcoded
// AU Galintel catalogue + bearing rules. The catalogue didn't fit US
// (steel angles) or UK (concrete + IG) construction, so lintels now live
// as per-opening supply items in the material library. The brick export
// tallies those supply items the same way it tallies ties and flashings.

export interface BrickTally {
  /** Number of walls drawn. */
  wallCount: number
  /** Number of openings placed. */
  openingCount: number
  /** Total wall lineal length (mm). */
  totalLinealMm: number
  /** Total brickwork face area in mm² (sum of wall area minus all opening areas, clamped at 0). */
  totalAreaSqMm: number
  /** Number of face bricks across every wall — sum of per-type counts. */
  brickCount: number
  /**
   * Brick counts keyed by brick type code. Populated only when at least
   * one wall on the project uses `BrickMakeup.courseRanges` (mixed
   * brick types). Single-brick projects leave this empty and callers
   * fall back to the flat `brickCount`.
   */
  bricksByType: Record<string, number>
  /**
   * Per wall-type (per-makeup) breakdown so the estimator can see how
   * much brickwork sits in each wall type and price each one
   * independently (Common @ $X/m² vs Facework @ $Y/m²).
   *
   * Openings on a wall deduct ONLY from that wall's makeup bucket —
   * not pooled into a single project deduction — so if a Facework
   * wall has two windows, the Facework net area / brick count drop
   * while the Common bucket stays unaffected.
   *
   * Walls without a makeup go into the '__none__' bucket so they're
   * still represented. Empty when no walls have been drawn.
   */
  byMakeup: Record<string, BrickTallyByMakeup>
}

export interface BrickTallyByMakeup {
  /** The makeup id (or '__none__' for walls without a makeup). */
  makeupId: string
  /** Number of walls using this makeup. */
  wallCount: number
  /** Total lineal mm of wall using this makeup. */
  totalLinealMm: number
  /** Gross face area (before opening deductions) in mm². */
  grossAreaSqMm: number
  /** Sum of opening areas placed on walls of this makeup, in mm². */
  openingAreaSqMm: number
  /** Net face area after opening deductions, in mm². */
  netAreaSqMm: number
  /** Bricks needed for the net area at this makeup's rate. */
  brickCount: number
}

function wallLengthMm(wall: Wall): number {
  const dx = wall.endX - wall.startX
  const dy = wall.endY - wall.startY
  return Math.sqrt(dx * dx + dy * dy)
}

/**
 * Course pitch (face height + mortar joint) for a brick type. Fallback
 * is 76 + 10 mm — sensible default if the type lookup misses (e.g. a
 * range references a brick the user later deleted from the library).
 */
function coursePitchMm(brickType: BrickType | undefined): number {
  if (!brickType) return 76 + DEFAULT_BRICK_MORTAR_MM
  const mortar = brickType.mortarJointMm ?? DEFAULT_BRICK_MORTAR_MM
  return brickType.heightMm + mortar
}

interface ResolvedBrickSegment {
  brickTypeCode: string
  /** Band height on the wall in mm (course count × course pitch). */
  heightMm: number
  /** Bricks per m² for this band's brick type. */
  bricksPerSquareMetre: number
}

/**
 * Walk a brick makeup's `courseRanges` against a real wall height and
 * return the vertical bands of brickwork to tally, ordered bottom →
 * top.
 *
 * Returns `null` when the makeup has no course composition — the caller
 * then falls back to the legacy "flat" tally using the project rate.
 *
 * The last range (highest fromCourse) is open-ended: it always extends
 * to the top of the wall regardless of how many courses that takes. If
 * the wall is too short to fit even the first range, the band height
 * collapses to whatever fits.
 */
function resolveBrickCourseSegments(
  makeup: BrickMakeup,
  wallHeightMm: number,
  library: Record<BrickCode, BrickType>
): ResolvedBrickSegment[] | null {
  const ranges = (makeup.courseRanges ?? []).filter(
    (r): r is BrickCourseRange =>
      Number.isFinite(r.fromCourse) && r.fromCourse >= 1 && !!r.brickTypeCode
  )
  if (ranges.length === 0) return null

  const sorted = [...ranges].sort((a, b) => a.fromCourse - b.fromCourse)
  const deduped: BrickCourseRange[] = []
  for (const r of sorted) {
    const last = deduped[deduped.length - 1]
    if (last && last.fromCourse === r.fromCourse) {
      deduped[deduped.length - 1] = r
    } else {
      deduped.push(r)
    }
  }
  // Ensure the bottom course (1) has a band — fall back to the makeup's
  // main brick if the user only added ranges starting above course 1.
  if (deduped[0].fromCourse !== 1) {
    deduped.unshift({ fromCourse: 1, brickTypeCode: makeup.brickTypeCode })
  }

  const segments: ResolvedBrickSegment[] = []
  let cursorMm = 0
  for (let i = 0; i < deduped.length; i++) {
    const range = deduped[i]
    const next = deduped[i + 1]
    const brickType = library[range.brickTypeCode]
    const pitch = coursePitchMm(brickType)
    const remainingMm = wallHeightMm - cursorMm
    if (remainingMm <= 0) break

    let bandHeight: number
    if (next) {
      const bandCourses = Math.max(0, next.fromCourse - range.fromCourse)
      bandHeight = Math.min(bandCourses * pitch, remainingMm)
    } else {
      bandHeight = remainingMm
    }
    if (bandHeight <= 0) continue

    segments.push({
      brickTypeCode: range.brickTypeCode,
      heightMm: bandHeight,
      bricksPerSquareMetre: brickType ? bricksPerSquareMetreOf(brickType) : 0,
    })
    cursorMm += bandHeight
  }
  return segments
}

/**
 * Compute the brick tally for a set of walls + openings.
 *
 * When `makeups` is supplied, walls whose makeup carries `courseRanges`
 * get a per-band tally — each band contributes
 * `bandHeight × wallLength × bricksPerSquareMetreOf(brick)` to a
 * per-brick-type bucket. Openings deduct area from the topmost band on
 * the wall (matches how doors and windows sit in real walls — almost
 * never inside the bottom course).
 *
 * Walls without per-makeup course composition (or any call site that
 * doesn't pass makeups) keep the legacy behaviour of one flat
 * `settings.bricksPerSquareMetre` rate against net wall area.
 */
export function calculateBrickTally(
  walls: Wall[],
  openings: Opening[],
  settings: BrickSettings,
  makeups?: BrickMakeup[]
): BrickTally {
  let totalLinealMm = 0
  let totalAreaSqMm = 0

  interface WallAreaEntry {
    wallId: string
    /** The wall's makeup id (or '__none__' for walls without one).
     *  Drives per-wall-type aggregation in the byMakeup output so
     *  the estimator can price each wall type independently. */
    makeupId: string
    /** This wall's bricksPerSquareMetre — used for the byMakeup
     *  brick-count math when the wall has no banded segments. */
    fallbackBricksPerSqM: number
    /** Bands top-to-bottom so opening deductions land on the topmost band first. */
    bands: Array<{
      brickTypeCode: string
      bricksPerSquareMetre: number
      areaSqMm: number
    }>
  }
  const wallAreas: WallAreaEntry[] = []
  const makeupsById = new Map<string, BrickMakeup>()
  if (makeups) for (const m of makeups) makeupsById.set(m.id, m)
  // Tracks whether any wall on the project actually has course bands —
  // when false, we leave `bricksByType` empty so single-brick projects
  // keep their existing tally shape.
  let anyWallBanded = false

  for (const wall of walls) {
    const len = wallLengthMm(wall)
    // Height precedence (mirrors block walls): per-wall override → wall
    // TYPE's height → project default. Resolve the makeup first so the
    // middle rung is reachable. Previously this skipped straight from the
    // override to the project default, which meant editing a brick wall
    // type's heightMm in BrickTypesPanel had no effect on the tallied
    // area — only on the preview swatch.
    const makeup = wall.makeupId ? makeupsById.get(wall.makeupId) : undefined
    const height =
      wall.heightMmOverride ?? makeup?.heightMm ?? settings.defaultWallHeightMm
    totalLinealMm += len

    let bands: WallAreaEntry['bands'] = []
    if (makeup) {
      const segments = resolveBrickCourseSegments(makeup, height, BRICK_LIBRARY)
      if (segments && segments.length > 0) {
        anyWallBanded = true
        const topToBottom = [...segments].reverse()
        bands = topToBottom.map((seg) => ({
          brickTypeCode: seg.brickTypeCode,
          bricksPerSquareMetre: seg.bricksPerSquareMetre,
          areaSqMm: len * seg.heightMm,
        }))
      }
    }
    if (bands.length === 0) {
      // Synthetic single band: legacy flat behaviour at the project rate.
      bands = [
        {
          brickTypeCode: makeup?.brickTypeCode ?? settings.brickTypeCode ?? '',
          bricksPerSquareMetre: settings.bricksPerSquareMetre,
          areaSqMm: len * height,
        },
      ]
    }
    for (const b of bands) totalAreaSqMm += b.areaSqMm
    wallAreas.push({
      wallId: wall.id,
      makeupId: wall.makeupId || '__none__',
      fallbackBricksPerSqM: settings.bricksPerSquareMetre,
      bands,
    })
  }

  // Index openings by their wall so we know where to deduct. Openings
  // without a resolvable wallId fall through to a project-wide subtract.
  const wallIds = new Set(walls.map((w) => w.id))
  const openingsByWall = new Map<string, Opening[]>()
  const orphanOpenings: Opening[] = []
  for (const op of openings) {
    if (op.wallId && wallIds.has(op.wallId)) {
      const arr = openingsByWall.get(op.wallId) ?? []
      arr.push(op)
      openingsByWall.set(op.wallId, arr)
    } else {
      orphanOpenings.push(op)
    }
  }

  // Deduct openings from each wall's bands top-down — opening area
  // comes off the topmost band first (the band most likely to contain
  // the window / door), spilling into lower bands only if the opening
  // is taller than the top band's height share.
  for (const entry of wallAreas) {
    const ops = openingsByWall.get(entry.wallId)
    if (!ops || ops.length === 0) continue
    let remaining = ops.reduce((s, o) => s + o.widthMm * o.heightMm, 0)
    for (const band of entry.bands) {
      if (remaining <= 0) break
      const take = Math.min(band.areaSqMm, remaining)
      band.areaSqMm -= take
      remaining -= take
    }
  }

  // Subtract every opening's area from the project-wide total (including
  // orphans). totalAreaSqMm should still equal the sum of per-band areas
  // after deduction, with rounding tolerance.
  let openingTotalArea = 0
  for (const op of openings) openingTotalArea += op.widthMm * op.heightMm
  totalAreaSqMm -= openingTotalArea
  if (totalAreaSqMm < 0) totalAreaSqMm = 0

  // Sum bands per brick type, then ceil into counts.
  const areaByType: Record<string, number> = {}
  for (const entry of wallAreas) {
    for (const band of entry.bands) {
      if (band.areaSqMm <= 0) continue
      const m2 = band.areaSqMm / 1_000_000
      const key = band.brickTypeCode || '__default__'
      areaByType[key] = (areaByType[key] ?? 0) + m2 * band.bricksPerSquareMetre
    }
  }
  // Orphan-opening area isn't allocated to any wall. Spread it across
  // the largest bucket as a best-effort deduction so per-type counts
  // sum to approximately net brickwork.
  if (orphanOpenings.length > 0 && Object.keys(areaByType).length > 0) {
    let orphanArea = 0
    for (const op of orphanOpenings) orphanArea += op.widthMm * op.heightMm
    const largestKey = Object.entries(areaByType).sort((a, b) => b[1] - a[1])[0][0]
    const orphanBricks = (orphanArea / 1_000_000) * settings.bricksPerSquareMetre
    areaByType[largestKey] = Math.max(0, areaByType[largestKey] - orphanBricks)
  }

  const bricksByType: Record<string, number> = {}
  let brickCount = 0
  for (const [key, n] of Object.entries(areaByType)) {
    const rounded = Math.ceil(n)
    if (rounded <= 0) continue
    bricksByType[key === '__default__' ? '' : key] = rounded
    brickCount += rounded
  }

  const distinctTypes = Object.keys(bricksByType)
  const finalBricksByType =
    anyWallBanded && distinctTypes.length > 1
      ? bricksByType
      : ({} as Record<string, number>)

  // Per-makeup breakdown: walk wallAreas again, this time bucketing
  // by makeupId so the estimator can see how much brickwork each
  // wall type contributes. The bands inside each wallArea have
  // already had their opening deductions applied above, so the band
  // sum here is the NET area for that wall. Gross is recomputed
  // from len × height; opening area is gross - net (per makeup).
  const byMakeup: Record<string, BrickTallyByMakeup> = {}
  // First, GROSS pass — sum the per-wall gross area (sum of bands
  // BEFORE deduction). Bands were mutated, so we re-derive gross
  // from openings on that wall plus the current (net) band sums.
  // Equivalently, gross = net + opening deductions credited to the
  // wall, which is what openingsByWall tells us.
  for (const entry of wallAreas) {
    const bucket = (byMakeup[entry.makeupId] ??= {
      makeupId: entry.makeupId,
      wallCount: 0,
      totalLinealMm: 0,
      grossAreaSqMm: 0,
      openingAreaSqMm: 0,
      netAreaSqMm: 0,
      brickCount: 0,
    })
    bucket.wallCount++
    const wall = walls.find((w) => w.id === entry.wallId)
    bucket.totalLinealMm += wall ? wallLengthMm(wall) : 0
    const netArea = entry.bands.reduce((s, b) => s + b.areaSqMm, 0)
    bucket.netAreaSqMm += netArea
    const wallOpenings = openingsByWall.get(entry.wallId) ?? []
    const wallOpeningArea = wallOpenings.reduce(
      (s, o) => s + o.widthMm * o.heightMm,
      0
    )
    bucket.openingAreaSqMm += wallOpeningArea
    bucket.grossAreaSqMm += netArea + wallOpeningArea
    // Per-makeup brick count: sum across bands at each band's rate
    // (so banded walls in the same makeup get their own rate per
    // band). Net area for the band × rate.
    for (const band of entry.bands) {
      if (band.areaSqMm <= 0) continue
      const m2 = band.areaSqMm / 1_000_000
      bucket.brickCount += m2 * band.bricksPerSquareMetre
    }
  }
  // Round each makeup's brick count up at the end so the per-makeup
  // numbers tile cleanly to the table.
  for (const bucket of Object.values(byMakeup)) {
    bucket.brickCount = Math.ceil(bucket.brickCount)
  }

  return {
    wallCount: walls.length,
    openingCount: openings.length,
    totalLinealMm,
    totalAreaSqMm,
    brickCount,
    bricksByType: finalBricksByType,
    byMakeup,
  }
}

/**
 * Sensible defaults for a fresh brick estimate.
 *
 * Picks the first brick code in the live BRICK_LIBRARY so a US user
 * with the US-modular library gets 'modular' as the default, a UK user
 * gets 'standard' (BS 215×65), AU users get the legacy 'standard'
 * (230×76). Falls back to 'standard' as a last resort.
 *
 * Initial bricks/m² is computed from the chosen brick's face dimensions
 * + the makeup mortar (default 10mm). Ties + plascourse live as supply
 * items in the Material library, not on BrickSettings any more.
 */
export function createDefaultBrickSettings(): BrickSettings {
  const firstBrick = Object.values(BRICK_LIBRARY)[0]
  const brickTypeCode = firstBrick?.code ?? 'standard'
  const computedRate = firstBrick
    ? Math.round(
        1_000_000 / ((firstBrick.widthMm + 10) * (firstBrick.heightMm + 10))
      )
    : 48
  return {
    defaultWallHeightMm: 2400,
    brickTypeCode,
    bricksPerSquareMetre: computedRate,
  }
}
