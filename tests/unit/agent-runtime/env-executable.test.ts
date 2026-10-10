import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AsyncQueue } from '@main/modules/agent-runtime/async-queue'
import { buildAgentEnv } from '@main/modules/agent-runtime/claude-sdk-runtime'
import { resolveClaudeExecutable, rewriteAsarPath } from '@main/modules/agent-runtime/resolve-executable'

describe('buildAgentEnv', () => {
  const base = { PATH: 'C:\\bin', ANTHROPIC_API_KEY: 'sk-1', ANTHROPIC_AUTH_TOKEN: 't', HOME: 'h', Anthropic_Api_Key: 'sk-2' }

  it('copies the environment and adds the memory switch', () => {
    const env = buildAgentEnv(base, { subscriptionMode: false })
    expect(env['PATH']).toBe('C:\\bin')
    expect(env['ANTHROPIC_API_KEY']).toBe('sk-1')
    expect(env['CLAUDE_CODE_DISABLE_AUTO_MEMORY']).toBe('1')
  })

  it('never tells an agent where NEXUS keeps its data, in either mode and whatever the case of the name', () => {
    for (const subscriptionMode of [true, false]) {
      const env = buildAgentEnv({ ...base, NEXUS_DATA_DIR: 'C:\data', Nexus_Data_Dir: 'C:\data2', NEXUS_OTHER: 'kept' }, { subscriptionMode })
      expect(Object.keys(env).filter((k) => k.toUpperCase() === 'NEXUS_DATA_DIR')).toEqual([])
      // A project may have variables of its own that start with NEXUS_: only this one is withheld.
      expect(env['NEXUS_OTHER']).toBe('kept')
    }
  })

  it('strips key variables case-insensitively in subscription mode', () => {
    const env = buildAgentEnv(base, { subscriptionMode: true })
    expect(Object.keys(env).filter((k) => k.toUpperCase().startsWith('ANTHROPIC_'))).toEqual([])
    expect(env['PATH']).toBe('C:\\bin')
  })

  it('does not mutate its input', () => {
    const input = { ANTHROPIC_API_KEY: 'k' }
    buildAgentEnv(input, { subscriptionMode: true })
    expect(input).toEqual({ ANTHROPIC_API_KEY: 'k' })
  })

  it('drops undefined values', () => {
    expect('X' in buildAgentEnv({ X: undefined }, { subscriptionMode: false })).toBe(false)
  })
})

describe('resolveClaudeExecutable', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'nexus-exe-'))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  })

  const pkgDir = (base: string) => join(base, 'node_modules', '@anthropic-ai', 'claude-agent-sdk-win32-x64')
  const touch = (dir: string) => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'claude.exe'), '')
  }
  const noResolve = () => {
    throw new Error('not found')
  }

  it('rewrites app.asar to app.asar.unpacked only at a path segment', () => {
    expect(rewriteAsarPath('C:\\App\\resources\\app.asar\\node_modules\\x\\claude.exe')).toBe(
      'C:\\App\\resources\\app.asar.unpacked\\node_modules\\x\\claude.exe',
    )
    expect(rewriteAsarPath('C:\\App\\app.asar.unpacked\\x')).toBe('C:\\App\\app.asar.unpacked\\x')
  })

  it('walks up from cwd to find node_modules', () => {
    touch(pkgDir(root))
    const deep = join(root, 'a', 'b')
    mkdirSync(deep, { recursive: true })
    const found = resolveClaudeExecutable({ cwd: deep, platform: 'win32', arch: 'x64', resolveModule: noResolve })
    expect(found).toBe(join(pkgDir(root), 'claude.exe'))
  })

  it('finds the binary in app.asar.unpacked under resourcesPath', () => {
    touch(pkgDir(join(root, 'app.asar.unpacked')))
    const found = resolveClaudeExecutable({
      resourcesPath: root,
      cwd: join(root, 'elsewhere'),
      platform: 'win32',
      arch: 'x64',
      resolveModule: noResolve,
    })
    expect(found).toBe(join(pkgDir(join(root, 'app.asar.unpacked')), 'claude.exe'))
  })

  it('maps a module-resolved asar path to the unpacked copy', () => {
    touch(pkgDir(join(root, 'app.asar.unpacked')))
    const asarPath = join(pkgDir(join(root, 'app.asar')), 'claude.exe')
    const found = resolveClaudeExecutable({
      cwd: join(root, 'nothing'),
      platform: 'win32',
      arch: 'x64',
      resolveModule: () => asarPath,
    })
    expect(found).toBe(join(pkgDir(join(root, 'app.asar.unpacked')), 'claude.exe'))
  })

  it('returns undefined when nothing exists', () => {
    expect(resolveClaudeExecutable({ cwd: root, platform: 'win32', arch: 'x64', resolveModule: noResolve, exists: () => false })).toBeUndefined()
  })
})

describe('AsyncQueue', () => {
  it('delivers queued items then finishes after close', async () => {
    const q = new AsyncQueue<number>()
    q.push(1)
    q.push(2)
    q.close()
    expect(q.push(3)).toBe(false)
    const seen: number[] = []
    for await (const n of q) seen.push(n)
    expect(seen).toEqual([1, 2])
  })

  it('wakes a pending consumer on push and on close', async () => {
    const q = new AsyncQueue<string>()
    const it = q[Symbol.asyncIterator]()
    const first = it.next()
    q.push('a')
    expect(await first).toEqual({ value: 'a', done: false })
    const second = it.next()
    q.close()
    expect((await second).done).toBe(true)
  })
})
