import { useEffect, useMemo, useRef, useState } from 'react'
import { useBlockLibrary } from '../data/blockLibrary'
import LengthInput from '../components/LengthInput'
import { resolveBlockByRole } from '../lib/blockRoles'
import { registerPendingEditor } from '../lib/pendingEdits'
import { toast } from '../lib/toast'
import { useUnsavedChangesPrompt } from '../lib/useUnsavedChangesPrompt'
import { formatLengthMm } from '../lib/units'
import { updateUserSettings, useUserSettings } from '../lib/userSettings'
import { computeAutoWallLengthSnapMm } from '../lib/wallLengthSnap'
import { DEFAULT_MORTAR_JOINT_MM } from '../types/blocks'
import type { Block, BlockRole } from '../types/blocks'
import type { DefaultsByRole, EstimatingDefaults } from '../types/userSettings'

/**
 * The single home for estimating defaults, surfaced as the Material
 * Library → Defaults tab. Two concerns live here:
 *
 * 1. Estimating values - the starting numbers every new wall makeup
 * inherits (height, bond, mortar, opening overlap, length snapping).
 * Moved out of Settings so all "what a new estimate starts from"
 * controls sit next to the catalogue they reference.
 * 2. Default blocks by role - which block in the library fills each
 * functional slot (body, corner, half, control-joint ends, base, top,
 * cap, pier, etc.) when a wall makeup doesn't name one explicitly.
 * Writes a per-role preferred code to settings.defaultsByRole; the
 * calc engine reads it through resolveBlockByRole. Non-destructive -
 * it never retags the catalogue, so a block can stay tagged for two
 * wall thicknesses while only one is the default.
 *
 * Save model: explicit. Edits collect in a local draft and only persist
 * when the user hits Save - a floating bar appears whenever there are
 * unsaved changes. Discard reverts the draft to the last saved state.
 */
export default function EstimatingDefaultsForm({
  readOnly = false,
}: {
  readOnly?: boolean
}) {
  const { settings } = useUserSettings()
  const { library, version } = useBlockLibrary()
  const unitsPref = settings.preferences.units

  // Local draft. Edits land here; nothing persists until Save.
  const [draftDefaults, setDraftDefaults] = useState<EstimatingDefaults>(
    settings.defaults
  )
  const [draftRoles, setDraftRoles] = useState<DefaultsByRole>(
    settings.defaultsByRole ?? {}
  )
  // True once the user touches a field - guards the re-sync effect so an
  // async settings load (or a save elsewhere) doesn't wipe pending edits.
  const editedRef = useRef(false)

  // Re-sync the draft from saved settings only while the user has no
  // pending edits (covers the first async load and external changes).
  useEffect(() => {
    if (editedRef.current) return
    setDraftDefaults(settings.defaults)
    setDraftRoles(settings.defaultsByRole ?? {})
  }, [settings.defaults, settings.defaultsByRole])

  const defaults = draftDefaults

  // The control-joint snap falls back to the wall-length snap when the
  // user hasn't pinned one, so show that value in the (unset) input.
  const effectiveWallSnap =
    draftDefaults.wallLengthSnapMm ??
    computeAutoWallLengthSnapMm(
      library,
      draftDefaults.defaultMortarJointMm ?? DEFAULT_MORTAR_JOINT_MM
    )

  const dirty = useMemo(
    () =>
      JSON.stringify(draftDefaults) !== JSON.stringify(settings.defaults) ||
      JSON.stringify(draftRoles) !==
        JSON.stringify(settings.defaultsByRole ?? {}),
    [draftDefaults, draftRoles, settings.defaults, settings.defaultsByRole]
  )

  const set = (p: Partial<EstimatingDefaults>) => {
    if (readOnly) return
    editedRef.current = true
    setDraftDefaults((d) => ({ ...d, ...p }))
  }

  const setRole = (key: keyof DefaultsByRole, code: string) => {
    if (readOnly) return
    editedRef.current = true
    setDraftRoles((r) => {
      const next: DefaultsByRole = { ...r }
      if (code) next[key] = code
      else delete next[key]
      return next
    })
  }

  const save = () => {
    if (readOnly || !dirty) return
    updateUserSettings({ defaults: draftDefaults, defaultsByRole: draftRoles })
    editedRef.current = false
    toast.success('Defaults saved')
  }

  const discard = () => {
    editedRef.current = false
    setDraftDefaults(settings.defaults)
    setDraftRoles(settings.defaultsByRole ?? {})
  }

  // Guard 1: route navigation + browser close (Link clicks, back button,
  // refresh). Prompts Save & leave / Discard / Stay.
  useUnsavedChangesPrompt(dirty, {
    message:
      'You have unsaved default changes. Save them before leaving, or discard?',
    onSave: async () => {
      save()
    },
  })

  // Guard 2: in-page tab switches inside the Material Library (Defaults →
  // Blocks, etc.). Those change only the hash, so the router blocker
  // above ignores them and the form would unmount silently. Register the
  // live dirty + save through refs so the registration stays stable while
  // the tab switcher reads the freshest values.
  const dirtyRef = useRef(dirty)
  dirtyRef.current = dirty
  const saveRef = useRef(save)
  saveRef.current = save
  useEffect(
    () =>
      registerPendingEditor({
        isDirty: () => dirtyRef.current,
        save: () => saveRef.current(),
      }),
    []
  )

  const renderPicker = (rp: RolePicker) => {
    const auto = resolveBlockByRole(rp.role, library, {
      settings: { defaultsByRole: {} },
    })
    const autoLabel = auto ? `Auto (${auto.code})` : 'Auto (none in library)'
    const pinned = draftRoles[rp.key] ?? ''
    return (
      <Field key={rp.key} label={rp.label} hint={rp.hint}>
        <Select<string>
          value={pinned}
          onChange={(v) => setRole(rp.key, v)}
          disabled={readOnly}
          options={[
            { value: '', label: autoLabel },
            ...orderedBlocksForRole(rp.role, library).map((b) => ({
              value: b.code,
              label: `${b.code} - ${b.name}`,
            })),
          ]}
        />
      </Field>
    )
  }

  const renderPickerCard = (
    title: string,
    description: string,
    pickers: RolePicker[]
  ) => (
    <PanelCard title={title} description={description}>
      {/* version keys the grid to library edits so the Auto labels +
          option lists refresh after a catalogue change. */}
      <div key={version} className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {pickers.map(renderPicker)}
      </div>
    </PanelCard>
  )

  return (
    <div className="space-y-6">
      <div className="sticky top-0 z-20 flex items-center justify-between gap-3 rounded-xl border border-ink-600 bg-ink-900/95 px-4 py-3 backdrop-blur">
        <span className="text-sm text-ink-300">
          {readOnly
            ? 'Read only - your org admin manages these defaults.'
            : dirty
              ? 'You have unsaved changes.'
              : 'All changes saved.'}
        </span>
        {!readOnly && (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={discard}
              disabled={!dirty}
              className="px-3 py-1.5 rounded-lg text-sm font-medium border border-ink-600 text-ink-200 hover:bg-ink-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              Discard
            </button>
            <button
              type="button"
              onClick={save}
              disabled={!dirty}
              className="px-4 py-1.5 rounded-lg text-sm font-semibold bg-beme-500 text-white hover:bg-beme-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              Save changes
            </button>
          </div>
        )}
      </div>

      <PanelCard
        title="Wall basics"
        description="Applied to every new wall makeup you create in a project."
      >
        <FieldGroup>
          <Field label="Default wall height">
            <LengthInput
              valueMm={defaults.defaultWallHeightMm}
              onChangeMm={(v) => set({ defaultWallHeightMm: v })}
              minMm={200}
              disabled={readOnly}
            />
          </Field>
          <Field label="Default bond type">
            <Select<'stretcher' | 'stack'>
              value={defaults.defaultBondType}
              onChange={(v) => set({ defaultBondType: v })}
              disabled={readOnly}
              options={[
                { value: 'stretcher', label: 'Stretcher bond (half-block stagger)' },
                { value: 'stack', label: 'Stack bond (no stagger)' },
              ]}
            />
          </Field>
          <Field label="Default mortar joint">
            <LengthInput
              valueMm={defaults.defaultMortarJointMm}
              onChangeMm={(v) => set({ defaultMortarJointMm: v })}
              minMm={0}
              disabled={readOnly}
            />
          </Field>
        </FieldGroup>
      </PanelCard>

      <PanelCard
        title="Openings"
        description="Defaults for doors and windows in new walls."
      >
        <FieldGroup>
          <Field
            label="Opening snap increment"
            hint="New openings snap their position AND width to this. Set 200mm to land reveals on block ends; 10mm is near-free placement. Hold Shift while placing to bypass."
          >
            <LengthInput
              valueMm={defaults.openingSnapMm ?? 10}
              onChangeMm={(v) => set({ openingSnapMm: Math.max(1, v) })}
              minMm={1}
              disabled={readOnly}
            />
          </Field>
          <Field
            label="Default lintel overlap"
            hint="Lintel end-bearing added to EACH side of an opening head. A 1000mm opening at 190mm lays a 1380mm lintel; the lintel ends rest on the masonry either side. Adjust per opening by clicking it. 0 = no bearing."
          >
            <LengthInput
              valueMm={defaults.defaultLintelBearingMm ?? 0}
              onChangeMm={(v) => set({ defaultLintelBearingMm: v })}
              minMm={0}
              disabled={readOnly}
            />
          </Field>
          <Field
            label="Window head allowance"
            hint="Gap from the top of a new window to the top of the wall (the lintel band). New windows sit this far down; change per window after placing."
          >
            <LengthInput
              valueMm={defaults.windowHeadReserveMm ?? 300}
              onChangeMm={(v) => set({ windowHeadReserveMm: v })}
              minMm={0}
              disabled={readOnly}
            />
          </Field>
        </FieldGroup>
      </PanelCard>

      <PanelCard
        title="Length & cuts"
        description="How new walls round off and absorb leftover length."
      >
        <FieldGroup>
          {(() => {
            // The auto value is derived from the active block library
            // + the user's mortar joint default. When the user hasn't
            // explicitly set a snap, this is the value drawing uses.
            const autoSnap = computeAutoWallLengthSnapMm(
              library,
              defaults.defaultMortarJointMm ?? DEFAULT_MORTAR_JOINT_MM
            )
            const isAuto = defaults.wallLengthSnapMm === undefined
            const autoSnapDisplay = formatLengthMm(autoSnap, unitsPref)
            return (
              <Field
                label="Wall length snap"
                hint={`When drawing a wall, the live length rounds to the nearest multiple of this. Leave on Auto to follow the active library - currently ${autoSnapDisplay}. Set a custom value to override.`}
              >
                <div className="flex items-center gap-2">
                  <LengthInput
                    valueMm={defaults.wallLengthSnapMm ?? autoSnap}
                    onChangeMm={(v) => set({ wallLengthSnapMm: Math.max(1, v) })}
                    minMm={1}
                    disabled={readOnly}
                  />
                  {isAuto ? (
                    <span className="text-[11px] px-2 py-0.5 rounded bg-beme-500/20 text-beme-300 font-medium border border-beme-500/30">
                      Auto
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => set({ wallLengthSnapMm: undefined })}
                      disabled={readOnly}
                      className="text-[11px] px-2 py-0.5 rounded border border-ink-600 text-ink-300 hover:bg-ink-700 transition-colors disabled:opacity-50"
                      title={`Reset to auto-derived (${autoSnapDisplay})`}
                    >
                      Use auto
                    </button>
                  )}
                </div>
              </Field>
            )
          })()}
          <Field
            label="Match exact wall length"
            hint="When on, the calc absorbs leftover length using fraction-tagged blocks (e.g. AU 20.02 / 20.22), or tallies cut blocks if your library has none. When off, walls round up to whole body blocks and the gap is ignored."
          >
            <Select<'yes' | 'no'>
              value={(defaults.defaultMatchExactLength ?? true) ? 'yes' : 'no'}
              onChange={(v) => set({ defaultMatchExactLength: v === 'yes' })}
              disabled={readOnly}
              options={[
                { value: 'yes', label: 'On (use fractions / cut blocks)' },
                { value: 'no', label: 'Off (round up to whole blocks)' },
              ]}
            />
          </Field>
          {(defaults.defaultMatchExactLength ?? true) && (
            <Field
              label="Apply exact length to"
              hint="Which course types match exact length. The rest round up to whole blocks. 'Body only' is the most common - avoids cuts on the cleanout / cap row. 'Body + bottom' or 'Body + top' lets you also match the base or cap course. 'All courses' matches everything."
            >
              {(() => {
                // Preset → set of course-type buckets. The dropdown
                // shows these presets; selecting one writes the set
                // back to defaultExactLengthCourses. Matching the saved
                // set against the presets picks the displayed value.
                type Bucket = 'base' | 'body' | 'height-makeup' | 'top'
                const PRESETS: Array<{ key: string; label: string; set: Bucket[] }> = [
                  { key: 'all', label: 'All courses', set: ['base', 'body', 'height-makeup', 'top'] },
                  { key: 'body', label: 'Body courses only', set: ['body'] },
                  { key: 'body-bottom', label: 'Body + bottom (base)', set: ['body', 'base'] },
                  { key: 'body-top', label: 'Body + top', set: ['body', 'top'] },
                  { key: 'body-bottom-top', label: 'Body + bottom + top', set: ['body', 'base', 'top'] },
                  { key: 'body-hm', label: 'Body + height makeup', set: ['body', 'height-makeup'] },
                  { key: 'none', label: 'None', set: [] },
                ]
                const sameSet = (a: Bucket[], b: Bucket[]): boolean => {
                  if (a.length !== b.length) return false
                  const sa = [...a].sort()
                  const sb = [...b].sort()
                  for (let i = 0; i < sa.length; i++) {
                    if (sa[i] !== sb[i]) return false
                  }
                  return true
                }
                const current: Bucket[] =
                  defaults.defaultExactLengthCourses ?? ['base', 'body', 'height-makeup', 'top']
                const matched = PRESETS.find((p) => sameSet(p.set, current))
                const value = matched?.key ?? 'custom'
                const options = matched
                  ? PRESETS.map((p) => ({ value: p.key, label: p.label }))
                  : [
                      { value: 'custom', label: 'Custom combination' },
                      ...PRESETS.map((p) => ({ value: p.key, label: p.label })),
                    ]
                return (
                  <Select<string>
                    value={value}
                    onChange={(v) => {
                      const preset = PRESETS.find((p) => p.key === v)
                      if (preset) set({ defaultExactLengthCourses: preset.set })
                    }}
                    disabled={readOnly}
                    options={options}
                  />
                )
              })()}
            </Field>
          )}
        </FieldGroup>
      </PanelCard>

      {renderPickerCard(
        'Default wall blocks',
        'The blocks a new wall type starts with. You can still change any of these per wall type in the wall type editor. Leave on Auto to use the first matching block in the library.',
        WALL_BLOCK_PICKERS
      )}

      <PanelCard
        title="Control joints"
        description="How control joints place and which blocks terminate them. Applies to every control joint unless you override a specific one on the 2D plan."
      >
        <div key={version} className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field
            label="Control joint snap increment"
            hint="New control joints snap their position along the wall to this. Set 200mm to land them on block ends. Falls back to your wall length snap when left as-is; hold Shift while placing to bypass."
          >
            <LengthInput
              valueMm={defaults.controlJointSnapMm ?? effectiveWallSnap}
              onChangeMm={(v) => set({ controlJointSnapMm: Math.max(1, v) })}
              minMm={1}
              disabled={readOnly}
            />
          </Field>
          {CONTROL_JOINT_PICKERS.map(renderPicker)}
        </div>
      </PanelCard>
    </div>
  )
}

/**
 * A single role picker. `key` is the DefaultsByRole field written to
 * settings; `role` is the BlockRole the calc resolves against.
 */
type RolePicker = {
  key: keyof DefaultsByRole
  role: BlockRole
  label: string
  hint: string
}

/**
 * Blocks a new wall type is seeded with, bottom of the wall to top.
 * Each is ALSO editable per wall type in the wall-type editor - this
 * just sets the starting pick, so changing it never touches existing
 * walls.
 */
const WALL_BLOCK_PICKERS: RolePicker[] = [
  { key: 'body', role: 'body', label: 'Body block', hint: 'Main course body block.' },
  { key: 'corner', role: 'corner', label: 'Corner / full end', hint: 'Full block at corners and free ends.' },
  { key: 'half', role: 'end-termination', label: 'Half / end block', hint: 'Half block at wall ends in stretcher bond.' },
  { key: 'base', role: 'base-course', label: 'Base course', hint: 'Bottom course (cleanout) block.' },
  { key: 'top', role: 'top-course', label: 'Top course', hint: 'Top course / bond-beam block.' },
  { key: 'cap', role: 'cap', label: 'Capping', hint: 'Capping tile across the top (optional).' },
]

/**
 * Control-joint terminations. Unlike the wall blocks above, these have
 * no per-wall-type field - the calc reaches for them at every control
 * joint that isn't overridden on the plan.
 */
const CONTROL_JOINT_PICKERS: RolePicker[] = [
  { key: 'controlJointFull', role: 'control-joint-full', label: 'Full end', hint: 'Full-end block at a control joint (e.g. a squint).' },
  { key: 'controlJointHalf', role: 'control-joint-half', label: 'Half end', hint: 'Half-end block at a control joint.' },
]

/**
 * Blocks ordered for a role picker: blocks tagged with the role first
 * (the sensible candidates), then everything else, each group sorted by
 * code. The picker still lists every block so a user can pin one that
 * isn't tagged yet (common for control-joint squints).
 */
function orderedBlocksForRole(
  role: BlockRole,
  library: Record<string, Block>
): Block[] {
  const all = Object.values(library)
  const byCode = (a: Block, b: Block) => a.code.localeCompare(b.code)
  const tagged = all.filter((b) => b.roles.includes(role)).sort(byCode)
  const rest = all.filter((b) => !b.roles.includes(role)).sort(byCode)
  return [...tagged, ...rest]
}

// ─── Local form primitives ──────────────────────────────────────────────────
// Self-contained clones of the Settings form chrome so this panel doesn't
// depend on SettingsPage internals. Same classes = same look.

function PanelCard({
  title,
  description,
  children,
}: {
  title: string
  description?: string
  children: React.ReactNode
}) {
  return (
    <div className="border border-ink-600 rounded-xl bg-ink-800 p-6">
      <div className="mb-5">
        <h3 className="text-lg font-bold text-ink-50">{title}</h3>
        {description && <p className="text-sm text-ink-300 mt-1">{description}</p>}
      </div>
      <div className="space-y-4">{children}</div>
    </div>
  )
}

function FieldGroup({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-1 md:grid-cols-2 gap-4">{children}</div>
}

function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <label className="block">
      <span className="block text-xs font-semibold uppercase tracking-[0.08em] text-ink-400 mb-1">
        {label}
      </span>
      {children}
      {hint && <span className="block text-[11px] text-ink-400 mt-1">{hint}</span>}
    </label>
  )
}

function Select<T extends string>({
  value,
  onChange,
  options,
  disabled,
}: {
  value: T
  onChange: (v: T) => void
  options: { value: T; label: string }[]
  disabled?: boolean
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as T)}
      disabled={disabled}
      className="w-full px-3 py-2 border border-ink-600 rounded-lg text-sm bg-ink-900 text-ink-50 focus:outline-none focus:border-beme-400 disabled:opacity-60"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  )
}
