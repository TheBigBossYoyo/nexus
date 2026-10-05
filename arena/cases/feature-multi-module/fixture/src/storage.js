import { createTask } from './model.js'

export const FORMAT_VERSION = 1

/** Serialise tasks to the persisted JSON text. */
export function serializeTasks(tasks) {
  const payload = {
    version: FORMAT_VERSION,
    tasks: tasks.map((task) => ({ id: task.id, title: task.title, done: task.done })),
  }
  return `${JSON.stringify(payload, null, 2)}\n`
}

/** Parse persisted JSON text back into tasks. Empty text means no tasks. */
export function deserializeTasks(text) {
  if (text.trim() === '') return []
  const payload = JSON.parse(text)
  if (payload.version !== FORMAT_VERSION) {
    throw new RangeError(`unsupported data version: ${String(payload.version)}`)
  }
  if (!Array.isArray(payload.tasks)) {
    throw new TypeError('data file is missing its tasks array')
  }
  return payload.tasks.map((raw) => createTask(raw))
}
