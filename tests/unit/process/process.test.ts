import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { NexusError } from '@shared/result'
import { resolveExecutable, runCommandLine, runProcess, tokenizeCommandLine } from '@main/modules/process'

const node = process.execPath
let dir: string

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nexus proc-'))
})
afterAll(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

describe('tokenizeCommandLine', () => {
  it('splits on whitespace and honours quotes', () => {
    expect(tokenizeCommandLine('npm run lint -- --max-warnings 0')).toEqual([
      'npm', 'run', 'lint', '--', '--max-warnings', '0',
    ])
    expect(tokenizeCommandLine(`tool "a b" 'c d' e"f g"h ""`)).toEqual(['tool', 'a b', 'c d', 'ef gh', ''])
  })

  it('keeps backslashes literal and supports escaped quotes in double quotes', () => {
    expect(tokenizeCommandLine('"C:\\Program Files\\x.exe" C:\\a\\b "say \\"hi\\""')).toEqual([
      'C:\\Program Files\\x.exe', 'C:\\a\\b', 'say "hi"',
    ])
  })

  it('allows operators inside quotes', () => {
    expect(tokenizeCommandLine('echo "a && b | c > d" \'$(x)\'')).toEqual(['echo', 'a && b | c > d', '$(x)'])
  })

  it.each(['a && b', 'a || b', 'a | b', 'a & b', 'a; b', 'a > f', 'a < f', 'a `b`', 'a $(b)', 'a\nb'])(
    'rejects operator in %j',
    (line) => {
      let caught: unknown
      try {
        tokenizeCommandLine(line)
      } catch (e) {
        caught = e
      }
      expect(caught).toBeInstanceOf(NexusError)
      expect((caught as NexusError).code).toBe('invalid_input')
    },
  )

  it('rejects empty and unterminated input', () => {
    expect(() => tokenizeCommandLine('   ')).toThrow(/empty/)
    expect(() => tokenizeCommandLine('a "b')).toThrow(/Unterminated/)
  })
})

describe('runProcess', () => {
  it('captures output and exit code', async () => {
    const r = await runProcess(node, ['-e', 'console.log("out");console.error("err");process.exit(3)'], { cwd: dir })
    expect(r.exitCode).toBe(3)
    expect(r.stdout.trim()).toBe('out')
    expect(r.stderr.trim()).toBe('err')
    expect(r.output).toContain('out')
    expect(r.output).toContain('err')
    expect(r.timedOut).toBe(false)
  })

  it('passes args verbatim without a shell', async () => {
    const weird = 'a b & c | "d" %PATH% $(x)'
    const r = await runProcess(node, ['-e', 'console.log(process.argv[1])', weird], { cwd: dir })
    expect(r.stdout.trim()).toBe(weird)
  })

  it('kills the whole process tree on timeout and resolves', async () => {
    const pidFile = join(dir, 'child.pid')
    const grandchild = `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(()=>{},1000)`
    const parent = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'ignore'}); setInterval(()=>{},1000)`
    const r = await runProcess(node, ['-e', parent], { cwd: dir, timeoutMs: 2000 })
    expect(r.timedOut).toBe(true)
    expect(r.durationMs).toBeLessThan(10_000)
    const pid = Number(await readFile(pidFile, 'utf8'))
    await new Promise((res) => setTimeout(res, 500))
    let alive = true
    try {
      process.kill(pid, 0)
    } catch {
      alive = false
    }
    expect(alive).toBe(false)
  })

  it('stops on abort signal', async () => {
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 300)
    const r = await runProcess(node, ['-e', 'setInterval(()=>{},1000)'], { cwd: dir, signal: ac.signal })
    expect(r.aborted).toBe(true)
    expect(r.timedOut).toBe(false)
  })

  it('keeps the tail of oversized output by default and the head on request', async () => {
    const script = 'process.stdout.write("A".repeat(5000)+"Z".repeat(5000))'
    const tail = await runProcess(node, ['-e', script], { cwd: dir, maxOutputBytes: 100 })
    expect(tail.truncated).toBe(true)
    expect(tail.stdout).toBe('Z'.repeat(100))
    const head = await runProcess(node, ['-e', script], { cwd: dir, maxOutputBytes: 100, keep: 'head' })
    expect(head.stdout).toBe('A'.repeat(100))
  })

  it('feeds stdin', async () => {
    const r = await runProcess(node, ['-e', 'process.stdin.pipe(process.stdout)'], { cwd: dir, input: 'hello' })
    expect(r.stdout).toBe('hello')
  })

  it('throws not_found for a missing executable', async () => {
    await expect(runProcess(join(dir, 'nope-xyz'), [], { cwd: dir })).rejects.toMatchObject({ code: 'not_found' })
  })
})

describe('runCommandLine', () => {
  it('runs an executable by absolute path with quoted arguments', async () => {
    const r = await runCommandLine(`"${node}" -e "console.log(process.argv.slice(1).join('|'))" "x y" z`, { cwd: dir })
    expect(r.exitCode).toBe(0)
    expect(r.stdout.trim()).toBe('x y|z')
  })

  it('reports not_found for unknown executables', async () => {
    await expect(runCommandLine('definitely-not-a-real-binary-xyz --v', { cwd: dir })).rejects.toMatchObject({
      code: 'not_found',
    })
  })

  it('rejects shell operators before running anything', async () => {
    await expect(runCommandLine('pnpm test && echo hi', { cwd: dir })).rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('resolves via PATH and PATHEXT', async () => {
    const bin = join(dir, 'bin dir')
    await mkdir(bin, { recursive: true })
    if (process.platform === 'win32') {
      await writeFile(join(bin, 'mytool.cmd'), '@echo off\r\n')
      const found = await resolveExecutable('mytool', { cwd: dir, env: { PATH: bin, PATHEXT: '.COM;.EXE;.BAT;.CMD' } })
      expect(found?.toLowerCase()).toBe(join(bin, 'mytool.cmd').toLowerCase())
    }
    expect(await resolveExecutable('definitely-not-here', { cwd: dir, env: { PATH: bin } })).toBeNull()
  })

  it.runIf(process.platform === 'win32')('runs .cmd files through cmd.exe with literal arguments', async () => {
    const bin = join(dir, 'cmd bin')
    await mkdir(bin, { recursive: true })
    const script = join(bin, 'show.js')
    await writeFile(script, 'console.log(JSON.stringify(process.argv.slice(2)))')
    await writeFile(join(bin, 'show.cmd'), `@echo off\r\n"${node}" "${script}" %*\r\nexit /b %ERRORLEVEL%\r\n`)
    const env = { ...process.env, PATH: `${bin};${process.env['PATH'] ?? ''}` }
    const r = await runCommandLine('show plain "with space" "q\\"uote" "a&b" "50%" "c^d"', { cwd: dir, env })
    expect(r.exitCode).toBe(0)
    expect(JSON.parse(r.stdout.trim())).toEqual(['plain', 'with space', 'q"uote', 'a&b', '50%', 'c^d'])
  })

  it.runIf(process.platform === 'win32')('propagates the exit code of a .cmd file', async () => {
    const bin = join(dir, 'cmd exit')
    await mkdir(bin, { recursive: true })
    await writeFile(join(bin, 'fail.cmd'), '@echo off\r\necho boom\r\nexit /b 7\r\n')
    const env = { ...process.env, PATH: `${bin};${process.env['PATH'] ?? ''}` }
    const r = await runCommandLine('fail', { cwd: dir, env })
    expect(r.exitCode).toBe(7)
    expect(r.output).toContain('boom')
  })
})
