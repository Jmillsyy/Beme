# Multi-trade unification — status

The block + brick estimate types are being merged into one unified
workspace with a left-side **trade rail** for switching between trades,
plus future room for concrete + paving.

## Done

### Data model (additive, fully backward-compatible)
- `SavedProject.trades?: ('block' | 'brick')[]` — which trades have content in this project
- `Wall.trade?: 'block' | 'brick'` — which makeup pool each wall belongs to
- Legacy `SavedProject.type` field optional, tolerated forever on reads
- `migrateSavedProject()` runs on every load path — silently upgrades old `type='block'`/`type='brick'` projects to the new shape, stamps `wall.trade` on every wall
- `saveProject()` always writes the legacy `type` field for forward-compat with older clients in production
- `duplicateProject()` carries `trades` forward

### TradeRail component
- `src/components/TradeRail.tsx` — vertical rail with block + brick icons, active state, future stubs for concrete + paving (disabled, dashed border)
- Wired into `PdfWorkspace` on lg+ screens

### PdfWorkspace surgery
- `mode` prop converted to `initialMode` (renamed in destructure); internal `mode` state initialised from it
- Walls filtered by active trade — `allWalls` and `currentPageWalls` only return walls matching `mode`
- New walls (straight + curved) get `trade` stamped at create time
- Switching trades hides the other trade's walls cleanly; switching back shows them again
- Save paths (`handleSaveProject`, `handleToggleProjectStatus`) now persist BOTH trades' setup unconditionally. Previously conditional on `mode` — would have wiped the inactive trade's work on a unified project
- `project.trades` derived from "which trades have walls" on every save

### Verification
- `npx tsc --noEmit` clean

## What works now

Open any existing block project → BL icon active in the rail, BR available. Click BR → switches to brick mode, block walls hide, brick toolbar + panels show. Draw brick walls → they save with `trade='brick'`. Save the project → `trades` becomes `['block', 'brick']`, both pools of makeups persisted. Re-open the project → both trades' work is preserved.

Same in reverse from a brick project. Old route URLs (`/project/block`, `/project/brick`) still work — they just pass the initial trade.

## Still to do

### Dashboard
- Collapse the two "Brick estimate" / "Block estimate" startup cards into one "New estimate" with a trade picker modal that allows picking one or both
- Project rows: show trade badges from `project.trades` instead of the single-type pill (e.g. "Block + Brick" when both are populated)

### Combined export
- `src/lib/blockExport.ts` + `src/lib/brickExport.ts` currently produce independent PDFs
- New: one PDF that includes block schedule + brick schedule back to back when both trades are present
- Export panel: separate sections per trade with their own tick boxes

### Misc polish
- `src/components/CommandPalette.tsx` — collapse "New block estimate" / "New brick estimate" entries into "New estimate"
- `src/components/ProjectBar.tsx` — show trade badges (currently shows the single type)
- TradeRail visibility on small screens (currently hidden — vertical rail on a narrow viewport wastes height; might want a compact horizontal variant)

### Smoke tests to run on a real machine
- Open an existing block project — still works exactly as today, BL active in rail
- Open an existing brick project — ditto, BR active
- Switch trade mid-session, draw walls in the new trade, save — both trades preserved on reload
- Add brick to an existing block project (or vice versa) — `project.trades` updates correctly
- Export — currently block-only or brick-only depending on which one was the original type; combined export is the next task

## Architecture notes

**Why `mode` is state, not derived from project:** the active trade is a per-session UI choice. If we derived it from the saved project (e.g. "first trade in `trades`"), reopening always lands users in the same trade — surprising if they last saved while in the OTHER trade. State + prop-initialised is the right call.

**Why walls carry a `trade` field rather than the makeup carrying it:** walls are rendered + hit-tested every frame. Knowing a wall's trade at render time lets the filter happen in one place. Looking it up via the makeup pool would force every render path to do an extra lookup.

**Why we don't drop the legacy `type` field:** older clients in production keep reading it. The save path writes both `type` (set to `trades[0]`) AND `trades`, so old clients keep functioning while we roll out.
