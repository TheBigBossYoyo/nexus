import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ExecutionBroker } from '@main/modules/isolation/execution-broker'
import { Launcher, type ContainmentProfile } from '@main/modules/isolation/launcher'
import { readSandboxAccount } from '@main/modules/isolation/sandbox-account'
import { mirrorTools } from '@main/modules/isolation/tools'
import { connect } from 'node:net'
import { RUNTIME_PROTOCOL_VERSION } from '@shared/runtime-protocol'
import { handshakeProof, newPipeName } from '@main/modules/runtime/endpoint'
import { RuntimeServer } from '@main/modules/runtime/server'
// @ts-expect-error a build script, plain JavaScript
import { buildLauncher } from '../../../scripts/build-launcher.mjs'

// The runtime's pipe is how a window becomes a client of NEXUS: whoever completes its handshake can enroll a
// project, answer a boundary request, read the database through the channels. Project code must not get that
// far, and must not get near: here a real runtime server listens, and contained code (the sandbox account;
// the user at low integrity) tries to find the pipe, open it, speak to it, and pass for a client.
//
// Two layers are tested apart. Windows: the pipe cannot be opened at all from inside a containment. The
// protocol: an opener that somehow got in proves nothing without the token, which it cannot read.

const WINDOWS = process.platform === 'win32'
const d = WINDOWS ? describe : describe.skip
const account = WINDOWS ? readSandboxAccount() : null
const SCRATCH = resolve('test-results', 'pipe-tests')
const PROFILES: ContainmentProfile[] = account ? ['RESTRICTED', 'ISOLATED'] : ['RESTRICTED']
const TOKEN = 'a'.repeat(64)
const dataDir = join(SCRATCH, 'data')

let broker: ExecutionBroker
let launcher: Launcher
let server: RuntimeServer
let pipe = ''
const dispatched: string[] = []

const PROBE = `
const net = require('net'); const fs = require('fs');
const pipe = process.env.PROBE_PIPE; const out = (k, v) => console.log(k + '=' + String(v).replace(/\\s+/g, ' ').slice(0, 160));
// 1. Is the pipe's name there to be found by listing?
try { const names = fs.readdirSync('\\\\\\\\.\\\\pipe\\\\'); out('listed', names.some((n) => pipe.endsWith(n)) ? 'FOUND' : 'not-in-' + names.length); } catch (e) { out('listed', 'DENIED:' + e.code); }
// 2. The endpoint file with the token.
try { fs.readFileSync(process.env.PROBE_ENDPOINT, 'utf8'); out('endpoint', 'READ'); } catch (e) { out('endpoint', 'DENIED:' + e.code); }
// 3. Open the pipe and speak.
const tries = [
  ['hello', JSON.stringify({ t: 'hello', protocol: 1, client: 'desktop', nonce: 'b'.repeat(64) }) + '\\n'],
  ['proof', JSON.stringify({ t: 'hello', protocol: 1, client: 'desktop', nonce: 'b'.repeat(64) }) + '\\n' + JSON.stringify({ t: 'proof', proof: 'c'.repeat(64) }) + '\\n'],
  ['request', JSON.stringify({ t: 'req', id: '1', channel: 'autonomy.enroll', input: { projectId: 'p', profile: 'AUTONOMOUS_PROJECT' } }) + '\\n'],
  ['stale', JSON.stringify({ t: 'hello', protocol: 1, client: 'desktop', nonce: 'b'.repeat(64), token: process.env.PROBE_STALE }) + '\\n'],
];
let i = 0;
const next = () => {
  if (i >= tries.length) return process.exit(0);
  const [name, payload] = tries[i++]; let got = ''; let done = false;
  const finish = (v) => { if (done) return; done = true; out('open-' + name, v); try { s.destroy() } catch (e) {} setTimeout(next, 50); };
  const s = net.connect({ path: pipe });
  s.on('connect', () => { s.write(payload); setTimeout(() => finish('CONNECTED reply=' + (got || 'none')), 700); });
  s.on('data', (c) => { got += c.toString(); });
  s.on('error', (e) => finish('DENIED:' + (e.code || e.message)));
};
next();
`

async function probe(profile: ContainmentProfile, target = pipe): Promise<Record<string, string>> {
  const base = profile === 'ISOLATED' && account ? join(account.root, 'worktrees', 'pipe-tests') : join(SCRATCH, 'worktrees')
  const worktree = join(base, profile.toLowerCase())
  mkdirSync(worktree, { recursive: true })
  writeFileSync(join(worktree, 'probe.cjs'), PROBE)
  const result = await broker.run({ profile, projectId: 'pipe-tests', sessionKey: profile, worktree, file: 'node', args: ['probe.cjs'], set: { PROBE_PIPE: target, PROBE_ENDPOINT: join(dataDir, 'runtime', 'endpoint.json'), PROBE_STALE: TOKEN.replace(/a/g, 'e') } }, { timeoutMs: 60_000 })
  const lines: Record<string, string> = {}
  for (const line of result.stdout.split(/\r?\n/)) {
    const m = /^([a-z-]+)=(.*)$/.exec(line.trim())
    if (m) lines[m[1] as string] = m[2] as string
  }
  if (Object.keys(lines).length === 0) throw new Error(`the probe printed nothing: ${result.stdout}${result.stderr}`)
  return lines
}

d('the runtime pipe, from inside a containment', () => {
  beforeAll(async () => {
    rmSync(SCRATCH, { recursive: true, force: true })
    mkdirSync(join(dataDir, 'runtime'), { recursive: true })
    writeFileSync(join(dataDir, 'runtime', 'endpoint.json'), JSON.stringify({ pipe: 'x', token: TOKEN }))
    launcher = new Launcher({ executable: buildLauncher(join(SCRATCH, 'native')) as string, specDir: join(SCRATCH, 'specs') })
    const mirrored = account ? mirrorTools({ sandboxRoot: account.root, userProfile: homedir(), path: process.env['PATH'] ?? '', names: ['node'] }) : null
    broker = new ExecutionBroker({ launcher, sandboxDir: join(SCRATCH, 'sandbox'), account: () => account, baseEnv: () => process.env, toolPath: (profile, path) => (profile === 'ISOLATED' && mirrored ? mirrored.path : path) })
    for (const profile of PROFILES) await broker.verify(profile)
    // As the runtime does for an enrolled project: its data directory is not readable from a containment.
    await launcher.label('protect', dataDir)
    pipe = newPipeName(dataDir)
    server = new RuntimeServer({
      pipe,
      token: TOKEN,
      identity: { pid: process.pid, bootId: 'test', version: 'test', protocol: 1, startedAt: new Date().toISOString() } as never,
      dispatch: async (channel) => {
        dispatched.push(channel)
        return { ok: true }
      },
      protect: (name) => launcher.protectPipe(name),
    })
    await server.listen()
  }, 240_000)

  afterAll(async () => {
    await server?.close()
    await launcher?.label('clear', dataDir).catch(() => undefined)
    rmSync(SCRATCH, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    if (account) rmSync(join(account.root, 'worktrees', 'pipe-tests'), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  })

  /** A client of the same user at medium integrity: opens the pipe, completes the handshake with `token`, sends one request. */
  const asClient = (token: string): Promise<string> =>
    new Promise((done) => {
      const socket = connect({ path: pipe })
      const nonce = 'b'.repeat(64)
      let buffer = ''
      const finish = (answer: string): void => {
        socket.destroy()
        done(answer)
      }
      const timer = setTimeout(() => finish('TIMEOUT'), 5000)
      socket.on('connect', () => socket.write(`${JSON.stringify({ t: 'hello', protocol: RUNTIME_PROTOCOL_VERSION, client: 'desktop', nonce })}\n`))
      socket.on('error', (e: NodeJS.ErrnoException) => (clearTimeout(timer), finish(`DENIED:${e.code ?? e.message}`)))
      socket.on('close', () => (clearTimeout(timer), finish(`CLOSED:${buffer.slice(0, 120)}`)))
      socket.on('data', (chunk: Buffer) => {
        buffer += chunk.toString()
        for (;;) {
          const end = buffer.indexOf('\n')
          if (end < 0) break
          const frame = JSON.parse(buffer.slice(0, end)) as { t: string; nonce?: string; code?: string; result?: unknown }
          buffer = buffer.slice(end + 1)
          if (frame.t === 'challenge') socket.write(`${JSON.stringify({ t: 'auth', proof: handshakeProof(token, 'client', nonce, frame.nonce as string) })}\n`)
          else if (frame.t === 'welcome') socket.write(`${JSON.stringify({ t: 'req', id: '1', channel: 'desktop.connection', input: {} })}\n`)
          else if (frame.t === 'res') return clearTimeout(timer), finish(`ANSWERED:${JSON.stringify(frame.result)}`)
          else return clearTimeout(timer), finish(`REFUSED:${frame.code ?? frame.t}`)
        }
      })
    })

  it('a trusted client of the same user, holding the token, connects and is answered', async () => {
    expect(await asClient(TOKEN)).toBe('ANSWERED:{"ok":true}')
    expect(dispatched).toEqual(['desktop.connection'])
  }, 30_000)

  it('a process of the same user at medium integrity without the token opens the pipe and gets nowhere', async () => {
    expect(await asClient('f'.repeat(64))).toMatch(/^(REFUSED:auth_failed|CLOSED)/)
    expect(dispatched).toEqual(['desktop.connection'])
  }, 30_000)

  it('for the record: what the same contained code reaches on a pipe NEXUS did not protect', async () => {
    // The protocol holds either way (no token, no answer). This shows what the protection adds below it.
    const bare = newPipeName(join(SCRATCH, 'bare'))
    const seen: string[] = []
    const unprotected = new RuntimeServer({ pipe: bare, token: TOKEN, identity: { pid: process.pid } as never, dispatch: async (channel) => (seen.push(channel), { ok: true }) })
    await unprotected.listen()
    try {
      for (const profile of PROFILES) {
        const r = await probe(profile, bare)
        console.info(`unprotected pipe from ${profile}: ${JSON.stringify(r)}`)
        // Whatever Windows allowed, nothing was answered: the handshake needs the token.
        for (const name of ['hello', 'proof', 'request', 'stale']) expect(r[`open-${name}`] ?? '', name).not.toMatch(/"t":"(welcome|res)"/)
      }
      expect(seen).toEqual([])
    } finally {
      await unprotected.close()
    }
  }, 180_000)

  for (const profile of PROFILES) {
    it(`${profile}: contained code cannot open the pipe, read the token, or have a request answered`, async () => {
      const r = await probe(profile)
      const all = JSON.stringify(r, null, 1)
      console.info(`pipe from ${profile}: ${JSON.stringify(r)}`)
      expect(r['endpoint'], all).toMatch(/^DENIED:/)
      for (const name of ['hello', 'proof', 'request', 'stale']) expect(r[`open-${name}`], `${name}: ${all}`).toMatch(/^DENIED:/)
      // Nothing it sent reached the dispatcher.
      expect(dispatched).toEqual(['desktop.connection'])
    }, 120_000)
  }
})
