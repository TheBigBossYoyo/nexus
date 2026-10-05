import { useRead } from './queries'

/** Hooks for the 0.7 Control Center. Writes use `useWrite` with the channel directly and invalidate this root. */

export const qkControl = {
  root: () => ['control'] as const,
  overview: () => ['control', 'overview'] as const,
}

export const useControlOverview = () => useRead(qkControl.overview(), 'control.overview', {})
