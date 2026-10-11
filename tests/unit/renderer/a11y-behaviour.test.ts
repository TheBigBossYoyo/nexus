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

describe('why Automatic chose a depth is said in words', () => {
  it('names the reason the depth policy recorded, and says nothing when the user chose the depth', async () => {
    const { depthReason } = await import('../../../src/renderer/src/lib/intelligenceLabels')
    expect(depthReason(['LOCALIZED_WELL_SPECIFIED_TASK', 'PROFILE:bugfix|medium|low:scope=single:ambiguity=low', 'DEPTH_POLICY:depth-2'])).toBe('Automatic chose this because the request names the files it is about and says exactly what is wanted.')
    expect(depthReason(['ENGINEERING_REQUIREMENT_DEVELOPMENT', 'RECORDED_EVIDENCE_LOW_PASS_RATE'])).toContain('often failed in this project')
    expect(depthReason(['USER_SELECTED_MODE'])).toBeNull()
  })
})
