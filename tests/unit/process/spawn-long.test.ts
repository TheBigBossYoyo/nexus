import { describe, expect, it } from 'vitest'
import { spawnLong } from '@main/modules/process/spawn-process'

// An application under test prints what it likes. The runtime keeps a bounded unfinished line, whatever it prints.

describe('spawnLong with output that never ends a line', () => {
  it('50 MB without a newline stays bounded and the next normal line still arrives', async () => {
    const script = [
      "const chunk = 'x'.repeat(1 << 20);",
      'let n = 0;',
      'const write = () => { while (n < 50) { n++; if (!process.stdout.write(chunk)) { process.stdout.once("drain", write); return } } process.stdout.write("\\nafter the flood\\n"); };',
      'write();',
    ].join(' ')
    const seen: string[] = []
    const started = Date.now()
    const memoryBefore = process.memoryUsage().heapUsed
    const child = spawnLong(process.execPath, ['-e', script], { cwd: process.cwd(), env: { ...(process.env as Record<string, string>) }, onLine: (line) => seen.push(line) })
    await child.exited
    // Lines are delivered as the data comes; give the last chunk a moment.
    await new Promise((done) => setTimeout(done, 100))
    expect(seen[seen.length - 1]).toBe('after the flood')
    // The flood itself came out once, cut, and not as 50 MB of lines.
    expect(seen.length).toBeLessThanOrEqual(3)
    expect(Math.max(...seen.map((l) => l.length))).toBeLessThanOrEqual(8192)
    expect(Date.now() - started).toBeLessThan(15_000)
    expect(process.memoryUsage().heapUsed - memoryBefore).toBeLessThan(64 * 1024 * 1024)
  }, 30_000)

  it('ordinary lines are unchanged, including one split across chunks', async () => {
    const seen: string[] = []
    const child = spawnLong(process.execPath, ['-e', "process.stdout.write('hel'); setTimeout(() => process.stdout.write('lo\\nsecond\\n'), 50)"], { cwd: process.cwd(), env: { ...(process.env as Record<string, string>) }, onLine: (line) => seen.push(line) })
    await child.exited
    await new Promise((done) => setTimeout(done, 100))
    expect(seen).toEqual(['hello', 'second'])
  })
})
