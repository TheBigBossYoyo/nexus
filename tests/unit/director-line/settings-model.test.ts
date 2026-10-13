import { describe, expect, it } from 'vitest'
import { clock, isValidTimeZone, minuteToTime, moved, secondsLeft, timeToMinute } from '../../../src/renderer/src/views/settings/directorLineModel'

describe('director line settings model', () => {
  it('converts between minutes and clock text', () => {
    expect(minuteToTime(22 * 60 + 30)).toBe('22:30')
    expect(minuteToTime(7 * 60)).toBe('07:00')
    expect(timeToMinute('22:30')).toBe(1350)
    expect(timeToMinute('24:00')).toBeNull()
    expect(timeToMinute('7:00')).toBeNull()
  })

  it('knows a time zone from a typo', () => {
    expect(isValidTimeZone('Europe/Paris')).toBe(true)
    expect(isValidTimeZone('UTC')).toBe(true)
    expect(isValidTimeZone('Europe/Pariss')).toBe(false)
    expect(isValidTimeZone('')).toBe(false)
  })

  it('counts a pairing window down and never below zero', () => {
    const at = Date.parse('2026-10-13T12:10:00.000Z')
    expect(secondsLeft('2026-10-13T12:10:00.000Z', at - 125_000)).toBe(125)
    expect(clock(125)).toBe('2:05')
    expect(secondsLeft('2026-10-13T12:10:00.000Z', at + 5000)).toBe(0)
  })

  it('moves a channel earlier or later and stops at the ends', () => {
    expect(moved(['PHONE', 'MESSAGE', 'LOCAL_NOTIFICATION'], 1, -1)).toEqual(['MESSAGE', 'PHONE', 'LOCAL_NOTIFICATION'])
    expect(moved(['PHONE', 'MESSAGE', 'LOCAL_NOTIFICATION'], 2, 1)).toEqual(['PHONE', 'MESSAGE', 'LOCAL_NOTIFICATION'])
  })
})
