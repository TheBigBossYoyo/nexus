import { useEffect } from 'react'
import { useUiStore } from '../store/ui'
import { hotkeyAction } from './hotkeysModel'

export function useHotkeys(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const action = hotkeyAction(e)
      if (!action) return
      const ui = useUiStore.getState()
      switch (action.type) {
        case 'escape':
          if (ui.paletteOpen) ui.setPaletteOpen(false)
          if (ui.drawer) ui.setDrawer(null)
          return
        case 'palette':
          e.preventDefault()
          ui.setPaletteOpen(!ui.paletteOpen)
          return
        case 'nav':
          e.preventDefault()
          ui.toggleNav()
          return
        case 'view':
          e.preventDefault()
          ui.setView(action.view)
          return
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}
