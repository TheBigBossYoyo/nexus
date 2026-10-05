import { nextId } from './ids.js'
import { completeTask, createTask } from './model.js'

export class TodoService {
  #store
  #tasks

  constructor(store) {
    this.#store = store
    this.#tasks = store.load()
  }

  add(title) {
    const task = createTask({ id: nextId(this.#tasks), title })
    this.#tasks = [...this.#tasks, task]
    this.#store.save(this.#tasks)
    return task
  }

  complete(id) {
    const index = this.#indexOf(id)
    const updated = completeTask(this.#tasks[index])
    this.#tasks = this.#tasks.map((task, i) => (i === index ? updated : task))
    this.#store.save(this.#tasks)
    return updated
  }

  remove(id) {
    const index = this.#indexOf(id)
    this.#tasks = this.#tasks.filter((_, i) => i !== index)
    this.#store.save(this.#tasks)
  }

  /** Tasks in creation order. */
  list({ includeDone = true } = {}) {
    return this.#tasks.filter((task) => includeDone || !task.done)
  }

  #indexOf(id) {
    const index = this.#tasks.findIndex((task) => task.id === id)
    if (index === -1) throw new RangeError(`unknown task: ${String(id)}`)
    return index
  }
}
