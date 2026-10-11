import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { FakeScript } from '@main/modules/agent-runtime/fake-runtime'
import { readSandboxAccount } from '@main/modules/isolation/sandbox-account'
// @ts-expect-error a build script, plain JavaScript
import { buildLauncher } from '../../scripts/build-launcher.mjs'
import { createHarness, git, plan, plannedTask, scenarioScript, writeFiles, type Harness } from './harness'

// 0.8, ISOLATED: git inside a mission whose commands run as the sandbox account. The repository is the user's,
// in the user's profile, where that account cannot go; it is given what git needs there and nothing more. The
// commands are the ones a real session ran when this was found broken (the 0.8 acceptance of 2026-10-11): a
// commit, git mixed with other programs, git in PowerShell, a reviewer's inspection.
//
// Runs only where the sandbox account is set up (node scripts/sandbox-setup.mjs).

const account = process.platform === 'win32' ? readSandboxAccount() : null
const d = account ? describe : describe.skip
const BASE = resolve('test-results', 'scenario-isolated-git')
const BASH = 'C:\\Program Files\\Git\\bin\\bash.exe'
const POWERSHELL = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
let launcher = ''

function runAs(tool: 'Bash' | 'PowerShell', input: Record<string, unknown>): string {
  try {
    const [file, args] = tool === 'Bash' ? [BASH, ['-c', String(input['command'])]] : [POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', String(input['command'])]]
    return execFileSync(file, args, { encoding: 'utf8', windowsHide: true, timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string }
    return `EXIT ${err.status}: ${err.stdout ?? ''}${err.stderr ?? ''}`
  }
}

const PLANT = `
const fs = require('fs'); const path = require('path'); const cp = require('child_process');
const say = (name, fn) => { try { fn(); console.log(name + ':PLANTED') } catch (e) { console.log(name + ':REFUSED:' + e.code) } };
const marker = path.join(process.cwd(), 'ran-as-the-user.txt');
const hook = '#!/bin/sh\\nwhoami > "' + marker.split(path.sep).join('/') + '"\\n';
// 1. A hook in the directory the hardened git is told to look in, if contained code can reach it.
say('hooks', () => { const dir = path.join(process.env.TMP, 'no-hooks'); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'pre-commit'), hook) });
// 2. A user-level configuration in the home the contained command has.
say('home', () => fs.writeFileSync(path.join(process.env.HOME, '.gitconfig'), '[core]\\n\\thooksPath = ' + path.join(process.env.TMP, 'no-hooks').split(path.sep).join('/') + '\\n[alias]\\n\\tst = !whoami > ran-as-the-user.txt\\n'));
// 3. The files of the worktree's entry that say where the repository is and what configuration applies.
const entry = cp.execFileSync('git', ['rev-parse', '--git-dir']).toString().trim();
for (const name of ['commondir', 'gitdir', 'config.worktree']) say(name, () => fs.writeFileSync(path.join(entry, name), name === 'config.worktree' ? '[core]\\n\\thooksPath = /x\\n' : 'C:/elsewhere\\n'));
// 4. A sibling task's branch, and the mission's integration branch.
const common = cp.execFileSync('git', ['rev-parse', '--git-common-dir']).toString().trim();
const own = cp.execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD']).toString().trim();
const dir = path.join(common, 'refs', 'heads', path.dirname(own));
for (const name of fs.readdirSync(dir)) if (name !== path.basename(own)) say('sibling-' + (name === 'integration' ? 'integration' : 'task'), () => fs.writeFileSync(path.join(dir, name), '0000000000000000000000000000000000000000\\n'));
// 6. A repository of its own inside the worktree, whose configuration runs the marker as a filter, a file monitor and a hook.
say('nested', () => {
  const sub = path.join(process.cwd(), 'nested'); fs.mkdirSync(path.join(sub, 'hooks'), { recursive: true });
  const g = (...a) => cp.execFileSync('git', a, { cwd: sub, stdio: 'pipe' });
  g('init', '-q', '-b', 'main', '.'); g('config', 'user.name', 'x'); g('config', 'user.email', 'x@x');
  fs.writeFileSync(path.join(sub, 's.txt'), 's\\n'); fs.writeFileSync(path.join(sub, '.gitattributes'), '* filter=evil\\n'); g('add', '-A'); g('commit', '-q', '-m', 'sub');
  const run = "sh -c 'whoami > \\"" + marker.split(path.sep).join('/') + "\\"; cat'";
  g('config', 'filter.evil.clean', run); g('config', 'core.fsmonitor', run); g('config', 'core.hooksPath', path.join(sub, 'hooks').split(path.sep).join('/'));
  for (const h of ['pre-commit', 'post-index-change', 'reference-transaction']) fs.writeFileSync(path.join(sub, 'hooks', h), hook);
  fs.writeFileSync(path.join(sub, 's.txt'), 's changed\\n');
});
// 7. The places git takes whole sets of objects from on trust: a pack, another object store, a commit-graph.
for (const name of ['pack/pack-0000000000000000000000000000000000000000.idx', 'info/alternates', 'info/commit-graph']) say('objects-' + name.split('/')[0] + '-' + name.split('/')[1].split('-')[0].split('.')[0], () => fs.writeFileSync(path.join(common, 'objects', name), 'x'));
// 5. The worktree's pointer, turned to a Git directory of the task's own making, with a hook of its own.
say('pointer', () => { fs.mkdirSync('evilgit/hooks', { recursive: true }); fs.writeFileSync('evilgit/hooks/pre-commit', hook); fs.writeFileSync('evilgit/HEAD', 'ref: refs/heads/main\\n'); fs.writeFileSync('.git', 'gitdir: ' + path.join(process.cwd(), 'evilgit').split(path.sep).join('/') + '\\n') });
`

d('scenario: git in a mission under the ISOLATED profile (0.8)', () => {
  let h: Harness
  beforeAll(() => {
    rmSync(BASE, { recursive: true, force: true })
    launcher = buildLauncher(join(BASE, 'native')) as string
  })
  afterEach(async () => h?.dispose())
  afterAll(() => rmSync(BASE, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }))

  it('git works in every kind of command, as the sandbox account, and only on what is the task own', async () => {
    const out: Record<string, string> = {}
    const refused: Record<string, boolean> = {}
    const worker: FakeScript = async (spec, ctx) => {
      await writeFiles(spec, ctx, { 'attempt.cjs': "const fs=require('fs');const cp=require('child_process');const common=cp.execFileSync('git',['rev-parse','--git-common-dir']).toString().trim();try{fs.writeFileSync(common+'/'+process.argv[2],'planted');console.log('WROTE')}catch(e){console.log('REFUSED:'+e.code)}", 'probe.cjs': "const cp=require('child_process');console.log('from-node:'+cp.execFileSync('git',['rev-parse','--abbrev-ref','HEAD']).toString().trim())" })
      const bash: [string, string][] = [
        ['who', 'whoami'],
        ['status', 'git status --short'],
        ['commit', 'git add -A 2>&1 && git commit -q -m "agent commit" 2>&1 && git status --short && git log --oneline -1'],
        ['mixed', 'git log --oneline | head -3; git status --short; echo mixed-done'],
        ['with-node', 'node probe.cjs && git rev-parse HEAD'],
        ['diff', 'echo more >> agent-file.txt && git diff --stat'],
        ['show', 'git show --stat HEAD'],
        ['pointer', 'cat .git'],
        ['buried-commit', 'echo again >> agent-file.txt && git add -A && git commit -q -m "buried" 2>&1; echo rc=$?'],
        ['after-buried', 'git log --oneline -1; git status --short'],
        // What is not the task's own: the user's branch, a new shared ref, the configuration, the hooks.
        ['other-branch', 'node attempt.cjs refs/heads/main'],
        ['config', 'node attempt.cjs config'],
        ['hook', 'node attempt.cjs hooks/pre-commit'],
      ]
      await writeFiles(spec, ctx, { 'agent-file.txt': 'change\n' })
      for (const [name, command] of bash) {
        const allowed = await ctx.useTool('Bash', { command }, async (effective) => {
          out[name] = runAs('Bash', effective)
          return out[name]
        })
        refused[name] = !allowed
      }
      await ctx.useTool('PowerShell', { command: 'git status --short; git log --oneline -1' }, async (effective) => {
        out['powershell'] = runAs('PowerShell', effective)
        return out['powershell']
      })
      await ctx.useTool('PowerShell', { command: 'Get-ChildItem -Name | Select-Object -First 1; git log --oneline -1' }, async (effective) => {
        out['powershell-mixed'] = runAs('PowerShell', effective)
        return out['powershell-mixed']
      })
      await ctx.useTool('Bash', { command: 'git checkout -q -- agent-file.txt; git status --short' }, async (effective) => runAs('Bash', effective))
      // Contained code arms everything it can reach; then git runs for a command that is git alone, as the user.
      await writeFiles(spec, ctx, { 'plant.cjs': PLANT })
      for (const [name, command] of [
        ['plant', 'node plant.cjs'],
        ['armed-commit', 'git add -A 2>&1; git commit -q -m "after the plant" 2>&1; git log --oneline -1; git status --short'],
      ] as const) {
        await ctx.useTool('Bash', { command }, async (effective) => {
          out[name] = runAs('Bash', effective)
          return out[name]
        })
      }
      await ctx.completeTurn({ text: 'done' })
    }
    h = await createHarness({ script: scenarioScript({ plan: plan([plannedTask('alpha')]), worker }), autonomy: { profile: 'AUTONOMOUS_PROJECT' }, containment: { profile: 'ISOLATED', launcher }, baseDir: BASE })
    const mainBefore = await git(h.repoDir, 'rev-parse', 'main')
    const run = await h.startRun()
    const end = await h.waitForState(run.id, ['completed', 'failed', 'paused'])
    const all = JSON.stringify({ out, refused }, null, 1)

    // A command that is more than git runs as the sandbox account.
    expect(out['who']?.toLowerCase(), all).toContain((account as { account: string }).account.toLowerCase())
    expect(out['status'], all).toContain('agent-file.txt')
    // The commit: made, the tree clean after it, and git said nothing went wrong.
    expect(out['commit'], all).toContain('agent commit')
    expect(out['commit']).not.toMatch(/error:|fatal:|Permission denied|EXIT/)
    expect(out['mixed'], all).toContain('agent commit')
    expect(out['mixed']).toContain('mixed-done')
    expect(out['mixed']).not.toMatch(/fatal:|not a git repository/)
    expect(out['with-node'], all).toMatch(/from-node:nexus\//)
    expect(out['diff'], all).toContain('agent-file.txt')
    expect(out['diff']).not.toMatch(/external diff died|fatal:/)
    expect(out['show'], all).toContain('agent commit')
    // A commit inside a larger command cannot be made as the sandbox account: it is stopped before git, and says what to do.
    expect(out['buried-commit'], all).toContain('runs only as a command of its own')
    expect(out['buried-commit']).toContain('rc=128')
    expect(out['after-buried'], all).toContain('agent commit')
    expect(out['after-buried']).toContain('agent-file.txt')
    expect(out['powershell'], all).toContain('agent commit')
    expect(out['powershell']).not.toMatch(/fatal:|not a git repository/)
    // Reading the worktree's own `.git` file is reading a file of the worktree: it is no question for the user.
    expect(refused['pointer'], all).toBe(false)
    expect(out['pointer']).toContain('gitdir:')
    expect(out['powershell-mixed'], all).toContain('agent commit')
    // What is not the task's own is refused by Windows.
    for (const name of ['other-branch', 'config', 'hook']) expect(out[name], `${name}: ${all}`).toMatch(/REFUSED:(EPERM|EACCES)/)
    expect(await git(h.repoDir, 'rev-parse', 'main')).toBe(mainBefore)
    expect(existsSync(join(h.repoDir, '.git', 'hooks', 'pre-commit'))).toBe(false)
    // What contained code planted for a git that runs as the user. Its own temporary directory and home are
    // its own to write, and are not where that git looks; the entry's three files and the branches of others
    // are refused by Windows; the pointer is the worktree's own file, and that git does not read it.
    for (const name of ['commondir', 'gitdir', 'config.worktree', 'sibling-integration', 'objects-pack-pack', 'objects-info-alternates', 'objects-info-commit']) expect(out['plant'], `${name}: ${all}`).toMatch(new RegExp(`${name}:REFUSED:(EPERM|EACCES)`))
    // (Whether the pointer could be rewritten is not a control: where it could, the git that runs as the user is told its Git directory by NEXUS.)
    expect(out['plant'], all).toContain('hooks:PLANTED')
    expect(out['plant'], all).toContain('nested:PLANTED')
    expect(out['plant'], all).toContain('home:PLANTED')
    // The commit after the plant was made in the real repository, on the task's branch, and no hook ran.
    expect(out['armed-commit'], all).toContain('after the plant')
    expect(out['armed-commit']).not.toMatch(/fatal:|error:/)
    const ranMarker = join(h.worktreesDir, run.id.slice(0, 8), 'alpha', 'ran-as-the-user.txt')
    // If anything planted ran at all, it ran as the sandbox account (a git of the task's own, inside the containment), never as the user.
    const ranAs = existsSync(ranMarker) ? readFileSync(ranMarker, 'utf8').trim().toLowerCase() : ''
    expect(ranAs === '' || ranAs.endsWith((account as { account: string }).account.toLowerCase()), `ran as: ${ranAs}
${all}`).toBe(true)
    expect(end.state, all).toBe('completed')
    expect(h.autonomy.missionMetrics(run.id).boundaryRequests, all).toBe(0)
  }, 300_000)
})
