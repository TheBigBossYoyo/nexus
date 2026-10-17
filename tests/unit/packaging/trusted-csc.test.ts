import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
// @ts-expect-error build scripts, plain JavaScript
import { REG_EXE, trustedCsc } from '../../../scripts/trusted-csc.mjs'
// @ts-expect-error build script
import { buildElevateHelper } from '../../../scripts/build-elevate.mjs'
// @ts-expect-error build script
import { buildLauncher } from '../../../scripts/build-launcher.mjs'
// @ts-expect-error build script
import { buildWlanHelper } from '../../../scripts/build-wlan.mjs'
// @ts-expect-error build script
import { buildSipHelper } from '../../../scripts/build-sip.mjs'
// @ts-expect-error build script
import { buildPresenceHelper } from '../../../scripts/build-presence.mjs'

// Review L13: the C# compiler comes from HKLM, never from the environment.
const scratchRoot = resolve('test-results', 'trusted-csc')
mkdirSync(scratchRoot, { recursive: true })
const scratch = mkdtempSync(join(scratchRoot, 'run-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

const ROOT = 'C:\\Windows'
const CSC = `${ROOT}\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe`
const regOut = (value: string, type = 'REG_SZ'): string => `\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\r\n    SystemRoot    ${type}    ${value}\r\n\r\n`

interface Calls {
  file?: string
  args?: string[]
  options?: Record<string, unknown>
}
function deps(over: { stdout?: string; status?: number; error?: Error; present?: (p: string) => boolean; real?: (p: string) => string } = {}, calls: Calls = {}) {
  return {
    spawnSync: (file: string, args: string[], options: Record<string, unknown>) => {
      Object.assign(calls, { file, args, options })
      return { status: over.status ?? 0, stdout: over.stdout ?? regOut(ROOT), error: over.error }
    },
    existsSync: over.present ?? (() => true),
    realpath: over.real ?? ((p: string) => p)
  }
}

describe('trustedCsc', () => {
  it('returns the compiler under the HKLM Windows folder, with reg.exe at its fixed path', () => {
    const calls: Calls = {}
    expect(trustedCsc(deps({}, calls))).toBe(CSC)
    expect(calls.file).toBe('C:\\Windows\\System32\\reg.exe')
    expect(REG_EXE).toBe('C:\\Windows\\System32\\reg.exe')
    expect(calls.args).toEqual(['query', 'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion', '/v', 'SystemRoot'])
    expect(calls.options).toMatchObject({ shell: false, windowsHide: true })
    expect(calls.options?.timeout).toBeGreaterThan(0)
    expect(JSON.stringify(calls.options?.env)).not.toMatch(/SystemRoot|windir/i)
  })

  it('accepts REG_EXPAND_SZ and a root on another drive', () => {
    expect(trustedCsc(deps({ stdout: regOut('D:\\WINNT', 'REG_EXPAND_SZ') }))).toBe('D:\\WINNT\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe')
  })

  it('ignores a spoofed process.env.SystemRoot', () => {
    const fake = join(scratch, 'fake')
    mkdirSync(join(fake, 'Microsoft.NET', 'Framework64', 'v4.0.30319'), { recursive: true })
    writeFileSync(join(fake, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'), 'x')
    const saved = process.env.SystemRoot
    process.env.SystemRoot = fake
    try {
      expect(trustedCsc(deps())).toBe(CSC)
    } finally {
      if (saved === undefined) delete process.env.SystemRoot
      else process.env.SystemRoot = saved
    }
  })

  it('throws when reg.exe is missing, fails, or cannot start', () => {
    expect(() => trustedCsc(deps({ present: (p) => p !== REG_EXE }))).toThrow(/registry tool was not found/)
    expect(() => trustedCsc(deps({ status: 1 }))).toThrow(/exited with 1/)
    expect(() => trustedCsc(deps({ error: new Error('ETIMEDOUT') }))).toThrow(/ETIMEDOUT/)
  })

  it('throws on an unparsable, relative or traversing value', () => {
    for (const stdout of ['', 'garbage', regOut('Windows'), regOut('\\Windows'), regOut('C:\\Windows\\..\\Temp'), regOut('C:Windows')]) {
      expect(() => trustedCsc(deps({ stdout }))).toThrow(/not an absolute drive path/)
    }
  })

  it('throws when csc.exe is missing', () => {
    expect(() => trustedCsc(deps({ present: (p) => p === REG_EXE }))).toThrow(/compiler of Windows was not found/)
  })

  it('throws when the compiler resolves outside Framework64 (a junction)', () => {
    const real = (p: string) => (p === CSC ? 'C:\\Users\\evil\\csc.exe' : p)
    expect(() => trustedCsc(deps({ real }))).toThrow(/resolves outside/)
    const sibling = (p: string) => (p === CSC ? 'C:\\Windows\\Microsoft.NET\\Framework64-evil\\csc.exe' : p)
    expect(() => trustedCsc(deps({ real: sibling }))).toThrow(/resolves outside/)
  })

  it('throws, keeping the cause, when the compiler path cannot be resolved', () => {
    const failure = new Error('EACCES')
    const real = () => {
      throw failure
    }
    expect(() => trustedCsc(deps({ real }))).toThrow(expect.objectContaining({ message: expect.stringMatching(/could not be resolved: EACCES/), cause: failure }))
  })

  it('accepts a different case and a legitimate redirect inside Framework64', () => {
    const real = (p: string) => (p === CSC ? 'c:\\windows\\microsoft.net\\framework64\\v4.0.30319\\csc.exe' : p)
    expect(trustedCsc(deps({ real }))).toBe(CSC)
  })
})

const fakeRun = (log: string[], status = 0, writeOutput = true) => (file: string, args: string[]) => {
  log.push(file)
  const out = args.find((a) => a.startsWith('/out:'))!.slice(5)
  if (writeOutput) writeFileSync(out, 'exe')
  return { status, stdout: '', stderr: 'boom' }
}
const findCsc = () => CSC

function dirWithNewerOutput(name: string, exe: string): string {
  const dir = join(scratch, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, exe), 'old')
  const future = new Date(Date.now() + 3_600_000)
  utimesSync(join(dir, exe), future, future)
  return dir
}

describe.skipIf(process.platform !== 'win32')('the builders', () => {
  it('build-elevate compiles even when a newer output exists', () => {
    const dir = dirWithNewerOutput('elevate', 'nexus-elevate.exe')
    const log: string[] = []
    buildElevateHelper(dir, { findCsc, run: fakeRun(log) })
    expect(log).toEqual([CSC])
    expect(readFileSync(join(dir, 'nexus-elevate.exe'), 'utf8')).toBe('exe')
  })

  it('build-elevate throws on a failed compile and leaves no output', () => {
    const dir = dirWithNewerOutput('elevate-fail', 'nexus-elevate.exe')
    expect(() => buildElevateHelper(dir, { findCsc, run: fakeRun([], 1, false) })).toThrow(/did not compile/)
    expect(existsSync(join(dir, 'nexus-elevate.exe'))).toBe(false)
  })

  const others: Array<[string, (dir: string, o?: object) => string, string]> = [
    ['launcher', buildLauncher, 'nexus-launch.exe'],
    ['wlan', buildWlanHelper, 'nexus-wlan.exe'],
    ['sip', buildSipHelper, 'nexus-sip.exe'],
    ['presence', buildPresenceHelper, 'nexus-presence.exe']
  ]
  for (const [name, build, exe] of others) {
    it(`build-${name}: reuses a newer output, but compiles when fresh`, () => {
      const dir = dirWithNewerOutput(name, exe)
      const log: string[] = []
      build(dir, { findCsc, run: fakeRun(log) })
      expect(log).toEqual([])
      build(dir, { fresh: true, findCsc, run: fakeRun(log) })
      expect(log).toEqual([CSC])
    })
  }
})

describe('sources and package.json', () => {
  const scripts = readdirSync('scripts').filter((f) => /^build-.*\.mjs$/.test(f))

  it('no build script reads SystemRoot or windir; each imports trusted-csc', () => {
    expect(scripts.length).toBeGreaterThanOrEqual(5)
    for (const f of scripts) {
      const text = readFileSync(join('scripts', f), 'utf8')
      expect(text, f).not.toMatch(/SystemRoot|windir/i)
      if (/csc/i.test(text)) expect(text, f).toContain("from './trusted-csc.mjs'")
    }
  })

  it('the package script passes --fresh to the four reusing builders, and only that script', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')).scripts as Record<string, string>
    for (const b of ['launcher', 'wlan', 'sip', 'presence']) expect(pkg.package).toContain(`node scripts/build-${b}.mjs --fresh`)
    expect(pkg.package).toContain('node scripts/build-elevate.mjs &&')
    for (const k of ['build', 'launcher:build', 'test:e2e']) expect(pkg[k]).not.toContain('--fresh')
  })
})

// Opt-in: needs the real registry and the real compiler. Never runs a built exe.
describe.skipIf(process.platform !== 'win32' || process.env.NEXUS_REAL_CSC_TEST !== '1')('real compiler (NEXUS_REAL_CSC_TEST=1)', () => {
  it('finds csc.exe under the real Framework64 and compiles the broker without running it', () => {
    const csc = trustedCsc() as string
    expect(csc.toLowerCase()).toMatch(/\\microsoft\.net\\framework64\\v4\.0\.30319\\csc\.exe$/)
    expect(existsSync(csc)).toBe(true)
    const dir = join(scratch, 'real')
    const out = buildElevateHelper(dir) as string
    expect(existsSync(out)).toBe(true)
    // the produced exe is deliberately never started
  })
})
