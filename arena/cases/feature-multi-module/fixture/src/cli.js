import { parseArgs } from './args.js'
import { renderTasks } from './render.js'

/**
 * Run one command against a TodoService and return the text to print.
 *   add <title>
 *   list [--open]
 *   done <id>
 */
export function runCommand(argv, service) {
  const [command, ...rest] = argv
  const { positionals, flags } = parseArgs(rest, { booleans: ['open'] })
  switch (command) {
    case 'add': {
      const task = service.add(positionals.join(' '))
      return `Added ${task.id}`
    }
    case 'list':
      return renderTasks(service.list({ includeDone: !flags.open }))
    case 'done': {
      const task = service.complete(positionals[0])
      return `Completed ${task.id}`
    }
    default:
      throw new RangeError(`unknown command: ${String(command)}`)
  }
}
