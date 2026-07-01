/**
 * pendingEdits.ts - guards in-page tab switches that would unmount an
 * editor holding unsaved draft state.
 *
 * The router-level `useUnsavedChangesPrompt` only catches pathname
 * navigation (Link clicks, the back button, refresh). Switching tabs
 * INSIDE a page - e.g. the Material Library moving from its Defaults tab
 * to Blocks - is a hash / state change on the same pathname, so the
 * router blocker deliberately ignores it. That silently unmounts the
 * editor and drops its draft.
 *
 * An editor registers its `isDirty` + `save` here while mounted; the tab
 * switcher awaits `confirmLeavePendingEdits()` before changing tabs and
 * either saves, discards, or stays per the user's choice.
 *
 * Singleton store - only one in-page editor is ever on screen at a time
 * within a page, so a single active slot is enough.
 */
import { confirm } from './confirm'

export interface PendingEditor {
  /** Are there unsaved edits right now? Read live (via a ref) so the
   * registration can stay stable across renders. */
  isDirty: () => boolean
  /** Persist the edits. Awaited before the tab switch proceeds. */
  save: () => void | Promise<void>
}

let active: PendingEditor | null = null

/**
 * Register the currently-mounted editor. Returns an unregister function
 * for the effect cleanup. Last registration wins.
 */
export function registerPendingEditor(editor: PendingEditor): () => void {
  active = editor
  return () => {
    if (active === editor) active = null
  }
}

/** Whether a registered editor currently has unsaved edits. */
export function hasPendingEdits(): boolean {
  return active?.isDirty() ?? false
}

/**
 * If a registered editor has unsaved edits, prompt Save & leave /
 * Discard / Stay. Returns true when it's safe to proceed (the edits were
 * saved or discarded), false when the user chose to stay. A no-op that
 * returns true when nothing is dirty.
 */
export async function confirmLeavePendingEdits(
  message = 'You have unsaved changes. Save them before leaving, or discard?'
): Promise<boolean> {
  const editor = active
  if (!editor || !editor.isDirty()) return true
  const result = await confirm({
    title: 'Save changes before leaving?',
    message,
    confirmLabel: 'Save & leave',
    secondaryLabel: 'Discard',
    cancelLabel: 'Stay',
    variant: 'default',
  })
  if (result === true) {
    try {
      await editor.save()
    } catch {
      // Save failed (its own toast already surfaced) - keep the user put.
      return false
    }
    return true
  }
  if (result === 'secondary') return true // Discard - proceed unsaved.
  return false // Stay.
}
