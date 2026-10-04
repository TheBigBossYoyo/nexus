import { createTask } from './model.js'

export const FORMAT_VERSION = 2

/** Serialise tasks to the persisted JSON text. */
export function serializeTasks(tasks) {
  const payload = {
    version: FORMAT_VERSION,
    tasks: tasks.map((task) => ({
      id: task.id,
      title: task.title,
      done: task.done,
      priority: task.priority,
      dueDate: task.dueDate,
    })),
  }
  return `${JSON.stringify(payload, null, 2)}\n`
}

/** Parse persisted JSON text (version 1 or 2) back into tasks. Empty text means no tasks. */
export function deserializeTasks(text) {
  if (text.trim() === '') return []
  const payload = JSON.parse(text)
  if (payload.version !== 1 && payload.version !== 2) {
    throw new RangeError(`unsupported data version: ${String(payload.version)}`)
  }
  if (!Array.isArray(payload.tasks)) {
    throw new TypeError('data file is missing its tasks array')
  }
  return payload.tasks.map((raw) => createTask(raw))
}
