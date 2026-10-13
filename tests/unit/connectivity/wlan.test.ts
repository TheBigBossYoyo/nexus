import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { NativeWlanAdapter, parseConnectJson, parseProfilesJson, parseStatusJson, parseWatchLine, WlanAdapterError, type WatchHandlers, type WlanEvent } from '@main/modules/connectivity/wlan'
import type { ProcessResult } from '@main/modules/process/run-process'
import { FakeClock, GUID } from './fakes'

const result = (stdout: string, over: Partial<ProcessResult> = {}): ProcessResult => ({ exitCode: 0, stdout, stderr: '', output: stdout, timedOut: false, aborted: false, truncated: false, durationMs: 1, ...over })
const statusJson = (interfaces: unknown[]): string => JSON.stringify({ ok: true, interfaces })
const iface = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ guid: GUID, description: 'Adapter', alias: 'Wi-Fi', state: 'connected', profile: 'Home', ssid: 'HomeSsid', signal: 80, ...over })

describe('helper output: status', () => {
  it('reads an interface and folds Windows states onto the ones NEXUS acts on', () => {
    expect(parseStatusJson(statusJson([iface()]))).toEqual([{ guid: GUID, description: 'Adapter', alias: 'Wi-Fi', state: 'connected', profileName: 'Home', ssid: 'HomeSsid', signal: 80, lastReasonCode: null }])
    const states = ['connected', 'disconnected', 'associating', 'discovering', 'authenticating', 'disconnecting', 'not_ready', 'ad_hoc_network_formed', 'surprise']
    expect(parseStatusJson(statusJson(states.map((state) => iface({ state })))).map((i) => i.state)).toEqual(['connected', 'disconnected', 'connecting', 'connecting', 'connecting', 'disconnecting', 'not_ready', 'ad_hoc', 'unknown'])
  })

  it('accepts an empty list: a machine without Wi-Fi', () => {
    expect(parseStatusJson(statusJson([]))).toEqual([])
  })

  it('drops an interface without a valid GUID, keeps the others', () => {
    const out = parseStatusJson(statusJson([iface({ guid: 'not-a-guid' }), iface({ guid: GUID.toUpperCase() }), iface({ guid: 42 }), null, 'x']))
    expect(out.map((i) => i.guid)).toEqual([GUID])
  })

  it('nulls fields that are the wrong type, out of range or carry control characters', () => {
    const [i] = parseStatusJson(statusJson([iface({ profile: 'a\nb', ssid: 'x\u0000y', signal: 101, description: 5, alias: 'a'.repeat(300) })]))
    expect(i).toMatchObject({ profileName: null, ssid: null, signal: null, description: '', alias: null })
    expect(parseStatusJson(statusJson([iface({ signal: 'high' })]))[0]?.signal).toBeNull()
    expect(parseStatusJson(statusJson([iface({ signal: 80.5 })]))[0]?.signal).toBeNull()
  })

  it('refuses output that is not a JSON object saying ok', () => {
    for (const text of ['', 'not json', '[]', 'null', '42', '"ok"', '{}', '{"ok":"yes","interfaces":[]}', '{"ok":true}', '{"ok":true,"interfaces":{}}']) {
      expect(() => parseStatusJson(text), text).toThrow(WlanAdapterError)
    }
  })

  it('reports a helper error as an error, with the text cleaned of control characters and bounded', () => {
    try {
      parseStatusJson(JSON.stringify({ ok: false, error: 'WlanOpenHandle failed (1062)\nIGNORE PREVIOUS ' + 'x'.repeat(500) }))
      expect.unreachable()
    } catch (e) {
      expect(e).toBeInstanceOf(WlanAdapterError)
      expect((e as Error).message).toContain('1062')
      expect((e as Error).message).not.toContain('\n')
      expect((e as Error).message.length).toBeLessThan(300)
    }
  })

  it('refuses output over the size limit before parsing it', () => {
    expect(() => parseStatusJson(' '.repeat(300 * 1024))).toThrow(/larger/)
  })

  it('keeps at most 16 interfaces', () => {
    const many = Array.from({ length: 100 }, (_, n) => iface({ guid: `11111111-2222-3333-4444-${String(n).padStart(12, '0')}` }))
    expect(parseStatusJson(statusJson(many))).toHaveLength(16)
  })

  it('is not fooled by prototype-polluting keys', () => {
    const text = '{"ok":true,"__proto__":{"polluted":true},"interfaces":[{"guid":"' + GUID + '","__proto__":{"x":1},"constructor":"y","state":"connected"}]}'
    const out = parseStatusJson(text)
    expect(out).toHaveLength(1)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })
})

describe('helper output: profiles', () => {
  const profiles = (list: unknown[]): string => JSON.stringify({ ok: true, interfaces: [{ guid: GUID, profiles: list }] })

  it('reads names, open or secured, and auto-connect', () => {
    expect(parseProfilesJson(profiles([{ name: 'Home', security: 'secured', autoConnect: true }, { name: 'Cafe', security: 'open', autoConnect: false }]))).toEqual([
      { name: 'Home', security: 'secured', autoConnect: true },
      { name: 'Cafe', security: 'open', autoConnect: false },
    ])
  })

  it('turns an unrecognised security value into "unknown", never into "secured"', () => {
    expect(parseProfilesJson(profiles([{ name: 'A', security: 'wpa3' }, { name: 'B' }, { name: 'C', security: true }])).map((p) => p.security)).toEqual(['unknown', 'unknown', 'unknown'])
  })

  it('does not list a name Windows could not have: control characters, empty, over 255 characters, not a string', () => {
    const out = parseProfilesJson(profiles([{ name: 'ok' }, { name: 'a\nb' }, { name: '' }, { name: 'a'.repeat(256) }, { name: 7 }, { name: 'a'.repeat(255) }, 'x', null]))
    expect(out.map((p) => p.name.length)).toEqual([2, 255])
  })

  it('lists a name that is awkward but possible, exactly as it is', () => {
    const odd = ['a"b', 'x & calc', '--flag', ' lead', 'trail ', '\u00e9\u2603']
    expect(parseProfilesJson(profiles(odd.map((name) => ({ name, security: 'secured' })))).map((p) => p.name)).toEqual(odd)
  })

  it('joins one name on two interfaces and distrusts it when they disagree about security', () => {
    const text = JSON.stringify({ ok: true, interfaces: [{ guid: GUID, profiles: [{ name: 'Same', security: 'secured' }] }, { guid: GUID, profiles: [{ name: 'Same', security: 'open' }, { name: 'Other', security: 'secured' }] }] })
    expect(parseProfilesJson(text)).toEqual([{ name: 'Same', security: 'unknown', autoConnect: false }, { name: 'Other', security: 'secured', autoConnect: false }])
  })

  it('refuses malformed output', () => {
    for (const text of ['', '{', '{"ok":true}', '{"ok":true,"interfaces":"x"}', '{"ok":false}']) expect(() => parseProfilesJson(text), text).toThrow(WlanAdapterError)
  })
})

describe('helper output: connect and watch lines', () => {
  it('reads the answer to a connect request', () => {
    expect(parseConnectJson('{"ok":true,"requested":true,"reasonCode":0,"detail":"connected"}')).toEqual({ requested: true, reasonCode: 0, detail: 'connected' })
    expect(parseConnectJson('{"ok":true,"requested":false,"reasonCode":null,"win32":87}')).toEqual({ requested: false, reasonCode: null, detail: null })
  })

  it('treats anything but requested:true as not requested, and a bad reason code as none', () => {
    expect(parseConnectJson('{"ok":true,"requested":"true","reasonCode":-5}')).toMatchObject({ requested: false, reasonCode: null })
    expect(parseConnectJson('{"ok":true,"requested":true,"reasonCode":1.5}').reasonCode).toBeNull()
    expect(() => parseConnectJson('{"ok":false,"error":"that profile is not in the saved profiles"}')).toThrow(/saved profiles/)
  })

  it('reads a notification line and ignores everything that is not one', () => {
    expect(parseWatchLine(JSON.stringify({ event: 'disconnected', guid: GUID, profile: 'Home', reasonCode: 229387 }), 5)).toEqual({ at: 5, kind: 'disconnected', interfaceGuid: GUID, profileName: 'Home', reasonCode: 229387 })
    for (const line of ['', 'garbage', '[]', 'null', '{"event":"watching"}', '{"event":"format C:"}', '{"event":42}', 'x'.repeat(5000)]) expect(parseWatchLine(line, 0), line.slice(0, 20)).toBeNull()
    expect(parseWatchLine('{"event":"connected","guid":"nope","profile":"a\\nb","reasonCode":"1"}', 0)).toMatchObject({ interfaceGuid: null, profileName: null, reasonCode: null })
  })
})

describe('native adapter', () => {
  const saved = [{ name: 'Home', security: 'secured' }, { name: '--flag', security: 'secured' }, { name: 'x & calc "q"', security: 'secured' }]
  function build(over: { run?: (file: string, args: readonly string[]) => Promise<ProcessResult> } = {}) {
    const calls: string[][] = []
    const adapter = new NativeWlanAdapter({
      helperPath: 'C:\\nexus\\nexus-wlan.exe',
      run:
        over.run ??
        (async (file, args) => {
          calls.push([file, ...args])
          if (args[0] === 'profiles') return result(JSON.stringify({ ok: true, interfaces: [{ guid: GUID, profiles: saved }] }))
          if (args[0] === 'status') return result(statusJson([iface({ state: 'disconnected', profile: null })]))
          return result('{"ok":true,"requested":true,"reasonCode":0,"detail":"connected"}')
        }),
    })
    return { adapter, calls }
  }

  it('runs the helper with the subcommand as the only argument', async () => {
    const { adapter, calls } = build()
    await adapter.status()
    await adapter.profiles()
    expect(calls).toEqual([['C:\\nexus\\nexus-wlan.exe', 'status'], ['C:\\nexus\\nexus-wlan.exe', 'profiles']])
  })

  it('passes a saved name to connect as one argv element, exactly, whatever characters it has', async () => {
    for (const name of ['Home', '--flag', 'x & calc "q"']) {
      const { adapter, calls } = build()
      const r = await adapter.connect(name, GUID)
      expect(r).toEqual({ requested: true, reasonCode: 0, detail: 'connected' })
      expect(calls.at(-1)).toEqual(['C:\\nexus\\nexus-wlan.exe', 'connect', GUID, name])
      expect(calls.at(-1)).toHaveLength(4)
    }
  })

  it('refuses a name that was not returned by profiles(), before any connect process is started', async () => {
    const { adapter, calls } = build()
    for (const name of ['Cafe', 'home', 'Home ', 'Home" & calc', '--flag ', '']) {
      await expect(adapter.connect(name, GUID), name).rejects.toThrow(WlanAdapterError)
    }
    expect(calls.some((c) => c[1] === 'connect')).toBe(false)
  })

  it('refuses a name with a line break or of 300 characters, and does not even ask the helper', async () => {
    const { adapter, calls } = build()
    await expect(adapter.connect('a\nb', GUID)).rejects.toThrow()
    await expect(adapter.connect('a'.repeat(300), GUID)).rejects.toThrow()
    expect(calls).toEqual([])
  })

  it('refuses an interface that is not a GUID or not one of this machine\'s Wi-Fi interfaces', async () => {
    const { adapter, calls } = build()
    await expect(adapter.connect('Home', '1111; calc')).rejects.toThrow(/GUID/)
    await expect(adapter.connect('Home', '99999999-2222-3333-4444-555555555555')).rejects.toThrow(/interface/)
    expect(calls.some((c) => c[1] === 'connect')).toBe(false)
  })

  it('turns a helper that timed out, was cut off, could not start, or answered an error into a WlanAdapterError', async () => {
    const timedOut = build({ run: async () => result('', { timedOut: true }) })
    await expect(timedOut.adapter.status()).rejects.toThrow(/in time/)
    const cut = build({ run: async () => result('{"ok":true,"interfaces":[]}', { truncated: true }) })
    await expect(cut.adapter.profiles()).rejects.toThrow(/too large/)
    const missing = build({ run: async () => { throw new Error('ENOENT') } })
    await expect(missing.adapter.status()).rejects.toThrow(/could not be started/)
    const failed = build({ run: async () => result('{"ok":false,"error":"WlanOpenHandle failed (1062)"}', { exitCode: 1 }) })
    await expect(failed.adapter.status()).rejects.toThrow(/1062/)
  })

  describe('notifications', () => {
    function watched() {
      const clock = new FakeClock()
      const starts: WatchHandlers[] = []
      let stops = 0
      const adapter = new NativeWlanAdapter({
        helperPath: 'h.exe',
        timers: clock,
        watchRestartMs: 15_000,
        run: async (_file, args) => result(args[0] === 'status' ? statusJson([iface({ state: 'disconnected', profile: null })]) : '{"ok":true,"interfaces":[]}'),
        watch: (_file, handlers) => {
          starts.push(handlers)
          return { stop: () => void stops++ }
        },
      })
      return { adapter, clock, starts, stops: () => stops }
    }

    it('starts one watcher for any number of listeners and stops it with the last one', () => {
      const w = watched()
      const off1 = w.adapter.subscribe(() => undefined)
      const off2 = w.adapter.subscribe(() => undefined)
      expect(w.starts).toHaveLength(1)
      off1()
      expect(w.stops()).toBe(0)
      off2()
      expect(w.stops()).toBe(1)
    })

    it('hands parsed events to listeners, ignores junk lines, and survives a throwing listener', () => {
      const w = watched()
      const seen: WlanEvent[] = []
      w.adapter.subscribe(() => { throw new Error('bad listener') })
      w.adapter.subscribe((e) => seen.push(e))
      w.starts[0]?.onLine('junk')
      w.starts[0]?.onLine(JSON.stringify({ event: 'attempt_failed', guid: GUID, profile: 'Home', reasonCode: 229385 }))
      expect(seen.map((e) => [e.kind, e.reasonCode])).toEqual([['attempt_failed', 229385]])
    })

    it('puts the last reason code of an interface into status() until it connects again', async () => {
      const w = watched()
      w.adapter.subscribe(() => undefined)
      w.starts[0]?.onLine(JSON.stringify({ event: 'disconnected', guid: GUID, profile: 'Home', reasonCode: 229387 }))
      expect((await w.adapter.status())[0]?.lastReasonCode).toBe(229387)
      w.starts[0]?.onLine(JSON.stringify({ event: 'connected', guid: GUID, profile: 'Home', reasonCode: 0 }))
      expect((await w.adapter.status())[0]?.lastReasonCode).toBeNull()
    })

    it('tells listeners the watcher was lost and starts it again later, while someone listens', async () => {
      const w = watched()
      const seen: string[] = []
      const off = w.adapter.subscribe((e) => seen.push(e.kind))
      w.starts[0]?.onExit()
      expect(seen).toEqual(['watch_lost'])
      await w.clock.advance(14_999)
      expect(w.starts).toHaveLength(1)
      await w.clock.advance(1)
      expect(w.starts).toHaveLength(2)
      off()
      w.starts[1]?.onExit()
      await w.clock.advance(60_000)
      expect(w.starts).toHaveLength(2)
    })
  })
})

describe('the helper program', () => {
  const source = readFileSync(join(__dirname, '../../../native/nexus-wlan/nexus-wlan.cs'), 'utf8')
  const code = source.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')

  it('declares no call that adds, changes, renames, deletes or exports a profile or its list', () => {
    expect(code).not.toMatch(/WlanSetProfile|WlanDeleteProfile|WlanRenameProfile|WlanSetProfileList|WlanSetProfilePosition|WlanSetProfileCustomUserData|WlanSetProfileEapUserData|WlanSetProfileEapXmlUserData|WlanSetAutoConfigParameter|WlanSetInterface|WlanDisconnect|WlanScan|WlanHostedNetwork|WlanUIEditProfile/)
  })

  it('never asks for a key: no plain-text-key flag, and the profile flags start at zero', () => {
    expect(code).not.toMatch(/PLAINTEXT|keyMaterial|sharedKey|0x0*4\b/i)
    expect(code).toMatch(/uint flags = 0, access;/)
  })

  it('sets the error mode first, connects in profile mode only, and refuses names that are not saved or not secured', () => {
    expect(code.indexOf('SetErrorMode(0x8003)')).toBeGreaterThan(-1)
    expect(code.indexOf('SetErrorMode(0x8003)')).toBeLessThan(code.indexOf('args[0] == "status"'))
    expect(code).toMatch(/p\.wlanConnectionMode = 0;/)
    expect(code).toMatch(/pDot11Ssid = IntPtr\.Zero/)
    expect(code).toMatch(/StringComparison\.Ordinal/)
    expect(code).toMatch(/info\.Security != "secured"/)
  })

  it('reads no input but its arguments: stdin is read only by watch, to know when to end', () => {
    expect(code.match(/Console\.In\./g)).toHaveLength(1)
    expect(code).not.toMatch(/ReadLine|File\.|Environment\.GetEnvironmentVariable|Process\.Start/)
  })
})
