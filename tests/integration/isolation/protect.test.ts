import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ExecutionBroker } from '@main/modules/isolation/execution-broker'
import { Launcher } from '@main/modules/isolation/launcher'
import { IsolationService } from '@main/modules/isolation/service'
// @ts-expect-error a build script, plain JavaScript
import { buildLauncher } from '../../../scripts/build-launcher.mjs'

// What NEXUS marks unreadable for contained code when a project is enrolled, and takes back when none is.
// Only a scratch data directory is marked here: the credential stores of the person running the test are
// left out on purpose (`userStores: false`), as they are for every runtime a test starts.

const d = process.platform === 'win32' ? describe : describe.skip
const SCRATCH = resolve('test-results', 'isolation-protect-tests')
const dataDir = join(SCRATCH, 'data')
const worktree = join(SCRATCH, 'worktree')
let broker: ExecutionBroker
let service: IsolationService

const readSecret = async (): Promise<string> => {
  const result = await broker.run({ profile: 'RESTRICTED', projectId: 'p', sessionKey: 's', worktree, file: 'cmd', args: ['/d', '/c', 'type', join(dataDir, 'nexus.db')] }, { timeoutMs: 30_000 })
  return `${result.stdout}${result.stderr}`
}

d('protection of NEXUS data from contained code', () => {
  beforeAll(async () => {
    rmSync(SCRATCH, { recursive: true, force: true })
    mkdirSync(dataDir, { recursive: true })
    mkdirSync(worktree, { recursive: true })
    writeFileSync(join(dataDir, 'nexus.db'), 'SECRET-OF-THE-DATA-DIRECTORY')
    const launcher = new Launcher({ executable: buildLauncher(join(SCRATCH, 'native')) as string, specDir: join(dataDir, 'sandbox', 'specs') })
    // The state of contained sessions is outside the data directory here, so that only the protection is under test.
    broker = new ExecutionBroker({ launcher, sandboxDir: join(SCRATCH, 'sandbox'), account: () => null, baseEnv: () => process.env })
    service = new IsolationService({ broker, launcher, containment: () => 'RESTRICTED', enrolled: () => true, dataDir })
    await broker.verify('RESTRICTED')
  }, 120_000)

  afterAll(async () => {
    await service?.unprotect().catch(() => undefined)
    rmSync(SCRATCH, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  })

  it('before anything is marked, contained code that runs as the user reads the file', async () => {
    expect(await readSecret()).toContain('SECRET-OF-THE-DATA-DIRECTORY')
  }, 60_000)

  it('marks the data directory and keeps a record; contained code is then refused the file', async () => {
    const marked = await service.protect({ userStores: false })
    expect(marked.map((p) => p.toLowerCase())).toEqual([dataDir.toLowerCase()])
    expect(JSON.parse(readFileSync(join(dataDir, 'sandbox', 'protected.json'), 'utf8')).paths).toHaveLength(1)
    expect(service.status().protectedPaths).toHaveLength(1)
    const out = await readSecret()
    expect(out).not.toContain('SECRET-OF-THE-DATA-DIRECTORY')
    expect(out.toLowerCase()).toMatch(/denied|refus/)
    // Done once: a second call marks nothing again.
    expect(await service.protect({ userStores: false })).toHaveLength(1)
  }, 60_000)

  it('takes the mark off again when asked, and the record with it', async () => {
    expect(await service.unprotect()).toEqual([])
    expect(JSON.parse(readFileSync(join(dataDir, 'sandbox', 'protected.json'), 'utf8')).paths).toEqual([])
    expect(await readSecret()).toContain('SECRET-OF-THE-DATA-DIRECTORY')
  }, 60_000)
})
