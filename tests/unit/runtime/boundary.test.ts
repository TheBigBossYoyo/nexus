import { createConnection, type Server } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RUNTIME_PROTOCOL_VERSION } from '@shared/runtime-protocol'
import { DEFAULT_SETTINGS, sensitiveSettingsChanges, type Settings } from '@shared/settings'
import { RuntimeClient } from '@main/modules/runtime/client'
import { handshakeProof, newPipeName, newToken, pipeAnswers, proofsEqual, readEndpoint, writeEndpoint } from '@main/modules/runtime/endpoint'
import { RuntimeServer } from '@main/modules/runtime/server'
import { checkedWorkerMessage } from '@main/modules/workers'

const dirs: string[] = []
const servers: RuntimeServer[] = []
const clients: RuntimeClient[] = []
afterEach(async () => {
  for (const c of clients.splice(0)) c.close()
  for (const s of servers.splice(0)) await s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5 })
})

async function rig(options: { handshakeTimeoutMs?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-boundary-'))
  dirs.push(dir)
  const token = newToken()
  const pipe = newPipeName(dir)
  const identity = { protocol: RUNTIME_PROTOCOL_VERSION, version: '0.7.0-test', pid: process.pid, bootId: 'boot', startedAt: new Date().toISOString() }
  const calls: string[] = []
  const server = new RuntimeServer({
    pipe,
    token,
    identity,
    dispatch: async (channel, input) => {
      calls.push(channel)
      return channel === 'runtime.status' ? { ok: true, value: { ...identity, phase: 'READY', recovery: { workloads: 0, workers: 0, leases: 0, finishedAt: null } } } : { ok: true, value: input }
    },
    ...(options.handshakeTimeoutMs !== undefined ? { handshakeTimeoutMs: options.handshakeTimeoutMs } : {}),
  })
  servers.push(server)
  await server.listen()
  await writeEndpoint(dir, { ...identity, pipe, token })
  return { dir, token, pipe, server, calls }
}

/** A raw connection: what a process that is not the NEXUS client would write. */
function raw(pipe: string): { send(frame: unknown): void; frames: Record<string, unknown>[]; closed: Promise<void>; socket: ReturnType<typeof createConnection> } {
  const socket = createConnection({ path: pipe })
  const frames: Record<string, unknown>[] = []
  let buffer = ''
  socket.on('data', (data: Buffer) => {
    buffer += data.toString('utf8')
    for (;;) {
      const at = buffer.indexOf('\n')
      if (at < 0) break
      frames.push(JSON.parse(buffer.slice(0, at)) as Record<string, unknown>)
      buffer = buffer.slice(at + 1)
    }
  })
  socket.on('error', () => undefined)
  const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()))
  return { send: (frame) => void socket.write(`${JSON.stringify(frame)}\n`), frames, closed, socket }
}
const nonce = 'ab'.repeat(32)

describe('the local protocol', () => {
  it('lets a client with the token in, and answers its requests', async () => {
    const { dir, calls } = await rig()
    const client = new RuntimeClient({ dataDir: dir, kind: 'desktop' })
    clients.push(client)
    client.start()
    await client.whenConnected(10_000)
    expect(await client.invoke('control.overview', { a: 1 })).toEqual({ ok: true, value: { a: 1 } })
    expect(calls).toContain('control.overview')
  })

  it('answers nothing before the handshake: a request, a wrong proof and an oversized frame each end the connection', async () => {
    const { pipe, calls } = await rig()
    const early = raw(pipe)
    early.send({ t: 'req', id: '1', channel: 'control.overview', input: {} })
    await early.closed
    expect(early.frames).toMatchObject([{ t: 'error', code: 'auth_failed' }])

    const guess = raw(pipe)
    guess.send({ t: 'hello', protocol: RUNTIME_PROTOCOL_VERSION, client: 'desktop', nonce })
    await expect.poll(() => guess.frames.length).toBe(1)
    guess.send({ t: 'auth', proof: 'cd'.repeat(32) })
    await guess.closed
    expect(guess.frames.at(-1)).toMatchObject({ t: 'error', code: 'auth_failed' })

    const big = raw(pipe)
    big.send({ t: 'hello', protocol: RUNTIME_PROTOCOL_VERSION, client: 'desktop', nonce, padding: 'x'.repeat(8000) })
    await big.closed
    expect(big.frames).toMatchObject([{ t: 'error', code: 'frame_too_long' }])

    const old = raw(pipe)
    old.send({ t: 'hello', protocol: RUNTIME_PROTOCOL_VERSION + 1, client: 'desktop', nonce })
    await old.closed
    expect(old.frames).toMatchObject([{ t: 'error', code: 'protocol_mismatch' }])
    expect(calls).toEqual([])
  })

  it('proves itself to the client first, and its proof is of no use as a client proof', async () => {
    const { pipe, token } = await rig()
    const peer = raw(pipe)
    peer.send({ t: 'hello', protocol: RUNTIME_PROTOCOL_VERSION, client: 'desktop', nonce })
    await expect.poll(() => peer.frames.length).toBe(1)
    const challenge = peer.frames[0] as { nonce: string; proof: string }
    expect(proofsEqual(challenge.proof, handshakeProof(token, 'server', nonce, challenge.nonce))).toBe(true)
    // Reflection: sending the runtime's own proof back is not an authentication.
    peer.send({ t: 'auth', proof: challenge.proof })
    await peer.closed
    expect(peer.frames.at(-1)).toMatchObject({ t: 'error', code: 'auth_failed' })
    // The two roles sign different messages, also with equal nonces.
    expect(handshakeProof(token, 'server', nonce, nonce)).not.toBe(handshakeProof(token, 'client', nonce, nonce))
    expect(proofsEqual('', '')).toBe(false)
  })

  it('closes a connection that does not finish the handshake, and bounds how many may be waiting', async () => {
    const { pipe, server } = await rig({ handshakeTimeoutMs: 300 })
    const silent = raw(pipe)
    await silent.closed
    expect(silent.frames).toMatchObject([{ t: 'error', code: 'handshake_timeout' }])

    // Many connections that say nothing: beyond the bound a new one is closed at once, and none is a client.
    const many = Array.from({ length: 40 }, () => raw(pipe))
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(server.clientCount()).toBe(0)
    const refused = many.filter((c) => c.socket.destroyed || c.socket.readyState !== 'open').length
    expect(refused).toBeGreaterThanOrEqual(40 - 16)
    await Promise.all(many.map((c) => c.closed))
  })

  it('a client refuses what answers on the pipe when it cannot prove that it holds the token', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nexus-boundary-'))
    dirs.push(dir)
    const pipe = newPipeName(dir)
    // Something else took the name: it answers the handshake with a proof made without the token.
    const { createServer } = await import('node:net')
    const impostor: Server = createServer((socket) => {
      socket.on('error', () => undefined)
      socket.once('data', () => socket.write(`${JSON.stringify({ t: 'challenge', protocol: RUNTIME_PROTOCOL_VERSION, nonce, proof: 'ef'.repeat(32) })}\n`))
    })
    await new Promise<void>((resolve) => impostor.listen(pipe, () => resolve()))
    try {
      await writeEndpoint(dir, { protocol: RUNTIME_PROTOCOL_VERSION, version: 'x', pipe, token: newToken(), pid: process.pid, bootId: 'impostor', startedAt: new Date().toISOString() })
      const client = new RuntimeClient({ dataDir: dir, kind: 'desktop' })
      clients.push(client)
      client.start()
      await expect(client.whenConnected(1500)).rejects.toThrow()
      expect(client.isConnected()).toBe(false)
      expect(await client.invoke('control.overview', {})).toMatchObject({ ok: false, error: { code: 'runtime_unavailable' } })
    } finally {
      await new Promise<void>((resolve) => impostor.close(() => resolve()))
    }
  })

  it('writes the endpoint file whole, and can tell whether a runtime still answers on its pipe', async () => {
    const { dir, pipe, token, server } = await rig()
    expect(readEndpoint(dir)).toMatchObject({ pipe, token, bootId: 'boot' })
    expect(await pipeAnswers(pipe)).toBe(true)
    await server.close()
    servers.splice(servers.indexOf(server), 1)
    expect(await pipeAnswers(pipe, 500)).toBe(false)
  })
})

describe('settings changes that need the user', () => {
  const base: Settings = DEFAULT_SETTINGS
  it('lists what starts a program or widens what agents may do, and nothing else', () => {
    expect(sensitiveSettingsChanges(base, base)).toEqual([])
    expect(sensitiveSettingsChanges(base, { ...base, execution: { ...base.execution, maxParallelAgents: 2, profile: 'RESTRICTED' } })).toEqual([])
    expect(sensitiveSettingsChanges(base, { ...base, claude: { ...base.claude, executablePath: 'C:\\x\\claude.exe' } })).toEqual(['Run this program as the Claude runtime: C:\\x\\claude.exe'])
    const server = { name: 'tools', type: 'stdio' as const, command: 'node', args: ['server.js'], enabled: true, roles: [] }
    expect(sensitiveSettingsChanges(base, { ...base, mcp: { servers: [server] } })).toEqual(['Start this program as the MCP server "tools": node server.js'])
    // The same server unchanged, a disabled one, and a removed one are not changes that need a question.
    const withServer = { ...base, mcp: { servers: [server] } }
    expect(sensitiveSettingsChanges(withServer, withServer)).toEqual([])
    expect(sensitiveSettingsChanges(withServer, { ...base, mcp: { servers: [{ ...server, enabled: false }] } })).toEqual([])
    expect(sensitiveSettingsChanges(withServer, base)).toEqual([])
    expect(sensitiveSettingsChanges(withServer, { ...base, mcp: { servers: [{ ...server, args: ['other.js'] }] } })).toHaveLength(1)
    expect(sensitiveSettingsChanges(base, { ...base, permissions: { allowNetworkTools: true, safeCommandPrefixes: ['pnpm test'] } })).toEqual(['Let agents run commands that begin with "pnpm test" without asking', 'Let read-only agents fetch pages from the web'])
    const restricted = { ...base, execution: { ...base.execution, profile: 'RESTRICTED' as const } }
    expect(sensitiveSettingsChanges(restricted, base)).toEqual(['Lower the execution profile from RESTRICTED to STANDARD'])
    expect(sensitiveSettingsChanges(base, { ...base, claude: { ...base.claude, executablePath: `C:\\${'a'.repeat(400)}` } })[0]?.length).toBeLessThanOrEqual(160)
  })
})

describe('what a worker may send', () => {
  it('accepts the messages of the protocol and nothing else', () => {
    expect(checkedWorkerMessage({ t: 'ready', pid: 12, capabilities: ['claude'] })).not.toBeNull()
    expect(checkedWorkerMessage({ t: 'hb', leaseId: null })).not.toBeNull()
    expect(checkedWorkerMessage({ t: 'event', leaseId: 'l', event: { type: 'text', text: 'x' } })).not.toBeNull()
    expect(checkedWorkerMessage({ t: 'event', leaseId: 'l', event: { type: 'session.started', sessionId: '0199-abc_DEF.1', model: 'm', tools: [], apiKeySource: null } })).not.toBeNull()
    expect(checkedWorkerMessage({ t: 'call', id: 1, leaseId: 'l', method: 'authorize', args: [{}] })).not.toBeNull()

    for (const bad of [
      null,
      'text',
      42,
      {},
      { t: 'unknown' },
      { t: 'event', leaseId: 'l' },
      { t: 'event', leaseId: 'l', event: null },
      { t: 'event', leaseId: 'l', event: { type: 'session.started', sessionId: '../../x' } },
      { t: 'event', leaseId: 'l', event: { type: 'session.started', sessionId: 'a b; rm' } },
      { t: 'event', leaseId: 'l', event: { type: 'session.ended', reason: 'won' } },
      { t: 'call', id: 1, leaseId: 'l', method: 'constructor', args: [] },
      { t: 'call', id: 1, leaseId: 'l', method: '__proto__', args: [] },
      { t: 'call', id: 1, leaseId: 'l', method: 'toString', args: [] },
      { t: 'call', id: 'x', leaseId: 'l', method: 'authorize', args: [] },
      { t: 'call', id: 1, leaseId: 'l', method: 'authorize', args: 'x' },
      { t: 'ready', pid: 'x', capabilities: [] },
      { t: 'ready', pid: 1, capabilities: Array.from({ length: 40 }, () => 'p') },
      { t: 'hb' },
      { t: 'ended', leaseId: 'x'.repeat(200) },
      { t: 'log', line: 12 },
    ]) {
      expect(checkedWorkerMessage(bad), JSON.stringify(bad)).toBeNull()
    }
  })
})
