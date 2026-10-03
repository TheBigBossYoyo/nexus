/**
 * A claim is a path subtree ("tree": a file, a directory and everything beneath it, or `dir/**`)
 * or the direct children of a directory ("children": `dir/*`, not their contents).
 */
interface Claim {
  base: string[]
  mode: 'tree' | 'children'
  text: string
}

/** Slashes, case, leading "./" and trailing "/" are normalized; Windows paths compare case-insensitively. */
export function normalizeFilePattern(raw: string): string {
  let p = raw.trim().replace(/\\/g, '/').toLowerCase()
  p = p.replace(/\/{2,}/g, '/')
  while (p.startsWith('./')) p = p.slice(2)
  if (p === '.') p = ''
  return p.replace(/\/+$/, '')
}

function parseClaim(raw: string): Claim | null {
  let p = normalizeFilePattern(raw)
  let mode: Claim['mode'] = 'tree'
  if (p === '**' || p === '*' || p.endsWith('/**') || p.endsWith('/*')) {
    mode = p.endsWith('**') ? 'tree' : 'children'
    p = p.slice(0, p.endsWith('**') ? -2 : -1).replace(/\/+$/, '')
  } else if (p === '') {
    return null
  }
  return { base: p === '' ? [] : p.split('/'), mode, text: normalizeFilePattern(raw) }
}

const isPrefix = (prefix: readonly string[], of: readonly string[]): boolean =>
  prefix.length <= of.length && prefix.every((seg, i) => seg === of[i])

/** The narrower claim when the two overlap, else null. */
function intersect(a: Claim, b: Claim): Claim | null {
  if (a.mode === 'tree' && b.mode === 'tree') {
    if (isPrefix(a.base, b.base)) return b
    if (isPrefix(b.base, a.base)) return a
    return null
  }
  if (a.mode === 'children' && b.mode === 'children') {
    return a.base.length === b.base.length && isPrefix(a.base, b.base) ? a : null
  }
  const [children, tree] = a.mode === 'children' ? [a, b] : [b, a]
  // The tree contains the whole directory, or sits on a direct child of it.
  if (isPrefix(tree.base, children.base)) return children
  if (tree.base.length === children.base.length + 1 && isPrefix(children.base, tree.base)) return tree
  return null
}

/**
 * Normalized entries of `a` and `b` that claim the same files, deduplicated and sorted.
 * Empty entries are ignored, so a task with no suggested files never conflicts.
 */
export function findOverlappingFiles(a: readonly string[], b: readonly string[]): string[] {
  const claimsB = b.map(parseClaim).filter((c): c is Claim => c !== null)
  const out = new Set<string>()
  for (const ca of a.map(parseClaim)) {
    if (!ca) continue
    for (const cb of claimsB) {
      const hit = intersect(ca, cb)
      if (hit) out.add(hit.text)
    }
  }
  return [...out].sort()
}

export function filesOverlap(a: readonly string[], b: readonly string[]): boolean {
  return findOverlappingFiles(a, b).length > 0
}
