/**
 * Whether the keyboard focus should move to the main region: only when the view really changed (not on the first
 * render, not on a re-render of the same view) and no dialog is open (a dialog owns the focus).
 */
export function shouldFocusMainOnNavigation(previous: string | null, current: string, dialogOpen: boolean): boolean {
  return previous !== null && previous !== current && !dialogOpen
}

export function isDialogOpen(root: Document = document): boolean {
  return root.querySelector('[role="dialog"], [role="alertdialog"], dialog[open]') !== null
}
