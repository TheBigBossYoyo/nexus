import { describe, expect, it } from 'vitest'
import { effectiveProfile } from '@main/modules/isolation/session-containment'

const broker = (isolated: boolean) => ({ usable: (profile: string) => ({ usable: profile === 'ISOLATED' ? isolated : true, detail: '' }) }) as never

describe('the profile "the strongest available" stands for', () => {
  it('is the isolated one where it holds, and Restricted where the isolated profile was never set up', () => {
    expect(effectiveProfile('STRONGEST', broker(true), true)).toBe('ISOLATED')
    expect(effectiveProfile('STRONGEST', broker(false), false)).toBe('RESTRICTED')
  })

  it('does not quietly become Restricted where the isolated profile was set up and does not hold', () => {
    // The profile stays the isolated one: not usable, so nothing runs, and the reason is shown.
    expect(effectiveProfile('STRONGEST', broker(false), true)).toBe('ISOLATED')
  })

  it('is what was asked for when a profile was named', () => {
    expect(effectiveProfile('RESTRICTED', broker(true), true)).toBe('RESTRICTED')
    expect(effectiveProfile('ISOLATED', broker(false), false)).toBe('ISOLATED')
    expect(effectiveProfile('STANDARD', broker(true), true)).toBe('STANDARD')
  })
})
