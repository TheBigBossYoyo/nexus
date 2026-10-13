import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ExecutionBroker, projectCapabilityName, sessionCapabilityName, type ContainSession } from '@main/modules/isolation/execution-broker'
import { Launcher, renderSpec } from '@main/modules/isolation/launcher'
import { readSandboxAccount } from '@main/modules/isolation/sandbox-account'
import { mirrorTools } from '@main/modules/isolation/tools'
// @ts-expect-error a build script, plain JavaScript
import { buildLauncher } from '../../../scripts/build-launcher.mjs'

// 0.9 (review W2-F1, ledger A1): two sessions of the isolated profile at the same time, each hostile to the
// other. They are the same Windows account in the same AppContainer; what keeps them apart is a capability of
// each session's own. Harmless: marker files and one attempt to end a process that only sleeps.
const account = process.platform === 'win32' ? readSandboxAccount() : null
const d = account ? describe : describe.skip
const SCRATCH = resolve('test-results', 'cross-session-tests')
let broker: ExecutionBroker
let launcher: Launcher

function session(project: string, name: string): ContainSession {
  const worktree = join((account as { root: string }).root, 'worktrees', 'cross-session-tests', project, name)
  mkdirSync(worktree, { recursive: true })
  return { profile: 'ISOLATED', projectId: project, sessionKey: name, worktree }
}

const lines = (text: string): Record<string, string> => Object.fromEntries(text.split(/\r?\n/).flatMap((line) => { const m = /^([a-z0-9-]+)=(.*)$/.exec(line.trim()); return m ? [[m[1] as string, m[2] as string]] : [] }))
const ATTEMPT = "const fs = require('fs'); const path = require('path'); function attempt(name, fn) { try { console.log(name + '=OK:' + String(fn()).slice(0, 60)) } catch (e) { console.log(name + '=DENIED:' + (e.code || e.message)) } }\n"

d('two isolated sessions at once (0.9)', () => {
  beforeAll(async () => {
    rmSync(SCRATCH, { recursive: true, force: true })
    launcher = new Launcher({ executable: buildLauncher(join(SCRATCH, 'native')) as string, specDir: join(SCRATCH, 'specs') })
    const state = mirrorTools({ sandboxRoot: (account as { root: string }).root, userProfile: homedir(), path: process.env['PATH'] ?? '', names: ['node'] })
    broker = new ExecutionBroker({ launcher, sandboxDir: join(SCRATCH, 'sandbox'), account: () => account, baseEnv: () => process.env, toolPath: (profile, path) => (profile === 'ISOLATED' ? state.path : path), limits: { maxProcesses: 32 } })
    await broker.verify('ISOLATED')
  }, 240_000)

  afterAll(() => {
    rmSync(SCRATCH, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    if (account) {
      rmSync(join(account.root, 'worktrees', 'cross-session-tests'), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
      broker.sweep()
    }
  })

  it('each session has a capability of its own, the same when it is resumed, and its project has another', () => {
    const a = session('project-a', 'one')
    const b = session('project-a', 'two')
    const c = session('project-b', 'one')
    expect(broker.capabilitiesOf(a)).toEqual([sessionCapabilityName(join(SCRATCH, 'sandbox'), a), projectCapabilityName(join(SCRATCH, 'sandbox'), 'project-a')])
    expect(broker.capabilitiesOf(a)).toEqual(broker.capabilitiesOf({ ...a }))
    expect(broker.capabilitiesOf(a)[0]).not.toBe(broker.capabilitiesOf(b)[0])
    expect(broker.capabilitiesOf(a)[1]).toBe(broker.capabilitiesOf(b)[1])
    expect(broker.capabilitiesOf(a)[1]).not.toBe(broker.capabilitiesOf(c)[1])
    expect(broker.capabilitiesOf({ ...a, profile: 'RESTRICTED' })).toEqual([])
    for (const name of broker.capabilitiesOf(a)) expect(name).toMatch(/^NexusSandbox\.[SP]\.[0-9a-f]{16}$/)
  })

  it('a spec takes capabilities of NEXUS\'s own making only, and only with an AppContainer', () => {
    const base = { profile: 'ISOLATED' as const, cwd: SCRATCH, commandLine: 'cmd /c echo x', env: {}, sandbox: { credentialPath: 'c', stage2Path: 's', stage2Dir: 'd' }, appContainer: 'NexusSandbox.Contained.1' }
    expect(renderSpec({ ...base, capabilities: ['NexusSandbox.S.0123456789abcdef'] })).toContain('capability=NexusSandbox.S.0123456789abcdef')
    for (const bad of ['internetClient', 'privateNetworkClientServer', 'NexusSandbox.Contained.1', 'nexussandbox.x', 'NexusSandbox.S.a b']) expect(() => renderSpec({ ...base, capabilities: [bad] }), bad).toThrow(/NEXUS's own/)
    expect(() => renderSpec({ ...base, appContainer: undefined as unknown as string, capabilities: ['NexusSandbox.S.0123456789abcdef'] })).toThrow(/AppContainer/)
    expect(() => renderSpec({ profile: 'RESTRICTED', cwd: SCRATCH, commandLine: 'x', env: {}, capabilities: ['NexusSandbox.S.0123456789abcdef'] })).toThrow(/ISOLATED profile only/)
  })

  it("one session cannot write the other's worktree, temporary directory or home, nor end its process; each works in its own; sessions of another project are kept out of a project's cache", async () => {
    const victim = session('project-a', 'victim')
    const attacker = session('project-a', 'attacker')
    const stranger = session('project-b', 'stranger')
    const victimRoots = await broker.roots(victim)
    await broker.roots(attacker)
    await broker.roots(stranger)
    writeFileSync(join(victim.worktree, 'work.txt'), 'the victim\'s work')
    writeFileSync(join(victimRoots.cache, 'cached.txt'), 'a package of project a')
    writeFileSync(join(victim.worktree, 'victim.cjs'), "const fs=require('fs');fs.writeFileSync('pid.txt',String(process.pid));setTimeout(()=>{fs.writeFileSync('own.txt','mine');console.log('survived')},9000)")
    const running = broker.run({ ...victim, file: 'node', args: ['victim.cjs'] }, { timeoutMs: 60_000 })
    for (let i = 0; i < 100 && !existsSync(join(victim.worktree, 'pid.txt')); i += 1) await new Promise((r) => setTimeout(r, 100))
    const pid = Number(readFileSync(join(victim.worktree, 'pid.txt'), 'utf8'))
    expect(pid).toBeGreaterThan(0)

    const hostile = (cache: string): string => `${ATTEMPT}
      attempt('kill', () => { process.kill(${pid}); return 'killed' })
      attempt('signal-0', () => { process.kill(${pid}, 0); return 'opened' })
      attempt('write-worktree', () => { fs.writeFileSync(${JSON.stringify(join(victim.worktree, 'planted.txt'))}, 'x'); return 'written' })
      attempt('overwrite-work', () => { fs.writeFileSync(${JSON.stringify(join(victim.worktree, 'work.txt'))}, 'replaced'); return 'written' })
      attempt('delete-work', () => { fs.rmSync(${JSON.stringify(join(victim.worktree, 'work.txt'))}); return 'deleted' })
      attempt('write-temp', () => { fs.writeFileSync(${JSON.stringify(join(victimRoots.temp, 'nx-planted.sh'))}, 'x'); return 'written' })
      attempt('write-home', () => { fs.writeFileSync(${JSON.stringify(join(victimRoots.home, '.npmrc'))}, 'x'); return 'written' })
      attempt('write-cache', () => { fs.writeFileSync(${JSON.stringify(join(cache, 'poison.txt'))}, 'x'); return 'written' })
      attempt('own', () => { fs.writeFileSync('mine.txt', 'x'); return 'written' })`
    writeFileSync(join(attacker.worktree, 'probe.cjs'), hostile(victimRoots.cache))
    writeFileSync(join(stranger.worktree, 'probe.cjs'), hostile(victimRoots.cache))
    const fromSameProject = lines((await broker.run({ ...attacker, file: 'node', args: ['probe.cjs'] }, { timeoutMs: 60_000 })).stdout)
    const fromOtherProject = lines((await broker.run({ ...stranger, file: 'node', args: ['probe.cjs'] }, { timeoutMs: 60_000 })).stdout)
    console.info(`a session against another of its project: ${JSON.stringify(fromSameProject)}`)
    console.info(`a session against one of another project: ${JSON.stringify(fromOtherProject)}`)
    for (const [who, got] of [['same project', fromSameProject], ['other project', fromOtherProject]] as const) {
      for (const key of ['kill', 'signal-0', 'write-worktree', 'overwrite-work', 'delete-work', 'write-temp', 'write-home']) expect(got[key], `${who}: ${key}`).toMatch(/^DENIED:/)
      expect(got['own'], who).toBe('OK:written')
    }
    // The cache is the project's: its own sessions write it, another project's do not.
    expect(fromSameProject['write-cache']).toBe('OK:written')
    expect(fromOtherProject['write-cache']).toMatch(/^DENIED:/)

    const ended = await running
    expect(ended.exitCode, ended.stderr).toBe(0)
    expect(ended.stdout).toContain('survived')
    expect(readFileSync(join(victim.worktree, 'work.txt'), 'utf8')).toBe("the victim's work")
    expect(readFileSync(join(victim.worktree, 'own.txt'), 'utf8')).toBe('mine')
    expect(existsSync(join(victim.worktree, 'planted.txt'))).toBe(false)
    expect(existsSync(join(victimRoots.temp, 'nx-planted.sh'))).toBe(false)
  }, 180_000)

  it('a command leaves no inner spec behind: it is removed as soon as it is read', async () => {
    const s = session('project-a', 'specs')
    const dir = join((account as { root: string }).root, 'specs')
    const before = new Set(existsSync(dir) ? readdirSync(dir) : [])
    const result = await broker.run({ ...s, file: 'cmd', args: ['/c', 'echo', 'done'] }, { timeoutMs: 60_000 })
    expect(result.stdout).toContain('done')
    // The folder is the machine's: other commands running at this moment have a spec in it for the instant between
    // its writing and its reading. What must not be there is a spec that stays: one made since this test began
    // and still there three seconds after it was written.
    await new Promise((r) => setTimeout(r, 3000))
    const stayed = (existsSync(dir) ? readdirSync(dir) : []).filter((name) => {
      if (before.has(name)) return false
      try {
        return Date.now() - statSync(join(dir, name)).mtimeMs > 2500
      } catch {
        return false
      }
    })
    expect(stayed).toEqual([])
  }, 120_000)
})
