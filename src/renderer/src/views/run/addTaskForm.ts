import type { AgentRole, Complexity } from '@shared/domain'

/** One entry per non-empty line (works for both LF and CRLF text). */
export const lines = (text: string): string[] =>
  text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '')

export interface AddTaskForm {
  title: string
  description: string
  role: AgentRole
  dependsOn: string[]
  suggestedFiles: string
  criteria: string
  complexity: Complexity
}

export const EMPTY_ADD_TASK: AddTaskForm = {
  title: '',
  description: '',
  role: 'worker',
  dependsOn: [],
  suggestedFiles: '',
  criteria: '',
  complexity: 'medium',
}

/** Field-level errors for the add-task form; empty when it can be submitted. */
export function validateAddTask(form: AddTaskForm): Partial<Record<'title' | 'description', string>> {
  const errors: Partial<Record<'title' | 'description', string>> = {}
  if (form.title.trim() === '') errors.title = 'A title is required.'
  else if (form.title.trim().length > 200) errors.title = 'The title is limited to 200 characters.'
  if (form.description.trim() === '') errors.description = 'A description is required.'
  return errors
}
