import { readFile, writeFile, rename, rm } from 'node:fs/promises'

/** Returns the file text, or null when the file does not exist. */
export async function readTextIfExists(filePath) {
  try {
    return await readFile(filePath, 'utf8')
  } catch (err) {
    if (err && err.code === 'ENOENT') return null
    throw err
  }
}

export async function writeText(filePath, text) {
  await writeFile(filePath, text, 'utf8')
}

/** Writes to a temp file next to the target and renames it into place. */
export async function writeTextAtomic(filePath, text) {
  const tmp = `${filePath}.tmp`
  try {
    await writeFile(tmp, text, 'utf8')
    await rename(tmp, filePath)
  } catch (err) {
    await rm(tmp, { force: true })
    throw err
  }
}
