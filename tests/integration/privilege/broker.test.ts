import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createHash, createHmac } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { ElevatedBrokerClient } from '@main/modules/privilege/broker-client'

// 0.9.1: the real broker (native/nexus-elevate) in its unelevated test mode: the same program, protocol and checks,
// without the UAC prompt. What these tests show: only the relay that started the broker reaches it, every line is
// numbered and signed, the broker ends with the runtime, its relay, its time or when told, and it ends what it
// started. What they do not show: elevation itself (the acceptance with the owner does), and a low-integrity or
// AppContainer client (the pipe's access list; scripts/privilege-acceptance.mjs probes it from the sandbox).

const available = process.platform === 'win32'
const root = resolve('test-results/privilege-broker')
let helper = ''
const children: ChildProcess[] = []
const clients: ElevatedBrokerClient[] = []

beforeAll(() => {
  if (!available) return
  if (existsSync(root)) for (const old of readdirSync(root)) rmSync(join(root, old), { recursive: true, force: true, maxRetries: 3 })
  const out = join(root, 'native')
  const built = spawnSync(process.execPath, [resolve('scripts/build-elevate.mjs'), out], { encoding: 'utf8', windowsHide: true })
  expect(built.status, built.stderr).toBe(0)
  helper = join(out, 'nexus-elevate.exe')
})

afterEach(async () => {
  for (const c of clients.splice(0)) await c.end().catch(() => undefined)
  for (const c of children.splice(0)) c.kill()
})

afterAll(() => {
  if (available) rmSync(join(root, 'native'), { recursive: true, force: true, maxRetries: 3 })
})

const running = (pid: number): boolean => spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'], { encoding: 'utf8', windowsHide: true }).stdout.includes(`"${pid}"`)
const until = async (cond: () => boolean, ms = 10_000): Promise<boolean> => {
  for (let t = 0; t < ms; t += 100) {
    if (cond()) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return cond()
}

async function start(name: string, opts: { runtimePid?: number; seconds?: number; capabilities?: string[] } = {}) {
  // The broker makes the staging folder itself and refuses one that exists: only its parent is made here.
  const staging = join(root, `${name}-${Date.now()}`, 'staging')
  mkdirSync(join(staging, '..'), { recursive: true })
  const ended: string[] = []
  const started = await ElevatedBrokerClient.start({
    helperPath: helper,
    runtimePid: opts.runtimePid ?? process.pid,
    session: `test-${name}`,
    expiresAt: new Date(Date.now() + (opts.seconds ?? 120) * 1000),
    capabilities: (opts.capabilities ?? ['NEXUS_ACCEPTANCE_FIXTURE', 'SIGNED_DRIVER_QUERY', 'PROJECT_TOOLCHAIN_INSTALL', 'PROJECT_SERVICE_CONTROL']) as never,
    cwd: root,
    unelevatedTest: { stagingDir: staging },
    consentTimeoutMs: 20_000,
    onEnded: (r) => void ended.push(r),
  })
  if (!started.ok) throw new Error(started.reason)
  clients.push(started.client)
  return { client: started.client, ended, staging }
}

const whoami = 'C:\\Windows\\System32\\whoami.exe'
const driverquery = 'C:\\Windows\\System32\\driverquery.exe'
const sys = (n: string): string => `C:\\Windows\\System32\\${n}`

describe.skipIf(!available)('privilege broker (real helper, unelevated test mode)', () => {
  it('runs a signed request of the session, refuses the rest, and ends what it started', async () => {
    const { client, staging } = await start('basic')
    expect(client.elevated).toBe(false)
    expect(client.brokerPid).toBeGreaterThan(0)
    const ran = await client.exec({ opId: 'op-1', capability: 'SIGNED_DRIVER_QUERY', executable: driverquery, args: ['/fo', 'csv', '/nh'], env: {}, timeoutMs: 60_000, inputs: [] })
    expect(ran).toMatchObject({ kind: 'result', exitCode: 0, timedOut: false })
    expect(ran.kind === 'result' && ran.stdout.trim().length).toBeGreaterThan(0)
    expect(await client.exec({ opId: 'op-2', capability: 'NEXUS_ACCEPTANCE_FIXTURE', executable: 'C:\\Windows\\System32\\cmd.exe', args: ['/c', 'echo x'], env: {}, timeoutMs: 20_000, inputs: [] })).toMatchObject({ kind: 'refused', reason: expect.stringMatching(/never run/) })
    expect(await client.exec({ opId: 'op-3', capability: 'APP_INSTALL_TEST', executable: whoami, args: [], env: {}, timeoutMs: 20_000, inputs: [] })).toMatchObject({ kind: 'refused', reason: expect.stringMatching(/not part of this session/) })
    expect(await client.exec({ opId: 'op-4', capability: 'NEXUS_ACCEPTANCE_FIXTURE', executable: 'C:\\Windows\\System32\\reg.exe', args: ['add', 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System', '/v', 'EnableLUA', '/d', '0'], env: {}, timeoutMs: 20_000, inputs: [] })).toMatchObject({ kind: 'refused' })
    expect(await client.exec({ opId: 'op-5', capability: 'SIGNED_DRIVER_QUERY', executable: driverquery, args: [], env: { PATH: 'C:\\evil' }, timeoutMs: 20_000, inputs: [] })).toMatchObject({ kind: 'refused', reason: expect.stringMatching(/PATH may not be set/) })
    // Still alive after refusals: they are answers, not faults.
    expect(await client.ping()).toBe(true)
    const pid = client.brokerPid as number
    await client.end()
    expect(await until(() => !running(pid))).toBe(true)
    expect(await until(() => !existsSync(staging))).toBe(true)
  })

  it('runs a program outside the protected folders only from a checked copy', async () => {
    const { client } = await start('staged')
    const dir = join(root, `staged-src-${Date.now()}`)
    mkdirSync(dir, { recursive: true })
    const copy = join(dir, 'probe-tool.exe')
    copyFileSync(whoami, copy)
    const hash = createHash('sha256').update(readFileSync(copy)).digest('hex')
    // A hashed installer program, run silently (whoami does not know /S: its exit code is not the point, the copy is).
    const base = { capability: 'PROJECT_TOOLCHAIN_INSTALL', executable: copy, args: ['/S'], env: {}, timeoutMs: 20_000, inputs: [] }
    expect(await client.exec({ opId: 'op-1', ...base } as never)).toMatchObject({ kind: 'refused', reason: expect.stringMatching(/sha-?256/i) })
    expect(await client.exec({ opId: 'op-2', ...base, sha256: 'f'.repeat(64) } as never)).toMatchObject({ kind: 'refused', reason: expect.stringMatching(/not the one that was reviewed/) })
    const ok = await client.exec({ opId: 'op-3', ...base, sha256: hash } as never)
    expect(ok).toMatchObject({ kind: 'result', stagedSha256: hash })
    expect(ok.kind === 'result' && ok.executable).not.toBe(copy)
    // Not silent, or not an installer shape: the broker's own template refuses it, whatever the runtime said.
    expect(await client.exec({ opId: 'op-4', ...base, args: [], sha256: hash } as never)).toMatchObject({ kind: 'refused', reason: expect.stringMatching(/silent/) })
  })

  it('enforces the capability templates itself (F4): programs, verbs, switches, the fixture key', async () => {
    const { client } = await start('templates', { capabilities: ['NEXUS_ACCEPTANCE_FIXTURE', 'SIGNED_DRIVER_QUERY', 'PROJECT_SERVICE_CONTROL', 'APP_INSTALL_TEST', 'NEXUS_FIREWALL_RECONCILIATION'] })
    const ask = (opId: string, capability: string, executable: string, args: string[]) => client.exec({ opId, capability, executable, args, env: {}, timeoutMs: 20_000, inputs: [] } as never)
    const refused = (reason: RegExp) => expect.objectContaining({ kind: 'refused', reason: expect.stringMatching(reason) })
    // A program that is not the capability's.
    expect(await ask('t-1', 'SIGNED_DRIVER_QUERY', whoami, [])).toEqual(refused(/driverquery/))
    expect(await ask('t-2', 'NEXUS_ACCEPTANCE_FIXTURE', whoami, [])).toEqual(refused(/PowerShell/))
    // sc.exe: query verbs only, one plain service name, never a protected service.
    expect(await ask('t-3', 'PROJECT_SERVICE_CONTROL', sys('sc.exe'), ['create', 'evil', 'binPath=C:\\x.exe'])).toEqual(refused(/query, queryex, qc, start or stop/))
    expect(await ask('t-4', 'PROJECT_SERVICE_CONTROL', sys('sc.exe'), ['stop', 'Spooler', 'extra'])).toEqual(refused(/nothing else/))
    expect(await ask('t-5', 'PROJECT_SERVICE_CONTROL', sys('sc.exe'), ['stop', 'EventLog'])).toEqual(refused(/never controlled/))
    expect(await ask('t-6', 'PROJECT_SERVICE_CONTROL', sys('sc.exe'), ['query', 'a b'])).toEqual(refused(/nothing else|not valid/))
    // reg.exe: the acceptance fixture's key only (the old name is no key either).
    expect(await ask('t-7', 'NEXUS_ACCEPTANCE_FIXTURE', sys('reg.exe'), ['add', 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', 'x', '/d', 'y'])).toEqual(refused(/NexusAcceptanceFixture/))
    expect(await ask('t-8', 'NEXUS_ACCEPTANCE_FIXTURE', sys('reg.exe'), ['add', 'HKLM\\SOFTWARE\\NexusPrivilegeFixture'])).toEqual(refused(/touches/))
    expect(await ask('t-9', 'NEXUS_ACCEPTANCE_FIXTURE', sys('reg.exe'), ['add', 'HKLM\\SOFTWARE\\NexusAcceptanceFixture', '/reg:64'])).toEqual(refused(/not allowed here/))
    // msiexec: a package must be a .msi given with its hash, silently, with no property or transform switches.
    expect(await ask('t-10', 'APP_INSTALL_TEST', sys('msiexec.exe'), ['/i', 'C:\\x\\a.msi', '/qn'])).toEqual(refused(/\.msi file given with its SHA-256/))
    expect(await ask('t-11', 'APP_INSTALL_TEST', sys('msiexec.exe'), ['/x', '{00000000-0000-0000-0000-000000000000}', '/qn'])).toEqual(refused(/only with \/i/))
    expect(await ask('t-12', 'APP_INSTALL_TEST', sys('msiexec.exe'), ['/i', '{00000000-0000-0000-0000-000000000000}', '/qn'])).toEqual(refused(/product code/))
    // netsh: only NEXUS's own blocking rules.
    expect(await ask('t-13', 'NEXUS_FIREWALL_RECONCILIATION', sys('netsh.exe'), ['advfirewall', 'firewall', 'add', 'rule', 'name=NexusSandboxX', 'action=allow'])).toEqual(refused(/block/))
    expect(await ask('t-14', 'NEXUS_FIREWALL_RECONCILIATION', sys('netsh.exe'), ['advfirewall', 'set', 'allprofiles', 'state', 'off'])).toEqual(refused(/touches|advfirewall firewall/))
    // The fixture key, read-only: the template lets it through (the key does not exist: reg.exe's own answer).
    expect(await ask('t-15', 'NEXUS_ACCEPTANCE_FIXTURE', sys('reg.exe'), ['query', 'HKLM\\SOFTWARE\\NexusAcceptanceFixture'])).toMatchObject({ kind: 'result' })
    expect(await client.ping()).toBe(true)
  })

  it('makes its staging folder itself (F2): one that exists is refused and left alone', async () => {
    const staging = join(root, `existing-${Date.now()}`, 'staging')
    mkdirSync(staging, { recursive: true }) // a pre-existing folder, as a user process could make it
    const started = await ElevatedBrokerClient.start({
      helperPath: helper,
      runtimePid: process.pid,
      session: 'test-existing',
      expiresAt: new Date(Date.now() + 60_000),
      capabilities: ['SIGNED_DRIVER_QUERY'] as never,
      cwd: root,
      unelevatedTest: { stagingDir: staging },
      consentTimeoutMs: 20_000,
    })
    expect(started.ok).toBe(false)
    expect(existsSync(staging)).toBe(true) // never deleted or used by the broker
    expect(readdirSync(staging)).toEqual([])
  })

  it('no other process can use the pipe: it is taken by the relay, and one instance only', async () => {
    const { client } = await start('probe')
    expect(client.pipeName).toMatch(/^nexus-priv-[0-9a-f]{32}$/)
    // A worker, a browser, the SIP helper, an application under test: any other process of the user.
    const probe = spawnSync(helper, ['probe', client.pipeName as string], { encoding: 'utf8', windowsHide: true, timeout: 15_000 })
    expect(probe.stdout).toMatch(/^refused (231|5)\b/)
    expect(await client.ping()).toBe(true)
  })

  it('ends with the runtime it watches (B11)', async () => {
    const runtime = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true })
    children.push(runtime)
    const { client, ended } = await start('runtime', { runtimePid: runtime.pid as number })
    const pid = client.brokerPid as number
    expect(running(pid)).toBe(true)
    runtime.kill()
    expect(await until(() => !running(pid))).toBe(true)
    expect(await until(() => ended.length > 0)).toBe(true)
    expect(client.alive).toBe(false)
  })

  it('ends at the end of its time', async () => {
    const { client, ended } = await start('expiry', { seconds: 3 })
    const pid = client.brokerPid as number
    expect(await until(() => !running(pid), 15_000)).toBe(true)
    expect(await until(() => ended.length > 0)).toBe(true)
    expect(ended.join(' ')).toMatch(/expired/)
  })
})

describe.skipIf(!available)('privilege broker protocol (raw lines)', () => {
  function raw(session: string) {
    const staging = join(root, `raw-${Date.now()}`, 'staging')
    mkdirSync(join(staging, '..'), { recursive: true })
    const p = spawn(helper, ['session', '--runtime-pid', String(process.pid), '--session', session, '--expires-unix', String(Math.floor(Date.now() / 1000) + 120), '--capabilities', 'SIGNED_DRIVER_QUERY', '--unelevated-test', '--staging', staging], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
    children.push(p)
    const lines: string[] = []
    let buf = ''
    p.stdout.on('data', (d) => {
      buf += d
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        lines.push(buf.slice(0, i))
        buf = buf.slice(i + 1)
      }
    })
    const key = async (): Promise<Buffer> => {
      await until(() => lines.some((l) => l.startsWith('0\t')))
      return Buffer.from(JSON.parse((lines.find((l) => l.startsWith('0\t')) as string).split('\t')[2] as string).key, 'base64')
    }
    const send = (k: Buffer, seq: number, body: object, signAs = session): void => {
      const b = JSON.stringify(body)
      p.stdin.write(`${seq}\t${createHmac('sha256', k).update(`${signAs}\nq\n${seq}\n${b}`).digest('hex')}\t${b}\n`)
    }
    const answer = async (n: number): Promise<Record<string, unknown>> => {
      await until(() => lines.filter((l) => /^[1-9]/.test(l)).length >= n)
      return JSON.parse((lines.filter((l) => /^[1-9]/.test(l))[n - 1] as string).split('\t')[2] as string) as Record<string, unknown>
    }
    return { p, key, send, answer }
  }

  it('refuses a replayed line, a line signed for another session, and ends after three such lines', async () => {
    const s = raw('raw-replay')
    const k = await s.key()
    s.send(k, 1, { op: 'ping' })
    expect(await s.answer(1)).toMatchObject({ e: 'pong' })
    s.send(k, 1, { op: 'ping' }) // replay
    expect(await s.answer(2)).toMatchObject({ e: 'rejected', reason: expect.stringMatching(/sequence/) })
    s.send(k, 2, { op: 'ping' }, 'another-session')
    expect(await s.answer(3)).toMatchObject({ e: 'rejected', reason: expect.stringMatching(/not authentic/) })
    s.send(Buffer.alloc(32, 7), 2, { op: 'ping' })
    expect(await s.answer(4)).toMatchObject({ e: 'rejected' })
    expect(await s.answer(5)).toMatchObject({ e: 'ended', reason: expect.stringMatching(/unauthentic|replay/) })
    expect(await until(() => s.p.exitCode !== null)).toBe(true)
  })
})
