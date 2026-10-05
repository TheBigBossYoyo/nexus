import { isValidDateString } from './dates.js'

export const PRIORITIES = ['low', 'normal', 'high']

/**
 * A task is `{ id, title, done, priority, dueDate }`.
 * priority is one of PRIORITIES (default 'normal'); dueDate is YYYY-MM-DD or null.
 */
export function createTask({ id, title, done = false, priority = 'normal', dueDate = null }) {
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
  if (!PRIORITIES.includes(priority)) {
    throw new RangeError(`invalid priority: ${String(priority)}`)
  }
  if (dueDate !== null && !isValidDateString(dueDate)) {
    throw new RangeError(`invalid due date: ${String(dueDate)}`)
  }
  return { id, title: trimmed, done: Boolean(done), priority, dueDate }
}

export function completeTask(task) {
  return { ...task, done: true }
}
