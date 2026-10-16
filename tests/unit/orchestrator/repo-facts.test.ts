import { describe, expect, it } from 'vitest'
import { repositoryFacts } from '@main/modules/orchestrator/repo-facts'
import type { ProcessResult } from '@main/modules/process/run-process'

const result = (stdout: string, exitCode = 0): ProcessResult => ({ exitCode, stdout, stderr: '', output: stdout, timedOut: false, aborted: false, truncated: false }) as ProcessResult

function fakeGit(answers: Record<string, string | null>) {
  return {
    run: async (_cwd: string, args: readonly string[]) => {
      const key = args.join(' ')
      const answer = Object.entries(answers).find(([k]) => key.startsWith(k))?.[1]
      if (answer === undefined) throw new Error(`unexpected git ${key}`)
      return answer === null ? result('', 128) : result(`${answer}\n`)
    },
  }
}

describe('repositoryFacts', () => {
  it('says what a verifier would otherwise ask git for, once', async () => {
    const facts = await repositoryFacts(
      fakeGit({ 'rev-parse HEAD': 'abc123', 'rev-list --count': '2', 'tag --points-at': '', 'symbolic-ref': 'nexus/r/integration', 'for-each-ref': '', 'branch -r --contains': '' }),
      'C:/w',
      'base9',
    )
    expect(facts).toContain('HEAD: abc123 (base base9)')
    expect(facts).toContain('Commits since the base: 2')
    expect(facts).toContain('Tags on HEAD: none')
    expect(facts).toContain('Upstream of nexus/r/integration: none')
    expect(facts).toContain('Remote-tracking branches that contain HEAD: none')
  })

  it('leaves out what it could not read, and says nothing without a HEAD', async () => {
    const facts = await repositoryFacts(fakeGit({ 'rev-parse HEAD': 'abc', 'tag --points-at': 'v1\nv2', 'symbolic-ref': null, 'branch -r --contains': null }), 'C:/w', null)
    expect(facts).toBe('HEAD: abc\nTags on HEAD: v1, v2')
    expect(await repositoryFacts(fakeGit({ 'rev-parse HEAD': null }), 'C:/w', null)).toBeNull()
  })
})
