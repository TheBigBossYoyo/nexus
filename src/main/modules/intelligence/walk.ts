import { lstat, open, readdir } from 'node:fs/promises'
import { join } from 'node:path'

/** Same vendor/generated skip list as the project profiler, plus a few cache directories. */
export const SKIP_DIRS: ReadonlySet<string> = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  'target',
  '.venv',
  'venv',
  'vendor',
  '__pycache__',
  '.next',
  'coverage',
  '.cache',
  '.turbo',
])

const SECRET_NAME = /^(\.env($|[._-])|id_rsa|id_dsa|id_ecdsa|id_ed25519|credentials)|\.(pem|key|p12|pfx)$/i

/** Files whose content must never be read or cited as evidence. */
export function isSecretName(name: string): boolean {
  return SECRET_NAME.test(name)
}

export function isSecretPath(rel: string): boolean {
  return rel.split('/').some(isSecretName)
}

export interface WalkedFile {
  /** Repo-relative, forward slashes. */
  path: string
  size: number
}

export interface WalkResult {
  files: WalkedFile[]
  /** True when a cap (file count or time) stopped the walk early. */
  truncated: boolean
}

const STAT_BATCH = 64

/** Bounded breadth-first walk in sorted order. Symlinks and junctions are never followed or listed. */
export async function walkRepository(
  root: string,
  maxFiles: number,
  deadline: number,
): Promise<WalkResult> {
  const files: WalkedFile[] = []
  const queue: string[] = ['']
  let truncated = false

  while (queue.length > 0) {
    if (Date.now() >= deadline || files.length >= maxFiles) {
      truncated = true
      break
    }
    const rel = queue.shift() ?? ''
    let entries
    try {
      entries = await readdir(rel === '' ? root : join(root, rel), { withFileTypes: true })
    } catch {
      continue
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    const names: string[] = []
    for (const e of entries) {
      if (e.isSymbolicLink()) continue
      const childRel = rel === '' ? e.name : `${rel}/${e.name}`
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) queue.push(childRel)
      } else if (e.isFile() && !isSecretName(e.name)) {
        names.push(childRel)
      }
    }
    for (let i = 0; i < names.length; i += STAT_BATCH) {
      const room = maxFiles - files.length
      if (room <= 0) {
        truncated = true
        break
      }
      const batch = names.slice(i, i + Math.min(STAT_BATCH, room))
      const stats = await Promise.all(
        batch.map((p) =>
          lstat(join(root, p)).then(
            (s) => (s.isFile() ? s.size : -1),
            () => -1,
          ),
        ),
      )
      batch.forEach((p, idx) => {
        const size = stats[idx] ?? -1
        if (size >= 0) files.push({ path: p, size })
      })
      if (i + STAT_BATCH < names.length && files.length >= maxFiles) truncated = true
    }
  }
  if (queue.length > 0 && files.length >= maxFiles) truncated = true
  return { files, truncated }
}

/** Reads at most `maxBytes` of a regular, non-secret file. Never follows symlinks. Null on any failure. */
export async function readBounded(root: string, rel: string, maxBytes: number): Promise<string | null> {
  if (isSecretPath(rel) || rel.startsWith('..') || rel.includes('\0')) return null
  const full = join(root, ...rel.split('/'))
  try {
    const st = await lstat(full)
    if (!st.isFile()) return null
    const handle = await open(full, 'r')
    try {
      const length = Math.min(st.size, maxBytes)
      const buf = Buffer.alloc(length)
      const { bytesRead } = await handle.read(buf, 0, length, 0)
      const text = buf.toString('utf8', 0, bytesRead)
      return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
    } finally {
      await handle.close()
    }
  } catch {
    return null
  }
}
