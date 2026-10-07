import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { cmdCommandName } from '@main/modules/policies/command-classifier'
import { isGitSegment, isInsideGitDir, isTopLevelGit, normalizeSegment, pathNamesGit } from '@main/modules/policies/paths'

// The shared normaliser for "is this Git's own entry" (used by the shell classifier and the file tools).

describe('Git entry spellings', () => {
  it('reads a segment as Windows does', () => {
    for (const s of ['.git', '.GIT', '.Git', '.git.', '.git ', '.git. .', '.git::$INDEX_ALLOCATION', '.git:stream', 'GIT~1', 'git~2', 'GIT~1.']) expect(isGitSegment(s), s).toBe(true)
    for (const s of ['.gitignore', '.github', '.gitattributes', 'git', 'git-notes.md', 'gitx~1', 'agit~1', 'legit', '.git2', '']) expect(isGitSegment(s), s).toBe(false)
    expect(normalizeSegment('FOO.TXT. ')).toBe('foo.txt')
  })

  it('finds .git in any segment of a path, in either separator', () => {
    for (const p of ['.git', 'a/.git', 'a\\.GIT.\\b', 'sub/GIT~1/HEAD', '.git /config', 'x/.git::$DATA']) expect(pathNamesGit(p), p).toBe(true)
    for (const p of ['src/gitlib/x.ts', '.github/workflows/ci.yml', 'docs/git.md', 'a/b/c']) expect(pathNamesGit(p), p).toBe(false)
  })

  it('tells the top-level entry from what is inside it', () => {
    const root = path.resolve('C:\\work\\wt')
    for (const p of ['.git', '.git.', '.git ', 'GIT~1', './.git', '.\\.GIT', 'src/..\\.git', '.git::$DATA']) expect(isTopLevelGit(p, root), p).toBe(true)
    for (const p of ['.git/config', '.git\\hooks', 'sub/.git', 'GIT~1/HEAD', '.gitignore', 'src']) expect(isTopLevelGit(p, root), p).toBe(false)
  })

  it('refuses writes to any spelling through the file-tool check', () => {
    const root = path.resolve('C:\\work\\wt')
    for (const p of ['.git', '.git.\\config', 'GIT~1\\config', '.GIT \\HEAD', 'a\\.git::$DATA']) expect(isInsideGitDir(root, path.join(root, p)), p).toBe(true)
    for (const p of ['src\\a.ts', '.gitignore', '.github\\x.yml']) expect(isInsideGitDir(root, path.join(root, p)), p).toBe(false)
  })
})

describe('cmd.exe command names', () => {
  it('ends the name at / , = ; or a quote when a short switch follows', () => {
    for (const [w, n] of [['shutdown/s', 'shutdown'], ['shutdown.exe/r/t', 'shutdown.exe'], ['shutdown,/s', 'shutdown'], ['shutdown=/s', 'shutdown'], ['shutdown"/s"', 'shutdown'], ['C:\\Windows\\System32\\shutdown.exe/a', 'shutdown.exe']] as const) {
      expect(cmdCommandName(w), w).toBe(n)
    }
    for (const w of ['shutdown/index.ts', 'src/shutdown/x', 'shutdown', '/s', 'pnpm']) expect(cmdCommandName(w), w).toBeNull()
  })
})
