/**
 * WorkspaceView3D — Tier 1 mass-model 3D view of the project.
 *
 * Lazy-loaded behind the workspace's 2D ↔ 3D toggle so users who never open
 * 3D pay zero bundle cost. The 2D Konva workspace stays the source of truth
 * for editing; this view is read-only — orbit camera, no interaction with
 * walls.
 *
 * Coordinate system:
 *   Plan-view (mm)      → 3D (m, Y-up)
 *   wall.startX/.startY → X / Z (Z negated so "up in plan" = "back in 3D")
 *   wall height (mm)    → Y
 *
 * Per-wall rendering (block walls):
 *   Each wall is decomposed into bands (convertMakeupToBands) and each
 *   band is rendered course-by-course. For every course we emit three
 *   regions: a left end-cap, a body slab in the middle, and a right
 *   end-cap. The end-cap code alternates per course in stretcher bond
 *   (corner block on odd courses, half block on even) and is uniform in
 *   stack bond (corner block every course). All three regions are tinted
 *   by their own block code's colour using the same distinct-colour
 *   palette as the 2D wall-type preview — so "the green one is 20.45"
 *   in the legend maps to the same green stripes in 3D, and corner
 *   blocks (e.g. 20.01) read as a different colour at the ends.
 *
 *   Brick walls render as a single solid extrusion — per-course brick
 *   banding is a v2 follow-up.
 *
 * Openings (windows + doors) cut by splitting each course's BODY slab
 * into left-of-opening / right-of-opening sub-spans. End-caps are not
 * cut — openings within a corner-block-width of a wall end are rare
 * (typical layouts leave structural space at corners). Sill / head
 * fills behind partially-crossing openings use the body colour at the
 * course's y-position.
 *
 * Curved walls sample the arc into N straight segments and run each
 * through the per-course renderer. No openings on curved walls in v1.
 *
 * Battery-friendly defaults:
 *   - frameloop="demand" — frames only render on camera interaction.
 *   - Pixel ratio capped at 1.5 — no Retina-density rendering.
 *   - One directional light, no shadows. Fine for a mass model.
 */
import { Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { Canvas } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import * as THREE from 'three'
import type { Wall, Opening, WallMakeup, BrickMakeup } from '../types/walls'
import type { ProjectArea } from '../lib/projectStorage'
import type { Block, BlockCode } from '../types/blocks'
import { arcFromThreePoints, sampleArc, isCurvedWall } from '../lib/curveGeom'
import {
  convertMakeupToBands,
  moduleHeightForBand,
  resolveCourseBlocks,
} from '../lib/makeups'
import { buildBlockColorMap } from '../lib/blockColors'
import { selectBlockLintel } from '../lib/lintels'

// ---------- Constants ----------

const FALLBACK_HEIGHT_MM = 2400
const DEFAULT_WALL_COLOR = '#cdb697'
const GROUND_COLOR = '#3a3f48'
const CURVE_SAMPLES = 24

/** Fallback widths (mm) when the library doesn't carry the block. AU
 *  defaults — full end 20.01 ≈ 390mm, half end 20.03 ≈ 190mm. */
const FALLBACK_CORNER_WIDTH_MM = 390
const FALLBACK_HALF_WIDTH_MM = 190
const FALLBACK_BODY_WIDTH_MM = 390

/** Visible mortar gap (m) inset on every block's right + top edges so
 *  adjacent blocks have a small gap between them, producing the visual
 *  of discrete blocks separated by mortar joints. 10mm matches the
 *  actual mortar joint thickness used in the rest of the app's modular
 *  math. Half is inset on each box's edge, so the gap between adjacent
 *  boxes ends up at the full 10mm. */
const MORTAR_GAP_M = 0.01

/** Mortar fill colour — warm medium-grey reading as cement between the
 *  block faces. Renders behind each block course so the gaps between
 *  blocks show mortar rather than empty space (the dark wrapper bg). */
const MORTAR_COLOR = '#6a635a'

/** Fraction of wall thickness the mortar layer occupies. Less than 1.0
 *  means the mortar is RECESSED — set inside the wall slightly so block
 *  faces sit visually proud of the mortar (matches real masonry where
 *  blocks protrude a few mm beyond the mortar plane). */
const MORTAR_THICKNESS_FRAC = 0.85

// ---------- Props ----------

export interface WorkspaceView3DProps {
  walls: Wall[]
  openings: Opening[]
  makeupsById: Record<string, WallMakeup>
  brickMakeupsById: Record<string, BrickMakeup>
  wallThicknessByWallId: Record<string, number>
  areas: ProjectArea[]
  library: Record<string, Block>
}

// ---------- Helpers ----------

function resolveWallHeightMm(
  wall: Wall,
  makeupsById: Record<string, WallMakeup>,
  brickMakeupsById: Record<string, BrickMakeup>
): number {
  if (typeof wall.heightMmOverride === 'number') return wall.heightMmOverride
  if (wall.trade === 'brick') {
    return brickMakeupsById[wall.makeupId]?.heightMm ?? FALLBACK_HEIGHT_MM
  }
  return makeupsById[wall.makeupId]?.heightMm ?? FALLBACK_HEIGHT_MM
}

/** Look up a block's face width (mm), falling back to the AU default. */
function widthOf(code: BlockCode | undefined, library: Record<string, Block>, fallback: number): number {
  if (!code) return fallback
  return library[code]?.dimensions.widthMm ?? fallback
}

/**
 * One course of the wall — body + corner + half codes already resolved
 * against the makeup's series ranges. y0/y1 are the course's world-space
 * vertical band (in metres).
 */
interface ResolvedCourse {
  /** 1-indexed from the base of the wall. */
  courseNumber: number
  /** World-space y range in metres. */
  y0: number
  y1: number
  /** Resolved per-course codes (body, corner, half). */
  bodyCode: BlockCode
  cornerCode: BlockCode
  halfCode: BlockCode
}

/**
 * Resolve a wall's course-by-course composition.
 *
 * Walks the makeup's band stack (via convertMakeupToBands) bottom-up and
 * expands each band into its individual courses, then runs each course
 * through resolveCourseBlocks so series-range overrides take effect
 * (e.g. courses 1-5 use 300-series corners). Heights in metres.
 */
function resolveWallCourses(
  wall: Wall,
  makeupsById: Record<string, WallMakeup>,
  library: Record<string, Block>
): { courses: ResolvedCourse[]; totalHeightM: number; makeup: WallMakeup | undefined } {
  const makeup = makeupsById[wall.makeupId]
  const heightMm =
    typeof wall.heightMmOverride === 'number'
      ? wall.heightMmOverride
      : makeup?.heightMm ?? FALLBACK_HEIGHT_MM
  const totalHeightM = heightMm / 1000

  if (!makeup) {
    return { courses: [], totalHeightM, makeup: undefined }
  }
  // Clone with override so band counts size to the wall's actual height.
  const scopedMakeup: WallMakeup =
    typeof wall.heightMmOverride === 'number'
      ? { ...makeup, heightMm: wall.heightMmOverride }
      : makeup
  const { bands } = convertMakeupToBands(scopedMakeup, undefined, {
    skipHeightMakeup: true,
  })

  const courses: ResolvedCourse[] = []
  let y = 0
  let courseNum = 1
  for (const band of bands) {
    if (band.count <= 0) continue
    const courseHeightM = moduleHeightForBand(band.blockCode, library) / 1000
    for (let i = 0; i < band.count; i++) {
      const resolved = resolveCourseBlocks(scopedMakeup, courseNum)
      courses.push({
        courseNumber: courseNum,
        y0: y,
        y1: y + courseHeightM,
        // Series-range body overlays the band's body code. Bands come
        // from the makeup's coursePattern (or defaults), but series
        // ranges can replace it for specific course ranges.
        bodyCode: resolved.bodyBlockCode || band.blockCode,
        cornerCode: resolved.cornerBlockCode,
        halfCode: resolved.halfBlockCode,
      })
      y += courseHeightM
      courseNum++
    }
  }
  // Pad shortfall (rare — happens when course heights don't tile evenly
  // to the wall height) so the wall still reaches its target height.
  if (y < totalHeightM - 0.001 && courses.length > 0) {
    courses[courses.length - 1].y1 = totalHeightM
  } else if (courses.length === 0) {
    courses.push({
      courseNumber: 1,
      y0: 0,
      y1: totalHeightM,
      bodyCode: makeup.bodyBlockCode,
      cornerCode: makeup.cornerBlockCode,
      halfCode: makeup.halfBlockCode ?? '20.03',
    })
  }
  return { courses, totalHeightM, makeup }
}

/** One Three.js-ready sub-box descriptor. Coordinates in metres, Y-up. */
interface WallSegmentBox {
  cx: number
  cy: number
  cz: number
  length: number
  heightM: number
  thickness: number
  yRotation: number
  color: string
  /** True for specialty blocks (cleanout, knockout, lintel, curve wedge,
   *  bond beam). Renders with an emissive glow so they stand out from
   *  the body / corner / half blocks that make up the bulk of the wall. */
  highlight: boolean
}

/**
 * Decide whether a given block code should be visually highlighted in
 * the 3D view. Used to make specialty blocks (the ones with a specific
 * structural purpose — cleanouts, knockouts, lintels, bond-beam tops,
 * curve wedges) stand out from the regular body / corner / half blocks.
 *
 * Detection is two-pronged:
 *   1. ROLE — base-course, base-tile, lintel, top-course, curve-tight.
 *      Catches block codes the library has tagged for these roles.
 *   2. NAME pattern — anything containing Knockout / Cleanout / Lintel /
 *      Wedge / Bond Beam in its name. Catches blocks like 20.21 (Knockout
 *      Corner) whose role is just 'corner' but whose NAME identifies it
 *      as a specialty piece.
 */
const HIGHLIGHT_ROLES = new Set([
  'base-course',
  'base-tile',
  'lintel',
  'top-course',
  'curve-tight',
])
const HIGHLIGHT_NAME_RE = /knockout|cleanout|lintel|wedge|bond.?beam/i

function isHighlightedBlock(
  code: BlockCode,
  library: Record<string, Block>
): boolean {
  if (!code) return false
  const block = library[code]
  if (!block) return false
  if (block.roles.some((r) => HIGHLIGHT_ROLES.has(r))) return true
  if (HIGHLIGHT_NAME_RE.test(block.name)) return true
  return false
}

/**
 * Emit sub-boxes for a single straight wall.
 *
 * Per course:
 *   1. Decide which block ends each course (corner on odd / stretcher
 *      stack-bond, half on even / stretcher) and pick its colour + width.
 *   2. Emit left end-cap.
 *   3. Emit the body in the middle (inset by end-cap width from each
 *      end), split by any openings that overlap this course's y-range.
 *      Body uses the course's resolved body code colour.
 *   4. Emit right end-cap.
 *
 * Opening sill / head bands are filled with the body code colour at the
 * relevant course — so the visual reads as "the wall behind the
 * window is still that course's body block".
 */
function segmentsForStraightWall(
  wall: Wall,
  openings: Opening[],
  thicknessMm: number,
  courses: ResolvedCourse[],
  totalHeightM: number,
  bondType: 'stretcher' | 'stack',
  colorMap: Map<string, string>,
  library: Record<string, Block>
): WallSegmentBox[] {
  // Negate BOTH X and Y in the plan → 3D mapping. The Y negation was
  // there from day 1 ("plan down" = "3D back"); the X negation mirrors
  // the model so its on-screen left/right matches the plan's left/right
  // when viewed from the camera's +X+Y+Z corner. Without it the camera
  // angle would show plan-left walls on screen-right (and vice versa)
  // because we're looking from the building's right side back toward
  // its left.
  const sx = -wall.startX / 1000
  const sz = -wall.startY / 1000
  const ex = -wall.endX / 1000
  const ez = -wall.endY / 1000
  const dx = ex - sx
  const dz = ez - sz
  const length = Math.hypot(dx, dz)
  if (length === 0 || courses.length === 0) return []
  const yRotation = Math.atan2(-dz, dx)
  const thickness = thicknessMm / 1000
  const dirX = dx / length
  const dirZ = dz / length

  // Pre-process openings on this wall — local s0..s1 in metres + sill/head.
  const wallOpenings = openings
    .filter((o) => o.wallId === wall.id)
    .map((o) => ({
      start: Math.max(0, o.startAlongWallMm / 1000),
      end: Math.min(length, (o.startAlongWallMm + o.widthMm) / 1000),
      sill: Math.max(0, o.sillHeightMm / 1000),
      head: Math.min(totalHeightM, (o.sillHeightMm + o.heightMm) / 1000),
    }))
    .filter((o) => o.end > o.start && o.head > o.sill)
    .sort((a, b) => a.start - b.start)

  const colorOf = (code: BlockCode) => colorMap.get(code) ?? DEFAULT_WALL_COLOR
  const boxes: WallSegmentBox[] = []

  /** Build a centred box from a span along local X (s0..s1, metres from
   *  wall start) and a vertical band (y0..y1, metres from base). The
   *  `code` argument is the block code this box represents — used to
   *  flag specialty blocks (cleanout, knockout, lintel, etc.) for the
   *  emissive glow highlight.
   *
   *  Box dimensions are inset by MORTAR_GAP_M on both axes so adjacent
   *  blocks have a visible mortar joint between them. The box stays
   *  CENTRED on the requested span — the inset just makes it slightly
   *  smaller on each side. */
  const buildBox = (
    s0: number,
    s1: number,
    y0: number,
    y1: number,
    color: string,
    code: BlockCode
  ): WallSegmentBox => {
    const localCx = (s0 + s1) / 2
    return {
      cx: sx + dirX * localCx,
      cy: (y0 + y1) / 2,
      cz: sz + dirZ * localCx,
      length: Math.max(0.001, s1 - s0 - MORTAR_GAP_M),
      heightM: Math.max(0.001, y1 - y0 - MORTAR_GAP_M),
      thickness,
      yRotation,
      color,
      highlight: isHighlightedBlock(code, library),
    }
  }

  /** Walk a horizontal span [spanStart, spanEnd] and emit one box per
   *  body block, ALIGNED to the course's natural block grid anchored
   *  at `gridOrigin`. The block width comes from the library so a
   *  290mm block stays 290mm in 3D.
   *
   *  Why grid alignment matters: head-fill / sill-fill spans don't
   *  start at the course's natural body-block boundary — they start
   *  at the opening's edge. Without grid alignment, head-fill blocks
   *  would start at the opening edge regardless of the course's bond,
   *  making every course above an opening look like stack bond (rows
   *  aligned) even when the wall is stretcher.
   *
   *  Grid origin = the course's end-cap width (cornerW on odd courses,
   *  halfW on even). Body blocks naturally start at that offset and
   *  step by bodyW. By computing block boundaries relative to that
   *  origin (not the span start), head-fill blocks line up with the
   *  rest of the course's bond — including the stretcher offset that
   *  makes even / odd courses staircase. Blocks at the span edges are
   *  clipped to [spanStart, spanEnd] so partial blocks show as cuts
   *  (matching real masonry where the bricklayer cuts a block at an
   *  opening edge). */
  const emitBlocksInSpan = (
    spanStart: number,
    spanEnd: number,
    y0: number,
    y1: number,
    bodyCode: BlockCode,
    bodyColor: string,
    bodyW: number,
    gridOrigin: number
  ) => {
    // First grid line at or before spanStart.
    const firstIdx = Math.floor((spanStart - gridOrigin) / bodyW)
    let cursor = gridOrigin + firstIdx * bodyW
    while (cursor < spanEnd) {
      const blockEnd = Math.min(cursor + bodyW, spanEnd)
      const blockStart = Math.max(cursor, spanStart)
      const blockWidth = blockEnd - blockStart
      if (blockWidth > 0.02) {
        boxes.push(
          buildBox(blockStart, blockEnd, y0, y1, bodyColor, bodyCode)
        )
      }
      cursor += bodyW
    }
  }

  /** Pre-compute lintel info per opening — for each opening, the lintel
   *  block code and which course (1-indexed from bottom) the lintel sits
   *  in. Lintel course = the FIRST course whose bottom is at or above
   *  the opening's head height. Null when the library has no lintel
   *  block tagged. */
  const wallHeightMm = totalHeightM * 1000
  const lintelByOpening = wallOpenings.map((op) => {
    const headHeightMm = wallHeightMm - op.sill * 1000 - (op.head - op.sill) * 1000
    if (headHeightMm <= 0) return null
    const spec = selectBlockLintel(headHeightMm)
    if (!spec) return null
    const lintelCourse = courses.find((c) => c.y0 >= op.head - 0.001)
    if (!lintelCourse) return null
    return {
      code: spec.code as BlockCode,
      courseNumber: lintelCourse.courseNumber,
      spanStart: op.start,
      spanEnd: op.end,
    }
  })

  /** Push a mortar fill box at the requested span. Bypasses buildBox so
   *  it doesn't get the MORTAR_GAP_M inset (mortar should fill the gaps
   *  between blocks, not have gaps of its own). Renders at recessed
   *  thickness so block faces sit visually proud of the mortar plane. */
  const pushMortar = (s0: number, s1: number, y0: number, y1: number) => {
    if (s1 - s0 < 0.005 || y1 - y0 < 0.005) return
    const localCx = (s0 + s1) / 2
    boxes.push({
      cx: sx + dirX * localCx,
      cy: (y0 + y1) / 2,
      cz: sz + dirZ * localCx,
      length: s1 - s0,
      heightM: y1 - y0,
      thickness: thickness * MORTAR_THICKNESS_FRAC,
      yRotation,
      color: MORTAR_COLOR,
      highlight: false,
    })
  }

  for (const course of courses) {
    const { y0, y1, bodyCode, cornerCode, halfCode } = course

    // Mortar fill for this course — emit BEFORE blocks so they render
    // visually on top (though three.js depth-sorts so order doesn't
    // strictly matter — recessed thickness keeps mortar behind block
    // faces regardless of draw order). Cut by openings that fully span
    // this course's y-range so window/door cutouts don't show mortar.
    const courseSpanningOpenings = wallOpenings
      .filter((o) => o.sill <= y0 && o.head >= y1)
      .sort((a, b) => a.start - b.start)
    if (courseSpanningOpenings.length === 0) {
      pushMortar(0, length, y0, y1)
    } else {
      let mortarCursor = 0
      for (const op of courseSpanningOpenings) {
        if (op.start > mortarCursor) {
          pushMortar(mortarCursor, op.start, y0, y1)
        }
        mortarCursor = Math.max(mortarCursor, op.end)
      }
      if (mortarCursor < length) {
        pushMortar(mortarCursor, length, y0, y1)
      }
    }

    // End-cap pattern: stack bond = corner every course; stretcher =
    // corner on odd courses, half on even. Matches what the 2D preview
    // renders, so the colour distribution reads the same in 3D.
    const useHalf = bondType === 'stretcher' && course.courseNumber % 2 === 0
    const endCode = useHalf ? halfCode : cornerCode
    const endColor = colorOf(endCode)
    const bodyColor = colorOf(bodyCode)
    const endWidthMm = useHalf
      ? widthOf(halfCode, library, FALLBACK_HALF_WIDTH_MM)
      : widthOf(cornerCode, library, FALLBACK_CORNER_WIDTH_MM)
    const endWidth = endWidthMm / 1000

    // Tiny wall (≤ 2 end-caps wide): render the whole course as a
    // single end-coloured box. Avoids negative-width body slabs.
    if (length <= endWidth * 2) {
      boxes.push(buildBox(0, length, y0, y1, endColor, endCode))
      continue
    }

    // Left end-cap.
    boxes.push(buildBox(0, endWidth, y0, y1, endColor, endCode))
    // Right end-cap.
    boxes.push(buildBox(length - endWidth, length, y0, y1, endColor, endCode))

    // Body region: bound by [endWidth, length - endWidth], cut by any
    // openings whose y-range fully covers this course's y-range. Each
    // solid sub-span emits individual body blocks (not one slab) so the
    // bond pattern is visible — stretcher offset emerges from even
    // courses starting at halfW vs odd at cornerW.
    const bodyStart = endWidth
    const bodyEnd = length - endWidth
    const bodyW = widthOf(bodyCode, library, FALLBACK_BODY_WIDTH_MM) / 1000
    const courseOpenings = wallOpenings
      .filter((o) => o.sill <= y0 && o.head >= y1) // opening covers this course
      .map((o) => ({
        s0: Math.max(bodyStart, o.start),
        s1: Math.min(bodyEnd, o.end),
      }))
      .filter((o) => o.s1 > o.s0)
      .sort((a, b) => a.s0 - b.s0)

    // Grid origin for this course's body blocks — anchors emitBlocksInSpan
    // so head / sill fills inherit the course's stretcher offset instead
    // of starting fresh at each opening edge (which made every course
    // above an opening look like stack bond).
    const gridOrigin = endWidth

    // Lintel for the course — if any opening's lintel sits in this
    // course, render the lintel block (single highlighted box) at the
    // opening span and skip body-block emission across that span.
    const lintelsHere = lintelByOpening.filter(
      (l) => l && l.courseNumber === course.courseNumber
    ) as { code: BlockCode; courseNumber: number; spanStart: number; spanEnd: number }[]

    if (courseOpenings.length === 0) {
      emitBlocksInSpan(bodyStart, bodyEnd, y0, y1, bodyCode, bodyColor, bodyW, gridOrigin)
    } else {
      let cursor = bodyStart
      for (const op of courseOpenings) {
        if (op.s0 > cursor) {
          emitBlocksInSpan(cursor, op.s0, y0, y1, bodyCode, bodyColor, bodyW, gridOrigin)
        }
        cursor = Math.max(cursor, op.s1)
      }
      if (cursor < bodyEnd) {
        emitBlocksInSpan(cursor, bodyEnd, y0, y1, bodyCode, bodyColor, bodyW, gridOrigin)
      }
    }

    // Sill + head fills for partially-crossing openings at this course.
    // Body colour fills the portion of the opening's span that falls
    // ABOVE the opening's head OR BELOW its sill, at this course's
    // y-range. So a 1200mm-high window leaves the courses below the
    // sill + above the head solid behind it. Pass gridOrigin so the
    // visible blocks line up with the rest of the course's bond
    // (stretcher offset propagates above/below openings correctly).
    //
    // Skips opening spans where a lintel sits in this course — the
    // lintel render below replaces the head fill at that span.
    const lintelSpans = lintelsHere.map((l) => ({ s0: l.spanStart, s1: l.spanEnd }))
    const skipLintelSpans = (s0: number, s1: number, ...args: [number, number, BlockCode, string, number, number]) => {
      // Emit blocks in [s0, s1] except where a lintel covers this course.
      const sortedLintels = lintelSpans
        .filter((l) => l.s1 > s0 && l.s0 < s1)
        .sort((a, b) => a.s0 - b.s0)
      if (sortedLintels.length === 0) {
        emitBlocksInSpan(s0, s1, ...args)
        return
      }
      let cur = s0
      for (const l of sortedLintels) {
        if (l.s0 > cur) emitBlocksInSpan(cur, Math.min(l.s0, s1), ...args)
        cur = Math.max(cur, l.s1)
      }
      if (cur < s1) emitBlocksInSpan(cur, s1, ...args)
    }
    for (const op of wallOpenings) {
      // Slice of this course that lies BELOW op.sill: course is below
      // the opening.
      if (op.sill > y0 && op.sill < y1) {
        // Course straddles the sill — render solid up to the sill line.
        const fillTop = Math.min(y1, op.sill)
        if (fillTop > y0) {
          skipLintelSpans(op.start, op.end, y0, fillTop, bodyCode, bodyColor, bodyW, gridOrigin)
        }
      } else if (op.sill >= y1) {
        // Course is fully below the sill — fill the opening span solid.
        skipLintelSpans(op.start, op.end, y0, y1, bodyCode, bodyColor, bodyW, gridOrigin)
      }
      // Slice of this course that lies ABOVE op.head.
      if (op.head > y0 && op.head < y1) {
        const fillBottom = Math.max(y0, op.head)
        if (fillBottom < y1) {
          skipLintelSpans(op.start, op.end, fillBottom, y1, bodyCode, bodyColor, bodyW, gridOrigin)
        }
      } else if (op.head <= y0) {
        // Course is fully above the head — fill the opening span solid.
        skipLintelSpans(op.start, op.end, y0, y1, bodyCode, bodyColor, bodyW, gridOrigin)
      }
    }

    // Lintel render — single box per lintel at its opening span,
    // exactly one course tall, using the lintel block's code (which
    // is highlighted via emissive thanks to isHighlightedBlock).
    for (const l of lintelsHere) {
      const lintelColor = colorOf(l.code)
      boxes.push(buildBox(l.spanStart, l.spanEnd, y0, y1, lintelColor, l.code))
    }
  }

  return boxes
}

/**
 * Curved-wall variant. Samples the arc into N straight segments and
 * runs each through the straight-wall builder with no openings.
 */
function segmentsForCurvedWall(
  wall: Wall,
  thicknessMm: number,
  courses: ResolvedCourse[],
  totalHeightM: number,
  bondType: 'stretcher' | 'stack',
  colorMap: Map<string, string>,
  library: Record<string, Block>
): WallSegmentBox[] {
  if (wall.midX === undefined || wall.midY === undefined) return []
  const geom = arcFromThreePoints(
    { x: wall.startX, y: wall.startY },
    { x: wall.midX, y: wall.midY },
    { x: wall.endX, y: wall.endY }
  )
  if (!geom) {
    return segmentsForStraightWall(
      wall, [], thicknessMm, courses, totalHeightM, bondType, colorMap, library
    )
  }
  const samples = sampleArc(geom, CURVE_SAMPLES + 1)
  const boxes: WallSegmentBox[] = []
  for (let i = 0; i < samples.length - 1; i++) {
    const a = samples[i]
    const b = samples[i + 1]
    const fakeWall: Wall = {
      ...wall,
      startX: a.x,
      startY: a.y,
      endX: b.x,
      endY: b.y,
    }
    boxes.push(
      ...segmentsForStraightWall(
        fakeWall, [], thicknessMm, courses, totalHeightM, bondType, colorMap, library
      )
    )
  }
  return boxes
}

// ---------- Scene ----------

function Scene({
  walls,
  openings,
  makeupsById,
  brickMakeupsById,
  wallThicknessByWallId,
  library,
}: Omit<WorkspaceView3DProps, 'areas'>) {
  const { segments, segmentBounds } = useMemo(() => {
    // First pass: resolve each wall's per-course composition so we know
    // every block code (body + corner + half) that'll appear in the 3D
    // view. Pass the complete set to buildBlockColorMap so every code
    // lands on a distinct palette slot — same logic as the 2D preview.
    const wallResolutions = walls.map((wall) => {
      if (wall.trade === 'brick') return null
      return resolveWallCourses(wall, makeupsById, library)
    })
    const allCodes: string[] = []
    for (const wr of wallResolutions) {
      if (!wr) continue
      for (const c of wr.courses) {
        allCodes.push(c.bodyCode, c.cornerCode, c.halfCode)
      }
    }
    // Lintel codes — collected for every opening on a block wall so the
    // lintel block gets its own distinct palette slot. selectBlockLintel
    // resolves per opening's head height; null if the library carries
    // no lintel-tagged block.
    for (const wall of walls) {
      if (wall.trade === 'brick') continue
      const heightMm =
        typeof wall.heightMmOverride === 'number'
          ? wall.heightMmOverride
          : makeupsById[wall.makeupId]?.heightMm ?? FALLBACK_HEIGHT_MM
      const wallOpenings = openings.filter((o) => o.wallId === wall.id)
      for (const op of wallOpenings) {
        const headHeightMm = heightMm - op.sillHeightMm - op.heightMm
        if (headHeightMm <= 0) continue
        const spec = selectBlockLintel(headHeightMm)
        if (spec) allCodes.push(spec.code)
      }
    }
    const colorMap = buildBlockColorMap(allCodes)

    const out: WallSegmentBox[] = []
    walls.forEach((wall, i) => {
      const thicknessMm = wallThicknessByWallId[wall.id] ?? 190

      if (wall.trade === 'brick') {
        // Brick walls render as one solid extrusion for v1. Per-course
        // banding (BrickMakeup.courseRanges) is a follow-up.
        const heightMm = resolveWallHeightMm(wall, makeupsById, brickMakeupsById)
        const totalHeightM = heightMm / 1000
        const solidCourse: ResolvedCourse[] = [
          {
            courseNumber: 1,
            y0: 0,
            y1: totalHeightM,
            bodyCode: '__brick__',
            cornerCode: '__brick__',
            halfCode: '__brick__',
          },
        ]
        const brickColorMap = new Map([['__brick__', DEFAULT_WALL_COLOR]])
        out.push(
          ...segmentsForStraightWall(
            wall, openings, thicknessMm, solidCourse, totalHeightM,
            'stack', brickColorMap, library
          )
        )
        return
      }

      const wr = wallResolutions[i]
      if (!wr || !wr.makeup) return
      const bondType = wr.makeup.bondType
      if (isCurvedWall(wall)) {
        out.push(
          ...segmentsForCurvedWall(
            wall, thicknessMm, wr.courses, wr.totalHeightM,
            bondType, colorMap, library
          )
        )
      } else {
        out.push(
          ...segmentsForStraightWall(
            wall, openings, thicknessMm, wr.courses, wr.totalHeightM,
            bondType, colorMap, library
          )
        )
      }
    })

    // Bounds for ground plane + orbit target.
    let bounds: { centerX: number; centerZ: number; sizeMax: number } = {
      centerX: 0,
      centerZ: 0,
      sizeMax: 20,
    }
    if (out.length > 0) {
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity
      for (const s of out) {
        const r = Math.max(s.length, s.thickness) / 2
        minX = Math.min(minX, s.cx - r)
        maxX = Math.max(maxX, s.cx + r)
        minZ = Math.min(minZ, s.cz - r)
        maxZ = Math.max(maxZ, s.cz + r)
      }
      bounds = {
        centerX: (minX + maxX) / 2,
        centerZ: (minZ + maxZ) / 2,
        sizeMax: Math.max(maxX - minX, maxZ - minZ, 4),
      }
    }
    return { segments: out, segmentBounds: bounds }
  }, [walls, openings, makeupsById, brickMakeupsById, wallThicknessByWallId, library])

  return (
    <>
      <ambientLight intensity={0.6} />
      <directionalLight position={[10, 20, 10]} intensity={0.8} />

      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[segmentBounds.centerX, -0.001, segmentBounds.centerZ]}
      >
        <planeGeometry args={[segmentBounds.sizeMax * 4, segmentBounds.sizeMax * 4]} />
        <meshStandardMaterial color={GROUND_COLOR} />
      </mesh>

      {/* One mesh per wall sub-box. Per-course rendering means ~5x more
          meshes than band rendering, but with ~30 walls × 13 courses ×
          ~3 cells = ~1200 meshes the cost is still fine on integrated
          GPUs. InstancedMesh by colour collapses this to ~16 draw calls
          if a busier project warrants. */}
      {segments.map((s, i) => (
        <mesh key={i} position={[s.cx, s.cy, s.cz]} rotation={[0, s.yRotation, 0]}>
          <boxGeometry args={[s.length, s.heightM, s.thickness]} />
          {/* Highlighted specialty blocks (cleanout / knockout / lintel /
              curve wedge / bond beam) emit a glow of their own colour so
              they stand out from the body / corner blocks around them.
              Regular blocks render with a flat standard material. */}
          {s.highlight ? (
            <meshStandardMaterial
              color={s.color}
              emissive={s.color}
              emissiveIntensity={0.45}
            />
          ) : (
            <meshStandardMaterial color={s.color} />
          )}
        </mesh>
      ))}

      <OrbitControls
        target={[segmentBounds.centerX, 1, segmentBounds.centerZ]}
        enableDamping
        dampingFactor={0.1}
        makeDefault
      />
    </>
  )
}

// ---------- Top-level export ----------

export default function WorkspaceView3D(props: WorkspaceView3DProps) {
  const { walls } = props

  const initialCamera = useMemo<[number, number, number]>(() => {
    if (walls.length === 0) return [10, 12, 10]
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity
    for (const w of walls) {
      // Mirror X to match the negation in segmentsForStraightWall so
      // the bounding box (and therefore the camera target) lines up
      // with where the walls actually render.
      const sx = -w.startX / 1000, sz = -w.startY / 1000
      const ex = -w.endX / 1000, ez = -w.endY / 1000
      minX = Math.min(minX, sx, ex)
      maxX = Math.max(maxX, sx, ex)
      minZ = Math.min(minZ, sz, ez)
      maxZ = Math.max(maxZ, sz, ez)
    }
    const cx = (minX + maxX) / 2
    const cz = (minZ + maxZ) / 2
    const sizeMax = Math.max(maxX - minX, maxZ - minZ, 4)
    const dist = sizeMax * 0.9 + 6
    return [cx + dist * 0.7, dist * 0.8, cz + dist * 0.7]
  }, [walls])

  if (walls.length === 0) {
    return (
      <div className="w-full h-full flex items-center justify-center text-ink-400 text-sm">
        Draw a wall on the 2D view to see it here.
      </div>
    )
  }

  return (
    // Explicit pixel sizing via ResizeObserver — r3f's Canvas auto-sizing
    // was leaving the rendered surface smaller than its container under
    // certain initial-layout conditions (visible as wrapper bg showing
    // around a too-small Canvas). We measure the wrapper div ourselves
    // and pass explicit width/height pixels to Canvas's `style`, which
    // it then uses to size the WebGL canvas exactly to our measured
    // dimensions. ResizeObserver keeps it in sync on viewport resize.
    <SizedCanvasShell>
      {(width, height) => (
        <Canvas
          frameloop="demand"
          dpr={[1, 1.5]}
          camera={{ position: initialCamera, fov: 45, near: 0.1, far: 5000 }}
          shadows={false}
          gl={{ antialias: true, powerPreference: 'high-performance' }}
          onCreated={({ gl }) => {
            gl.setClearColor(new THREE.Color('#1a1d24'))
          }}
          style={{ width, height, display: 'block' }}
        >
          <Suspense fallback={null}>
            <Scene {...props} />
          </Suspense>
        </Canvas>
      )}
    </SizedCanvasShell>
  )
}

/**
 * Measures its own rendered size via ResizeObserver and passes pixel
 * width + height as render-prop arguments. Used to give the r3f Canvas
 * inside an explicit pixel size — without this, Canvas was occasionally
 * rendering at the parent's INITIAL measured size (which could be a
 * fraction of the final flex-resolved size if the observer fires
 * before layout settles), leaving the wrapper's bg visible around it.
 *
 * Renders nothing until the first measurement comes back (avoids a
 * 0×0 Canvas mount that then has to resize on next frame).
 */
function SizedCanvasShell({
  children,
}: {
  children: (width: number, height: number) => React.ReactNode
}) {
  const ref = useRef<HTMLDivElement | null>(null)
  const [size, setSize] = useState<{ w: number; h: number } | null>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0].contentRect
      // Round to integer pixels — sub-pixel widths/heights can confuse
      // WebGL's framebuffer sizing.
      const w = Math.floor(rect.width)
      const h = Math.floor(rect.height)
      if (w > 0 && h > 0) setSize({ w, h })
    })
    observer.observe(el)
    // Initial measurement before observer fires (some browsers wait for
    // the first layout pass).
    const rect = el.getBoundingClientRect()
    if (rect.width > 0 && rect.height > 0) {
      setSize({ w: Math.floor(rect.width), h: Math.floor(rect.height) })
    }
    return () => observer.disconnect()
  }, [])

  return (
    <div ref={ref} className="absolute inset-0">
      {size ? children(size.w, size.h) : null}
    </div>
  )
}
