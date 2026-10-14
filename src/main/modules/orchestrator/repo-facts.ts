import type { RunGitOptions } from '@main/modules/git/git-service'
import type { ProcessResult } from '@main/modules/process/run-process'

interface GitRunner {
  run(cwd: string, args: readonly string[], opts?: RunGitOptions): Promise<ProcessResult>
}

/**
 * 0.9.1: what a verifier would otherwise find out with git commands of its own, measured once by NEXUS: the commit,
 * its base, the tags on it, the branch's upstream and whether any remote-tracking branch holds it. Verifiers of real
 * missions spent three or four turns on `git tag --points-at`, `git branch -vv` and `git ls-remote` to judge a
 * criterion such as "do not push or tag". A fact that could not be read is left out, never guessed.
 */
export async function repositoryFacts(git: GitRunner, cwd: string, baseCommit: string | null): Promise<string | null> {
  const read = async (args: string[]): Promise<string | null> => {
    try {
      const r = await git.run(cwd, args, { okCodes: [0, 1, 128], timeoutMs: 15_000, maxOutputBytes: 8_000 })
      return r.exitCode === 0 ? r.stdout.trim() : null
    } catch {
      return null
    }
  }
  const head = await read(['rev-parse', 'HEAD'])
  if (head === null) return null
  const lines = [`HEAD: ${head}${baseCommit ? ` (base ${baseCommit})` : ''}`]
  if (baseCommit) {
    const count = await read(['rev-list', '--count', `${baseCommit}..HEAD`])
    if (count !== null) lines.push(`Commits since the base: ${count}`)
  }
  const tags = await read(['tag', '--points-at', 'HEAD'])
  if (tags !== null) lines.push(`Tags on HEAD: ${tags === '' ? 'none' : tags.split('\n').join(', ')}`)
  const branch = await read(['symbolic-ref', '--short', '-q', 'HEAD'])
  if (branch !== null && branch !== '') {
    const upstream = await read(['for-each-ref', '--format=%(upstream:short)', `refs/heads/${branch}`])
    if (upstream !== null) lines.push(`Upstream of ${branch}: ${upstream === '' ? 'none' : upstream}`)
  }
  const remote = await read(['branch', '-r', '--contains', 'HEAD', '--format=%(refname:short)'])
  if (remote !== null) lines.push(`Remote-tracking branches that contain HEAD: ${remote === '' ? 'none (from the refs this repository has)' : remote.split('\n').join(', ')}`)
  return lines.join('\n')
}
