import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, rm, stat } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { NexusError } from '@shared/result'
import type { ArenaCaseVersion } from '@shared/v3'
import type { GitService } from '../git'
import { runCommandLine } from '../process'
import { listFilesRecursive, loadVerifiedCase, normalizedBytes } from './case-format'

export const BASELINE_AUTHOR = { name: 'NEXUS Arena', email: 'arena@nexus.invalid' } as const
/** A fixed date makes the baseline commit id a pure function of the fixture: two trials share one sha. */
const BASELINE_DATE = '2000-01-01T00:00:00Z'
const SETUP_TIMEOUT_MS = 10 * 60_000

export interface ProvisionInput {
  caseVersion: ArenaCaseVersion
  /** The case directory (never copied into the trial). */
  sourcePath: string
  /** `<data>/arena/<campaign>/<trial>`; the repository is created at `<trialDir>/repo`. */
  trialDir: string
  git: GitService
  /** Origin `repository`: the trial repository is a local clone of `path` at `commit` instead of the fixture. */
  repository?: { path: string; commit: string }
}

export interface ProvisionedTrial {
  repoPath: string
  baselineCommit: string
}

const isInside = (parent: string, child: string): boolean => {
  const p = resolve(parent).toLowerCase() + sep
  const c = resolve(child).toLowerCase() + sep
  return c.startsWith(p)
}

async function runSetup(commands: readonly string[], cwd: string): Promise<void> {
  for (const command of commands) {
    const result = await runCommandLine(command, { cwd, timeoutMs: SETUP_TIMEOUT_MS, maxOutputBytes: 64 * 1024 })
    if (result.exitCode !== 0 || result.timedOut) {
      throw new NexusError('invalid_state', `Case setup command failed (exit ${result.exitCode ?? 'n/a'}): ${command}`, {
        output: result.output.slice(-2000),
      })
    }
  }
}

const sha256 = (bytes: Buffer): string => createHash('sha256').update(normalizedBytes(bytes)).digest('hex')

/**
 * Throws when any file of `evaluatorDir` exists in `repoPath`, by relative path or by content hash. The
 * evaluator must not exist anywhere an agent can read; this is checked before the baseline commit exists.
 */
export async function assertNoEvaluatorFiles(repoPath: string, evaluatorDir: string, fixtureDir?: string): Promise<void> {
  const evaluatorFiles = listFilesRecursive(evaluatorDir)
  const names = new Set(evaluatorFiles.map((f) => f.toLowerCase()))
  const hashes = new Set<string>()
  // A case may legitimately ship a copy of a fixture file inside its evaluator (e.g. a pristine source for
  // mutation testing); that content is already visible to agents, so it is not "hidden" content.
  const fixtureHashes = new Set<string>()
  if (fixtureDir) {
    for (const rel of listFilesRecursive(fixtureDir)) fixtureHashes.add(sha256(await readFile(join(fixtureDir, rel))))
  }
  for (const rel of evaluatorFiles) {
    const bytes = await readFile(join(evaluatorDir, rel))
    if (bytes.length > 0 && !fixtureHashes.has(sha256(bytes))) hashes.add(sha256(bytes))
  }
  const repoFiles = listFilesRecursive(repoPath).filter((f) => f !== '.git' && !f.startsWith('.git/'))
  for (const rel of repoFiles) {
    if (names.has(rel.toLowerCase())) {
      throw new NexusError('invalid_state', `Evaluator file "${rel}" exists in the trial repository`, { file: rel })
    }
    const bytes = await readFile(join(repoPath, rel))
    if (bytes.length > 0 && hashes.has(sha256(bytes))) {
      throw new NexusError('invalid_state', `A file in the trial repository ("${rel}") has the content of an evaluator file`, { file: rel })
    }
  }
}

async function configureRepo(git: GitService, repoPath: string): Promise<void> {
  await git.run(repoPath, ['config', 'user.name', BASELINE_AUTHOR.name])
  await git.run(repoPath, ['config', 'user.email', BASELINE_AUTHOR.email])
  await git.run(repoPath, ['config', 'commit.gpgsign', 'false'])
  // Line endings must not depend on the machine: the baseline is byte-identical everywhere.
  await git.run(repoPath, ['config', 'core.autocrlf', 'false'])
}

/**
 * Creates the isolated repository of one trial. Always starts from nothing: a directory left by an
 * interrupted attempt is removed first, so a re-provisioned trial is identical to a first attempt.
 */
export async function provisionTrial(input: ProvisionInput): Promise<ProvisionedTrial> {
  const { caseVersion, sourcePath, trialDir, git } = input
  if (isInside(sourcePath, trialDir) || isInside(trialDir, sourcePath)) {
    throw new NexusError('invalid_state', 'The trial directory and the case directory must not contain one another')
  }
  const loaded = loadVerifiedCase(sourcePath, caseVersion)
  const repoPath = join(trialDir, 'repo')
  await rm(trialDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  await mkdir(trialDir, { recursive: true })

  if (input.repository) {
    return provisionFromRepository(input, loaded.definition.setup, loaded.evaluatorDir, repoPath)
  }

  // Copy, never link: a trial can neither change the case nor see another trial.
  await cp(loaded.fixtureDir, repoPath, { recursive: true, dereference: true })
  await runSetup(loaded.definition.setup, repoPath)
  await assertNoEvaluatorFiles(repoPath, loaded.evaluatorDir, loaded.fixtureDir)

  await git.run(repoPath, ['init', '--initial-branch=main'])
  await configureRepo(git, repoPath)
  await git.run(repoPath, ['add', '-A'])
  await git.run(repoPath, ['commit', '--no-verify', '--allow-empty', '-m', `Arena baseline ${caseVersion.caseId}@${caseVersion.version}`], {
    env: { GIT_AUTHOR_DATE: BASELINE_DATE, GIT_COMMITTER_DATE: BASELINE_DATE },
  })
  return { repoPath, baselineCommit: await git.headCommit(repoPath) }
}

async function provisionFromRepository(
  input: ProvisionInput,
  setup: readonly string[],
  evaluatorDir: string,
  repoPath: string,
): Promise<ProvisionedTrial> {
  const { git, trialDir } = input
  const source = resolve(input.repository!.path)
  if (!(await stat(source).catch(() => null))?.isDirectory()) {
    throw new NexusError('not_found', `Repository does not exist: ${source}`)
  }
  const commit = await git.resolveCommit(source, input.repository!.commit)
  const before = JSON.stringify([await git.headCommit(source), await git.currentBranch(source), await git.status(source)])

  // --no-hardlinks: a full copy of the objects, so nothing in the trial can touch the original's object store.
  await git.run(trialDir, ['clone', '--no-hardlinks', '--no-checkout', source, repoPath])
  await git.run(repoPath, ['checkout', '--quiet', '-b', 'arena-baseline', commit])
  // The trial must not be able to push or fetch into the user's repository by accident.
  await git.run(repoPath, ['remote', 'remove', 'origin'])
  await configureRepo(git, repoPath)
  await runSetup(setup, repoPath)
  await assertNoEvaluatorFiles(repoPath, evaluatorDir)

  const after = JSON.stringify([await git.headCommit(source), await git.currentBranch(source), await git.status(source)])
  if (before !== after) {
    throw new NexusError('invalid_state', 'The original repository changed while a trial was provisioned from it', { source })
  }
  return { repoPath, baselineCommit: commit }
}
