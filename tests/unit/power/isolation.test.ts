import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ipcInputs } from '@shared/ipc'
import { DEFAULT_OVERNIGHT_POLICY, OVERNIGHT_CONFIRMATION_TEXT } from '@shared/overnight'
import { classifyCommand } from '@main/modules/policies'
import { createAuthorizer } from '@main/modules/policies'
import { AGENT_ROLES } from '@shared/domain'

const ROOT = resolve(import.meta.dirname, '..', '..', '..')
const SRC = join(ROOT, 'src')

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sources(path)
    return /\.(ts|tsx|cjs|mjs)$/.test(entry.name) ? [path] : []
  })
}

const files = sources(SRC).map((path) => ({ path: relative(ROOT, path).replace(/\\/g, '/'), text: readFileSync(path, 'utf8') }))
const importsOf = (text: string): string[] => [...text.matchAll(/(?:from|import\(|require\()\s*['"]([^'"]+)['"]/g)].map((m) => m[1] ?? '')

/**
 * The power boundary, checked against the source tree: who can reach the power controller, and that no
 * other code path can run a power command.
 */
describe('power control isolation', () => {
  it('only the overnight supervisor and the runtime core import the power module', () => {
    const importers = files
      .filter((f) => !f.path.startsWith('src/main/modules/power/'))
      // Any path whose last or middle segment is the power module, however it is reached (`../power`, `../../power/index`, `./power/windows-power-controller`).
      .filter((f) => importsOf(f.text).some((i) => /(^|\/)power(\/|$)/.test(i)))
      .map((f) => f.path)
      .sort()
    // 0.7: the runtime core is where the controller is constructed. The window's process, the workers and the
    // local server never see it.
    expect(importers).toEqual(['src/main/modules/overnight/supervisor.ts', 'src/main/runtime/core.ts'])
  })

  it('the window process, the worker process and the local protocol cannot reach the power module or the supervisor', () => {
    const outside = files.filter((f) => ['src/main/index.ts', 'src/main/desktop.ts', 'src/main/worker.ts'].includes(f.path) || f.path.startsWith('src/main/modules/workers/') || f.path.startsWith('src/main/modules/runtime/'))
    expect(outside.length).toBeGreaterThan(6)
    for (const f of outside) {
      expect(importsOf(f.text).filter((i) => /modules\/power|\/power$|overnight\/supervisor|modules\/overnight$/.test(i)), f.path).toEqual([])
      expect(f.text, f.path).not.toMatch(/PowerController|scheduleShutdown|cancelShutdown|OvernightSupervisor/)
    }
    // The protocol's frames carry a channel of the closed contract or one of three fixed questions; none is a power operation.
    const protocol = files.find((f) => f.path === 'src/shared/runtime-protocol.ts')?.text ?? ''
    expect([...protocol.matchAll(/kind: z\.literal\('([^']+)'\)/g)].map((m) => m[1])).toEqual(['confirm', 'pickDirectory', 'openDataDir'])
  })

  it('the runtime core only constructs the controller and passes it to the supervisor', () => {
    const main = files.find((f) => f.path === 'src/main/runtime/core.ts')?.text ?? ''
    // The variable holding the controller is referenced exactly where it is created and where it is handed over.
    const uses = main.split('\n').filter((line) => /\bpower\b/.test(line) && !/^\s*(\/\/|\*)/.test(line) && !/import /.test(line) && !/logger\(/.test(line))
    expect(uses.map((l) => l.trim())).toEqual([
      'let power: PowerController | null = null',
      "power = useFakePower ? new FakePowerController({ logFile: join(dataDir, 'fake-power.log') }) : new WindowsPowerController()",
      'const overnight = power',
      'power,',
    ])
    // The fake controller can only be chosen in an unpackaged build.
    expect(main).toMatch(/const useFakePower = !host\.isPackaged && /)
  })

  it('no source file outside the power module names a power executable or power API', () => {
    const offenders = files
      .filter((f) => !f.path.startsWith('src/main/modules/power/'))
      // The command classifier names these commands in order to forbid them.
      .filter((f) => !f.path.startsWith('src/main/modules/policies/'))
      .filter((f) => /shutdown\.exe|SetSuspendState|powrprof|Stop-Computer|Restart-Computer|ExitWindowsEx|InitiateSystemShutdown|psshutdown/i.test(f.text))
      .map((f) => f.path)
    expect(offenders).toEqual([])
  })

  it('child processes are spawned only by the process runner, the power controller and the four places that start a NEXUS process', () => {
    const spawners = files.filter((f) => importsOf(f.text).some((i) => i === 'node:child_process' || i === 'child_process')).map((f) => f.path).sort()
    expect(spawners).toEqual([
      // 0.7: the window starts the runtime; the runtime's host starts the window; the worker manager forks workers;
      // the endpoint file's access list is narrowed with icacls.
      'src/main/desktop.ts',
      'src/main/modules/power/windows-power-controller.ts',
      'src/main/modules/process/run-process.ts',
      'src/main/modules/runtime/endpoint.ts',
      'src/main/modules/workers/manager.ts',
      'src/main/runtime-electron.ts',
    ])
    const text = (path: string): string => files.find((f) => f.path === path)?.text ?? ''
    const calls = (path: string, fn: string): string[] => [...text(path).matchAll(new RegExp(`\\b${fn}\\(([^,)]+)`, 'g'))].map((m) => (m[1] ?? '').trim())
    // Each of them starts one fixed thing: this executable, the worker entry, or icacls. None takes a command from a caller.
    expect(calls('src/main/desktop.ts', 'spawn')).toEqual(['process.execPath'])
    expect(calls('src/main/runtime-electron.ts', 'spawn')).toEqual(['process.execPath'])
    expect(calls('src/main/modules/workers/manager.ts', 'fork')).toEqual(['options.entry'])
    expect(calls('src/main/modules/runtime/endpoint.ts', 'execFile')).toEqual(["'icacls'"])
    for (const path of ['src/main/desktop.ts', 'src/main/runtime-electron.ts', 'src/main/modules/workers/manager.ts', 'src/main/modules/runtime/endpoint.ts']) {
      expect(text(path), path).not.toMatch(/\bexec\(|execSync|spawnSync|shell: true/)
    }
  })

  it('the renderer and the preload bridge cannot reach the power module or Node', () => {
    const exposed = files.filter((f) => f.path.startsWith('src/renderer/') || f.path.startsWith('src/preload/'))
    for (const f of exposed) {
      const imports = importsOf(f.text)
      expect(imports.filter((i) => i.startsWith('@main') || i.includes('modules/power') || i.startsWith('node:')), f.path).toEqual([])
    }
    const preload = files.find((f) => f.path === 'src/preload/index.ts')?.text ?? ''
    expect(preload.match(/exposeInMainWorld/g)).toHaveLength(1)
  })

  it('no agent tool, MCP tool or IPC channel is a power operation', () => {
    const runtime = files.filter((f) => f.path.startsWith('src/main/modules/agent-runtime/') || f.path.startsWith('src/main/modules/orchestrator/'))
    for (const f of runtime) {
      expect(importsOf(f.text).filter((i) => i.includes('power') || i.includes('overnight')), f.path).toEqual([])
      expect(f.text, f.path).not.toMatch(/PowerController|scheduleShutdown|cancelShutdown|OvernightSupervisor/)
    }
    const channels = Object.keys(ipcInputs)
    expect(channels.filter((c) => /power|shutdown|sleep|hibernate/i.test(c))).toEqual(['overnight.cancelPower'])
    // Stopping the NEXUS runtime is its own channel and has nothing to do with the computer's power state.
    expect(channels).toContain('runtime.stop')
  })
})

describe('the renderer cannot submit arbitrary power arguments', () => {
  const start = {
    projectId: 'p1',
    preset: 'balanced',
    prompt: 'Do the work',
    policy: DEFAULT_OVERNIGHT_POLICY,
    confirmed: true,
    confirmation: OVERNIGHT_CONFIRMATION_TEXT,
  }

  it('accepts the documented shape', () => {
    expect(ipcInputs['overnight.start'].safeParse(start).success).toBe(true)
  })

  it.each([
    ['an unknown top-level field', { ...start, command: 'shutdown.exe /r /t 0' }],
    ['arguments', { ...start, args: ['/r'] }],
    ['an executable in the policy', { ...start, policy: { ...DEFAULT_OVERNIGHT_POLICY, executable: 'cmd.exe' } }],
    ['a message in the policy', { ...start, policy: { ...DEFAULT_OVERNIGHT_POLICY, message: 'x" & calc & "' } }],
    ['an end action outside the enum', { ...start, policy: { ...DEFAULT_OVERNIGHT_POLICY, endAction: 'RESTART' } }],
    ['an end action that is a command', { ...start, policy: { ...DEFAULT_OVERNIGHT_POLICY, endAction: 'SHUTDOWN /r' } }],
    ['a negative delay', { ...start, policy: { ...DEFAULT_OVERNIGHT_POLICY, finalDelaySeconds: -1 } }],
    ['a string delay', { ...start, policy: { ...DEFAULT_OVERNIGHT_POLICY, finalDelaySeconds: '60 /f' } }],
    ['a huge delay', { ...start, policy: { ...DEFAULT_OVERNIGHT_POLICY, finalDelaySeconds: 10_000_000 } }],
    ['a failsafe before the deadline', { ...start, policy: { ...DEFAULT_OVERNIGHT_POLICY, failsafeAfterMinutes: 60 } }],
    ['no confirmation', { ...start, confirmed: false }],
    ['a different confirmation sentence', { ...start, confirmation: 'ok' }],
    ['a missing confirmation', { projectId: 'p1', preset: 'balanced', prompt: 'x', policy: DEFAULT_OVERNIGHT_POLICY }],
    ['overnight disabled', { ...start, policy: { ...DEFAULT_OVERNIGHT_POLICY, enabled: false } }],
  ])('rejects %s', (_name, input) => {
    expect(ipcInputs['overnight.start'].safeParse(input).success).toBe(false)
  })

  it('changeEndAction and extend take only enums and bounded numbers', () => {
    const change = ipcInputs['overnight.changeEndAction']
    expect(change.safeParse({ runId: 'r', endAction: 'SLEEP' }).success).toBe(true)
    expect(change.safeParse({ runId: 'r', endAction: 'shutdown /r' }).success).toBe(false)
    expect(change.safeParse({ runId: 'r', endAction: 'SLEEP', args: ['/f'] }).success).toBe(false)
    expect(change.safeParse({ runId: 'r', finalDelaySeconds: 5 }).success).toBe(false)
    expect(change.safeParse({ runId: 'r', policy: DEFAULT_OVERNIGHT_POLICY }).success).toBe(false)
    expect(ipcInputs['overnight.extend'].safeParse({ runId: 'r', minutes: 60 }).success).toBe(true)
    expect(ipcInputs['overnight.extend'].safeParse({ runId: 'r', minutes: 100_000 }).success).toBe(false)
    expect(ipcInputs['overnight.cancelPower'].safeParse({ runId: 'r', action: 'SHUTDOWN' }).success).toBe(false)
  })
})

describe('an agent cannot power the machine off through its shell tool', () => {
  const commands: [string, 'bash' | 'powershell'][] = [
    ['shutdown /s /t 0', 'bash'],
    ['shutdown.exe /s /f /t 60', 'powershell'],
    ['C:\\Windows\\System32\\shutdown.exe /h', 'powershell'],
    ['cmd /c shutdown /s /t 0', 'bash'],
    ['Stop-Computer -Force', 'powershell'],
    ['Restart-Computer', 'powershell'],
    ['rundll32.exe powrprof.dll,SetSuspendState 0,1,0', 'powershell'],
    ['Start-Process shutdown -ArgumentList "/s","/t","0"', 'powershell'],
    ['shutdown /a', 'bash'],
  ]

  it.each(commands)('%s is forbidden by the classifier', (command, shell) => {
    expect(classifyCommand(command, shell).level).toBe('forbidden')
  })

  it.each(AGENT_ROLES.map((role) => [role] as const))('role %s is denied without an approval path', async (role) => {
    const authorize = createAuthorizer({ role, worktreeRoot: 'C:\\work\\tree', projectRoot: 'C:\\work\\project', safeCommandPrefixes: ['shutdown'], allowNetworkTools: true, allowedMcpServers: [] })
    for (const [command, shell] of commands) {
      const decision = await authorize({ toolName: shell === 'bash' ? 'Bash' : 'PowerShell', input: { command, dangerouslyDisableSandbox: true }, agentId: 'agent', toolUseId: 'tool' })
      expect(decision.behavior, `${role}: ${command}`).toBe('deny')
    }
  })
})
