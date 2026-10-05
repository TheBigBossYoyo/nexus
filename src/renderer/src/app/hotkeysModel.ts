import { NUMBERED_VIEWS } from './nav'

export { NUMBERED_VIEWS }

/**
 * Pure routing of a key press to an action; unit-tested. Ctrl/Cmd+K palette, Ctrl+B navigation,
 * Ctrl+1..9 the first nine navigation items. Esc closes overlays.
 */
export type HotkeyAction =
  | { type: 'palette' }
  | { type: 'nav' }
  | { type: 'view'; view: (typeof NUMBERED_VIEWS)[number] }
  | { type: 'escape' }

export function hotkeyAction(e: {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
}): HotkeyAction | null {
  if (e.key === 'Escape') return { type: 'escape' }
  if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return null
  const k = e.key.toLowerCase()
  if (k === 'k') return { type: 'palette' }
  if (k === 'b') return { type: 'nav' }
  const n = Number(e.key)
  const view = Number.isInteger(n) && n >= 1 ? NUMBERED_VIEWS[n - 1] : undefined
  return view ? { type: 'view', view } : null
}
