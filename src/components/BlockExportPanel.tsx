import { useState } from 'react'
import type {
  BlockExportInclusions,
  Opening,
  Pier,
  PierMakeup,
  ProjectDetails,
  Wall,
  WallMakeup,
} from '../types/walls'
import { exportBlockEstimate, type PageInfo } from '../lib/blockExport'
import { useUserSettings } from '../lib/userSettings'
import { useOrganisations } from '../lib/organisations'

interface BlockExportPanelProps {
  projectDetails: ProjectDetails
  inclusions: BlockExportInclusions
  onChangeInclusions: (inclusions: BlockExportInclusions) => void
  walls: Wall[]
  makeups: WallMakeup[]
  openings: Opening[]
  piers?: Pier[]
  pierMakeups?: PierMakeup[]
  /**
   * The uploaded plan PDF. When provided alongside `pagesInfo`, the export
   * rasterises each page's plan as the SVG background for its Wall Layout
   * overview so the reader sees the real building plan with the walls
   * drawn over it.
   */
  pdfFile?: File | null
  /**
   * One entry per PDF page that has any walls — the export builds a
   * separate Wall Layout overview page for each, labelled with the page's
   * label or its page number. Multi-floor projects rely on this; single-
   * page exports just pass a one-element array.
   */
  pagesInfo?: PageInfo[]
}

export default function BlockExportPanel({
  projectDetails,
  inclusions,
  onChangeInclusions,
  walls,
  makeups,
  openings,
  piers = [],
  pierMakeups = [],
  pdfFile,
  pagesInfo,
}: BlockExportPanelProps) {
  // Collapsed by default in the rail — export is end-of-workflow.
  const [expanded, setExpanded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { settings: userSettings } = useUserSettings()
  const { currentOrg } = useOrganisations()

  /**
   * Per-page exclusion: when a project carries stale walls on an old PDF
   * page (e.g. a first-attempt estimate the user moved past, but the walls
   * weren't deleted), the user can tick those pages OFF here to drop them
   * from this export entirely — Wall Layout sections AND the project-wide
   * Block Schedule both use the filtered subset. Default is all pages
   * included; the state stores the SET of excluded page numbers so adding
   * a new page automatically opts it in.
   */
  const [excludedPages, setExcludedPages] = useState<Set<number>>(new Set())

  function patch(p: Partial<BlockExportInclusions>) {
    onChangeInclusions({ ...inclusions, ...p })
  }

  function togglePage(pageNumber: number) {
    setExcludedPages((prev) => {
      const next = new Set(prev)
      if (next.has(pageNumber)) next.delete(pageNumber)
      else next.add(pageNumber)
      return next
    })
  }

  // Filter walls / openings / piers / pagesInfo down to just the pages the
  // user wants in this export. The filtered arrays drive both the Wall
  // Layout sections (per-page) and the project-wide Block Schedule, so
  // unticking a page genuinely removes its walls from every count.
  const includedPagesInfo = (pagesInfo ?? []).filter(
    (p) => !excludedPages.has(p.pageNumber)
  )
  const filteredWalls = pagesInfo
    ? includedPagesInfo.flatMap((p) => p.walls)
    : walls
  const filteredOpenings = pagesInfo
    ? includedPagesInfo.flatMap((p) => p.openings)
    : openings
  const filteredPiers = pagesInfo
    ? includedPagesInfo.flatMap((p) => p.piers)
    : piers

  async function handleExport() {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await exportBlockEstimate({
        projectDetails,
        inclusions,
        walls: filteredWalls,
        makeups,
        openings: filteredOpenings,
        piers: filteredPiers,
        pierMakeups,
        pdfFile: pdfFile ?? undefined,
        pagesInfo: includedPagesInfo,
        // Pass the user's business identity through so exports become branded.
        // When the user is signed in to an organisation, the org's name takes
        // precedence over the personal business.companyName field — that way
        // estimates exported from inside ABC always read 'ABC Building Products'
        // in the top-left, regardless of what the user has typed into their
        // personal Settings → Business tab. Other fields (ABN, phone, address,
        // logo) still come from personal settings, on the assumption that the
        // sales rep / estimator is using their own contact details.
        business: {
          companyName: currentOrg?.name || userSettings.business.companyName,
          abn: userSettings.business.abn,
          phone: userSettings.business.phone,
          website: userSettings.business.website,
          addressLine1: userSettings.business.addressLine1,
          addressLine2: userSettings.business.addressLine2,
          suburb: userSettings.business.suburb,
          state: userSettings.business.state,
          postcode: userSettings.business.postcode,
          logoUrl: currentOrg?.logoUrl || userSettings.business.logoUrl,
        },
      })
    } catch (e) {
      setError((e as Error).message ?? 'Export failed')
    } finally {
      setBusy(false)
    }
  }

  const canExport = filteredWalls.length > 0 && !busy

  return (
    <div className="my-4 border border-ink-600 rounded-xl bg-ink-800 p-3">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-2 text-left group mb-2"
      >
        <span className="text-ink-500 group-hover:text-neutral-600 text-xs">
          {expanded ? '▾' : '▸'}
        </span>
        <h3 className="text-sm font-semibold text-ink-50 group-hover:text-beme-300">
          Export estimate
        </h3>
        {!expanded && (
          <span className="text-xs text-ink-400 truncate">
            · {Object.values(inclusions).filter(Boolean).length} sections selected
          </span>
        )}
      </button>

      {!expanded && (
        <button
          onClick={handleExport}
          disabled={!canExport}
          className="w-full px-3 py-1.5 rounded-lg bg-beme-500 text-black text-sm hover:bg-beme-400 disabled:opacity-40 disabled:cursor-not-allowed transition-colors font-medium"
        >
          {busy ? 'Opening print dialog…' : 'Save as PDF →'}
        </button>
      )}

      {expanded && (
        <>
          <p className="text-xs text-ink-400 mb-2">
            Tick what you want in the document, then click <em>Open print preview</em>.
            Your estimate opens in a new tab — hit the orange <em>Print / Save as PDF</em>
            button at the top of that tab (or Cmd&nbsp;+&nbsp;P) and pick{' '}
            <em>Save as PDF</em> in the browser's print dialog.
          </p>

          <div className="grid grid-cols-1 gap-1.5 text-sm mb-3">
            <Toggle
              label="Assumptions page"
              checked={inclusions.assumptions}
              onChange={(v) => patch({ assumptions: v })}
            />
            <Toggle
              label="Wall specifications"
              checked={inclusions.wallSpecs}
              onChange={(v) => patch({ wallSpecs: v })}
            />
            <Toggle
              label="Block schedule"
              checked={inclusions.blockSchedule}
              onChange={(v) => patch({ blockSchedule: v })}
            />
            <Toggle
              label="Breakdown by wall type"
              checked={inclusions.wallTypeBreakdown}
              onChange={(v) => patch({ wallTypeBreakdown: v })}
              disabled={makeups.length === 0}
              disabledHint="Define at least one wall type first"
            />
            <Toggle
              label="Disclaimer page"
              checked={inclusions.disclaimer}
              onChange={(v) => patch({ disclaimer: v })}
            />
          </div>

          {/* Per-page picker — only shown when the project has walls on more
              than one PDF page. Lets the user drop stale pages (e.g. an
              earlier estimate attempt whose walls weren't deleted) from
              this export without touching the underlying project data. */}
          {pagesInfo && pagesInfo.length > 1 && (
            <div className="mb-3 p-2 border border-ink-600 rounded-lg bg-ink-700/40">
              <div className="text-xs font-semibold text-ink-200 mb-1">
                Include Wall Layout pages
              </div>
              <p className="text-[11px] text-ink-400 mb-2">
                Untick a page to drop its walls from the export entirely —
                schedule, breakdown, and layout all use only the ticked pages.
              </p>
              <div className="flex flex-col gap-1">
                {pagesInfo.map((p) => {
                  const checked = !excludedPages.has(p.pageNumber)
                  const label = p.label?.trim() || `Page ${p.pageNumber}`
                  return (
                    <label
                      key={p.pageNumber}
                      className="flex items-center gap-2 text-xs cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => togglePage(p.pageNumber)}
                      />
                      <span className={checked ? 'text-ink-100' : 'text-ink-500'}>
                        {label}
                      </span>
                      <span className="text-ink-500">
                        · {p.walls.length} wall{p.walls.length === 1 ? '' : 's'}
                      </span>
                    </label>
                  )
                })}
              </div>
            </div>
          )}

          <button
            onClick={handleExport}
            disabled={!canExport}
            className="w-full px-3 py-1.5 rounded-lg bg-beme-500 text-black text-sm hover:bg-beme-400 disabled:opacity-40 disabled:cursor-not-allowed transition-colors font-medium"
          >
            {busy ? 'Opening print dialog…' : 'Save as PDF →'}
          </button>

          {filteredWalls.length === 0 && walls.length > 0 && (
            <p className="text-xs text-amber-300 mt-2">
              No walls in the selected pages — tick at least one page above to enable export.
            </p>
          )}
          {walls.length === 0 && (
            <p className="text-xs text-ink-400 mt-2">
              Draw at least one wall before exporting.
            </p>
          )}
          {error && (
            <p className="text-xs text-rose-300 mt-2">
              Couldn't build the PDF — {error}
            </p>
          )}
        </>
      )}
    </div>
  )
}

function Toggle({
  label,
  checked,
  onChange,
  disabled,
  disabledHint,
}: {
  label: string
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
  disabledHint?: string
}) {
  return (
    <label
      className={`flex items-center gap-2 cursor-pointer ${
        disabled ? 'opacity-50 cursor-not-allowed' : ''
      }`}
      title={disabled ? disabledHint : undefined}
    >
      <input
        type="checkbox"
        checked={checked && !disabled}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>{label}</span>
    </label>
  )
}
