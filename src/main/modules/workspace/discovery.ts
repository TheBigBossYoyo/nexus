import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import type { DependencyKind, EdgeProvenance } from '@shared/workspace'

/**
 * What a repository says about itself in its own manifest, and the dependencies between enrolled
 * repositories that follow from it. Read from files only: nothing is installed, resolved or fetched, and
 * a repository's stack is never assumed from another one's.
 */

export interface ManifestDependency {
  name: string
  /** The version or path specification as written. */
  spec: string
  /** 1-based line in the manifest, when found. */
  line: number | null
}

export interface ManifestInfo {
  /** File name relative to the repository root. */
  file: string
  name: string | null
  version: string | null
  dependencies: ManifestDependency[]
}

const MAX_MANIFEST_BYTES = 256_000

function readText(path: string): string | null {
  try {
    if (!existsSync(path)) return null
    const text = readFileSync(path, 'utf8')
    return text.length > MAX_MANIFEST_BYTES ? null : text
  } catch {
    return null
  }
}

const lineOf = (text: string, needle: string): number | null => {
  const index = text.indexOf(needle)
  return index === -1 ? null : text.slice(0, index).split('\n').length
}

function packageJson(text: string): ManifestInfo | null {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof json !== 'object' || json === null) return null
  const pkg = json as Record<string, unknown>
  const dependencies: ManifestDependency[] = []
  for (const bucket of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const deps = pkg[bucket]
    if (typeof deps !== 'object' || deps === null) continue
    for (const [name, spec] of Object.entries(deps as Record<string, unknown>)) {
      dependencies.push({ name, spec: String(spec), line: lineOf(text, `"${name}"`) })
    }
  }
  return { file: 'package.json', name: typeof pkg['name'] === 'string' ? pkg['name'] : null, version: typeof pkg['version'] === 'string' ? pkg['version'] : null, dependencies }
}

/** The lines of one `[section]` of a TOML file (enough for names, versions and dependency tables). */
function tomlSection(text: string, section: string): string[] {
  const lines = text.split(/\r?\n/)
  const out: string[] = []
  let inside = false
  for (const line of lines) {
    const header = /^\s*\[([^\]]+)\]\s*$/.exec(line)
    if (header) {
      inside = header[1]?.trim() === section
      continue
    }
    if (inside) out.push(line)
  }
  return out
}

const tomlString = (lines: string[], key: string): string | null => {
  for (const line of lines) {
    const m = new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']*)["']`).exec(line)
    if (m) return m[1] ?? null
  }
  return null
}

function cargoToml(text: string): ManifestInfo {
  const pkg = tomlSection(text, 'package')
  const dependencies: ManifestDependency[] = []
  for (const section of ['dependencies', 'dev-dependencies', 'build-dependencies']) {
    for (const line of tomlSection(text, section)) {
      const m = /^\s*([\w-]+)\s*=\s*(.+)$/.exec(line)
      if (m) dependencies.push({ name: m[1] ?? '', spec: (m[2] ?? '').trim(), line: lineOf(text, line) })
    }
  }
  return { file: 'Cargo.toml', name: tomlString(pkg, 'name'), version: tomlString(pkg, 'version'), dependencies }
}

function pyproject(text: string): ManifestInfo {
  const project = tomlSection(text, 'project')
  const poetry = tomlSection(text, 'tool.poetry')
  const dependencies: ManifestDependency[] = []
  // PEP 621: dependencies = ["name>=1", ...] possibly over several lines.
  const list = /^\s*dependencies\s*=\s*\[([\s\S]*?)\]/m.exec(text)?.[1] ?? ''
  for (const m of list.matchAll(/["']([A-Za-z0-9_.-]+)\s*([^"']*)["']/g)) dependencies.push({ name: m[1] ?? '', spec: (m[2] ?? '').trim(), line: lineOf(text, m[0]) })
  for (const line of tomlSection(text, 'tool.poetry.dependencies')) {
    const m = /^\s*([\w.-]+)\s*=\s*(.+)$/.exec(line)
    if (m && m[1] !== 'python') dependencies.push({ name: m[1] ?? '', spec: (m[2] ?? '').trim(), line: lineOf(text, line) })
  }
  return { file: 'pyproject.toml', name: tomlString(project, 'name') ?? tomlString(poetry, 'name'), version: tomlString(project, 'version') ?? tomlString(poetry, 'version'), dependencies }
}

function goMod(text: string): ManifestInfo {
  const dependencies: ManifestDependency[] = []
  for (const m of text.matchAll(/^\s*(?:require\s+)?([\w./-]+\.[\w./-]+)\s+(v[\w.+-]+)/gm)) dependencies.push({ name: m[1] ?? '', spec: m[2] ?? '', line: lineOf(text, m[0]) })
  for (const m of text.matchAll(/^\s*replace\s+([\w./-]+)\s*(?:v[\w.+-]+\s*)?=>\s*(\S+)/gm)) dependencies.push({ name: m[1] ?? '', spec: `=> ${m[2] ?? ''}`, line: lineOf(text, m[0]) })
  return { file: 'go.mod', name: /^\s*module\s+(\S+)/m.exec(text)?.[1] ?? null, version: null, dependencies }
}

/** The first manifest found in the repository root, in a fixed order. Null when the repository has none. */
export function readManifest(root: string): ManifestInfo | null {
  const pkg = readText(join(root, 'package.json'))
  if (pkg !== null) {
    const info = packageJson(pkg)
    if (info) return info
  }
  const cargo = readText(join(root, 'Cargo.toml'))
  if (cargo !== null) return cargoToml(cargo)
  const py = readText(join(root, 'pyproject.toml'))
  if (py !== null) return pyproject(py)
  const go = readText(join(root, 'go.mod'))
  if (go !== null) return goMod(go)
  return null
}

export interface DiscoveredEdge {
  /** Key of the repository that depends. */
  from: string
  /** Key of the repository depended on. */
  to: string
  kind: DependencyKind
  provenance: EdgeProvenance
}

const samePath = (a: string, b: string): boolean => resolve(a).replace(/[\\/]+$/, '').toLowerCase() === resolve(b).replace(/[\\/]+$/, '').toLowerCase()

/** A local path a dependency specification points at (`file:../x`, `link:../x`, `{ path = "../x" }`, `=> ../x`). */
function localPath(spec: string): string | null {
  const direct = /^(?:file:|link:|portal:)(.+)$/.exec(spec.trim())?.[1]
  if (direct) return direct
  const toml = /path\s*=\s*["']([^"']+)["']/.exec(spec)?.[1]
  if (toml) return toml
  const go = /^=>\s*(\.{1,2}[\\/].*|[A-Za-z]:[\\/].*|\/.*)$/.exec(spec.trim())?.[1]
  return go ?? null
}

/**
 * Dependencies between the given repositories that their manifests state: a dependency whose name is another
 * repository's package name, or whose specification is a local path to another repository. Each edge carries
 * the manifest file and line that shows it.
 */
export function discoverManifestEdges(repositories: readonly { key: string; rootPath: string; manifest: ManifestInfo | null }[]): DiscoveredEdge[] {
  const edges: DiscoveredEdge[] = []
  const seen = new Set<string>()
  for (const repo of repositories) {
    if (!repo.manifest) continue
    for (const dep of repo.manifest.dependencies) {
      const path = localPath(dep.spec)
      const target = repositories.find((other) => {
        if (other.key === repo.key) return false
        if (other.manifest?.name && other.manifest.name === dep.name) return true
        if (path === null) return false
        return samePath(isAbsolute(path) ? path : join(repo.rootPath, path), other.rootPath)
      })
      if (!target || seen.has(`${repo.key}>${target.key}`)) continue
      seen.add(`${repo.key}>${target.key}`)
      edges.push({
        from: repo.key,
        to: target.key,
        kind: 'package_dependency',
        provenance: { source: 'manifest', file: dep.line !== null ? `${repo.manifest.file}:${dep.line}` : repo.manifest.file, detail: `${repo.manifest.file} declares ${dep.name} (${dep.spec.slice(0, 80)})` },
      })
    }
  }
  return edges
}
