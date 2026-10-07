import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { RuntimeStatus } from '@shared/runtime-protocol'
import type { Settings } from '@shared/settings'
import { RuntimeClient } from '@main/modules/runtime/client'
import { readEndpoint } from '@main/modules/runtime/endpoint'

/**
 * The confirmation the runtime process shows by itself (`pnpm smoke:dialog`, after `pnpm build`). Never part of
 * `pnpm test`: it starts the real Electron runtime (real agent runtime, nothing scripted, no test-only route for
 * confirmations) and operates its native dialog through Windows UI Automation, the way a person's click does.
 *
 * It proves what no other test can: that a settings change which would start a program makes the runtime
 * process open a real dialog; that a client of the pipe is not asked and cannot answer; that "Cancel" leaves the
 * settings as they were and "Allow" stores them. It shows two small dialogs on the screen for about a second each:
 * Windows keeps a dialog on a display, so this test cannot hide them. No agent session is started and no provider
 * is used.
 */
const REPO = resolve(import.meta.dirname, '..', '..')
const ELECTRON = join(REPO, 'node_modules', 'electron', 'dist', 'electron.exe')
const dataDir = mkdtempSync(join(tmpdir(), 'nexus-dialog-smoke-'))
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const UIA = String.raw`
param([int]$ProcessId, [string]$Press)
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type @"
using System; using System.Text; using System.Runtime.InteropServices; using System.Collections.Generic;
public class NexusDialogs {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  public static List<IntPtr> Of(uint pid) {
    var found = new List<IntPtr>();
    EnumWindows((h, l) => { uint p; GetWindowThreadProcessId(h, out p); var c = new StringBuilder(64); GetClassName(h, c, 64);
      if (p == pid && c.ToString() == "#32770" && IsWindowVisible(h)) found.Add(h); return true; }, IntPtr.Zero);
    return found;
  }
}
"@
$ae = [System.Windows.Automation.AutomationElement]
$out = @()
foreach ($handle in [NexusDialogs]::Of([uint32]$ProcessId)) {
  $w = $ae::FromHandle($handle)
  $buttons = $w.FindAll([System.Windows.Automation.TreeScope]::Descendants, (New-Object System.Windows.Automation.PropertyCondition($ae::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)))
  $texts = $w.FindAll([System.Windows.Automation.TreeScope]::Descendants, (New-Object System.Windows.Automation.PropertyCondition($ae::ControlTypeProperty, [System.Windows.Automation.ControlType]::Text)))
  $r = $w.Current.BoundingRectangle
  $pressed = $false
  foreach ($b in $buttons) {
    if ($Press -and $b.Current.Name -eq $Press) {
      $b.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
      $pressed = $true
    }
  }
  $out += [pscustomobject]@{
    title = $w.Current.Name
    className = $w.Current.ClassName
    left = [int]$r.Left; top = [int]$r.Top; width = [int]$r.Width; height = [int]$r.Height
    buttons = @($buttons | ForEach-Object { $_.Current.Name })
    texts = @($texts | ForEach-Object { $_.Current.Name })
    pressed = $pressed
  }
}
ConvertTo-Json -InputObject @($out) -Depth 4 -Compress
`

interface DialogSeen {
  title: string
  className: string
  left: number
  top: number
  width: number
  height: number
  buttons: string[]
  texts: string[]
  pressed: boolean
}

const script = join(dataDir, 'uia.ps1')
writeFileSync(script, UIA)

function dialogs(pid: number, press = ''): DialogSeen[] {
  const out = execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-ProcessId', String(pid), '-Press', press], { encoding: 'utf8', windowsHide: true, timeout: 30_000 }).trim()
  if (out === '') return []
  const parsed = JSON.parse(out) as DialogSeen | DialogSeen[]
  return Array.isArray(parsed) ? parsed : [parsed]
}

async function waitForDialog(pid: number, button: string, timeoutMs = 8_000): Promise<DialogSeen> {
  const end = Date.now() + timeoutMs
  for (;;) {
    const found = dialogs(pid).find((d) => d.buttons.includes(button))
    if (found) return found
    if (Date.now() > end) {
      const dump = process.env['NEXUS_DIALOG_SMOKE_WINDOWS']
      const windows = dump ? execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', dump, '-ProcessId', String(pid)], { encoding: 'utf8', windowsHide: true }) : ''
      throw new Error(`No dialog with a "${button}" button appeared in the runtime process.\n${JSON.stringify(dialogs(pid))}\n${windows}`)
    }
    await sleep(300)
  }
}

let runtime: ChildProcess | null = null
let client: RuntimeClient | null = null

afterAll(() => {
  client?.close()
  // The runtime of this test's own data directory, by the handle this test holds.
  if (runtime && runtime.exitCode === null && runtime.pid !== undefined) {
    try {
      execFileSync('taskkill', ['/PID', String(runtime.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    } catch {
      // Already gone.
    }
  }
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

describe.skipIf(process.platform !== 'win32' || !existsSync(ELECTRON) || !existsSync(join(REPO, 'out', 'main', 'index.js')))('the confirmation of the runtime process', () => {
  it('is a real dialog of the runtime, is not sent to a pipe client, and decides whether a program in the settings is stored', async () => {
    const env: NodeJS.ProcessEnv = { ...process.env, NEXUS_DATA_DIR: dataDir, NEXUS_WINDOW_OFFSCREEN: '1' }
    for (const name of ['NEXUS_FAKE_RUNTIME', 'NEXUS_FAKE_CONFIRM', 'NEXUS_FAKE_POWER', 'NEXUS_FAKE_WORKERS', 'ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL']) delete env[name]
    runtime = spawn(ELECTRON, [REPO, '--nexus-runtime'], { env, stdio: 'ignore', windowsHide: true })
    const started = Date.now()
    while (!readEndpoint(dataDir)) {
      if (Date.now() - started > 60_000) throw new Error('The runtime did not write its endpoint.')
      await sleep(200)
    }
    const pid = readEndpoint(dataDir)?.pid as number
    expect(pid).toBe(runtime.pid)

    // A client that calls itself the window and would say yes to anything it is asked.
    const asked: string[] = []
    client = new RuntimeClient({
      dataDir,
      kind: 'desktop',
      onUiRequest: async (request) => {
        asked.push(request.kind)
        return request.kind === 'confirm' ? { response: 0 } : request.kind === 'pickDirectory' ? { path: null } : { done: true }
      },
    })
    client.start()
    await client.whenConnected(30_000)
    const invoke = async <T>(channel: string, input: unknown = {}): Promise<T> => {
      const result = await (client as RuntimeClient).invoke(channel, input)
      if (!result.ok) throw new Error(`${channel}: ${result.error.code}: ${result.error.message}`)
      return result.value as T
    }
    for (let i = 0; i < 100; i++) {
      if ((await invoke<RuntimeStatus>('runtime.status')).phase === 'READY') break
      await sleep(200)
    }
    const before = await invoke<Settings>('settings.get')
    const changed: Settings = { ...before, permissions: { ...before.permissions, safeCommandPrefixes: [...before.permissions.safeCommandPrefixes, 'pnpm dialog-smoke'] } }
    expect(dialogs(pid).filter((d) => d.buttons.includes('Allow'))).toEqual([])

    // 1. The change is requested; the runtime opens its own dialog. Cancel: nothing is stored.
    const refused = (client as RuntimeClient).invoke('settings.update', { settings: changed })
    const first = await waitForDialog(pid, 'Allow')
    expect(first.title).toBe('NEXUS Settings')
    expect(first.buttons).toEqual(expect.arrayContaining(['Allow', 'Cancel']))
    expect(first.texts.join('\n')).toContain('pnpm dialog-smoke')
    expect(first.width).toBeGreaterThan(100)
    expect(dialogs(pid, 'Cancel').some((d) => d.pressed)).toBe(true)
    expect(await refused).toMatchObject({ ok: false, error: { code: 'invalid_state' } })
    expect(await invoke<Settings>('settings.get')).toEqual(before)

    // 2. Asked again. Allow: the change is stored.
    const allowed = (client as RuntimeClient).invoke('settings.update', { settings: changed })
    await waitForDialog(pid, 'Allow')
    expect(dialogs(pid, 'Allow').some((d) => d.pressed)).toBe(true)
    expect(await allowed).toMatchObject({ ok: true })
    expect((await invoke<Settings>('settings.get')).permissions.safeCommandPrefixes).toContain('pnpm dialog-smoke')

    // The pipe client was never asked to confirm anything.
    expect(asked.filter((kind) => kind === 'confirm')).toEqual([])
    // With nothing running the runtime stops without a question.
    expect(await invoke<{ stopping: boolean }>('runtime.stop')).toEqual({ stopping: true })
  }, 180_000)
})
