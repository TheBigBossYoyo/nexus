import { beforeEach, describe, expect, it } from 'vitest'
import { useLiveStore } from '../../../src/renderer/src/store/live'

beforeEach(() => useLiveStore.setState({ text: {} }))

describe('live store', () => {
  it('accumulates deltas per agent and clears them', () => {
    const s = useLiveStore.getState()
    s.append('a', 'hel')
    s.append('a', 'lo')
    s.append('b', 'x')
    expect(useLiveStore.getState().text).toEqual({ a: 'hello', b: 'x' })
    s.clear('a')
    expect(useLiveStore.getState().text).toEqual({ b: 'x' })
  })

  it('caps the buffered text, keeping the newest characters', () => {
    useLiveStore.getState().append('a', 'x'.repeat(50_000))
    useLiveStore.getState().append('a', 'END')
    const t = useLiveStore.getState().text['a'] ?? ''
    expect(t.length).toBe(40_000)
    expect(t.endsWith('END')).toBe(true)
  })
})
