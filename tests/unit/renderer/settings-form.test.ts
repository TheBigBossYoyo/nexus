import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/settings'
import {
  buildMcpServer,
  isQuietCommandsOn,
  isSameSettings,
  normalizeSettings,
  quietCommandsPatch,
  validateSettings,
} from '../../../src/renderer/src/views/settings/settingsForm'

const clone = () => structuredClone(DEFAULT_SETTINGS)

describe('settings form', () => {
  it('accepts the defaults', () => {
    expect(validateSettings(clone()).ok).toBe(true)
  })

  it('reports errors keyed by dotted path', () => {
    const s = clone()
    s.execution.maxIterations = 0
    s.execution.maxParallelAgents = 99
    const v = validateSettings(s)
    expect(v.ok).toBe(false)
    if (!v.ok) {
      expect(Object.keys(v.errors)).toEqual(
        expect.arrayContaining(['execution.maxIterations', 'execution.maxParallelAgents']),
      )
    }
  })

  it('normalizes free text and blank prefixes before validating', () => {
    const s = clone()
    s.permissions.safeCommandPrefixes = [' pnpm test ', '', '  ']
    s.claude.executablePath = '  C:\\claude.exe '
    const n = normalizeSettings(s)
    expect(n.permissions.safeCommandPrefixes).toEqual(['pnpm test'])
    expect(n.claude.executablePath).toBe('C:\\claude.exe')
    expect(isSameSettings(n, clone())).toBe(false)
    expect(isSameSettings(clone(), clone())).toBe(true)
  })

  it('adds MCP servers disabled and with no role access', () => {
    const r = buildMcpServer({ name: 'github', type: 'stdio', command: 'npx', args: '-y\n\n pkg ', url: '' }, [])
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.server).toMatchObject({ name: 'github', enabled: false, roles: [], command: 'npx', args: ['-y', 'pkg'] })
    }
  })

  it('rejects duplicate names, missing command/url and bad names', () => {
    const existing = [{ name: 'gh', type: 'http' as const, url: 'https://x', enabled: false, roles: [] }]
    expect(buildMcpServer({ name: 'GH', type: 'http', command: '', args: '', url: 'https://y' }, existing).ok).toBe(false)
    expect(buildMcpServer({ name: 'a', type: 'stdio', command: ' ', args: '', url: '' }, []).ok).toBe(false)
    expect(buildMcpServer({ name: 'a', type: 'sse', command: '', args: '', url: '' }, []).ok).toBe(false)
    expect(buildMcpServer({ name: 'bad name', type: 'http', command: '', args: '', url: 'https://y' }, []).ok).toBe(false)
  })

  it('defaults to the light theme and validates the usage behavior section', () => {
    const s = clone()
    expect(s.appearance.theme).toBe('light')
    expect(s.usage.autoResume).toBe(true)
    expect(validateSettings(s).ok).toBe(true)
  })

  it('reports usage errors under usage.* and keeps the same object shape', () => {
    const s = clone()
    s.usage.resumeDelaySeconds = 5
    s.usage.maxQuotaWaitMinutes = -1
    const v = validateSettings(s)
    expect(v.ok).toBe(false)
    if (!v.ok) expect(Object.keys(v.errors)).toEqual(expect.arrayContaining(['usage.resumeDelaySeconds', 'usage.maxQuotaWaitMinutes']))
  })

  it('rejects a maximum probe interval below the first interval', () => {
    const s = clone()
    s.usage.unknownResetProbeMinutes = 30
    s.usage.unknownResetProbeMaxMinutes = 10
    const v = validateSettings(s)
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.errors['usage.unknownResetProbeMaxMinutes']).toMatch(/at least/)
    s.usage.unknownResetProbeMaxMinutes = 30
    expect(validateSettings(s).ok).toBe(true)
  })

  it('treats 0 as a valid maximum quota wait (inherit the mission deadline)', () => {
    const s = clone()
    s.usage.maxQuotaWaitMinutes = 0
    expect(validateSettings(s).ok).toBe(true)
  })
})

describe('quiet commands switch', () => {
  it('reads as checked when the value is absent or true, unchecked only when false', () => {
    const s = clone()
    delete s.execution.quietCommands
    expect(isQuietCommandsOn(s.execution)).toBe(true)
    expect(isQuietCommandsOn({ ...s.execution, quietCommands: true })).toBe(true)
    expect(isQuietCommandsOn({ ...s.execution, quietCommands: false })).toBe(false)
  })

  it('saves an explicit false when unticked and true when ticked again', () => {
    const s = clone()
    delete s.execution.quietCommands
    const off = { ...s, execution: { ...s.execution, ...quietCommandsPatch(false) } }
    expect(normalizeSettings(off).execution.quietCommands).toBe(false)
    expect(validateSettings(normalizeSettings(off)).ok).toBe(true)
    const on = { ...off, execution: { ...off.execution, ...quietCommandsPatch(true) } }
    expect(normalizeSettings(on).execution.quietCommands).toBe(true)
  })
})
