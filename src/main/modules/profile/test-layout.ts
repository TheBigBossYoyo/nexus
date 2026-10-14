import { isTestFile } from '@main/modules/intelligence/analyze'

/** Packages that make DOM or component tests possible, by what they are. */
const DOM_TEST_PACKAGES: [string, string][] = [
  ['@testing-library/react', 'React Testing Library'],
  ['@testing-library/vue', 'Vue Testing Library'],
  ['@testing-library/svelte', 'Svelte Testing Library'],
  ['@testing-library/dom', 'DOM Testing Library'],
  ['@vue/test-utils', 'Vue Test Utils'],
  ['jsdom', 'jsdom'],
  ['happy-dom', 'happy-dom'],
]
/** End-to-end tools: they drive the built application, they do not render components in a unit test. */
const E2E_PACKAGES: [string, string][] = [
  ['@playwright/test', 'Playwright'],
  ['cypress', 'Cypress'],
  ['webdriverio', 'WebdriverIO'],
]
const SOURCE = /\.(?:[cm]?[jt]sx?|py|go|rs|cs|java|kt|rb|php|vue|svelte)$/i

const stemOf = (path: string): string => {
  const name = path.slice(path.lastIndexOf('/') + 1)
  return name.replace(/\.(test|spec)(?=\.[a-z]+$)/i, '').replace(/^test_|_test(?=\.[a-z]+$)/, '').replace(/\.[a-z0-9]+$/i, '').toLowerCase()
}

/**
 * 0.9.1: how this project tests, in a few measured lines for the planner: where the tests are and how they are
 * named, the environment the test runner's configuration sets, whether a DOM testing library is installed, and
 * a few source files with the test that covers them. The first real mission of NEXUS on itself spent most of its
 * planning (19 turns) finding out how renderer code is tested here (no DOM: helpers are tested as functions).
 * Only what the files say; nothing is guessed. Empty when the project has no tests.
 */
export function describeTestLayout(input: { files: readonly string[]; deps: Readonly<Record<string, string>>; runnerConfigs: readonly { name: string; text: string }[] }): string[] {
  const tests = input.files.filter((f) => isTestFile(f))
  if (tests.length === 0) return []
  const lines: string[] = []
  const roots = new Map<string, number>()
  const suffixes = new Map<string, number>()
  for (const t of tests) {
    const segs = t.split('/')
    const root = segs.length > 2 ? `${segs[0]}/${segs[1]}` : (segs[0] ?? '')
    roots.set(root, (roots.get(root) ?? 0) + 1)
    const suffix = /(\.(?:test|spec)\.[a-z]+|_test\.[a-z]+)$/i.exec(t)?.[1]
    if (suffix) suffixes.set(suffix, (suffixes.get(suffix) ?? 0) + 1)
  }
  const top = [...roots.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 6)
  const named = [...suffixes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
  lines.push(`Tests: ${tests.length} files${named ? `, named *${named}` : ''}; in ${top.map(([r, n]) => `${r}/ (${n})`).join(', ')}`)
  for (const c of input.runnerConfigs) {
    const envs = [...new Set([...c.text.matchAll(/environment\s*:\s*['"]([a-z-]+)['"]/g)].map((m) => m[1] as string))]
    if (envs.length > 0) lines.push(`Test environment (${c.name}): ${envs.join(', ')}`)
  }
  const dom = DOM_TEST_PACKAGES.filter(([pkg]) => pkg in input.deps).map(([, what]) => what)
  lines.push(dom.length > 0 ? `DOM or component testing installed: ${dom.join(', ')}` : 'No DOM or component testing library installed: interface code is tested through the functions it uses.')
  const e2e = E2E_PACKAGES.filter(([pkg]) => pkg in input.deps).map(([, what]) => what)
  if (e2e.length > 0) lines.push(`End-to-end testing of the built application: ${e2e.join(', ')}`)
  // Source files beside the test that names them: the convention, by example.
  // Fixtures are not examples of anything: a folder named fixture(s) is left out on both sides, and a name shared by
  // several sources says nothing about which one a test covers.
  const fixture = (f: string): boolean => /(^|\/)(fixtures?|__fixtures__|testdata)(\/|$)/i.test(f)
  const sources = new Map<string, string>()
  for (const f of input.files) if (!isTestFile(f) && SOURCE.test(f) && !fixture(f)) sources.set(stemOf(f), sources.has(stemOf(f)) ? '' : f)
  const pairs: string[] = []
  for (const [root] of top) {
    const t = tests.find((x) => x.startsWith(`${root}/`) && /\.(test|spec)\.|_test\./i.test(x) && SOURCE.test(x) && !fixture(x) && (sources.get(stemOf(x)) ?? '') !== '')
    if (t !== undefined) pairs.push(`${sources.get(stemOf(t))} -> ${t}`)
    if (pairs.length >= 3) break
  }
  if (pairs.length > 0) lines.push(`For example: ${pairs.join('; ')}`)
  return lines
}
