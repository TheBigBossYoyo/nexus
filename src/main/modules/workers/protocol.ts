import type { AgentEvent, ExternalMcpServer, SessionContextOptions, SessionSpec, ToolRequest } from '@main/modules/agent-runtime/types'

/**
 * What the runtime and one of its worker processes say to each other over the process channel Node gives a
 * forked child. The channel exists only between the two processes; nothing else can write to it.
 *
 * A worker executes; it does not decide. Every tool call a session wants to make is sent to the runtime
 * (`call` with `authorize`), which answers with the decision of the policy engine.
 */

/** The parts of a session specification that are data. The callbacks stay in the runtime and are reached by `call`. */
export interface WireSessionSpec {
  agentId: string
  role: SessionSpec['role']
  label?: string
  cwd: string
  model?: string
  effort?: SessionSpec['effort']
  maxTurns: number
  systemPromptAppend: string
  prompt: string
  tools: string[]
  outputSchema?: Record<string, unknown>
  /** Which NEXUS tools the session gets; null when it gets none. */
  nexusTools: { proposeGraphChange: boolean; contextTool?: boolean; extensionGroups?: string[] } | null
  contextOptions?: SessionContextOptions
  mcpServers?: Record<string, ExternalMcpServer>
  resumeSessionId?: string
  loadProjectSettings: boolean
  subscriptionMode: boolean
}

export function toWireSpec(spec: SessionSpec): WireSessionSpec {
  return {
    agentId: spec.agentId,
    role: spec.role,
    ...(spec.label !== undefined ? { label: spec.label } : {}),
    cwd: spec.cwd,
    ...(spec.model !== undefined ? { model: spec.model } : {}),
    ...(spec.effort !== undefined ? { effort: spec.effort } : {}),
    maxTurns: spec.maxTurns,
    systemPromptAppend: spec.systemPromptAppend,
    prompt: spec.prompt,
    tools: [...spec.tools],
    ...(spec.outputSchema !== undefined ? { outputSchema: spec.outputSchema } : {}),
    nexusTools: spec.nexusTools ? { proposeGraphChange: typeof spec.nexusTools.proposeGraphChange === 'function', contextTool: typeof spec.nexusTools.contextTool === 'function', ...(typeof spec.nexusTools.extensionTool === 'function' ? { extensionGroups: [...(spec.nexusTools.extensionGroups ?? [])] } : {}) } : null,
    ...(spec.contextOptions !== undefined ? { contextOptions: { ...spec.contextOptions } } : {}),
    ...(spec.mcpServers !== undefined ? { mcpServers: spec.mcpServers } : {}),
    ...(spec.resumeSessionId !== undefined ? { resumeSessionId: spec.resumeSessionId } : {}),
    loadProjectSettings: spec.loadProjectSettings,
    subscriptionMode: spec.subscriptionMode,
  }
}

/** How a worker builds the runtimes it can host. Plain data: a worker receives no functions. */
export interface WorkerConfig {
  claude?: { executablePath?: string; resourcesPath?: string; debug: boolean }
  codex?: { version: string | null }
  /** The scripted runtime, for tests. The runtime process passes it only where it would use the scripted runtime itself. */
  fake?: { script: 'demo' | 'probe'; delayMs?: number }
  /** How often the worker says that it is alive. */
  heartbeatMs: number
}

export type WorkerCallMethod = 'authorize' | 'requestApproval' | 'sendMessage' | 'reportBlocker' | 'recordDecision' | 'proposeMemory' | 'proposeGraphChange' | 'contextTool' | 'extensionTool'

export type RuntimeToWorker =
  | { t: 'init'; workerId: string; config: WorkerConfig }
  | { t: 'assign'; leaseId: string; provider: string; spec: WireSessionSpec }
  | { t: 'cmd'; id: number; leaseId: string; op: 'send' | 'interrupt' | 'end' | 'stop'; text?: string }
  | { t: 'callResult'; id: number; ok: boolean; value?: unknown; error?: string }
  | { t: 'shutdown' }

export type WorkerToRuntime =
  | { t: 'ready'; pid: number; capabilities: string[] }
  | { t: 'hb'; leaseId: string | null }
  | { t: 'event'; leaseId: string; event: AgentEvent }
  | { t: 'call'; id: number; leaseId: string; method: WorkerCallMethod; args: unknown[] }
  | { t: 'cmdResult'; id: number; ok: boolean; error?: string }
  /** The assignment is over: the session's `session.ended` event was sent before this. */
  | { t: 'ended'; leaseId: string; stopConfirmed?: boolean }
  | { t: 'log'; line: string }

export type { ToolRequest }
