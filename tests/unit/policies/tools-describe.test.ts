import { describe, expect, it } from 'vitest'
import { AGENT_ROLES } from '@shared/domain'
import { describeToolRequest, isSecretPath, summarizeToolInput, toolsForRole } from '@main/modules/policies'

describe('toolsForRole', () => {
  const noNet = { allowNetworkTools: false }
  const net = { allowNetworkTools: true }

  it('gives read-only inspection roles read tools and shells but no writes', () => {
    for (const role of ['planner', 'architect', 'researcher', 'security_reviewer'] as const) {
      expect(toolsForRole(role, noNet)).toEqual(['Read', 'Glob', 'Grep', 'Bash', 'PowerShell'])
    }
  })

  it('gives reviewers and verifiers read tools and shells', () => {
    for (const role of ['reviewer', 'verifier'] as const) {
      expect(toolsForRole(role, noNet)).toEqual(['Read', 'Glob', 'Grep', 'Bash', 'PowerShell'])
    }
  })

  it('gives writing roles the edit tools and TodoWrite', () => {
    for (const role of ['worker', 'debugger'] as const) {
      expect(toolsForRole(role, noNet)).toEqual(['Read', 'Glob', 'Grep', 'Edit', 'Write', 'NotebookEdit', 'Bash', 'PowerShell', 'TodoWrite'])
    }
  })

  it('adds web tools only for non-writing roles when enabled', () => {
    for (const role of AGENT_ROLES) {
      const tools = toolsForRole(role, net)
      const writing = role === 'worker' || role === 'debugger'
      expect(tools.includes('WebFetch')).toBe(!writing)
      expect(tools.includes('WebSearch')).toBe(!writing)
      expect(toolsForRole(role, noNet)).not.toContain('WebFetch')
    }
  })

  it('never exposes Agent or Task and never lets read-only roles edit', () => {
    for (const role of AGENT_ROLES) {
      const tools = toolsForRole(role, net)
      expect(tools).not.toContain('Agent')
      expect(tools).not.toContain('Task')
      if (role !== 'worker' && role !== 'debugger') {
        for (const w of ['Edit', 'Write', 'NotebookEdit']) expect(tools).not.toContain(w)
      }
    }
  })
})

describe('describeToolRequest', () => {
  it('describes shell commands with the exact command', () => {
    expect(describeToolRequest({ toolName: 'Bash', input: { command: 'git push origin main' } })).toEqual({
      action: 'Run shell command (bash)',
      command: 'git push origin main',
    })
    expect(describeToolRequest({ toolName: 'PowerShell', input: { command: 'Remove-Item -Recurse x' } })).toEqual({
      action: 'Run PowerShell command',
      command: 'Remove-Item -Recurse x',
    })
  })

  it('describes file, web and MCP tools', () => {
    expect(describeToolRequest({ toolName: 'Read', input: { file_path: '.env' } })).toEqual({ action: 'Read file', command: '.env' })
    expect(describeToolRequest({ toolName: 'Write', input: { file_path: 'a.ts' } })).toEqual({ action: 'Write file', command: 'a.ts' })
    expect(describeToolRequest({ toolName: 'NotebookEdit', input: { notebook_path: 'n.ipynb' } }).command).toBe('n.ipynb')
    expect(describeToolRequest({ toolName: 'WebFetch', input: { url: 'https://x.dev' } }).command).toBe('https://x.dev')
    expect(describeToolRequest({ toolName: 'mcp__a__b', input: { k: 1 } })).toEqual({ action: 'Call MCP tool mcp__a__b', command: '{"k":1}' })
    expect(describeToolRequest({ toolName: 'Mystery', input: {} })).toEqual({ action: 'Use tool Mystery', command: null })
  })

  it('does not throw on malformed input', () => {
    expect(describeToolRequest({ toolName: 'Bash', input: { command: 5 } })).toEqual({ action: 'Run shell command (bash)', command: null })
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(() => describeToolRequest({ toolName: 'mcp__a__b', input: cyclic })).not.toThrow()
  })
})

describe('summarizeToolInput', () => {
  it('summarises by tool', () => {
    expect(summarizeToolInput('Bash', { command: 'git status' })).toBe('git status')
    expect(summarizeToolInput('PowerShell', { command: 'Get-ChildItem' })).toBe('Get-ChildItem')
    expect(summarizeToolInput('Read', { file_path: 'src/a.ts' })).toBe('src/a.ts')
    expect(summarizeToolInput('Edit', { file_path: 'src/a.ts', old_string: 'x', new_string: 'y' })).toBe('src/a.ts')
    expect(summarizeToolInput('Glob', { pattern: '**/*.ts', path: 'src' })).toBe('**/*.ts in src')
    expect(summarizeToolInput('Grep', { pattern: 'foo' })).toBe('foo')
    expect(summarizeToolInput('WebSearch', { query: 'vitest' })).toBe('vitest')
    expect(summarizeToolInput('TodoWrite', { todos: [1, 2, 3] })).toBe('3 todo items')
    expect(summarizeToolInput('mcp__a__b', { x: 1 })).toBe('{"x":1}')
  })

  it('collapses whitespace and bounds the length', () => {
    expect(summarizeToolInput('Bash', { command: 'echo a\n  echo   b' })).toBe('echo a echo b')
    const long = summarizeToolInput('Bash', { command: 'x'.repeat(5000) })
    expect(long.length).toBeLessThanOrEqual(200)
    expect(long.endsWith('…')).toBe(true)
  })

  it('never throws', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(() => summarizeToolInput('x', cyclic)).not.toThrow()
    expect(summarizeToolInput('Bash', null)).toBeTypeOf('string')
    expect(summarizeToolInput('Bash', { command: 5 })).toBe('')
  })
})

describe('isSecretPath', () => {
  it.each([
    '.env',
    '.env.local',
    'a/b/.env.production',
    'a\\b\\.env',
    'cert.pem',
    'x/server.KEY',
    'id_rsa',
    'id_rsa.pub',
    'id_ed25519',
    'credentials',
    'credentials.json',
    '.npmrc',
    '.claude/.credentials.json',
    '.claude\\.credentials.json',
    'home/.ssh/known_hosts',
    'C:\\Users\\a\\.aws\\config',
    '.env*',
    '*.pem',
  ])('%s is secret', (p) => expect(isSecretPath(p)).toBe(true))

  it.each(['src/a.ts', 'environment.md', '.envrc.md.bak.txt'.slice(0, 0) + 'README.md', '.env.example', '.env.sample', 'keyboard.ts', 'package.json', 'sshd.ts'])(
    '%s is not secret',
    (p) => expect(isSecretPath(p)).toBe(false),
  )
})
