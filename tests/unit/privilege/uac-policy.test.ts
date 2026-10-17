import { describe, expect, it } from 'vitest'
import { createUacPolicyReader, parseUacPolicy, uacWarning, UAC_POLICY_KEY } from '@main/modules/privilege/uac-policy'

const listing = (lua: string | null, consent: string | null): string =>
  [
    '',
    'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System',
    '    DisableCAD    REG_DWORD    0x1',
    ...(lua === null ? [] : [`    EnableLUA    REG_DWORD    ${lua}`]),
    ...(consent === null ? [] : [`    ConsentPromptBehaviorAdmin    REG_DWORD    ${consent}`]),
    '',
  ].join('\r\n')

describe('parseUacPolicy', () => {
  it('reads REG_DWORD values', () => {
    expect(parseUacPolicy(listing('0x0', '0x5'))).toEqual({ enableLua: 0, consentPromptBehaviorAdmin: 5 })
    expect(parseUacPolicy(listing('0x1', '0x0'))).toEqual({ enableLua: 1, consentPromptBehaviorAdmin: 0 })
  })
  it('gives null for missing, malformed or wrongly typed values', () => {
    expect(parseUacPolicy(listing(null, null))).toEqual({ enableLua: null, consentPromptBehaviorAdmin: null })
    expect(parseUacPolicy(listing('zero', '0xZZ'))).toEqual({ enableLua: null, consentPromptBehaviorAdmin: null })
    expect(parseUacPolicy('garbage\n\u0000 ???')).toEqual({ enableLua: null, consentPromptBehaviorAdmin: null })
    expect(parseUacPolicy('')).toEqual({ enableLua: null, consentPromptBehaviorAdmin: null })
  })
})

describe('uacWarning', () => {
  it('warns only when EnableLUA or ConsentPromptBehaviorAdmin is 0', () => {
    const w = uacWarning({ enableLua: 0, consentPromptBehaviorAdmin: 5 })
    expect(w).toMatch(/will not show a UAC prompt/)
    expect(w).toMatch(/confirmation in NEXUS is the only consent/)
    expect(uacWarning({ enableLua: 1, consentPromptBehaviorAdmin: 0 })).toBe(w)
    expect(uacWarning({ enableLua: 1, consentPromptBehaviorAdmin: 5 })).toBeNull()
    expect(uacWarning({ enableLua: null, consentPromptBehaviorAdmin: null })).toBeNull()
  })
})

describe('createUacPolicyReader', () => {
  it('runs reg.exe with the query verb only and parses the result', async () => {
    const calls: Array<[string, readonly string[]]> = []
    const read = createUacPolicyReader({
      systemRoot: 'C:\\Windows',
      run: async (file, args) => (calls.push([file, args]), { exitCode: 0, stdout: listing('0x0', '0x5') }),
    })
    expect(await read()).toEqual({ enableLua: 0, consentPromptBehaviorAdmin: 5 })
    expect(calls).toEqual([['C:\\Windows\\System32\\reg.exe', ['query', UAC_POLICY_KEY]]])
  })
  // Merge review: the Admin access panel polls privilege.status, which started one reg.exe per poll.
  it('reads the registry at most once a minute', async () => {
    let clock = 0
    let calls = 0
    const read = createUacPolicyReader({ systemRoot: 'C:\\Windows', now: () => clock, run: async () => (calls++, { exitCode: 0, stdout: listing('0x1', '0x5') }) })
    await Promise.all([read(), read()])
    clock = 59_999
    await read()
    expect(calls).toBe(1)
    clock = 60_000
    expect(await read()).toEqual({ enableLua: 1, consentPromptBehaviorAdmin: 5 })
    expect(calls).toBe(2)
  })
  it('gives no policy on a non-zero exit, a timeout or a throw', async () => {
    const none = { enableLua: null, consentPromptBehaviorAdmin: null }
    expect(await createUacPolicyReader({ systemRoot: 'C:\\Windows', run: async () => ({ exitCode: 1, stdout: listing('0x0', '0x0') }) })()).toEqual(none)
    expect(await createUacPolicyReader({ systemRoot: 'C:\\Windows', run: async () => ({ exitCode: 0, stdout: listing('0x0', '0x0'), timedOut: true }) })()).toEqual(none)
    expect(await createUacPolicyReader({ systemRoot: 'C:\\Windows', run: async () => { throw new Error('no reg') } })()).toEqual(none)
  })
})

// Opt-in: reads the real registry (read-only).
describe.skipIf(process.platform !== 'win32' || process.env.NEXUS_REAL_REGISTRY_TEST !== '1')('real registry', () => {
  it('returns numbers or null without throwing', async () => {
    const p = await createUacPolicyReader({ systemRoot: process.env.SystemRoot ?? 'C:\\Windows' })()
    for (const v of [p.enableLua, p.consentPromptBehaviorAdmin]) expect(v === null || typeof v === 'number').toBe(true)
  })
})
