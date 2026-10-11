import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { FakeScript } from '@main/modules/agent-runtime/fake-runtime'
// @ts-expect-error a build script, plain JavaScript
import { buildLauncher } from '../../scripts/build-launcher.mjs'
import { createHarness, git, plan, plannedTask, scenarioScript, writeFiles, type Harness } from './harness'

// 0.8: a mission whose commands really run through the launcher. The agents are scripted; what they "run" is
// what the provider's shell tool would be handed: the wrapped command the authorizer returned. The script
// executes that text with Git Bash, as the tool would, so the whole path is the real one: authorizer, broker,
// spec, launcher, job, token. The profile is RESTRICTED, which needs no setup of the machine.

const WINDOWS = process.platform === 'win32'
const d = WINDOWS ? describe : describe.skip
const BASE = resolve('test-results', 'scenario-containment')
const BASH = 'C:\\Program Files\\Git\\bin\\bash.exe'
let launcher = ''

/** What the provider's Bash tool does with the input it is given. */
function runAsBashTool(input: Record<string, unknown>): string {
  try {
    return execFileSync(BASH, ['-c', String(input['command'])], { encoding: 'utf8', windowsHide: true, timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string }
    return `EXIT ${err.status}: ${err.stdout ?? ''}${err.stderr ?? ''}`
  }
}

d('scenario: a mission inside the containment (0.8)', () => {
  let h: Harness
  beforeAll(() => {
    rmSync(BASE, { recursive: true, force: true })
    launcher = buildLauncher(join(BASE, 'native')) as string
  })
  afterEach(async () => h?.dispose())
  afterAll(() => rmSync(BASE, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }))

  it("an agent's shell command is handed to the tool as its contained launch, and Windows holds it to the worktree", async () => {
    const outputs: Record<string, string> = {}
    const inputs: Record<string, string> = {}
    let explicitAllowed: boolean | null = null
    const worker: FakeScript = async (spec, ctx) => {
      const outside = join(h.dir, 'outside-the-worktree.txt')
      // A program the agent wrote: the policy reads it and finds nothing it knows, and Windows is what stops it.
      const escape = `const fs=require('fs');const targets={outside:${JSON.stringify(outside)},repo:${JSON.stringify(join(h.repoDir, 'planted-in-user-repo.txt'))}};for(const [n,t] of Object.entries(targets)){try{fs.writeFileSync(t,'planted');console.log(n+':ESCAPED')}catch(e){console.log(n+':REFUSED:'+e.code)}}`
      await writeFiles(spec, ctx, { 'escape.cjs': escape })
      const commands: Record<string, string> = {
        inside: 'echo built > made-by-agent.txt && cat made-by-agent.txt',
        script: 'node escape.cjs',
        env: 'echo "home=$HOME"; env | grep -ci -E "anthropic|github_token|nexus_data" || true',
      }
      for (const [name, command] of Object.entries(commands)) {
        await ctx.useTool('Bash', { command, timeout: 60000 }, async (effective) => {
          inputs[name] = String(effective['command'])
          outputs[name] = runAsBashTool(effective)
          return outputs[name]
        })
      }
      // The same write, spelled out: the policy sees the path and it never runs. It is a boundary, asked once.
      explicitAllowed = await ctx.useTool('Bash', { command: `echo planted > "${outside.replace(/\\/g, '/')}"` }, async (effective) => runAsBashTool(effective))
      await writeFiles(spec, ctx)
      await ctx.completeTurn({ text: 'done' })
    }
    h = await createHarness({ script: scenarioScript({ plan: plan([plannedTask('alpha')]), worker }), autonomy: { profile: 'AUTONOMOUS_PROJECT' }, containment: { profile: 'RESTRICTED', launcher }, baseDir: BASE })
    const run = await h.startRun()
    expect((await h.waitForState(run.id, ['completed', 'failed', 'paused'])).state).toBe('completed')

    const refusals = h.eventsOfType(run.id, 'agent.tool.denied').map((e) => JSON.stringify(e.payload).slice(0, 300))
    // The tool never saw the agent's text: it was given the launcher and a spec.
    for (const name of ['inside', 'script', 'env']) {
      expect(inputs[name], `${name}: ${refusals.join(' | ')}`).toMatch(/nexus-launch\.exe' --spec '.*\.spec'$/)
      expect(inputs[name]).not.toContain('escape')
    }
    expect(outputs['inside']).toContain('built')
    expect(outputs['script']).toContain('outside:REFUSED')
    expect(outputs['script']).toContain('repo:REFUSED')
    expect(existsSync(join(h.dir, 'outside-the-worktree.txt'))).toBe(false)
    expect(existsSync(join(h.repoDir, 'planted-in-user-repo.txt'))).toBe(false)
    // A home of its own, and none of the user's secrets in the environment.
    expect(outputs['env']).toMatch(/home=.*sandbox/i)
    expect(outputs['env']?.trim().split(/\r?\n/).pop()).toBe('0')
    // The spelled-out write was refused by the policy and is the one question of this mission.
    expect(explicitAllowed).toBe(false)
    expect(h.autonomy.missionMetrics(run.id).boundaryRequests).toBe(1)
    expect([...h.autonomy.pending(), ...h.autonomy.recent()].map((r) => r.capability)).toEqual(['WRITE_OUTSIDE_PROJECT'])
    expect(h.repos.approvals.listByRun(run.id).filter((a) => a.kind === 'tool')).toEqual([])
  })

  it('an agent commits on its own branch with a contained git, and cannot touch the branches of the user', async () => {
    const outputs: Record<string, string> = {}
    const worker: FakeScript = async (spec, ctx) => {
      const steps: [string, string][] = [
        ['write', 'echo change > agent-file.txt'],
        ['status', 'git status --short'],
        ['commit', 'git add -A && git commit -m "agent commit" 2>&1 && git log --oneline -1'],
      ]
      for (const [name, command] of steps) {
        await ctx.useTool('Bash', { command }, async (effective) => {
          outputs[name] = runAsBashTool(effective)
          return outputs[name]
        })
      }
      // These are refused by the policy before anything runs: each is a boundary, and one question each.
      for (const [name, command] of [['delete-main', 'git branch -D main'], ['move-main', 'git update-ref refs/heads/main HEAD'], ['hooks', 'git config core.hooksPath ./hooks']] as const) {
        const allowed = await ctx.useTool('Bash', { command }, async (effective) => runAsBashTool(effective))
        outputs[name] = allowed ? 'RAN' : 'REFUSED'
      }
      await ctx.completeTurn({ text: 'done' })
    }
    h = await createHarness({ script: scenarioScript({ plan: plan([plannedTask('alpha')]), worker }), autonomy: { profile: 'AUTONOMOUS_PROJECT' }, containment: { profile: 'RESTRICTED', launcher }, baseDir: BASE })
    const mainBefore = await git(h.repoDir, 'rev-parse', 'main')
    const run = await h.startRun()
    expect((await h.waitForState(run.id, ['completed', 'failed', 'paused'])).state).toBe('completed')

    expect(outputs['status']).toContain('agent-file.txt')
    expect(outputs['commit'], outputs['commit']).toContain('agent commit')
    // git's attempt to lock the repository's packed-refs after a commit is refused and is not shown as an error.
    expect(outputs['commit']).not.toMatch(/error:|Permission denied/)
    for (const name of ['delete-main', 'move-main', 'hooks']) expect(outputs[name], name).toBe('REFUSED')
    expect(await git(h.repoDir, 'rev-parse', 'main')).toBe(mainBefore)
    expect(await git(h.repoDir, 'config', '--get', 'core.hooksPath').catch(() => '')).toBe('')
  })

  it("NEXUS's own check command runs inside the containment: a test that tries to write outside is refused by Windows", async () => {
    const check = `const fs=require('fs');const path=require('path');const out=path.join(process.cwd(),'..','..','..','check-escaped.txt');let r='REFUSED';try{fs.writeFileSync(out,'x');r='ESCAPED'}catch(e){}fs.writeFileSync('check-ran.txt',r);console.log('check:'+r+' home='+require('os').homedir());`
    h = await createHarness({
      script: scenarioScript({ plan: plan([plannedTask('alpha')]) }),
      files: { 'check.cjs': check },
      commands: { test: 'node check.cjs' },
      autonomy: { profile: 'AUTONOMOUS_PROJECT' },
      containment: { profile: 'RESTRICTED', launcher },
      baseDir: BASE,
    })
    const run = await h.startRun()
    expect((await h.waitForState(run.id, ['completed', 'failed', 'paused'])).state).toBe('completed')
    const verification = h.repos.verifications.listByRun(run.id).find((v) => v.commands.some((c) => c.command === 'node check.cjs'))
    const result = verification?.commands.find((c) => c.command === 'node check.cjs')
    expect(result?.exitCode, JSON.stringify(result)).toBe(0)
    expect(result?.output).toContain('check:REFUSED')
    expect(result?.output).toMatch(/home=.*sandbox/i)
    expect(existsSync(join(h.worktreesDir, 'check-escaped.txt'))).toBe(false)
    expect(readFileSync(join(h.dir, 'nexus.db')).length).toBeGreaterThan(0)
  })

  it('with the launcher gone, nothing is run: no fallback to an uncontained command', async () => {
    const ran: string[] = []
    const allowed: boolean[] = []
    const worker: FakeScript = async (spec, ctx) => {
      allowed.push(await ctx.useTool('Bash', { command: 'echo should-not-run > leaked.txt' }, async (effective) => (ran.push(String(effective['command'])), 'ran')))
      await writeFiles(spec, ctx)
      await ctx.completeTurn({ text: 'done' })
    }
    h = await createHarness({ script: scenarioScript({ plan: plan([plannedTask('alpha')]), worker }), autonomy: { profile: 'AUTONOMOUS_PROJECT' }, containment: { profile: 'RESTRICTED', launcher: join(BASE, 'no-such', 'nexus-launch.exe') }, baseDir: BASE })
    const run = await h.startRun()
    await h.waitForState(run.id, ['completed', 'failed', 'paused'])
    expect(allowed).toEqual([false])
    expect(ran).toEqual([])
    const denied = h.eventsOfType(run.id, 'agent.tool.denied')
    expect(JSON.stringify(denied[0]?.payload)).toContain('Nothing is run outside the containment')
  })
})
