import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { deserializeTasks, serializeTasks } from './storage.js'

/** Keeps the serialised text in memory; useful for tests and previews. */
export class MemoryStore {
  text = ''

  load() {
    return deserializeTasks(this.text)
  }

  save(tasks) {
    this.text = serializeTasks(tasks)
  }
}

/** Persists tasks to a file. A missing file means no tasks yet. */
export class FileStore {
  constructor(filePath) {
    this.filePath = filePath
  }

  load() {
    let text
    try {
      text = readFileSync(this.filePath, 'utf8')
    } catch (error) {
      if (error && error.code === 'ENOENT') return []
      throw error
    }
    return deserializeTasks(text)
  }

  save(tasks) {
    mkdirSync(dirname(this.filePath), { recursive: true })
    writeFileSync(this.filePath, serializeTasks(tasks), 'utf8')
  }
}
