import { describe, expect, it } from 'vitest'
import { WindowsPowerController } from '@main/modules/power'

/**
 * Manual smoke of the REAL WindowsPowerController (`pnpm smoke:power`). It schedules a shutdown ten
 * minutes away, checks that Windows accepted it, and aborts it at once. The abort runs in `finally`, and
 * a second abort proves no timer is left behind. No automated suite includes this file.
 */
describe('WindowsPowerController against Windows', () => {
  it('schedules a distant shutdown, then aborts it and leaves nothing armed', async () => {
    const power = new WindowsPowerController()
    const scheduled = await power.scheduleShutdown({ delaySeconds: 600, force: false, purpose: 'smoke' })
    console.log('schedule:', JSON.stringify(scheduled))
    let cancelled = null
    try {
      // 1190 would mean a shutdown was already scheduled by something else: not ours to abort.
      expect(scheduled.exitCode, scheduled.output).toBe(0)
      expect(scheduled.args.slice(0, 3)).toEqual(['/s', '/t', '600'])
      expect(power.getState().pending).toMatchObject({ purpose: 'smoke' })
    } finally {
      if (scheduled.ok) {
        cancelled = await power.cancelShutdown()
        console.log('abort:', JSON.stringify(cancelled))
      }
    }
    expect(cancelled?.ok).toBe(true)
    expect(cancelled?.args).toEqual(['/a'])
    expect(power.getState().pending).toBeNull()
    // Nothing is pending any more: Windows answers 1116 to another abort.
    const again = await power.cancelShutdown()
    console.log('second abort:', JSON.stringify(again))
    expect(again.exitCode).toBe(1116)
  })
})
