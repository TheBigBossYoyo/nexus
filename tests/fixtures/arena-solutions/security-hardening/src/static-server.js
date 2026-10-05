import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { contentTypeFor } from './mime.js'

function forbidden(message = 'Forbidden') {
  const err = new Error(message)
  err.code = 'EFORBIDDEN'
  return err
}

/** Maps a URL request path to an absolute file path below rootDir. Throws for anything that could escape it. */
export function resolveStaticPath(rootDir, requestPath) {
  if (typeof requestPath !== 'string') throw forbidden('Bad request path')
  const root = path.resolve(rootDir)
  let relative
  try {
    relative = decodeURIComponent(requestPath.split(/[?#]/)[0])
  } catch {
    throw forbidden('Bad request path')
  }
  // NUL, drive letters / alternate data streams, and UNC style prefixes.
  if (relative.includes('\0') || relative.includes(':')) throw forbidden()
  const segments = relative.split(/[\\/]+/).filter((s) => s !== '' && s !== '.')
  for (const segment of segments) {
    // ".." and Windows-normalised variants such as "..." or ".. " (trailing dots/spaces are dropped by the OS).
    if (/^[. ]+$/.test(segment)) throw forbidden()
  }
  const full = path.join(root, ...segments)
  const rel = path.relative(root, full)
  if (rel.split(path.sep)[0] === '..' || path.isAbsolute(rel)) throw forbidden()
  return full
}

/** Reads the file for a request path; a trailing slash serves index.html of that directory. */
export async function readStaticFile(rootDir, requestPath) {
  const resolved = resolveStaticPath(rootDir, requestPath)
  const file = /[\\/]$/.test(requestPath.split(/[?#]/)[0]) ? path.join(resolved, 'index.html') : resolved
  const body = await readFile(file)
  return { path: file, body, contentType: contentTypeFor(file) }
}
