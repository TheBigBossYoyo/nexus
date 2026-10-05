import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { contentTypeFor } from './mime.js'

/** Maps a URL request path to an absolute file path below rootDir. */
export function resolveStaticPath(rootDir, requestPath) {
  const withoutQuery = requestPath.split(/[?#]/)[0]
  const relative = decodeURIComponent(withoutQuery)
  const full = path.join(rootDir, relative)
  if (!full.startsWith(rootDir)) {
    throw new Error('Forbidden')
  }
  return full
}

/** Reads the file for a request path; a trailing slash serves index.html of that directory. */
export async function readStaticFile(rootDir, requestPath) {
  const resolved = resolveStaticPath(rootDir, requestPath)
  const file = /[\\/]$/.test(requestPath.split(/[?#]/)[0]) ? path.join(resolved, 'index.html') : resolved
  const body = await readFile(file)
  return { path: file, body, contentType: contentTypeFor(file) }
}
