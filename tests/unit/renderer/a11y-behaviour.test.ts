import { describe, expect, it } from 'vitest'
import { shouldFocusMainOnNavigation } from '../../../src/renderer/src/app/navFocus'
import { toastLifetimeMs } from '../../../src/renderer/src/store/toasts'

describe('focus on navigation (WCAG 2.4.3)', () => {
  it('moves the focus when the view changed and no dialog is open', () => {
    expect(shouldFocusMainOnNavigation('home', 'director', false)).toBe(true)
  })
  it('does not steal the focus on the first render, on a re-render of the same view or while a dialog is open', () => {
    expect(shouldFocusMainOnNavigation(null, 'home', false)).toBe(false)
    expect(shouldFocusMainOnNavigation('home', 'home', false)).toBe(false)
    expect(shouldFocusMainOnNavigation('home', 'director', true)).toBe(false)
  })
})

describe('toast lifetime (WCAG 2.2.1)', () => {
  it('keeps an error until it is dismissed and lets the other toasts expire', () => {
    expect(toastLifetimeMs('error')).toBeNull()
    expect(toastLifetimeMs('info')).toBe(4000)
    expect(toastLifetimeMs('success')).toBe(4000)
    expect(toastLifetimeMs('notice')).toBe(8000)
  })
})
