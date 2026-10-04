/**
 * One line per task: `[ ] t1  Buy milk` (or `[x]` when done). No tasks gives "No tasks.".
 */
export function renderTasks(tasks) {
  if (tasks.length === 0) return 'No tasks.'
  return tasks.map((task) => `${task.done ? '[x]' : '[ ]'} ${task.id}  ${task.title}`).join('\n')
}
