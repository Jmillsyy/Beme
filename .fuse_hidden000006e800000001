# Session notes — 2 June 2026

**Branch:** `dev`
**Headline:** Per-course corner-ownership body fit for blocks + brick 3D rendering (bricks as proper stacked units, plan-as-floor in 3D, mortar joints for both bricks and blocks, brick corner ownership with cut bricks, auto lead-in detection for 300-series blocks). Also miscellaneous 3D view polish (camera fit, sky/ground colour, padding).

To sync on another machine: `git fetch && git checkout dev && git pull`.

## What changed (newest first)

### Auto lead-in detection for 300-series blocks (and any series where corner ≠ cube + half-body)

New `resolveLeadInForWall(wall, makeup)` helper in `WorkspaceView3D.tsx`. Computes `requiredLeadInModular = body_modular/2 − (corner_width − cube_depth)`. For 200-series this is 0 (no lead-in needed). For 300-series (corner 390, cube 290, body 390+10) it's 100mm modular → 90mm block width.

If the gap is >5mm and the library has a block within ±15mm of the required width (excluding the body/corner block), it returns an override makeup with `cornerLeadInBlockCode` + `cornerLeadInCount: 1` set. `planWallLayout` then emits the lead-in on owning courses between the corner block and body — same code path as a hand-configured lead-in. Currently scoped to the no-openings path (which uses `planWallLayout`); walls with openings still go through the legacy `segmentsForStraightWall` path and aren't lead-in-aware yet.

Dev-time `[lead-in detect] wall=…` console.log shows what the helper sees (library candidates, picked match, whether the override fires).

### Brick walls in 3D — proper brick-sized units, stretcher bond, corner ownership

Brick branch in `WorkspaceView3D.tsx` rewritten:

- Looks up real brick dimensions from `BRICK_LIBRARY[brickTypeCode]` — standard 230×76×110, maxi 290×90×110, double-height 230×162×110, half-height 230×38×110, or whatever the user has defined. Falls back to AU standard 230×76×110 for unknown codes.
- Generates one course per brick row at `brickHeight + 10mm mortar` interval (~86mm course modular for standard). Bottom-up, top course trimmed to fit any leftover height.
- Three synthetic library entries injected via library spread: `__brick__` (full), `__brick_half__` (half — used as `halfCode` for free-end stretcher alternation), `__brick_cube__` (corner-cut — `widthMm = thicknessMm`, used as `cornerCode` on non-owning corner courses to alternate corner ownership without confusing free-end alternation).
- `bondType: 'stretcher'`, palette from `bandColor(brickTypeCode)` (same 16-slot grey palette blocks use).
- **Fudged thickness map for cube-depth lookup**: builds a per-call `brickCubeThicknessMap` where every brick wall's thickness is reported as `brickWidth/2` (= 115mm for standard) instead of its real depth (110mm). `segmentsForStraightWall` then uses 115mm as the cube depth on non-owning corner courses → body grid offset = `230 − 115 = 115mm = exactly half a brick`, restoring perfect stretcher bond at corners. Real box geometry stays 110mm because that's passed via the separate `thicknessMm` parameter.

Per-course `cornerCode` swap (full ↔ cube-cut) only applied when BOTH ends of the wall are corner junctions, so free-end stretcher alternation isn't disturbed.

### Opening defaults for brick walls

The 2D opening tool only captures width × height for brick openings (no explicit vertical position). The brick branch overrides `sillHeightMm` per opening to `max(0, wall_height − 300 − opening_height)` so the head sits 300mm below wall top — sensible window/door placement.

Additionally, brick courses are split at every opening sill/head boundary so `segmentsForStraightWall`'s carve logic (which only fires when a course is fully inside an opening's sill→head range) actually carves partial-height openings correctly.

### Mortar joints between bricks AND blocks

New `emitMortarForWall(wall, thicknessMm, totalHeightM, wallOpenings)` helper in `WorkspaceView3D.tsx`. Pushes a mortar-coloured (`#6a635a`) box recessed in depth via `MORTAR_THICKNESS_FRAC` (= 88% of wall depth) so block/brick faces sit visually proud of it. The 3mm half-gap inset on every block/brick edge that faces a neighbour produces 6mm gaps between adjacent units → mortar plane visible through those gaps.

Inset 6mm from the outer wall envelope on every edge (s=0, s=wallLen, y=0, y=totalHeight) so the box's side/top/bottom faces tuck behind the block/brick faces (which span the full envelope with no inset there). Without this inset, the mortar's side faces are coplanar with the brick top / outer-end faces and read as mortar-coloured strips at the wall corners / along the top from any 3/4 view angle.

Openings: emitted as horizontal bands split at every opening y-boundary; strips within each band skip s-ranges covered by openings fully spanning the band. Opening cavities stay empty instead of showing the warm-grey mortar plane through the void.

Called from both the brick branch and the block branch (for straight walls). Curved walls skip mortar for now.

### Per-course corner-ownership body fit (`blockCalc.ts`)

`planWallLayout` and `calculateWallTally` now both compute the body fit PER COURSE based on per-course corner ownership at each end. Previously the fit was parity-only:

- Owning both ends: `body_region_modular = outer − 800` → 5 bodies + ~220mm fraction
- Owning one end: `body_region_modular = outer − 600` → 6 bodies (exact)
- Owning neither end: `body_region_modular = outer − 400` → 6 bodies + ~210mm fraction

Without the per-course fit, a single body count (based on the both-ends-owning case) was used for every course, producing visible sliding gaps along the wall on courses where this wall didn't own one or both corners. The fix computes effective end modular per course (`corner_block_modular` when owning, `cube_depth + mortar` when not) and re-fits.

`calculateWallTally` gained an optional `cornerOwnership` param. `calculateProjectTally` passes `cornerOwnershipFor(wall)` for every wall — so the EXPORT tally now reflects the corrected body counts too. Tally goes up by ~1 body block per non-owning corner end per course (e.g. ~20 H blocks on a 10-course 4-wall box).

`blockExport.ts` per-makeup and per-page tally callers also pass `cornerOwnershipFor(w)` so the breakdown and per-page totals stay consistent with the project total.

### Plan-as-floor in 3D

`WorkspaceView3D.tsx` now optionally accepts `pdfFile`, `currentPageNumber`, `pageWidthMm`, `pageHeightMm`, `pageScaleRatio` from `PdfWorkspace.tsx`. When all are supplied:

1. Rasterises the current PDF page at 2× via `rasterisePdfPage`
2. Loads into a 2D canvas, walks pixels, threshold-converts to a B&W wireframe: dark pixels (< 200 grayscale) → light grey `(200,200,200)`, light pixels → canvas-bg `(26,29,36)` so the page white visually disappears
3. Wraps in a `THREE.CanvasTexture` with `wrapS/wrapT = RepeatWrapping`, `repeat = (-1, -1)`, `offset = (1, 1)` to rotate the texture sampling 180° — needed because the 3D renderer negates wall X and Y coordinates
4. Renders as a horizontal plane sized to `page_mm × scale_ratio` (real-world footprint), positioned with centre at `(-w/2, -0.015, -h/2)` so the plan's top-left corner lands at world (0,0) — every wall in 3D sits directly on top of its 2D-drawn position
5. Plane material is `meshBasicMaterial` with `toneMapped: false` so the B&W threshold colours render unchanged by scene lighting; `DoubleSide` so the rotation direction doesn't matter

Dark ground plane skipped when the plan texture is mounted (would z-fight and be visually identical underneath anyway). PdfWorkspace passes through the new props.

### Camera fit tightened + ground colour matches sky

- Initial camera and F-fit both use `Math.max(sizeX, sizeZ)` (not diagonal) with multiplier `0.55` (was `1.1`). Building reads ~2× larger and fills the canvas.
- `GROUND_COLOR` changed from `#3a3f48` (visible lighter grey) → `#1a1d24` (matches canvas clear colour). Horizon line disappears; viewport reads as one continuous dark surface. Plane geometry still there for raycast hits (scroll-zoom-to-cursor needs something to land on past the building).

### Misc

- Padding round in `PdfWorkspace.tsx`: temporarily reduced `px-20 pt-2 pb-4` → `px-3 pt-2 pb-1` to test wider workspace, reverted to original after user feedback.
- `cornerOwnershipFor(wall)` imported into `WorkspaceView3D.tsx` for use in the auto lead-in detection and brick corner-ownership swap.

## Where to look

- **Per-course body fit** — `src/lib/blockCalc.ts` (`calculateWallTally`, `planWallLayout`, both have a "Per-course corner ownership" block computing effective start/end modular and re-fitting `fitCourseLength` when the effective ends differ from the parity-only base)
- **Brick 3D path** — `src/components/WorkspaceView3D.tsx` (search `wall.trade === 'brick'`)
- **Plan-as-floor** — `src/components/WorkspaceView3D.tsx` (search `planTexture` and `rasterisePdfPage`)
- **Mortar helper** — `src/components/WorkspaceView3D.tsx` (search `emitMortarForWall`)
- **Auto lead-in detection** — `src/components/WorkspaceView3D.tsx` (search `resolveLeadInForWall`)

## Open follow-ups

1. **300-series lead-in for walls with openings** — current `resolveLeadInForWall` only applies on the `planWallLayout` path. Walls with openings use legacy `segmentsForStraightWall` which takes pre-resolved courses. Need to re-resolve courses from the effective makeup before that call.
2. **Lead-in in the project tally** — auto-detected lead-in shows in 3D but is NOT included in the export count (uses original makeup). Either propagate the override into `calculateProjectTally` too, or run the auto-detection at makeup-creation time so it's persisted in the project state.
3. **Lead-in detection diagnostic** — dev-time `console.log('[lead-in detect]…')` left in `WorkspaceView3D.tsx` to surface what `resolveLeadInForWall` sees per wall. Useful for debugging which walls need lead-ins and whether the library has matching blocks. Remove before shipping a release.
4. **Brick stretcher bond at corners** — fudged-thickness fix lands the body grid on exact half-brick offset (115mm). The cube-cut on non-owning courses is 115mm wide which means it extends 5mm past the real 110mm cube boundary into the perpendicular wall. Both walls are the same colour at the corner so the overlap reads as one continuous brick, but if you orbit the camera under or beside the corner you may see slight z-fight artefacts.
5. **Plan texture pixel threshold** — B&W threshold at 200 might cut faint dimension lines on some plans or let page noise through on others. Tunable in the rasterise effect.
