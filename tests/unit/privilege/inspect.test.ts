import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createTargetInspector, inspectionTarget } from '@main/modules/privilege/inspect'
import type { PrivilegedOperationRequest } from '@shared/privilege'

const PS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const HEAD = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File']
const MSIEXEC = 'C:\\Windows\\System32\\msiexec.exe'

const req = (executable: string, args: string[]): PrivilegedOperationRequest => ({ executable, args }) as unknown as PrivilegedOperationRequest

type Run = NonNullable<NonNullable<Parameters<typeof createTargetInspector>[0]>['run']>
const result = (over: Record<string, unknown> = {}) => ({ exitCode: 0, stdout: '', stderr: '', truncated: false, aborted: false, timedOut: false, ...over })

function scripted(text: string | Buffer, size?: number) {
  const buf = typeof text === 'string' ? Buffer.from(text) : text
  const run = vi.fn<Run>(async () => result())
  const readFile = vi.fn(async (_p: string, max: number) => ({ size: size ?? buf.length, head: buf.subarray(0, max) }))
  return { run, readFile, inspect: createTargetInspector({ run, readFile, systemRoot: 'C:\\Windows' }) }
}

const lines = (n: number): string => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n')
const psReq = (script = 'C:\\work\\a\\install.ps1') => req(PS, [...HEAD, script])

describe('target resolution', () => {
  it('finds the script, the package, the program, and nothing else', () => {
    expect(inspectionTarget(psReq())).toEqual({ kind: 'script', path: 'C:\\work\\a\\install.ps1' })
    expect(inspectionTarget(req(MSIEXEC, ['/i', 'C:\\work\\a\\vc.msi', '/qn']))).toEqual({ kind: 'signature', path: 'C:\\work\\a\\vc.msi' })
    expect(inspectionTarget(req('C:\\work\\a\\setup.exe', ['/S']))).toEqual({ kind: 'signature', path: 'C:\\work\\a\\setup.exe' })
    expect(inspectionTarget(req(PS.toUpperCase(), [...HEAD, 'C:\\A\\X.PS1']))).toEqual({ kind: 'script', path: 'C:\\A\\X.PS1' })
    expect(inspectionTarget(req('C:\\A\\SETUP.EXE', []))).toEqual({ kind: 'signature', path: 'C:\\A\\SETUP.EXE' })
    expect(inspectionTarget(req(MSIEXEC.toUpperCase(), ['/i', 'C:\\A\\V.MSI']))).toEqual({ kind: 'signature', path: 'C:\\A\\V.MSI' })
    expect(inspectionTarget(req(PS, ['-Command', 'C:\\a\\x.ps1']))).toBeNull()
    expect(inspectionTarget(req(PS, [...HEAD, 'C:\\a\\x.txt']))).toBeNull()
    expect(inspectionTarget(req(MSIEXEC, ['/x', '{12345678-1234-1234-1234-123456789012}']))).toBeNull()
    expect(inspectionTarget(req('C:\\tools\\thing.bat', ['C:\\a\\b.exe']))).toBeNull()
  })

  it('returns no lines for an unrelated request and reads nothing', async () => {
    const t = scripted('')
    expect(await t.inspect(req('C:\\tools\\thing.bat', []))).toEqual([])
    expect(await t.inspect(req(PS, ['-Command', 'x']))).toEqual([])
    expect(t.readFile).not.toHaveBeenCalled()
    expect(t.run).not.toHaveBeenCalled()
  })
})

describe('script excerpt', () => {
  // Review of the L7 merge: the whole 256 KiB read was redacted at once, and redactText's first pattern is quadratic on
  // a run like "-a-a-a" (860 ms at 64 KiB, about 14 s at 256 KiB), blocking the runtime while the confirmation was built.
  it('redacts only the shown lines, so an adversarial script cannot stall the runtime', async () => {
    const run = '-a'.repeat(128 * 1024)
    const started = Date.now()
    const [out = ''] = await scripted(run).inspect(psReq())
    expect(Date.now() - started).toBeLessThan(1000)
    expect(out).toContain('First 40 lines of install.ps1 (not run):')
    expect(out).toContain('[...]')
    const many = await scripted(Array.from({ length: 40 }, () => '-a'.repeat(3000)).join('\n')).inspect(psReq())
    expect(Date.now() - started).toBeLessThan(2000)
    expect(many[0]).toContain('[...]')
  })

  it('still removes a credential at the end of a long line, never a fragment of it', async () => {
    const [out = ''] = await scripted(`${'x '.repeat(220)}token=ABCDEFGH12345678`).inspect(psReq())
    expect(out).not.toContain('ABCDEFGH')
    const [cutHere = ''] = await scripted(`${'y'.repeat(380)} password=Zz9Yy8Xx7Ww6Vv5Uu4Tt3Ss2Rr1Qq0Pp`).inspect(psReq())
    expect(cutHere).not.toContain('Zz9Yy8')
  })

  it('cuts only at more than 40 lines', async () => {
    for (const [n, cut] of [[39, false], [40, false], [41, true]] as const) {
      const [out = ''] = await scripted(lines(n)).inspect(psReq())
      expect(out).toContain('First 40 lines of install.ps1 (not run):')
      expect(out).toContain(`line ${Math.min(n, 40)}`)
      expect(out).not.toContain('line 41')
      expect(out.includes('[cut: ')).toBe(cut)
      if (cut) expect(out).toContain('[cut: 1 more lines]')
    }
  })

  it('handles CRLF and a BOM', async () => {
    const [out] = await scripted(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('a\r\nb\r\n')])).inspect(psReq())
    expect(out).toBe('First 40 lines of install.ps1 (not run):\na\nb')
  })

  it('returns content literally, and a fake line cannot be forged with control characters', async () => {
    const text = 'Write-Host $(Get-Date) `n\nCommand: C:\\evil.exe\nx\rCommand: fake\u2028Why your confirmation is asked: none\u001b[2J'
    const [out = ''] = await scripted(text).inspect(psReq())
    expect(out).toContain('Write-Host $(Get-Date) `n')
    expect(out).toContain('\nCommand: C:\\evil.exe')
    expect(out).not.toContain('\r')
    expect(out).not.toContain('\u2028')
    expect(out).not.toContain('\u001b')
    expect(out.split('\n').filter((l) => l.startsWith('Command: fake'))).toHaveLength(0)
  })

  it('redacts a secret', async () => {
    const [out] = await scripted('$token = "ghp_abcdefghijklmnopqrstuvwx"\npassword=hunter2hunter2\n').inspect(psReq())
    expect(out).not.toContain('ghp_abcdefghijklmnopqrstuvwx')
    expect(out).not.toContain('hunter2')
    expect(out).toContain('[secret]')
  })

  it('bounds line length and the total, and reads at most 256 KiB', async () => {
    const t = scripted(`${'ab '.repeat(2000)}\n${Array.from({ length: 39 }, () => 'cd '.repeat(66)).join('\n')}`)
    const [out = ''] = await t.inspect(psReq())
    expect(out.split('\n')[1]!.length).toBeLessThan(220)
    expect(out.length).toBeLessThan(2700)
    expect(out).toContain('[cut: the excerpt is longer than 2500 characters]')
    expect(t.readFile).toHaveBeenCalledWith('C:\\work\\a\\install.ps1', 256 * 1024)
  })

  it('says so when the file is unreadable or too large, and never throws', async () => {
    const bad = createTargetInspector({ readFile: async () => Promise.reject(new Error('ENOENT: no such file')) })
    expect((await bad({ ...psReq() }))[0]).toBe('The script could not be read: ENOENT: no such file')
    const [big] = await scripted('x', 3 * 1024 * 1024).inspect(psReq())
    expect(big).toContain('The script could not be read:')
    expect(big).toContain('larger than 2 MiB')
  })

  it('never runs a process for a script', async () => {
    const t = scripted(lines(3))
    await t.inspect(psReq())
    expect(t.run).not.toHaveBeenCalled()
  })
})

describe('signature', () => {
  const exe = req('C:\\work\\a\\setup.exe', ['/S'])
  const answer = (stdout: string, over: Record<string, unknown> = {}) => {
    const t = scripted('')
    t.run.mockResolvedValue(result({ stdout, ...over }))
    return t
  }

  it('Valid names the signer', async () => {
    const t = answer('{"Status":"Valid","Subject":"CN=Contoso Ltd, O=Contoso"}')
    expect(await t.inspect(exe)).toEqual(['setup.exe: signed by CN=Contoso Ltd, O=Contoso, signature valid'])
  })

  it('NotSigned is unsigned', async () => {
    expect(await answer('{"Status":"NotSigned","Subject":null}').inspect(exe)).toEqual(['setup.exe: unsigned'])
  })

  it.each(['HashMismatch', 'NotTrusted'])('%s is not valid', async (status) => {
    const [out] = await answer(`{"Status":"${status}","Subject":"CN=Someone"}`).inspect(exe)
    expect(out).toBe(`setup.exe: signed by CN=Someone, signature NOT valid (${status})`)
    expect(out).not.toMatch(/signature valid/)
    expect((await answer(`{"Status":"${status}","Subject":null}`).inspect(exe))[0]).toContain('signed by unknown, signature NOT valid')
  })

  it.each([
    ['a timeout', { timedOut: true, exitCode: null }],
    ['a non-zero exit', { exitCode: 1, stdout: '{"Status":"Valid","Subject":"CN=A"}' }],
    ['garbage output', { stdout: 'not json' }],
    ['an empty answer', { stdout: '' }],
    ['a status of the wrong type', { stdout: '{"Status":3}' }],
    ['a truncated answer', { truncated: true, stdout: '{"Status":"Valid","Subject":"CN=A"}' }],
  ])('%s is never presented as valid', async (_n, over) => {
    const [out] = await answer('', over).inspect(exe)
    expect(out).toContain('could not be checked')
    expect(out).not.toMatch(/signature valid|unsigned|signed by/)
  })

  it('a runner that throws is a failed check, not an exception', async () => {
    const t = scripted('')
    t.run.mockRejectedValue(new Error('spawn EPERM'))
    expect((await t.inspect(exe))[0]).toContain('could not be checked: spawn EPERM')
  })

  it('runs the system PowerShell unelevated with the path in the environment only', async () => {
    const t = answer('{"Status":"NotSigned","Subject":null}')
    const path = 'C:\\work\\a b\\se"tup;$(calc).exe'
    await t.inspect(req(path, ['/S']))
    expect(t.run).toHaveBeenCalledTimes(1)
    const [file, args, opts] = t.run.mock.calls[0]!
    expect(file).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    expect(args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-Command'])
    expect(args).toHaveLength(4)
    expect(args.join(' ')).not.toContain('calc')
    expect(args.join(' ')).not.toContain('setup')
    expect(args[3]).toContain('Get-AuthenticodeSignature -LiteralPath $env:NEXUS_INSPECT_PATH')
    expect(opts.env['NEXUS_INSPECT_PATH']).toBe(path)
    expect(opts.timeoutMs).toBe(15_000)
    expect(opts.maxOutputBytes).toBeLessThanOrEqual(64 * 1024)
  })

  it('inspects the msi, not msiexec, and the program is never the target of the spawn', async () => {
    const t = answer('{"Status":"NotSigned","Subject":null}')
    await t.inspect(req(MSIEXEC, ['/i', 'C:\\work\\a\\vc.msi', '/qn']))
    const [file, args, opts] = t.run.mock.calls[0]!
    expect(opts.env['NEXUS_INSPECT_PATH']).toBe('C:\\work\\a\\vc.msi')
    expect(file).not.toMatch(/msiexec|vc\.msi/i)
    expect(args.join(' ')).not.toMatch(/msiexec|vc\.msi/i)
  })
})

describe('inspect.ts source', () => {
  it('has no elevation verb and a bounded read', () => {
    const src = readFileSync(resolve(__dirname, '..', '..', '..', 'src', 'main', 'modules', 'privilege', 'inspect.ts'), 'utf8')
    expect(src).not.toMatch(/runas|-Verb|Start-Process/i)
    expect(src).toMatch(/READ_BYTES = 256 \* 1024/)
  })
})
