import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { mirrorTools } from '@main/modules/isolation/tools'

// 0.9.1: the sandbox's copy of a tool follows its installation. It was made once and kept: pnpm, installed globally
// into Node's own folder after the copy, never reached an enrolled project's checks ("no pnpm on PATH").

const root = resolve('test-results', 'tool-mirror-refresh')
const profile = join(root, 'profile')
const install = join(profile, 'apps', 'nodejs', 'current')
const sandbox = join(root, 'sandbox')

describe.runIf(process.platform === 'win32')('the tool mirror', () => {
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it('makes a new copy when a tool is added to the installation, and finds the added tool', async () => {
    rmSync(root, { recursive: true, force: true })
    mkdirSync(join(install, 'bin'), { recursive: true })
    writeFileSync(join(install, 'node.exe'), 'node v1')
    const path = `${install};${join(install, 'bin')}`
    const first = mirrorTools({ sandboxRoot: sandbox, userProfile: profile, path, names: ['node', 'pnpm'] })
    expect(first.tools.map((t) => t.name)).toEqual(['node'])
    // Later: pnpm is installed into the same Node folder (a directory's time changes with its entries).
    await new Promise((r) => setTimeout(r, 50))
    writeFileSync(join(install, 'bin', 'pnpm.cmd'), '@echo pnpm')
    const second = mirrorTools({ sandboxRoot: sandbox, userProfile: profile, path, names: ['node', 'pnpm'] })
    expect(second.tools.map((t) => t.name)).toEqual(['node', 'pnpm'])
    const pnpm = second.tools.find((t) => t.name === 'pnpm')
    expect(pnpm?.mirror).toMatch(/pnpm\.cmd$/)
    // A new copy, beside the first one, which a contained process might still be using.
    expect(second.path.split(';')[0]).not.toBe(first.path.split(';')[0])
  })
})
