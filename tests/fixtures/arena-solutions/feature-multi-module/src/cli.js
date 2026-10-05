import { parseArgs } from './args.js'
import { renderTasks } from './render.js'

/**
 * Run one command against a TodoService and return the text to print.
 *   add <title> [--priority low|normal|high] [--due YYYY-MM-DD]
 *   list [--open] [--priority p] [--before YYYY-MM-DD] [--sort created|priority|due] [--today YYYY-MM-DD]
 *   done <id>
 */
export function runCommand(argv, service) {
  const [command, ...rest] = argv
  const { positionals, flags } = parseArgs(rest, { booleans: ['open'] })
  switch (command) {
    case 'add': {
      const task = service.add(positionals.join(' '), { priority: flags.priority, dueDate: flags.due })
      return `Added ${task.id}`
    }
    case 'list': {
      const tasks = service.list({
        includeDone: !flags.open,
        priority: flags.priority,
        dueBefore: flags.before,
        sortBy: flags.sort,
      })
      return renderTasks(tasks, { today: flags.today })
    }
    case 'done': {
      const task = service.complete(positionals[0])
      return `Completed ${task.id}`
    }
    default:
      throw new RangeError(`unknown command: ${String(command)}`)
  }
}
