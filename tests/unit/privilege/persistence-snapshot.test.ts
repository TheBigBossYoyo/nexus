import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createPersistenceCollector, parseTaskXml, type PersistenceCollectorDeps } from '@main/modules/privilege/persistence-snapshot'
import type { PersistenceSurface } from '@shared/privilege'

// A fake `run` and a fake fs with canned output: nothing here reads the live machine (except the opt-in live test).

const SYS = 'C:\\Windows'
const REG = 'C:\\Windows\\System32\\reg.exe'
const SCHTASKS = 'C:\\Windows\\System32\\schtasks.exe'
const CV = 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion'
const CV32 = 'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion'
const SU = 'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\StartUp'
const MiB = 1024 * 1024

const ok = (stdout: string) => ({ exitCode: 0, stdout })
const fail = (exitCode = 1) => ({ exitCode, stdout: '' })

const RUN64 = [
  '',
  'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run',
  '    SecurityHealth    REG_EXPAND_SZ    %windir%\\system32\\SecurityHealthSystray.exe',
  '    My App    REG_SZ    "C:\\Program Files\\My App\\app.exe" --tray',
  '',
].join('\r\n')
// The parent of RunOnce lists its values and subkeys; RunOnce is not among them.
const CV_LISTING = [
  '',
  'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion',
  '    ProgramFilesDir    REG_SZ    C:\\Program Files',
  '',
  'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run',
  'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  '',
].join('\r\n')
const RUN32 = ['', 'HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Run', '    Old Tool    REG_SZ    C:\\old\\tool.exe /quiet', ''].join('\r\n')
const RUNONCE32 = ['', 'HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\RunOnce', ''].join('\r\n')

const SVC = 'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Services'
const START = [
  '',
  `${SVC}\\AppSvc`,
  '    Start    REG_DWORD    0x2',
  '',
  `${SVC}\\AppSvc\\Parameters`,
  '    Start    REG_DWORD    0x3',
  '',
  `${SVC}\\bootdrv`,
  '    Start    REG_DWORD    0x0',
  '',
  `${SVC}\\sysdrv`,
  '    Start    REG_DWORD    0x1',
  '',
  `${SVC}\\Manual Svc`,
  '    Start    REG_DWORD    0x3',
  '',
  `${SVC}\\Off`,
  '    Start    REG_DWORD    0x4',
  '',
  // Localized summary line: ignored, not a parse failure.
  'Fin de la recherche : 6 correspondance(s) trouvée(s).',
  '',
].join('\r\n')
const IMAGE = [
  '',
  `${SVC}\\AppSvc`,
  '    ImagePath    REG_EXPAND_SZ    "C:\\Program Files\\App Co\\svc.exe" -k "net svc"',
  '',
  `${SVC}\\bootdrv`,
  '    ImagePath    REG_EXPAND_SZ    \\SystemRoot\\System32\\drivers\\bootdrv.sys',
  '',
  `${SVC}\\Off`,
  '    ImagePath    REG_EXPAND_SZ    C:\\Off Dir\\off.exe',
  '',
  'End of search: 3 match(es) found.',
  '',
].join('\r\n')

const TASKS = `<?xml version="1.0" encoding="UTF-16"?>
<Tasks>
  <!-- \\Vendor\\Updater -->
  <Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
    <RegistrationInfo>
      <Author>Vendor &amp; Co</Author>
      <URI>\\Vendor\\Updater</URI>
    </RegistrationInfo>
    <Actions Context="Author">
      <Exec>
        <Command>"C:\\Program Files\\Vendor\\upd.exe"</Command>
        <Arguments>/check &amp;quiet</Arguments>
      </Exec>
      <Exec>
        <Command>C:\\Windows\\System32\\cmd.exe</Command>
      </Exec>
      <ComHandler>
        <ClassId>{11111111-2222-3333-4444-555555555555}</ClassId>
        <Data><![CDATA[blob]]></Data>
      </ComHandler>
    </Actions>
  </Task>
  <!-- \\NoUri -->
  <Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
    <RegistrationInfo />
    <Actions Context="Author">
      <Exec>
        <Command>C:\\x.exe</Command>
      </Exec>
    </Actions>
  </Task>
</Tasks>
`

type Run = NonNullable<PersistenceCollectorDeps['run']>
type Call = { file: string; args: readonly string[] }

function fakeRun(overrides: Partial<Record<string, Run>> = {}): { run: Run; calls: Call[] } {
  const calls: Call[] = []
  const run: Run = async (file, args, opts) => {
    calls.push({ file, args })
    const key = `${file.split('\\').pop()} ${args.join(' ')}`
    const o = overrides[key]
    if (o) return o(file, args, opts)
    switch (key) {
      case `reg.exe query ${CV}\\Run /reg:64`:
        return ok(RUN64)
      case `reg.exe query ${CV}\\RunOnce /reg:64`:
        return fail(1)
      case `reg.exe query ${CV} /reg:64`:
        return ok(CV_LISTING)
      case `reg.exe query ${CV32}\\Run /reg:64`:
        return ok(RUN32)
      case `reg.exe query ${CV32}\\RunOnce /reg:64`:
        return ok(RUNONCE32)
      case 'reg.exe query HKLM\\SYSTEM\\CurrentControlSet\\Services /s /v Start /reg:64':
        return ok(START)
      case 'reg.exe query HKLM\\SYSTEM\\CurrentControlSet\\Services /s /v ImagePath /reg:64':
        return ok(IMAGE)
      case 'schtasks.exe /query /xml ONE':
        return ok(TASKS)
    }
    throw new Error(`unexpected command ${key}`)
  }
  return { run, calls }
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex')

function fakeFs(files: Record<string, { content?: string; size?: number; dir?: boolean }> = { 'app.lnk': { content: 'link' }, 'desktop.ini': { content: '[x]' } }) {
  const reads: string[] = []
  const hashed: string[] = []
  return {
    reads,
    hashed,
    deps: {
      readDir: async (path: string) => {
        reads.push(`readDir ${path}`)
        if (path !== SU) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        return Object.keys(files)
      },
      stat: async (path: string) => {
        reads.push(`stat ${path}`)
        const f = files[path.slice(SU.length + 1)]
        if (!f) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        return { size: f.size ?? (f.content ?? '').length, mtimeMs: Date.UTC(2026, 0, 2), isFile: () => !f.dir }
      },
      hashFile: async (path: string) => {
        hashed.push(path)
        return sha(files[path.slice(SU.length + 1)]?.content ?? '')
      },
    },
  }
}

function collector(run: Run, extra: Partial<PersistenceCollectorDeps> = {}) {
  return createPersistenceCollector({ run, systemRoot: SYS, programData: 'C:\\ProgramData', ...fakeFs().deps, ...extra })
}

const of = (items: { surface: PersistenceSurface; id: string; attrs: Record<string, string> }[], surface: PersistenceSurface) =>
  items.filter((i) => i.surface === surface).map((i) => ({ id: i.id, ...i.attrs }))

describe('persistence collector', () => {
  it('reads Run/RunOnce in both views; a missing key is an empty COMPLETE set', async () => {
    const snap = await collector(fakeRun().run)()
    expect(snap.coverage.RUN_KEY).toEqual({ state: 'COMPLETE' })
    expect(of(snap.items, 'RUN_KEY')).toEqual([
      { id: `${CV}\\Run\\SecurityHealth`, data: '%windir%\\system32\\SecurityHealthSystray.exe' },
      { id: `${CV}\\Run\\My App`, data: '"C:\\Program Files\\My App\\app.exe" --tray' },
      { id: `${CV32}\\Run\\Old Tool`, data: 'C:\\old\\tool.exe /quiet' },
    ])
  })

  it('an existing Run key with no values (reg.exe prints a blank line only) is an empty COMPLETE set', async () => {
    const { run } = fakeRun({ [`reg.exe query ${CV32}\\RunOnce /reg:64`]: async () => ok('\r\n') })
    const snap = await collector(run)()
    expect(snap.coverage.RUN_KEY).toEqual({ state: 'COMPLETE' })
    expect(of(snap.items, 'RUN_KEY').map((i) => i.id)).toEqual([`${CV}\\Run\\SecurityHealth`, `${CV}\\Run\\My App`, `${CV32}\\Run\\Old Tool`])
    const cut = await collector(fakeRun({ [`reg.exe query ${CV32}\\RunOnce /reg:64`]: async () => ({ exitCode: 0, stdout: '', truncated: true }) }).run)()
    expect(cut.coverage.RUN_KEY?.state).toBe('FAILED')
  })

  it('a Run key that fails while its parent still lists it is FAILED, not empty', async () => {
    const listed = `${CV_LISTING}HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\RunOnce\r\n`
    const { run } = fakeRun({ [`reg.exe query ${CV} /reg:64`]: async () => ok(listed) })
    const snap = await collector(run)()
    expect(snap.coverage.RUN_KEY?.state).toBe('FAILED')
    expect(of(snap.items, 'RUN_KEY')).toEqual([])
    const parentFails = await collector(fakeRun({ [`reg.exe query ${CV} /reg:64`]: async () => fail(1) }).run)()
    expect(parentFails.coverage.RUN_KEY?.state).toBe('FAILED')
  })

  it('parses services: direct subkeys only, Start mapped, ImagePath with spaces and quotes kept whole', async () => {
    const snap = await collector(fakeRun().run)()
    expect(snap.coverage.SERVICE).toEqual({ state: 'COMPLETE' })
    expect(of(snap.items, 'SERVICE')).toEqual([
      { id: 'AppSvc', startType: 'auto', binaryPath: '"C:\\Program Files\\App Co\\svc.exe" -k "net svc"' },
      { id: 'bootdrv', startType: 'boot', binaryPath: '\\SystemRoot\\System32\\drivers\\bootdrv.sys' },
      { id: 'sysdrv', startType: 'system' },
      { id: 'Manual Svc', startType: 'demand' },
      { id: 'Off', startType: 'disabled', binaryPath: 'C:\\Off Dir\\off.exe' },
    ])
  })

  it('a services listing with an unknown indented line is PARTIAL with a note', async () => {
    const odd = START.replace('    Start    REG_DWORD    0x1', '    Start    REG_DWORD    0x1\r\n    ???')
    const snap = await collector(fakeRun({ 'reg.exe query HKLM\\SYSTEM\\CurrentControlSet\\Services /s /v Start /reg:64': async () => ok(odd) }).run)()
    expect(snap.coverage.SERVICE?.state).toBe('PARTIAL')
    expect(snap.coverage.SERVICE?.note).toMatch(/could not be parsed/)
  })

  it('parses scheduled tasks from the XML, with several actions and the comment as fallback path', async () => {
    const snap = await collector(fakeRun().run)()
    expect(snap.coverage.SCHEDULED_TASK).toEqual({ state: 'COMPLETE' })
    expect(of(snap.items, 'SCHEDULED_TASK')).toEqual([
      {
        id: '\\Vendor\\Updater',
        actions: '"C:\\Program Files\\Vendor\\upd.exe" /check &quiet; C:\\Windows\\System32\\cmd.exe; com {11111111-2222-3333-4444-555555555555}',
      },
      { id: '\\NoUri', actions: 'C:\\x.exe' },
    ])
  })

  it.each([
    ['localized CSV', '"Nom de la tâche","Prochaine exécution","Statut"\r\n"\\Vendor\\Updater","N/A","Prêt"\r\n'],
    ['localized error text', 'ERREUR : Accès refusé.\r\n'],
    ['empty output', ''],
    ['unterminated document', '<?xml version="1.0"?>\r\n<Tasks>\r\n  <!-- \\A -->\r\n'],
    ['tasks without paths', '<Tasks><Task><Actions><Exec><Command>x</Command></Exec></Actions></Task></Tasks>'],
  ])('task output that does not have the expected shape (%s) is FAILED, never an empty COMPLETE set', async (_, stdout) => {
    const snap = await collector(fakeRun({ 'schtasks.exe /query /xml ONE': async () => ok(stdout) }).run)()
    expect(snap.coverage.SCHEDULED_TASK?.state).toBe('FAILED')
    expect(of(snap.items, 'SCHEDULED_TASK')).toEqual([])
    expect(snap.coverage.SERVICE?.state).toBe('COMPLETE')
  })

  it('a non-zero exit of the task query is FAILED', async () => {
    const snap = await collector(fakeRun({ 'schtasks.exe /query /xml ONE': async () => ({ exitCode: 1, stdout: TASKS }) }).run)()
    expect(snap.coverage.SCHEDULED_TASK?.state).toBe('FAILED')
  })

  it('task XML cut at the cap keeps the whole tasks and is PARTIAL', () => {
    const cut = TASKS.slice(0, TASKS.indexOf('<!-- \\NoUri -->') + 30)
    const r = parseTaskXml(cut, true)
    expect(r.state).toBe('PARTIAL')
    expect(r.items.map((i) => i.id)).toEqual(['\\Vendor\\Updater'])
  })

  it('a run that rejects makes only its surface FAILED', async () => {
    const snap = await collector(
      fakeRun({
        'schtasks.exe /query /xml ONE': async () => {
          throw new Error('spawn failed')
        },
      }).run,
    )()
    expect(snap.coverage.SCHEDULED_TASK?.state).toBe('FAILED')
    expect(snap.coverage.SCHEDULED_TASK?.note).toMatch(/spawn failed/)
    for (const s of ['SERVICE', 'RUN_KEY', 'STARTUP_FOLDER'] as const) expect(snap.coverage[s]?.state).toBe('COMPLETE')
  })

  it('a run that never resolves makes only its surface TIMED_OUT, within the deadline, and is aborted', async () => {
    let seen: AbortSignal | undefined
    const { run } = fakeRun({
      'schtasks.exe /query /xml ONE': (_f, _a, opts) => {
        seen = opts.signal
        return new Promise(() => {})
      },
    })
    const t0 = Date.now()
    const snap = await collector(run, { deadlineMs: 200 })()
    const elapsed = Date.now() - t0
    expect(elapsed).toBeGreaterThanOrEqual(190)
    expect(elapsed).toBeLessThan(450)
    expect(snap.coverage.SCHEDULED_TASK?.state).toBe('TIMED_OUT')
    for (const s of ['SERVICE', 'RUN_KEY', 'STARTUP_FOLDER'] as const) expect(snap.coverage[s]?.state).toBe('COMPLETE')
    expect(seen?.aborted).toBe(true)
  })

  it('a run that reports it was stopped is TIMED_OUT', async () => {
    const { run } = fakeRun({ 'reg.exe query HKLM\\SYSTEM\\CurrentControlSet\\Services /s /v Start /reg:64': async () => ({ exitCode: null, stdout: '', aborted: true }) })
    const snap = await collector(run)()
    expect(snap.coverage.SERVICE?.state).toBe('TIMED_OUT')
  })

  it('a cancelled snapshot resolves at once, with unfinished surfaces FAILED', async () => {
    const { run } = fakeRun({ 'schtasks.exe /query /xml ONE': () => new Promise(() => {}) })
    const ctl = new AbortController()
    const p = collector(run, { deadlineMs: 5000 })(ctl.signal)
    setTimeout(() => ctl.abort(), 20)
    const snap = await p
    expect(snap.durationMs).toBeLessThan(1000)
    expect(snap.coverage.SCHEDULED_TASK).toEqual({ state: 'FAILED', note: 'the snapshot was cancelled' })
  })

  it('hashes StartUp files with sha256 and compares files above the cap by size and mtime', async () => {
    const fs = fakeFs({ 'app.lnk': { content: 'link' }, 'big.exe': { size: 20 * MiB }, sub: { dir: true } })
    const snap = await createPersistenceCollector({ run: fakeRun().run, systemRoot: SYS, programData: 'C:\\ProgramData', ...fs.deps })()
    expect(of(snap.items, 'STARTUP_FOLDER')).toEqual([
      { id: `${SU}\\app.lnk`, size: '4', sha256: sha('link') },
      { id: `${SU}\\big.exe`, size: String(20 * MiB), mtime: '2026-01-02T00:00:00.000Z' },
    ])
    expect(fs.hashed).toEqual([`${SU}\\app.lnk`])
    expect(snap.coverage.STARTUP_FOLDER?.state).toBe('COMPLETE')
    expect(snap.coverage.STARTUP_FOLDER?.note).toMatch(/big\.exe/)
  })

  it('a missing StartUp folder is an empty COMPLETE set; an unreadable one is FAILED', async () => {
    const missing = await collector(fakeRun().run, { programData: 'D:\\Nowhere' })()
    expect(missing.coverage.STARTUP_FOLDER).toEqual({ state: 'COMPLETE' })
    const denied = await collector(fakeRun().run, {
      readDir: async () => {
        throw Object.assign(new Error('EPERM: denied'), { code: 'EPERM' })
      },
    })()
    expect(denied.coverage.STARTUP_FOLDER?.state).toBe('FAILED')
  })

  it('issues only read-only commands: reg.exe query, schtasks /query /xml, and fs reads', async () => {
    const { run, calls } = fakeRun()
    const fs = fakeFs()
    await createPersistenceCollector({ run, systemRoot: SYS, programData: 'C:\\ProgramData', ...fs.deps })()
    expect(calls.length).toBeGreaterThan(0)
    for (const c of calls) {
      const allowed = (c.file === REG && c.args[0] === 'query') || (c.file === SCHTASKS && c.args.join(' ') === '/query /xml ONE')
      expect(allowed, `${c.file} ${c.args.join(' ')}`).toBe(true)
      expect(c.args.join(' ')).not.toMatch(/\b(add|delete|import|export|save|restore|load|unload|copy|\/create|\/change|\/run|\/end)\b/i)
    }
    expect(fs.reads.every((r) => /^(readDir|stat) /.test(r))).toBe(true)
    const source = readFileSync(join(__dirname, '../../../src/main/modules/privilege/persistence-snapshot.ts'), 'utf8')
    expect(source).not.toMatch(/runas|broker|writeFile|appendFile|unlink|rmSync|\brm\(|mkdir|rename|createWriteStream|Verb RunAs/i)
  })
})

const live = process.platform === 'win32' && process.env.NEXUS_LIVE_PERSISTENCE === '1'

describe.skipIf(!live)('persistence collector (live, opt-in: NEXUS_LIVE_PERSISTENCE=1)', () => {
  it('takes one real snapshot with every surface COMPLETE within the deadline', async () => {
    const times: Partial<Record<PersistenceSurface, number>> = {}
    const snap = await createPersistenceCollector({ onSurfaceTime: (s, ms) => (times[s] = ms) })()
    console.log('persistence snapshot timings (ms):', JSON.stringify({ total: snap.durationMs, ...times }), JSON.stringify(snap.coverage))
    for (const s of ['SERVICE', 'SCHEDULED_TASK', 'RUN_KEY', 'STARTUP_FOLDER'] as const) expect(snap.coverage[s]?.state, s).toBe('COMPLETE')
    expect(snap.durationMs).toBeLessThan(2500 + 250)
  }, 10_000)
})
