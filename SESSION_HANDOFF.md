# Beme session handoff — render-tally-alignment branch

Paste this into the next Claude session as context.

---

I'm continuing work on Beme — a React 19 + Vite + Supabase masonry estimating
SaaS (repo `Jmillsyy/Beme`, marketing site in `Jmillsyy/beme-web`). Last
session produced the `render-tally-alignment` branch: **33 commits**, all
verified. `dev` is fast-forwarded to the same tip locally. A PR to `main`
exists (opened from the first 24 commits); the last 9 commits are local-only
until I run `git push` + `git push origin dev`.

## The big architectural change: render is truth

The 3D render and the export tally used to be independent implementations.
Now the tally **counts exactly the blocks the renderer draws**:

- Straight walls without openings count `planWallLayout`'s positioned blocks;
  walls WITH openings count the renderer's cell grid (`segmentsForStraightWall`,
  extracted from WorkspaceView3D into `src/lib/wallSegments.ts`). The old
  formula-based `applyOpeningAdjustments` is deleted.
- Corner deduplication happens per wall via `cornerOwnershipFor` (the
  project-level `calculateCornerAdjustment` subtraction is gone from totals).
- Paired tiles (50.45) are counted-but-not-rendered; caps are formula-counted
  on the no-openings path. Curved walls remain formula-counted (follow-up).
- `npm test` = Vitest suite (`renderTallyParity.test.ts`, 14 tests) pinning
  render↔tally parity, corner invariants, Rule 4 and phasing behaviour.
- IMPORTANT: bare `npx tsc --noEmit` checks NOTHING (root tsconfig is empty
  project references). The real typecheck is
  `npx tsc --noEmit -p tsconfig.app.json`, and main has ~68 pre-existing
  errors — compare against that baseline, don't try to zero it.

## Bond / layout engine fixes

- **Rule 4**: free-standing walls pick the cleaner end scheme by fit
  (full/full + half/half on modular lengths; inverted full+half only when
  strictly cleaner). Was hardcoded always-invert.
- **Fit-aware corner phasing** ("4800 means outer face"): walls whose OUTER
  length is modular lay [corner..corner] / [cube..cube] alternating courses —
  zero cuts. Solved as a 2-colouring of the corner graph
  (`solveCornerPhases` in blockCalc). Centreline-modular walls keep opposite
  phasing. Jog stubs (<800 outer) don't constrain the solver.
- **Modular grid in the opening renderer**: block walls tile at face+mortar
  pitch (was face-only, drifting 10mm/block and emitting phantom slivers).
- **Opening heads fixed**: block openings keep their explicit sill (the brick
  window auto-anchor no longer hijacks them — it's kind==='window' only);
  lintel picker tiebreak prefers the SMALLEST clean fit (600 head = 190
  lintel + 2 body courses, not the 390 deep lintel); mid-course sills/heads
  emit CUT sub-bands and lintel top courses get packed to the course line.
- **Height-makeup blocks are series-strict** (no 20.71 stuffed into a
  300-series wall); the lintel gap-fill is depth-checked too.
- Z-fighting eliminated structurally: 0.5mm envelope inset on all blocks,
  render-only cube fillers recessed, cap strips de-overlapped at corners.

## Workspace (PDF + drawing)

- **Sharp at any zoom** (Bluebeam pattern): above the 3.5× whole-page raster
  cap, the visible PDF region renders at true resolution into a
  viewport-sized canvas (`src/lib/pdfViewportRender.ts` + settle effect in
  PdfWorkspace); the wall stage shrinks to a render window with raised
  per-layer pixelRatio so drawing is sharp LIVE. Overlays ride the transform
  through pans/zooms. Zoom ceiling is scale-aware (8× at 1:50 → 32× site
  plans). NOTE: a full viewport-stage relocation was attempted and REVERTED
  (commit "Park Phase B") — the render-window approach replaced it.
- Curve tool snapping measures against the actual arc (not the chord);
  endpoint anchors use the standard 8px radius.
- Drawn lengths grid-snap on the OUTER figure off corners (1050, not 1045).
- 2D openings colour by kind (doors teal, windows amber).

## Product features

- **Brick "No head" openings**: checkbox in the brick opening modal — void
  runs sill→wall top, area reduced, no head course counted, 3D carves to top.
- **Regional libraries**: NZ (rebuilt from the real Firth 20-Series flyer +
  Hollow Masonry brochure — 33 verified units), US/UK/Canada full catalogues
  (dimensions standards-verified; codes are conventions), AU expanded with
  100/150 series + caps + 40.48 per the National Masonry SEQ price list.
- **Your Library / wall type templates**: Material Library has a "Wall types"
  tab (card grid with course-stack previews); any project wall type card has
  "Save to library"; project "+ Add" opens a chooser — one-click "Add to
  project" per template, "Customise first…" pre-fills the editor (seed prop
  on WallTypeEditorModal), "Start blank" as before. Templates live in
  userSettings.wallTypeTemplates (user-level, not org-shared yet).
- **Brick library phased out** (deliberate product decision): ONE standard
  brick (230×76×110). Brick editor has no brick picker / course-composition
  tab; BrickLibraryPanel deleted; templates/RegionPicker are block-only.
  Legacy walls keep stored codes + ranges so old tallies don't move.
- **Material Library categorised**: Catalogue (Blocks) · Your builds (Wall
  types) · Rates & extras (Supply items).

## Known quirks / environment

- The git repo at C:\Users\Joshua\Beme intermittently corrupts
  `.git/index` / `ORIG_HEAD` when operated from a sandbox mount —
  fix is `rm .git/index .git/ORIG_HEAD && git reset` (working tree is never
  the problem). Native Windows git is unaffected.
- Sandbox `npm test` against Windows-installed node_modules fails (rolldown
  native binding) — clone to a Linux tmp dir and `npm install` there, or run
  tests on Windows.
- Expected behaviour changes shipped: export totals shift slightly on
  opening-heavy projects (now exact); free modular walls lay full/full +
  half/half; outer-modular corner walls lay aligned phasing.

## Open follow-ups (in priority order)

1. Push + merge the PR (smoke checklist is in the PR description: U-shape
   corners, 350mm jog, deep zoom 1:100, opening-at-corner count, brick
   no-head, NZ/CA templates, brick editor, library categorisation).
2. Modular-length hint in the drawing layer (live "lays clean / +95" badge —
   prevents off-modular walls at draw time).
3. Curved-wall tally enumeration (last formula-counted path).
4. Replace PROTECTED_BLOCK_CODES with role-based fallbacks + referential
   deletion guards (delete-block-in-use warning); makes non-AU libraries as
   safe as AU.
5. Org-share wall type templates (currently per-user settings).
6. Viewport-stage take three if drawing-time sharpness needs more (render
   window covers it for now).
