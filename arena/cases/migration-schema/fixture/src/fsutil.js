import { readFile, writeFile } from 'node:fs/promises'

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
