import { describe, expect, it } from 'vitest'
import { PERSISTENCE_CAPABILITIES, diffPersistence, isExpected, persistenceObservedLines } from '@main/modules/privilege/persistence'
import type { PersistenceCoverage, PersistenceItem, PersistenceSnapshot } from '@shared/privilege'

// Fixtures only: no live machine state.

const RUN = 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run'
const RUN32 = 'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Run'
const RUNONCE = 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\RunOnce'
const SU = 'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\StartUp'
const none = { files: [], registry: [], services: [], network: 'none' }

const svc = (id: string, startType = 'auto', binaryPath = 'C:\\x.exe'): PersistenceItem => ({ surface: 'SERVICE', id, attrs: { startType, binaryPath } })
const task = (id: string, actions = 'C:\\t.exe'): PersistenceItem => ({ surface: 'SCHEDULED_TASK', id, attrs: { actions } })
const run = (id: string, data = 'C:\\r.exe'): PersistenceItem => ({ surface: 'RUN_KEY', id, attrs: { data } })
const su = (id: string, sha256 = 'aa', size = '10'): PersistenceItem => ({ surface: 'STARTUP_FOLDER', id, attrs: { size, sha256 } })
const snap = (items: PersistenceItem[], coverage: PersistenceCoverage = {}): PersistenceSnapshot => ({ takenAt: '2026-01-01T00:00:00Z', durationMs: 5, items, coverage })

describe('diffPersistence', () => {
  it('reports added, removed, changed and ignores unchanged on every surface', () => {
    const before = snap([svc('Rem'), svc('Same'), svc('Chg'), task('\\F\\Rem'), task('\\F\\Same'), run(`${RUN}\\Rem`), run(`${RUN}\\Same`), su(`${SU}\\rem.lnk`), su(`${SU}\\same.lnk`)])
    const after = snap([svc('New'), svc('Same'), svc('Chg', 'disabled'), task('\\F\\New'), task('\\F\\Same'), run(`${RUN}\\New`), run(`${RUN}\\Same`), su(`${SU}\\new.lnk`), su(`${SU}\\same.lnk`)])
    const r = diffPersistence(before, after, none)
    expect(r.changes.map((c) => `${c.surface}:${c.id}:${c.change}`)).toEqual([
      'SERVICE:Chg:CHANGED',
      'SERVICE:New:ADDED',
      'SERVICE:Rem:REMOVED',
      'SCHEDULED_TASK:\\F\\New:ADDED',
      'SCHEDULED_TASK:\\F\\Rem:REMOVED',
      `RUN_KEY:${RUN}\\New:ADDED`,
      `RUN_KEY:${RUN}\\Rem:REMOVED`,
      `STARTUP_FOLDER:${SU}\\new.lnk:ADDED`,
      `STARTUP_FOLDER:${SU}\\rem.lnk:REMOVED`,
    ])
    expect(r.unexpected).toBe(9)
  })

  it('detects service start-type and binary-path changes with before/after', () => {
    const r = diffPersistence(snap([svc('A', 'auto', 'C:\\a.exe'), svc('B', 'auto', 'C:\\b.exe')]), snap([svc('A', 'manual', 'C:\\a.exe'), svc('B', 'auto', 'C:\\evil.exe')]), none)
    expect(r.changes).toHaveLength(2)
    expect(r.changes[0]).toMatchObject({ id: 'A', change: 'CHANGED', before: { startType: 'auto' }, after: { startType: 'manual' } })
    expect(r.changes[1].after?.binaryPath).toBe('C:\\evil.exe')
  })

  it('detects removed Run values in the 64-bit and WOW6432Node views, and a RunOnce addition', () => {
    const r = diffPersistence(snap([run(`${RUN}\\A`), run(`${RUN32}\\B`)]), snap([run(`${RUNONCE}\\C`)]), none)
    expect(r.changes.map((c) => `${c.change}:${c.id}`).sort()).toEqual([`ADDED:${RUNONCE}\\C`, `REMOVED:${RUN32}\\B`, `REMOVED:${RUN}\\A`].sort())
  })

  it('detects a StartUp file whose sha256 changed under the same name', () => {
    const r = diffPersistence(snap([su(`${SU}\\a.cmd`, 'aa')]), snap([su(`${SU}\\A.CMD`, 'bb')]), none)
    expect(r.changes).toHaveLength(1)
    expect(r.changes[0]).toMatchObject({ change: 'CHANGED', before: { sha256: 'aa' }, after: { sha256: 'bb' } })
  })

  it('compares ids case-insensitively', () => {
    expect(diffPersistence(snap([svc('Foo')]), snap([svc('FOO')]), none).changes).toEqual([])
  })

  it('gives an identical result for shuffled input', () => {
    const b = [svc('A'), svc('B'), task('\\T'), run(`${RUN}\\R`), su(`${SU}\\s`), svc('Gone')]
    const a = [svc('A', 'manual'), svc('C'), task('\\T2'), run(`${RUN32}\\Q`), su(`${SU}\\s`, 'zz'), svc('B')]
    const r1 = diffPersistence(snap(b), snap(a), none)
    const r2 = diffPersistence(snap([...b].reverse()), snap([a[3], a[0], a[5], a[1], a[4], a[2]]), none)
    expect(JSON.stringify(r2)).toBe(JSON.stringify(r1))
  })
})

describe('expected matching', () => {
  it('marks declared changes expected and undeclared ones not, counting unexpected', () => {
    const r = diffPersistence(snap([]), snap([svc('Foo'), svc('Bar')]), { ...none, services: ['foo'] })
    expect(r.changes.find((c) => c.id === 'Foo')?.expected).toBe(true)
    expect(r.changes.find((c) => c.id === 'Bar')?.expected).toBe(false)
    expect(r.unexpected).toBe(1)
  })

  it('covers an expected REMOVED service on uninstall, and tasks by full path', () => {
    const r = diffPersistence(snap([svc('Foo'), task('\\F\\T')]), snap([]), { ...none, services: ['Foo', '\\F\\T'] })
    expect(r.changes.every((c) => c.change === 'REMOVED' && c.expected)).toBe(true)
    expect(r.unexpected).toBe(0)
  })

  it('treats HKLM and HKEY_LOCAL_MACHINE as equal but requires the exact view', () => {
    const c = { surface: 'RUN_KEY' as const, id: `${RUN}\\V` }
    expect(isExpected(c, { ...none, registry: [`HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run\\v`] })).toBe(true)
    expect(isExpected(c, { ...none, registry: [`${RUN32}\\V`] })).toBe(false)
    expect(isExpected({ surface: 'RUN_KEY', id: `${RUN32}\\V` }, { ...none, registry: [`${RUN}\\V`] })).toBe(false)
  })

  it('does not let a bare Run key or a bare StartUp folder cover items under it', () => {
    const exp = { ...none, registry: [RUN, RUN32, RUNONCE], files: [SU] }
    const r = diffPersistence(snap([]), snap([run(`${RUN}\\V`), run(`${RUN32}\\V`), su(`${SU}\\f.lnk`)]), exp)
    expect(r.changes).toHaveLength(3)
    expect(r.unexpected).toBe(3)
  })

  it('covers a StartUp file by its full path', () => {
    expect(isExpected({ surface: 'STARTUP_FOLDER', id: `${SU}\\f.lnk` }, { ...none, files: [`${SU}\\F.LNK`] })).toBe(true)
  })
})

describe('coverage', () => {
  it.each(['FAILED', 'TIMED_OUT'] as const)('%s on either side yields no changes for that surface and a coverage line', (state) => {
    const items = [svc('A')]
    for (const side of ['before', 'after'] as const) {
      const cov: PersistenceCoverage = { SERVICE: { state, note: 'denied' } }
      const r = diffPersistence(snap(side === 'before' ? [] : items, side === 'before' ? cov : {}), snap(side === 'before' ? items : [], side === 'after' ? cov : {}), none)
      expect(r.changes).toEqual([])
      expect(persistenceObservedLines(r).join('\n')).toContain(state)
    }
  })

  it('PARTIAL yields no ADDED/REMOVED for items missing on the partial side but still CHANGED', () => {
    const partial: PersistenceCoverage = { SERVICE: { state: 'PARTIAL' } }
    const r = diffPersistence(snap([svc('Gone'), svc('Chg')], partial), snap([svc('New'), svc('Chg', 'disabled')]), none)
    // before is partial: "New" may simply have been missed before, so no ADDED; "Gone" is really absent after.
    expect(r.changes.map((c) => `${c.id}:${c.change}`)).toEqual(['Chg:CHANGED', 'Gone:REMOVED'])
    // after is partial: "Gone" may simply be missed after, so no REMOVED.
    const r2 = diffPersistence(snap([svc('Gone')]), snap([svc('New')], partial), none)
    expect(r2.changes.map((c) => `${c.id}:${c.change}`)).toEqual(['New:ADDED'])
    expect(persistenceObservedLines(r2).some((l) => l.includes('PARTIAL'))).toBe(true)
  })

  it('does not suppress other surfaces', () => {
    const r = diffPersistence(snap([], { SERVICE: { state: 'FAILED' } }), snap([svc('A'), task('\\T')]), none)
    expect(r.changes.map((c) => c.id)).toEqual(['\\T'])
  })
})

describe('persistenceObservedLines', () => {
  it('formats and marks unexpected changes', () => {
    const r = diffPersistence(snap([]), snap([svc('Foo')]), none)
    expect(persistenceObservedLines(r)).toEqual(['Persistence (observed during the operation): service Foo ADDED (binary C:\\x.exe, start auto) — UNEXPECTED (not declared)'])
  })

  it('does not mark expected changes UNEXPECTED', () => {
    const r = diffPersistence(snap([]), snap([svc('Foo')]), { ...none, services: ['Foo'] })
    expect(persistenceObservedLines(r)[0]).not.toContain('UNEXPECTED')
  })

  it('redacts secrets', () => {
    const r = diffPersistence(snap([]), snap([run(`${RUN}\\V`, 'app.exe --password hunter2')]), none)
    expect(persistenceObservedLines(r).join('')).not.toContain('hunter2')
  })

  it('caps at 40 lines plus "and N more"', () => {
    const items = Array.from({ length: 55 }, (_, i) => svc(`S${String(i).padStart(2, '0')}`))
    const lines = persistenceObservedLines(diffPersistence(snap([]), snap(items), none))
    expect(lines).toHaveLength(41)
    expect(lines[40]).toBe('and 15 more')
  })
})

describe('PERSISTENCE_CAPABILITIES', () => {
  it('has exactly the five install/repair/uninstall capabilities', () => {
    expect([...PERSISTENCE_CAPABILITIES].sort()).toEqual(['APP_INSTALL_TEST', 'APP_UNINSTALL_TEST', 'KNOWN_DEPENDENCY_MACHINE_INSTALL', 'PROJECT_TOOLCHAIN_INSTALL', 'PROJECT_TOOLCHAIN_REPAIR'])
    for (const c of ['PROJECT_TOOLCHAIN_INSTALL', 'KNOWN_DEPENDENCY_MACHINE_INSTALL', 'PROJECT_TOOLCHAIN_REPAIR', 'APP_INSTALL_TEST', 'APP_UNINSTALL_TEST'] as const) {
      expect(PERSISTENCE_CAPABILITIES.has(c)).toBe(true)
    }
    expect(PERSISTENCE_CAPABILITIES.has('PROJECT_SERVICE_CONTROL')).toBe(false)
  })
})
