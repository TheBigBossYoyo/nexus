import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, type Server } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { portOwner } from '@main/modules/browser/app-manager'

// The audit's measurement: a foreign process on 127.0.0.1:P and the application on [::1]:P. The listener rows of
// the port are all looked at, not the first.

const children: ChildProcess[] = []
const servers: Server[] = []

afterEach(() => {
  for (const c of children.splice(0)) c.kill()
  for (const s of servers.splice(0)) s.close()
})

async function freePort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>((done) => probe.listen(0, '127.0.0.1', done))
  const port = (probe.address() as { port: number }).port
  await new Promise((done) => probe.close(done))
  return port
}

/** A child that listens on the host and port and says so. */
async function childListening(host: string, port: number): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['-e', `require('net').createServer().listen(${port}, '${host}', () => console.log('up')); setInterval(() => {}, 1000)`], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
  children.push(child)
  await new Promise<void>((done, fail) => {
    child.stdout?.once('data', () => done())
    child.once('exit', () => fail(new Error('the child ended')))
  })
  return child
}

const d = process.platform === 'win32' ? describe : describe.skip

d('portOwner', () => {
  it('a foreign listener on 127.0.0.1 and the application on [::1] on the same port is refused', async () => {
    const port = await freePort()
    const foreign = createServer()
    servers.push(foreign)
    await new Promise<void>((done) => foreign.listen(port, '127.0.0.1', done))
    const child = await childListening('::1', port)
    const answers = [await portOwner(port, child.pid as number, '127.0.0.1'), await portOwner(port, child.pid as number, '::1'), await portOwner(port, child.pid as number, '127.0.0.1')]
    expect(answers).toEqual(['foreign', 'foreign', 'foreign'])
  }, 60_000)

  it('the application alone on 127.0.0.1 is its own, and only for a host that address serves', async () => {
    const port = await freePort()
    const child = await childListening('127.0.0.1', port)
    expect(await portOwner(port, child.pid as number, '127.0.0.1')).toBe('own')
    expect(await portOwner(port, child.pid as number, 'localhost')).toBe('own')
    // Nothing of the application listens on [::1]: that address is not its endpoint.
    expect(await portOwner(port, child.pid as number, '::1')).toBe('foreign')
  }, 60_000)

  it('a port nobody listens on is none', async () => {
    const port = await freePort()
    expect(await portOwner(port, process.pid, '127.0.0.1')).toBe('none')
  }, 60_000)
})
