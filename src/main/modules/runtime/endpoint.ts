import { execFile } from 'node:child_process'
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { homedir, userInfo } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { EndpointFileSchema, type EndpointFile } from '@shared/runtime-protocol'

/** Where the runtime leaves the file through which clients find it. */
export function endpointPath(dataDir: string): string {
  return join(dataDir, 'runtime', 'endpoint.json')
}

/**
 * The pipe's name: one per data directory and start. The random part makes the name unpredictable, so another
 * process cannot create the pipe first and wait for a client; the handshake would expose it anyway, because it
 * cannot prove that it holds the token.
 */
export function newPipeName(dataDir: string): string {
  const scope = createHash('sha256').update(dataDir.toLowerCase()).digest('hex').slice(0, 12)
  const name = `nexus-runtime-${scope}-${randomBytes(8).toString('hex')}`
  return process.platform === 'win32' ? `\\\\.\\pipe\\${name}` : join(dataDir, 'runtime', `${name.slice(0, 40)}.sock`)
}

export function newToken(): string {
  return randomBytes(32).toString('hex')
}

/** The proof one side sends: an HMAC over its role and both nonces. Knowing a proof does not help to make another. */
export function handshakeProof(token: string, role: 'server' | 'client', clientNonce: string, serverNonce: string): string {
  return createHmac('sha256', Buffer.from(token, 'hex')).update(`nexus-runtime/${role}/${clientNonce}/${serverNonce}`).digest('hex')
}

export function proofsEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex')
  const y = Buffer.from(b, 'hex')
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y)
}

/**
 * Narrows the file's access list to the current Windows user (and SYSTEM and administrators, who can read
 * everything anyway). The data directory is inside the user's profile, so the inherited list already excludes
 * other users; this removes the dependence on that. Resolves false when it could not be done.
 */
export function restrictToUser(file: string): Promise<boolean> {
  if (process.platform !== 'win32') return Promise.resolve(true)
  return new Promise((resolve) => {
    let user: string
    try {
      user = userInfo().username
    } catch {
      resolve(false)
      return
    }
    const domain = process.env['USERDOMAIN']
    const account = domain ? `${domain}\\${user}` : user
    execFile('icacls', [file, '/inheritance:r', '/grant:r', `${account}:F`, '/grant:r', '*S-1-5-18:F', '/grant:r', '*S-1-5-32-544:F'], { windowsHide: true, timeout: 10_000 }, (error) => resolve(!error))
  })
}

/**
 * Writes the endpoint file whole: a reader sees the old file or the new one, never half of one. The access
 * list is narrowed on the temporary file, before it gets the name clients look for, so the token is never
 * readable under the final name with a wider list than intended. Resolves whether the narrowing succeeded.
 */
export async function writeEndpoint(dataDir: string, endpoint: EndpointFile): Promise<{ file: string; restricted: boolean }> {
  const file = endpointPath(dataDir)
  mkdirSync(join(dataDir, 'runtime'), { recursive: true })
  // An unpredictable name, created exclusively: a file or link somebody put there first is an error, not a target.
  const temp = `${file}.${randomBytes(8).toString('hex')}.tmp`
  writeFileSync(temp, JSON.stringify(endpoint), { mode: 0o600, flag: 'wx' })
  const restricted = await restrictToUser(temp)
  // Inside the user's profile the inherited access list already keeps other users out. Anywhere else the
  // narrowing is the only protection the token has, so without it the runtime does not start.
  if (!restricted && !isInside(homedir(), dataDir)) {
    rmSync(temp, { force: true })
    throw new Error(`The runtime's endpoint file could not be restricted to the current user, and the data directory ${dataDir} is outside the user's profile.`)
  }
  renameSync(temp, file)
  return { file, restricted }
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** Whether something accepts connections on the pipe. It says nothing about what answers there. */
export function pipeAnswers(pipe: string, timeoutMs = 1000): Promise<boolean> {
  return new Promise((done) => {
    const socket = connect({ path: pipe })
    const finish = (answer: boolean): void => {
      clearTimeout(timer)
      socket.destroy()
      done(answer)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}

/** The endpoint a runtime left, or null when there is none or it cannot be read. */
export function readEndpoint(dataDir: string): EndpointFile | null {
  const file = endpointPath(dataDir)
  if (!existsSync(file)) return null
  try {
    const parsed = EndpointFileSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/** Removes the endpoint file if it still names this runtime (a newer runtime's file is left alone). */
export function removeEndpoint(dataDir: string, bootId: string): void {
  if (readEndpoint(dataDir)?.bootId !== bootId) return
  try {
    rmSync(endpointPath(dataDir), { force: true })
  } catch {
    // A stale file is harmless: nothing answers on its pipe.
  }
}

/** Whether a process with this id exists. It says nothing about what that process is. */
export function processExists(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}
