import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ExecutionBroker, type ContainSession } from '@main/modules/isolation/execution-broker'
import { LAUNCH_EXIT, Launcher, type ContainmentProfile } from '@main/modules/isolation/launcher'
import { readSandboxAccount } from '@main/modules/isolation/sandbox-account'
import { mirrorTools } from '@main/modules/isolation/tools'
// @ts-expect-error a build script, plain JavaScript
import { buildLauncher } from '../../../scripts/build-launcher.mjs'

// The containment, against the operating system. Each profile runs the same hostile programs; they are
// harmless: they try to read sentinel files this test wrote, to write marker files, to reach a local server
// this test started and a public address, and to leave a process behind. What is asserted is what Windows did.
//
// RESTRICTED always runs. ISOLATED runs when the machine's sandbox account was set up
// (node scripts/sandbox-setup.mjs); without it the suite says so and tests that ISOLATED is refused.
//
// Targets are console programs only (cmd, node), never anything with a window; the launcher sets the error mode
// so that a program that cannot start fails with a code and not with a dialog.

const WINDOWS = process.platform === 'win32'
const d = WINDOWS ? describe : describe.skip
const account = WINDOWS ? readSandboxAccount() : null
const SCRATCH = resolve('test-results', 'isolation-tests')
const SENTINEL = 'NEXUS-ISOLATION-SENTINEL-9d2e'
const WHOAMI = join(process.env['SystemRoot'] ?? 'C:/Windows', 'System32', 'whoami.exe')

let launcher: Launcher
let broker: ExecutionBroker
let localServer: Server
let localPort = 0
let localHits = 0
/** A directory of the user's that nobody labeled: the stand-in for "unrelated user files". */
const userDir = join(SCRATCH, 'user-files')
/** A directory NEXUS protected (no read up): the stand-in for a credential store. */
const protectedDir = join(SCRATCH, 'protected-store')
/** A directory inside the user's profile proper, for what only a different account is kept from. */
const profileDir = join(homedir(), '.nexus-isolation-test')

const PROFILES: ContainmentProfile[] = account ? ['RESTRICTED', 'ISOLATED'] : ['RESTRICTED']

function worktreeFor(profile: ContainmentProfile, name: string): string {
  const base = profile === 'ISOLATED' && account ? join(account.root, 'worktrees', 'isolation-tests') : join(SCRATCH, 'worktrees')
  const dir = join(base, name)
  mkdirSync(dir, { recursive: true })
  return dir
}

function session(profile: ContainmentProfile, name: string): ContainSession {
  return { profile, projectId: 'isolation-tests', sessionKey: name, worktree: worktreeFor(profile, name) }
}

/** Runs a node program inside the containment and returns what it printed as JSON lines. */
async function probe(profile: ContainmentProfile, name: string, source: string, env: Record<string, string> = {}): Promise<{ exit: number | null; lines: Record<string, string>; raw: string }> {
  const s = session(profile, name)
  const script = join(s.worktree, 'probe.cjs')
  writeFileSync(script, source)
  const result = await broker.run({ ...s, file: 'node', args: [script], set: { PROBE_USER_DIR: userDir, PROBE_PROTECTED_DIR: protectedDir, PROBE_PROFILE_DIR: profileDir, PROBE_PORT: String(localPort), ...env } }, { timeoutMs: 60_000 })
  const lines: Record<string, string> = {}
  for (const line of result.stdout.split(/\r?\n/)) {
    const m = /^([a-z0-9-]+)=(.*)$/.exec(line.trim())
    if (m) lines[m[1] as string] = m[2] as string
  }
  return { exit: result.exitCode, lines, raw: `${result.stdout}\n${result.stderr}` }
}

const ATTEMPT = `
const fs = require('fs'); const path = require('path'); const cp = require('child_process');
function attempt(name, fn) { try { const v = fn(); console.log(name + '=OK:' + String(v).slice(0, 60).replace(/\\s+/g, ' ')); } catch (e) { console.log(name + '=DENIED:' + (e.code || e.message)); } }
`

d('containment against the operating system', () => {
  beforeAll(async () => {
    rmSync(SCRATCH, { recursive: true, force: true })
    for (const dir of [userDir, protectedDir, profileDir]) mkdirSync(dir, { recursive: true })
    writeFileSync(join(userDir, 'notes.txt'), `${SENTINEL}-user`)
    writeFileSync(join(protectedDir, 'credentials.json'), `${SENTINEL}-protected`)
    writeFileSync(join(profileDir, 'secret.txt'), `${SENTINEL}-profile`)
    launcher = new Launcher({ executable: buildLauncher(join(SCRATCH, 'native')) as string, specDir: join(SCRATCH, 'specs') })
    await launcher.label('protect', protectedDir)
    const state = account ? mirrorTools({ sandboxRoot: account.root, userProfile: homedir(), path: process.env['PATH'] ?? '', names: ['node'] }) : null
    broker = new ExecutionBroker({
      launcher,
      sandboxDir: join(SCRATCH, 'sandbox'),
      account: () => account,
      baseEnv: () => ({ ...process.env, ANTHROPIC_API_KEY: `${SENTINEL}-env`, GITHUB_TOKEN: `${SENTINEL}-env`, NEXUS_DATA_DIR: `${SENTINEL}-env` }),
      toolPath: (profile, path) => (profile === 'ISOLATED' && state ? state.path : path),
      limits: { maxProcesses: 64 },
      posixShell: () => resolve('vendor', 'busybox', 'busybox.exe'),
    })
    localServer = createServer((_req, res) => {
      localHits += 1
      res.end('local-service')
    })
    await new Promise<void>((done) => localServer.listen({ host: '127.0.0.1', port: 0 }, done))
    localPort = (localServer.address() as AddressInfo).port
    for (const profile of PROFILES) await broker.verify(profile)
  }, 240_000)

  afterAll(async () => {
    await new Promise<void>((done) => localServer.close(() => done()))
    await launcher.label('clear', protectedDir).catch(() => undefined)
    rmSync(SCRATCH, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
    rmSync(profileDir, { recursive: true, force: true })
    if (account) {
      rmSync(join(account.root, 'worktrees', 'isolation-tests'), { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
      broker.sweep()
    }
  })

  it('reports which profiles hold on this machine, each by having run it', () => {
    expect(broker.usable('RESTRICTED')).toMatchObject({ usable: true })
    expect(broker.status('RESTRICTED')?.detail).toContain('It runs as you')
    if (account) {
      const isolated = broker.usable('ISOLATED')
      expect(isolated.usable, isolated.detail).toBe(true)
      expect(isolated.detail).toContain('no direct route to the Internet')
    } else {
      expect(broker.usable('ISOLATED')).toMatchObject({ usable: false })
      expect(broker.usable('ISOLATED').detail).toContain('not set up')
    }
  })

  it('refuses rather than runs when a profile was not verified, and when ISOLATED is asked for without an account', async () => {
    const fresh = new ExecutionBroker({ launcher: new Launcher({ executable: launcher.executable, specDir: join(SCRATCH, 'specs2') }), sandboxDir: join(SCRATCH, 'sandbox2'), account: () => null, baseEnv: () => process.env })
    const unverified = await fresh.containShell({ ...session('RESTRICTED', 'unverified'), cwd: SCRATCH, shell: 'bash', command: 'echo should-not-run' })
    expect(unverified).toMatchObject({ ok: false })
    await fresh.verify('ISOLATED')
    expect(fresh.usable('ISOLATED')).toMatchObject({ usable: false })
    await expect(fresh.run({ ...session('RESTRICTED', 'no-account'), profile: 'ISOLATED', file: 'cmd', args: ['/c', 'echo', 'x'] })).rejects.toThrow(/not available/)
  })

  for (const profile of PROFILES) {
    describe(profile, () => {
      it('runs a program with its output, its exit code and only the environment it was given', async () => {
        const r = await probe(profile, 'env', `console.log('ok=' + (1 + 1)); console.log('keys=' + Object.keys(process.env).filter(k => /KEY|TOKEN|NEXUS|ANTHROPIC|GITHUB/i.test(k)).join(',')); console.log('home=' + require('os').homedir()); console.log('all=' + JSON.stringify(process.env).includes('${SENTINEL}')); process.exit(3)`)
        expect(r.exit, r.raw).toBe(3)
        expect(r.lines['ok']).toBe('2')
        expect(r.lines['keys']).toBe('')
        expect(r.lines['all']).toBe('false')
        expect(r.lines['home']?.toLowerCase()).not.toBe(homedir().toLowerCase())
      })

      it('writes in its worktree and its temporary directory, and nowhere else it tries', async () => {
        const r = await probe(
          profile,
          'writes',
          `${ATTEMPT}
attempt('worktree', () => { fs.writeFileSync('built.txt', 'x'); return fs.readFileSync('built.txt', 'utf8'); });
attempt('temp', () => { const f = path.join(require('os').tmpdir(), 't.txt'); fs.writeFileSync(f, 'x'); return 'written'; });
attempt('user-dir', () => { fs.writeFileSync(path.join(process.env.PROBE_USER_DIR, 'planted.txt'), 'x'); return 'ESCAPED'; });
attempt('user-overwrite', () => { fs.writeFileSync(path.join(process.env.PROBE_USER_DIR, 'notes.txt'), 'overwritten'); return 'ESCAPED'; });
attempt('user-delete', () => { fs.rmSync(path.join(process.env.PROBE_USER_DIR, 'notes.txt')); return 'ESCAPED'; });
attempt('profile-dir', () => { fs.writeFileSync(path.join(process.env.PROBE_PROFILE_DIR, 'planted.txt'), 'x'); return 'ESCAPED'; });
attempt('windows-dir', () => { fs.writeFileSync(path.join(process.env.SystemRoot, 'nexus-planted.txt'), 'x'); return 'ESCAPED'; });
attempt('parent', () => { fs.writeFileSync(path.join('..', 'planted-beside.txt'), 'x'); return 'ESCAPED'; });
attempt('via-cmd', () => { cp.execSync('cmd /c echo x> "' + path.join(process.env.PROBE_USER_DIR, 'planted-cmd.txt') + '"', { stdio: 'pipe' }); return 'ESCAPED'; });
attempt('via-powershell', () => { cp.execSync('powershell -NoProfile -NonInteractive -Command "Set-Content -Path \\'' + path.join(process.env.PROBE_USER_DIR, 'planted-ps.txt') + '\\' -Value x -ErrorAction Stop"', { stdio: 'pipe' }); return 'ESCAPED'; });
attempt('junction', () => { fs.symlinkSync(process.env.PROBE_USER_DIR, 'link', 'junction'); fs.writeFileSync(path.join('link', 'planted-junction.txt'), 'x'); return 'ESCAPED'; });
attempt('registry', () => { cp.execSync('reg add HKCU\\\\Software\\\\NexusIsolationTest /v planted /d 1 /f', { stdio: 'pipe' }); return 'ESCAPED'; });
`,
        )
        expect(r.lines['worktree'], r.raw).toBe('OK:x')
        expect(r.lines['temp']).toBe('OK:written')
        for (const key of ['user-dir', 'user-overwrite', 'user-delete', 'profile-dir', 'windows-dir', 'parent', 'via-cmd', 'via-powershell', 'junction', 'registry']) expect(r.lines[key], `${key}: ${r.raw}`).toMatch(/^DENIED:/)
        for (const planted of ['planted.txt', 'planted-cmd.txt', 'planted-ps.txt', 'planted-junction.txt']) expect(existsSync(join(userDir, planted)), planted).toBe(false)
        expect(readFileSync(join(userDir, 'notes.txt'), 'utf8')).toBe(`${SENTINEL}-user`)
        expect(existsSync(join(profileDir, 'planted.txt'))).toBe(false)
        // The registry: nothing was written under the user's own hive.
        expect(() => execFileSync('reg', ['query', 'HKCU\\Software\\NexusIsolationTest'], { stdio: 'pipe', windowsHide: true })).toThrow()
      })

      it('cannot read what NEXUS protected, in any way it tries', async () => {
        const r = await probe(
          profile,
          'protected',
          `${ATTEMPT}
const f = path.join(process.env.PROBE_PROTECTED_DIR, 'credentials.json');
attempt('read', () => fs.readFileSync(f, 'utf8'));
attempt('list', () => fs.readdirSync(process.env.PROBE_PROTECTED_DIR).join(','));
attempt('stat', () => fs.statSync(f).size);
attempt('copy', () => { fs.copyFileSync(f, 'stolen.txt'); return fs.readFileSync('stolen.txt', 'utf8'); });
attempt('type', () => cp.execSync('cmd /c type "' + f + '"', { stdio: 'pipe' }).toString());
attempt('link', () => { fs.linkSync(f, 'hard.txt'); return fs.readFileSync('hard.txt', 'utf8'); });
attempt('stream', () => fs.readFileSync(f + '::$DATA', 'utf8'));
`,
        )
        for (const key of ['read', 'list', 'stat', 'copy', 'type', 'link', 'stream']) expect(r.lines[key], `${key}: ${r.raw}`).toMatch(/^DENIED:/)
        expect(r.raw).not.toContain(SENTINEL)
      })

      it('what it can do with junctions and links to places that are not its own (recorded as Windows answers)', async () => {
        // A junction or a link planted in a worktree matters when a process with more rights later walks the
        // worktree. This records what Windows lets contained code make; NEXUS does not rely on the answer:
        // whatever reads or writes a worktree for NEXUS runs inside the containment too.
        const r = await probe(
          profile,
          'junctions',
          `${ATTEMPT}
const user = process.env.PROBE_USER_DIR; const prot = process.env.PROBE_PROTECTED_DIR; const profileDir = process.env.PROBE_PROFILE_DIR;
attempt('junction-user', () => { fs.symlinkSync(user, 'j-user', 'junction'); return 'made'; });
attempt('read-through-user', () => fs.readFileSync(path.join('j-user', 'notes.txt'), 'utf8'));
attempt('write-through-user', () => { fs.writeFileSync(path.join('j-user', 'planted.txt'), 'x'); return 'wrote'; });
attempt('junction-protected', () => { fs.symlinkSync(prot, 'j-prot', 'junction'); return 'made'; });
attempt('read-through-protected', () => fs.readFileSync(path.join('j-prot', 'credentials.json'), 'utf8'));
attempt('junction-profile', () => { fs.symlinkSync(profileDir, 'j-profile', 'junction'); return 'made'; });
attempt('read-through-profile', () => fs.readFileSync(path.join('j-profile', 'secret.txt'), 'utf8'));
attempt('symlink-dir', () => { fs.symlinkSync(user, 's-user', 'dir'); return 'made'; });
attempt('symlink-file', () => { fs.symlinkSync(path.join(user, 'notes.txt'), 's-file', 'file'); return 'made'; });
attempt('mklink-j', () => cp.execSync('cmd /c mklink /J j-cmd "' + user + '"', { stdio: 'pipe' }).toString());
`,
        )
        writeFileSync(join(SCRATCH, `junctions-${profile}.txt`), r.raw)
        // Never, under either profile: nothing protected is read and nothing is written outside through a link.
        expect(r.lines['read-through-protected'], r.raw).toMatch(/^DENIED:/)
        expect(r.lines['write-through-user'], r.raw).toMatch(/^DENIED:/)
        expect(existsSync(join(userDir, 'planted.txt'))).toBe(false)
        expect(r.raw).not.toContain(`${SENTINEL}-protected`)
        // The sandbox account reads nothing of the user's through one either.
        if (profile === 'ISOLATED') {
          expect(r.lines['read-through-user'], r.raw).toMatch(/^DENIED:/)
          expect(r.lines['read-through-profile'], r.raw).toMatch(/^DENIED:/)
          expect(r.raw).not.toContain(SENTINEL)
        }
        console.info(`junctions under ${profile}: ${JSON.stringify(r.lines)}`)
      })

      it('cannot leave a process behind: a detached grandchild ends with the command', async () => {
        const s = session(profile, 'orphan')
        const marker = join(s.worktree, 'still-alive.txt')
        const r = await probe(profile, 'orphan', `const cp = require('child_process'); const c = cp.spawn(process.execPath, ['-e', "setTimeout(() => require('fs').writeFileSync('still-alive.txt', 'alive'), 3000)"], { detached: true, stdio: 'ignore' }); c.unref(); console.log('spawned=' + !!c.pid);`)
        expect(r.lines['spawned'], r.raw).toBe('true')
        await new Promise((done) => setTimeout(done, 4500))
        expect(existsSync(marker)).toBe(false)
      })

      it('is stopped at its process limit, and the machine is not', async () => {
        const r = await probe(profile, 'forks', `const cp = require('child_process'); let alive = 0; const kids = []; for (let i = 0; i < 300; i++) { try { const c = cp.spawn('cmd', ['/c', 'ping -n 6 127.0.0.1 >nul'], { stdio: 'ignore' }); c.on('error', () => {}); kids.push(c); } catch (e) {} } setTimeout(() => { for (const c of kids) if (c.exitCode === null && c.pid) alive++; console.log('alive=' + alive); process.exit(0); }, 1500);`)
        expect(Number(r.lines['alive']), r.raw).toBeLessThanOrEqual(64)
      })

      it("is ended at its time limit with the launcher's own code", async () => {
        const s = session(profile, 'timeout')
        const started = Date.now()
        const result = await broker.run({ ...s, file: 'node', args: ['-e', 'setTimeout(() => {}, 30000)'] }, { timeoutMs: 2000 })
        expect(Date.now() - started).toBeLessThan(20_000)
        // Either the launcher ended it at its own limit, or the caller's limit ended the launcher and the job with it.
        expect(result.timedOut || result.exitCode === LAUNCH_EXIT.timeout, JSON.stringify({ exit: result.exitCode, timedOut: result.timedOut })).toBe(true)
      })

      it('runs on a desktop of its own, cannot open the one the user sees, makes no desktop, and inherits its three standard handles only', async () => {
        // Compiled with the compiler that ships with Windows, as the launcher is; run from the worktree, where the profile's account can read it.
        const s = session(profile, 'ui-probe')
        const exe = join(s.worktree, 'ui-probe.exe')
        const csc = join(process.env['SystemRoot'] ?? 'C:/Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
        execFileSync(csc, ['/nologo', '/optimize+', '/platform:x64', '/target:exe', `/out:${exe}`, resolve('tests', 'integration', 'isolation', 'ui-probe.cs')], { windowsHide: true, stdio: 'pipe' })
        // The same program outside any containment, as the control: it is on the user's desktop and holds what this process let it inherit.
        const bare = execFileSync(exe, [], { encoding: 'utf8', windowsHide: true })
        console.info(`uncontained: ${bare.trim().split(/\r?\n/).join(' ')}`)
        const result = await broker.run({ ...s, file: exe, args: [] }, { timeoutMs: 60_000 })
        const lines: Record<string, string> = {}
        for (const line of result.stdout.split(/\r?\n/)) {
          const m = /^([a-z-]+)=(.*)$/.exec(line.trim())
          if (m) lines[m[1] as string] = m[2] as string
        }
        console.info(`${profile}: ${JSON.stringify(lines)}`)
        expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0)
        expect(lines['desktop'], 'a desktop the launcher made').toMatch(/^nx-[0-9a-f]{16}$/)
        expect(lines['create-desktop'], 'no desktop is made from inside (and so none is switched to)').toBe('False')
        // The sandbox account has no entry on the desktop the user sees: it cannot open it, so it cannot read the
        // screen. RESTRICTED runs as the user, to whom that desktop belongs: it can, and the profile says so.
        if (profile === 'ISOLATED') {
          expect(lines['open-input-desktop'], "the desktop the user sees is not opened: its screen is not the command's to read").toBe('False')
          expect(lines['open-default-desktop']).toBe('False')
        } else console.info(`RESTRICTED can open the user's desktop: ${lines['open-default-desktop']} (stated limit of the profile)`)
        // What it inherited: its standard handles, and what Windows gives every process (its window station and
        // desktop). No file, and fewer handles than the same program started bare by this process.
        const kinds = (lines['inherited-kinds'] ?? '').split(',').filter((k) => k !== '')
        const bareCount = Number(/inherited-handles=(\d+)/.exec(bare)?.[1] ?? '0')
        expect(kinds.filter((k) => k === '1'), 'no file handle of the runtime').toEqual([])
        expect(kinds.filter((k) => k === '3').length, 'pipes: the three standard ones, and at most one of its own making').toBeLessThanOrEqual(4)
        expect(kinds.length).toBeLessThanOrEqual(6)
        expect(kinds.length, `bare: ${bareCount}`).toBeLessThan(bareCount)
      }, 120_000)

      it("gives the agent's shell a wrapped command that runs the text as written, bash and PowerShell", async () => {
        const s = session(profile, 'shell')
        for (const [shell, command, expected] of [
          ['bash', `echo "a b" 'c d' | tr a-z A-Z && echo "exit:$?" > out.txt && cat out.txt`, 'A B C D'],
          ['powershell', `Write-Output ("x" + "y"); "second line" | Set-Content out2.txt; Get-Content out2.txt`, 'xy'],
        ] as const) {
          const wrapped = await broker.containShell({ ...s, cwd: s.worktree, shell, command })
          if (!wrapped.ok) throw new Error(wrapped.reason)
          let out: string
          try {
            out = execFileSync(wrapped.file, wrapped.args, { encoding: 'utf8', windowsHide: true, timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] })
          } catch (e) {
            const err = e as { status?: number; stdout?: string; stderr?: string }
            throw new Error(`${shell} failed with ${err.status}: ${err.stdout ?? ''} ${err.stderr ?? ''}`, { cause: e })
          }
          expect(out, `${shell}: ${out}`).toContain(expected)
        }
        expect(readFileSync(join(s.worktree, 'out.txt'), 'utf8')).toContain('exit:0')
        expect(readFileSync(join(s.worktree, 'out2.txt'), 'utf8')).toContain('second line')
      })
    })
  }

  describe('what RESTRICTED does not stop, stated as a test so that nobody claims otherwise', () => {
    it('reads a file of the user that nobody protected, and reaches the network', async () => {
      const r = await probe('RESTRICTED', 'gap', `${ATTEMPT}
attempt('user-read', () => fs.readFileSync(path.join(process.env.PROBE_USER_DIR, 'notes.txt'), 'utf8'));
const http = require('http'); http.get('http://127.0.0.1:' + process.env.PROBE_PORT + '/', (res) => { console.log('loopback=OK:' + res.statusCode); process.exit(0); }).on('error', (e) => { console.log('loopback=DENIED:' + e.code); process.exit(0); });
`)
      expect(r.lines['user-read'], r.raw).toBe(`OK:${SENTINEL}-user`)
      expect(r.lines['loopback']).toBe('OK:200')
    })
  })

  const isolated = account ? describe : describe.skip
  isolated('what only ISOLATED stops', () => {
    it('runs as another account at low integrity', async () => {
      const who = await broker.run({ ...session('ISOLATED', 'whoami'), file: WHOAMI, args: [] }, { timeoutMs: 30_000 })
      const groups = await broker.run({ ...session('ISOLATED', 'whoami'), file: WHOAMI, args: ['/groups', '/fo', 'csv', '/nh'] }, { timeoutMs: 30_000 })
      const result = { stdout: `${who.stdout}\n${groups.stdout}`, stderr: `${who.stderr}${groups.stderr}` }
      expect(result.stdout.toLowerCase(), result.stderr).toContain((account?.account ?? '').toLowerCase())
      expect(result.stdout.toLowerCase()).not.toContain(`\\${(process.env['USERNAME'] ?? '').toLowerCase()}\r`)
      expect(result.stdout).toContain('S-1-16-4096')
    })

    it("cannot read or list anything in the user's profile, protected or not", async () => {
      const r = await probe('ISOLATED', 'profile', `${ATTEMPT}
attempt('profile-file', () => fs.readFileSync(path.join(process.env.PROBE_PROFILE_DIR, 'secret.txt'), 'utf8'));
attempt('profile-list', () => fs.readdirSync(process.env.PROBE_PROFILE_DIR).join(','));
attempt('home-list', () => fs.readdirSync(${JSON.stringify(homedir())}).length);
attempt('claude-list', () => fs.readdirSync(path.join(${JSON.stringify(homedir())}, '.claude')).length);
attempt('ssh-list', () => fs.readdirSync(path.join(${JSON.stringify(homedir())}, '.ssh')).length);
attempt('appdata-list', () => fs.readdirSync(${JSON.stringify(process.env['APPDATA'] ?? '')}).length);
attempt('project-file', () => fs.readFileSync(${JSON.stringify(join(process.cwd(), 'package.json'))}, 'utf8').length);
attempt('user-dir', () => fs.readFileSync(path.join(process.env.PROBE_USER_DIR, 'notes.txt'), 'utf8'));
`)
      for (const key of ['profile-file', 'profile-list', 'home-list', 'claude-list', 'ssh-list', 'appdata-list', 'project-file', 'user-dir']) expect(r.lines[key], `${key}: ${r.raw}`).toMatch(/^DENIED:/)
      expect(r.raw).not.toContain(SENTINEL)
    })

    it('has no route to the Internet: TCP, HTTP, DNS', async () => {
      const r = await probe('ISOLATED', 'network', `
const net = require('net'); const dns = require('dns'); const http = require('http');
const results = {}; let pending = 5;
function done(name, value) { if (results[name]) return; results[name] = value; console.log(name + '=' + value); if (--pending === 0) process.exit(0); }
const s = net.connect({ host: '1.1.1.1', port: 443, timeout: 5000 }); s.on('connect', () => done('tcp', 'REACHED')); s.on('error', (e) => done('tcp', 'DENIED:' + e.code)); s.on('timeout', () => { s.destroy(); done('tcp', 'DENIED:timeout'); });
const h = http.get({ host: '93.184.216.34', port: 80, path: '/', timeout: 5000 }, () => done('http', 'REACHED')); h.on('error', (e) => done('http', 'DENIED:' + e.code)); h.on('timeout', () => { h.destroy(); done('http', 'DENIED:timeout'); });
dns.resolve4('example.com', (e, a) => done('dns', e ? 'DENIED:' + e.code : 'REACHED'));
// The same name through Windows' own resolver: the question is then asked by the DNS Client service, not by this process.
dns.lookup('example.com', (e, a) => done('lookup', e ? 'DENIED:' + e.code : 'ANSWERED'));
// A real DNS question over UDP: sending always succeeds locally, so what counts is whether an answer comes back.
const q = Buffer.from('abcd01000001000000000000076578616d706c6503636f6d0000010001', 'hex'); const u = require('dgram').createSocket('udp4'); u.on('message', () => done('udp', 'REACHED')); u.on('error', (e) => done('udp', 'DENIED:' + e.code)); u.send(q, 53, '8.8.8.8', (e) => { if (e) done('udp', 'DENIED:' + e.code); });
setTimeout(() => { for (const n of ['tcp', 'http', 'dns', 'udp', 'lookup']) done(n, 'DENIED:timeout'); }, 12000);
`)
      expect(r.lines['tcp'], r.raw).toMatch(/^DENIED:/)
      expect(r.lines['http']).toMatch(/^DENIED:/)
      expect(r.lines['dns']).toMatch(/^DENIED:/)
      expect(r.lines['udp']).toMatch(/^DENIED:/)
      // Windows' own resolver asks through the DNS Client service, which no firewall rule for the account covers.
      // In the AppContainer the service answers nothing for it: this was open until the AppContainer (0.8).
      expect(r.lines['lookup'], r.raw).toMatch(/^DENIED:/)
    }, 60_000)

    it('gets no name looked up and is not shown the cache of names, whichever way it asks', async () => {
      const sys = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32')
      const ps = join(sys, 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      const name = 'dns.msftncsi.com'
      // The same questions outside the containment, so that a refusal inside is not an empty network outside.
      const outside = execFileSync(join(sys, 'ipconfig.exe'), ['/displaydns'], { encoding: 'latin1', windowsHide: true }).split(/\r?\n/).filter((l) => l.trim() !== '').length
      const r = await probe('ISOLATED', 'names', `
const cp = require('child_process'); const dns = require('dns');
function run(name, file, args) { let out = ''; try { out = cp.execFileSync(file, args, { encoding: 'latin1', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000 }); } catch (e) { out = String(e.stdout || '') + String(e.stderr || ''); } return out; }
const address = /\\b\\d{1,3}(\\.\\d{1,3}){3}\\b/;
const cache = run('cache', ${JSON.stringify(join(sys, 'ipconfig.exe'))}, ['/displaydns']);
console.log('cache-lines=' + cache.split(/\\r?\\n/).filter((l) => l.trim() !== '').length);
console.log('getaddrinfo=' + (address.test(run('ping', ${JSON.stringify(join(sys, 'PING.EXE'))}, ['-4', '-n', '1', '-w', '200', '${name}'])) ? 'ANSWERED' : 'DENIED'));
console.log('dotnet=' + (address.test(run('dotnet', ${JSON.stringify(ps)}, ['-NoProfile', '-NonInteractive', '-Command', "try { ([Net.Dns]::GetHostAddresses('${name}') | ForEach-Object { $_.ToString() }) -join ',' } catch { 'FAILED' }"])) ? 'ANSWERED' : 'DENIED'));
console.log('dnsquery=' + (address.test(run('resolve', ${JSON.stringify(ps)}, ['-NoProfile', '-NonInteractive', '-Command', "try { (Resolve-DnsName -Name '${name}' -Type A -ErrorAction Stop | ForEach-Object { $_.IPAddress }) -join ',' } catch { 'FAILED' }"])) ? 'ANSWERED' : 'DENIED'));
const ns = run('nslookup', ${JSON.stringify(join(sys, 'nslookup.exe'))}, ['-timeout=2', '-retry=1', '${name}']); const at = ns.toLowerCase().lastIndexOf('${name}');
console.log('nslookup=' + (at >= 0 && address.test(ns.slice(at)) ? 'ANSWERED' : 'DENIED'));
console.log('curl-name=' + (run('curl', ${JSON.stringify(join(sys, 'curl.exe'))}, ['-s', '-m', '5', '-o', 'NUL', '-w', '%{http_code}', 'http://${name}/']).trim() === '000' ? 'DENIED' : 'ANSWERED'));
dns.lookup('${name}', (e) => { console.log('node-lookup=' + (e ? 'DENIED:' + e.code : 'ANSWERED')); dns.lookup('fresh-' + Date.now() + '.example.com', (e2) => { console.log('node-fresh=' + (e2 ? 'DENIED:' + e2.code : 'ANSWERED')); process.exit(0); }); });
`)
      console.info(`ISOLATED and names: ${JSON.stringify(r.lines)}; the cache outside has ${outside} lines`)
      for (const way of ['getaddrinfo', 'dotnet', 'dnsquery', 'nslookup', 'curl-name', 'node-lookup', 'node-fresh']) expect(r.lines[way], `${way}: ${r.raw}`).toMatch(/^DENIED/)
      // The refusal is a few lines; a cache is a listing.
      expect(Number(r.lines['cache-lines']), r.raw).toBeLessThanOrEqual(8)
    }, 120_000)

    it("in the user's repository it reads and writes nothing: objects, branches, its own included, and the worktree's entry stay as they were", async () => {
      // A repository's Git directory as NEXUS lets the account into it: laid out by hand, so that every file is known.
      const common = join(SCRATCH, 'grant-repo', '.git')
      const entry = join(common, 'worktrees', 'task')
      const refs = join(common, 'refs', 'heads', 'nexus', 'run1')
      for (const dir of [join(common, 'objects', 'ab'), refs, join(common, 'logs', 'refs', 'heads', 'nexus', 'run1'), entry]) mkdirSync(dir, { recursive: true })
      const files = { object: join(common, 'objects', 'ab', 'existing'), sibling: join(refs, 'sibling'), own: join(refs, 'task'), head: join(entry, 'HEAD'), commondir: join(entry, 'commondir'), index: join(entry, 'index') }
      for (const file of Object.values(files)) writeFileSync(file, 'ORIGINAL')
      await broker.grantGit({ commonDir: common, writable: [entry, join(common, 'objects'), refs, join(common, 'logs', 'refs', 'heads', 'nexus', 'run1'), files.own] })
      try {
        const r = await probe('ISOLATED', 'grant', `${ATTEMPT}
const f = JSON.parse(process.env.PROBE_FILES); const entry = path.dirname(f.head); const objects = path.dirname(f.object); const refs = path.dirname(f.sibling);
attempt('read-object', () => fs.readFileSync(f.object, 'utf8'));
attempt('overwrite-object', () => fs.writeFileSync(f.object, 'CHANGED'));
attempt('delete-object', () => fs.unlinkSync(f.object));
attempt('rename-object', () => fs.renameSync(f.object, f.object + '.gone'));
attempt('add-object', () => { fs.writeFileSync(path.join(objects, 'new-object'), 'new'); return 'added'; });
attempt('replace-own-object', () => { fs.writeFileSync(path.join(objects, 'new-object'), 'again'); fs.unlinkSync(path.join(objects, 'new-object')); return 'own'; });
attempt('overwrite-sibling-branch', () => fs.writeFileSync(f.sibling, 'CHANGED'));
attempt('delete-sibling-branch', () => fs.unlinkSync(f.sibling));
attempt('replace-sibling-branch', () => { fs.writeFileSync(path.join(refs, 'x.lock'), 'CHANGED'); fs.renameSync(path.join(refs, 'x.lock'), f.sibling); });
attempt('write-own-branch', () => { fs.writeFileSync(f.own, 'MOVED'); return 'moved'; });
attempt('overwrite-head', () => fs.writeFileSync(f.head, 'ref: refs/heads/release'));
attempt('delete-head', () => fs.unlinkSync(f.head));
attempt('replace-head', () => { fs.writeFileSync(path.join(entry, 'HEAD.new'), 'ref: refs/heads/release'); fs.renameSync(path.join(entry, 'HEAD.new'), f.head); });
attempt('replace-commondir', () => { fs.writeFileSync(path.join(entry, 'c.new'), 'x'); fs.renameSync(path.join(entry, 'c.new'), f.commondir); });
attempt('replace-config', () => { fs.writeFileSync(path.join(entry, 'cfg.new'), '[core]'); fs.renameSync(path.join(entry, 'cfg.new'), path.join(entry, 'config.worktree')); });
attempt('write-config', () => fs.writeFileSync(path.join(entry, 'config.worktree'), '[core]'));
attempt('stage-through-lock', () => { fs.writeFileSync(path.join(entry, 'index.lock'), 'STAGED'); fs.renameSync(path.join(entry, 'index.lock'), f.index); return 'staged'; });
`, { PROBE_FILES: JSON.stringify(files) })
        console.info(`ISOLATED in a granted repository: ${JSON.stringify(r.lines)}`)
        // The AppContainer reads the repository's Git data and writes nothing there: not an object, not a lock, not
        // its own branch, not its index. (Integrity labels do not bind a process in an AppContainer, so nothing in
        // the user's repository is left for one to write; what stages or commits runs as a command of its own.)
        expect(r.lines['read-object'], r.raw).toBe('OK:ORIGINAL')
        for (const name of ['add-object', 'replace-own-object', 'write-own-branch', 'stage-through-lock', 'overwrite-object', 'delete-object', 'rename-object', 'overwrite-sibling-branch', 'delete-sibling-branch', 'replace-sibling-branch', 'overwrite-head', 'delete-head', 'replace-head', 'replace-commondir', 'replace-config', 'write-config']) expect(r.lines[name], name).toMatch(/^DENIED:/)
        expect(readFileSync(files.own, 'utf8')).toBe('ORIGINAL')
        expect(readFileSync(files.index, 'utf8')).toBe('ORIGINAL')
        expect(readFileSync(files.object, 'utf8')).toBe('ORIGINAL')
        expect(readFileSync(files.sibling, 'utf8')).toBe('ORIGINAL')
        expect(readFileSync(files.head, 'utf8')).toBe('ORIGINAL')
        expect(readFileSync(files.commondir, 'utf8')).toBe('ORIGINAL')
        expect(readFileSync(join(entry, 'config.worktree'), 'utf8')).toBe('')
      } finally {
        await broker.revokeGit(common)
      }
    }, 120_000)

    it('reaches the loopback, which is where its proxy is', async () => {
      const before = localHits
      const r = await probe('ISOLATED', 'loopback', `const http = require('http'); http.get('http://127.0.0.1:' + process.env.PROBE_PORT + '/', (res) => { console.log('loopback=OK:' + res.statusCode); process.exit(0); }).on('error', (e) => { console.log('loopback=DENIED:' + e.code); process.exit(0); });`)
      expect(r.lines['loopback'], r.raw).toBe('OK:200')
      expect(localHits).toBe(before + 1)
    })

    it("cannot use the user's credential vault or keys", async () => {
      // cmdkey lists the vault of whoever runs it: for the sandbox account that is its own, empty one.
      const result = await broker.run({ ...session('ISOLATED', 'vault'), file: 'cmd', args: ['/c', 'cmdkey /list'] }, { timeoutMs: 30_000 })
      const mine = execFileSync('cmdkey', ['/list'], { encoding: 'utf8', windowsHide: true })
      const targets = (text: string): number => (text.match(/Target:|Cible\s*:/gi) ?? []).length
      expect(targets(result.stdout)).toBe(0)
      // Meaningful only if the user's own vault has something in it; on a machine where it is empty this says nothing.
      if (targets(mine) === 0) console.warn('The user vault is empty on this machine: the vault assertion is vacuous here.')
    })
  })
})
