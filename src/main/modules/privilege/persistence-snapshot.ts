import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { win32 } from 'node:path'
import type { PersistenceCoverageState, PersistenceItem, PersistenceSnapshot, PersistenceSurface } from '@shared/privilege'
import { errorMessage } from '@shared/result'
import { runProcess, type ProcessResult } from '../process/run-process'

/**
 * 0.9.1 (second review, L5): one snapshot of what starts by itself on this machine (services, scheduled tasks,
 * HKLM Run/RunOnce in both registry views, the all-users StartUp folder), taken from NEXUS's own unelevated side.
 * It reads; it never changes anything and never asks for elevation. It never throws: what could not be read
 * becomes the coverage of that surface. Every source is locale-independent (registry listings, task XML, files).
 */

type RunResult = Pick<ProcessResult, 'exitCode' | 'stdout'> & Partial<Pick<ProcessResult, 'stderr' | 'truncated' | 'aborted' | 'timedOut'>>

export interface PersistenceCollectorDeps {
  run?: (file: string, args: readonly string[], opts: { signal: AbortSignal; maxOutputBytes: number }) => Promise<RunResult>
  readDir?: (path: string) => Promise<string[]>
  stat?: (path: string) => Promise<{ size: number; mtimeMs: number; isFile(): boolean }>
  hashFile?: (path: string, signal: AbortSignal) => Promise<string>
  systemRoot?: string
  programData?: string
  deadlineMs?: number
  /** How long each surface took (measurement only). */
  onSurfaceTime?: (surface: PersistenceSurface, ms: number) => void
}

interface SurfaceResult {
  items: PersistenceItem[]
  state: PersistenceCoverageState
  note?: string
}

const SURFACES: PersistenceSurface[] = ['SERVICE', 'SCHEDULED_TASK', 'RUN_KEY', 'STARTUP_FOLDER']
const CURRENT_VERSION = 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion'
export const RUN_KEYS = [
  `HKLM\\${CURRENT_VERSION}\\Run`,
  `HKLM\\${CURRENT_VERSION}\\RunOnce`,
  'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Run',
  'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\RunOnce',
] as const
const SERVICES_KEY = 'HKLM\\SYSTEM\\CurrentControlSet\\Services'
const START_TYPES = ['boot', 'system', 'auto', 'demand', 'disabled']
const HASH_CAP = 16 * 1024 * 1024
const SMALL_OUTPUT = 256 * 1024
const LARGE_OUTPUT = 16 * 1024 * 1024

class Failed extends Error {
  constructor(
    readonly state: PersistenceCoverageState,
    message: string,
  ) {
    super(message)
  }
}

// ---- reg.exe listings ----------------------------------------------------------------------------------------

interface RegListing {
  keys: Map<string, { path: string; values: Map<string, { name: string; type: string; data: string }> }>
  unparsed: number
}

const VALUE_LINE = /^ {4}(.*?) {4}(REG_[A-Z0-9_]+)(?: {4}(.*))?$/

/** `reg query` output: a key line (HKEY_...) followed by its indented values. Key and value names are case-folded in the map. */
export function parseRegListing(stdout: string): RegListing {
  const keys: RegListing['keys'] = new Map()
  let unparsed = 0
  let current: ReturnType<RegListing['keys']['get']> | undefined
  const lines = stdout.split(/\r?\n/)
  let last = lines.length - 1
  while (last >= 0 && lines[last]!.trim() === '') last--
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (line.trim() === '') continue
    if (/^HKEY_[A-Z_]+(\\|$)/.test(line)) {
      const path = line.trimEnd().replace(/^HKEY_LOCAL_MACHINE(?=\\|$)/, 'HKLM')
      current = keys.get(path.toLowerCase()) ?? { path, values: new Map() }
      keys.set(path.toLowerCase(), current)
      continue
    }
    const m = VALUE_LINE.exec(line)
    if (m && current) {
      current.values.set(m[1]!.toLowerCase(), { name: m[1]!, type: m[2]!, data: (m[3] ?? '').trimEnd() })
      continue
    }
    // The closing "End of search: N match(es) found." of a /s search is localized; it is the last line.
    if (i === last && !line.startsWith(' ')) continue
    unparsed++
  }
  return { keys, unparsed }
}

const parentKey = (key: string): string => key.slice(0, key.lastIndexOf('\\'))

// ---- scheduled-task XML (schtasks /query /xml ONE) -----------------------------------------------------------

function xmlText(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .trim()
}

const element = (xml: string, name: string): string | null => {
  const m = new RegExp(`<${name}\\b[^>]*?(?:/>|>([\\s\\S]*?)</${name}>)`).exec(xml)
  return m ? xmlText(m[1] ?? '') : null
}

/** One line per action: Exec as command and arguments, a COM handler by its class id, anything else by its kind. */
function taskActions(actionsXml: string): string[] {
  const out: string[] = []
  for (const m of actionsXml.matchAll(/<(Exec|ComHandler|SendEmail|ShowMessage)\b[^>]*?(?:\/>|>([\s\S]*?)<\/\1>)/g)) {
    const body = m[2] ?? ''
    if (m[1] === 'Exec') out.push([element(body, 'Command'), element(body, 'Arguments')].filter((p) => p).join(' '))
    else if (m[1] === 'ComHandler') out.push(`com ${element(body, 'ClassId') ?? ''}`.trim())
    else out.push(m[1]!.toLowerCase())
  }
  return out
}

export function parseTaskXml(stdout: string, truncated: boolean): SurfaceResult {
  if (!/<Tasks\b[^>]*>/.test(stdout)) throw new Failed('FAILED', 'the task query did not return a <Tasks> document')
  if (!truncated && !/<\/Tasks>\s*$/.test(stdout)) throw new Failed('FAILED', 'the task query returned an unterminated <Tasks> document')
  const items: PersistenceItem[] = []
  let unparsed = 0
  const opened = stdout.match(/<Task\b/g)?.length ?? 0
  for (const m of stdout.matchAll(/(?:<!--\s*((?:(?!-->)[\s\S])*?)\s*-->\s*)?<Task\b[^>]*>([\s\S]*?)<\/Task>/g)) {
    const body = m[2]!
    const registration = /<RegistrationInfo\b[^>]*>([\s\S]*?)<\/RegistrationInfo>/.exec(body)?.[1] ?? ''
    const id = element(registration, 'URI') || (m[1] ? m[1].trim() : '')
    const actions = /<Actions\b[^>]*?(?:\/>|>([\s\S]*?)<\/Actions>)/.exec(body)
    if (!id.startsWith('\\') || !actions) {
      unparsed++
      continue
    }
    items.push({ surface: 'SCHEDULED_TASK', id, attrs: { actions: taskActions(actions[1] ?? '').join('; ') } })
  }
  unparsed += Math.max(0, opened - items.length - unparsed)
  if (opened > 0 && items.length === 0) throw new Failed('FAILED', `none of the ${opened} task(s) in the task query could be parsed`)
  const notes = [truncated ? 'the task query output was cut at its size cap' : '', unparsed ? `${unparsed} task(s) could not be parsed` : ''].filter(Boolean)
  return { items, state: notes.length ? 'PARTIAL' : 'COMPLETE', ...(notes.length ? { note: notes.join('; ') } : {}) }
}

// ---- the collector ---------------------------------------------------------------------------------------------

export function createPersistenceCollector(deps: PersistenceCollectorDeps = {}): (signal?: AbortSignal) => Promise<PersistenceSnapshot> {
  const systemRoot = deps.systemRoot ?? process.env.SystemRoot ?? 'C:\\Windows'
  const programData = deps.programData ?? process.env.ProgramData ?? 'C:\\ProgramData'
  const deadlineMs = deps.deadlineMs ?? 2500
  const run =
    deps.run ??
    ((file: string, args: readonly string[], opts: { signal: AbortSignal; maxOutputBytes: number }) =>
      runProcess(file, args, {
        cwd: systemRoot,
        env: { SystemRoot: systemRoot, windir: systemRoot, PATH: `${systemRoot}\\System32` },
        timeoutMs: deadlineMs + 1000,
        maxOutputBytes: opts.maxOutputBytes,
        keep: 'head',
        signal: opts.signal,
      }))
  const readDir = deps.readDir ?? ((path: string) => readdir(path))
  const statFile = deps.stat ?? ((path: string) => stat(path))
  const hashFile =
    deps.hashFile ??
    ((path: string, signal: AbortSignal) =>
      new Promise<string>((resolve, reject) => {
        const hash = createHash('sha256')
        const stream = createReadStream(path, { signal })
        stream.on('error', reject)
        stream.on('data', (chunk) => hash.update(chunk))
        stream.on('end', () => resolve(hash.digest('hex')))
      }))
  const reg = win32.join(systemRoot, 'System32', 'reg.exe')
  const schtasks = win32.join(systemRoot, 'System32', 'schtasks.exe')

  /** Runs one read-only query; anything but a whole, successful run is thrown as the surface's coverage. */
  const query = async (file: string, args: readonly string[], signal: AbortSignal, maxOutputBytes: number): Promise<RunResult> => {
    let r: RunResult
    try {
      r = await run(file, args, { signal, maxOutputBytes })
    } catch (e) {
      throw new Failed('FAILED', `${win32.basename(file)} could not be run: ${errorMessage(e).slice(0, 200)}`)
    }
    if (r.aborted || r.timedOut) throw new Failed('TIMED_OUT', `${win32.basename(file)} was stopped at the deadline`)
    return r
  }

  const runKeys = async (signal: AbortSignal): Promise<SurfaceResult> => {
    const perKey = await Promise.all(
      RUN_KEYS.map(async (key): Promise<{ items: PersistenceItem[]; note?: string }> => {
        const r = await query(reg, ['query', key, '/reg:64'], signal, SMALL_OUTPUT)
        if (r.exitCode !== 0) {
          // A missing key fails like any other error, in the user's language: ask its parent whether it is there.
          const parent = await query(reg, ['query', parentKey(key), '/reg:64'], signal, SMALL_OUTPUT)
          if (parent.exitCode === 0 && !parent.truncated && !parseRegListing(parent.stdout).keys.has(key.toLowerCase())) return { items: [] }
          throw new Failed('FAILED', `${key} could not be read (exit ${r.exitCode})`)
        }
        const listing = parseRegListing(r.stdout)
        const values = listing.keys.get(key.toLowerCase())
        if (!values) throw new Failed('FAILED', `${key} listing did not name the key`)
        const items = [...values.values.values()].map((v): PersistenceItem => ({ surface: 'RUN_KEY', id: `${key}\\${v.name}`, attrs: { data: v.data } }))
        const cut = r.truncated || listing.unparsed > 0
        return { items, ...(cut ? { note: `${key}: ${listing.unparsed} line(s) could not be parsed${r.truncated ? ', output cut' : ''}` } : {}) }
      }),
    )
    const notes = perKey.flatMap((k) => (k.note ? [k.note] : []))
    return { items: perKey.flatMap((k) => k.items), state: notes.length ? 'PARTIAL' : 'COMPLETE', ...(notes.length ? { note: notes.join('; ') } : {}) }
  }

  const services = async (signal: AbortSignal): Promise<SurfaceResult> => {
    const [start, image] = await Promise.all(
      ['Start', 'ImagePath'].map((v) => query(reg, ['query', SERVICES_KEY, '/s', '/v', v, '/reg:64'], signal, LARGE_OUTPUT)),
    )
    for (const r of [start!, image!]) if (r.exitCode !== 0) throw new Failed('FAILED', `the services listing failed (exit ${r.exitCode})`)
    const starts = parseRegListing(start!.stdout)
    const images = parseRegListing(image!.stdout)
    const prefix = `${SERVICES_KEY}\\`.toLowerCase()
    const items: PersistenceItem[] = []
    for (const [k, key] of starts.keys) {
      // Only the services themselves: direct subkeys of Services with a Start value.
      if (!k.startsWith(prefix) || k.slice(prefix.length).includes('\\')) continue
      const value = key.values.get('start')
      if (!value) continue
      const n = /^0x([0-9a-f]+)$/i.exec(value.data)
      const code = n ? parseInt(n[1]!, 16) : NaN
      const binaryPath = images.keys.get(k)?.values.get('imagepath')?.data
      items.push({
        surface: 'SERVICE',
        id: key.path.slice(prefix.length),
        attrs: { startType: START_TYPES[code] ?? `start ${value.data}`, ...(binaryPath !== undefined ? { binaryPath } : {}) },
      })
    }
    if (items.length === 0) throw new Failed('FAILED', 'the services listing named no service')
    const unparsed = starts.unparsed + images.unparsed
    const notes = [
      start!.truncated || image!.truncated ? 'the services listing was cut at its size cap' : '',
      unparsed ? `${unparsed} line(s) of the services listing could not be parsed` : '',
    ].filter(Boolean)
    return { items, state: notes.length ? 'PARTIAL' : 'COMPLETE', ...(notes.length ? { note: notes.join('; ') } : {}) }
  }

  const tasks = async (signal: AbortSignal): Promise<SurfaceResult> => {
    const r = await query(schtasks, ['/query', '/xml', 'ONE'], signal, LARGE_OUTPUT)
    if (r.exitCode !== 0) throw new Failed('FAILED', `the task query failed (exit ${r.exitCode})`)
    const result = parseTaskXml(r.stdout, r.truncated === true)
    // Exit 0 with errors on stderr: some tasks could not be read by this account.
    if (result.state === 'COMPLETE' && (r.stderr ?? '').trim() !== '') return { ...result, state: 'PARTIAL', note: 'the task query reported errors for some tasks' }
    return result
  }

  const startup = async (signal: AbortSignal): Promise<SurfaceResult> => {
    const folder = win32.join(programData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'StartUp')
    let names: string[]
    try {
      names = await readDir(folder)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { items: [], state: 'COMPLETE' }
      throw new Failed('FAILED', `the StartUp folder could not be read: ${errorMessage(e).slice(0, 200)}`)
    }
    const items: PersistenceItem[] = []
    const unread: string[] = []
    const large: string[] = []
    for (const name of [...names].sort()) {
      if (signal.aborted) throw new Failed('TIMED_OUT', 'the StartUp folder was not read to the end before the deadline')
      const path = win32.join(folder, name)
      try {
        const s = await statFile(path)
        if (!s.isFile()) continue
        if (s.size > HASH_CAP) {
          large.push(name)
          items.push({ surface: 'STARTUP_FOLDER', id: path, attrs: { size: String(s.size), mtime: new Date(s.mtimeMs).toISOString() } })
        } else {
          items.push({ surface: 'STARTUP_FOLDER', id: path, attrs: { size: String(s.size), sha256: await hashFile(path, signal) } })
        }
      } catch {
        if (signal.aborted) throw new Failed('TIMED_OUT', 'the StartUp folder was not read to the end before the deadline')
        unread.push(name)
      }
    }
    const notes = [
      large.length ? `above ${HASH_CAP / 1024 / 1024} MiB, compared by size and mtime: ${large.join(', ')}` : '',
      unread.length ? `could not be read: ${unread.join(', ')}` : '',
    ].filter(Boolean)
    return { items, state: unread.length ? 'PARTIAL' : 'COMPLETE', ...(notes.length ? { note: notes.join('; ') } : {}) }
  }

  const sources: Record<PersistenceSurface, (signal: AbortSignal) => Promise<SurfaceResult>> = {
    SERVICE: services,
    SCHEDULED_TASK: tasks,
    RUN_KEY: runKeys,
    STARTUP_FOLDER: startup,
  }

  return async (signal) => {
    const started = Date.now()
    const ctl = new AbortController()
    let timer: NodeJS.Timeout | undefined
    let onAbort: (() => void) | undefined
    // Resolves at the deadline or when the caller gives up, whichever is first.
    const cut = new Promise<SurfaceResult>((resolve) => {
      timer = setTimeout(() => resolve({ items: [], state: 'TIMED_OUT', note: `not finished within ${deadlineMs} ms` }), deadlineMs)
      onAbort = () => resolve({ items: [], state: 'FAILED', note: 'the snapshot was cancelled' })
      if (signal?.aborted) onAbort()
      else signal?.addEventListener('abort', onAbort, { once: true })
    })
    const results = await Promise.all(
      SURFACES.map((surface) => {
        const t0 = Date.now()
        const work = sources[surface](ctl.signal).then(
          (r) => {
            deps.onSurfaceTime?.(surface, Date.now() - t0)
            return r
          },
          (e: unknown): SurfaceResult =>
            e instanceof Failed ? { items: [], state: e.state, note: e.message } : { items: [], state: 'FAILED', note: errorMessage(e).slice(0, 200) },
        )
        return Promise.race([work, cut])
      }),
    )
    clearTimeout(timer)
    if (onAbort) signal?.removeEventListener('abort', onAbort)
    // Stop whatever is still running (the stragglers).
    ctl.abort()
    const snapshot: PersistenceSnapshot = { takenAt: new Date(started).toISOString(), durationMs: Date.now() - started, items: [], coverage: {} }
    SURFACES.forEach((surface, i) => {
      const r = results[i]!
      snapshot.items.push(...r.items)
      snapshot.coverage[surface] = { state: r.state, ...(r.note ? { note: r.note } : {}) }
    })
    return snapshot
  }
}
