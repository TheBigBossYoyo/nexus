import { lstatSync, realpathSync } from 'node:fs'
import path from 'node:path'

const RESERVED_DEVICE = /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\..*)?$/i

export class PathBoundaryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PathBoundaryError'
  }
}

/**
 * Resolves `input` (relative paths against `base`) to the real on-disk location. For paths that do
 * not exist yet, the nearest existing ancestor is resolved through symlinks/junctions/8.3 aliases
 * and the missing tail is appended. UNC/device paths, alternate data streams and wildcards throw.
 */
export function canonicalizePath(input: string, base: string): string {
  if (input.includes('\0')) throw new PathBoundaryError('path contains a NUL character')
  let p = input
  if (/^[\\/]{2}[?.][\\/][a-zA-Z]:/.test(p)) p = p.slice(4)
  else if (/^[\\/]{2}/.test(p)) throw new PathBoundaryError(`UNC and device paths are not permitted: ${input}`)

  const afterDrive = /^[a-zA-Z]:/.test(p) ? p.slice(2) : p
  if (afterDrive.includes(':')) throw new PathBoundaryError(`alternate data streams are not permitted: ${input}`)
  if (/[?*<>"|]/.test(afterDrive)) throw new PathBoundaryError(`path contains characters invalid on Windows: ${input}`)
  // `C:foo` means "foo in the current directory of drive C", which depends on process state rather than on `base`.
  if (process.platform === 'win32' && /^[a-zA-Z]:(?![\\/])/.test(p)) throw new PathBoundaryError(`drive-relative paths are not permitted: ${input}`)

  if (process.platform === 'win32') {
    // CON, NUL, COM1, LPT1, AUX, PRN ... (with any extension) are devices in every directory, not files.
    for (const seg of p.split(/[\\/]/)) {
      if (RESERVED_DEVICE.test(seg.replace(/[. ]+$/, ''))) throw new PathBoundaryError(`Windows device names are not permitted: ${input}`)
    }
    // Windows ignores trailing dots and spaces in a segment, so ".git." is the .git directory.
    p = p
      .split(/[\\/]/)
      .map((seg) => (seg === '.' || seg === '..' ? seg : seg.replace(/[. ]+$/, '')))
      .join('\\')
  }
  return realpathNearest(path.resolve(base, p))
}

function realpathNearest(abs: string): string {
  let cur = abs
  const tail: string[] = []
  for (;;) {
    try {
      const real = realpathSync.native(cur)
      return tail.length === 0 ? real : path.join(real, ...tail.reverse())
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw e
      if (exists(cur)) throw new PathBoundaryError(`dangling link at ${cur}`)
      const parent = path.dirname(cur)
      if (parent === cur) return abs
      tail.push(path.basename(cur))
      cur = parent
    }
  }
}

function exists(p: string): boolean {
  try {
    lstatSync(p)
    return true
  } catch {
    return false
  }
}

/** Both arguments must already be canonical. Case-insensitive on Windows (drive letters included). */
export function isPathInside(root: string, target: string): boolean {
  const rel = path.relative(root, target)
  if (rel === '') return true
  if (path.isAbsolute(rel)) return false
  return rel !== '..' && !rel.startsWith(`..${path.sep}`)
}

/** True when the canonical `target` has a `.git` segment below `root`. */
export function isInsideGitDir(root: string, target: string): boolean {
  const rel = path.relative(root, target)
  if (path.isAbsolute(rel)) return false
  return rel.split(/[\\/]/).some((s) => s.toLowerCase() === '.git')
}

const TEMPLATE_SUFFIX = /\.(example|sample|template|dist|defaults?)$/

/** Heuristic for secret-bearing files. Works on raw words, globs and paths with either separator. */
export function isSecretPath(p: string): boolean {
  const segs = p
    .replace(/\\/g, '/')
    .split('/')
    .filter((s) => s.length > 0)
    .map((s) => s.toLowerCase())
  if (segs.some((s) => s === '.ssh' || s === '.aws')) return true
  const base = segs[segs.length - 1]
  if (base === undefined) return false
  if (base.startsWith('.env') && (base.length === 4 || '.*?'.includes(base.charAt(4)))) {
    return !TEMPLATE_SUFFIX.test(base)
  }
  if (/\.(pem|key|p12|pfx)$/.test(base)) return true
  if (/^id_(rsa|dsa|ecdsa|ed25519)/.test(base)) return true
  if (base.startsWith('credentials') || base.startsWith('.credentials')) return true
  return ['.npmrc', '.netrc', '.pgpass', '.git-credentials'].includes(base)
}
