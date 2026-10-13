import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { NativeWlanAdapter, WlanAdapterError } from '@main/modules/connectivity/wlan'

const csc = join(process.env.SystemRoot ?? 'C:/Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
const canBuild = process.platform === 'win32' && existsSync(csc)

/**
 * Compiles the real helper and runs its two READ-ONLY subcommands on this machine. It never runs `connect`, and it
 * changes nothing. On a machine without Wi-Fi the answer is an empty list or the Windows "service not active" error;
 * both are accepted, a malformed answer is not.
 */
describe.skipIf(!canBuild)('nexus-wlan.exe on this machine (read-only)', () => {
  const out = resolve('test-results/connectivity-scratch/native')

  it('compiles, and its status and profiles output passes the adapter\'s own validation', async () => {
    mkdirSync(out, { recursive: true })
    // Through the command line of the build script, as a developer runs it.
    const built = spawnSync(process.execPath, [resolve('scripts/build-wlan.mjs'), out], { encoding: 'utf8' })
    expect(built.status, built.stderr).toBe(0)
    const exe = join(out, 'nexus-wlan.exe')
    expect(existsSync(exe)).toBe(true)
    try {
      const adapter = new NativeWlanAdapter({ helperPath: exe })
      let interfaces
      try {
        interfaces = await adapter.status()
      } catch (e) {
        expect(e).toBeInstanceOf(WlanAdapterError)
        expect((e as Error).message).toMatch(/WlanOpenHandle/)
        return
      }
      for (const i of interfaces) {
        expect(i.guid).toMatch(/^[0-9a-f-]{36}$/)
        expect(['connected', 'disconnected', 'connecting', 'disconnecting', 'not_ready', 'ad_hoc', 'unknown']).toContain(i.state)
        if (i.state === 'connected') expect(i.profileName).not.toBeNull()
      }
      const profiles = await adapter.profiles()
      for (const p of profiles) {
        expect(['open', 'secured', 'unknown']).toContain(p.security)
        expect(typeof p.autoConnect).toBe('boolean')
      }
      // The output never carries key material: profile entries have exactly these fields.
      for (const p of profiles) expect(Object.keys(p).sort()).toEqual(['autoConnect', 'name', 'security'])
    } finally {
      rmSync(out, { recursive: true, force: true })
    }
  }, 60_000)
})
