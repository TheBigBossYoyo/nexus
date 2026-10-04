/** Next unused id of the form t<number> given the existing tasks. */
export function nextId(tasks) {
  let max = 0
  for (const task of tasks) {
    const match = /^t(\d+)$/.exec(task.id)
    if (match) max = Math.max(max, Number(match[1]))
  }
  return `t${max + 1}`
}
