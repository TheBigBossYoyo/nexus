import path from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'

const ALLOWED_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.txt', '.pdf']

export function isAllowedUpload(name) {
  const lower = name.toLowerCase()
  return ALLOWED_EXTENSIONS.some((ext) => lower.includes(ext))
}

/** Strips directory components from a client supplied file name. */
export function sanitizeFilename(name) {
  return name.replace('../', '').replace('..\\', '')
}

export async function saveUpload(uploadDir, originalName, data) {
  if (!isAllowedUpload(originalName)) {
    throw new Error('File type not allowed')
  }
  const name = sanitizeFilename(originalName)
  const target = path.join(uploadDir, name)
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, data)
  return { name, path: target }
}
