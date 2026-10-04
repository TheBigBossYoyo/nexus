import { StoreError } from './errors.js'

/**
 * Take the directory lock: the file `LOCK` holds the owning process id as decimal text.
 * Returns a function that releases the lock.
 */
export function acquireLock(fs, path) {
  try {
    fs.writeFileSync(path, String(process.pid), { flag: 'wx' })
  } catch (error) {
    if (error.code === 'EEXIST') throw new StoreError('LOCKED', `store is locked: ${path}`)
    throw error
  }
  return () => {
    try {
      fs.unlinkSync(path)
    } catch {
      // already gone
    }
  }
}
