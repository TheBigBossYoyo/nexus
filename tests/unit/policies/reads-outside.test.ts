import { describe, expect, it } from 'vitest'
import { classifyCommand } from '@main/modules/policies/command-classifier'

// 0.9.1: read-only commands were put to the owner as "write or delete files outside the task roots" in the first
// missions NEXUS ran on itself. A `cd` inside the command is followed, and a path outside that nothing writes to is
// said to be a read.

const wt = 'C:\\work\\repo\\.nexus-wt\\task'

describe('reads outside the worktree', () => {
  it('follows a cd inside the worktree for the relative paths after it', () => {
    const r = classifyCommand('cd src/shared; head -20 ../../tests/unit/a.test.ts', 'bash', { roots: [wt] })
    expect(r.reasons).toEqual([])
  })

  it('still sees a path that leaves the worktree after the cd', () => {
    const r = classifyCommand('cd src; cat ../../../secret.txt', 'bash', { roots: [wt] })
    expect(r.reasons.join(' ')).toMatch(/reads path outside the worktree/)
  })

  it('calls a listing or a read of an outside path a read, and a write a write', () => {
    expect(classifyCommand('ls C:\\Tools\\node', 'bash', { roots: [wt] }).reasons.join(' ')).toMatch(/^reads path outside the worktree/)
    expect(classifyCommand('echo hi > C:\\Tools\\x.txt', 'bash', { roots: [wt] }).reasons.join(' ')).toMatch(/^path outside the worktree/)
    expect(classifyCommand('cp src/a.ts C:\\Tools\\a.ts', 'bash', { roots: [wt] }).reasons.join(' ')).not.toMatch(/^reads /)
    expect(classifyCommand('rm C:\\Tools\\x.txt', 'bash', { roots: [wt] }).reasons.join(' ')).toMatch(/deleting/)
  })

  it('treats 2>&1 and 2>$null as no write at all', () => {
    expect(classifyCommand('ls node_modules 2>&1 | head -3', 'bash', { roots: [wt] }).reasons).toEqual([])
    expect(classifyCommand('Get-ChildItem src 2>$null', 'powershell', { roots: [wt] }).reasons).toEqual([])
  })
})
