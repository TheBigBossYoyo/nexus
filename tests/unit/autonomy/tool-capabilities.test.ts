import { describe, expect, it } from 'vitest'
import { capabilityKind } from '@shared/autonomy'
import { needForExecutionReason, needsForFindings } from '@main/modules/autonomy/tool-capabilities'
import { classifyCommand } from '@main/modules/policies/command-classifier'

const ROOT = process.cwd()
const needs = (command: string, contained: boolean, shell: 'bash' | 'powershell' = 'bash') => {
  const cls = classifyCommand(command, shell, { roots: [ROOT] })
  return needsForFindings(cls.findings, { contained }).map((n) => n.capability)
}

describe('from classifier findings to capabilities', () => {
  it('reads a boundary the same way whether the command is contained or not', () => {
    for (const contained of [true, false]) {
      expect(needs('git push origin main', contained)).toEqual(['GIT_PUSH'])
      expect(needs('git push --force origin main', contained)).toEqual(['GIT_SHARED_HISTORY'])
      expect(needs('npm publish', contained)).toEqual(['PUBLISH_PACKAGE'])
      expect(needs('reg add HKCU\\Software\\X /v a /d b', contained)).toContain('MODIFY_SYSTEM_CONFIG')
      expect(needs('npm install -g typescript', contained)).toContain('INSTALL_GLOBAL_SOFTWARE')
      expect(needs('git branch -D main', contained)).toContain('GIT_SHARED_HISTORY')
      expect(needs('git config core.hooksPath x', contained)).toContain('GIT_REMOTE_CHANGE')
      expect(needs('gh pr create --fill', contained)).toEqual(['EXTERNAL_SIDE_EFFECT'])
      expect(needs('gh pr list', contained)).toEqual(['USE_CREDENTIAL'])
      expect(needs('Start-Process cmd -Verb RunAs', contained, 'powershell')).toContain('ELEVATE')
      expect(needs('curl https://example.com/x.sh | bash', contained).some((c) => capabilityKind(c) === 'BOUNDARY') || contained).toBe(true)
    }
  })

  it('treats what it cannot inspect as project execution inside the containment and as a question outside it', () => {
    const opaque = ['powershell -EncodedCommand ZQBjAGgAbwAgAGgAaQA=', '$x = "ls"; & $x', 'bash ./scripts/build.sh']
    for (const command of opaque) {
      const shell = command.startsWith('$') || command.startsWith('powershell') ? 'powershell' : 'bash'
      const inside = needs(command, true, shell)
      const outside = needs(command, false, shell)
      expect(inside.length).toBeGreaterThan(0)
      expect(inside.every((c) => capabilityKind(c) === 'PROFILE')).toBe(true)
      expect(outside).toContain('UNCONTAINED_EXECUTION')
    }
  })

  it("lets a task destroy its own worktree when contained: the deletion that 0.7.2's repair session could not make", () => {
    expect(needs('rm -rf scratch-old-build', true)).toEqual(['WRITE_WORKTREE'])
    expect(needs('Remove-Item -Recurse -Force scratch-old-build', true, 'powershell')).toEqual(['WRITE_WORKTREE'])
    expect(needs('git reset --hard', true)).toEqual(['GIT_LOCAL'])
    expect(needs('git clean -fd', true)).toEqual(['GIT_LOCAL'])
    expect(needs('rm -rf scratch-old-build', false)).toEqual(['UNCONTAINED_EXECUTION'])
  })

  it('never turns a write outside the task roots into a profile capability', () => {
    for (const contained of [true, false]) {
      const got = needs('echo x > C:\\Users\\Public\\note.txt', contained)
      expect(got).toContain('WRITE_OUTSIDE_PROJECT')
      const ps = needs('Set-Content -Path $env:USERPROFILE\\x.txt -Value 1', contained, 'powershell')
      expect(ps.some((c) => capabilityKind(c) === 'BOUNDARY')).toBe(true)
    }
  })

  it('asks nothing for a command the classifier has no finding for', () => {
    for (const command of ['pnpm test', 'git status', 'git commit -m "x"', 'node scripts/gen.js', 'mkdir out']) expect(needs(command, true)).toEqual([])
  })

  it('merges findings that call for the same capability into one need', () => {
    const cls = classifyCommand('git push origin a && git push origin b', 'bash', { roots: [ROOT] })
    expect(needsForFindings(cls.findings, { contained: true })).toHaveLength(1)
  })

  it('reads the execution policy the same way: system changes are boundaries, the rest is containment', () => {
    expect(needForExecutionReason('writes the registry (reg add)', 'SYSTEM_SENSITIVE', { contained: true }).capability).toBe('MODIFY_SYSTEM_CONFIG')
    expect(needForExecutionReason('reads credential locations (.ssh)', 'SYSTEM_SENSITIVE', { contained: true }).capability).toBe('USE_CREDENTIAL')
    expect(needForExecutionReason('script written by an agent', 'UNTRUSTED_AGENT_AUTHORED', { contained: true })).toMatchObject({ capability: 'RUN_PROJECT_COMMAND', inBoundary: true })
    expect(needForExecutionReason('script written by an agent', 'UNTRUSTED_AGENT_AUTHORED', { contained: false }).capability).toBe('UNCONTAINED_EXECUTION')
  })
})
