import { describe, expect, it } from 'vitest'
import { runProcess } from '@main/modules/process/run-process'

// 0.9.1: a contained full suite with 25 failed files kept 8 of their names: the output is capped at its end, and the
// runner printed each failure as it came, long before the end.
describe('keepLines', () => {
  it('keeps the matching lines of the whole output, colour codes removed, beside an output cut to its end', async () => {
    const script = [
      "process.stdout.write('\\u001b[31m FAIL \\u001b[39m tests/early.test.ts > a\\n')",
      "for (let i = 0; i < 2000; i++) process.stdout.write('noise line ' + i + '\\n')",
      "process.stderr.write(' FAIL  tests/late.test.ts > b\\n')",
      "process.stdout.write('done')",
    ].join(';')
    const r = await runProcess(process.execPath, ['-e', script], { cwd: process.cwd(), maxOutputBytes: 2000, keepLines: /^\s*FAIL\b/ })
    expect(r.truncated).toBe(true)
    expect(r.output).not.toContain('early.test.ts')
    expect(r.keptLines).toEqual([' FAIL  tests/early.test.ts > a', ' FAIL  tests/late.test.ts > b'])
  })

  it('is absent when not asked for', async () => {
    const r = await runProcess(process.execPath, ['-e', "console.log('x')"], { cwd: process.cwd() })
    expect(r.keptLines).toBeUndefined()
  })
})
