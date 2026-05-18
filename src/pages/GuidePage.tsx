import { Link } from 'react-router-dom'
import Header from '../components/Header'

/**
 * Full beme walkthrough. Region-agnostic — uses generic masonry vocabulary
 * ("body block", "corner block", "lintel") rather than supplier-specific
 * codes so an Australian, US, or UK estimator finds it equally readable.
 *
 * Layout: table of contents on the left (sticky on lg+), long-form scrolling
 * content on the right. Each major step has a numbered heading, plain-English
 * body, and at least one Annotation callout with a tip / gotcha.
 *
 * Anyone landing here for the first time should be able to read top-to-bottom
 * and be productive without needing additional documentation.
 */
export default function GuidePage() {
  return (
    <div className="min-h-screen bg-ink-900 text-ink-50">
      <Header />
      <main className="max-w-[1600px] mx-auto px-6 py-10">
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
            Everything you need to know to take off a masonry job in beme — from
            setting up your block library through to exporting the finished
            estimate. Written for any region; substitute your own block names
            and dimensions as you go.
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

          {/* Long-form content. */}
          <article className="prose-content space-y-12 max-w-3xl">
            <Section id="welcome" title="Welcome to beme">
              <P>
                Beme turns a building plan PDF into a priced masonry estimate.
                You upload the plan, trace the walls, openings, and piers, and
                beme tallies blocks (or bricks), lintels, ties, mortar, and any
                supply items you've configured — ready to export to PDF or
                Excel for your customer.
              </P>
              <P>
                Five minutes of one-off setup the first time, then a few
                minutes per estimate after that. The rest of this guide walks
                you through both.
              </P>
              <Annotation kind="tip">
                If you're impatient, jump to{' '}
                <a href="#first-estimate" className="text-beme-300 underline hover:text-beme-200">
                  Your first estimate
                </a>{' '}
                and refer back to the earlier sections when you hit something
                unfamiliar.
              </Annotation>
            </Section>

            <Section id="library" title="1. Set up your material library">
              <P>
                Open <strong>Material library</strong> from the dashboard.
                This is your one-time setup, shared across every estimate you
                ever do (and across your team if you're in an organisation).
                Three tabs:
              </P>
              <Ul>
                <li>
                  <strong>Blocks</strong> — every concrete block you supply.
                  Code, dimensions (height × width × depth), and one or more{' '}
                  <em>roles</em>: body, corner, end-termination, fraction,
                  lintel, pier, height-makeup, etc. The role tells beme
                  what slot in a wall this block fills.
                </li>
                <li>
                  <strong>Bricks</strong> — every brick type. Dimensions,
                  mortar-joint thickness, and the auto-calculated bricks-per-
                  square-metre rate.
                </li>
                <li>
                  <strong>Supply items</strong> — anything else you price
                  into an estimate. Cement, ties, rebar, flashings, sealants.
                  Each item is named whatever you want, and supplied by a
                  rate: <em>per block</em>, <em>per brick</em>,{' '}
                  <em>per m²</em>, <em>per lineal m</em>, <em>per opening</em>,
                  or just a flat <em>each</em>.
                </li>
              </Ul>
              <Annotation kind="tip">
                Role tags matter more than you'd think. When beme calculates
                a wall it doesn't search for "20.01" by name — it asks the
                library "which block is the corner block?" by role. So as
                long as a block in your library is tagged with the right
                roles, beme uses it correctly regardless of what you call it.
              </Annotation>
              <Annotation kind="warning">
                Org members on a team account see the library in read-only
                mode. Only the organisation admin can add / edit / delete
                blocks. Ask your admin if you need a block added.
              </Annotation>
            </Section>

            <Section id="first-estimate" title="2. Start your first estimate">
              <P>
                On the dashboard, click <strong>+ Block estimate</strong> or{' '}
                <strong>+ Brick estimate</strong> (whichever this job is).
                You'll land in an empty workspace.
              </P>
              <P>
                <strong>Upload the plan.</strong> Drag a PDF into the drop
                zone (or click to browse). The plan renders in the canvas. If
                you have engineering or structural drawings, add them as{' '}
                <em>reference PDFs</em> via <strong>+ Add reference</strong> —
                you can flip between them with the tabs above the toolbar.
              </P>
              <P>
                <strong>Calibrate the scale.</strong> Pick two points on the
                plan with a known dimension (a labelled wall length is
                easiest), then type the real-world length. Or use one of the
                ratio presets (1:50, 1:100, 1:200, etc.) from the dropdown
                next to the scale. The wall lengths beme tallies later all
                come from this calibration, so do it carefully on every page.
              </P>
              <Annotation kind="tip">
                You can recalibrate at any time — click <strong>Recalibrate</strong>{' '}
                next to the scale in the toolbar. Useful if you discover a
                misalignment 30 walls in and don't want to redraw everything.
                The previously-drawn walls scale to match the new calibration.
              </Annotation>
            </Section>

            <Section id="wall-types" title="3. Set up wall types">
              <P>
                Before you can draw, you need at least one wall type
                (in block mode) or your brick settings configured (in brick
                mode). A wall type defines:
              </P>
              <Ul>
                <li>Bond pattern (stretcher or stack)</li>
                <li>Wall height</li>
                <li>Which block goes where (base course, body, top, corner)</li>
                <li>Whether to use fraction blocks for length makeup</li>
                <li>Any per-course overrides for things like bond beams</li>
              </Ul>
              <P>
                Each wall type gets a colour (auto-assigned from a palette)
                that the walls on the plan are drawn in, so it's easy to see
                at a glance which type is where.
              </P>
              <P>
                Add several if your job has different wall types (e.g. an
                external 2400 mm stretcher and an internal 2400 mm stack).
                The <strong>Active</strong> wall type is the one new walls
                are drawn with — click any wall type in the side panel to
                make it active.
              </P>
              <Annotation kind="tip">
                Reassign walls to different types later by selecting them
                (Shift+click for multi-select) and using the wall-type
                dropdown in the side panel.
              </Annotation>
            </Section>

            <Section id="drawing" title="4. Draw walls">
              <P>
                Click <strong>Draw wall</strong> (or press <Kbd>W</Kbd>).
                Click two points on the plan and a wall appears between them.
                The cursor snaps to existing wall endpoints (green ring),
                wall faces (purple ring), and orthogonal directions, so
                corners and T-junctions form cleanly without pixel-precise
                clicking.
              </P>
              <Annotation kind="tip">
                <strong>Type a length for precision.</strong> After your first
                click, type a number on the keyboard and press <Kbd>Enter</Kbd>.
                The wall will commit at exactly that length in the direction
                your cursor is pointing — useful when the plan's labelled
                dimensions are more accurate than your click position.
              </Annotation>
              <P>
                For curves, click <strong>↷ Curved wall</strong> (or press{' '}
                <Kbd>C</Kbd>). Three clicks: first wall to anchor onto,
                second wall, then the midpoint of the arc.
              </P>
            </Section>

            <Section id="openings" title="5. Add openings (doors and windows)">
              <P>
                Click <strong>+ Add opening</strong> (or press <Kbd>O</Kbd>),
                then click two points along an existing wall to define the
                width.
              </P>
              <P>
                A dialog appears asking for the opening's sill height (block
                mode) or just the opening height (brick mode). Both modes
                offer <strong>preset chips</strong> for common dimensions —
                Door 2100, Window 1500, etc. — that pre-fill the inputs.
                The lintel (if your region uses one) is selected
                automatically from the library.
              </P>
              <Annotation kind="warning">
                Openings are tied to the wall they're placed on. Delete the
                wall and any openings on it go with it. Drag a wall endpoint
                across a wall whose opening would no longer fit, and beme
                will warn you.
              </Annotation>
            </Section>

            <Section id="piers" title="6. Piers">
              <P>
                Block mode only. Click <strong>+ Pier</strong> (or press{' '}
                <Kbd>P</Kbd>) and click:
              </P>
              <Ul>
                <li>
                  <strong>On a wall</strong> → a tied pier (built into the
                  wall, alternating pier and corner blocks per course)
                </li>
                <li>
                  <strong>Off any wall</strong> → a freestanding pier
                  (standalone column of pier blocks)
                </li>
              </Ul>
              <P>
                Pier dimensions and course pattern come from the pier
                makeup — defined alongside wall types in the side panel.
              </P>
            </Section>

            <Section id="selection" title="7. Selecting and editing">
              <P>
                <strong>Click any wall, opening, or pier</strong> to select
                it. The side panel shows actions: change wall type,
                drag endpoints to reposition, delete, etc.
              </P>
              <P>
                <strong>Shift+click multiple items</strong> to multi-select
                across walls, openings, and piers. A batch action bar appears
                with <em>Delete all</em>, and for walls, a wall-type dropdown
                that reassigns every selected wall at once.
              </P>
              <P>
                <strong>Press <Kbd>Delete</Kbd> or <Kbd>Backspace</Kbd></strong>{' '}
                to remove everything in the selection. Walls go last, so any
                attached openings or piers vanish along with their parent
                wall automatically.
              </P>
              <Annotation kind="tip">
                <Kbd>Ctrl+Z</Kbd> undoes any change — drawing, deleting,
                moving, reassigning, splitting at a control joint. Up to
                50 steps. <Kbd>Ctrl+Y</Kbd> (or <Kbd>Ctrl+Shift+Z</Kbd>) redoes.
              </Annotation>
            </Section>

            <Section id="multi-page" title="8. Multi-page plans + reference PDFs">
              <P>
                If your plan PDF has multiple pages, page nav appears
                automatically in the toolbar and a thumbnail rail down the
                left side. Each page has its own calibration, walls, openings,
                and piers — but they all roll up into one total tally in the
                side panel.
              </P>
              <P>
                Attach reference PDFs (engineering, structural, architectural
                detail sheets) via the <strong>+ Add reference</strong> button
                in the File row at the top. They're view-only — walls live on
                the primary plan — but you can flip to them at any time to
                cross-check wall types or detail callouts.
              </P>
            </Section>

            <Section id="shortcuts" title="9. Keyboard shortcuts">
              <P>Press <Kbd>?</Kbd> in the workspace at any time for the
                inline cheat sheet. Highlights:</P>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1.5 my-3">
                <ShortcutRow keys={['W']} label="Draw wall" />
                <ShortcutRow keys={['O']} label="Add opening" />
                <ShortcutRow keys={['C']} label="Curved wall (block mode)" />
                <ShortcutRow keys={['J']} label="Control joint" />
                <ShortcutRow keys={['P']} label="Pier" />
                <ShortcutRow keys={['Esc']} label="Cancel current tool" />
                <ShortcutRow keys={['Shift', '+', 'click']} label="Multi-select" />
                <ShortcutRow keys={['Del']} label="Delete selected" />
                <ShortcutRow keys={['Ctrl', '+', 'Z']} label="Undo" />
                <ShortcutRow keys={['Ctrl', '+', 'Y']} label="Redo" />
                <ShortcutRow keys={['type', '+', 'Enter']} label="Wall to exact length" />
                <ShortcutRow keys={['?']} label="Toggle this list" />
              </div>
            </Section>

            <Section id="export" title="10. Export the estimate">
              <P>
                In the right-hand <strong>Export estimate</strong> panel,
                tick the sections you want to include and click{' '}
                <strong>Save as PDF</strong> (or copy as Excel from the same
                panel). The export uses your business name, ABN, logo, and
                tax rate from <strong>Settings → Business</strong>.
              </P>
              <P>
                Sections you can include:
              </P>
              <Ul>
                <li><strong>Assumptions</strong> — generated from project notes + brick/block settings</li>
                <li><strong>Block / brick schedule</strong> — totals per code</li>
                <li><strong>Wall type breakdown</strong> — totals per wall type</li>
                <li><strong>Openings list</strong> — every opening with dimensions and the lintel selected</li>
                <li><strong>Lintels / ties / plascourse</strong> (regional — toggle in Settings → Preferences)</li>
                <li><strong>Supply items</strong> — anything in your supply-items library</li>
                <li><strong>Disclaimer</strong></li>
              </Ul>
              <Annotation kind="tip">
                Untick sections that don't apply to this customer (e.g. internal
                jobs with no lintels). Toggles only affect the export — the
                tally still has those numbers available for re-export later.
              </Annotation>
            </Section>

            <Section id="organisations" title="11. Working in a team">
              <P>
                Beme supports organisations — typically a masonry supplier
                with multiple sales staff and estimators. Three roles:
              </P>
              <Ul>
                <li>
                  <strong>Admin</strong> — full control. Can edit the
                  shared material library, manage members, change branding.
                </li>
                <li>
                  <strong>Sales</strong> — can create new estimate requests
                  and send them to estimators. Sees all org requests.
                </li>
                <li>
                  <strong>Estimator</strong> — receives estimate requests,
                  completes the estimate in beme, returns it to sales. Sees
                  all org requests.
                </li>
              </Ul>
              <P>
                Your dashboard shows an inbox split: <em>"Needs you to pick
                up"</em> (assigned but not started), <em>"Currently working
                on"</em> (in progress), and a <em>team inbox</em> of what
                everyone else is up to. Pick up a request inline with the{' '}
                <strong>Pick up</strong> button and it becomes yours.
              </P>
              <Annotation kind="tip">
                Single-user accounts get the same workspace but skip the
                inbox / team views entirely. Everything's just "your
                projects" in chronological order.
              </Annotation>
            </Section>

            <Section id="tips" title="Final tips">
              <Ul>
                <li>
                  <strong>Duplicate a similar project</strong> when starting a
                  new estimate for the same client / same wall types. The
                  Duplicate button on each dashboard row creates a fresh
                  project with all your setup pre-loaded.
                </li>
                <li>
                  <strong>Use control joints</strong> (<Kbd>J</Kbd>) to split a
                  long wall at a specific point — handy for marking
                  expansion joints or breaking up a single drawn wall into
                  two priced pieces.
                </li>
                <li>
                  <strong>Save changes</strong> commits to cloud. You'll see
                  the button grey out when there's nothing to save, light up
                  the moment you make a change. <Kbd>Ctrl+S</Kbd> saves from
                  anywhere too.
                </li>
                <li>
                  <strong>Regional features.</strong> In Settings →
                  Preferences, toggle lintels / brick ties / plascourse off
                  if your market doesn't use them. New projects inherit the
                  toggle.
                </li>
              </Ul>
            </Section>

            <Section id="help" title="Need more help?">
              <P>
                If something's not working as expected, or you'd like a
                feature added that would help your day-to-day, get in touch.
                Beme is actively developed — feedback shapes what gets built
                next.
              </P>
            </Section>
          </article>
        </div>
      </main>
    </div>
  )
}

// ─── Table of contents ────────────────────────────────────────────────────────

const TOC: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'welcome', label: 'Welcome' },
  { id: 'library', label: '1. Material library' },
  { id: 'first-estimate', label: '2. First estimate' },
  { id: 'wall-types', label: '3. Wall types' },
  { id: 'drawing', label: '4. Draw walls' },
  { id: 'openings', label: '5. Openings' },
  { id: 'piers', label: '6. Piers' },
  { id: 'selection', label: '7. Selecting + editing' },
  { id: 'multi-page', label: '8. Multi-page + references' },
  { id: 'shortcuts', label: '9. Shortcuts' },
  { id: 'export', label: '10. Export' },
  { id: 'organisations', label: '11. Teams' },
  { id: 'tips', label: 'Final tips' },
  { id: 'help', label: 'Need help?' },
]

// ─── Small typography helpers ────────────────────────────────────────────────

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
      <h3 className="text-xl font-bold text-ink-50 mb-3">{title}</h3>
      <div className="space-y-3 text-ink-200 leading-relaxed">{children}</div>
    </section>
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
