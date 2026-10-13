import { mkdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { ApplicationUnderTestManager, AppLaunchError } from '@main/modules/browser/app-manager'
import { AppManifestSchema, electronArgProblem, localEndpointIn, readyLineMatches } from '@main/modules/browser/manifest'

// The manifest is the repository's text. What it says about readiness and about Electron arguments is data that
// NEXUS reads with its own code, never a program it runs.

const SCRATCH = resolve('test-results', 'fix-app', 'manifest-unit')

describe('ready.pattern is literal text', () => {
  it('the hostile pattern that froze the runtime returns at once against hostile output', () => {
    const hostile = `${'a'.repeat(32)}!`
    const started = performance.now()
    for (let i = 0; i < 200; i++) expect(readyLineMatches('^(a+)+$', hostile)).toBe(false)
    expect(performance.now() - started).toBeLessThan(1000)
    // As a literal, the text is found where it is.
    expect(readyLineMatches('^(a+)+$', 'x ^(a+)+$ y')).toBe(true)
  })

  it('a normal readiness line still names the endpoint', () => {
    const line = 'Listening on http://127.0.0.1:41234'
    expect(readyLineMatches('listening on', line)).toBe(true)
    expect(localEndpointIn(line)?.port).toBe(41234)
    expect(readyLineMatches('ready on', line)).toBe(false)
  })

  it('"*" stands for any text, in order, and many of them stay fast', () => {
    expect(readyLineMatches('listening*:41234', 'Listening on http://127.0.0.1:41234')).toBe(true)
    expect(readyLineMatches('41234*listening', 'Listening on http://127.0.0.1:41234')).toBe(false)
    const started = performance.now()
    expect(readyLineMatches(`${'a*'.repeat(90)}b`, 'a'.repeat(4000))).toBe(false)
    expect(performance.now() - started).toBeLessThan(1000)
  })

  it('the manifest accepts printable ASCII text only and says what the field means', () => {
    const bad = AppManifestSchema.safeParse({ type: 'web', launchCommand: 'node s.js', ready: { kind: 'log', pattern: 'ready\u0007' } })
    expect(bad.success).toBe(false)
    if (!bad.success) expect(bad.error.issues[0]?.message).toContain('not a regular expression')
    expect(AppManifestSchema.safeParse({ type: 'web', launchCommand: 'node s.js', ready: { kind: 'log', pattern: 'ready on' } }).success).toBe(true)
  })
})

describe('ready.url is loopback only', () => {
  const manifest = (url: string): unknown => ({ type: 'web', launchCommand: 'node s.js', ready: { kind: 'http', url } })

  it.each(['http://169.254.169.254/', 'http://192.168.1.10:8080/', 'http://example.com/', 'file:///c:/x', 'http://user:pw@127.0.0.1:3000/', 'ftp://127.0.0.1/'])('%s is refused at validation', (url) => {
    const parsed = AppManifestSchema.safeParse(manifest(url))
    expect(parsed.success).toBe(false)
    if (!parsed.success) expect(parsed.error.issues[0]?.message).toContain('127.0.0.1, localhost or [::1]')
  })

  it.each(['http://127.0.0.1:3000/', 'http://localhost:5173/health', 'https://[::1]:8443/'])('%s is accepted', (url) => {
    expect(AppManifestSchema.safeParse(manifest(url)).success).toBe(true)
  })

  afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }))

  it('a manifest handed to the manager without validation is refused before anything is started or requested', async () => {
    mkdirSync(SCRATCH, { recursive: true })
    let started = 0
    const broker = {
      usable: () => ({ usable: true, detail: '' }),
      containProgram: async () => {
        started++
        return { ok: false as const, reason: 'must not be reached' }
      },
      releaseSpec: () => undefined,
    }
    const apps = new ApplicationUnderTestManager({ broker: broker as never, browser: {} as never, profileFor: () => 'RESTRICTED', artifactsDir: resolve(SCRATCH, 'art') })
    const given = { type: 'web' as const, launchCommand: 'node s.js', cwd: '.', ready: { kind: 'http' as const, url: 'http://169.254.169.254/latest/meta-data/' }, startTimeoutSeconds: 5, env: {} }
    const error = await apps.launch({ projectId: 'p', runId: 'r', taskId: 't', key: 'k', worktree: SCRATCH }, given).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AppLaunchError)
    expect((error as AppLaunchError).message).toContain('127.0.0.1, localhost or [::1]')
    expect(started).toBe(0)
  })
})

describe('electron.args is an allowlist', () => {
  it.each(['--log-file=c:/x.log', '--enable-logging=c:/x', '--crash-dumps-dir=c:/d', '--disk-cache-dir=c:/c', '--app=http://x', '--allow-file-access-from-files', '-r', '--require', '/log-file=c:/x', '/enable-logging', '-r=x.js', '--remote-debugging-port=1', '--no-sandbox', 'c:\\x', '..\\x'])('%s is refused', (arg) => {
    expect(electronArgProblem(arg)).not.toBeNull()
    expect(AppManifestSchema.safeParse({ type: 'electron', electron: { args: [arg] } }).success).toBe(false)
  })

  it.each(['--lang=en-US', '--window-size=800,600', '--disable-gpu', 'positional', 'dist/main.js', '--force-device-scale-factor=1'])('%s is passed on', (arg) => {
    expect(electronArgProblem(arg)).toBeNull()
    expect(AppManifestSchema.safeParse({ type: 'electron', electron: { args: [arg] } }).success).toBe(true)
  })
})
