import { existsSync, readdirSync, readFileSync, type Dirent } from 'node:fs'
import { join } from 'node:path'

/**
 * 0.9.1: what a task's checks run. Until now every task ran the project's whole check commands, so a project with
 * a large test suite paid the whole suite after every task (NEXUS on itself: about 5,400 tests, 15 minutes, which
 * is the check time limit: the check timed out, the timeout was taken for a failure of the task, and a repair agent
 * was sent to fix code that had nothing wrong with it).
 *
 * A task's checks are now about the task's own changes: the tests related to the files it changed (vitest
 * `related`, jest `--findRelatedTests`), the linter on those files, the type check whole (it is the one check whose
 * result depends on the whole program), and no build when a type check exists. The mission's integration runs
 * every command whole, as before: nothing is merged without the full checks having passed once.
 *
 * A command is scoped only when NEXUS can read exactly what it is (a package script that is one plain invocation
 * of vitest, jest or eslint); anything else runs as configured.
 */

export type CheckName = 'typecheck' | 'lint' | 'build' | 'test'

export interface ScopedCheck {
  name: CheckName
  command: string
  /** FULL: as configured. CHANGED: limited to the task's files. */
  scope: 'FULL' | 'CHANGED'
  /** Not run for this task (the note says why). */
  skip: boolean
  /** Why this check was scoped or left out, for the record of the checks. */
  note: string | null
}

const SOURCE = /\.(?:[cm]?[jt]sx?|vue|svelte)$/i
const MAX_FILES = 200
const PACKAGE_MANAGERS = ['pnpm', 'npm', 'yarn', 'bun'] as const

/** The package script a check command runs (`pnpm test`, `npm run lint`), or null when it is not one. */
export function scriptOf(command: string): { pm: (typeof PACKAGE_MANAGERS)[number]; script: string } | null {
  const parts = command.trim().split(/\s+/)
  const pm = PACKAGE_MANAGERS.find((p) => p === parts[0])
  if (pm === undefined) return null
  if (parts.length === 2 && parts[1] !== 'run' && parts[1] !== 'exec') return { pm, script: parts[1] as string }
  if (parts.length === 3 && parts[1] === 'run') return { pm, script: parts[2] as string }
  return null
}

/** The script's text when it is one plain invocation of `tool` (no `&&`, `;`, pipes or redirections). */
function plainInvocation(script: string | undefined, tool: string): string[] | null {
  if (script === undefined || /[&;|<>`$]/.test(script)) return null
  const words = script.trim().split(/\s+/)
  return words[0] === tool ? words.slice(1) : null
}

const quote = (file: string): string => (/[\s"]/.test(file) ? `"${file.replace(/"/g, '')}"` : file)

function readScripts(cwd: string): Record<string, string> {
  try {
    const path = join(cwd, 'package.json')
    if (!existsSync(path)) return {}
    const pkg = JSON.parse(readFileSync(path, 'utf8')) as { scripts?: Record<string, unknown> }
    return Object.fromEntries(Object.entries(pkg.scripts ?? {}).filter((e): e is [string, string] => typeof e[1] === 'string'))
  } catch {
    return {}
  }
}

const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/i
const NOT_SOURCE_DIRS = new Set(['node_modules', '.git', 'out', 'dist', 'build', 'release', 'test-results', 'coverage', 'vendor', '.nexus'])
const MAX_TESTS = 80

/** Every test file of the worktree, relative, with forward slashes. */
function testFiles(cwd: string): string[] {
  const found: string[] = []
  const walk = (rel: string, depth: number): void => {
    if (depth > 12 || found.length > 5000) return
    let entries: Dirent[]
    try {
      entries = readdirSync(join(cwd, rel), { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const path = rel === '' ? e.name : `${rel}/${e.name}`
      if (e.isDirectory()) {
        if (!NOT_SOURCE_DIRS.has(e.name) && !e.name.startsWith('.')) walk(path, depth + 1)
      } else if (TEST_FILE.test(e.name)) found.push(path)
    }
  }
  walk('', 0)
  return found
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * The test files that name one of the changed modules in an import (by its file name, as `…/name'` or
 * `…/name.ts'`), and the changed test files themselves. Null when there are more than MAX_TESTS: then the whole
 * suite is the better run. What this misses (a test that reaches a changed module only through another one) is
 * caught by the whole suite at integration.
 */
export function testsNaming(cwd: string, sources: readonly string[]): string[] | null {
  const all = testFiles(cwd)
  const chosen = new Set(sources.map((s) => s.replace(/\\/g, '/')).filter((s) => TEST_FILE.test(s)))
  const stems = [
    ...new Set(
      sources
        .filter((s) => !TEST_FILE.test(s))
        .map((s) => {
          const parts = s.replace(/\\/g, '/').split('/')
          const stem = (parts.at(-1) ?? '').replace(/\.[^.]+$/, '')
          return stem === 'index' ? (parts.at(-2) ?? stem) : stem
        })
        .filter((s) => s.length >= 3),
    ),
  ]
  if (stems.length > 0) {
    const pattern = new RegExp(`[/'"](?:${stems.map(escapeRe).join('|')})(?:\\.[cm]?[jt]sx?)?['"]`)
    for (const test of all) {
      if (chosen.has(test)) continue
      try {
        if (pattern.test(readFileSync(join(cwd, test), 'utf8'))) chosen.add(test)
      } catch {
        // An unreadable test is left to the integration.
      }
      if (chosen.size > MAX_TESTS) return null
    }
  }
  return [...chosen].filter((t) => existsSync(join(cwd, t))).sort()
}

/**
 * The checks of one task. `changedFiles` are the task's files relative to the worktree, as git names them (deleted
 * files may be among them; they are left out). The commands are read from the worktree's own package.json.
 */
export function scopeTaskChecks(input: { checks: Partial<Record<CheckName, string | null>>; order: readonly CheckName[]; cwd: string; changedFiles: readonly string[] }): ScopedCheck[] {
  const scripts = readScripts(input.cwd)
  const sources = input.changedFiles.filter((f) => SOURCE.test(f) && existsSync(join(input.cwd, f)))
  const tooMany = sources.length > MAX_FILES
  const out: ScopedCheck[] = []
  for (const name of input.order) {
    const command = input.checks[name]
    if (!command) continue
    const full = (note: string | null = null): ScopedCheck => ({ name, command, scope: 'FULL', skip: false, note })
    const skipped = (note: string): ScopedCheck => ({ name, command, scope: 'CHANGED', skip: true, note })
    const scoped = (scopedCommand: string, note: string): ScopedCheck => ({ name, command: scopedCommand, scope: 'CHANGED', skip: false, note })
    if (name === 'build') {
      // The type check says whether the program holds together; a build per task repeats it at length and makes
      // binaries the integration builds anyway.
      if (input.checks.typecheck) {
        out.push(skipped('Not run for this task: the type check covers it, and the build runs when the mission integrates.'))
        continue
      }
      out.push(full())
      continue
    }
    if (name !== 'test' && name !== 'lint') {
      out.push(full())
      continue
    }
    const called = scriptOf(command)
    if (called === null || tooMany) {
      out.push(full(tooMany ? `The task changed more than ${MAX_FILES} source files: the whole ${name} runs.` : null))
      continue
    }
    const script = scripts[called.script]
    const exec = `${called.pm} exec`
    if (name === 'test') {
      const vitest = plainInvocation(script, 'vitest')
      const jest = plainInvocation(script, 'jest')
      if (vitest !== null && (vitest.length === 0 || (vitest.length === 1 && vitest[0] === 'run'))) {
        // Not `vitest related`: it builds the import graph of every test first (measured on NEXUS: no answer in five
        // minutes). The test files that name a changed module, and the changed test files, are found by reading them.
        const tests = sources.length === 0 ? [] : testsNaming(input.cwd, sources)
        if (tests === null) out.push(full('Too many test files name the changed modules: the whole suite runs.'))
        else if (tests.length === 0) out.push(skipped('Not run for this task: no test names the files it changed; the whole suite runs when the mission integrates.'))
        else out.push(scoped(`${exec} vitest run --passWithNoTests ${tests.map(quote).join(' ')}`, `The ${tests.length} test file(s) that name the files this task changed; the whole suite runs when the mission integrates.`))
        continue
      }
      if (jest !== null && jest.length === 0) {
        if (sources.length === 0) out.push(skipped('Not run for this task: it changed no source file; the whole suite runs when the mission integrates.'))
        else out.push(scoped(`${exec} jest --passWithNoTests --findRelatedTests ${sources.map(quote).join(' ')}`, `The tests related to the ${sources.length} file(s) this task changed; the whole suite runs when the mission integrates.`))
        continue
      }
      out.push(full())
      continue
    }
    const eslint = plainInvocation(script, 'eslint')
    if (eslint !== null && eslint.every((w) => !w.startsWith('-'))) {
      if (sources.length === 0) out.push(skipped('Not run for this task: it changed no source file.'))
      else out.push(scoped(`${exec} eslint ${sources.map(quote).join(' ')}`, `The linter on the ${sources.length} file(s) this task changed.`))
      continue
    }
    out.push(full())
  }
  return out
}
