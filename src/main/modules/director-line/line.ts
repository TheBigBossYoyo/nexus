import { randomUUID } from 'node:crypto'
import {
  DEFAULT_COMMUNICATION_POLICY,
  type CommunicationPolicy,
  type DeliveryAttempt,
  type DeliveryOutcome,
  type OperatorChannelKind,
  type OperatorCommand,
  type OperatorIdentity,
  type RawUserIntent,
  type ReportEvent,
  type ReportEventKind,
} from '@shared/director-line'
import { commandRisk, interpretMessage, sanitizeInbound, type IntentClassifier } from './intent'
import type { PairingService } from './pairing'
import type { OperatorChannelProvider, RawProviderUpdate, SendResult } from './provider'
import {
  composeBlockers, composeChecks, composeDetails, composeEta, composeRefused, composeStatus, constrainSummary, HELP_TEXT, inert, inertBlock,
  PAIRED_TEXT, UNKNOWN_TEXT, UNPAIRED_TEXT, type LatestChecks, type StatusFacts,
} from './replies'
import type { DeliveryStore, OutboxItem, OutboxStore, PolicyStore, SeenStore } from './stores'
import type { VoiceProvider } from './voice'

/**
 * DirectorLine: the service between the phone and NEXUS.
 *
 * It holds NO reference to the capability broker, to settings, to power or to run creation. What it can do is
 * exactly what is injected below: read functions, pause/resume, and `submitIntent`, which the runtime wires to the
 * ordinary mission-creation path (Task Compiler and CapabilityBroker). A remote message therefore cannot grant,
 * allow, disable or approve anything: there is no function here to call.
 */

export interface DirectorLineReads {
  getStatus(): Promise<StatusFacts>
  getOvernightReport(): Promise<string | null>
  getLatestChecks(): Promise<LatestChecks | null>
}

export interface SubmitResult {
  accepted: boolean
  reference?: string
  /** A short reason from the creation path when it refuses; shown as plain text. */
  reason?: string
}

export interface DirectorLineActions {
  pauseAfterCurrentTask(): Promise<void>
  resume(): Promise<void>
  submitIntent(intent: RawUserIntent): Promise<SubmitResult>
}

export interface RefusalNote {
  at: string
  channel: OperatorChannelKind
  operatorId: string
  messageId: string
  topic: string
  /** The first 120 characters, as inert text, for the audit trail. */
  snippet: string
}

export interface DirectorLineOptions {
  messageProvider: OperatorChannelProvider | null
  voiceProvider: VoiceProvider | null
  pairing: PairingService
  seen: SeenStore
  outbox: OutboxStore
  deliveries: DeliveryStore
  policy: PolicyStore
  reads: DirectorLineReads
  actions: DirectorLineActions
  /** Optional cheap-model classifier for what the patterns miss. It can only choose among the closed command set. */
  classify?: IntentClassifier
  /** Optional rephraser. Gets only the facts; its output is capped and loses URLs it was not given. */
  summarize?: (facts: string) => Promise<string>
  /** Shows a notification on the PC (last in the usual precedence). */
  localNotify?: (title: string, text: string) => Promise<void>
  isOnline?: () => Promise<boolean> | boolean
  recordNote?: (note: RefusalNote) => void
  now?: () => Date
  log?: (line: string) => void
}

const CRITICAL_KINDS: readonly ReportEventKind[] = ['CRITICAL_FAILURE', 'SECURITY_BOUNDARY_REQUIRED']
const MAX_MESSAGE_ATTEMPTS = 5
const UNPAIRED_REPLY_INTERVAL_MS = 10 * 60 * 1000
const MAX_TRACKED_CHATS = 500
const MAX_REPORT_CHARS = 1500
const DIGEST_ABOVE = 3

/** Minutes below which the same kind about the same subject is not sent again. */
function kindIntervalMinutes(kind: ReportEventKind, policy: CommunicationPolicy): number {
  switch (kind) {
    case 'CRITICAL_FAILURE': return 1
    case 'SECURITY_BOUNDARY_REQUIRED': return 5
    case 'MISSION_BLOCKED': return 30
    case 'NETWORK_OFFLINE': return 60
    case 'ETA_SLIPPED': return 30
    case 'MORNING_OVERNIGHT_REPORT': return 60
    case 'PROGRAM_COMPLETE': return 5
    case 'PROGRESS': return policy.minProgressIntervalMinutes
  }
}

/** Whether `at` falls in the quiet window, in the window's own time zone (so daylight saving is the zone's, not ours). */
export function inQuietHours(quiet: CommunicationPolicy['quietHours'], at: Date): boolean {
  if (!quiet.enabled || quiet.startMinute === quiet.endMinute) return false
  let minute: number
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: quiet.timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at)
    minute = Number(parts.find((p) => p.type === 'hour')?.value) * 60 + Number(parts.find((p) => p.type === 'minute')?.value)
  } catch {
    // An unknown zone name is a settings mistake: stay quiet rather than ring at night.
    return true
  }
  return quiet.startMinute < quiet.endMinute ? minute >= quiet.startMinute && minute < quiet.endMinute : minute >= quiet.startMinute || minute < quiet.endMinute
}

export function collapseTexts(items: OutboxItem[]): string {
  const sorted = [...items].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  const newest = sorted[sorted.length - 1]!
  const earlier = sorted.slice(0, -1)
  const wasBlocked = earlier.some((i) => i.event.kind === 'MISSION_BLOCKED' || i.event.kind === 'NETWORK_OFFLINE')
  const resolved = newest.event.resolved === true || newest.event.kind === 'PROGRAM_COMPLETE'
  if (resolved && wasBlocked) return `${newest.event.text} It had been blocked earlier and is no longer.`
  if (earlier.length > 0 && earlier.every((i) => i.event.kind === newest.event.kind)) return `${newest.event.text} (${items.length} similar notices combined.)`
  return earlier.length > 0 ? `${newest.event.text} (${earlier.length} earlier update(s) combined.)` : newest.event.text
}

export interface VoiceInput {
  from: string
  /** Digits entered on the keypad. */
  pin: string | null
  /** What the caller said or pressed after the PIN. */
  text: string
  callId: string
  envelopeId?: string
}

export class DirectorLine {
  private readonly o: DirectorLineOptions
  private readonly now: () => Date
  private readonly unpairedReplies = new Map<string, number>()
  private readonly lastSent = new Map<string, number>()
  private lastProgressText: string | null = null
  private chain: Promise<unknown> = Promise.resolve()

  constructor(options: DirectorLineOptions) {
    this.o = options
    this.now = options.now ?? (() => new Date())
  }

  async start(): Promise<void> {
    await this.o.messageProvider?.start((update) => this.handleUpdate(update))
  }

  async stop(): Promise<void> {
    await this.o.messageProvider?.stop()
  }

  private async getPolicy(): Promise<CommunicationPolicy> {
    return (await this.o.policy.get()) ?? DEFAULT_COMMUNICATION_POLICY
  }

  // ---- Inbound -----------------------------------------------------------------------------------------------

  /**
   * One raw delivery from a provider. The returned promise resolves when the update is durably handled; the provider
   * moves its own offset only after that.
   */
  async handleUpdate(update: RawProviderUpdate): Promise<void> {
    const at = this.now().toISOString()
    // Two keys: the provider's update id, and the message id. A redelivery or a duplicate is processed once, also after a restart.
    const freshUpdate = await this.o.seen.addIfAbsent(update.dedupeKey, at)
    const freshMessage = await this.o.seen.addIfAbsent(`msg:${update.channel}:${update.providerUserId}:${update.providerMessageId}`, at)
    if (!freshUpdate || !freshMessage) return

    const identity = update.providerAuthenticated ? await this.o.pairing.findPaired(update.channel, update.providerUserId) : null
    if (!identity) {
      await this.handleUnpaired(update)
      return
    }
    const text = sanitizeInbound(update.text)
    const command = await interpretMessage(text, this.o.classify)
    const reply = await this.act(identity, update, text, command, false)
    await this.reply(update.providerUserId, reply, `reply:${update.providerMessageId}`)
  }

  /** Everything from a chat that is not paired is UNTRUSTED_EXTERNAL: it is never interpreted, and gets at most one fixed reply. */
  private async handleUnpaired(update: RawProviderUpdate): Promise<void> {
    const attempt = await this.o.pairing.attemptPairing(update.channel, update.providerUserId, update.senderLabel, update.text)
    if (attempt.kind === 'COOLING') return
    if (attempt.kind === 'PAIRED') {
      await this.reply(update.providerUserId, PAIRED_TEXT, `reply:${update.providerMessageId}`)
      return
    }
    const key = `${update.channel}:${update.providerUserId}`
    const nowMs = this.now().getTime()
    const last = this.unpairedReplies.get(key)
    if (last !== undefined && nowMs - last < UNPAIRED_REPLY_INTERVAL_MS) return
    if (this.unpairedReplies.size >= MAX_TRACKED_CHATS) this.unpairedReplies.delete(this.unpairedReplies.keys().next().value as string)
    this.unpairedReplies.set(key, nowMs)
    await this.reply(update.providerUserId, UNPAIRED_TEXT, `reply:${update.providerMessageId}`)
  }

  /** The phone side, fed by opened relay envelopes. Returns the words to speak. */
  async handleVoiceInput(input: VoiceInput): Promise<{ speak: string; authenticated: boolean }> {
    const at = this.now().toISOString()
    if (input.envelopeId && !(await this.o.seen.addIfAbsent(`voice:${input.callId}:${input.envelopeId}`, at))) return { speak: '', authenticated: false }
    const policy = await this.getPolicy()
    const denied = { speak: 'Not authorised.', authenticated: false }
    let readOnlyOnly = false
    if (input.pin === null && !policy.requirePinForStatus) {
      // The number alone is weak (caller ID can be spoofed). Allowed only for reading, and only when the owner chose so.
      if (!(await this.o.pairing.findPaired('TWILIO_VOICE', input.from))) return denied
      readOnlyOnly = true
    } else if ((await this.o.pairing.authenticatePhone('TWILIO_VOICE', input.from, input.pin)) !== 'OK') {
      return denied
    }
    const identity = (await this.o.pairing.findPaired('TWILIO_VOICE', input.from))!
    const text = sanitizeInbound(input.text)
    const command = await interpretMessage(text, this.o.classify)
    const risk = commandRisk(command)
    // Speech recognition errs, so no task is created by voice, and a PIN-less call reads only.
    if (risk === 'TASK_HANDOFF') return { speak: 'Tasks cannot be added by phone. Send a message instead.', authenticated: true }
    if (readOnlyOnly && risk !== 'READ_ONLY' && command.kind !== 'HELP') return { speak: 'The PIN is needed for that.', authenticated: true }
    const spoken = await this.act(identity, { channel: 'TWILIO_VOICE', providerUserId: input.from, providerMessageId: `${input.callId}:${input.envelopeId ?? ''}`, dedupeKey: '', senderLabel: '', text, receivedAt: at, providerAuthenticated: true }, text, command, true)
    return { speak: inert(spoken.replace(/\n+/g, '. '), 500), authenticated: true }
  }

  /**
   * 0.9.1: what a sentence of a live call asks for. The same closed set of commands as a message; the text is
   * cleaned the same way. Nothing is done by this.
   */
  async interpretSpoken(text: string): Promise<{ text: string; command: OperatorCommand }> {
    const cleaned = sanitizeInbound(text)
    return { text: cleaned, command: await interpretMessage(cleaned, this.o.classify) }
  }

  /**
   * 0.9.1: carries out one command of a live call and returns what is said back. Only for a call that the voice
   * session authenticated (the paired number and the PIN): the caller must be a paired phone, and each turn is
   * done once (a turn that is delivered twice is answered with nothing the second time). Tasks are allowed here,
   * unlike `handleVoiceInput`: the session reads a task back and waits for a yes before it calls this.
   */
  async performSpoken(input: { from: string; callId: string; turnId: string; text: string; command: OperatorCommand }): Promise<string> {
    const at = this.now().toISOString()
    const identity = await this.o.pairing.findPaired('TWILIO_VOICE', input.from)
    if (!identity) return 'Not authorised.'
    if (!(await this.o.seen.addIfAbsent(`voice-turn:${input.callId}:${input.turnId}`, at))) return ''
    const spoken = await this.act(identity, { channel: 'TWILIO_VOICE', providerUserId: input.from, providerMessageId: `${input.callId}:${input.turnId}`, dedupeKey: '', senderLabel: '', text: input.text, receivedAt: at, providerAuthenticated: true }, input.text, input.command, true)
    return inert(spoken.replace(/\n+/g, '. '), 600)
  }

  /** What is said at the start of a call NEXUS places about an event: the report's own text, made safe to speak. */
  spokenReport(text: string): string {
    return inert(text.replace(/\n+/g, '. '), 500)
  }

  private async act(identity: OperatorIdentity, update: RawProviderUpdate, text: string, command: OperatorCommand, spoken: boolean): Promise<string> {
    const { reads, actions } = this.o
    try {
      switch (command.kind) {
        case 'HELP': return HELP_TEXT
        case 'UNKNOWN': return UNKNOWN_TEXT
        case 'REFUSED_AT_MACHINE':
          this.o.recordNote?.({ at: this.now().toISOString(), channel: update.channel, operatorId: identity.providerUserId, messageId: update.providerMessageId, topic: command.topic, snippet: inert(text, 120) })
          return composeRefused(command.topic)
        case 'PAUSE_AFTER_CURRENT_TASK':
          await actions.pauseAfterCurrentTask()
          return 'Done: NEXUS will pause after the current task.'
        case 'CONTINUE':
          await actions.resume()
          return 'Done: NEXUS continues.'
        case 'ADD_TASK_AFTER_CURRENT':
        case 'CREATE_TASK': {
          // The operator's words are the user's words. They go to the ordinary creation path, which applies the Task
          // Compiler and the CapabilityBroker; nothing in the text changes what that path allows.
          const intent: RawUserIntent = {
            text: command.text,
            projectHint: command.kind === 'CREATE_TASK' ? command.project : null,
            source: 'OPERATOR_REMOTE',
            channel: update.channel,
            operatorId: identity.providerUserId,
            messageId: update.providerMessageId,
            afterCurrent: command.kind === 'ADD_TASK_AFTER_CURRENT',
          }
          const result = await actions.submitIntent(intent)
          return result.accepted ? `Task received and sent through the normal checks${result.reference ? ` (ref ${inert(result.reference, 40)})` : ''}.` : `The task was not accepted${result.reason ? `: ${inert(result.reason, 160)}` : ''}.`
        }
        case 'LATEST_TEST_RESULTS': return await this.phrase(composeChecks(await reads.getLatestChecks()), spoken)
        default: {
          const facts = await reads.getStatus()
          const template =
            command.kind === 'ETA' ? composeEta(facts)
            : command.kind === 'BLOCKERS' ? composeBlockers(facts)
            : command.kind === 'DETAILS' ? composeDetails(facts, command.subject)
            : composeStatus(facts)
          return await this.phrase(template, spoken)
        }
      }
    } catch {
      this.o.log?.(`director-line: action ${command.kind} failed`)
      return 'That did not work on the PC. Nothing more was done.'
    }
  }

  /** Template text, optionally rephrased by the injected summarizer from the facts alone. */
  private async phrase(template: string, _spoken: boolean): Promise<string> {
    if (!this.o.summarize) return template
    try {
      const out = constrainSummary(await this.o.summarize(template), template)
      return out.trim().length > 0 ? out : template
    } catch {
      return template
    }
  }

  private async reply(to: string, text: string, reportId: string): Promise<void> {
    const provider = this.o.messageProvider
    if (!provider) return
    const result = await provider.send({ providerUserId: to, text })
    await this.record(provider.kind, result.ok ? 'SENT' : 'FAILED', reportId, result)
  }

  private async record(channel: DeliveryAttempt['channel'], outcome: DeliveryOutcome, reportId: string, result?: SendResult | { providerReference: string | null; errorClass: string | null }): Promise<void> {
    await this.o.deliveries.add({ channel, at: this.now().toISOString(), outcome, providerReference: result?.providerReference ?? null, errorClass: result?.errorClass ?? null, reportId })
  }

  // ---- Outbound ----------------------------------------------------------------------------------------------

  /** The runtime raises an event. Policy decides whether, when, and how it reaches the operator. */
  async report(event: ReportEvent): Promise<void> {
    const policy = await this.getPolicy()
    const reportId = randomUUID()
    const suppress = async (): Promise<void> => this.record('LOCAL_NOTIFICATION', 'SUPPRESSED_POLICY', reportId)
    if (event.kind === 'PROGRESS') {
      if (policy.minProgressIntervalMinutes <= 0 || event.text === this.lastProgressText) return suppress()
    } else {
      const rule = policy.events[event.kind]
      if (!rule.enabled) return suppress()
      if (rule.threshold !== undefined && !event.resolved) {
        const measured = rule.thresholdUnit === 'PERCENT' ? event.slippedPercent : event.kind === 'ETA_SLIPPED' ? event.slippedMinutes : event.minutes
        if (measured === undefined || measured < rule.threshold) return suppress()
      }
    }
    const item: OutboxItem = { id: reportId, event: { ...event, text: inertBlock(event.text, MAX_REPORT_CHARS) }, createdAt: this.now().toISOString(), state: 'PENDING', callAttempts: 0, messageAttempts: 0, nextAttemptAt: null, quietNoted: false }
    await this.o.outbox.put(item)
    await this.flush()
  }

  /** Called after report() and by the runtime on a timer (about once a minute) and when connectivity returns. */
  flush(): Promise<void> {
    const run = this.chain.then(() => this.flushNow())
    this.chain = run.catch(() => undefined)
    return run
  }

  private async flushNow(): Promise<void> {
    let items = await this.o.outbox.list()
    if (items.length === 0) return
    const online = this.o.isOnline ? await this.o.isOnline() : true
    if (!online) return
    const policy = await this.getPolicy()
    const nowMs = this.now().getTime()

    // 1. Stale ones are dropped, not sent late.
    const fresh: OutboxItem[] = []
    for (const item of items) {
      const limit = item.event.kind === 'PROGRESS' ? Math.min(policy.staleAfterMinutes, Math.max(30, 2 * policy.minProgressIntervalMinutes)) : policy.staleAfterMinutes
      if (nowMs - Date.parse(item.createdAt) > limit * 60_000) {
        await this.record('LOCAL_NOTIFICATION', 'DROPPED_STALE', item.id)
        await this.o.outbox.remove(item.id)
      } else fresh.push(item)
    }
    items = fresh

    // 2. Pending notices about the same piece of work become one updated report.
    const bySubject = new Map<string, OutboxItem[]>()
    for (const item of items) bySubject.set(item.event.subjectId, [...(bySubject.get(item.event.subjectId) ?? []), item])
    let merged: OutboxItem[] = []
    for (const group of bySubject.values()) {
      if (group.length === 1) { merged.push(group[0]!); continue }
      const sorted = [...group].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      const newest = sorted[sorted.length - 1]!
      const text = inertBlock(collapseTexts(sorted), MAX_REPORT_CHARS)
      for (const old of sorted.slice(0, -1)) {
        await this.record('LOCAL_NOTIFICATION', 'COLLAPSED', old.id)
        await this.o.outbox.remove(old.id)
      }
      const combined: OutboxItem = { ...newest, event: { ...newest.event, text }, callAttempts: Math.max(...sorted.map((i) => i.callAttempts)), messageAttempts: Math.max(...sorted.map((i) => i.messageAttempts)) }
      await this.o.outbox.put(combined)
      merged.push(combined)
    }

    // 3. A pile of different subjects is one digest, never one message each.
    if (merged.length > DIGEST_ABOVE) {
      const sorted = [...merged].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      const text = inert(`While NEXUS could not reach you, ${sorted.length} things happened. ${sorted.map((i) => inert(i.event.text, 160)).join(' | ')}`, MAX_REPORT_CHARS)
      for (const old of sorted) {
        await this.record('LOCAL_NOTIFICATION', 'COLLAPSED', old.id)
        await this.o.outbox.remove(old.id)
      }
      const digest: OutboxItem = { id: randomUUID(), event: { kind: 'MORNING_OVERNIGHT_REPORT', at: this.now().toISOString(), subjectId: 'digest', text }, createdAt: this.now().toISOString(), state: 'PENDING', callAttempts: 0, messageAttempts: 0, nextAttemptAt: null, quietNoted: false }
      await this.o.outbox.put(digest)
      merged = [digest]
    }

    // 4. Quiet hours, rate limits, then delivery.
    const quiet = inQuietHours(policy.quietHours, this.now())
    for (const item of merged) {
      const critical = CRITICAL_KINDS.includes(item.event.kind)
      if (quiet && !(critical && policy.quietHours.criticalBreaksQuiet)) {
        if (!item.quietNoted) {
          item.quietNoted = true
          await this.o.outbox.put(item)
          await this.record('LOCAL_NOTIFICATION', 'SUPPRESSED_QUIET_HOURS', item.id)
        }
        continue
      }
      if (item.nextAttemptAt && Date.parse(item.nextAttemptAt) > nowMs) continue
      const rateKey = `${item.event.kind}:${item.event.subjectId}:${item.event.resolved === true}`
      const lastMs = this.lastSent.get(rateKey)
      if (lastMs !== undefined && nowMs - lastMs < kindIntervalMinutes(item.event.kind, policy) * 60_000) {
        await this.record('LOCAL_NOTIFICATION', 'SUPPRESSED_POLICY', item.id)
        await this.o.outbox.remove(item.id)
        continue
      }
      if (await this.deliver(item, policy)) {
        this.lastSent.set(rateKey, nowMs)
        if (item.event.kind === 'PROGRESS') this.lastProgressText = item.event.text
      }
    }
  }

  /** Walks the precedence. Returns true when the report reached the operator (or the PC). A retryable failure keeps the item. */
  private async deliver(item: OutboxItem, policy: CommunicationPolicy): Promise<boolean> {
    const { event } = item
    const text = `NEXUS: ${event.text}`
    for (const cls of policy.precedence) {
      if (cls === 'PHONE') {
        const callWorthy = event.kind !== 'PROGRESS' && policy.events[event.kind].call && (!event.resolved || event.kind === 'PROGRAM_COMPLETE')
        if (!callWorthy || item.callAttempts >= policy.maxCallAttempts || !this.o.voiceProvider) continue
        const health = await this.o.voiceProvider.health()
        const number = (await this.o.pairing.listPaired()).find((i) => i.channel === 'TWILIO_VOICE')
        if (health.status === 'UNCONFIGURED' || !number) { await this.record('TWILIO_VOICE', 'NOT_CONFIGURED', item.id); continue }
        // Counted and stored BEFORE dialling: a crash during the call must not lead to a second call.
        item.callAttempts += 1
        await this.o.outbox.put(item)
        const call = await this.o.voiceProvider.placeCall({ to: number.providerUserId, spokenText: inert(event.text, 400) })
        const answered = call.finalState === 'ANSWERED' || call.finalState === 'COMPLETED'
        await this.record('TWILIO_VOICE', answered ? 'ANSWERED' : call.finalState === 'NO_ANSWER' ? 'NO_ANSWER' : call.finalState === 'BUSY' ? 'BUSY' : 'FAILED', item.id, { providerReference: call.providerCallId, errorClass: call.errorClass })
        if (answered) { await this.o.outbox.remove(item.id); return true }
        continue
      }
      if (cls === 'MESSAGE') {
        const provider = this.o.messageProvider
        const target = provider ? (await this.o.pairing.listPaired()).find((i) => i.channel === provider.kind) : undefined
        if (!provider || !target) { await this.record('TELEGRAM', 'NOT_CONFIGURED', item.id); continue }
        const result = await provider.send({ providerUserId: target.providerUserId, text })
        if (result.ok) { await this.record(provider.kind, 'SENT', item.id, result); await this.o.outbox.remove(item.id); return true }
        await this.record(provider.kind, 'FAILED', item.id, result)
        item.messageAttempts += 1
        if (result.retryable && item.messageAttempts < MAX_MESSAGE_ATTEMPTS) {
          item.nextAttemptAt = new Date(this.now().getTime() + Math.min(60, 2 ** item.messageAttempts) * 60_000).toISOString()
          await this.o.outbox.put(item)
          return false
        }
        continue
      }
      if (this.o.localNotify) {
        await this.o.localNotify('NEXUS', inert(event.text, 400))
        await this.record('LOCAL_NOTIFICATION', 'SENT', item.id)
        await this.o.outbox.remove(item.id)
        return true
      }
    }
    await this.o.outbox.remove(item.id)
    return false
  }

  // ---- Settings actions (the runtime puts the native confirmation in front of the ones that need it) -------------

  async sendTestMessage(): Promise<SendResult> {
    const provider = this.o.messageProvider
    const target = provider ? (await this.o.pairing.listPaired()).find((i) => i.channel === provider.kind) : undefined
    if (!provider || !target) return { ok: false, providerReference: null, errorClass: 'NOT_CONFIGURED', retryable: false }
    const result = await provider.send({ providerUserId: target.providerUserId, text: 'NEXUS: this is a test message. Nothing needs your attention.' })
    await this.record(provider.kind, result.ok ? 'SENT' : 'FAILED', 'test-message', result)
    return result
  }

  async testCall(): Promise<{ ok: boolean; errorClass: string | null }> {
    const voice = this.o.voiceProvider
    const number = (await this.o.pairing.listPaired()).find((i) => i.channel === 'TWILIO_VOICE')
    if (!voice || !number || (await voice.health()).status === 'UNCONFIGURED') return { ok: false, errorClass: 'NOT_CONFIGURED' }
    const call = await voice.placeCall({ to: number.providerUserId, spokenText: 'This is a test call from NEXUS. Nothing needs your attention.' })
    await this.record('TWILIO_VOICE', call.ok ? 'ANSWERED' : 'FAILED', 'test-call', { providerReference: call.providerCallId, errorClass: call.errorClass })
    return { ok: call.ok, errorClass: call.errorClass }
  }

  async lastDelivery(): Promise<DeliveryAttempt | null> {
    return this.o.deliveries.last()
  }
}
