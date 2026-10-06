import { isRecord } from './input'

const MAX_SUMMARY = 200

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

function oneLine(s: string, max = MAX_SUMMARY): string {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? ''
  } catch {
    return '[unserializable input]'
  }
}

/** Short single-line summary for event streams: the command, the path, or the query. */
export function summarizeToolInput(toolName: string, input: unknown, max = MAX_SUMMARY): string {
  const one = (s: string): string => oneLine(s, max)
  try {
    if (!isRecord(input)) return one(safeJson(input))
    switch (toolName) {
      case 'Bash':
      case 'PowerShell':
        return one(str(input.command) ?? '')
      case 'Read':
      case 'Write':
      case 'Edit':
        return one(str(input.file_path) ?? '')
      case 'NotebookEdit':
        return one(str(input.notebook_path) ?? '')
      case 'Glob': {
        const path = str(input.path)
        return one(`${str(input.pattern) ?? ''}${path ? ` in ${path}` : ''}`)
      }
      case 'Grep': {
        const path = str(input.path)
        return one(`${str(input.pattern) ?? ''}${path ? ` in ${path}` : ''}`)
      }
      case 'WebFetch':
        return one(str(input.url) ?? '')
      case 'WebSearch':
        return one(str(input.query) ?? '')
      case 'TodoWrite':
        return Array.isArray(input.todos) ? `${input.todos.length} todo items` : 'todo list'
      default:
        return one(safeJson(input))
    }
  } catch {
    return ''
  }
}

/** Human-readable action and the exact command or path, for ApprovalRequest records and the UI. */
export function describeToolRequest(req: {
  toolName: string
  input: Record<string, unknown>
}): { action: string; command: string | null } {
  try {
    const { toolName, input } = req
    switch (toolName) {
      case 'Bash':
        return { action: 'Run shell command (bash)', command: str(input.command) }
      case 'PowerShell':
        return { action: 'Run PowerShell command', command: str(input.command) }
      case 'Read':
        return { action: 'Read file', command: str(input.file_path) }
      case 'Write':
        return { action: 'Write file', command: str(input.file_path) }
      case 'Edit':
        return { action: 'Edit file', command: str(input.file_path) }
      case 'NotebookEdit':
        return { action: 'Edit notebook', command: str(input.notebook_path) }
      case 'Glob':
        return { action: 'Find files by pattern', command: [str(input.path), str(input.pattern)].filter(Boolean).join(' : ') || null }
      case 'Grep':
        return { action: 'Search file contents', command: [str(input.pattern), str(input.path)].filter(Boolean).join(' in ') || null }
      case 'WebFetch':
        return { action: 'Fetch web page', command: str(input.url) }
      case 'WebSearch':
        return { action: 'Search the web', command: str(input.query) }
      default:
        if (toolName.startsWith('mcp__')) return { action: `Call MCP tool ${toolName}`, command: safeJson(input) }
        return { action: `Use tool ${toolName}`, command: null }
    }
  } catch {
    return { action: `Use tool ${String(req.toolName)}`, command: null }
  }
}
