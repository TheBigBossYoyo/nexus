import { useEffect } from 'react'
import type { Settings } from '@shared/settings'
import { useSettings } from '../lib/queries'

export type Appearance = Settings['appearance']

/** Applies theme, density and font size to the document root. Everything in the UI is rem/CSS-variable based. */
export function applyAppearance(a: Appearance): void {
  const root = document.documentElement
  root.dataset.theme = a.theme
  root.dataset.density = a.density
  root.style.setProperty('--font-size', `${a.fontSize}px`)
}

export function useApplySavedAppearance(): void {
  const appearance = useSettings().data?.appearance
  useEffect(() => {
    if (appearance) applyAppearance(appearance)
  }, [appearance])
}
