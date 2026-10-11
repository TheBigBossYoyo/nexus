import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ApplicationUnderTestManager, type AppOwner } from '@main/modules/browser/app-manager'
import { PlaywrightDirectProvider } from '@main/modules/browser/provider'
import { ExecutionBroker } from '@main/modules/isolation/execution-broker'
import { Launcher } from '@main/modules/isolation/launcher'
// @ts-expect-error a build script, plain JavaScript
import { buildLauncher } from '../../scripts/build-launcher.mjs'

// 0.8 soak: the containment and the application under test, used many times over, must leave nothing behind:
// no process, no listening port, no spec file, no registered endpoint, no growing set of proxies. RESTRICTED
// (needs no setup of the machine), headless. Run with `pnpm stress`; rounds are set by NEXUS_SOAK_ROUNDS.

const provider = new PlaywrightDirectProvider()
const d = process.platform === 'win32' && provider.availability().browser !== null ? describe : describe.skip
const SCRATCH = resolve('test-results', 'isolation-soak')
const ROUNDS = Number(process.env['NEXUS_SOAK_ROUNDS'] ?? 150)
const APP_ROUNDS = Number(process.env['NEXUS_SOAK_APP_ROUNDS'] ?? 20)
let launcher: Launcher
let broker: ExecutionBroker

/** Processes of this soak, by what their command line names: the scratch directory is in every one of them. */
function leftovers(): number {
  const script = "(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'isolation-soak' -and $_.Name -match '^(node|cmd|nexus-launch|bash|msedge)\\.exe$' -and $_.CommandLine -notmatch 'vitest' } | Measure-Object).Count"
  return Number(execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8', windowsHide: true }).trim())
}

d('soak: containment and applications under test (0.8)', () => {
  beforeAll(async () => {
    rmSync(SCRATCH, { recursive: true, force: true })
    mkdirSync(SCRATCH, { recursive: true })
    launcher = new Launcher({ executable: buildLauncher(join(SCRATCH, 'native')) as string, specDir: join(SCRATCH, 'specs') })
    broker = new ExecutionBroker({ launcher, sandboxDir: join(SCRATCH, 'sandbox'), account: () => null, baseEnv: () => process.env, limits: { maxProcesses: 64 } })
    await broker.verify('RESTRICTED')
  }, 120_000)

  afterAll(() => rmSync(SCRATCH, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }))

  it(`${ROUNDS} contained commands, some of which fail, time out or leave children: every one is accounted for and nothing is left`, async () => {
    const worktree = join(SCRATCH, 'worktrees', 'commands')
    mkdirSync(worktree, { recursive: true })
    writeFileSync(join(worktree, 'work.cjs'), "const fs=require('fs');const n=process.argv[2];fs.writeFileSync('out-'+n+'.txt',n);if(n%10===3)process.exit(3);if(n%10===7){require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'}).unref()}if(n%25===9)setInterval(()=>{},1000);else console.log('done '+n)")
    const session = { profile: 'RESTRICTED' as const, projectId: 'soak', sessionKey: 'commands', worktree }
    const outcomes = { ok: 0, failed: 0, timedOut: 0 }
    const started = Date.now()
    for (let i = 0; i < ROUNDS; i += 1) {
      const result = await broker.run({ ...session, file: 'node', args: ['work.cjs', String(i)] }, { timeoutMs: i % 25 === 9 ? 1500 : 30_000 })
      if (i % 25 === 9) {
        expect(result.timedOut || result.exitCode === 124, `round ${i}: ${result.exitCode}`).toBe(true)
        outcomes.timedOut += 1
      } else if (i % 10 === 3) {
        expect(result.exitCode, `round ${i}`).toBe(3)
        outcomes.failed += 1
      } else {
        expect(result.exitCode, `round ${i}: ${result.stderr.slice(0, 200)}`).toBe(0)
        expect(result.stdout).toContain(`done ${i}`)
        outcomes.ok += 1
      }
      expect(existsSync(join(worktree, `out-${i}.txt`))).toBe(true)
    }
    expect(outcomes.ok + outcomes.failed + outcomes.timedOut).toBe(ROUNDS)
    // Nothing a command started outlives it, the detached children included; no spec is left; counters add up.
    await expect.poll(leftovers, { timeout: 20_000 }).toBe(0)
    expect(existsSync(join(SCRATCH, 'specs')) ? readdirSync(join(SCRATCH, 'specs')) : []).toEqual([])
    expect(broker.counters().refused).toBe(0)
    console.info(`soak: ${ROUNDS} contained commands in ${Math.round((Date.now() - started) / 1000)} s (${JSON.stringify(outcomes)})`)
  }, 30 * 60_000)

  it(`${APP_ROUNDS} launches of an application, used and stopped, some ended by crash: no port, process, proxy or endpoint is left`, async () => {
    const apps = new ApplicationUnderTestManager({ broker, browser: provider, profileFor: () => 'RESTRICTED', artifactsDir: join(SCRATCH, 'artifacts') })
    const worktree = join(SCRATCH, 'worktrees', 'app')
    mkdirSync(join(worktree, '.nexus'), { recursive: true })
    writeFileSync(join(worktree, 'server.cjs'), "const http=require('http');let n=0;http.createServer((q,s)=>{if(q.url==='/die'){s.end('x');setTimeout(()=>process.exit(9),20);return}if(q.url==='/inc'){n+=1;s.end(String(n));return}s.setHeader('content-type','text/html');s.end('<title>soak</title><h1>soak</h1><p role=\"status\" id=\"n\">count 0</p><button id=\"b\">Add</button><script>b.onclick=async()=>{n.textContent=\"count \"+await (await fetch(\"/inc\",{method:\"POST\"})).text()}</script>')}).listen(0,'127.0.0.1',function(){console.log('ready on http://127.0.0.1:'+this.address().port+'/')})")
    writeFileSync(join(worktree, '.nexus', 'app.json'), JSON.stringify({ type: 'web', launchCommand: 'node server.cjs', ready: { kind: 'log', pattern: 'ready on' }, startTimeoutSeconds: 60 }))
    const owner: AppOwner = { projectId: 'soak', runId: 'soak-run', taskId: 'soak-task', key: 'soak-run:soak-task', worktree }
    const started = Date.now()
    try {
      for (let i = 0; i < APP_ROUNDS; i += 1) {
        const status = await apps.launch(owner)
        expect(status.state, `round ${i}`).toBe('running')
        const browser = apps.session(owner.key)
        const ref = /\[ref=(\w+)\]/.exec((await browser.find('Add')).matches[0] ?? '')?.[1] as string
        await browser.click(ref)
        await browser.wait({ text: 'count 1' })
        if (i % 5 === 4) {
          // The application dies on its own; the next launch replaces it.
          await browser.navigate(apps.resolveInApp(owner.key, '/die') as string).catch(() => undefined)
          await expect.poll(() => apps.status(owner.key)?.state, { timeout: 15_000 }).toBe('exited')
        } else if (i % 5 !== 2) await apps.stop(owner.key)
        // i % 5 === 2: left running, and launched over.
        expect(apps.registry().length, `round ${i}`).toBeLessThanOrEqual(1)
      }
    } finally {
      await apps.stopAll()
    }
    expect(apps.registry()).toEqual([])
    expect(apps.list().filter((a) => a.state === 'running' || a.state === 'starting')).toEqual([])
    await expect.poll(leftovers, { timeout: 30_000 }).toBe(0)
    expect(existsSync(join(SCRATCH, 'specs')) ? readdirSync(join(SCRATCH, 'specs')) : []).toEqual([])
    console.info(`soak: ${APP_ROUNDS} application launches in ${Math.round((Date.now() - started) / 1000)} s`)
  }, 30 * 60_000)
})
