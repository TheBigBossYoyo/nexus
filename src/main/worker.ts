import { ClaudeSdkRuntime } from './modules/agent-runtime/claude-sdk-runtime'
import { createDemoScript } from './modules/agent-runtime/demo-script'
import { FakeAgentRuntime } from './modules/agent-runtime/fake-runtime'
import { resolveClaudeExecutable } from './modules/agent-runtime/resolve-executable'
import type { AgentRuntime, AgentSessionHandle, NexusToolHandlers, SessionSpec, ToolDecision } from './modules/agent-runtime/types'
import { GitService } from './modules/git'
import { CodexCliRuntime } from './modules/providers/codex-runtime'
import { createProbeScript } from './modules/workers/probe-script'
import type { RuntimeToWorker, WireSessionSpec, WorkerCallMethod, WorkerConfig, WorkerToRuntime } from './modules/workers/protocol'

/**
 * The entry point of a NEXUS worker process (`nexus-worker-N`). A worker is started by the runtime, runs one
 * agent session at a time, and ends when the runtime tells it to or when the runtime is gone. It opens no
 * database, listens on nothing and decides nothing: tool calls are authorized by the runtime, which it asks
 * over the process channel.
 */

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

function send(message: WorkerToRuntime): void {
  if (!process.connected) return
  try {
    process.send?.(message)
  } catch {
    // The runtime is gone; the disconnect handler ends this process.
  }
}

let nextCall = 1
const calls = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()

/** Asks the runtime to run one of the session's callbacks and waits for its answer. */
function call(leaseId: string, method: WorkerCallMethod, args: unknown[]): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = nextCall++
    calls.set(id, { resolve, reject })
    // The policy answers at once; only a human approval may take as long as the human does. A decision that
    // does not come is a refusal, not a session that hangs.
    if (method !== 'requestApproval') {
      const timer = setTimeout(() => {
        if (calls.delete(id)) reject(new Error('The runtime did not answer in time.'))
      }, DECISION_TIMEOUT_MS)
      timer.unref()
    }
    send({ t: 'call', id, leaseId, method, args })
  })
}

const DECISION_TIMEOUT_MS = 60_000

/**
 * The environment of the processes a session starts (the provider's own process and, through it, the agent's
 * shells): this worker's environment without what belongs to the worker itself. With those variables an
 * Electron program an agent starts would run as plain Node and inherit the channel to the runtime's name.
 */
function sessionEnvironment(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env }
  for (const name of Object.keys(env)) {
    if (name === 'ELECTRON_RUN_AS_NODE' || name === 'NEXUS_WORKER_ID' || name.startsWith('NODE_CHANNEL_')) delete env[name]
  }
  return env
}

function buildRuntimes(config: WorkerConfig): Map<string, AgentRuntime> {
  const runtimes = new Map<string, AgentRuntime>()
  if (config.fake) {
    // The scripted runtime stands in for every provider, as it does in the runtime process.
    const fake = new FakeAgentRuntime({ script: config.fake.script === 'probe' ? createProbeScript() : createDemoScript(), ...(config.fake.delayMs !== undefined ? { delayMs: config.fake.delayMs } : {}) })
    runtimes.set('claude', fake)
    runtimes.set('codex', fake)
    return runtimes
  }
  if (config.claude) {
    const claude = config.claude
    runtimes.set(
      'claude',
      new ClaudeSdkRuntime({
        ...(claude.executablePath ? { executablePath: claude.executablePath } : {}),
        resolveExecutable: () => resolveClaudeExecutable(claude.resourcesPath ? { resourcesPath: claude.resourcesPath } : {}),
        debug: claude.debug,
        processEnv: sessionEnvironment(),
        ...(claude.debug ? { logger: (line: string) => send({ t: 'log', line: `[claude] ${line}` }) } : {}),
      }),
    )
  }
  if (config.codex) {
    const git = new GitService()
    const version = config.codex.version
    runtimes.set('codex', new CodexCliRuntime({ version: () => version, snapshot: (cwd) => git.workingState(cwd) }))
  }
  return runtimes
}

function toSpec(leaseId: string, wire: WireSessionSpec): SessionSpec {
  const tools = wire.nexusTools
  const nexusTools: NexusToolHandlers | undefined = tools
    ? {
        sendMessage: (input) => call(leaseId, 'sendMessage', [input]) as Promise<string>,
        reportBlocker: (input) => call(leaseId, 'reportBlocker', [input]) as Promise<string>,
        recordDecision: (input) => call(leaseId, 'recordDecision', [input]) as Promise<string>,
        proposeMemory: (input) => call(leaseId, 'proposeMemory', [input]) as Promise<string>,
        ...(tools.proposeGraphChange ? { proposeGraphChange: (input: unknown) => call(leaseId, 'proposeGraphChange', [input]) as Promise<string> } : {}),
      }
    : undefined
  const { nexusTools: _flags, ...data } = wire
  return {
    ...data,
    // A decision that cannot be obtained is a refusal: the worker never lets a tool call through by itself.
    authorize: (request) => (call(leaseId, 'authorize', [request]) as Promise<ToolDecision>).catch((e: unknown): ToolDecision => ({ behavior: 'deny', reason: `The runtime did not answer: ${errorText(e)}` })),
    requestApproval: (request, reason, risk) => (call(leaseId, 'requestApproval', [request, reason, risk]) as Promise<boolean>).catch(() => false),
    ...(nexusTools ? { nexusTools } : {}),
  }
}

let runtimes = new Map<string, AgentRuntime>()
let heartbeat: ReturnType<typeof setInterval> | null = null
let current: { leaseId: string; handle: AgentSessionHandle } | null = null

async function run(leaseId: string, provider: string, wire: WireSessionSpec): Promise<void> {
  const runtime = runtimes.get(provider)
  if (!runtime || current) {
    send({ t: 'event', leaseId, event: { type: 'session.ended', reason: 'crashed', error: current ? 'The worker already holds an assignment.' : `This worker cannot run ${provider} sessions.` } })
    send({ t: 'ended', leaseId })
    return
  }
  let ended = false
  try {
    const handle = runtime.startSession(toSpec(leaseId, wire))
    current = { leaseId, handle }
    for await (const event of handle.events) {
      send({ t: 'event', leaseId, event })
      if (event.type === 'session.ended') ended = true
    }
  } catch (e) {
    if (!ended) send({ t: 'event', leaseId, event: { type: 'session.ended', reason: 'crashed', error: errorText(e) } })
    ended = true
  }
  if (!ended) send({ t: 'event', leaseId, event: { type: 'session.ended', reason: 'crashed', error: 'The session ended without saying why.' } })
  current = null
  send({ t: 'ended', leaseId })
}

async function command(message: Extract<RuntimeToWorker, { t: 'cmd' }>): Promise<void> {
  try {
    if (!current || current.leaseId !== message.leaseId) throw new Error('The worker does not hold this assignment.')
    const { handle } = current
    if (message.op === 'send') handle.send(message.text ?? '')
    else if (message.op === 'interrupt') await handle.interrupt()
    else if (message.op === 'end') handle.end()
    else await handle.stop()
    send({ t: 'cmdResult', id: message.id, ok: true })
  } catch (e) {
    send({ t: 'cmdResult', id: message.id, ok: false, error: errorText(e) })
  }
}

async function shutdown(code: number): Promise<never> {
  if (heartbeat) clearInterval(heartbeat)
  // Sessions own child processes (claude.exe, codex); they are stopped before this process goes.
  await Promise.race([Promise.allSettled([...new Set(runtimes.values())].map((r) => r.shutdown())), new Promise((resolve) => setTimeout(resolve, 5000))])
  process.exit(code)
}

process.on('message', (raw: unknown) => {
  const message = raw as RuntimeToWorker
  if (message.t === 'init') {
    try {
      runtimes = buildRuntimes(message.config)
    } catch (e) {
      send({ t: 'log', line: `worker ${message.workerId}: ${errorText(e)}` })
      void shutdown(1)
      return
    }
    heartbeat = setInterval(() => send({ t: 'hb', leaseId: current?.leaseId ?? null }), Math.max(100, message.config.heartbeatMs))
    send({ t: 'ready', pid: process.pid, capabilities: [...runtimes.keys()] })
  } else if (message.t === 'assign') void run(message.leaseId, message.provider, message.spec)
  else if (message.t === 'cmd') void command(message)
  else if (message.t === 'callResult') {
    const pending = calls.get(message.id)
    if (!pending) return
    calls.delete(message.id)
    if (message.ok) pending.resolve(message.value)
    else pending.reject(new Error(message.error ?? 'The runtime refused the call.'))
  } else if (message.t === 'shutdown') void shutdown(0)
})

// A worker never outlives the runtime that started it: without it nothing authorizes its tool calls.
process.on('disconnect', () => void shutdown(0))
process.on('uncaughtException', (e) => {
  send({ t: 'log', line: `worker: uncaught: ${errorText(e)}` })
  void shutdown(1)
})
