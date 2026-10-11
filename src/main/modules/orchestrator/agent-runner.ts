import { extensionToolNames } from '@main/modules/agent-runtime/extension-tools'
import {
  AgentMessageTypeSchema,
  emptyMetrics,
  MAX_AGENT_SUBJECT_CHARS,
  HandoffSchema,
  type Agent,
  type AgentMetrics,
  type AgentPurpose,
  type AgentRole,
  type AgentState,
  type Handoff,
  type ProjectProfile,
  type Run,
  type Severity,
  type Task,
  type ModelTier,
} from '@shared/domain'
import { newId, nowIso } from '@shared/ids'
import { errorMessage } from '@shared/result'
import type { ContextPack } from '@shared/v2'
import type {
  AgentSessionHandle,
  ExternalMcpServer,
  NexusToolHandlers,
  SessionSpec,
  ToolRequest,
  TurnOutcome,
  TurnResult,
  UsageInfo,
} from '@main/modules/agent-runtime/types'
import { canProposeGraphChange, rolePrompt } from '@main/modules/context/prompts'
import { renderInstructionsInForce } from './instructions'
import {
  buildHandoffRequestPrompt,
  buildResumeFromHandoffPrompt,
  handoffJsonSchema,
} from '@main/modules/context/context-builder'
import {
  createAuthorizer,
  describeToolRequest,
  gitBaseReader,
  ProvenanceTracker,
  summarizeToolInput,
  toolsForRole,
} from '@main/modules/policies'
import { packForPrompt } from '@main/modules/context/context-engine'
import { canTransition } from '@main/modules/state'
import type { ApprovalService } from './approvals'
import type { GraphService } from './graph-service'
import type { TokenIntelligenceEngine } from '@main/modules/token'
import type { OrchestratorDeps } from './deps'
import type { MemoryService } from './memory'
import type { MessageService } from './messaging'
import type { ModelRoutingService } from './routing'

export type StopReason = 'paused' | 'cancelled' | 'user_stop' | 'shutdown'

/** Gate and planning sessions never receive instructions meant for the agent doing the work. */
const NON_WORKER_PURPOSES: ReadonlySet<AgentPurpose> = new Set<AgentPurpose>(['plan', 'review', 'verify', 'critique', 'synthesize', 'arbitrate'])

interface RegisteredHandle {
  purpose: AgentPurpose
  /** False once the session takes no more input (turn finished, or a handoff request). */
  open: boolean
}

/** Live-session registry for one unit of work (a task pipeline, the planner, the mission verifier). */
export class SessionControl {
  private readonly registered = new Map<AgentSessionHandle, RegisteredHandle>()
  stopReason: StopReason | null = null

  register(handle: AgentSessionHandle, purpose: AgentPurpose, open = true): void {
    this.registered.set(handle, { purpose, open })
  }

  /** The session still runs (and can be stopped) but can no longer be handed a message. */
  closeInput(handle: AgentSessionHandle): void {
    const entry = this.registered.get(handle)
    if (entry) entry.open = false
  }

  unregister(handle: AgentSessionHandle): void {
    this.registered.delete(handle)
  }

  async stop(reason: StopReason): Promise<void> {
    this.stopReason = reason
    await Promise.allSettled([...this.registered.keys()].map((h) => h.stop()))
  }

  /**
   * Hand a message to the live session doing the work (implementer, debugger, read-only worker).
   * Reviewer, verifier and planner sessions are never targets. Returns false when nobody took it,
   * so the caller keeps the message undelivered for the next prompt.
   */
  send(text: string): boolean {
    let delivered = false
    // Usually one session does the work. Speculative candidates are several: every one of them gets the
    // message, otherwise they would no longer be working from the same instructions.
    for (const [handle, entry] of this.registered) {
      if (!entry.open || NON_WORKER_PURPOSES.has(entry.purpose)) continue
      handle.send(text)
      delivered = true
    }
    return delivered
  }
}

export interface AgentRunInput {
  run: Run
  task: Task | null
  role: AgentRole
  purpose: AgentPurpose
  label: string
  /** Working directory of the session. */
  cwd: string
  /** Directory the agent's writes are confined to (same as cwd for writing roles). */
  worktreeRoot: string
  projectRoot: string
  prompt: string
  outputSchema?: Record<string, unknown>
  /** Inputs of the model route beyond role, purpose and the task itself; see ModelRoutingService. */
  routing?: { attempt?: number; repairCycle?: number; triggeringSeverity?: Severity | null; tierOverride?: ModelTier | null }
  /** Why the agent receives this prompt; persisted with the agent's id once the agent exists. */
  contextPack?: ContextPack
  control: SessionControl
  /** Resume this SDK session (after pause, quota, or restart) instead of starting fresh. */
  resumeSdkSessionId?: string
  /** Allow handoff + fresh session when the per-session turn threshold is reached. */
  allowRotation?: boolean
  /** Called on agent activity; used to renew the task lease. */
  onActivity?: () => void
}

export type AgentOutcome = TurnOutcome | 'crashed' | 'stopped' | 'capacity'

export interface AgentRunResult {
  agentId: string
  outcome: AgentOutcome
  text: string
  structuredOutput: unknown
  error: string | null
  sdkSessionId: string | null
  /** Set when the agent called report_blocker. */
  blocker: { summary: string; evidence: string } | null
}

interface SessionResult {
  outcome: AgentOutcome
  result: TurnResult | null
  error: string | null
  sdkSessionId: string | null
  /** Model round-trips over every turn of this session (each result reports its own turn's count). */
  turns: number
}

/** Last cumulative figures the runtime reported for one SDK session, per model (a resumed session continues them). */
type CumulativeUsage = Record<string, UsageInfo>

const usageKey = (sdkSessionId: string): string => `usage-cumulative:${sdkSessionId}`

const FILE_READ_TOOLS = new Set(['Read'])
const FILE_WRITE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit'])
const SHELL_TOOLS = new Set(['Bash', 'PowerShell'])

/** Script names that do more than build or check: never run by a gate role on its own. */
const UNSAFE_SCRIPT = /deploy|publish|release|push|upload|start|serve|dev|watch|install|clean|reset|migrate|seed|docker|electron/i

/**
 * The project's own package scripts count as verification commands, so a verifier or reviewer can run
 * what the acceptance criteria refer to (a generator, a build step). Planners stay read-only. The names
 * come from the profile taken when the project was opened, not from the worktree an agent can edit.
 */
export function projectScriptPrefixes(profile: ProjectProfile | null): string[] {
  if (!profile) return []
  const runners = profile.packageManagers.length > 0 ? profile.packageManagers : ['npm']
  return Object.keys(profile.scripts)
    .filter((name) => /^[\w:.-]+$/.test(name) && !UNSAFE_SCRIPT.test(name))
    .flatMap((name) => runners.flatMap((pm) => (pm === 'npm' ? [`npm run ${name}`] : [`${pm} run ${name}`, `${pm} ${name}`])))
}

/** Runs one agent (one or more SDK sessions) and records everything observable about it. */
/** The NEXUS tools every session gets, and the Context Graph tools a session gets when the graph is on. */
const BASE_NEXUS_TOOLS = ['send_message', 'report_blocker', 'record_decision', 'propose_memory'] as const
const CONTEXT_TOOLS = ['context_open', 'context_search', 'context_related', 'context_note'] as const
/** Sent to a session that reached its turn limit with room to spare, when pressure rotation keeps it. */
export const CONTINUE_SESSION_PROMPT = 'Continue the task from where you stopped. Nothing has changed since your last turn.'

export class AgentRunner {
  constructor(
    private readonly deps: OrchestratorDeps,
    private readonly approvals: ApprovalService,
    private readonly messages: MessageService,
    private readonly memory: MemoryService,
    private readonly graph: GraphService,
    private readonly routing: ModelRoutingService,
  ) {}

  /** v0.7.1: token accounting and the Context Graph tools, attached by the core once both exist. */
  private context: { tokens: TokenIntelligenceEngine; contextTool: (session: { run: Run; task: Task | null; agentId: string; role: AgentRole }) => ((input: unknown) => Promise<string>) | null } | null = null

  attachContext(context: NonNullable<AgentRunner['context']>): void {
    this.context = context
  }

  /** Which files agents wrote, shared by every agent this runner starts (persisted when the repository exists). */
  private provenanceTracker: ProvenanceTracker | undefined
  private get provenance(): ProvenanceTracker {
    this.provenanceTracker ??= new ProvenanceTracker(this.deps.repos.fileProvenance)
    return this.provenanceTracker
  }

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    const { repos, bus } = this.deps
    const config = input.run.config
    const route = this.routing.route({
      run: input.run,
      task: input.task,
      role: input.role,
      purpose: input.purpose,
      ...input.routing,
    })
    // The agent, the reason for its model and the reason for its context are recorded together.
    const agent = bus.transaction(() => {
      const row = repos.agents.insert({
        id: newId(),
        runId: input.run.id,
        taskId: input.task?.id ?? null,
        role: input.role,
        purpose: input.purpose,
        label: input.label,
        state: 'starting',
        model: null,
        activity: null,
        metrics: emptyMetrics(),
        error: null,
        createdAt: nowIso(),
        startedAt: nowIso(),
        stoppedAt: null,
      })
      const decision = repos.routingDecisions.insert({
        id: newId(),
        runId: input.run.id,
        taskId: input.task?.id ?? null,
        agentId: row.id,
        role: input.role,
        purpose: input.purpose,
        requestedPolicy: route.requestedPolicy,
        resolvedPolicy: route.resolvedPolicy,
        resolvedTier: route.resolvedTier,
        resolvedModel: route.resolvedModel,
        reasons: route.reasons,
        createdAt: nowIso(),
      })
      bus.emit({
        runId: input.run.id,
        taskId: input.task?.id ?? null,
        agentId: row.id,
        type: 'routing.decided',
        payload: { decisionId: decision.id, role: input.role, policy: route.resolvedPolicy, model: route.resolvedModel, reasons: route.reasons },
      })
      if (input.contextPack) this.recordPack(input, row.id, input.contextPack)
      return row
    })

    const model = route.resolvedModel ?? undefined
    const rotationTurns = input.allowRotation ? config.sessionRotationTurns : 0
    let remainingTurns = config.maxTurnsPerAgent
    let prompt = input.prompt
    let resumeId = input.resumeSdkSessionId
    let blocker: AgentRunResult['blocker'] = null
    const files = { read: new Set<string>(), changed: new Set<string>() }

    let base: Omit<SessionSpec, 'prompt' | 'maxTurns'>
    try {
      base = this.buildSpec(input, agent, model, (b) => (blocker = b))
    } catch (e) {
      this.context?.tokens.sessionClosed(agent.id)
      throw e
    }
    this.context?.tokens.attachPack(agent.id, input.contextPack ?? null)
    let last: SessionResult = { outcome: 'error', result: null, error: null, sdkSessionId: null, turns: 0 }

    try {
      for (;;) {
        const maxTurns = rotationTurns > 0 ? Math.min(rotationTurns, remainingTurns) : remainingTurns
        const spec: SessionSpec = { ...base, prompt, maxTurns, resumeSessionId: resumeId }
        last = await this.runSession(input, agent.id, spec, files)
        resumeId = undefined
        remainingTurns -= last.result ? last.turns : maxTurns

        const canRotate =
          last.outcome === 'max_turns' &&
          rotationTurns > 0 &&
          remainingTurns > 0 &&
          input.task !== null &&
          !input.control.stopReason
        // The session-efficiency decision is recorded at the end of every session. With pressure rotation off it
        // is the turn rule above; with it on, a session whose context is still small is continued, not rotated.
        const efficiency = this.context?.tokens.turnEnded(agent.id, last.sdkSessionId, {
          turns: last.turns,
          rotationTurns,
          hitTurnLimit: last.outcome === 'max_turns',
          canHandoff: canRotate,
          settings: repos.settings.get().tokens,
          ...(input.task ? { risk: input.task.risk } : {}),
          // Cumulative for the session, as the runtime reports usage. Thinking is absent when no turn recorded it.
          outputTokens: last.result ? last.result.usage.reduce((n, u) => n + u.outputTokens, 0) : null,
          thinkingTokens: last.result && last.result.usage.some((u) => u.thinkingTokens !== undefined) ? last.result.usage.reduce((n, u) => n + (u.thinkingTokens ?? 0), 0) : null,
        })
        if (!canRotate) break
        if (efficiency && efficiency.action !== 'HANDOFF_AND_ROTATE' && last.sdkSessionId) {
          resumeId = last.sdkSessionId
          prompt = CONTINUE_SESSION_PROMPT
          continue
        }

        // Session rotation: structured handoff, then a fresh session with minimal context.
        const handoff = await this.requestHandoff(input, agent.id, base, last.sdkSessionId)
        // A pause, cancel or shutdown during the handoff request ends the agent here: no further session.
        if (input.control.stopReason) break
        bus.emit({
          runId: input.run.id,
          taskId: input.task?.id ?? null,
          agentId: agent.id,
          type: 'agent.rotated',
          payload: { fromSessionId: last.sdkSessionId, turns: last.result ? last.turns : maxTurns },
        })
        prompt = buildResumeFromHandoffPrompt({
          task: input.task as Task,
          handoff,
          // The handoff is what a model chose to write down. What the user asked for is given again in full.
          instructions: renderInstructionsInForce(repos, input.run, input.task, { withRequest: true }),
          missionCriteria: input.run.plan?.acceptanceCriteria ?? [],
          worktreePath: input.cwd,
          branch: input.task?.branch ?? '',
        }).prompt
        const resumePack = packForPrompt({
            run: input.run,
            task: input.task,
            purpose: input.purpose,
            prompt,
            blocks: [
              { section: 'Resuming task', sourceKind: 'handoff', title: 'Handoff from the rotated session', reason: 'The session reached its turn threshold and was rotated; the structured handoff replaces its history.', chars: JSON.stringify(handoff).length },
              { section: 'Task', sourceKind: 'task', sourceId: input.task?.id ?? null, title: input.task?.title ?? '', reason: 'The task being continued.', chars: input.task?.description.length ?? 0 },
            ],
        })
        this.recordPack(input, agent.id, resumePack)
        // The fresh session starts from the handoff, not from the first pack: its breakdown names these sections.
        this.context?.tokens.attachPack(agent.id, resumePack)
      }
    } catch (e) {
      last = { outcome: 'crashed', result: null, error: errorMessage(e), sdkSessionId: last.sdkSessionId, turns: last.turns }
    }

    // A usage limit or an authentication stop is not a failure of the agent: it ends 'stopped', reason recorded.
    const failed = last.outcome !== 'success' && last.outcome !== 'stopped' && last.outcome !== 'quota' && last.outcome !== 'auth' && last.outcome !== 'capacity'
    const error = failed ? (last.error ?? last.result?.errors.join('; ') ?? last.outcome) : null
    try {
      this.finishAgent(agent.id, failed ? 'failed' : 'stopped', error, input.control.stopReason ?? last.outcome)
    } finally {
      this.context?.tokens.sessionClosed(agent.id)
    }
    return {
      agentId: agent.id,
      outcome: last.outcome,
      text: last.result?.text ?? '',
      structuredOutput: last.result?.structuredOutput,
      error,
      sdkSessionId: last.sdkSessionId,
      blocker,
    }
  }

  /** Persist a pack for an agent and announce it. */
  private recordPack(input: AgentRunInput, agentId: string, pack: ContextPack): void {
    const { repos, bus } = this.deps
    const stored = repos.contextPacks.insert({ ...pack, agentId })
    const included = stored.entries.filter((e) => e.included).length
    bus.emit({
      runId: input.run.id,
      taskId: input.task?.id ?? null,
      agentId,
      type: 'context.composed',
      payload: { packId: stored.id, included, excluded: stored.entries.length - included, chars: stored.totalChars },
    })
  }

  private buildSpec(
    input: AgentRunInput,
    agent: Agent,
    model: string | undefined,
    onBlocker: (b: { summary: string; evidence: string }) => void,
  ): Omit<SessionSpec, 'prompt' | 'maxTurns'> {
    const { repos, bus } = this.deps
    const settings = repos.settings.get()
    const { run, task, role } = input
    const allowNetworkTools = settings.permissions.allowNetworkTools

    const servers = settings.mcp.servers.filter(
      (s) => s.enabled && s.roles.includes(role) && run.config.enabledMcpServers.includes(s.name),
    )
    const mcpServers: Record<string, ExternalMcpServer> = {}
    for (const s of servers) {
      mcpServers[s.name] = { type: s.type, command: s.command, args: s.args, url: s.url }
    }

    const authorize = createAuthorizer({
      role,
      worktreeRoot: input.worktreeRoot,
      projectRoot: input.projectRoot,
      safeCommandPrefixes: [
        ...settings.permissions.safeCommandPrefixes,
        ...Object.values(run.config.checks).filter((c): c is string => typeof c === 'string'),
        ...projectScriptPrefixes(repos.projects.get(run.projectId)?.profile ?? null),
      ],
      allowNetworkTools,
      allowedMcpServers: servers.map((s) => s.name),
      execution: {
        profile: settings.execution.profile,
        provenance: this.provenance,
        // The run's base commit: everything agents produced in this run, including earlier tasks, differs from it.
        base: run.baseCommit
          ? gitBaseReader((cwd, args) => this.deps.git.run(cwd, args, { okCodes: [0, 1, 128], timeoutMs: 15_000 }), input.worktreeRoot, run.baseCommit)
          : undefined,
        decisions: repos.securityDecisions,
        runId: run.id,
        taskId: task?.id ?? null,
      },
      // 0.8: in an enrolled project the capability broker decides where this policy would ask the user.
      autonomy: this.deps.autonomy?.gateFor({ projectId: run.projectId, runId: run.id, taskId: task?.id ?? null, role, provider: null, cwd: input.cwd }),
    })

    const contextTool = this.context?.contextTool({ run, task, agentId: agent.id, role }) ?? null
    const extensions = this.deps.extensions?.({ run, task, agentId: agent.id, role, cwd: input.cwd }) ?? null
    const systemPromptAppend = rolePrompt(role, input.purpose)
    const builtinTools = toolsForRole(role, { allowNetworkTools })
    const mayPropose = !!task && canProposeGraphChange(role, input.purpose)
    const plan = this.context?.tokens.planSession({
      runId: run.id,
      taskId: task?.id ?? null,
      agentId: agent.id,
      role,
      model: model ?? null,
      effort: null,
      cwd: input.cwd,
      systemText: systemPromptAppend,
      tools: builtinTools,
      nexusToolNames: [...BASE_NEXUS_TOOLS, ...(mayPropose ? ['propose_graph_change'] : []), ...(contextTool ? CONTEXT_TOOLS : []), ...(extensions ? extensionToolNames(extensions.groups) : [])],
      externalServers: servers.map((s) => s.name),
      loadProjectSettings: run.config.respectProjectClaudeConfig,
      structuredOutput: input.outputSchema !== undefined,
      settings: settings.tokens,
    })

    const nexusTools: NexusToolHandlers = {
      sendMessage: async (m) => {
        // Authoritative: only NEXUS writes user instructions and review findings. An agent that
        // claims them gets an ordinary information message.
        const legal = AgentMessageTypeSchema.safeParse(m.type).success
        const type = legal ? m.type : 'information'
        const { recipients } = this.messages.send({
          runId: run.id,
          type,
          severity: m.severity,
          subject: m.subject.replace(/\s+/g, ' ').trim().slice(0, MAX_AGENT_SUBJECT_CHARS),
          body: m.body,
          fromAgentId: agent.id,
          fromTaskId: task?.id ?? null,
          fromLabel: input.label,
          toTask: m.toTask,
          toRole: m.toRole,
        })
        const outcome =
          recipients.length > 0
            ? `Message routed to: ${recipients.map((t) => t.key).join(', ')}`
            : 'Message recorded. No open task matched the recipient; the user can see it.'
        return legal ? outcome : `${outcome} Type '${m.type}' is reserved for NEXUS and the user; it was sent as 'information'.`
      },
      reportBlocker: async (b) => {
        onBlocker(b)
        this.messages.send({
          runId: run.id,
          type: 'blocker',
          severity: 'high',
          subject: b.summary,
          body: b.evidence,
          fromAgentId: agent.id,
          fromTaskId: task?.id ?? null,
          fromLabel: input.label,
          toTask: null,
          toRole: null,
        })
        return 'Blocker recorded. Finish your turn with a short summary; the task will be marked blocked.'
      },
      recordDecision: async (d) => {
        bus.transaction(() => {
          const decision = repos.decisions.insert({
            id: newId(),
            runId: run.id,
            taskId: task?.id ?? null,
            agentId: agent.id,
            title: d.title,
            decision: d.decision,
            rationale: d.rationale,
            createdAt: nowIso(),
          })
          bus.emit({
            runId: run.id,
            taskId: task?.id ?? null,
            agentId: agent.id,
            type: 'decision.recorded',
            payload: { decisionId: decision.id, title: decision.title },
          })
        })
        return 'Decision recorded.'
      },
      proposeMemory: async (m) => {
        this.memory.propose({
          run,
          taskId: task?.id ?? null,
          agentId: agent.id,
          source: role,
          title: m.title,
          content: m.content,
          evidence: m.evidence,
          tags: m.tags,
          filePaths: m.filePaths,
        })
        return 'Memory proposed. It becomes project memory once approved.'
      },
      // Work-doing sessions only: planners, reviewers and verifiers never change the graph.
      ...(task && canProposeGraphChange(role, input.purpose)
        ? {
            proposeGraphChange: async (raw: unknown) =>
              // A repair attempt has no task of its own to wait or be replaced: it cannot yield.
              this.graph.propose(run, { agentId: agent.id, label: input.label, taskId: task.parentTaskId ? null : task.id }, raw).message,
          }
        : {}),
      ...(contextTool ? { contextTool } : {}),
      ...(extensions && extensions.groups.length > 0 ? { extensionGroups: extensions.groups, extensionTool: extensions.call } : {}),
    }

    return {
      agentId: agent.id,
      role,
      label: input.label,
      cwd: input.cwd,
      model,
      systemPromptAppend,
      tools: builtinTools,
      ...(plan ? { contextOptions: plan.options } : {}),
      authorize,
      requestApproval: (request, reason, risk) => this.requestToolApproval(input, agent.id, request, reason, risk),
      outputSchema: input.outputSchema,
      nexusTools,
      mcpServers,
      loadProjectSettings: run.config.respectProjectClaudeConfig,
      subscriptionMode: run.config.subscriptionMode,
    }
  }

  private async requestToolApproval(
    input: AgentRunInput,
    agentId: string,
    request: ToolRequest,
    reason: string,
    risk: 'low' | 'medium' | 'high',
  ): Promise<boolean> {
    const described = describeToolRequest(request)
    this.setState(agentId, 'waiting')
    this.deps.bus.emit({
      runId: input.run.id,
      taskId: input.task?.id ?? null,
      agentId,
      type: 'agent.waiting',
      payload: { reason: `approval: ${described.action}` },
    })
    const approved = await this.approvals.requestDecision({
      runId: input.run.id,
      taskId: input.task?.id ?? null,
      agentId,
      kind: 'tool',
      action: described.action,
      reason,
      command: described.command,
      requestedBy: input.label,
      risk,
    })
    this.setState(agentId, 'working')
    return approved
  }

  private async runSession(
    input: AgentRunInput,
    agentId: string,
    spec: SessionSpec,
    files: { read: Set<string>; changed: Set<string> },
    opts: { handoff?: boolean } = {},
  ): Promise<SessionResult> {
    const { repos, bus, runtime, push } = this.deps
    const runId = input.run.id
    const taskId = input.task?.id ?? null
    const ids = { runId, taskId, agentId }
    const session = repos.sessions.insert({
      id: newId(),
      agentId,
      sdkSessionId: spec.resumeSessionId ?? null,
      model: spec.model ?? null,
      state: 'active',
      endReason: null,
      handoff: null,
      startedAt: nowIso(),
      endedAt: null,
    })

    const handle = spec.resumeSessionId
      ? runtime.resumeSession(spec, spec.resumeSessionId)
      : runtime.startSession(spec)
    input.control.register(handle, input.purpose, !opts.handoff)
    // A stop requested while the session was being created must still take effect.
    if (input.control.stopReason) void handle.stop()

    let result: TurnResult | null = null
    let ended: { reason: string; error: string | null } = { reason: 'crashed', error: null }
    let quota = false
    let capacity = false
    let turns = 0
    let sdkId: string | null = spec.resumeSessionId ?? null
    const toolNames = new Map<string, string>()

    const appendOutput = (kind: 'text' | 'system' | 'error', content: string): void => {
      const row = repos.outputs.append(agentId, kind, content)
      push({ kind: 'agent.output', agentId, runId, seq: row.seq, outputKind: kind, content })
    }

    try {
      for await (const event of handle.events) {
        input.onActivity?.()
        switch (event.type) {
          case 'capacity.wait':
            capacity = true
            bus.emit({ ...ids, type: 'capacity.waiting', payload: { routingId: event.routingId, provider: event.provider, reasons: event.reasons, ...(event.waitingOn ? { waitingOn: event.waitingOn } : {}) } })
            break
          case 'session.started': {
            sdkId = event.sessionId
            this.context?.tokens.sessionStarted(agentId, { provider: event.provider ?? 'claude', model: event.model }, { resumed: spec.resumeSessionId !== undefined, handoff: opts.handoff === true })
            repos.sessions.update(session.id, { sdkSessionId: event.sessionId, model: event.model })
            repos.agents.update(agentId, { model: event.model })
            this.setState(agentId, 'working')
            bus.emit({
              ...ids,
              type: 'agent.started',
              payload: { role: input.role, model: event.model, sessionId: event.sessionId },
            })
            break
          }
          case 'text': {
            appendOutput('text', event.text)
            bus.emit({ ...ids, type: 'agent.message', payload: { preview: event.text.slice(0, 200) } })
            break
          }
          case 'text.delta':
            push({ kind: 'agent.delta', agentId, runId, text: event.text })
            break
          case 'tool.started': {
            toolNames.set(event.toolUseId, event.toolName)
            const summary = summarizeToolInput(event.toolName, event.input)
            bus.transaction(() => {
              repos.toolEvents.insert({
                id: newId(),
                runId,
                taskId,
                agentId,
                toolUseId: event.toolUseId,
                toolName: event.toolName,
                input: event.input,
                status: 'started',
                outputPreview: null,
                startedAt: nowIso(),
                completedAt: null,
              })
              this.bumpMetrics(agentId, event.toolName, event.input, files, summary)
              bus.emit({
                ...ids,
                type: 'agent.tool.started',
                payload: { toolUseId: event.toolUseId, toolName: event.toolName, summary },
              })
            })
            break
          }
          case 'tool.completed': {
            const toolName = toolNames.get(event.toolUseId) ?? 'unknown'
            bus.transaction(() => {
              const existing = repos.toolEvents.listByAgent(agentId).find((t) => t.toolUseId === event.toolUseId)
              // A denied call also produces an error result; keep the more specific 'denied' status.
              if (existing?.status !== 'denied') {
                repos.toolEvents.complete(event.toolUseId, event.isError ? 'failed' : 'completed', event.outputPreview)
              }
              bus.emit({
                ...ids,
                type: 'agent.tool.completed',
                payload: { toolUseId: event.toolUseId, toolName, isError: event.isError },
              })
            })
            break
          }
          case 'tool.denied': {
            bus.transaction(() => {
              repos.toolEvents.complete(event.toolUseId, 'denied', event.reason)
              bus.emit({
                ...ids,
                type: 'agent.tool.denied',
                payload: { toolName: event.toolName, reason: event.reason },
              })
            })
            break
          }
          case 'rate_limit': {
            if (event.status === 'rejected') quota = true
            bus.emit({
              ...ids,
              type: 'agent.rate_limited',
              payload: {
                status: event.status,
                resetsAt: event.resetsAt,
                limitType: event.limitType,
                utilization: event.utilization ?? null,
                overageStatus: event.overageStatus ?? null,
                isUsingOverage: event.isUsingOverage ?? null,
                surpassedThreshold: event.surpassedThreshold ?? null,
              },
            })
            break
          }
          case 'throttle':
            // Transient (overloaded / server error): recorded for the usage service, never a quota outcome.
            bus.emit({
              ...ids,
              type: 'agent.rate_limited',
              payload: { status: 'throttled', resetsAt: null, limitType: event.kind },
            })
            break
          case 'status':
            repos.agents.update(agentId, { activity: event.status })
            break
          case 'request.usage':
            this.context?.tokens.requestUsage(agentId, sdkId, event)
            break
          case 'context.usage':
            this.context?.tokens.contextUsage(agentId, sdkId, event.usage)
            break
          case 'compaction':
            this.context?.tokens.compaction(agentId, sdkId, event)
            break
          case 'turn.completed': {
            result = event.result
            turns += event.result.numTurns
            this.recordUsage(input, agentId, sdkId ?? session.id, event.result)
            if (event.result.errors.length > 0) appendOutput('error', event.result.errors.join('\n'))
            // Single-turn agents: let the process exit. Queued follow-ups still run before it does.
            input.control.closeInput(handle)
            handle.end()
            break
          }
          case 'session.ended':
            ended = { reason: event.reason, error: event.error }
            break
        }
      }
    } finally {
      input.control.unregister(handle)
    }

    const stopReason = input.control.stopReason
    let outcome: AgentOutcome
    if (stopReason) outcome = 'stopped'
    else if (capacity) outcome = 'capacity'
    else if (result) outcome = result.outcome
    else if (quota) outcome = 'quota'
    else outcome = 'crashed'
    if (outcome === 'crashed' && ended.error) appendOutput('error', ended.error)

    repos.sessions.update(session.id, {
      state: outcome === 'success' || outcome === 'stopped' || outcome === 'quota' || outcome === 'capacity' ? 'ended' : 'failed',
      endReason: stopReason ?? (outcome === 'success' ? 'completed' : outcome),
      endedAt: nowIso(),
    })
    return { outcome, result, error: ended.error, sdkSessionId: handle.sessionId(), turns }
  }

  /** Ask the exhausted session for a structured handoff; fall back to an empty one. */
  private async requestHandoff(
    input: AgentRunInput,
    agentId: string,
    base: Omit<SessionSpec, 'prompt' | 'maxTurns'>,
    sdkSessionId: string | null,
  ): Promise<Handoff> {
    const empty: Handoff = {
      completedWork: [],
      commits: [],
      filesChanged: [],
      unresolvedIssues: [],
      importantFindings: ['No handoff was available. Inspect `git log` and `git status` in the worktree to see prior progress.'],
      nextSteps: ['Continue the task from the current state of the worktree.'],
    }
    if (!sdkSessionId) return empty
    const spec: SessionSpec = {
      ...base,
      prompt: buildHandoffRequestPrompt(),
      maxTurns: 3,
      tools: [],
      outputSchema: handoffJsonSchema,
      nexusTools: undefined,
      resumeSessionId: sdkSessionId,
    }
    const result = await this.runSession(input, agentId, spec, { read: new Set(), changed: new Set() }, { handoff: true })
    const parsed = HandoffSchema.safeParse(result.result?.structuredOutput)
    const handoff = parsed.success ? parsed.data : empty
    const latest = this.deps.repos.sessions.latestForAgent(agentId)
    if (latest) this.deps.repos.sessions.update(latest.id, { state: 'rotated', handoff })
    return handoff
  }

  private bumpMetrics(
    agentId: string,
    toolName: string,
    toolInput: Record<string, unknown>,
    files: { read: Set<string>; changed: Set<string> },
    activity: string,
  ): void {
    const { repos } = this.deps
    const agent = repos.agents.require(agentId)
    const path = typeof toolInput['file_path'] === 'string' ? toolInput['file_path'] : toolInput['notebook_path']
    if (typeof path === 'string') {
      if (FILE_READ_TOOLS.has(toolName)) files.read.add(path.toLowerCase())
      if (FILE_WRITE_TOOLS.has(toolName)) files.changed.add(path.toLowerCase())
    }
    const metrics: AgentMetrics = {
      ...agent.metrics,
      toolCalls: agent.metrics.toolCalls + 1,
      commands: agent.metrics.commands + (SHELL_TOOLS.has(toolName) ? 1 : 0),
      filesRead: files.read.size,
      filesChanged: files.changed.size,
    }
    repos.agents.update(agentId, { metrics, activity: `${toolName}: ${activity}`.slice(0, 200) })
  }

  /**
   * The runtime reports usage cumulatively per SDK session (and a resumed session continues the totals
   * of the session it resumes), while `numTurns` is per result. The agent's metrics and the usage rows
   * therefore hold deltas against the last cumulative figures seen for that SDK session. That keeps
   * follow-up turns, resumed sessions (which get a new agent row) and the handoff request on a rotated
   * session from being counted twice. A figure that went down means the counter restarted.
   */
  private recordUsage(input: AgentRunInput, agentId: string, sessionKey: string, result: TurnResult): void {
    const { repos, bus } = this.deps
    const key = usageKey(sessionKey)
    const before = repos.settings.getValue<CumulativeUsage>(key) ?? {}
    const after: CumulativeUsage = { ...before }
    const deltas: UsageInfo[] = []
    for (const u of result.usage) {
      const prev = before[u.model]
      // A zeroed entry is the SDK reporting nothing for that model this time, not a counter restart: keep the
      // baseline, or the next cumulative figure would be counted in full a second time.
      if (prev && u.inputTokens === 0 && u.outputTokens === 0 && u.cacheReadTokens === 0 && u.cacheCreationTokens === 0 && u.costUsd === 0) continue
      const step = (cur: number, old: number | undefined): number => (old === undefined || cur < old ? cur : cur - old)
      deltas.push({
        model: u.model,
        inputTokens: step(u.inputTokens, prev?.inputTokens),
        outputTokens: step(u.outputTokens, prev?.outputTokens),
        cacheReadTokens: step(u.cacheReadTokens, prev?.cacheReadTokens),
        cacheCreationTokens: step(u.cacheCreationTokens, prev?.cacheCreationTokens),
        costUsd: step(u.costUsd, prev?.costUsd),
        contextWindow: u.contextWindow,
      })
      after[u.model] = u
    }
    const sum = (pick: (u: UsageInfo) => number): number => deltas.reduce((n, u) => n + pick(u), 0)
    const agent = repos.agents.require(agentId)
    bus.transaction(() => {
      if (result.usage.length > 0) repos.settings.setValue(key, after)
      const metrics: AgentMetrics = {
        ...agent.metrics,
        turns: agent.metrics.turns + result.numTurns,
        inputTokens: (agent.metrics.inputTokens ?? 0) + sum((u) => u.inputTokens),
        outputTokens: (agent.metrics.outputTokens ?? 0) + sum((u) => u.outputTokens),
        cacheReadTokens: (agent.metrics.cacheReadTokens ?? 0) + sum((u) => u.cacheReadTokens),
        costUsd: (agent.metrics.costUsd ?? 0) + sum((u) => u.costUsd),
        contextWindow: deltas.length > 0 ? (deltas[deltas.length - 1]?.contextWindow ?? null) : agent.metrics.contextWindow,
      }
      repos.agents.update(agentId, { metrics })
      for (const u of deltas) {
        repos.usage.insert({
          id: newId(),
          runId: input.run.id,
          agentId,
          model: u.model,
          inputTokens: u.inputTokens,
          outputTokens: u.outputTokens,
          cacheReadTokens: u.cacheReadTokens,
          cacheCreationTokens: u.cacheCreationTokens,
          costUsd: u.costUsd,
          contextWindow: u.contextWindow,
          turns: result.numTurns,
          createdAt: nowIso(),
        })
      }
      bus.emit({
        runId: input.run.id,
        taskId: input.task?.id ?? null,
        agentId,
        type: 'agent.usage',
        payload: {
          inputTokens: metrics.inputTokens ?? 0,
          outputTokens: metrics.outputTokens ?? 0,
          costUsd: metrics.costUsd ?? 0,
          turn: {
            sdkSessionId: sessionKey === agentId ? null : sessionKey,
            role: input.role,
            turns: result.numTurns,
            durationMs: result.durationMs,
            models: deltas.map((u) => ({
              model: u.model,
              inputTokens: u.inputTokens,
              outputTokens: u.outputTokens,
              cacheReadTokens: u.cacheReadTokens,
              cacheCreationTokens: u.cacheCreationTokens,
              costUsd: u.costUsd,
            })),
          },
        },
      })
    })
  }

  private setState(agentId: string, to: AgentState): void {
    const { repos, bus } = this.deps
    const agent = repos.agents.require(agentId)
    if (agent.state === to || !canTransition('agent', agent.state, to)) return
    bus.transaction(() => {
      repos.agents.update(agentId, { state: to })
      bus.emit({
        runId: agent.runId,
        taskId: agent.taskId,
        agentId,
        type: 'agent.state_changed',
        payload: { from: agent.state, to },
      })
    })
  }

  private finishAgent(agentId: string, to: 'stopped' | 'failed', error: string | null, reason: string): void {
    const { repos, bus } = this.deps
    const agent = repos.agents.require(agentId)
    // Only tool approvals belong to a session; a graph approval outlives its proposer's turn.
    this.approvals.expire({ runId: agent.runId, agentId, kind: 'tool' })
    bus.transaction(() => {
      // 'stopped' is only reachable through 'stopping' in the agent state machine.
      if (to === 'stopped' && canTransition('agent', agent.state, 'stopping')) {
        repos.agents.update(agentId, { state: 'stopping' })
      }
      repos.agents.update(agentId, { state: to, error, activity: null, stoppedAt: nowIso() })
      bus.emit({
        runId: agent.runId,
        taskId: agent.taskId,
        agentId,
        type: 'agent.state_changed',
        payload: { from: agent.state, to },
      })
      if (to === 'failed') {
        bus.emit({ runId: agent.runId, taskId: agent.taskId, agentId, type: 'agent.failed', payload: { error: error ?? reason } })
      } else {
        bus.emit({ runId: agent.runId, taskId: agent.taskId, agentId, type: 'agent.stopped', payload: { reason } })
      }
    })
  }
}
