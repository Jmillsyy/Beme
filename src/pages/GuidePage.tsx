import { Link } from 'react-router-dom'
import GuideMedia from '../components/GuideMedia'

/**
 * Full Beme walkthrough — from creating an account through to exporting
 * the finished estimate. Each numbered section maps to a real workflow
 * step in the product and includes screenshots / short clips so the
 * reader can match what they're seeing to what's described.
 *
 * Layout: sticky TOC on the left (lg+), long-form scrolling content on
 * the right. Media files live under public/guide/ — when one is missing
 * the GuideMedia component renders a labelled placeholder instead of a
 * broken image, so unfinished sections look intentionally pending
 * rather than broken.
 *
 * Vocabulary stays region-agnostic ("body block", "corner block",
 * "lintel") so an AU, NZ, UK, or US estimator reads equally well —
 * specific block codes only appear when the screenshot already shows
 * one (20.48, 40.925 etc.).
 */
export default function GuidePage() {
  return (
    <>
      <div className="px-12 py-10">
        <div className="mb-8">
          <Link
            to="/"
            className="inline-flex items-center gap-1.5 text-sm text-ink-400 hover:text-beme-300 transition-colors mb-2"
          >
            <span>←</span>
            <span>Back to dashboard</span>
          </Link>
          <h2 className="text-3xl font-extrabold tracking-tight text-ink-50">
            Beme guide
          </h2>
          <p className="text-sm text-ink-400 mt-1 max-w-3xl">
            Everything you need to take a masonry job off plan — account
            setup, library configuration, drawing, openings, piers, lintels,
            and exporting the finished estimate. Read it top to bottom the
            first time, then come back to specific sections via the menu on
            the left as you need them.
          </p>
        </div>

        <div className="lg:grid lg:grid-cols-[220px_1fr] lg:gap-10">
          {/* Table of contents — sticky on wide screens. */}
          <aside className="hidden lg:block">
            <div className="sticky top-6">
              <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-400 mb-3">
                Sections
              </div>
              <ul className="space-y-2 text-sm">
                {TOC.map(({ id, label }) => (
                  <li key={id}>
                    <a
                      href={`#${id}`}
                      className="text-ink-300 hover:text-beme-300 transition-colors block"
                    >
                      {label}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          </aside>

          {/* Long-form content. Text width caps at max-w-3xl for readability
              (~70 chars per line) but figures are allowed to extend wider —
              see GuideMedia's wrapper. */}
          <article className="prose-content space-y-14 max-w-4xl">
            {/* ─── Welcome ────────────────────────────────────────────── */}
            <Section id="welcome" title="Welcome to Beme">
              <P>
                Beme turns a building plan PDF into a priced masonry
                estimate. Upload the plan, trace the walls, openings, and
                piers, and Beme tallies blocks (or bricks), lintels, ties,
                cement, and any supply items you've configured — ready to
                export to PDF for your customer.
              </P>
              <P>
                Five minutes of one-off setup the first time you use it,
                then a few minutes per estimate after that. This guide
                walks through both.
              </P>
              <GuideMedia
                src="01-dashboard.png"
                caption="Your dashboard — recent projects, quick-start cards, and the find-by-reference shortcut for jumping to an existing estimate."
              />
              <Annotation kind="tip">
                In a hurry? Skip ahead to{' '}
                <a href="#new-estimate" className="text-beme-300 underline hover:text-beme-200">
                  Start an estimate
                </a>{' '}
                and refer back to the earlier sections only when you hit
                something unfamiliar.
              </Annotation>
            </Section>

            {/* ─── 1. Account setup ───────────────────────────────────── */}
            <Section id="account" title="1. Account setup">
              <P>
                One-off configuration that sits behind every estimate.
                Open <strong>Settings</strong> from the dashboard sidebar.
                Four tabs:
              </P>

              <H4>Profile</H4>
              <P>
                Your name, contact, and role. The display name and email
                appear on every exported estimate header. If you sign in
                with Microsoft, the email field is read-only — it pulls
                from your work account.
              </P>
              <GuideMedia
                src="02-settings-profile.png"
                caption="Profile tab — name, phone, email, and role / job title."
              />

              <H4>Business</H4>
              <P>
                Your company identity. Trading name, ABN / business
                number, address, logo, and default tax rate (10% for
                Australian GST). This lands in the header of every PDF
                export — so customers see your branding, not Beme's.
              </P>
              <GuideMedia
                src="03-settings-business.png"
                caption="Business tab — appears in the header of every exported quote."
              />

              <H4>Preferences</H4>
              <P>
                Units (metric / imperial — display only, internals stay
                in mm), date format, theme, and default project type for
                the New estimate button. The <strong>Library template</strong>{' '}
                row down the bottom lets you switch between regional
                presets — handy if you start in one market and later
                expand to another.
              </P>
              <GuideMedia
                src="04-settings-preferences.png"
                caption="Preferences tab — units, date format, theme, default project type, and library template."
              />

              <H4>Defaults</H4>
              <P>
                Starting values for every new estimate. Default wall
                height, mortar joint, bond pattern, default brick type,
                and — most useful — the{' '}
                <strong>Default blocks by role</strong> grid. Override
                which block the calc engine reaches for when it needs to
                pick on your behalf (e.g. auto-creating a wall type,
                filling a stale makeup, or selecting a lintel). Leave a
                row blank to fall back to whatever your library has tagged.
              </P>
              <GuideMedia
                src="05-settings-defaults.png"
                caption="Defaults tab — wall defaults plus the per-role block override grid."
              />

              <Annotation kind="tip">
                Defaults are device-scoped — they apply to every project
                on this computer. Sign in on another machine and you'll
                set them again there. Cloud-saved projects keep their own
                copy of any overrides so a project always knows what it
                was estimated against.
              </Annotation>
            </Section>

            {/* ─── 2. Material library ────────────────────────────────── */}
            <Section id="library" title="2. Material library">
              <P>
                The catalogue of every block, brick, and supply item Beme
                prices into your estimates. One-off setup, shared across
                every job.
              </P>
              <GuideMedia
                src="10-library-page.png"
                caption="Material library — Library template, blocks list, bricks list, and supply items, all on one page."
              />

              <H4>Pick a regional preset</H4>
              <P>
                First-time setup: click{' '}
                <strong>Pick a regional preset</strong> at the top of the
                library page. Beme ships seed libraries for Australia
                (SEQ), the United States (CMU + modular), and the United
                Kingdom (concrete block + BS clay brick). Picking one
                gives you a working set of blocks + bricks for that market
                — edit or add to it freely after that.
              </P>
              <GuideMedia
                src="11-pick-region.png"
                caption="Regional presets — pick the closest to your market, then customise from there."
              />

              <H4>Blocks</H4>
              <P>
                Every concrete block you supply. Code, name, dimensions
                (width × height × depth), and — most importantly — one
                or more <strong>roles</strong>: body, corner,
                end-termination, half, fraction, height-makeup, lintel,
                pier, base, top course, tight-curve wedge. The role tells
                Beme which slot in a wall this block fills.
              </P>
              <GuideMedia
                src="12-block-editor-add.png"
                caption="Add a block — code, name, description, dimensions, and the role checkbox grid."
              />
              <Annotation kind="tip">
                Role tags matter more than the block code does. Beme
                doesn't search for "20.01" by name — it asks the library
                "which block is the corner block?" by role tag. Get the
                roles right and Beme uses the right block regardless of
                what you've called it.
              </Annotation>

              <H4>Lintels</H4>
              <P>
                A block tagged with the <strong>Lintel</strong> role gets
                two extra fields:{' '}
                <strong>min / max head height (mm)</strong>. Beme uses
                these as inclusive buckets when picking a lintel for each
                opening — e.g. a "20.25 — 300 mm Lintel Block" with
                max 300 covers a 300 mm head height; a "20.18 — 400 mm
                Lintel Block" with min 301, max 400 covers from there up.
                Catalogue-style ranges; the engine prefers the smaller
                max on ties.
              </P>
              <GuideMedia
                src="14-block-editor-lintel.png"
                caption="Block editor with Lintel role ticked — the min / max head height fields appear so you can define the bucket."
              />

              <H4>Bricks</H4>
              <P>
                Brick types you supply. Dimensions (width × height ×
                depth), mortar joint thickness, and the auto-calculated
                bricks-per-square-metre rate. One brick in the library is
                tagged <strong>Default</strong> — that's the one new
                brick estimates start with.
              </P>
              <GuideMedia
                src="15-brick-editor.png"
                caption="Brick editor — dimensions, joint, and the derived bricks/m² rate."
              />

              <H4>Supply items</H4>
              <P>
                Everything else you price into a job: cement bags, brick
                ties, plascourse, rebar, flashings, sealants. Each item
                has a <strong>unit</strong> (per block, per brick, per
                m², per lineal m, per opening, or flat each) and a{' '}
                <strong>rate</strong> — Beme multiplies it out across the
                estimate. Tick which estimate types each item applies to
                (block, brick, or both) so brick items don't appear on
                block jobs.
              </P>
              <GuideMedia
                src="16-supply-item-form.png"
                caption="Supply item form — name, rate, unit, and which estimate types it applies to."
              />
              <P>
                Supply items with <strong>unit = per opening</strong>{' '}
                show extra width-range fields — opening width min / max
                in mm. Use this for brick-mode lintels (Galintel etc.)
                where the lintel you specify depends on the opening
                width.
              </P>
              <GuideMedia
                src="17-supply-item-width-range.png"
                caption="Per-opening supply item with width-range bounds — used for brick lintels keyed off opening width."
              />

              <Annotation kind="warning">
                Switching regional preset later merges the new template's
                blocks on top of your existing library — your custom
                blocks aren't deleted. <strong>Reset entire library</strong>{' '}
                does wipe everything and rebuild from a template, so
                only use it if you really want to start over.
              </Annotation>
            </Section>

            {/* ─── 3. Start an estimate ──────────────────────────────── */}
            <Section id="new-estimate" title="3. Start an estimate">
              <P>
                From the dashboard, pick <strong>Brick estimate</strong>{' '}
                or <strong>Block estimate</strong> depending on the job.
              </P>

              <H4>Project details</H4>
              <P>
                Fill in the customer + project info: project name (the
                only required field), site address, and client name.
                These land in the header of the exported estimate. You
                can edit them later from the project bar at the top of
                the workspace.
              </P>
              <GuideMedia
                src="20-new-estimate-modal.png"
                caption="Start a new block estimate — project name, site address, client. Hit Start estimate to open the workspace."
              />

              <H4>Upload the plan</H4>
              <P>
                The empty workspace shows a drop zone in the middle. Drag
                a PDF in, or click <strong>Choose a PDF</strong> to
                browse. Multi-page plans are fully supported — you'll be
                asked which pages to import next.
              </P>
              <GuideMedia
                src="21-empty-workspace.png"
                caption="Empty workspace — drop a PDF on the canvas, or start with an empty 1:100 workspace for quick what-ifs."
              />
              <P>
                If your PDF has more than one page, Beme shows a page
                picker — tick only the pages with actual masonry to
                estimate. Plumbing, electrical, and admin pages can be
                skipped. Each imported page becomes a tab in the page
                rail on the left, with its own scale and walls.
              </P>
              <GuideMedia
                src="22-pdf-page-picker.png"
                caption="Multi-page picker — tick the pages you want, skip the rest."
              />
              <Annotation kind="tip">
                No plan to work from? Click{' '}
                <strong>Start with an empty workspace</strong> — Beme
                runs at a fixed 1:100 metric grid, useful for sample
                walls and quick quotes where there's no PDF to trace.
              </Annotation>
            </Section>

            {/* ─── 4. Scale ───────────────────────────────────────────── */}
            <Section id="scale" title="4. Set the scale">
              <P>
                Every page needs its scale set before any wall length
                will be accurate. Pick a known dimension on the plan —
                an annotated wall length is easiest — then either:
              </P>
              <Ul>
                <li>
                  Pick a ratio preset (1:50, 1:100, 1:200, etc.) from
                  the dropdown if you know the plan's drawn ratio, or
                </li>
                <li>
                  Click <strong>Ruler</strong>, drag between two points
                  with a known dimension, type the real-world length in
                  mm, and click <strong>Save scale</strong>.
                </li>
              </Ul>
              <GuideMedia
                src="30-ruler-drawn.png"
                caption="Ruler tool — drag between two points with a known dimension, type the mm length, and save the scale."
              />
              <Annotation kind="tip">
                Calibrate carefully on every page — wall lengths Beme
                tallies later all come from this calibration. You can{' '}
                <strong>Recalibrate</strong> at any time from the
                toolbar; previously-drawn walls scale to match the new
                calibration, so you don't have to redraw 30 walls if you
                spot a misalignment.
              </Annotation>
            </Section>

            {/* ─── 5. Wall types ──────────────────────────────────────── */}
            <Section id="wall-types" title="5. Define your wall types">
              <P>
                A wall type is the recipe Beme follows when it tallies
                blocks for a wall: bond pattern, height, which block
                goes where, and any per-course overrides. Each type
                gets a colour from the palette so the plan shows at a
                glance which type each wall is.
              </P>
              <P>
                The same editor handles three things — pick the kind at
                the top:
              </P>
              <Ul>
                <li>
                  <strong>Wall</strong> — standard masonry wall
                </li>
                <li>
                  <strong>Tied pier</strong> — a column built into a
                  host wall (height inherits the wall)
                </li>
                <li>
                  <strong>Freestanding pier</strong> — a standalone
                  column with its own height
                </li>
              </Ul>
              <GuideMedia
                src="40-wall-type-kind-picker.png"
                caption="One editor for walls, tied piers, and freestanding piers — pick the kind via the tabs at the top."
              />

              <H4>Basics</H4>
              <P>
                Name (auto-suggested from the height and bond),
                wall height in mm, and bond type (stretcher or stack).
                The <strong>Match exact wall length</strong> toggle
                controls whether the calc absorbs leftover length using
                fraction-tagged blocks from your library (AU 20.02 /
                20.22 etc.) — leave it on if your supplier stocks
                fractions, turn it off if the bricklayer trims on site.
              </P>
              <GuideMedia
                src="41-wall-type-basics.png"
                caption="Basics tab — name, height, bond, and length-matching behaviour."
              />

              <H4>Composition</H4>
              <P>
                Which block fills each role in this wall type:
                base course, body, top course, full-end termination,
                half-end termination. Each picker only shows blocks
                from your library tagged with the matching role.
              </P>
              <GuideMedia
                src="42-wall-type-composition.png"
                caption="Composition tab — assign blocks to base / body / top / end-termination roles."
              />

              <H4>Course pattern (mixed-height walls)</H4>
              <P>
                Most walls don't need this — the flat Height field on
                the Basics tab handles uniform walls. Use the Course
                pattern tab when courses are mixed heights — e.g.{' '}
                <em>4 × 200 mm body + 2 × 100 mm bond beam</em>{' '}
                repeating up the wall.
              </P>
              <GuideMedia
                src="43-wall-type-pattern-empty.png"
                caption="Course pattern empty state — click Convert this wall to a pattern or Add band to start."
              />
              <P>
                Each band is a count + block — Beme stacks them
                bottom-to-top and the Basics height field locks to
                whatever the pattern sums to. Drag to reorder, ▲▼ to
                shuffle, × to remove.
              </P>
              <GuideMedia
                src="44-wall-type-pattern-bands.png"
                caption="Course pattern populated — multiple bands stack from base to top, preview reflects the layered build."
              />

              <H4>Advanced overrides</H4>
              <P>
                Two extra tools for edge cases:{' '}
                <strong>per-course overrides</strong> (replace the
                block on a single course — handy for a mid-wall bond
                beam) and <strong>course-series ranges</strong> (use a
                different block series for a range of courses — e.g.
                300-series for the bottom 5 courses, 200-series above).
              </P>
              <GuideMedia
                src="45-wall-type-advanced.png"
                caption="Advanced tab — per-course overrides and course-series ranges for unusual builds."
              />

              <P>
                Hit <strong>Save changes</strong>. The wall type appears
                in the right panel and becomes the <strong>Active</strong>{' '}
                type — every new wall you draw uses it until you switch.
                Click any other type in the panel to make it active.
              </P>
            </Section>

            {/* ─── 6. Drawing ─────────────────────────────────────────── */}
            <Section id="drawing" title="6. Draw the plan">
              <P>
                Click <strong>Draw wall</strong>. Each click places a
                point; consecutive clicks chain into a continuous
                polyline — perfect for going around a room without
                releasing the tool. Press <Kbd>Esc</Kbd> to stop
                drawing, or click <strong>Stop drawing</strong> in the
                toolbar.
              </P>
              <GuideMedia
                src="51-wall-in-progress.png"
                caption="Drawing in progress — click points along a wall; consecutive clicks chain into a polyline."
              />

              <H4>Snap targets</H4>
              <P>
                The cursor magnets onto existing geometry so corners and
                T-junctions form cleanly without pixel-precise clicking:
              </P>
              <Ul>
                <li>
                  <strong>Wall endpoints</strong> — green ring; useful
                  for closing a loop or starting a new wall off the end
                  of an existing one
                </li>
                <li>
                  <strong>Wall faces</strong> — purple ring; T-junctions
                  snap to the face of the host wall
                </li>
                <li>
                  <strong>Orthogonal angles</strong> — 0°, 45°, 90°
                  relative to your last point
                </li>
              </Ul>

              <H4>Type a length for precision</H4>
              <P>
                After the first click, type a number on the keyboard.
                The length appears in millimetres above the wall;
                press <Kbd>Enter</Kbd> to commit the wall at exactly
                that length in the direction your cursor is pointing.
                Useful when the plan's labelled dimensions are more
                accurate than your click position.
              </P>
              <GuideMedia
                src="50-drawing-typed-length.png"
                caption="Typed length while drawing — number entered floats above the wall, Enter commits."
              />

              <H4>Corners</H4>
              <P>
                Just chain — first click places a point, second click
                completes wall A, third click branches off in a new
                direction (wall B). The corner block from the wall
                type's Composition tab fills the join automatically;
                the tally dedup's the shared corner.
              </P>
              <GuideMedia
                src="52-corner.png"
                caption="A corner formed by two chained walls — corner block fills automatically."
              />

              <H4>Curved walls</H4>
              <P>
                Click <strong>↷ Curved wall</strong>. Three clicks:
                first point of the arc, second point of the arc, then a
                third point on the midpoint of the arc to set the
                radius. Beme stacks tight-curve wedge blocks (or
                compresses standard body blocks for large radii)
                depending on the curve geometry — visible in the tally
                as "Curved-Wall Half Block" / wedge entries.
              </P>
              <GuideMedia
                src="53-curved-wall.png"
                caption="Curved wall — three-click arc placement, curve blocks tallied separately."
              />
              <Annotation kind="tip">
                Radius matters: ≥ 6000 mm uses stock body blocks with
                compressed mortar. 1500–6000 mm uses stock blocks with
                a small saw cut. &lt; 1500 mm uses the tight-curve
                wedge block. &lt; 665 mm requires custom blocks — Beme
                will flag it.
              </Annotation>

              <H4>Multi-page plans</H4>
              <P>
                Switch pages via the thumbnail rail on the left. Each
                page has its own calibration, walls, openings, and
                piers — but they all roll up into one total tally in
                the right panel. Useful for plans split across
                multiple sheets, or plans with separate floors.
              </P>
              <GuideMedia
                src="54-multi-page-walls.png"
                caption="Multi-page plan with walls drawn across pages — single tally rolls up the lot."
              />
            </Section>

            {/* ─── 7. Openings ────────────────────────────────────────── */}
            <Section id="openings" title="7. Openings (doors and windows)">
              <P>
                Click <strong>+ Add opening</strong>, then click two
                points along an existing wall to set the opening's
                width. A modal pops up asking for sill and head
                heights — or pick a preset.
              </P>
              <GuideMedia
                src="60-opening-modal.png"
                caption="New opening modal — presets across the top, sill + head height fields below."
              />
              <P>
                Presets cover common configurations: Door 2100, Door
                2040, Window 1500 (sill 900), Window 1200 (sill 900),
                Window 1800 (sill 600). They pre-fill the dimensions —
                you can still tweak before saving.
              </P>
              <P>
                Once placed, the opening shows as a gap in the wall.
                Click on it to select — the inspector band at the top
                shows its dimensions, the lintel selected, and which
                wall it's attached to. Press <Kbd>Del</Kbd> or{' '}
                <Kbd>Backspace</Kbd> to remove.
              </P>
              <GuideMedia
                src="61-opening-placed.png"
                caption="Opening rendered on the wall — visible as a gap with width + height labels."
              />
              <GuideMedia
                src="62-opening-selected.png"
                caption="Selected opening — banner shows dimensions, sill, head, and the lintel block selected automatically."
              />
              <Annotation kind="warning">
                Openings are tied to the wall they sit on. Delete the
                wall and any openings on it vanish too. Drag a wall
                endpoint such that an opening no longer fits, and Beme
                will warn you.
              </Annotation>
            </Section>

            {/* ─── 8. Piers ───────────────────────────────────────────── */}
            <Section id="piers" title="8. Piers">
              <P>
                Block mode only. Click <strong>+ Pier</strong> and then
                click on the plan:
              </P>
              <Ul>
                <li>
                  <strong>On a wall</strong> → a tied pier — height
                  inherits the host wall, course pattern alternates the
                  pier block with a corner / tie-back block per course
                </li>
                <li>
                  <strong>Off any wall</strong> → a freestanding pier —
                  standalone column with its own height defined on the
                  pier type
                </li>
              </Ul>
              <GuideMedia
                src="70-pier-placement.png"
                caption="Pier placement banner — click on a wall for tied, anywhere else for freestanding."
              />
              <P>
                Pier types live alongside wall types in the right
                panel. Each type stores the pier block, course pattern,
                and (for freestanding) the height.
              </P>
              <GuideMedia
                src="71-pier-types.png"
                caption="Wall types panel showing both pier types alongside walls — one unified list."
              />
              <GuideMedia
                src="72-pier-editor.png"
                caption="Pier editor — placement, height, course pattern, and a per-course preview."
              />
            </Section>

            {/* ─── 9. Tally ──────────────────────────────────────────── */}
            <Section id="tally" title="9. Tally + lintel warnings">
              <P>
                The right panel updates live as you draw. Block tally
                shows total blocks, run length, and a breakdown by code
                — sorted by count so the headline numbers are at the
                top. Brick tally shows total bricks + area + per-brick
                breakdown.
              </P>
              <GuideMedia
                src="80-block-tally.png"
                caption="Block tally — total blocks, run length, and per-code breakdown."
                aspect="4/3"
              />
              <Annotation kind="tip">
                If your library has overlapping lintel bucket ranges
                (e.g. two blocks both claim 200–300 mm heads), an amber
                warning band appears above the tally listing the
                conflict. Adjust the ranges in the block editor to
                clear it — Beme will pick whichever block comes first
                in the library otherwise, which isn't deterministic.
              </Annotation>
            </Section>

            {/* ─── 10. Export ────────────────────────────────────────── */}
            <Section id="export" title="10. Export the estimate">
              <P>
                In the right-hand <strong>Export estimate</strong>{' '}
                panel, tick the sections you want included, then click{' '}
                <strong>Save as PDF</strong>. The estimate opens in a
                new browser tab — hit the orange <em>Print / Save as
                PDF</em> button at the top, or use{' '}
                <Kbd>Ctrl+P</Kbd> and choose Save as PDF in the print
                dialog.
              </P>
              <GuideMedia
                src="81-export-panel.png"
                caption="Export panel — tick what you want included, save as PDF."
                aspect="4/3"
              />
              <P>
                Available sections:
              </P>
              <Ul>
                <li>
                  <strong>Assumptions</strong> — the masonry conventions
                  Beme applied (mortar joint, rounding, corner dedup,
                  curve thresholds)
                </li>
                <li>
                  <strong>Wall specifications</strong> — per-wall-type
                  composition and dimensions
                </li>
                <li>
                  <strong>Block / brick schedule</strong> — totals per
                  code with per-wall-type breakdown
                </li>
                <li>
                  <strong>Breakdown by wall type</strong> — runs and
                  blocks grouped by wall type
                </li>
                <li>
                  <strong>Ruler measurements on layout</strong> — every
                  ruler measurement you drew, on the page where it sits
                </li>
                <li>
                  <strong>Disclaimer page</strong>
                </li>
              </Ul>
              <GuideMedia
                src="82-export-pdf-assumptions.png"
                caption="Exported PDF — first page (assumptions). Your business name + ABN sit in the header, the customer's site address as the subtitle."
              />
              <GuideMedia
                src="84-export-pdf-wall-specs.png"
                caption="Wall specifications page — composition, dimensions, and run lengths per wall type."
              />
              <GuideMedia
                src="83-export-pdf-schedule.png"
                caption="Block schedule page — totals per code with breakdown by wall type."
              />
              <Annotation kind="tip">
                Untick sections that don't apply to this customer (e.g.
                internal jobs with no lintels schedule). Toggles only
                affect the export — the tally always has the full
                numbers available for re-export later.
              </Annotation>
            </Section>

            {/* ─── 11. Save + revisit ────────────────────────────────── */}
            <Section id="projects" title="11. Save + revisit projects">
              <P>
                Every estimate gets a six-digit{' '}
                <strong>reference number</strong> (#101311 etc.) and
                lives in your cloud projects list. <Kbd>Ctrl+S</Kbd>{' '}
                saves at any time, or hit <strong>Save changes</strong>{' '}
                in the top bar.
              </P>
              <P>
                Mark a project as <strong>Won</strong>,{' '}
                <strong>Lost</strong>, or leave it{' '}
                <strong>Pending</strong> via the outcome pill on the
                project row. The dashboard tracks your win rate from
                these — useful for sales meetings and seeing which kinds
                of jobs convert.
              </P>
              <P>
                Need to find a specific estimate? Type the six-digit
                reference number into the <strong>Find by reference</strong>{' '}
                card on the dashboard — it's printed on every exported
                PDF so customers can quote it back to you over the phone.
              </P>
              <Annotation kind="tip">
                <strong>Duplicate</strong> is your friend when you do
                multiple estimates for the same client. The Duplicate
                button on each dashboard row creates a fresh project
                with all your wall types, openings, and supply items
                pre-loaded — just change the project name and adjust
                what's different.
              </Annotation>
            </Section>

            {/* ─── 12. Power tools ───────────────────────────────────── */}
            <Section id="power" title="12. Power tools">
              <H4>Command palette</H4>
              <P>
                Press <Kbd>Cmd+K</Kbd> (or <Kbd>Ctrl+K</Kbd> on Windows)
                to open the command palette anywhere in Beme. Search
                projects by name or reference, jump to settings, library,
                or the guide, start a new estimate — without lifting your
                hands off the keyboard. Arrow keys to move,{' '}
                <Kbd>Enter</Kbd> to open.
              </P>
              <GuideMedia
                src="06-command-palette.png"
                caption="Command palette — fuzzy-search across navigation, actions, and your projects."
                aspect="4/3"
              />

              <H4>Keyboard shortcuts</H4>
              <P>
                Press <Kbd>?</Kbd> anywhere for the full shortcut
                reference. Highlights below — full list in the modal:
              </P>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1.5 my-3">
                <ShortcutRow keys={['Cmd/Ctrl', '+', 'K']} label="Command palette" />
                <ShortcutRow keys={['Cmd/Ctrl', '+', 'S']} label="Save the current estimate" />
                <ShortcutRow keys={['?']} label="Show shortcut reference" />
                <ShortcutRow keys={['Esc']} label="Cancel current tool / close modal" />
                <ShortcutRow keys={['type', '+', 'Enter']} label="Wall to exact length" />
                <ShortcutRow keys={['Shift', '+', 'click']} label="Multi-select walls / openings / piers" />
                <ShortcutRow keys={['Del']} label="Remove selected" />
                <ShortcutRow keys={['Backspace']} label="Same as Delete" />
              </div>
              <GuideMedia
                src="90-keyboard-shortcuts.png"
                caption="The full shortcut reference — global, drawing, selection, and project shortcuts."
              />
            </Section>

            {/* ─── Working in a team ─────────────────────────────────── */}
            <Section id="team" title="Working in a team (optional)">
              <P>
                Beme works fine as a single-user app — most users won't
                need this section. If you're set up as an organisation
                (typically a masonry supplier with sales + estimating
                staff), every project is visible to the whole team and
                identified by its 6-digit reference number.
              </P>
              <P>
                Want a teammate to look at your estimate? Tell them the
                reference number — they can punch it into the{' '}
                <em>Find by reference</em> card on the dashboard sidebar
                and land straight on the project. No inbox routing, no
                hand-offs.
              </P>
              <P>
                The dashboard's <em>"Your projects"</em> and{' '}
                <em>"In-progress projects"</em> sections split work into
                yours vs the rest of the team so you can spot what
                everyone's on at a glance.
              </P>
            </Section>

            {/* ─── Final tips ────────────────────────────────────────── */}
            <Section id="tips" title="Final tips">
              <Ul>
                <li>
                  <strong>Duplicate a similar project</strong> when
                  starting a new estimate for the same client. Saves
                  redoing wall types + supply items.
                </li>
                <li>
                  <strong>Use control joints</strong> (toolbar →
                  Control joint) to split a long wall at a specific
                  point — handy for marking expansion joints or
                  breaking up a single drawn wall into two priced
                  pieces.
                </li>
                <li>
                  <strong>Save changes</strong> commits to cloud. The
                  button greys out when there's nothing new to save,
                  lights up the moment you make a change.{' '}
                  <Kbd>Ctrl+S</Kbd> works from anywhere.
                </li>
                <li>
                  <strong>Library health</strong> badge on the
                  dashboard's Material library card flags when
                  something needs your attention — overlapping lintel
                  ranges, missing role tags, etc. Click through to fix.
                </li>
                <li>
                  <strong>Region toggles</strong> in Settings →
                  Preferences let you flip the library template
                  without losing your custom blocks.
                </li>
              </Ul>
            </Section>

            {/* ─── Help ──────────────────────────────────────────────── */}
            <Section id="help" title="Need more help?">
              <P>
                Something not working, or a feature would make your day
                shorter? Get in touch — Beme is actively developed and
                feedback shapes what gets built next.
              </P>
            </Section>
          </article>
        </div>
      </div>
    </>
  )
}

// ─── Table of contents ──────────────────────────────────────────────────────

const TOC: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'welcome', label: 'Welcome' },
  { id: 'account', label: '1. Account setup' },
  { id: 'library', label: '2. Material library' },
  { id: 'new-estimate', label: '3. Start an estimate' },
  { id: 'scale', label: '4. Set the scale' },
  { id: 'wall-types', label: '5. Wall types' },
  { id: 'drawing', label: '6. Draw the plan' },
  { id: 'openings', label: '7. Openings' },
  { id: 'piers', label: '8. Piers' },
  { id: 'tally', label: '9. Tally + lintels' },
  { id: 'export', label: '10. Export' },
  { id: 'projects', label: '11. Save + revisit' },
  { id: 'power', label: '12. Power tools' },
  { id: 'team', label: 'Working in a team' },
  { id: 'tips', label: 'Final tips' },
  { id: 'help', label: 'Need help?' },
]

// ─── Small typography helpers ──────────────────────────────────────────────

function Section({
  id,
  title,
  children,
}: {
  id: string
  title: string
  children: React.ReactNode
}) {
  return (
    <section id={id} className="scroll-mt-6">
      <h3 className="text-xl font-bold text-ink-50 mb-4">{title}</h3>
      <div className="space-y-3 text-ink-200 leading-relaxed">{children}</div>
    </section>
  )
}

/**
 * Subsection heading inside a Section. Used to break long sections (wall
 * types, library, account setup) into scannable chunks without polluting
 * the TOC with every sub-step.
 */
function H4({ children }: { children: React.ReactNode }) {
  return (
    <h4 className="text-base font-semibold text-ink-100 mt-6 mb-2">
      {children}
    </h4>
  )
}

function P({ children }: { children: React.ReactNode }) {
  return <p className="text-sm">{children}</p>
}

function Ul({ children }: { children: React.ReactNode }) {
  return <ul className="list-disc pl-5 space-y-1.5 text-sm">{children}</ul>
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="px-1.5 py-0.5 rounded border border-ink-600 bg-ink-800 text-ink-100 text-[11px] font-mono align-middle inline-block">
      {children}
    </kbd>
  )
}

/**
 * Callout box for tips and warnings. Visually distinct from body text so
 * the reader's eye is drawn to the gotcha or shortcut.
 *
 * Uses text-beme-300 / text-amber-200 specifically because those tokens
 * have light-mode overrides defined in index.css (text-beme-100 / -amber-100
 * do not, and would render as pale-on-pale in light mode).
 */
function Annotation({
  kind,
  children,
}: {
  kind: 'tip' | 'warning'
  children: React.ReactNode
}) {
  const styles =
    kind === 'tip'
      ? 'border-beme-500/40 bg-beme-500/10 text-beme-300'
      : 'border-amber-500/40 bg-amber-500/10 text-amber-200'
  const label = kind === 'tip' ? '💡 Tip' : '⚠ Heads up'
  return (
    <div className={`my-3 px-4 py-3 border rounded-lg ${styles}`}>
      <div className="text-[11px] font-semibold uppercase tracking-wider mb-1 opacity-80">
        {label}
      </div>
      <div className="text-sm leading-relaxed">{children}</div>
    </div>
  )
}

function ShortcutRow({ keys, label }: { keys: string[]; label: string }) {
  return (
    <div className="flex items-center gap-2 text-sm">
      {keys.map((k, i) => (
        <span key={i} className="inline-flex items-center">
          {k === '+' ? (
            <span className="text-ink-500 mx-0.5">+</span>
          ) : (
            <Kbd>{k}</Kbd>
          )}
        </span>
      ))}
      <span className="text-ink-200 ml-1">{label}</span>
    </div>
  )
}
