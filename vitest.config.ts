import { resolve } from 'node:path'
import { configDefaults, defineConfig } from 'vitest/config'

const alias = {
  '@shared': resolve(import.meta.dirname, 'src/shared'),
  '@main': resolve(import.meta.dirname, 'src/main'),
}

/**
 * 0.9.1: run inside NEXUS's own sandbox (a mission of NEXUS on itself in an enrolled checkout: the worktree lies in
 * C:\ProgramData\NexusSandbox), these files cannot work: they test NEXUS's own machinery of the operating system, and
 * there it would be nested in itself. Measured in a contained full run (125 failures in 25 files, all of the
 * environment): Chromium does not start, named pipes cannot be made, a launcher or broker started from inside is
 * refused, git cannot clone or reach a remote, icacls and integrity labels are refused, child processes end with
 * 0xC0000142. They run in every run outside the sandbox. The list is printed at the start of a run that leaves them out.
 */
const SANDBOX_ROOT = `${(process.env['ProgramData'] ?? 'C:\\ProgramData').toLowerCase()}\\nexussandbox\\`
const insideSandbox = process.platform === 'win32' && `${resolve(import.meta.dirname).toLowerCase()}\\`.startsWith(SANDBOX_ROOT)
const NOT_IN_THE_SANDBOX = [
  'tests/integration/arena/audit.test.ts',
  'tests/integration/arena/builtin-cases.test.ts',
  'tests/integration/arena/campaign.test.ts',
  'tests/integration/arena/overnight-arena.test.ts',
  'tests/integration/arena/provisioning.test.ts',
  'tests/integration/browser/app-faults.test.ts',
  'tests/integration/browser/port-owner.test.ts',
  'tests/integration/git/git-safety.test.ts',
  'tests/integration/git/hostile-index.test.ts',
  'tests/integration/git/user-git-script.test.ts',
  'tests/integration/git/worktree-pointer-trust.test.ts',
  'tests/integration/isolation/protect.test.ts',
  'tests/integration/isolation/quiet-commands.test.ts',
  'tests/integration/isolation/sandbox-checks.test.ts',
  'tests/integration/privilege/broker.test.ts',
  'tests/integration/profile/project-profiler.test.ts',
  'tests/integration/research/browser.test.ts',
  'tests/integration/runtime/runtime-process.test.ts',
  'tests/scenarios/v3-arena.test.ts',
  'tests/scenarios/v3-strategies.test.ts',
  'tests/scenarios/v8-app.test.ts',
  'tests/scenarios/v8-containment.test.ts',
  'tests/unit/policies/git-user.test.ts',
  'tests/unit/process/process.test.ts',
  'tests/unit/runtime/boundary.test.ts',
]
const sandboxExclude = insideSandbox ? NOT_IN_THE_SANDBOX : []
// Once per run: the configuration is read by every project and worker.
if (insideSandbox && process.env['SANDBOX_TESTS_NOTICE_SHOWN'] === undefined) {
  process.env['SANDBOX_TESTS_NOTICE_SHOWN'] = '1'
  console.log(`[NEXUS] This checkout lies inside NEXUS's sandbox: ${NOT_IN_THE_SANDBOX.length} test files that test NEXUS's own operating-system machinery are not run here (they run outside it):\n  ${NOT_IN_THE_SANDBOX.join('\n  ')}`)
}

export default defineConfig({
  resolve: { alias },
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'unit',
          environment: 'node',
          include: ['tests/unit/**/*.test.ts'],
          exclude: [...configDefaults.exclude, ...sandboxExclude],
          // Unit tests run next to the scenario tests' git processes; the limit bounds a hang, it is not a
          // performance assertion.
          testTimeout: 30_000,
          sequence: { groupOrder: 0 },
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'integration',
          environment: 'node',
          // The overnight state-machine stress is fast (stub orchestrator, in-memory database) and runs with every suite.
          // So are the 0.3 policy, usage and campaign state stresses (pure or stubbed; no git, no Claude).
          include: [
            'tests/integration/**/*.test.ts',
            'tests/scenarios/**/*.test.ts',
            'tests/stress/overnight-*.test.ts',
            'tests/stress/policy-*.test.ts',
            'tests/stress/usage-*.test.ts',
            'tests/stress/arena-*.test.ts',
            'tests/stress/program-*.test.ts',
            'tests/stress/workspace-*.test.ts',
          ],
          // The built-in Arena cases run by themselves afterwards (see the next project).
          exclude: [...configDefaults.exclude, 'tests/integration/arena/builtin-cases.test.ts', ...sandboxExclude],
          // Scenario tests drive real git and SQLite; leave headroom for a loaded machine.
          // Generous on purpose: these waits bound a hang, they are not performance assertions, and the machine may be busy.
          testTimeout: 240_000,
          // Scenario files each drive several git processes; too many at once starve one another.
          maxWorkers: 6,
          sequence: { groupOrder: 1 },
          hookTimeout: 60_000,
        },
      },
      {
        resolve: { alias },
        test: {
          // The hidden evaluator of the performance case runs the unoptimized fixture, which by design needs most of
          // its 120 s limit. Next to six other workers it runs out of time; alone it does not. This group starts when
          // the others have finished.
          name: 'arena-cases',
          environment: 'node',
          include: ['tests/integration/arena/builtin-cases.test.ts'],
          exclude: [...configDefaults.exclude, ...sandboxExclude],
          testTimeout: 480_000,
          maxWorkers: 1,
          sequence: { groupOrder: 2 },
          hookTimeout: 60_000,
        },
      },
    ],
  },
})
