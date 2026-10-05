/**
 * A task is `{ id, title, done }`.
 */
export function createTask({ id, title, done = false }) {
  if (typeof id !== 'string' || id === '') {
    throw new TypeError('task id must be a non-empty string')
  }
  if (typeof title !== 'string') {
    throw new TypeError('task title must be a string')
  }
  const trimmed = title.trim()
  if (trimmed === '') {
    throw new RangeError('task title must not be empty')
  }
  return { id, title: trimmed, done: Boolean(done) }
}

export function completeTask(task) {
  return { ...task, done: true }
}
