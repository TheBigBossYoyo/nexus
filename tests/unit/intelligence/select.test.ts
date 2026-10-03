import { describe, expect, it } from 'vitest'
import { selectFactsForTask } from '@main/modules/intelligence/select'
import type { FactKind, RepositoryFact } from '@shared/v2'

let n = 0
function fact(kind: FactKind, subject: string, statement: string, files: string[] = [], stale = false): RepositoryFact {
  n++
  return {
    id: `f${n}`,
    projectId: 'p',
    kind,
    subject,
    statement,
    source: 'static_analysis',
    confidence: 'medium',
    files,
    fingerprint: 'x',
    stale,
    createdAt: 'now',
    verifiedAt: 'now',
  }
}

const task = (title: string, suggestedFiles: string[], description = '') => ({ title, description, suggestedFiles })

describe('selectFactsForTask', () => {
  const facts = [
    fact('command', 'test', 'test: pnpm test', ['package.json']),
    fact('module', 'src/billing', 'src/billing: 4 source files', ['src/billing/invoice.ts']),
    fact('module', 'src/auth', 'src/auth: 3 source files', ['src/auth/login.ts']),
    fact('interface', 'src/billing/invoice.ts', 'imported by 3 files', ['src/billing/invoice.ts']),
    fact('hot_file', 'src/billing/ledger.ts', 'changed often', ['src/billing/ledger.ts']),
    fact('hot_file', 'docs/guide.md', 'changed often', ['docs/guide.md']),
    fact('dependency', 'npm:stripe', 'Runtime dependency stripe@1 used for payment processing', ['package.json']),
    fact('module', 'src/old', 'stale module', ['src/billing/old.ts'], true),
  ]

  it('ranks path matches first, then commands, then text overlap, with reasons', () => {
    const out = selectFactsForTask(facts, task('Improve payment processing', ['src/billing/invoice.ts']), 10)
    const subjects = out.map((o) => o.fact.subject)
    expect(subjects[0]).toBe('src/billing/invoice.ts')
    const billing = out.find((o) => o.fact.subject === 'src/billing')
    expect(billing?.reason).toContain('src/billing/invoice.ts')
    const cmdIdx = subjects.indexOf('test')
    const textIdx = subjects.indexOf('npm:stripe')
    expect(cmdIdx).toBeGreaterThan(subjects.indexOf('src/billing'))
    expect(textIdx).toBeGreaterThan(cmdIdx)
    expect(out[cmdIdx]?.reason).toContain('always relevant to implementers')
    expect(out[textIdx]?.reason).toContain('payment')
  })

  it('never returns stale or unrelated facts', () => {
    const out = selectFactsForTask(facts, task('Fix login', ['src/auth/login.ts']), 10)
    const subjects = out.map((o) => o.fact.subject)
    expect(subjects).not.toContain('src/old')
    expect(subjects).not.toContain('src/billing')
    expect(subjects).toContain('src/auth')
  })

  it('matches modules shared with a suggested file and respects the limit', () => {
    const out = selectFactsForTask(facts, task('x', ['src/billing/new-file.ts']), 3)
    expect(out).toHaveLength(3)
    expect(out[0]?.reason).toContain("contains the task's suggested file")
    expect(out.find((o) => o.fact.subject === 'src/billing/ledger.ts')?.reason).toContain('module src/billing')
  })

  it('is deterministic regardless of input order', () => {
    const t = task('Improve payment processing', ['src/billing/invoice.ts'])
    const a = selectFactsForTask(facts, t, 10).map((o) => o.fact.id)
    const b = selectFactsForTask([...facts].reverse(), t, 10).map((o) => o.fact.id)
    expect(b).toEqual(a)
  })

  it('returns only commands when nothing else is relevant', () => {
    const out = selectFactsForTask(facts, task('zzz', []), 5)
    expect(out.map((o) => o.fact.kind)).toEqual(['command'])
    expect(selectFactsForTask(facts, task('zzz', []), 0)).toEqual([])
  })
})
