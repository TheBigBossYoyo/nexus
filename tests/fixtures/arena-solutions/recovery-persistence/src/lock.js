import { resolve } from 'node:path'
import { StoreError } from './errors.js'

/** Locks held by open handles in this process. */
const held = new Set()

function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

/** A lock is stale when its owner is gone (or the file is unreadable garbage). */
function isStale(fs, path) {
  let text
  try {
    text = String(fs.readFileSync(path, 'utf8'))
  } catch (error) {
    return error.code === 'ENOENT'
  }
  const pid = Number.parseInt(text.trim(), 10)
  if (!Number.isInteger(pid) || pid <= 0) return true
  // The same pid with no open handle in this process is a leftover from an earlier incarnation.
  if (pid === process.pid) return true
  return !isAlive(pid)
}

/**
 * Take the directory lock: the file `LOCK` holds the owning process id as decimal text.
 * Returns a function that releases the lock.
 */
export function acquireLock(fs, path) {
  const key = resolve(path)
  if (held.has(key)) throw new StoreError('LOCKED', `store is locked: ${path}`)
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.writeFileSync(path, String(process.pid), { flag: 'wx' })
      held.add(key)
      return () => {
        held.delete(key)
        try {
          fs.unlinkSync(path)
        } catch {
          // already gone
        }
      }
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      if (!isStale(fs, path)) throw new StoreError('LOCKED', `store is locked: ${path}`)
      try {
        fs.unlinkSync(path)
      } catch (unlinkError) {
        if (unlinkError.code !== 'ENOENT') throw unlinkError
      }
    }
  }
  throw new StoreError('LOCKED', `store is locked: ${path}`)
}
