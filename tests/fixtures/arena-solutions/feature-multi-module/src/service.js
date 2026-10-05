import { isValidDateString } from './dates.js'
import { nextId } from './ids.js'
import { PRIORITIES, completeTask, createTask } from './model.js'

const SORTS = ['created', 'priority', 'due']

export class TodoService {
  #store
  #tasks

  constructor(store) {
    this.#store = store
    this.#tasks = store.load()
  }

  add(title, { priority, dueDate } = {}) {
    const task = createTask({ id: nextId(this.#tasks), title, priority, dueDate })
    this.#tasks = [...this.#tasks, task]
    this.#store.save(this.#tasks)
    return task
  }

  complete(id) {
    return this.#update(id, completeTask)
  }

  setPriority(id, priority) {
    return this.#update(id, (task) => createTask({ ...task, priority }))
  }

  setDueDate(id, dueDate) {
    return this.#update(id, (task) => createTask({ ...task, dueDate }))
  }

  remove(id) {
    const index = this.#indexOf(id)
    this.#tasks = this.#tasks.filter((_, i) => i !== index)
    this.#store.save(this.#tasks)
  }

  /**
   * Tasks in creation order unless `sortBy` says otherwise. Filters: includeDone,
   * priority, dueBefore (strictly before the date; tasks without a due date never match).
   */
  list({ includeDone = true, priority, dueBefore, sortBy = 'created' } = {}) {
    if (priority !== undefined && !PRIORITIES.includes(priority)) {
      throw new RangeError(`invalid priority: ${String(priority)}`)
    }
    if (dueBefore !== undefined && !isValidDateString(dueBefore)) {
      throw new RangeError(`invalid dueBefore: ${String(dueBefore)}`)
    }
    if (!SORTS.includes(sortBy)) {
      throw new RangeError(`invalid sortBy: ${String(sortBy)}`)
    }
    const result = this.#tasks.filter(
      (task) =>
        (includeDone || !task.done) &&
        (priority === undefined || task.priority === priority) &&
        (dueBefore === undefined || (task.dueDate !== null && task.dueDate < dueBefore)),
    )
    if (sortBy === 'priority') {
      const rank = (task) => PRIORITIES.length - 1 - PRIORITIES.indexOf(task.priority)
      return result.sort((a, b) => rank(a) - rank(b))
    }
    if (sortBy === 'due') {
      return result.sort((a, b) => {
        if (a.dueDate === b.dueDate) return 0
        if (a.dueDate === null) return 1
        if (b.dueDate === null) return -1
        return a.dueDate < b.dueDate ? -1 : 1
      })
    }
    return result
  }

  #update(id, change) {
    const index = this.#indexOf(id)
    const updated = change(this.#tasks[index])
    this.#tasks = this.#tasks.map((task, i) => (i === index ? updated : task))
    this.#store.save(this.#tasks)
    return updated
  }

  #indexOf(id) {
    const index = this.#tasks.findIndex((task) => task.id === id)
    if (index === -1) throw new RangeError(`unknown task: ${String(id)}`)
    return index
  }
}
