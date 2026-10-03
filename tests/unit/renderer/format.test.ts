import { describe, expect, it } from 'vitest'
import {
  DASH,
  baseName,
  formatBytes,
  formatCost,
  formatDuration,
  formatRelative,
  formatSpan,
  formatTokens,
  shortId,
} from '../../../src/renderer/src/lib/format'

describe('format', () => {
  it('renders null, undefined and NaN as a dash and never invents a value', () => {
    for (const v of [null, undefined, Number.NaN]) {
      expect(formatDuration(v)).toBe(DASH)
      expect(formatTokens(v)).toBe(DASH)
      expect(formatCost(v)).toBe(DASH)
      expect(formatBytes(v)).toBe(DASH)
    }
    expect(formatRelative(null)).toBe(DASH)
    expect(formatRelative('not a date')).toBe(DASH)
    expect(formatSpan(null, null)).toBe(DASH)
    expect(shortId(null)).toBe(DASH)
  })

  it('keeps a real zero distinct from missing', () => {
    expect(formatTokens(0)).toBe('0')
    expect(formatCost(0)).toBe('$0.00')
    expect(formatDuration(0)).toBe('0ms')
  })

  it('formats durations across magnitudes', () => {
    expect(formatDuration(850)).toBe('850ms')
    expect(formatDuration(12_400)).toBe('12s')
    expect(formatDuration(185_000)).toBe('3m 05s')
    expect(formatDuration(3_720_000)).toBe('1h 02m')
    expect(formatDuration(90_000_000)).toBe('1d 1h')
  })

  it('formats tokens and cost', () => {
    expect(formatTokens(999)).toBe('999')
    expect(formatTokens(1500)).toBe('1.5k')
    expect(formatTokens(120_000)).toBe('120k')
    expect(formatTokens(2_300_000)).toBe('2.3M')
    expect(formatCost(1.234)).toBe('$1.23')
    expect(formatCost(0.0034)).toBe('$0.0034')
  })

  it('formats bytes', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2.0 KB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB')
  })

  it('formats relative time in both directions', () => {
    const now = Date.parse('2026-10-03T12:00:00Z')
    expect(formatRelative('2026-10-03T11:59:58Z', now)).toBe('just now')
    expect(formatRelative('2026-10-03T11:59:15Z', now)).toBe('45s ago')
    expect(formatRelative('2026-10-03T11:55:00Z', now)).toBe('5m ago')
    expect(formatRelative('2026-10-03T09:00:00Z', now)).toBe('3h ago')
    expect(formatRelative('2026-10-01T12:00:00Z', now)).toBe('2d ago')
    expect(formatRelative('2026-10-03T12:10:00Z', now)).toBe('in 10m')
  })

  it('runs an unfinished span until now', () => {
    const now = Date.parse('2026-10-03T12:00:00Z')
    expect(formatSpan('2026-10-03T11:58:00Z', null, now)).toBe('2m 00s')
    expect(formatSpan('2026-10-03T11:58:00Z', '2026-10-03T11:59:00Z', now)).toBe('1m 00s')
  })

  it('shortens ids and paths', () => {
    expect(shortId('0a1b2c3d-1111-2222-3333-444455556666')).toBe('0a1b2c3d')
    expect(baseName('C:\\Users\\me\\repo\\')).toBe('repo')
    expect(baseName('/home/me/repo')).toBe('repo')
  })
})
