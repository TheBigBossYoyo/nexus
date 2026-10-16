import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { walkRepository } from '@main/modules/intelligence/walk'

// 0.9.1: in Electron an lstat of an `.asar` file opens the archive and keeps it open; profiling NEXUS's own repository
// locked release\win-unpacked\resources\app.asar and the next installer could not be built.
const root = resolve('test-results', 'walk-packaged')

afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('the repository walk', () => {
  it('leaves out Electron packages and their unpacked output', async () => {
    rmSync(root, { recursive: true, force: true })
    mkdirSync(join(root, 'src'), { recursive: true })
    mkdirSync(join(root, 'release', 'win-unpacked', 'resources'), { recursive: true })
    writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1\n')
    writeFileSync(join(root, 'release', 'win-unpacked', 'resources', 'app.asar'), 'x')
    writeFileSync(join(root, 'release', 'builder.yml'), 'x: 1\n')
    writeFileSync(join(root, 'app.asar'), 'x')
    const walked = await walkRepository(root, 1000, Date.now() + 10_000)
    const paths = walked.files.map((f) => f.path)
    expect(paths).toContain('src/a.ts')
    expect(paths).toContain('release/builder.yml')
    expect(paths.some((p) => p.endsWith('.asar') || p.includes('win-unpacked'))).toBe(false)
  })
})
