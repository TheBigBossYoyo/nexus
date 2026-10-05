import path from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'

const ALLOWED_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.txt', '.pdf'])
const RESERVED_DEVICE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i

function isSafeBaseName(name) {
  if (typeof name !== 'string' || name.length === 0 || name.length > 200) return false
  if (/[\u0000-\u001f<>:"/\\|?*]/.test(name)) return false
  if (/[. ]$/.test(name) || /^[. ]/.test(name)) return false
  const stem = name.split('.')[0].trimEnd()
  return !RESERVED_DEVICE.test(stem)
}

export function isAllowedUpload(name) {
  if (!isSafeBaseName(name)) return false
  return ALLOWED_EXTENSIONS.has(path.extname(name).toLowerCase())
}

/** Returns the file name if it is a plain, safe base name; throws otherwise. */
export function sanitizeFilename(name) {
  if (!isSafeBaseName(name)) throw new Error('Invalid file name')
  return name
}

export async function saveUpload(uploadDir, originalName, data) {
  if (!isAllowedUpload(originalName)) {
    throw new Error('File type not allowed')
  }
  const name = sanitizeFilename(originalName)
  const root = path.resolve(uploadDir)
  const target = path.join(root, name)
  if (path.dirname(target) !== root) throw new Error('Invalid file name')
  await mkdir(root, { recursive: true })
  await writeFile(target, data)
  return { name, path: target }
}
