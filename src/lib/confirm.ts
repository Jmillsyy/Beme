/**
 * confirm.ts — promise-based replacement for `window.confirm`.
 *
 * `window.confirm` is unstyled, blocks the JS event loop, and looks
 * straight out of 1995. This module is the styled equivalent:
 *
 *   const ok = await confirm({
 *     title: 'Delete project?',
 *     message: 'This can\'t be undone.',
 *     confirmLabel: 'Delete',
 *     variant: 'destructive',
 *   })
 *   if (ok) await deleteProject(id)
 *
 * Architecture mirrors the toast system: a singleton store (one open
 * dialog at a time), a small in-memory state, a `useConfirm()` hook
 * for the host renderer to subscribe to, and a callable `confirm()`
 * API that any code — React or otherwise — can `await`.
 *
 * Resolves boolean: true = confirmed, false = cancelled (Esc / backdrop
 * click / Cancel button). The promise NEVER rejects; cancellation is
 * just `false`, which makes call sites read like the legacy API.
 */
import { useEffect, useState } from 'react'

export type ConfirmVariant = 'default' | 'destructive'

export interface ConfirmOptions {
  /** Bold headline at the top of the dialog. */
  title: string
  /** Optional body copy under the title. */
  message?: string
  /** Label for the confirm button. Default: "Confirm". */
  confirmLabel?: string
  /** Label for the cancel button. Default: "Cancel". */
  cancelLabel?: string
  /**
   * Visual tone for the confirm button. 'destructive' = rose (Delete,
   * Discard); 'default' = beme orange (Save, OK). The host applies
   * appropriate styling per variant.
   */
  variant?: ConfirmVariant
  /**
   * Optional middle button — used for three-way choices like "Save / Discard
   * / Stay". When set, the dialog renders Cancel + Secondary + Confirm
   * left-to-right. When the user clicks it, the promise resolves to the
   * string 'secondary' instead of true / false. Callers that don't pass
   * this option keep the boolean-result behaviour they had before.
   */
  secondaryLabel?: string
}

/** Result of a confirm dialog. true = primary confirm, false = cancel,
 *  'secondary' = the middle button (only fires if secondaryLabel was set). */
export type ConfirmResult = boolean | 'secondary'

/** Internal store entry — the open dialog plus the promise resolver. */
export interface ConfirmState extends ConfirmOptions {
  resolve: (result: ConfirmResult) => void
}

type Listener = (state: ConfirmState | null) => void
const listeners = new Set<Listener>()
let current: ConfirmState | null = null

function emit() {
  for (const l of listeners) l(current)
}

/**
 * Open the confirm dialog. Returns a promise that resolves with true
 * (user confirmed) or false (user cancelled / dismissed). If a dialog
 * is already open the new call replaces it — the previous promise
 * resolves false so callers don't hang.
 */
export function confirm(opts: ConfirmOptions): Promise<ConfirmResult> {
  return new Promise<ConfirmResult>((resolve) => {
    if (current) {
      // Reject the previous dialog cleanly so its caller can move on.
      current.resolve(false)
    }
    current = { ...opts, resolve }
    emit()
  })
}

/** Internal: called by the host when the user clicks Confirm / Cancel /
 *  Secondary or hits a keyboard shortcut. Resolves and clears the active
 *  state. */
export function _resolveCurrent(result: ConfirmResult) {
  if (!current) return
  const r = current.resolve
  current = null
  emit()
  r(result)
}

/**
 * Hook for the ConfirmHost renderer. Subscribes to the singleton store
 * and returns the current dialog state (or null). React-side reactivity
 * lives entirely here — the store is plain JS.
 */
export function useConfirm(): ConfirmState | null {
  const [state, setState] = useState<ConfirmState | null>(current)
  useEffect(() => {
    listeners.add(setState)
    return () => {
      listeners.delete(setState)
    }
  }, [])
  return state
}
