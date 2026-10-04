import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'contacts-test-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

export function file(dir) {
  return join(dir, 'contacts.json')
}
