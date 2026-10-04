import { cp, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { errorMessage } from '@shared/result'
import type { ArenaCaseVersion } from '@shared/v3'
import type { GitService } from '../git'
import { runCommandLine } from '../process'
import { loadVerifiedCase } from './case-format'

export const EVALUATION_OUTPUT_CAP_BYTES = 16 * 1024

export interface EvaluateInput {
  /** The trial repository (its object store holds the result commit). */
  repoPath: string
  /** Integration branch head of the finished run. Null = the run produced nothing to evaluate. */
  resultCommit: string | null
  caseVersion: ArenaCaseVersion
  sourcePath: string
  /** `<data>/arena/<campaign>/<trial>`; the export lives in `<trialDir>/eval` for the duration of the call. */
  trialDir: string
  git: GitService
  /** Why there is no result commit (shown in the evaluation record). */
  skippedReason?: string
}

export interface EvaluationOutcome {
  exitCode: number | null
  timedOut: boolean
  durationMs: number
  /** Tail of the evaluator output, at most 16 KiB. */
  output: string
  passed: boolean
  /** Set when the evaluator did not run. */
  skippedReason: string | null
}

async function removeDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 })
}

/**
 * Runs the hidden evaluator against one finished trial. A pure function of the result commit: the export is
 * rebuilt from Git every time, the evaluator files exist only in a throw-away directory that is created after
 * the agents are done and removed before this returns, and nothing from the trial's working copies is used.
 */
export async function evaluateTrial(input: EvaluateInput): Promise<EvaluationOutcome> {
  const { repoPath, resultCommit, caseVersion, sourcePath, trialDir, git } = input
  if (!resultCommit) {
    return {
      exitCode: null,
      timedOut: false,
      durationMs: 0,
      output: '',
      passed: false,
      skippedReason: input.skippedReason ?? 'No result commit: acceptance counts as failed',
    }
  }
  // Refuses an evaluator (or fixture) that changed since the case version was registered.
  const loaded = loadVerifiedCase(sourcePath, caseVersion)
  const evalDir = join(trialDir, 'eval')
  const started = Date.now()
  await removeDir(evalDir)
  try {
    await mkdir(trialDir, { recursive: true })
    await git.run(trialDir, ['clone', '--quiet', '--no-hardlinks', '--no-checkout', repoPath, evalDir])
    // The commit may not be on a branch the clone fetched; pull it explicitly when needed.
    const present = await git.run(evalDir, ['cat-file', '-e', `${resultCommit}^{commit}`], { okCodes: [0, 1, 128] })
    if (present.exitCode !== 0) await git.run(evalDir, ['fetch', '--quiet', repoPath, resultCommit])
    await git.run(evalDir, ['checkout', '--quiet', '--detach', resultCommit])
    // A pure file export: no history and no link back to the trial repository.
    await removeDir(join(evalDir, '.git'))
    await cp(loaded.evaluatorDir, evalDir, { recursive: true, dereference: true, force: true })

    const { command, timeoutSeconds } = loaded.definition.hiddenEvaluation
    try {
      const result = await runCommandLine(command, {
        cwd: evalDir,
        timeoutMs: timeoutSeconds * 1000,
        maxOutputBytes: EVALUATION_OUTPUT_CAP_BYTES,
        keep: 'tail',
      })
      return {
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        durationMs: result.durationMs,
        output: result.output.slice(-EVALUATION_OUTPUT_CAP_BYTES),
        passed: result.exitCode === 0 && !result.timedOut,
        skippedReason: null,
      }
    } catch (e) {
      // The evaluator could not even start (e.g. executable missing): a failed evaluation with the reason.
      return {
        exitCode: null,
        timedOut: false,
        durationMs: Date.now() - started,
        output: `Evaluator could not run: ${errorMessage(e)}`,
        passed: false,
        skippedReason: null,
      }
    }
  } finally {
    await removeDir(evalDir)
  }
}
