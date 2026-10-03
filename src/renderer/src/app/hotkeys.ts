import { useEffect } from 'react'
import { useUiStore, type View } from '../store/ui'

export const NUMBERED_VIEWS: readonly View[] = ['projects', 'run', 'agents', 'memory', 'settings', 'performance', 'intelligence']

/** Ctrl+K palette, Ctrl+1..7 views, Esc closes the palette and drawers. */
export function useHotkeys(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const ui = useUiStore.getState()
      if (e.key === 'Escape') {
        if (ui.paletteOpen) ui.setPaletteOpen(false)
        if (ui.drawer) ui.setDrawer(null)
        return
      }
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return
      if (e.key.toLowerCase() === 'k') {
        e.preventDefault()
        ui.setPaletteOpen(!ui.paletteOpen)
        return
      }
      const n = Number(e.key)
      const view = Number.isInteger(n) ? NUMBERED_VIEWS[n - 1] : undefined
      if (view) {
        e.preventDefault()
        ui.setView(view)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}
