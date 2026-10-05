/**
 * One line per task: `[ ] t1  [high] Buy milk (due 2025-03-01) OVERDUE`.
 * The priority tag is omitted for 'normal'. OVERDUE is added only when `today`
 * (YYYY-MM-DD) is given, the task is open and its due date is before today.
 * No tasks gives "No tasks.".
 */
export function renderTasks(tasks, { today } = {}) {
  if (tasks.length === 0) return 'No tasks.'
  return tasks
    .map((task) => {
      const tag = task.priority === 'high' || task.priority === 'low' ? `[${task.priority}] ` : ''
      const due = task.dueDate ? ` (due ${task.dueDate})` : ''
      const overdue = today && task.dueDate && !task.done && task.dueDate < today ? ' OVERDUE' : ''
      return `${task.done ? '[x]' : '[ ]'} ${task.id}  ${tag}${task.title}${due}${overdue}`
    })
    .join('\n')
}
