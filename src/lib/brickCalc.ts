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
import { arcFromThreePoints, isCurvedWall } from './curveGeom'

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
   * Lineal MILLIMETRES of head course needed across every opening,
   * keyed by brick code. Per opening: width + 2 × overhang. Doors AND
   * windows both contribute a head course.
   *
   * Always populated when openings exist. When a makeup names an
   * explicit `headBrickCode` (in the wall-type modal's "Opening
   * visuals" tab) the lineals key under THAT code; otherwise they
   * key under the makeup's primary brick code — the head course
   * defaults to the body brick. The brick-code lookup is a 3D-render
   * concern; the lineal-m total is a tally metric that surfaces
   * either way.
   *
   * Reported in MILLIMETRES — the export divides by 1000 to render
   * as "X.X m" for the deliverable.
   */
  headLinealMmByType: Record<string, number>
  /**
   * Lineal MILLIMETRES of sill course under every window. Same
   * (width + 2 × overhang) formula. Doors are EXCLUDED — they sit
   * on the floor, no sill course beneath. Same fallback rule as
   * headLinealMmByType: keys under the makeup's `sillBrickCode` when
   * set, otherwise its primary brick code, so the lineal-m total
   * surfaces whether or not the user has filled in Opening visuals.
   */
  sillLinealMmByType: Record<string, number>
  /**
   * Lineal MILLIMETRES of head course needed, keyed by MAKEUP id
   * (wall type) rather than by brick code. Drives the per-wall-type
   * breakdown table in the export — the brick-code variant above
   * pools across makeups that share a head brick, which is the right
   * shape for ordering bricks but not for showing the estimator the
   * head lineals each wall type contributes.
   *
   * Populated for every wall type that has openings, regardless of
   * whether the makeup names a headBrickCode.
   */
  headLinealMmByMakeup: Record<string, number>
  /**
   * Lineal MILLIMETRES of sill course needed, keyed by MAKEUP id.
   * Windows only (doors excluded — same rule as sillLinealMmByType).
   * Populated for every wall type that has at least one window
   * opening, regardless of whether the makeup names a sillBrickCode.
   */
  sillLinealMmByMakeup: Record<string, number>
  /**
   * Lineal MILLIMETRES of "course substitute" — courses on a wall
   * whose courseRanges nominates a brick type different from the
   * wall's main brickTypeCode. Sum across all such courses on
   * walls of (course count for this range) × wall length, keyed
   * by the substitute brick code. Lets the estimator order the
   * substitute brick separately from the body brick.
   *
   * A wall with no courseRanges (or whose courseRanges all match
   * the main brick) contributes 0.
   */
  courseSubstituteLinealMmByType: Record<string, number>
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

/**
 * Wall length in millimetres.
 *
 * Straight walls → Euclidean distance between start and end.
 * Curved walls   → true arc length along the centreline. The arc is
 *                  defined by the three points (start, mid, end), and
 *                  arcLengthMm comes from the shared curveGeom helper
 *                  that drives the block estimator + 3D renderer.
 *
 * Falls back to Euclidean distance if the curve geometry is degenerate
 * (three collinear points) so the calc never returns NaN.
 */
function wallLengthMm(wall: Wall): number {
  if (isCurvedWall(wall) && wall.midX !== undefined && wall.midY !== undefined) {
    const geom = arcFromThreePoints(
      { x: wall.startX, y: wall.startY },
      { x: wall.midX, y: wall.midY },
      { x: wall.endX, y: wall.endY },
    )
    if (geom) return geom.arcLengthMm
  }
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

  // BELOW-COURSE semantics: ranges sorted ascending by their
  // `fromCourse` threshold. Each range covers courses below its
  // threshold but above the previous range's threshold (or 1 if
  // it's the first). The makeup's main brick fills the top of the
  // wall, covering all courses above the highest threshold.
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

  const segments: ResolvedBrickSegment[] = []
  let cursorMm = 0
  let cursorCourse = 1
  for (let i = 0; i < deduped.length; i++) {
    const range = deduped[i]
    const brickType = library[range.brickTypeCode]
    const pitch = coursePitchMm(brickType)
    const remainingMm = wallHeightMm - cursorMm
    if (remainingMm <= 0) break
    // Number of courses this range covers — from cursorCourse up to
    // (but not including) range.fromCourse.
    const bandCourses = Math.max(0, range.fromCourse - cursorCourse)
    const bandHeight = Math.min(bandCourses * pitch, remainingMm)
    if (bandHeight <= 0) {
      cursorCourse = range.fromCourse
      continue
    }
    segments.push({
      brickTypeCode: range.brickTypeCode,
      heightMm: bandHeight,
      bricksPerSquareMetre: brickType ? bricksPerSquareMetreOf(brickType) : 0,
    })
    cursorMm += bandHeight
    cursorCourse = range.fromCourse
  }
  // Top of wall — fill the remaining height with the makeup's main
  // brick. This is the implicit "above all bands" region in the
  // below-course model: courses above the highest threshold use
  // the default brick instead of needing an explicit band.
  const remainingMm = wallHeightMm - cursorMm
  if (remainingMm > 0) {
    const mainBrick = library[makeup.brickTypeCode]
    if (mainBrick) {
      segments.push({
        brickTypeCode: makeup.brickTypeCode,
        heightMm: remainingMm,
        bricksPerSquareMetre: bricksPerSquareMetreOf(mainBrick),
      })
    }
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

  // ── Grid-based brick counting ────────────────────────────────────
  //
  // Walk each wall's courses (matching how the 3D renderer lays bricks)
  // and tally one brick per visible unit. Where openings sit inside a
  // course's Y range, the bricks inside the opening's X span DON'T
  // count — same as the renderer not drawing them. Result: every brick
  // the user sees in 3D is one brick in this tally, no area-rate
  // approximation drift.
  //
  // Per-course brick type comes from `brickTypeForCourse(courseNum)`
  // applied to the makeup's courseRanges, falling back to the makeup's
  // primary brickTypeCode then to the project-default brick. Matches
  // the renderer's resolution exactly.
  const BRICK_MORTAR_MM = 10
  const bricksByTypeRaw: Record<string, number> = {}
  // Per-wall total brick count — used below to populate
  // byMakeup[m].brickCount with grid-counted bricks, matching the
  // project-wide bricksByType totals.
  const bricksPerWall = new Map<string, number>()
  for (const wall of walls) {
    const wallMakeup = wall.makeupId ? makeupsById.get(wall.makeupId) : undefined
    const wallLenMm = wallLengthMm(wall)
    const wallHeightMm =
      wall.heightMmOverride ??
      wallMakeup?.heightMm ??
      settings.defaultWallHeightMm
    if (wallLenMm < 1 || wallHeightMm < 1) continue
    const sortedRanges = [...(wallMakeup?.courseRanges ?? [])]
      .filter(
        (r) =>
          Number.isFinite(r.fromCourse) &&
          r.fromCourse >= 1 &&
          !!r.brickTypeCode,
      )
      .sort((a, b) => a.fromCourse - b.fromCourse)
    // BELOW-COURSE semantics: each range applies to courses BELOW
    // its `fromCourse` value. The first range whose threshold is
    // greater than the course number wins. Courses above every
    // range fall through to the makeup's default brick.
    const brickTypeForCourse = (courseNum: number): string => {
      for (const r of sortedRanges) {
        if (courseNum < r.fromCourse) return r.brickTypeCode
      }
      return wallMakeup?.brickTypeCode ?? settings.brickTypeCode ?? '__default__'
    }
    const wallOpenings = openings.filter((o) => o.wallId === wall.id)
    let wallTotal = 0
    let cursorMm = 0
    let courseIdx = 0
    while (cursorMm < wallHeightMm - 0.5) {
      const courseNum = courseIdx + 1
      const code = brickTypeForCourse(courseNum)
      const brickFromLib = BRICK_LIBRARY[code]
      const brickWidthMm = brickFromLib?.widthMm ?? 230
      const brickHeightMm = brickFromLib?.heightMm ?? 76
      const modularMm = brickWidthMm + BRICK_MORTAR_MM
      const y0 = cursorMm
      const y1 = Math.min(wallHeightMm, cursorMm + brickHeightMm)
      // Subtract opening x-spans from the course's available width
      // when an opening overlaps this course vertically.
      let availableSpans: Array<{ start: number; end: number }> = [
        { start: 0, end: wallLenMm },
      ]
      for (const op of wallOpenings) {
        const opSill = op.sillHeightMm
        const opHead = op.sillHeightMm + op.heightMm
        if (opHead <= y0 + 0.5 || opSill >= y1 - 0.5) continue
        const opStart = op.startAlongWallMm
        const opEnd = op.startAlongWallMm + op.widthMm
        const next: Array<{ start: number; end: number }> = []
        for (const span of availableSpans) {
          if (opEnd <= span.start || opStart >= span.end) {
            next.push(span)
          } else {
            if (opStart > span.start) next.push({ start: span.start, end: opStart })
            if (opEnd < span.end) next.push({ start: opEnd, end: span.end })
          }
        }
        availableSpans = next
      }
      // ceil(spanLen / modular) per available chunk — matches the
      // renderer's body-emit loop which lays one brick per modular
      // step and clamps the last brick to the chunk end.
      let bricksThisCourse = 0
      for (const span of availableSpans) {
        const spanLenMm = span.end - span.start
        if (spanLenMm < 1) continue
        bricksThisCourse += Math.ceil(spanLenMm / modularMm)
      }
      bricksByTypeRaw[code] = (bricksByTypeRaw[code] ?? 0) + bricksThisCourse
      wallTotal += bricksThisCourse
      cursorMm += brickHeightMm + BRICK_MORTAR_MM
      courseIdx++
    }
    bricksPerWall.set(wall.id, wallTotal)
  }

  // ── Lineal-metre buckets for head / sill / course substitute ─────
  //
  // The export prices these in lineal metres rather than brick
  // counts, so the bricklayer can multiply by their preferred
  // bricks/m rate for each lay-up. Three buckets:
  //
  //   - headLinealMmByType: sum of (openingWidth + 2 × overhang) per
  //       opening on walls whose makeup names a headBrickCode.
  //   - sillLinealMmByType: same, but WINDOWS only (doors sit on
  //       the floor → no sill course).
  //   - courseSubstituteLinealMmByType: walls with courseRanges that
  //       name a brick type different from the wall's MAIN brick get
  //       (wall length) × (number of courses in the substitute range)
  //       added to the substitute brick's bucket.
  //
  // No body-brick adjustment any more — the export ditched body
  // brick counts in favour of total wall area m², so there's nothing
  // to subtract from.
  const headLinealMmByType: Record<string, number> = {}
  const sillLinealMmByType: Record<string, number> = {}
  const headLinealMmByMakeup: Record<string, number> = {}
  const sillLinealMmByMakeup: Record<string, number> = {}
  const courseSubstituteLinealMmByType: Record<string, number> = {}
  const DEFAULT_TRIM_OVERHANG_MM = 100
  const wallByIdLocal = new Map<string, Wall>()
  for (const w of walls) wallByIdLocal.set(w.id, w)

  // Head + sill — per opening.
  //
  // Lineal-m accumulation runs UNCONDITIONALLY — every window gets a
  // sill span, every opening gets a head span — regardless of whether
  // the wall makeup has set a sillBrickCode / headBrickCode. The brick
  // code is a 3D-render concern (drives the visual sill / head course
  // bricks in the workspace view) but the lineal-m total is a real
  // takeoff metric the estimator wants to see either way. When no
  // brick code is set, the lineal m keys under the makeup's primary
  // brick code instead — the head / sill course would default to the
  // same brick as the body anyway, so it's the right downstream key
  // for the per-type tables.
  for (const op of openings) {
    if (!op.wallId) continue
    const wall = wallByIdLocal.get(op.wallId)
    if (!wall) continue
    const makeup = wall.makeupId ? makeupsById.get(wall.makeupId) : undefined
    if (!makeup) continue
    const overhang = makeup.openingTrimOverhangMm ?? DEFAULT_TRIM_OVERHANG_MM
    const trimSpanMm = op.widthMm + 2 * overhang
    const primaryBrickCode =
      makeup.brickTypeCode ?? settings.brickTypeCode ?? ''

    // Sill — windows only. An opening is a door (no sill course
    // underneath) when EITHER its explicit kind is 'door' OR its
    // sill height is 0 (door sits on the floor). The geometry
    // fallback matters because openings created in block mode
    // don't persist a kind field — they only carry sill / head
    // measurements, and a door is geometrically a sill=0 opening.
    const isDoor =
      op.kind === 'door' || (op.sillHeightMm ?? 0) <= 0
    if (!isDoor) {
      const sillCode = makeup.sillBrickCode || primaryBrickCode
      if (sillCode) {
        sillLinealMmByType[sillCode] =
          (sillLinealMmByType[sillCode] ?? 0) + trimSpanMm
      }
      if (wall.makeupId) {
        sillLinealMmByMakeup[wall.makeupId] =
          (sillLinealMmByMakeup[wall.makeupId] ?? 0) + trimSpanMm
      }
    }
    // Head — doors AND windows.
    const headCode = makeup.headBrickCode || primaryBrickCode
    if (headCode) {
      headLinealMmByType[headCode] =
        (headLinealMmByType[headCode] ?? 0) + trimSpanMm
    }
    if (wall.makeupId) {
      headLinealMmByMakeup[wall.makeupId] =
        (headLinealMmByMakeup[wall.makeupId] ?? 0) + trimSpanMm
    }
  }

  // Course substitute — per wall.
  // A "substitute" is a courseRanges entry whose brickTypeCode
  // differs from the wall makeup's primary brickTypeCode. Sum the
  // wall length once per course that the range covers.
  for (const wall of walls) {
    if (!wall.makeupId) continue
    const makeup = makeupsById.get(wall.makeupId)
    if (!makeup) continue
    const ranges = makeup.courseRanges
    if (!ranges || ranges.length === 0) continue
    const mainBrickCode =
      makeup.brickTypeCode ?? settings.brickTypeCode ?? ''
    const wallLenMm = wallLengthMm(wall)
    const wallHeightMm =
      wall.heightMmOverride ??
      makeup.heightMm ??
      settings.defaultWallHeightMm
    if (wallLenMm < 1 || wallHeightMm < 1) continue
    // Walk up the wall course-by-course using EACH course's own
    // brick height to advance the y-cursor. The previous version
    // used the MAIN brick's height for every step, which inflated
    // the substitute count when the substitute brick was taller
    // (a double-height course is 162mm vs standard's 76mm — using
    // standard's pitch would record ~2× as many substitute courses
    // as actually fit in the wall).
    const sortedRanges = [...ranges]
      .filter(
        (r) =>
          Number.isFinite(r.fromCourse) &&
          r.fromCourse >= 1 &&
          !!r.brickTypeCode,
      )
      .sort((a, b) => a.fromCourse - b.fromCourse)
    if (sortedRanges.length === 0) continue
    const brickForCourse = (courseNum: number): string => {
      let active = mainBrickCode
      for (const r of sortedRanges) {
        if (r.fromCourse > courseNum) break
        active = r.brickTypeCode
      }
      return active
    }
    const fallbackBrick = mainBrickCode
      ? BRICK_LIBRARY[mainBrickCode]
      : undefined
    const fallbackPitch =
      (fallbackBrick?.heightMm ?? 76) + (fallbackBrick?.mortarJointMm ?? 10)
    let y = 0
    let courseNum = 0
    while (y < wallHeightMm) {
      courseNum++
      const code = brickForCourse(courseNum)
      const brick = code ? BRICK_LIBRARY[code] : undefined
      const pitch = brick
        ? brick.heightMm + (brick.mortarJointMm ?? 10)
        : fallbackPitch
      if (pitch <= 0) break // defensive — avoid infinite loop
      if (code && code !== mainBrickCode) {
        courseSubstituteLinealMmByType[code] =
          (courseSubstituteLinealMmByType[code] ?? 0) + wallLenMm
      }
      y += pitch
    }
  }

  const bricksByType: Record<string, number> = {}
  let brickCount = 0
  for (const [key, n] of Object.entries(bricksByTypeRaw)) {
    if (n <= 0) continue
    bricksByType[key === '__default__' ? '' : key] = n
    brickCount += n
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
    // Per-makeup brick count: use the per-wall grid-counted total so
    // every wall's contribution to its makeup matches what the 3D
    // renderer draws. bricksPerWall was populated in the grid walk
    // above; missing entries (degenerate walls) contribute 0.
    bucket.brickCount += bricksPerWall.get(entry.wallId) ?? 0
  }

  return {
    wallCount: walls.length,
    openingCount: openings.length,
    totalLinealMm,
    totalAreaSqMm,
    brickCount,
    bricksByType: finalBricksByType,
    headLinealMmByType,
    sillLinealMmByType,
    headLinealMmByMakeup,
    sillLinealMmByMakeup,
    courseSubstituteLinealMmByType,
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
