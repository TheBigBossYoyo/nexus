import {
  allocate,
  compareWorkItems,
  ControlLimitsSchema,
  DEFAULT_CONTROL_LIMITS,
  DEFAULT_PRIORITY,
  EnqueueInputSchema,
  HEALTH_COMPONENTS,
  mayNotify,
  nextOccurrence,
  overallHealth,
  scheduleDue,
  serviceOrder,
  ScheduleInputSchema,
  stateFromPhase,
  TERMINAL_WORK_ITEM_STATES,
  WORK_ITEM_TYPE_LABEL,
  type Allocation,
  type ComponentHealth,
  type ControlLimits,
  type ControlPlaneOverview,
  type GlobalWorkItem,
  type HealthComponent,
  type HealthLevel,
  type NotificationKind,
  type NotificationRecord,
  type Priority,
  type Schedule,
  type ScheduleAction,
  type WorkItemState,
  type WorkItemType,
  type WorkloadSnapshot,
} from '@shared/control-plane'
import { newId } from '@shared/ids'
import { NexusError } from '@shared/result'

const LIMITS_KEY = 'control-limits'
const DISPATCH_PAUSED_KEY = 'control-dispatch-paused'
const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** How the control plane drives one kind of workload. Each adapter is a thin view of an engine that already exists. */
export interface WorkloadAdapter {
  /** Start the workload of a queued item (or continue it). Returns its id. */
  start(item: GlobalWorkItem): Promise<string>
  pause(refId: string): Promise<void>
  resume(refId: string): Promise<void>
  cancel(refId: string): Promise<void>
  /** What the workload's own engine says now. Never throws: a workload that is gone is `missing`. */
  snapshot(refId: string): WorkloadSnapshot
  title(item: Pick<GlobalWorkItem, 'refId' | 'payload'>): string | null
  /** The most agents the workload asks for. */
  requestedAgents(item: Pick<GlobalWorkItem, 'refId' | 'payload'>): number
}

export interface WorkItemStore {
  insert(item: GlobalWorkItem): GlobalWorkItem
  update(id: string, patch: Partial<GlobalWorkItem>): GlobalWorkItem
  get(id: string): GlobalWorkItem | null
  listOpen(): GlobalWorkItem[]
  listFinished(limit: number): GlobalWorkItem[]
  findOpenByRef(type: WorkItemType, refId: string): GlobalWorkItem | null
  maxPosition(): number
  delete(id: string): void
}

export interface ScheduleStore {
  insert(schedule: Schedule): Schedule
  update(id: string, patch: Partial<Schedule>): Schedule
  get(id: string): Schedule | null
  list(): Schedule[]
  delete(id: string): void
}

export interface IncidentStore {
  insert(incident: { id: string; at: string; summary: string; itemId: string | null }): unknown
  recent(limit: number): { at: string; summary: string; itemId: string | null }[]
}

export interface ControlPlaneDeps {
  items: WorkItemStore
  schedules: ScheduleStore
  incidents: IncidentStore
  settings: { getValue<T>(key: string): T | null; setValue(key: string, value: unknown): void }
  adapters: Partial<Record<WorkItemType, WorkloadAdapter>>
  /**
   * One row per occurrence of a schedule that fired. With it an occurrence fires once however often the
   * runtime restarts; without it (tests of the pure service) the schedule's stored next time is the only guard.
   */
  firings?: { claim(scheduleId: string, occurrence: string, firedAt: string): boolean; complete(scheduleId: string, occurrence: string, itemId: string | null, result: string): void }
  /** Why an item was started, granted capacity or made to wait; one record when the answer changes. */
  decisions?: { insert(decision: { at: string; itemId: string; decision: string; reason: string }): void }
  /** Runs `fn` as one database transaction. */
  transaction?: <T>(fn: () => T) => T
  /** Worker processes, for the overview. */
  workers?: () => { live: number; busy: number; max: number } | null
  /** The Claude usage gate. */
  usage: { canDispatch(): boolean; onChange?(listener: () => void): () => void }
  /**
   * Workloads that are working and were not started from the queue (a mission from the composer, a program
   * from its page). They are adopted as work items so that everything that uses agents is in one queue.
   */
  unownedActiveWorkloads?: () => { type: WorkItemType; refId: string; title: string; requestedAgents: number }[]
  /** One line per component other than the scheduler, which reports itself. */
  health?: Partial<Record<Exclude<HealthComponent, 'scheduler'>, () => { level: HealthLevel; detail: string }>>
  /** Shows one native notification. The control plane decides whether one is due. */
  notify?: (kind: NotificationKind, title: string, body: string) => void
  onChange?: () => void
  /** The agent allowance of some workload changed: runs may be able to start more sessions now. */
  onAllocationChange?: () => void
  now?: () => number
  logger?: (line: string) => void
  /** Milliseconds between passes; 0 disables the timer (tests call tick()). */
  tickIntervalMs?: number
}

/**
 * The control plane: the global queue, the allocation of agent capacity between workloads, schedules and
 * health. It starts, pauses and resumes workloads through their own engines and never keeps a second truth
 * about them: an item's state is read from its workload on every pass.
 */
export class ControlPlane {
  private timer: ReturnType<typeof setInterval> | null = null
  private unsubscribe: (() => void) | null = null
  private running: Promise<void> = Promise.resolve()
  private disposed = false
  private allocation: Allocation = { allowance: new Map(), admit: [], waiting: new Map(), free: 0 }
  private snapshots = new Map<string, WorkloadSnapshot>()
  private allocatedAt = 0
  private allocationSignature = ''
  private lastTickAt: number | null = null
  private lastError: string | null = null
  private readonly shown: NotificationRecord[] = []
  private readonly bootedAt: string
  private readonly lastDecision = new Map<string, string>()

  constructor(private readonly deps: ControlPlaneDeps) {
    this.bootedAt = this.iso()
    const every = deps.tickIntervalMs ?? 2000
    if (every > 0) {
      this.timer = setInterval(() => void this.tick(), every)
      this.timer.unref()
    }
    this.unsubscribe = deps.usage.onChange?.(() => void this.tick()) ?? null
  }

  dispose(): void {
    this.disposed = true
    if (this.timer) clearInterval(this.timer)
    this.unsubscribe?.()
  }

  idle(): Promise<void> {
    return this.running
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  private iso(ms = this.now()): string {
    return new Date(ms).toISOString()
  }

  private log(line: string): void {
    this.deps.logger?.(`control-plane: ${line}`)
  }

  private adapter(type: WorkItemType): WorkloadAdapter {
    const adapter = this.deps.adapters[type]
    if (!adapter) throw new NexusError('runtime_unavailable', `${WORK_ITEM_TYPE_LABEL[type]} work is not available in this process`)
    return adapter
  }

  private incident(summary: string, itemId: string | null): void {
    this.deps.incidents.insert({ id: newId(), at: this.iso(), summary: summary.slice(0, 500), itemId })
  }

  private notify(kind: NotificationKind, subject: string, title: string, body: string): void {
    const candidate: NotificationRecord = { kind, subject, at: this.now() }
    if (!mayNotify(candidate, this.shown)) return
    this.shown.push(candidate)
    if (this.shown.length > 100) this.shown.splice(0, this.shown.length - 100)
    try {
      this.deps.notify?.(kind, title, body.slice(0, 300))
    } catch (e) {
      this.log(`notification failed: ${errorMessage(e)}`)
    }
  }

  /** A notification from outside the queue (a milestone, a regression, a refused tool call). The restraint rules apply. */
  announce(kind: NotificationKind, subject: string, title: string, body: string): void {
    this.notify(kind, subject, title, body)
  }

  // ───────────────────────────── limits ─────────────────────────────

  limits(): ControlLimits {
    const stored = ControlLimitsSchema.safeParse(this.deps.settings.getValue<unknown>(LIMITS_KEY))
    return stored.success ? stored.data : DEFAULT_CONTROL_LIMITS
  }

  setLimits(input: unknown): ControlLimits {
    const parsed = ControlLimitsSchema.safeParse(input)
    if (!parsed.success) throw new NexusError('invalid_input', `Invalid limits: ${parsed.error.issues[0]?.message ?? 'unknown'}`)
    this.deps.settings.setValue(LIMITS_KEY, parsed.data)
    this.allocatedAt = 0
    void this.tick()
    return parsed.data
  }

  /** True while the user paused dispatch: what runs keeps running, nothing new starts. Stored, so it survives a restart. */
  dispatchPaused(): boolean {
    return this.deps.settings.getValue<unknown>(DISPATCH_PAUSED_KEY) === true
  }

  setDispatchPaused(paused: boolean): boolean {
    if (paused === this.dispatchPaused()) return paused
    this.deps.settings.setValue(DISPATCH_PAUSED_KEY, paused)
    this.incident(paused ? 'Dispatch was paused: nothing new starts until it is resumed.' : 'Dispatch was resumed.', null)
    this.allocatedAt = 0
    void this.tick()
    return paused
  }

  // ───────────────────────────── queue ─────────────────────────────

  /** Puts an existing workload on the queue. The scheduler starts it when capacity allows. */
  enqueue(input: unknown, options: { scheduleId?: string; notBefore?: string | null } = {}): GlobalWorkItem {
    const parsed = EnqueueInputSchema.safeParse(input)
    if (!parsed.success) throw new NexusError('invalid_input', `Invalid work item: ${parsed.error.issues[0]?.message ?? 'unknown'}`)
    const data = parsed.data
    const refId = data.type === 'program' ? data.programId : data.type === 'arena' ? data.campaignId : data.type === 'workspace_mission' ? data.missionId : null
    const payload = data.type === 'scheduled_audit' ? { projectId: data.projectId, kind: data.kind } : null
    const adapter = this.adapter(data.type)
    if (refId) {
      const existing = this.deps.items.findOpenByRef(data.type, refId)
      if (existing) throw new NexusError('invalid_state', `${WORK_ITEM_TYPE_LABEL[data.type]} is already on the queue (${existing.state}).`)
      const snapshot = adapter.snapshot(refId)
      if (snapshot.phase === 'missing') throw new NexusError('not_found', `${WORK_ITEM_TYPE_LABEL[data.type]} ${refId} does not exist`)
      if (snapshot.phase === 'completed' || snapshot.phase === 'cancelled') throw new NexusError('invalid_state', `${WORK_ITEM_TYPE_LABEL[data.type]} is already ${snapshot.phase}.`)
    }
    const at = this.iso()
    const scheduled = options.notBefore && Date.parse(options.notBefore) > this.now()
    const item = this.deps.items.insert({
      id: newId(),
      type: data.type,
      refId,
      title: adapter.title({ refId, payload }) ?? WORK_ITEM_TYPE_LABEL[data.type],
      priority: data.priority ?? DEFAULT_PRIORITY,
      position: this.deps.items.maxPosition() + 1,
      state: scheduled ? 'SCHEDULED' : 'QUEUED',
      requestedAgents: Math.max(1, adapter.requestedAgents({ refId, payload })),
      deadlineAt: null,
      notBefore: scheduled ? (options.notBefore ?? null) : null,
      scheduleId: options.scheduleId ?? null,
      heldByUser: false,
      payload,
      detail: null,
      createdAt: at,
      updatedAt: at,
      startedAt: null,
      finishedAt: null,
    })
    void this.tick()
    return item
  }

  private require(id: string): GlobalWorkItem {
    const item = this.deps.items.get(id)
    if (!item) throw new NexusError('not_found', `Work item ${id} does not exist`)
    return item
  }

  setPriority(id: string, priority: Priority): GlobalWorkItem {
    const item = this.require(id)
    if (TERMINAL_WORK_ITEM_STATES.includes(item.state)) throw new NexusError('invalid_state', `The item is ${item.state}.`)
    const updated = this.deps.items.update(id, { priority, updatedAt: this.iso() })
    this.allocatedAt = 0
    void this.tick()
    return updated
  }

  /** Moves an item before every other item of its priority, or one place up or down among them. The order is persisted. */
  move(id: string, where: 'top' | 'up' | 'down'): GlobalWorkItem {
    const item = this.require(id)
    const peers = this.deps.items
      .listOpen()
      .filter((i) => i.priority === item.priority)
      .sort(compareWorkItems)
    const index = peers.findIndex((i) => i.id === id)
    if (index < 0) throw new NexusError('invalid_state', `The item is ${item.state}.`)
    const at = this.iso()
    if (where === 'top') {
      const first = peers[0]
      if (first && first.id !== id) this.deps.items.update(id, { position: first.position - 1, updatedAt: at })
    } else {
      const other = peers[where === 'up' ? index - 1 : index + 1]
      if (other) {
        // Equal positions are possible after adoption; make the swap strict.
        const [a, b] = other.position === item.position ? [item.position, item.position + (where === 'up' ? 1 : -1)] : [other.position, item.position]
        this.deps.items.update(id, { position: a, updatedAt: at })
        this.deps.items.update(other.id, { position: b, updatedAt: at })
      }
    }
    this.allocatedAt = 0
    void this.tick()
    return this.require(id)
  }

  /** The user holds an item: its workload is paused if it runs, and the scheduler leaves it alone. */
  async pause(id: string): Promise<GlobalWorkItem> {
    const item = this.require(id)
    if (TERMINAL_WORK_ITEM_STATES.includes(item.state)) throw new NexusError('invalid_state', `The item is ${item.state}.`)
    this.deps.items.update(id, { heldByUser: true, updatedAt: this.iso() })
    if (item.refId && (item.state === 'RUNNING' || item.state === 'QUOTA_WAIT')) await this.adapter(item.type).pause(item.refId)
    await this.tick()
    return this.require(id)
  }

  async resume(id: string): Promise<GlobalWorkItem> {
    const item = this.require(id)
    if (TERMINAL_WORK_ITEM_STATES.includes(item.state)) throw new NexusError('invalid_state', `The item is ${item.state}.`)
    this.deps.items.update(id, { heldByUser: false, updatedAt: this.iso() })
    if (item.refId) {
      const phase = this.adapter(item.type).snapshot(item.refId).phase
      if (phase === 'paused' || phase === 'blocked') await this.adapter(item.type).resume(item.refId)
    }
    await this.tick()
    return this.require(id)
  }

  async cancel(id: string): Promise<GlobalWorkItem> {
    const item = this.require(id)
    if (TERMINAL_WORK_ITEM_STATES.includes(item.state)) return item
    const started = item.refId ? this.adapter(item.type).snapshot(item.refId).phase !== 'not_started' : false
    // A workload that never started is only taken off the queue; it is not cancelled itself.
    if (item.refId && started) await this.adapter(item.type).cancel(item.refId)
    this.deps.items.update(id, { state: 'CANCELLED', finishedAt: this.iso(), updatedAt: this.iso(), detail: started ? 'Cancelled by the user.' : 'Taken off the queue before it started.' })
    await this.tick()
    return this.require(id)
  }

  // ───────────────────────────── schedules ─────────────────────────────

  createSchedule(input: unknown): Schedule {
    const parsed = ScheduleInputSchema.safeParse(input)
    if (!parsed.success) throw new NexusError('invalid_input', `Invalid schedule: ${parsed.error.issues[0]?.message ?? 'unknown'}`)
    this.adapter(parsed.data.action.type)
    const at = this.iso()
    const next = parsed.data.enabled ? (nextOccurrence(parsed.data.rule, new Date(this.now()))?.toISOString() ?? null) : null
    if (parsed.data.enabled && parsed.data.rule.kind === 'once' && next === null) throw new NexusError('invalid_input', 'The time of a one-time schedule is in the past.')
    return this.deps.schedules.insert({ id: newId(), ...parsed.data, nextRunAt: next, lastRunAt: null, lastResult: null, createdAt: at, updatedAt: at })
  }

  setScheduleEnabled(id: string, enabled: boolean): Schedule {
    const schedule = this.deps.schedules.get(id)
    if (!schedule) throw new NexusError('not_found', `Schedule ${id} does not exist`)
    const next = enabled ? (nextOccurrence(schedule.rule, new Date(this.now()))?.toISOString() ?? null) : null
    return this.deps.schedules.update(id, { enabled, nextRunAt: next, updatedAt: this.iso() })
  }

  removeSchedule(id: string): void {
    this.deps.schedules.delete(id)
  }

  private enqueueInputOf(action: ScheduleAction, priority: Priority): unknown {
    return { ...action, priority }
  }

  private fireSchedules(): void {
    const now = new Date(this.now())
    for (const schedule of this.deps.schedules.list()) {
      const { due, nextRunAt } = scheduleDue(schedule, now)
      if (!due || !schedule.nextRunAt) continue
      const occurrence = schedule.nextRunAt
      const advance = (lastResult: string | null): void =>
        void this.deps.schedules.update(schedule.id, { nextRunAt, ...(lastResult !== null ? { lastRunAt: now.toISOString(), lastResult: lastResult.slice(0, 300) } : {}), enabled: schedule.rule.kind === 'once' ? false : schedule.enabled, updatedAt: now.toISOString() })
      // The claim, the queued item and the schedule's next time are one transaction: after a crash anywhere in
      // between, either all of it happened or none of it did, and the occurrence is claimed at most once.
      const fire = (): void => {
        if (this.deps.firings && !this.deps.firings.claim(schedule.id, occurrence, now.toISOString())) {
          // This occurrence already fired (before a restart that lost the schedule's new time). Only move on.
          advance(null)
          return
        }
        let result: string
        let itemId: string | null = null
        try {
          const item = this.enqueue(this.enqueueInputOf(schedule.action, schedule.priority), { scheduleId: schedule.id })
          itemId = item.id
          result = `Queued "${item.title}".`
          this.notify('schedule_started', schedule.id, `Scheduled: ${schedule.name}`, result)
        } catch (e) {
          // A schedule that cannot queue its work says why and keeps its next time; it never retries in a loop.
          result = `Not queued: ${errorMessage(e)}`
          this.incident(`Schedule "${schedule.name}" queued nothing: ${errorMessage(e)}`, null)
        }
        this.deps.firings?.complete(schedule.id, occurrence, itemId, result)
        advance(result)
      }
      if (this.deps.transaction) this.deps.transaction(fire)
      else fire()
    }
  }

  // ───────────────────────────── the pass ─────────────────────────────

  /** One pass: schedules, adoption, reconciliation with the workloads, allocation, admission. Passes never overlap. */
  tick(): Promise<void> {
    const next = this.running.then(async () => {
      if (this.disposed) return
      try {
        this.fireSchedules()
        this.releaseScheduled()
        this.adoptRuns()
        this.reconcile()
        await this.admit()
        this.lastError = null
      } catch (e) {
        this.lastError = errorMessage(e)
        this.log(`pass failed: ${this.lastError}`)
      }
      this.lastTickAt = this.now()
      this.deps.onChange?.()
    })
    this.running = next.catch(() => undefined)
    return this.running
  }

  private releaseScheduled(): void {
    for (const item of this.deps.items.listOpen()) {
      if (item.state === 'SCHEDULED' && (!item.notBefore || Date.parse(item.notBefore) <= this.now())) this.deps.items.update(item.id, { state: 'QUEUED', updatedAt: this.iso() })
    }
  }

  private adoptRuns(): void {
    for (const run of this.deps.unownedActiveWorkloads?.() ?? []) {
      if (this.deps.items.findOpenByRef(run.type, run.refId)) continue
      const at = this.iso()
      this.deps.items.insert({ id: newId(), type: run.type, refId: run.refId, title: run.title, priority: DEFAULT_PRIORITY, position: this.deps.items.maxPosition() + 1, state: 'RUNNING', requestedAgents: Math.max(1, run.requestedAgents), deadlineAt: null, notBefore: null, scheduleId: null, heldByUser: false, payload: null, detail: 'Started directly; adopted by the queue.', createdAt: at, updatedAt: at, startedAt: at, finishedAt: null })
    }
  }

  /** Reads every open item's workload and sets the item's state from it. */
  private reconcile(): void {
    const snapshots = new Map<string, WorkloadSnapshot>()
    for (const item of this.deps.items.listOpen()) {
      if (!item.refId) continue
      const adapter = this.deps.adapters[item.type]
      if (!adapter) continue
      let snapshot: WorkloadSnapshot
      try {
        snapshot = adapter.snapshot(item.refId)
      } catch (e) {
        snapshot = { phase: 'missing', activeAgents: 0, runIds: [], detail: errorMessage(e) }
      }
      snapshots.set(item.id, snapshot)
      // An item that has not been admitted yet stays queued whatever its workload says (a paused program on the queue is waiting for its turn).
      const waitingForTurn = item.startedAt === null && (snapshot.phase === 'not_started' || snapshot.phase === 'paused' || snapshot.phase === 'blocked')
      const state: WorkItemState = waitingForTurn ? stateFromPhase('not_started', item.state, item.heldByUser) : stateFromPhase(snapshot.phase, item.state, item.heldByUser)
      if (state === item.state && (snapshot.detail ?? null) === item.detail) continue
      const terminal = TERMINAL_WORK_ITEM_STATES.includes(state)
      this.deps.items.update(item.id, { state, detail: snapshot.detail, updatedAt: this.iso(), ...(terminal ? { finishedAt: this.iso() } : {}) })
      if (state === item.state) continue
      const label = `${WORK_ITEM_TYPE_LABEL[item.type]} "${item.title}"`
      if (state === 'FAILED') {
        this.incident(`${label} failed${snapshot.detail ? `: ${snapshot.detail}` : '.'}`, item.id)
        this.notify('work_item_failed', item.id, `${WORK_ITEM_TYPE_LABEL[item.type]} failed`, `${item.title}${snapshot.detail ? `: ${snapshot.detail}` : ''}`)
      } else if (state === 'BLOCKED') {
        this.incident(`${label} is blocked${snapshot.detail ? `: ${snapshot.detail}` : '.'}`, item.id)
        this.notify(item.type === 'program' ? 'program_blocked' : 'workload_blocked', item.id, `${WORK_ITEM_TYPE_LABEL[item.type]} blocked`, `${item.title}${snapshot.detail ? `: ${snapshot.detail}` : ''}`)
      } else if (state === 'QUOTA_WAIT') {
        this.notify('quota_paused', 'claude', 'Waiting for the Claude usage limit', 'Work that needs Claude is waiting. It continues by itself after the reset.')
      } else if (state === 'RUNNING' && item.state === 'QUOTA_WAIT') {
        this.notify('quota_resumed', 'claude', 'Claude is available again', 'Waiting work continues.')
      }
    }
    this.snapshots = snapshots
  }

  private computeAllocation(): Allocation {
    const items = this.deps.items.listOpen()
    const active = new Map<string, number>()
    for (const item of items) active.set(item.id, this.snapshots.get(item.id)?.activeAgents ?? 0)
    this.allocation = allocate({ items, active, limits: this.limits(), claudeAvailable: this.deps.usage.canDispatch(), paused: this.dispatchPaused(), now: this.now() })
    this.recordDecisions(items)
    this.allocatedAt = this.now()
    const signature = [...this.allocation.allowance].map(([id, n]) => `${id}:${n}`).join(',')
    if (signature !== this.allocationSignature) {
      this.allocationSignature = signature
      this.deps.onAllocationChange?.()
    }
    return this.allocation
  }

  /** Records why each open item has what it has, when that changed since the last allocation. */
  private recordDecisions(items: readonly GlobalWorkItem[]): void {
    if (!this.deps.decisions) return
    const open = new Set<string>()
    for (const item of items) {
      open.add(item.id)
      const waiting = this.allocation.waiting.get(item.id)
      const granted = this.allocation.allowance.get(item.id)
      const decision = this.allocation.admit.includes(item.id) ? 'ADMIT' : waiting ? 'WAIT' : granted !== undefined ? 'GRANT' : null
      if (!decision) continue
      const reason = decision === 'WAIT' ? (waiting as string) : decision === 'ADMIT' ? `Started with ${granted} of ${item.requestedAgents} agent(s) at ${item.priority}.` : `May hold ${granted} of ${item.requestedAgents} agent(s).`
      const signature = `${decision}|${reason}`
      if (this.lastDecision.get(item.id) === signature) continue
      this.lastDecision.set(item.id, signature)
      try {
        this.deps.decisions.insert({ at: this.iso(), itemId: item.id, decision, reason })
      } catch (e) {
        this.log(`decision not recorded: ${errorMessage(e)}`)
      }
    }
    for (const id of [...this.lastDecision.keys()]) if (!open.has(id)) this.lastDecision.delete(id)
  }

  private async admit(): Promise<void> {
    const allocation = this.computeAllocation()
    for (const id of allocation.admit) {
      const item = this.deps.items.get(id)
      if (!item || item.heldByUser) continue
      try {
        const refId = await this.adapter(item.type).start(item)
        this.deps.items.update(id, { refId, state: 'RUNNING', startedAt: this.iso(), updatedAt: this.iso(), detail: null })
      } catch (e) {
        // A workload that cannot start is not retried on every pass: the item fails with the reason.
        this.deps.items.update(id, { state: 'FAILED', finishedAt: this.iso(), updatedAt: this.iso(), detail: `Could not be started: ${errorMessage(e)}`.slice(0, 500) })
        this.incident(`${WORK_ITEM_TYPE_LABEL[item.type]} "${item.title}" could not be started: ${errorMessage(e)}`, id)
      }
    }
    if (allocation.admit.length > 0) {
      this.reconcile()
      this.computeAllocation()
    }
  }

  /**
   * The parallel-session limit of one run: what its item was granted, less what the item's other runs use.
   * A run no item owns keeps its own limit (it is adopted on the next pass).
   */
  allowanceForRun(runId: string, normal: number, activeInRun: number): number {
    // Always from the present state: the question is asked at the moment a run wants to start a session, often
    // right after it was resumed, and an answer computed while it was still paused would be zero.
    try {
      this.reconcile()
      this.computeAllocation()
    } catch (e) {
      this.log(`allocation failed: ${errorMessage(e)}`)
      return normal
    }
    for (const [itemId, snapshot] of this.snapshots) {
      if (!snapshot.runIds.includes(runId)) continue
      const granted = this.allocation.allowance.get(itemId)
      // The run's item holds no capacity in the queue's eyes (it is paused, blocked or not yet started there)
      // while the run itself is working: the queue is behind the run, and the run keeps its own limit until the
      // next pass has caught up.
      if (granted === undefined) return normal
      const others = Math.max(0, snapshot.activeAgents - activeInRun)
      return Math.max(0, Math.min(normal, granted - others))
    }
    return normal
  }

  /**
   * False when a run can start nothing because the capacity is used by others and it runs no session of its
   * own. The orchestrator treats that as a closed gate (a wait), not as a run that cannot make progress.
   */
  hasCapacityForRun(runId: string, normal: number, activeInRun: number): boolean {
    return activeInRun > 0 || this.allowanceForRun(runId, normal, activeInRun) > 0
  }

  // ───────────────────────────── boot ─────────────────────────────

  /**
   * After a restart of NEXUS: the queue is as it was stored. Every open item is read against its workload
   * (programs, workspace missions and Arena campaigns continue by their own recovery rules; a plain mission
   * is paused by the orchestrator and resumed here only when the limits say `resume`).
   */
  async recoverOnBoot(resumeMission?: (runId: string) => Promise<void>, interruptedMissions?: () => string[]): Promise<void> {
    const open = this.deps.items.listOpen()
    if (open.length > 0) this.incident(`NEXUS started; ${open.length} open work item${open.length === 1 ? '' : 's'} read from the queue.`, null)
    await this.tick()
    if (this.limits().resumeOnBoot !== 'resume' || !resumeMission) return
    const resumed = new Set<string>()
    for (const item of this.deps.items.listOpen()) {
      if (item.type !== 'mission' || !item.refId || item.heldByUser || item.state !== 'PAUSED') continue
      resumed.add(item.refId)
      await resumeMission(item.refId).catch((e: unknown) => this.incident(`Mission "${item.title}" was not resumed after the restart: ${errorMessage(e)}`, item.id))
    }
    // A mission the runtime lost before the queue had adopted it has no item; it is resumed all the same.
    for (const runId of interruptedMissions?.() ?? []) {
      if (resumed.has(runId)) continue
      const item = this.deps.items.findOpenByRef('mission', runId)
      if (item?.heldByUser) continue
      await resumeMission(runId).catch((e: unknown) => this.incident(`A mission was not resumed after the restart: ${errorMessage(e)}`, item?.id ?? null))
    }
    await this.tick()
  }

  // ───────────────────────────── read model ─────────────────────────────

  health(): { level: HealthLevel; components: ComponentHealth[] } {
    const at = this.iso()
    const every = this.deps.tickIntervalMs ?? 2000
    const components: ComponentHealth[] = HEALTH_COMPONENTS.map((component): ComponentHealth => {
      if (component === 'scheduler') {
        if (this.lastError) return { component, level: 'DEGRADED', detail: `The last pass failed: ${this.lastError}`, checkedAt: at }
        if (this.lastTickAt === null) return { component, level: 'RECOVERING', detail: 'No pass has run yet.', checkedAt: at }
        const late = every > 0 && this.now() - this.lastTickAt > Math.max(30_000, every * 10)
        return { component, level: late ? 'DEGRADED' : 'HEALTHY', detail: late ? 'The scheduler has not run for a while.' : 'Passes are running.', checkedAt: at }
      }
      if (component === 'schedules' && !this.deps.health?.schedules) {
        const enabled = this.deps.schedules.list().filter((s) => s.enabled && s.nextRunAt)
        const overdue = enabled.filter((s) => this.now() - Date.parse(s.nextRunAt as string) > Math.max(60_000, every * 30))
        if (overdue.length > 0) return { component, level: 'DEGRADED', detail: `${overdue.length} schedule${overdue.length === 1 ? ' is' : 's are'} past the time and did not fire.`, checkedAt: at }
        const next = enabled.map((s) => s.nextRunAt as string).sort()[0]
        return { component, level: 'HEALTHY', detail: enabled.length === 0 ? 'No schedule is switched on.' : `${enabled.length} schedule${enabled.length === 1 ? '' : 's'} switched on; the next fires at ${next}. Schedules fire while the runtime runs, with or without a window.`, checkedAt: at }
      }
      const probe = this.deps.health?.[component]
      if (!probe) return { component, level: 'HEALTHY', detail: 'Not checked in this process.', checkedAt: at }
      try {
        return { component, ...probe(), checkedAt: at }
      } catch (e) {
        return { component, level: 'DEGRADED', detail: `The check failed: ${errorMessage(e)}`, checkedAt: at }
      }
    })
    return { level: overallHealth(components), components }
  }

  overview(): ControlPlaneOverview {
    const limits = this.limits()
    const open = serviceOrder(this.deps.items.listOpen(), this.now(), limits.agingMinutes)
    const activeOf = (id: string): number => this.snapshots.get(id)?.activeAgents ?? 0
    const live: WorkItemState[] = ['RUNNING', 'QUOTA_WAIT', 'FINALIZING']
    return {
      health: this.health(),
      limits,
      agents: { active: open.reduce((n, i) => n + activeOf(i.id), 0), max: limits.maxAgents },
      claudeAvailable: this.deps.usage.canDispatch(),
      active: open.filter((i) => live.includes(i.state)).map((i) => ({ ...i, activeAgents: activeOf(i.id), allowance: this.allocation.allowance.get(i.id) ?? activeOf(i.id) })),
      waiting: open
        .filter((i) => !live.includes(i.state) && i.state !== 'SCHEDULED')
        .map((i) => ({ ...i, reason: i.heldByUser ? 'Held by you.' : i.state === 'BLOCKED' ? (i.detail ?? 'Blocked.') : i.state === 'PAUSED' ? (i.detail ?? 'Paused.') : (this.allocation.waiting.get(i.id) ?? 'Next in the queue.') })),
      scheduled: open.filter((i) => i.state === 'SCHEDULED'),
      finished: this.deps.items.listFinished(20),
      schedules: this.deps.schedules.list(),
      incidents: this.deps.incidents.recent(20),
      bootedAt: this.bootedAt,
      dispatchPaused: this.dispatchPaused(),
      workers: this.deps.workers?.() ?? null,
    }
  }
}
