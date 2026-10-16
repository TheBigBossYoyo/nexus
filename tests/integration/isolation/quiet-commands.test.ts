import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ExecutionBroker } from '@main/modules/isolation/execution-broker'
import { Launcher } from '@main/modules/isolation/launcher'
import { createShellContainment } from '@main/modules/isolation/session-containment'
// @ts-expect-error a build script without types
import { buildLauncher } from '../../../scripts/build-launcher.mjs'
// @ts-expect-error a build script without types
import { buildPresenceHelper } from '../../../scripts/build-presence.mjs'

/**
 * 0.9.1: the commands of a project that is not contained, started quietly (C8 to C10). They still run as the user,
 * with the agent shell's environment and their own output and exit code; only their desktop is another one, so
 * that a window they open is on no screen and takes no focus. Measured with the presence meter on the real
 * desktop of whoever runs the tests: no window of the command's appears there and the foreground does not move.
 * The probe window is a form that asks to be activated and kept on top, on the command's own desktop.
 */

const available = process.platform === 'win32'
const SCRATCH = resolve('test-results', 'quiet-commands')

describe.runIf(available)('quiet commands (PRESENT launcher profile)', () => {
  let broker: ExecutionBroker
  let meter: string
  const worktree = join(SCRATCH, 'worktree')

  beforeAll(() => {
    rmSync(SCRATCH, { recursive: true, force: true, maxRetries: 3 })
    mkdirSync(worktree, { recursive: true })
    const launcher = new Launcher({ executable: buildLauncher(join(SCRATCH, 'native')) as string, specDir: join(SCRATCH, 'specs') })
    meter = buildPresenceHelper(join(SCRATCH, 'native')) as string
    broker = new ExecutionBroker({ launcher, sandboxDir: join(SCRATCH, 'sandbox'), account: () => null, baseEnv: () => process.env, toolPath: (_p, path) => path, posixShell: () => null })
  }, 120_000)

  afterAll(() => rmSync(SCRATCH, { recursive: true, force: true, maxRetries: 3 }))

  async function run(shell: 'bash' | 'powershell', command: string, env: Record<string, string> = {}) {
    const containment = createShellContainment({ broker, profile: 'STANDARD', projectId: 'p', sessionKey: 'quiet-tests', worktree, cwd: worktree, quiet: true })
    expect(containment.quiet).toBe(true)
    const wrapped = await containment.wrap(shell, command, { gitOnly: false })
    if (!wrapped.ok) throw new Error(wrapped.reason)
    expect(wrapped.command).toMatch(/nexus-launch\.exe'? --spec /)
    // As the agent's own shell tool runs it: Git Bash or PowerShell, with the agent's environment.
    const r =
      shell === 'bash'
        ? spawnSync('bash', ['-c', wrapped.command], { encoding: 'utf8', windowsHide: true, timeout: 60_000, env: { ...process.env, ...env } })
        : spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', wrapped.command], { encoding: 'utf8', windowsHide: true, timeout: 60_000, env: { ...process.env, ...env } })
    return { exit: r.status, out: r.stdout.replace(/\r\n/g, '\n'), err: r.stderr }
  }

  it('runs the command as written: its output, its exit code, the agent shell environment, its working directory', async () => {
    const r = await run('bash', 'echo "v=$NX_QUIET_VAR"; pwd | sed "s|.*/||"; exit 7', { NX_QUIET_VAR: 'inherited' })
    expect(r.out).toBe('v=inherited\nworktree\n')
    expect(r.exit).toBe(7)
    const p = await run('powershell', 'Write-Output "ps=$env:NX_QUIET_VAR"; exit 3', { NX_QUIET_VAR: 'inherited' })
    expect(p.out.trim()).toBe('ps=inherited')
    expect(p.exit).toBe(3)
  })

  it('a window the command opens never reaches the real desktop, and the foreground does not move', async () => {
    const form = join(SCRATCH, 'form.ps1')
    writeFileSync(
      form,
      [
        'Add-Type -AssemblyName System.Windows.Forms',
        '$f = New-Object System.Windows.Forms.Form',
        "$f.Text = 'NEXUS quiet probe'",
        '$f.TopMost = $true',
        '$t = New-Object System.Windows.Forms.Timer',
        '$t.Interval = 2500',
        '$t.Add_Tick({ $f.Close() })',
        '$t.Start()',
        '$f.Add_Shown({ $f.Activate() })',
        '[void]$f.ShowDialog()',
        "Write-Output 'form closed'",
      ].join('\r\n'),
    )
    const lines: string[] = []
    const watch = spawn(meter, ['watch', '--roots', String(process.pid)], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
    watch.stdout.on('data', (d: Buffer) => lines.push(...String(d).split(/\r?\n/).filter(Boolean)))
    await new Promise((r) => setTimeout(r, 800))
    const r = await run('bash', `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File '${form.replace(/'/g, "'\\''")}'`)
    await new Promise((r) => setTimeout(r, 800))
    watch.stdin.end()
    await new Promise((r) => watch.on('exit', r))
    expect(r.out.trim()).toBe('form closed')
    const events = lines.map((l) => JSON.parse(l) as { e: string; nexus?: boolean })
    expect(events[0]?.e).toBe('ready')
    // Anything of this test's own process tree that was shown or took the focus on the real desktop.
    expect(events.filter((e) => e.nexus === true)).toEqual([])
  }, 60_000)
})
