import { ACTIVE_AGENT_STATES, type Agent, type Message, type ToolEvent } from '@shared/domain'
import { formatSpan } from '../../lib/format'

/** Pure helpers behind the Agents view. Unit-tested in tests/unit/renderer/agent-logic.test.ts. */

export const SHELL_TOOLS: readonly string[] = ['Bash', 'PowerShell']
const READ_TOOLS: readonly string[] = ['Read']
const CHANGE_TOOLS: readonly string[] = ['Edit', 'MultiEdit', 'Write', 'NotebookEdit']

export function isShellTool(toolName: string): boolean {
  return SHELL_TOOLS.includes(toolName)
}

export function isActiveAgent(agent: Pick<Agent, 'state'>): boolean {
  return ACTIVE_AGENT_STATES.includes(agent.state)
}

/** Active agents first, then the rest; each group oldest first so positions stay stable. */
export function groupAgents(agents: readonly Agent[]): { active: Agent[]; inactive: Agent[] } {
  const byCreated = (a: Agent, b: Agent) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)
  const sorted = [...agents].sort(byCreated)
  return { active: sorted.filter(isActive), inactive: sorted.filter((a) => !isActive(a)) }
}
const isActive = (a: Agent) => isActiveAgent(a)

export function agentElapsed(agent: Agent, now: number = Date.now()): string {
  return formatSpan(agent.startedAt ?? agent.createdAt, agent.stoppedAt, now)
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

export function toolFilePath(input: Record<string, unknown>): string | null {
  return str(input.file_path) ?? str(input.notebook_path) ?? str(input.path)
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** One-line description of what a tool call did: the command, the file path, or the search pattern. */
export function toolInputSummary(event: Pick<ToolEvent, 'toolName' | 'input'>, max = 400): string {
  const { toolName, input } = event
  if (isShellTool(toolName)) return truncate(str(input.command) ?? '', max)
  const path = toolFilePath(input)
  if (path) return truncate(path, max)
  const pattern = str(input.pattern) ?? str(input.query) ?? str(input.url)
  if (pattern) return truncate(pattern, max)
  const firstString = Object.values(input).find((v): v is string => typeof v === 'string' && v.length > 0)
  if (firstString) return truncate(firstString, max)
  const keys = Object.keys(input)
  return keys.length === 0 ? '' : truncate(JSON.stringify(input), max)
}

const pad2 = (n: number) => String(n).padStart(2, '0')

/** Local HH:MM:SS, or an em dash for an unparseable timestamp. */
export function clockTime(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '—' : `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}

/** Terminal-style line for a shell command: "[16:31:10] > pnpm test". */
export function terminalLine(event: Pick<ToolEvent, 'startedAt' | 'input'>): string {
  return `[${clockTime(event.startedAt)}] > ${str(event.input.command) ?? ''}`
}

export interface FileUse {
  path: string
  count: number
}

export interface AgentFiles {
  read: FileUse[]
  changed: FileUse[]
}

/** Files touched, derived only from tool inputs (Read → read; Edit/Write/NotebookEdit → changed). */
export function filesFromToolEvents(events: readonly ToolEvent[]): AgentFiles {
  const read = new Map<string, FileUse>()
  const changed = new Map<string, FileUse>()
  const bump = (into: Map<string, FileUse>, path: string) => {
    // Windows paths are case-insensitive and may mix separators.
    const key = path.replaceAll('\\', '/').toLowerCase()
    const existing = into.get(key)
    if (existing) existing.count += 1
    else into.set(key, { path, count: 1 })
  }
  for (const e of events) {
    const path = toolFilePath(e.input)
    if (!path) continue
    if (READ_TOOLS.includes(e.toolName)) bump(read, path)
    else if (CHANGE_TOOLS.includes(e.toolName)) bump(changed, path)
  }
  const order = (a: FileUse, b: FileUse) => b.count - a.count || a.path.localeCompare(b.path)
  return { read: [...read.values()].sort(order), changed: [...changed.values()].sort(order) }
}

export type MessageDirection = 'sent' | 'received'

export function messageDirection(message: Message, agent: Pick<Agent, 'id' | 'taskId'>): MessageDirection {
  if (message.fromAgentId === agent.id) return 'sent'
  if (agent.taskId && message.fromTaskId === agent.taskId) return 'sent'
  return 'received'
}

export type AgentGroupId = 'working' | 'waiting' | 'done'

export interface AgentGroup {
  id: AgentGroupId
  label: string
  agents: Agent[]
}

/** Group an agent by what a person cares about: doing work, waiting on something, or finished. */
export function agentGroupOf(agent: Pick<Agent, 'state'>): AgentGroupId {
  switch (agent.state) {
    case 'starting':
    case 'working':
      return 'working'
    case 'waiting':
    case 'blocked':
    case 'idle':
      return 'waiting'
    default:
      return 'done'
  }
}

/** Working, Waiting, Done (empty groups omitted); each group oldest first so rows do not jump. */
export function groupAgentsByState(agents: readonly Agent[]): AgentGroup[] {
  const sorted = [...agents].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
  const defs: { id: AgentGroupId; label: string }[] = [
    { id: 'working', label: 'Working' },
    { id: 'waiting', label: 'Waiting' },
    { id: 'done', label: 'Done' },
  ]
  return defs
    .map((d) => ({ ...d, agents: sorted.filter((a) => agentGroupOf(a) === d.id) }))
    .filter((g) => g.agents.length > 0)
}

/** "Claude · Sonnet" from a model id; the id itself when the tier is not recognisable; "Claude" without a model. */
export function claudeModelLabel(model: string | null | undefined): string {
  if (!model) return 'Claude'
  const m = /(opus|sonnet|haiku)/i.exec(model)
  if (!m?.[1]) return `Claude · ${model}`
  const tier = m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase()
  return `Claude · ${tier}`
}

/** One calm line: the live activity, else the error, else a state phrase. Never empty. */
export function agentActivityLine(agent: Pick<Agent, 'state' | 'activity' | 'error'>): string {
  if (agent.activity && agent.activity.trim() !== '') return agent.activity.trim()
  if (agent.error) return agent.error
  switch (agentGroupOf(agent)) {
    case 'working':
      return 'Working'
    case 'waiting':
      return 'Waiting'
    default:
      return agent.state === 'failed' ? 'Failed' : 'Finished'
  }
}

/** Observed token total (input + output), or null when neither was reported. */
export function observedTokens(metrics: Pick<Agent['metrics'], 'inputTokens' | 'outputTokens'>): number | null {
  if (metrics.inputTokens === null && metrics.outputTokens === null) return null
  return (metrics.inputTokens ?? 0) + (metrics.outputTokens ?? 0)
}
