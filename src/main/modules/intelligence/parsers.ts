/** Small, dependency-free parsers for manifests and import statements. All are tolerant: bad input yields empty output. */

export const LANGUAGE_BY_EXT: Record<string, string> = {
  ts: 'TypeScript',
  tsx: 'TypeScript',
  mts: 'TypeScript',
  cts: 'TypeScript',
  js: 'JavaScript',
  jsx: 'JavaScript',
  mjs: 'JavaScript',
  cjs: 'JavaScript',
  py: 'Python',
  rs: 'Rust',
  go: 'Go',
  cs: 'C#',
  java: 'Java',
  kt: 'Kotlin',
  rb: 'Ruby',
  php: 'PHP',
  swift: 'Swift',
  c: 'C',
  h: 'C',
  cpp: 'C++',
  cc: 'C++',
  hpp: 'C++',
  vue: 'Vue',
  svelte: 'Svelte',
}

export function extOf(path: string): string {
  const slash = path.lastIndexOf('/')
  const dot = path.lastIndexOf('.')
  return dot > slash + 1 ? path.slice(dot + 1).toLowerCase() : ''
}

export function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

export function dirName(path: string): string {
  const i = path.lastIndexOf('/')
  return i < 0 ? '' : path.slice(0, i)
}

/** Language family used for import parsing and test mapping. */
export function familyOf(path: string): 'js' | 'py' | 'go' | 'rs' | null {
  switch (extOf(path)) {
    case 'ts':
    case 'tsx':
    case 'mts':
    case 'cts':
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
      return 'js'
    case 'py':
      return 'py'
    case 'go':
      return 'go'
    case 'rs':
      return 'rs'
    default:
      return null
  }
}

// ───────────────────────────── JSON ─────────────────────────────

export function parseJsonObject(text: string | null): Record<string, unknown> | null {
  if (text === null) return null
  try {
    const v: unknown = JSON.parse(text)
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** JSON with comments and trailing commas (tsconfig style). */
export function parseJsonLoose(text: string | null): Record<string, unknown> | null {
  if (text === null) return null
  const noComments = text.replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (_m, str: string | undefined) => str ?? '')
  return parseJsonObject(noComments.replace(/,(\s*[}\]])/g, '$1'))
}

export function stringRecord(v: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
    for (const [k, val] of Object.entries(v)) if (typeof val === 'string') out[k] = val
  }
  return out
}

/** Collects string leaves of a package.json "exports"/"bin" style value (bounded). */
export function stringLeaves(v: unknown, limit = 20): string[] {
  const out: string[] = []
  const visit = (x: unknown, depth: number): void => {
    if (out.length >= limit || depth > 6) return
    if (typeof x === 'string') out.push(x)
    else if (Array.isArray(x)) for (const i of x) visit(i, depth + 1)
    else if (x !== null && typeof x === 'object') for (const i of Object.values(x)) visit(i, depth + 1)
  }
  visit(v, 0)
  return out
}

// ───────────────────────────── TOML-ish / go.mod ─────────────────────────────

/** Lines of a `[section]` (header matched exactly), up to the next header. */
export function tomlSection(text: string, header: string): string[] {
  const lines = text.split(/\r?\n/)
  const out: string[] = []
  let inside = false
  for (const raw of lines) {
    const line = raw.trim()
    if (line.startsWith('[')) {
      inside = line === `[${header}]`
      continue
    }
    if (inside && line !== '' && !line.startsWith('#')) out.push(line)
  }
  return out
}

export interface DepSpec {
  name: string
  spec: string
}

export function parseCargoDependencies(text: string): DepSpec[] {
  const out: DepSpec[] = []
  for (const line of tomlSection(text, 'dependencies')) {
    const m = /^([A-Za-z0-9_-]+)(?:\.workspace)?\s*=\s*(.+)$/.exec(line)
    if (!m) continue
    const name = m[1] ?? ''
    const rhs = m[2] ?? ''
    const quoted = /^"([^"]*)"/.exec(rhs)
    const version = /version\s*=\s*"([^"]*)"/.exec(rhs)
    out.push({ name, spec: quoted?.[1] ?? version?.[1] ?? (rhs.includes('workspace') ? 'workspace' : '*') })
  }
  return out
}

export function parsePyprojectDependencies(text: string): DepSpec[] {
  const out: DepSpec[] = []
  const project = /^\[project\]([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(text)
  const arr = project ? /^dependencies\s*=\s*\[([\s\S]*?)\]/m.exec(project[1] ?? '') : null
  if (arr) {
    for (const m of (arr[1] ?? '').matchAll(/["']([^"']+)["']/g)) {
      const item = m[1] ?? ''
      const nm = /^[A-Za-z0-9_.-]+/.exec(item)
      if (nm) out.push({ name: nm[0], spec: item.slice(nm[0].length).trim() || '*' })
    }
  }
  for (const line of tomlSection(text, 'tool.poetry.dependencies')) {
    const m = /^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/.exec(line)
    if (!m || m[1] === 'python') continue
    const rhs = m[2] ?? ''
    const q = /^"([^"]*)"/.exec(rhs) ?? /version\s*=\s*"([^"]*)"/.exec(rhs)
    out.push({ name: m[1] ?? '', spec: q?.[1] ?? '*' })
  }
  return out
}

export function parseGoMod(text: string): { module: string | null; deps: DepSpec[] } {
  const module = /^module\s+(\S+)/m.exec(text)?.[1] ?? null
  const deps: DepSpec[] = []
  const take = (line: string): void => {
    if (/\/\/\s*indirect/.test(line)) return
    const m = /^\s*(\S+)\s+(v\S+)/.exec(line)
    if (m) deps.push({ name: m[1] ?? '', spec: m[2] ?? '' })
  }
  for (const block of text.matchAll(/^require\s*\(([\s\S]*?)^\)/gm)) {
    for (const l of (block[1] ?? '').split(/\r?\n/)) take(l)
  }
  for (const m of text.matchAll(/^require\s+([^(\s].*)$/gm)) take(m[1] ?? '')
  return { module, deps }
}

// ───────────────────────────── imports ─────────────────────────────

const JS_IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)(['"])([^'"\n]+)\1/g

/**
 * Raw import specifiers of a source file. Python relative imports keep their leading dots; Rust
 * specifiers are prefixed `mod:` or `crate:`; Go specifiers are import paths.
 */
export function extractImports(family: 'js' | 'py' | 'go' | 'rs', text: string): string[] {
  const out = new Set<string>()
  if (family === 'js') {
    for (const m of text.matchAll(JS_IMPORT)) if (m[2]) out.add(m[2])
  } else if (family === 'py') {
    for (const m of text.matchAll(/^[ \t]*from\s+(\.*)([\w.]*)\s+import\s+([^\n#]+)/gm)) {
      const dots = m[1] ?? ''
      const mod = m[2] ?? ''
      if (dots !== '' && mod === '') {
        for (const n of (m[3] ?? '').replace(/[()]/g, '').split(',')) {
          const name = /^\s*(\w+)/.exec(n)?.[1]
          if (name) out.add(`${dots}${name}`)
        }
      } else {
        out.add(`${dots}${mod}`)
      }
    }
    for (const m of text.matchAll(/^[ \t]*import\s+([\w., \t]+)/gm)) {
      for (const n of (m[1] ?? '').split(',')) {
        const name = /^\s*([\w.]+)/.exec(n)?.[1]
        if (name) out.add(name)
      }
    }
  } else if (family === 'go') {
    for (const m of text.matchAll(/^[ \t]*import\s+(?:[\w.]+\s+)?"([^"]+)"/gm)) if (m[1]) out.add(m[1])
    for (const block of text.matchAll(/^[ \t]*import\s*\(([\s\S]*?)\)/gm)) {
      for (const m of (block[1] ?? '').matchAll(/^[ \t]*(?:[\w.]+\s+)?"([^"]+)"/gm)) if (m[1]) out.add(m[1])
    }
  } else {
    for (const m of text.matchAll(/^[ \t]*(?:pub(?:\([^)]*\))?\s+)?mod\s+(\w+)\s*;/gm)) out.add(`mod:${m[1] ?? ''}`)
    for (const m of text.matchAll(/^[ \t]*(?:pub(?:\([^)]*\))?\s+)?use\s+crate::(\w+)/gm)) out.add(`crate:${m[1] ?? ''}`)
  }
  return [...out]
}
