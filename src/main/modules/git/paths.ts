import { realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/** Real path of the deepest existing ancestor plus the not-yet-existing remainder. */
async function realpathLoose(p: string): Promise<string> {
  const abs = resolve(p)
  const pending: string[] = []
  let cur = abs
  for (;;) {
    try {
      const real = await realpath(cur)
      return pending.length > 0 ? join(real, ...pending.reverse()) : real
    } catch {
      const parent = dirname(cur)
      if (parent === cur) return abs
      pending.push(basename(cur))
      cur = parent
    }
  }
}

/** Stable comparison key for a path: resolved symlinks, normalized, case-folded on Windows. */
export async function pathKey(p: string): Promise<string> {
  const real = await realpathLoose(p)
  return process.platform === 'win32' ? real.toLowerCase() : real
}

/** True when `child` is `parent` or lies beneath it, after resolving symlinks and (on Windows) ignoring case. */
export async function isPathInside(child: string, parent: string): Promise<boolean> {
  const [c, p] = await Promise.all([pathKey(child), pathKey(parent)])
  const rel = relative(p, c)
  if (rel === '') return true
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}
