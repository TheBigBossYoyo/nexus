import { describe, expect, it } from 'vitest'
import type { ProjectProfile } from '@shared/domain'
import { projectScriptPrefixes } from '@main/modules/orchestrator/agent-runner'
import { createAuthorizer } from '@main/modules/policies'

const profile = (scripts: Record<string, string>, packageManagers = ['npm']): ProjectProfile => ({
  repoRoot: 'C:\\work\\project',
  isGitRepo: true,
  currentBranch: 'main',
  headCommit: 'abc',
  dirty: false,
  packageManagers,
  languages: [],
  frameworks: [],
  scripts,
  commands: { build: null, test: 'npm test', lint: null, typecheck: null },
  docs: [],
  hasClaudeMd: false,
  fileCount: 1,
  sizeBytes: 1,
  generatedPaths: [],
  profiledAt: '2026-10-04T00:00:00.000Z',
})

describe('project package scripts as verification commands', () => {
  it('turns script names into prefixes for the project package managers and leaves out the ones that do more than check', () => {
    const prefixes = projectScriptPrefixes(profile({ 'generate-schema': 'node scripts/generate.mjs', build: 'tsc', deploy: 'x', 'publish:npm': 'x', start: 'x', dev: 'x', 'db:migrate': 'x', 'weird name; rm -rf /': 'x' }))
    expect(prefixes).toEqual(['npm run generate-schema', 'npm run build'])
    expect(projectScriptPrefixes(profile({ check: 'x' }, ['pnpm']))).toEqual(['pnpm run check', 'pnpm check'])
    expect(projectScriptPrefixes(null)).toEqual([])
  })

  it('lets a verifier run a project script, and still keeps a planner read-only', async () => {
    const safeCommandPrefixes = projectScriptPrefixes(profile({ 'generate-schema': 'node scripts/generate.mjs' }))
    const decide = (role: 'verifier' | 'planner' | 'reviewer', command: string) =>
      createAuthorizer({ role, worktreeRoot: 'C:\\work\\tree', projectRoot: 'C:\\work\\project', safeCommandPrefixes, allowNetworkTools: false, allowedMcpServers: [] })({
        toolName: 'Bash',
        input: { command },
        agentId: 'a',
        toolUseId: 't',
      })
    expect((await decide('verifier', 'npm run generate-schema')).behavior).toBe('allow')
    expect((await decide('reviewer', 'npm run generate-schema')).behavior).toBe('allow')
    expect((await decide('planner', 'npm run generate-schema')).behavior).toBe('deny')
    // Only the named script: anything else stays refused for a gate role.
    expect((await decide('verifier', 'npm run deploy')).behavior).toBe('deny')
    expect((await decide('verifier', 'npm run generate-schema && shutdown /s')).behavior).toBe('deny')
  })
})
