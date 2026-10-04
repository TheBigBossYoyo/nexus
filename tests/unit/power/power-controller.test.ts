import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { MAX_SHUTDOWN_DELAY_SECONDS } from '@shared/overnight'
import { buildShutdownArgs, FakePowerController, isEffectivelyForced, SHUTDOWN_MESSAGES, WindowsPowerController, type SpawnLike } from '@main/modules/power'

interface Spawned {
  executable: string
  args: readonly string[]
  options: unknown
}

/** A spawn stand-in that records the command and exits with the given code. Nothing is executed. */
function recordingSpawn(exitCode: number | 'throw' | 'error' = 0, output = ''): { spawn: SpawnLike; calls: Spawned[] } {
  const calls: Spawned[] = []
  const spawn: SpawnLike = (executable, args, options) => {
    calls.push({ executable, args, options })
    if (exitCode === 'throw') throw new Error('spawn EPERM')
    const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void }
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = () => undefined
    setImmediate(() => {
      if (exitCode === 'error') {
        child.emit('error', new Error('ENOENT'))
        return
      }
      if (output) child.stderr.emit('data', Buffer.from(output))
      child.emit('close', exitCode)
    })
    return child as unknown as ReturnType<SpawnLike>
  }
  return { spawn, calls }
}

const controller = (spawn: SpawnLike, systemRoot = 'C:\\Windows'): WindowsPowerController => new WindowsPowerController({ spawn, systemRoot, platform: 'win32' })

describe('shutdown argument construction', () => {
  it('builds /s /t <delay> /c <fixed message> and adds /f only for a forced close', () => {
    expect(buildShutdownArgs({ delaySeconds: 32_400, force: false, purpose: 'failsafe' })).toEqual(['/s', '/t', '32400', '/c', SHUTDOWN_MESSAGES.failsafe])
    expect(buildShutdownArgs({ delaySeconds: 60, force: true, purpose: 'final' })).toEqual(['/s', '/f', '/t', '60', '/c', SHUTDOWN_MESSAGES.final])
    expect(buildShutdownArgs({ delaySeconds: 0, force: false, purpose: 'final' })).not.toContain('/f')
  })

  it('never produces a restart, logoff or remote-machine switch', () => {
    for (const purpose of ['failsafe', 'final', 'smoke'] as const) {
      for (const force of [true, false]) {
        const args = buildShutdownArgs({ delaySeconds: 600, force, purpose })
        expect(args.filter((a) => a.startsWith('/')).sort()).toEqual(force ? ['/c', '/f', '/s', '/t'] : ['/c', '/s', '/t'])
      }
    }
  })

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, MAX_SHUTDOWN_DELAY_SECONDS + 1, '60' as unknown as number])('rejects the delay %s', (delaySeconds) => {
    expect(() => buildShutdownArgs({ delaySeconds, force: false, purpose: 'final' })).toThrow(/Invalid shutdown delay/)
  })

  it('rejects a purpose that is not one of the fixed messages', () => {
    expect(() => buildShutdownArgs({ delaySeconds: 60, force: false, purpose: 'x; calc.exe' as never })).toThrow()
  })

  it('messages are short, fixed and contain no shell metacharacters', () => {
    for (const message of Object.values(SHUTDOWN_MESSAGES)) {
      expect(message.length).toBeLessThanOrEqual(512)
      expect(message).not.toMatch(/["&|<>^%\r\n]/)
    }
  })

  it('Windows forces every timed shutdown, with or without /f', () => {
    expect(isEffectivelyForced({ delaySeconds: 60, force: false })).toBe(true)
    expect(isEffectivelyForced({ delaySeconds: 0, force: false })).toBe(false)
    expect(isEffectivelyForced({ delaySeconds: 0, force: true })).toBe(true)
  })
})

describe('WindowsPowerController', () => {
  it('spawns System32\\shutdown.exe directly with an argument array, hidden and without a shell', async () => {
    const { spawn, calls } = recordingSpawn(0)
    const power = controller(spawn)
    const result = await power.scheduleShutdown({ delaySeconds: 600, force: false, purpose: 'smoke' })
    expect(result).toMatchObject({ ok: true, exitCode: 0, executable: 'C:\\Windows\\System32\\shutdown.exe' })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.executable).toBe('C:\\Windows\\System32\\shutdown.exe')
    expect(calls[0]?.args).toEqual(['/s', '/t', '600', '/c', SHUTDOWN_MESSAGES.smoke])
    expect(calls[0]?.options).toEqual({ windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
    expect(power.getState().pending).toMatchObject({ purpose: 'smoke', forced: true })
  })

  it('cancel uses /a and clears the pending state, also when Windows says nothing was scheduled', async () => {
    const ok = recordingSpawn(0)
    const power = controller(ok.spawn)
    await power.scheduleShutdown({ delaySeconds: 600, force: false, purpose: 'smoke' })
    const cancelled = await power.cancelShutdown()
    expect(ok.calls[1]?.args).toEqual(['/a'])
    expect(cancelled.ok).toBe(true)
    expect(power.getState().pending).toBeNull()

    const none = recordingSpawn(1116, 'Unable to abort the system shutdown because no shutdown was in progress.(1116)')
    const result = await controller(none.spawn).cancelShutdown()
    expect(result).toMatchObject({ ok: false, exitCode: 1116 })
    expect(result.output).toContain('1116')
  })

  it('reports a refusal with the exit code and keeps no pending state', async () => {
    const { spawn } = recordingSpawn(1190, 'A system shutdown has already been scheduled.(1190)')
    const power = controller(spawn)
    const result = await power.scheduleShutdown({ delaySeconds: 600, force: false, purpose: 'failsafe' })
    expect(result).toMatchObject({ ok: false, exitCode: 1190 })
    expect(power.getState().pending).toBeNull()
  })

  it('a spawn failure is a failed result, not an exception', async () => {
    expect(await controller(recordingSpawn('throw').spawn).cancelShutdown()).toMatchObject({ ok: false, exitCode: null })
    expect(await controller(recordingSpawn('error').spawn).cancelShutdown()).toMatchObject({ ok: false, exitCode: null })
  })

  it('hibernate is shutdown.exe /h and sleep is a fixed PowerShell call', async () => {
    const { spawn, calls } = recordingSpawn(0)
    const power = controller(spawn)
    await power.hibernate()
    await power.sleep()
    expect(calls[0]).toMatchObject({ executable: 'C:\\Windows\\System32\\shutdown.exe', args: ['/h'] })
    expect(calls[1]?.executable).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    expect(calls[1]?.args.at(-1)).toContain("SetSuspendState('Suspend', $false, $false)")
    expect(calls[1]?.args).toContain('-NonInteractive')
  })

  it.each(['shutdown', '.\\evil', '\\\\server\\share', '', 'relative\\Windows'])('ignores an unsafe SystemRoot (%s) and falls back to C:\\Windows', (systemRoot) => {
    expect(controller(recordingSpawn().spawn, systemRoot).shutdownExecutable).toBe('C:\\Windows\\System32\\shutdown.exe')
  })

  it('refuses to exist on other platforms', () => {
    expect(() => new WindowsPowerController({ platform: 'linux' })).toThrow(/only runs on Windows/)
  })

  it('exposes no method that takes an executable, an argument list or free text', () => {
    const methods = Object.getOwnPropertyNames(WindowsPowerController.prototype).filter((n) => n !== 'constructor')
    expect(methods.sort()).toEqual(['cancelShutdown', 'execute', 'getState', 'hibernate', 'powershellExecutable', 'scheduleShutdown', 'shutdownExecutable', 'sleep'])
    // `execute` is private in TypeScript and only ever called with the constants above.
  })
})

describe('FakePowerController', () => {
  it('models the single Windows shutdown timer', async () => {
    const power = new FakePowerController()
    expect((await power.cancelShutdown()).exitCode).toBe(1116)
    expect((await power.scheduleShutdown({ delaySeconds: 60, force: false, purpose: 'failsafe' })).ok).toBe(true)
    expect((await power.scheduleShutdown({ delaySeconds: 60, force: false, purpose: 'final' })).exitCode).toBe(1190)
    expect((await power.cancelShutdown()).ok).toBe(true)
    expect(power.getState().pending).toBeNull()
    expect(power.calls.map((c) => c.ok)).toEqual([false, true, false, true])
  })
})
