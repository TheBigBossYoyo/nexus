import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, parse } from 'node:path'

export interface ResolveExecutableOptions {
  /** Electron's `process.resourcesPath` (packaged app). Passed in so this module never imports electron. */
  resourcesPath?: string
  cwd?: string
  platform?: NodeJS.Platform
  arch?: string
  /** Test seam: module resolution. Defaults to `require.resolve` relative to this file. */
  resolveModule?: (id: string) => string
  /** Test seam: file existence check. */
  exists?: (path: string) => boolean
}

/** Electron cannot exec a file inside app.asar; the unpacked sibling must be used instead. */
export function rewriteAsarPath(path: string): string {
  return path.replace(/app\.asar(?=[\\/]|$)/, 'app.asar.unpacked')
}

/**
 * Locates the native Claude Code binary shipped in the platform package of the Agent SDK. Returns
 * undefined when nothing is found so the SDK can apply its own default lookup.
 */
export function resolveClaudeExecutable(options: ResolveExecutableOptions = {}): string | undefined {
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  const exists = options.exists ?? existsSync
  const pkg = `@anthropic-ai/claude-agent-sdk-${platform}-${arch}`
  const file = platform === 'win32' ? 'claude.exe' : 'claude'
  const candidates: string[] = []

  try {
    const resolve = options.resolveModule ?? createRequire(import.meta.url).resolve
    candidates.push(resolve(`${pkg}/${file}`))
  } catch {
    // fall through to directory walking
  }

  if (options.resourcesPath) {
    candidates.push(join(options.resourcesPath, 'app.asar.unpacked', 'node_modules', pkg, file))
    candidates.push(join(options.resourcesPath, 'app', 'node_modules', pkg, file))
  }
  for (const start of [options.cwd ?? process.cwd()]) {
    let dir = start
    for (;;) {
      candidates.push(join(dir, 'node_modules', pkg, file))
      const parent = dirname(dir)
      if (parent === dir || dir === parse(dir).root) break
      dir = parent
    }
  }

  for (const candidate of candidates) {
    const fixed = rewriteAsarPath(candidate)
    if (exists(fixed)) return fixed
  }
  return undefined
}
