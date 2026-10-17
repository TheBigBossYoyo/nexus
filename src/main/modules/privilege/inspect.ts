import { open } from 'node:fs/promises'
import { win32 } from 'node:path'
import type { PrivilegedOperationRequest } from '@shared/privilege'
import { errorMessage } from '@shared/result'
import { runProcess, type ProcessResult } from '../process/run-process'
import { redactText } from './policy'

/**
 * 0.9.1 (second review, L7): what the owner's confirmation shows besides the command: the first lines of the script
 * that would run (as text, never executed), or the Authenticode signer of the program or package. Read unelevated.
 *
 * The target is found exactly as the policy engine finds it, never guessed from free text:
 * powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <script.ps1>  -> the script (args[5]);
 * msiexec.exe <verb> <package.msi> ...                                                  -> the package (args[1]);
 * any other program that is an .exe                                                      -> the program itself.
 *
 * Limit: the file may change after the owner confirms. This inspection does not prevent that; what binds the file
 * that finally runs is the existing sha256 and `inputs` binding the policy engine and the broker check.
 * The inspector never throws and never changes a verdict: it only returns lines.
 */

type RunResult = Pick<ProcessResult, 'exitCode' | 'stdout'> & Partial<Pick<ProcessResult, 'stderr' | 'truncated' | 'aborted' | 'timedOut'>>

export interface TargetInspectorDeps {
  run?: (file: string, args: readonly string[], opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; maxOutputBytes: number }) => Promise<RunResult>
  /** The first `maxBytes` of a file and its full size. */
  readFile?: (path: string, maxBytes: number) => Promise<{ size: number; head: Buffer }>
  systemRoot?: string
  timeoutMs?: number
}

const PS_HEAD = ['-noprofile', '-noninteractive', '-executionpolicy', 'bypass', '-file']
const READ_BYTES = 256 * 1024
/** The cap privilege-host.ts readScript applies: a larger script is refused. */
const MAX_SCRIPT_BYTES = 2 * 1024 * 1024
const MAX_LINES = 40
const LINE_CHARS = 200
const TOTAL_CHARS = 2500
const OUTPUT_BYTES = 16 * 1024
const ENV_NAME = 'NEXUS_INSPECT_PATH'
/** Fixed text: the path is read from the environment, never interpolated. */
const SIGNATURE_SCRIPT = `$ErrorActionPreference='Stop';$s=Get-AuthenticodeSignature -LiteralPath $env:${ENV_NAME};$subject=$null;if($s.SignerCertificate){$subject=$s.SignerCertificate.Subject};[pscustomobject]@{Status=[string]$s.Status;Subject=$subject}|ConvertTo-Json -Compress`

const lower = (s: string): string => s.toLowerCase()

type Target = { kind: 'script' | 'signature'; path: string }

export function inspectionTarget(req: Pick<PrivilegedOperationRequest, 'executable' | 'args'>): Target | null {
  const name = lower(win32.basename(req.executable))
  if (name === 'powershell.exe' || name === 'pwsh.exe') {
    const head = req.args.slice(0, PS_HEAD.length).map(lower)
    const script = req.args[PS_HEAD.length]
    return head.join(' ') === PS_HEAD.join(' ') && script !== undefined && /\.ps1$/i.test(script) ? { kind: 'script', path: script } : null
  }
  if (name === 'msiexec.exe') {
    const pkg = req.args[1]
    return pkg !== undefined && /\.msi$/i.test(pkg) ? { kind: 'signature', path: pkg } : null
  }
  return /\.exe$/i.test(req.executable) ? { kind: 'signature', path: req.executable } : null
}

/** Control characters (a bare CR, escape, line and paragraph separators) could fake lines of the dialog: they become a space. */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029\ufeff]/g

const defaultReadFile = async (path: string, maxBytes: number): Promise<{ size: number; head: Buffer }> => {
  const handle = await open(path, 'r')
  try {
    const size = (await handle.stat()).size
    const head = Buffer.alloc(Math.min(size, maxBytes))
    const { bytesRead } = await handle.read(head, 0, head.length, 0)
    return { size, head: head.subarray(0, bytesRead) }
  } finally {
    await handle.close()
  }
}

export function createTargetInspector(deps: TargetInspectorDeps = {}): (req: PrivilegedOperationRequest) => Promise<string[]> {
  const systemRoot = deps.systemRoot ?? process.env['SystemRoot'] ?? 'C:\\Windows'
  const readFile = deps.readFile ?? defaultReadFile
  const timeoutMs = deps.timeoutMs ?? 15_000
  const run =
    deps.run ??
    ((file: string, args: readonly string[], opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; maxOutputBytes: number }) => runProcess(file, args, { ...opts, keep: 'head' }))

  async function excerpt(path: string): Promise<string[]> {
    const name = redactText(win32.basename(path)).replace(CONTROL, ' ')
    try {
      const { size, head } = await readFile(path, READ_BYTES)
      if (size > MAX_SCRIPT_BYTES) return [`The script could not be read: it is larger than ${MAX_SCRIPT_BYTES / 1024 / 1024} MiB (${name} not shown).`]
      const all = head.toString('utf8').replace(/^\ufeff/, '').replace(/\r/g, '').split('\n')
      // A file read only in part (cut at READ_BYTES) has more lines than the ones seen.
      const partial = size > head.length
      if (!partial && all.length > 0 && all[all.length - 1] === '') all.pop()
      // Only the lines shown are redacted, each first cut near its bound (an unfinished last word dropped, it may be
      // part of a credential): redactText is not linear on long input, and the script is the agent's text.
      const shown = all.slice(0, MAX_LINES).map((l) => {
        const long = l.length > LINE_CHARS + 256
        const clean = redactText(long ? l.slice(0, LINE_CHARS + 256).replace(/\S*$/, '') : l).replace(CONTROL, ' ')
        return long || clean.length > LINE_CHARS ? `${clean.slice(0, LINE_CHARS)}[...]` : clean
      })
      const more = all.length - shown.length
      let out = [`First ${MAX_LINES} lines of ${name} (not run):`, ...shown].join('\n')
      if (more > 0) out += `\n[cut: ${more} more lines]`
      else if (partial) out += '\n[cut: the rest of the file is not shown]'
      if (out.length > TOTAL_CHARS) out = `${out.slice(0, TOTAL_CHARS)}\n[cut: the excerpt is longer than ${TOTAL_CHARS} characters]`
      return [out]
    } catch (e) {
      return [`The script could not be read: ${errorMessage(e).replace(CONTROL, ' ').slice(0, 200)}`]
    }
  }

  async function signature(path: string): Promise<string[]> {
    const name = redactText(win32.basename(path)).replace(CONTROL, ' ')
    const failed = (why: string): string[] => [`The signature of ${name} could not be checked: ${why}`]
    try {
      const powershell = win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      const r = await run(powershell, ['-NoProfile', '-NonInteractive', '-Command', SIGNATURE_SCRIPT], { cwd: systemRoot, env: { ...process.env, [ENV_NAME]: path }, timeoutMs, maxOutputBytes: OUTPUT_BYTES })
      if (r.timedOut) return failed(`it took longer than ${Math.round(timeoutMs / 1000)} s`)
      if (r.aborted) return failed('the check was stopped')
      if (r.exitCode !== 0) return failed(`PowerShell ended with code ${r.exitCode ?? 'none'}`)
      if (r.truncated) return failed('its answer was too long')
      let parsed: unknown
      try {
        parsed = JSON.parse(r.stdout.trim())
      } catch {
        return failed('its answer could not be read')
      }
      const status = (parsed as { Status?: unknown } | null)?.Status
      const rawSubject = (parsed as { Subject?: unknown } | null)?.Subject
      if (typeof status !== 'string' || status === '') return failed('its answer could not be read')
      const subject = typeof rawSubject === 'string' && rawSubject !== '' ? redactText(rawSubject).replace(CONTROL, ' ').slice(0, 300) : null
      if (status === 'Valid') return subject !== null ? [`${name}: signed by ${subject}, signature valid`] : failed('the signature has no signer')
      if (status === 'NotSigned') return [`${name}: unsigned`]
      return [`${name}: signed by ${subject ?? 'unknown'}, signature NOT valid (${status.replace(CONTROL, ' ').slice(0, 40)})`]
    } catch (e) {
      return failed(errorMessage(e).replace(CONTROL, ' ').slice(0, 200))
    }
  }

  return async (req) => {
    try {
      const target = inspectionTarget(req)
      if (target === null) return []
      return target.kind === 'script' ? await excerpt(target.path) : await signature(target.path)
    } catch {
      return ['The file could not be inspected.']
    }
  }
}
