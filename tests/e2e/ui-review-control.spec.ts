/// <reference lib="dom" />
import { join } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import type { ConnectionState } from '../../src/shared/runtime-protocol'
import { IPC_INVOKE_CHANNEL, IPC_PUSH_CHANNEL } from '../../src/shared/ipc-channels'
import { closeApp, createRepo, invoke, killRuntime, launchApp, REPO_ROOT, tempDir } from './helpers'

/**
 * Screenshot capture of the 0.7 surfaces for an independent UI review
 * (`NEXUS_UI_REVIEW=1 npx playwright test tests/e2e/ui-review-control.spec.ts`). Not an assertion suite.
 *
 * Every state is produced deterministically: a wrapper around the window's main-process invoke handler answers
 * `control.overview`, `control.decisions`, `runtime.status`, `runtime.workers`, `security.decisions` and (for the
 * startup screen) `desktop.connection` from fixtures, and connection changes are sent to the window as the same
 * `nexus:push` message the app receives from the runtime client. Nothing here changes what the app does with them.
 * Only the final disconnected capture is real: the runtime process is killed with `killRuntime`.
 * (`NEXUS_FAKE_WORKERS` is not used: the fixtures guarantee a RUNNING and a FAILED worker, which a real run cannot.)
 *
 * Output: `test-results/ui-review/control-<theme>-<size>-<state>.png` and `control-notes.json`.
 */
const OUT = join(REPO_ROOT, 'test-results', 'ui-review')
const SIZES = [
  { name: 'wide', width: 1440, height: 900 },
  { name: 'narrow', width: 1024, height: 700 },
  { name: '1100', width: 1100, height: 700 },
] as const
type Size = (typeof SIZES)[number]
type Theme = 'light' | 'dark'

interface FocusInfo {
  testid: string | null
  text: string
  tag: string | null
}
interface Notes {
  dialogs: {
    name: string
    theme: Theme
    size: string
    trigger: string | null
    openFocus: FocusInfo
    closeFocus: FocusInfo
    focusReturnedToTrigger: boolean
  }[]
  disconnected: { theme: Theme; size: string; source: string; contentInert: boolean; contentDataStale: string | null; bannerFocusable: boolean }[]
  colors: Record<string, Record<string, { color: string; background: string }>>
  notReached: string[]
}
const notes: Notes = { dialogs: [], disconnected: [], colors: { light: {}, dark: {} }, notReached: [] }

async function resize(app: ElectronApplication, width: number, height: number): Promise<void> {
  await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]?.setContentSize(size.width, size.height), { width, height })
}

async function setTheme(page: Page, theme: Theme): Promise<void> {
  const settings = await invoke(page, 'settings.get', {})
  await invoke(page, 'settings.update', { settings: { ...settings, appearance: { ...settings.appearance, theme } } })
  await page.reload()
  await expect(page.getByTestId('app-shell')).toBeVisible()
}

async function shot(page: Page, name: string): Promise<void> {
  mkdirSync(OUT, { recursive: true })
  await page.mouse.move(0, 0)
  await page.waitForTimeout(300)
  await page.screenshot({ path: join(OUT, `${name}.png`) })
}

// ───────────────────────────── fixtures (answered in the main process) ─────────────────────────────

interface Fixture {
  /** `seed`: fixtures; `fail`: control.overview fails; `off`: everything passes through. */
  mode: 'seed' | 'fail' | 'off'
  paused: boolean
  claudeAvailable: boolean
  securityEmpty: boolean
  /** Answer for `desktop.connection`; null passes through. */
  connection: ConnectionState | null
}

async function installFixtures(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain }, channel) => {
    type Reply = { ok: boolean; value?: unknown; error?: { code: string; message: string } }
    type Handler = (event: unknown, channel: string, input: unknown) => Promise<Reply> | Reply
    type Rec = Record<string, unknown>
    const g = globalThis as unknown as { __ui?: Fixture }
    if (g.__ui) return
    g.__ui = { mode: 'seed', paused: false, claudeAvailable: true, securityEmpty: false, connection: null }
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers
    const original = handlers.get(channel)
    if (!original) throw new Error('No invoke handler to wrap')
    const ago = (minutes: number): string => new Date(Date.now() - minutes * 60_000).toISOString()
    const ahead = (minutes: number): string => new Date(Date.now() + minutes * 60_000).toISOString()
    const item = (o: Rec): Rec => ({
      refId: null, priority: 'P2', position: 1, requestedAgents: 2, deadlineAt: null, notBefore: null, scheduleId: null, heldByUser: false,
      payload: null, detail: null, createdAt: ago(30), updatedAt: ago(1), startedAt: null, finishedAt: null, ...o,
    })
    const ok = (value: unknown): Reply => ({ ok: true, value })

    const decisions: Record<string, { decision: string; reason: string; minutes: number }[]> = {
      'ui-q1': [
        { decision: 'wait_for_capacity', reason: 'All 6 agents are in use or reserved; the next free session goes to this item first (P0).', minutes: 1 },
        { decision: 'aging_raised_priority', reason: 'Waited 95 minutes with an aging step of 30: served as P0 instead of P1.', minutes: 12 },
        { decision: 'queued', reason: 'Put on the queue by you at P1.', minutes: 95 },
      ],
      'ui-blocked': [
        { decision: 'blocked', reason: 'The workload reported a block: Milestone 2 could not start.', minutes: 8 },
        { decision: 'granted', reason: '2 agents granted of 2 requested.', minutes: 540 },
        { decision: 'started', reason: 'A workload slot and 2 agent sessions were free.', minutes: 600 },
      ],
      'ui-run': [
        { decision: 'granted', reason: '4 agents granted of 4 requested; 3 are running.', minutes: 3 },
        { decision: 'started', reason: 'Started because it was first in queue order and capacity was free.', minutes: 42 },
      ],
    }

    const overview = (base: Rec): Rec => {
      const ui = g.__ui as Fixture
      const waitReason = (text: string): string => (ui.paused ? 'Dispatch is paused by you. Nothing new starts.' : text)
      const blocked = item({ id: 'ui-blocked', type: 'program', refId: 'prog-9', title: 'Release train 2.4', priority: 'P1', position: 5, state: 'BLOCKED', startedAt: ago(600), detail: 'Milestone 2 could not start: repository acme/web has uncommitted changes.' })
      return {
        ...base,
        agents: { active: 3, max: 6 },
        claudeAvailable: ui.claudeAvailable,
        dispatchPaused: ui.paused,
        workers: { live: 4, busy: 3, max: 6 },
        active: [
          { ...item({ id: 'ui-run', type: 'program', refId: 'prog-1', title: 'Billing rework', priority: 'P1', state: 'RUNNING', requestedAgents: 4, startedAt: ago(42), scheduleId: 'ui-schedule' }), activeAgents: 3, allowance: 4 },
          { ...item({ id: 'ui-start', type: 'mission', refId: 'run-1', title: 'Add an API module and a UI module, then integrate them', state: 'RUNNING', startedAt: ago(0.1) }), activeAgents: 0, allowance: 2 },
          { ...item({ id: 'ui-quota', type: 'arena', refId: 'camp-1', title: 'Nightly regression campaign', state: 'QUOTA_WAIT', startedAt: ago(300), detail: 'Paused (quota).' }), activeAgents: 0, allowance: 0 },
        ],
        waiting: [
          { ...item({ id: 'ui-q1', type: 'workspace_mission', refId: 'wm-1', title: 'Migrate the auth service across three repositories', priority: 'P0', position: 1, state: 'QUEUED', createdAt: ago(95), requestedAgents: 3 }), reason: waitReason('Waiting for agent capacity (6 agents in use or reserved).') },
          { ...item({ id: 'ui-q2', type: 'program', refId: 'prog-2', title: 'Docs refresh', priority: 'P2', position: 2, state: 'QUEUED', scheduleId: 'ui-schedule', createdAt: ago(20) }), reason: waitReason('Waiting for a workload slot (4 run at once).') },
          { ...item({ id: 'ui-q3', type: 'scheduled_audit', title: 'Dependency audit of nexus-web', priority: 'P3', position: 3, state: 'QUEUED', createdAt: ago(5), requestedAgents: 1, payload: { projectId: 'p', kind: 'dependency_audit' } }), reason: waitReason('Waiting behind higher-priority work (1 P0 and 1 P1 item are ahead of it).') },
          { ...item({ id: 'ui-held', type: 'program', refId: 'prog-3', title: 'Performance baseline', priority: 'P2', position: 4, state: 'PAUSED', heldByUser: true }), reason: 'Held by you.' },
          { ...blocked, reason: blocked['detail'] },
        ],
        scheduled: [item({ id: 'ui-sched', type: 'scheduled_audit', title: 'Architecture audit of nexus-api', priority: 'P3', state: 'SCHEDULED', notBefore: ahead(60 * 9), scheduleId: 'ui-schedule', payload: { projectId: 'p', kind: 'architecture_audit' } })],
        finished: [
          item({ id: 'ui-failed', type: 'scheduled_audit', title: 'Dependency audit of nexus-api', state: 'FAILED', startedAt: ago(40), finishedAt: ago(12), detail: 'The analysis run crashed: out of memory in the parser.' }),
          item({ id: 'ui-done', type: 'program', refId: 'prog-0', title: 'Modules program', state: 'COMPLETED', startedAt: ago(300), finishedAt: ago(120) }),
          item({ id: 'ui-cancelled', type: 'mission', refId: 'run-0', title: 'Try the experimental parser', state: 'CANCELLED', startedAt: ago(500), finishedAt: ago(450), detail: 'Cancelled by the user.' }),
        ],
        schedules: [{ id: 'ui-schedule', name: 'Continue at night', rule: { kind: 'daily', time: '22:00' }, action: { type: 'program', programId: 'prog-1' }, priority: 'P2', enabled: true, nextRunAt: ahead(60 * 9), lastRunAt: ago(60 * 15), lastResult: 'Queued "Docs refresh".', createdAt: ago(60 * 70), updatedAt: ago(60 * 15) }],
        incidents: [
          { at: ago(8), summary: 'Release train 2.4 is blocked: Milestone 2 could not start.', itemId: 'ui-blocked' },
          { at: ago(12), summary: 'Dependency audit of nexus-api failed: out of memory in the parser.', itemId: 'ui-failed' },
          { at: ago(60 * 15), summary: 'Schedule "Continue at night" queued Docs refresh.', itemId: 'ui-q2' },
          { at: ago(60 * 20), summary: 'NEXUS started; 5 open work items read from the queue.', itemId: null },
        ],
      }
    }

    const worker = (o: Rec): Rec => ({ bootId: 'boot-ui', pid: null, state: 'IDLE', startedAt: ago(42), heartbeatAt: ago(0.05), stoppedAt: null, exitCode: null, error: null, assignments: 0, capabilities: ['claude'], assignment: null, ...o })
    const assignment = (n: string, extra: Rec = {}): Rec => ({ leaseId: `lease-${n}`, agentId: `agent-91be34f${n}`, runId: 'run-5c20aa91', taskId: `task-7d11e0b${n}`, provider: 'claude', sessionId: `sess-3e8f12ab7${n}`, worktree: `C:\\Users\\dev\\AppData\\Local\\NEXUS\\worktrees\\billing-rework\\task-7d11e0b${n}`, assignedAt: ago(9), ...extra })
    const workersOverview = (): Rec => ({
      enabled: true,
      limits: { maxWorkers: 6 },
      counts: { live: 4, busy: 3, idle: 1, waitingAssignments: 2 },
      workers: [
        worker({ id: 'wrk-7f3a91c2d4', pid: 18240, state: 'RUNNING', assignments: 6, assignment: assignment('1') }),
        worker({ id: 'wrk-a02be7710c', pid: 18244, state: 'RUNNING', assignments: 4, heartbeatAt: ago(2), assignment: assignment('2') }),
        worker({ id: 'wrk-c9d1e5f3b8', pid: 18252, state: 'ASSIGNED', assignments: 1, assignment: assignment('3') }),
        worker({ id: 'wrk-1b44d90ee2', pid: 18260, state: 'IDLE', assignments: 7 }),
        worker({ id: 'wrk-e5a7730f19', pid: 18101, state: 'FAILED', startedAt: ago(70), stoppedAt: ago(14), exitCode: 3221225477, error: 'The worker process exited with code 3221225477.', assignments: 2 }),
        worker({ id: 'wrk-39cc8d2a60', pid: 18077, state: 'STOPPED', startedAt: ago(120), stoppedAt: ago(90), assignments: 9 }),
      ],
      leases: [
        { id: 'lease-1', workerId: 'wrk-7f3a91c2d4', bootId: 'boot-ui', agentId: 'agent-91be34f1', runId: 'run-5c20aa91', taskId: 'task-7d11e0b1', provider: 'claude', state: 'ACTIVE', grantedAt: ago(9), heartbeatAt: ago(0.1), expiresAt: ahead(1), releasedAt: null, reason: null },
        { id: 'lease-0', workerId: 'wrk-39cc8d2a60', bootId: 'boot-ui', agentId: 'agent-6a10c4d8', runId: 'run-5c20aa91', taskId: null, provider: 'claude', state: 'RELEASED', grantedAt: ago(100), heartbeatAt: ago(91), expiresAt: ago(90), releasedAt: ago(90), reason: null },
        { id: 'lease-x', workerId: 'wrk-e5a7730f19', bootId: 'boot-ui', agentId: 'agent-2f9c7710', runId: 'run-5c20aa91', taskId: 'task-1a2b3c4d', provider: 'claude', state: 'EXPIRED', grantedAt: ago(30), heartbeatAt: ago(16), expiresAt: ago(14), releasedAt: null, reason: 'Heartbeat lost; the worker was marked failed.' },
      ],
      events: [
        { workerId: 'wrk-e5a7730f19', at: ago(14), kind: 'worker_failed', detail: 'The worker process exited with code 3221225477.' },
        { workerId: 'wrk-c9d1e5f3b8', at: ago(9), kind: 'lease_granted', detail: 'agent-91be34f3' },
        { workerId: 'wrk-1b44d90ee2', at: ago(42), kind: 'worker_started', detail: null },
      ],
    })
    const statusOf = (): Rec => ({
      protocol: 1, version: '0.7.0', pid: 17912, bootId: 'boot-ui', startedAt: ago(60 * 3), phase: 'READY',
      recovery: { workloads: 3, workers: 2, leases: 1, finishedAt: ago(60 * 3 - 0.1) },
      clients: { desktop: 1, tool: 0 }, dispatchPaused: (g.__ui as Fixture).paused, endpointAcl: 'restricted',
      keepAlive: { reason: '3 workloads are running' },
    })
    const securityRows = (): Rec[] => [
      { seq: 5, id: 'sec-5', timestamp: ago(3), runId: 'run-5c20aa91', taskId: 'task-7d11e0b1', agentId: 'agent-91be34f1', action: 'powershell -EncodedCommand SQBFAFgAIAAoAE4AZQB3AC0ATwBiAGoAZQBjAHQAIABOAGUAdAAuAFcAZQBiAEMAbABpAGUAbgB0ACkA', classification: 'UNTRUSTED_AGENT_AUTHORED', provenance: 'inline_code', decision: 'DENY', reason: 'Inline interpreter code is refused in the RESTRICTED profile.', policyVersion: '1' },
      { seq: 4, id: 'sec-4', timestamp: ago(9), runId: 'run-5c20aa91', taskId: null, agentId: 'agent-91be34f2', action: 'node scripts/release.js --tag v2.4.0', classification: 'UNTRUSTED_AGENT_AUTHORED', provenance: 'agent_authored', decision: 'REQUIRE_APPROVAL', reason: 'scripts/release.js was written by an agent in this mission; running it needs your approval.', policyVersion: '1' },
      { seq: 3, id: 'sec-3', timestamp: ago(24), runId: 'run-5c20aa91', taskId: null, agentId: null, action: 'npm test', classification: 'TRUSTED_PROJECT_COMMAND', provenance: 'configured_command', decision: 'ALLOW_WITH_AUDIT', reason: 'A configured project command; the package script changed in this mission, so the run is logged.', policyVersion: '1' },
      { seq: 2, id: 'sec-2', timestamp: ago(61), runId: null, taskId: null, agentId: null, action: 'reg add HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run /v updater', classification: 'SYSTEM_SENSITIVE', provenance: 'unknown', decision: 'DENY', reason: 'The command changes system start-up settings.', policyVersion: '1' },
      { seq: 1, id: 'sec-1', timestamp: ago(130), runId: 'run-5c20aa91', taskId: null, agentId: 'agent-6a10c4d8', action: 'pnpm install left-pad', classification: 'UNTRUSTED_REPOSITORY_CODE', provenance: 'repository_unmodified', decision: 'REQUIRE_APPROVAL', reason: 'Installs always ask.', policyVersion: '1' },
    ]

    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, async (event, name: string, input: unknown) => {
      const ui = g.__ui as Fixture
      if (ui.mode === 'off') return original(event, name, input)
      if (name === 'desktop.connection' && ui.connection) return ok(ui.connection)
      if (name === 'control.overview') {
        if (ui.mode === 'fail') return { ok: false, error: { code: 'internal', message: 'The queue database is locked (SQLITE_BUSY).' } }
        const reply = await original(event, name, input)
        return reply.ok ? ok(overview(reply.value as Rec)) : reply
      }
      if (name === 'control.decisions') {
        const id = (input as { itemId?: string } | undefined)?.itemId ?? ''
        return ok((decisions[id] ?? []).map((d) => ({ at: ago(d.minutes), itemId: id, decision: d.decision, reason: d.reason })))
      }
      if (name === 'runtime.status') return ok(statusOf())
      if (name === 'runtime.workers') return ok(workersOverview())
      if (name === 'security.decisions') return ok({ decisions: ui.securityEmpty ? [] : securityRows(), nextBefore: null })
      return original(event, name, input)
    })
  }, IPC_INVOKE_CHANNEL)
}

async function fixture(app: ElectronApplication, patch: Partial<Fixture>): Promise<void> {
  await app.evaluate((_, p) => Object.assign((globalThis as unknown as { __ui: Fixture }).__ui, p), patch)
}

/** Sends the window what the runtime client sends it: a push message. */
async function push(app: ElectronApplication, message: unknown): Promise<void> {
  await app.evaluate(({ BrowserWindow }, m) => BrowserWindow.getAllWindows()[0]?.webContents.send(m.channel, m.message), { channel: IPC_PUSH_CHANNEL, message })
}

const connection = (phase: ConnectionState['phase'], detail: string, over: Partial<ConnectionState> = {}): ConnectionState => ({
  phase,
  detail,
  runtime: { protocol: 1, version: '0.7.0', pid: 17912, bootId: 'boot-ui', startedAt: new Date(Date.now() - 3 * 3600_000).toISOString() },
  attempt: 0,
  since: new Date(Date.now() - 20_000).toISOString(),
  ...over,
})

// ───────────────────────────── page helpers ─────────────────────────────

async function focusOf(page: Page): Promise<FocusInfo> {
  return page.evaluate(() => {
    const a = document.activeElement as HTMLElement | null
    return { testid: a?.getAttribute('data-testid') ?? null, text: (a?.innerText ?? a?.textContent ?? '').trim().slice(0, 80), tag: a?.tagName ?? null }
  })
}

async function scrollToTop(page: Page): Promise<void> {
  await page.getByTestId('control-page').evaluate((el) => el.querySelector('.overflow-auto')?.scrollTo(0, 0))
}

async function bring(page: Page, testId: string): Promise<void> {
  const target = page.getByTestId(testId).first()
  await expect(target).toBeVisible()
  await target.evaluate((el) => el.scrollIntoView({ block: 'start' }))
}

async function openControl(page: Page): Promise<void> {
  await page.getByTestId('nav-control').click()
  await expect(page.getByTestId('work-item-ui-run')).toBeVisible()
  await scrollToTop(page)
}

/** Leaves and re-enters the page so row and form state (errors, open fields) starts clean. */
async function reopenControl(page: Page): Promise<void> {
  await page.getByTestId('nav-home').click()
  await openControl(page)
}

async function colorsOf(page: Page, testId: string): Promise<{ color: string; background: string }> {
  return colorsOfLocator(page.getByTestId(testId))
}

async function colorsOfLocator(locator: Locator): Promise<{ color: string; background: string }> {
  return locator.first().evaluate((el) => {
    let background = 'rgba(0, 0, 0, 0)'
    for (let n: Element | null = el; n; n = n.parentElement) {
      const c = getComputedStyle(n).backgroundColor
      if (c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent') {
        background = c
        break
      }
    }
    return { color: getComputedStyle(el).color, background }
  })
}

/** Opens a dialog or drawer, captures it, closes it with Escape and records where focus was at both moments. */
async function dialogShot(page: Page, theme: Theme, size: string, name: string, trigger: Locator, dialog: Locator, shotName: string): Promise<void> {
  const triggerId = await trigger.first().getAttribute('data-testid')
  await trigger.first().click()
  await expect(dialog).toBeVisible()
  const openFocus = await focusOf(page)
  await shot(page, shotName)
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  const closeFocus = await focusOf(page)
  notes.dialogs.push({ name, theme, size, trigger: triggerId, openFocus, closeFocus, focusReturnedToTrigger: triggerId !== null && closeFocus.testid === triggerId })
}

// ───────────────────────────── the capture ─────────────────────────────

async function capture(app: ElectronApplication, page: Page, theme: Theme, size: Size): Promise<void> {
  const base = `control-${theme}-${size.name}`
  const name = (state: string): string => `${base}-${state}`
  await resize(app, size.width, size.height)
  await fixture(app, { mode: 'seed', paused: false, claudeAvailable: true, securityEmpty: false, connection: null })
  await page.reload()
  await expect(page.getByTestId('app-shell')).toBeVisible()
  await openControl(page)

  // 1. The queue: top (health strip, attention), active, waiting, schedules, finished.
  await shot(page, name('queue-top'))
  if (size.name === '1100') {
    await bring(page, 'control-waiting')
    await shot(page, name('queue-waiting'))
    return
  }
  await bring(page, 'control-active')
  await shot(page, name('queue-active'))
  await bring(page, 'control-waiting')
  await shot(page, name('queue-waiting'))
  await bring(page, 'control-schedules')
  await shot(page, name('queue-schedules'))
  await bring(page, 'control-finished')
  await shot(page, name('queue-finished'))

  // Colours for the contrast review, once per theme at the wide size where everything is on screen.
  if (size.name === 'wide') {
    const c = notes.colors[theme] ?? {}
    notes.colors[theme] = c
    await bring(page, 'control-attention')
    c['blocked-badge'] = await colorsOf(page, 'work-item-badge-ui-blocked')
    c['blocked-reason'] = await colorsOf(page, 'work-item-reason-ui-blocked')
    await bring(page, 'control-finished')
    c['failed-row'] = await colorsOf(page, 'finished-ui-failed')
    c['failed-reason'] = await colorsOf(page, 'finished-reason-ui-failed')
    await bring(page, 'control-waiting')
    c['waiting-reason-line'] = await colorsOf(page, 'work-item-line-ui-q1')
    c['primary-button'] = await colorsOf(page, 'control-enqueue-submit')
  }

  // 2. Needs attention close-up, and the inspector on a waiting and on a blocked item.
  await bring(page, 'control-attention')
  await shot(page, name('attention'))
  await scrollToTop(page)
  await bring(page, 'work-item-ui-q1')
  await dialogShot(page, theme, size.name, 'inspector (waiting item, scheduler decisions)', page.getByTestId('work-item-open-ui-q1'), page.getByTestId('work-item-inspector'), name('inspector-waiting'))
  await bring(page, 'control-attention')
  await dialogShot(page, theme, size.name, 'inspector (blocked item)', page.getByTestId('work-item-open-ui-blocked'), page.getByTestId('work-item-inspector'), name('inspector-blocked'))

  // 3. Cancel confirmation for a running workload; delete-schedule confirmation.
  await bring(page, 'control-active')
  await dialogShot(page, theme, size.name, 'cancel a running workload', page.getByTestId('work-item-cancel-ui-run'), page.getByTestId('cancel-dialog-ui-run'), name('dialog-cancel'))
  if (size.name === 'wide') {
    await page.getByTestId('work-item-cancel-ui-run').click()
    const c = notes.colors[theme] ?? {}
    c['dialog-destructive-button'] = await colorsOf(page, 'confirm-dialog-confirm')
    c['dialog-keep-button'] = await colorsOfLocator(page.getByTestId('cancel-dialog-ui-run').getByRole('button', { name: 'Keep it running' }))
    await page.keyboard.press('Escape')
  }
  await bring(page, 'control-schedules')
  await dialogShot(page, theme, size.name, 'delete a schedule', page.getByTestId('schedule-remove-ui-schedule'), page.getByTestId('schedule-delete-dialog'), name('dialog-delete-schedule'))

  // The lighter path: a never-started item is removed without a question. The click is real, so the item's own
  // error shows next to the action (the fixture item does not exist in the queue), and the page stays usable.
  await bring(page, 'control-waiting')
  await page.getByTestId('work-item-cancel-ui-q3').click()
  await page.waitForTimeout(400)
  await expect(page.locator('[data-testid^="cancel-dialog-"]')).toHaveCount(0)
  await shot(page, name('remove-no-dialog'))
  await reopenControl(page)

  // 5. Dispatch paused.
  await fixture(app, { paused: true })
  await push(app, { kind: 'control' })
  await expect(page.getByTestId('control-dispatch-paused')).toBeVisible()
  await scrollToTop(page)
  await shot(page, name('dispatch-paused'))
  await bring(page, 'control-waiting')
  await shot(page, name('dispatch-paused-queue'))
  await fixture(app, { paused: false })
  await push(app, { kind: 'control' })
  await expect(page.getByTestId('control-dispatch-paused')).toHaveCount(0)

  // Claude waiting for the usage limit.
  await fixture(app, { claudeAvailable: false })
  await push(app, { kind: 'control' })
  await expect(page.getByTestId('control-quota-notice')).toBeVisible()
  await scrollToTop(page)
  await shot(page, name('claude-waiting'))
  await fixture(app, { claudeAvailable: true })
  await push(app, { kind: 'control' })
  await expect(page.getByTestId('control-quota-notice')).toHaveCount(0)

  // 8. Security decisions, then the empty panel.
  await bring(page, 'security-decisions')
  await expect(page.getByTestId('security-decisions')).toContainText('Refused')
  await shot(page, name('security-decisions'))

  // 6. Runtime diagnostics.
  await page.getByTestId('runtime-diagnostics-toggle').click()
  await expect(page.getByTestId('workers-table')).toBeVisible()
  await bring(page, 'runtime-diagnostics')
  await shot(page, name('diagnostics-identity'))
  await bring(page, 'workers-table')
  await shot(page, name('diagnostics-workers'))
  await bring(page, 'leases-table')
  await shot(page, name('diagnostics-leases-events'))
  await dialogShot(page, theme, size.name, 'stop the NEXUS runtime', page.getByTestId('runtime-shutdown'), page.getByTestId('runtime-shutdown-dialog'), name('dialog-stop-runtime'))

  // 7. Connection states, sent as the runtime client sends them.
  await scrollToTop(page)
  await push(app, { kind: 'connection', state: connection('RECOVERING', 'Recovering 3 workloads; reconciling 2 workers', { runtime: null }) })
  await expect(page.getByTestId('connection-banner')).toHaveAttribute('data-phase', 'RECOVERING')
  await shot(page, name('connection-recovering'))
  await push(app, { kind: 'connection', state: connection('DISCONNECTED', 'The runtime closed the connection.', { attempt: 3 }) })
  await expect(page.getByTestId('connection-banner')).toHaveAttribute('data-phase', 'DISCONNECTED')
  await expect(page.getByTestId('connection-content')).toHaveAttribute('data-stale', 'true')
  await shot(page, name('connection-disconnected'))
  notes.disconnected.push({
    theme,
    size: size.name,
    source: 'pushed connection state',
    contentInert: await page.getByTestId('connection-content').evaluate((el) => el.hasAttribute('inert')),
    contentDataStale: await page.getByTestId('connection-content').getAttribute('data-stale'),
    bannerFocusable: await page.getByTestId('connection-retry').evaluate((el) => !el.closest('[inert]')),
  })
  if (size.name === 'wide') {
    const c = notes.colors[theme] ?? {}
    c['disconnected-banner'] = await colorsOf(page, 'connection-banner')
    c['disconnected-title'] = await colorsOf(page, 'connection-title')
    c['disconnected-detail'] = await colorsOf(page, 'connection-detail')
    c['primary-button-retry'] = await colorsOf(page, 'connection-retry')
  }
  await page.getByTestId('connection-diagnostics').click()
  await expect(page.getByTestId('connection-diagnostics-panel')).toBeVisible()
  await shot(page, name('connection-diagnostics'))
  await push(app, { kind: 'connection', state: connection('INCOMPATIBLE', 'The runtime speaks protocol 2; this window speaks protocol 1. Update NEXUS so both match.') })
  await expect(page.getByTestId('connection-banner')).toHaveAttribute('data-phase', 'INCOMPATIBLE')
  await shot(page, name('connection-incompatible'))
  await push(app, { kind: 'connection', state: connection('READY', 'Connected.') })
  await expect(page.getByTestId('connection-banner')).toHaveCount(0)

  // Startup: the window is reloaded while `desktop.connection` answers a starting runtime, so the state is the
  // one a freshly opened window shows before its first READY.
  for (const [phase, detail] of [
    ['STARTING_RUNTIME', 'Starting the runtime process.'],
    ['CONNECTING', 'Waiting for the runtime to accept the connection.'],
  ] as const) {
    await fixture(app, { connection: connection(phase, detail, { runtime: null }) })
    await page.reload()
    await expect(page.getByTestId('startup-state')).toHaveAttribute('data-phase', phase)
    await shot(page, name(`startup-${phase === 'STARTING_RUNTIME' ? 'starting-runtime' : 'connecting'}`))
  }
  await fixture(app, { connection: null })

  // 4. Failed load with Retry; then a failed refresh with the data kept.
  await fixture(app, { mode: 'fail' })
  await page.reload()
  await expect(page.getByTestId('app-shell')).toBeVisible()
  await page.getByTestId('nav-control').click()
  await expect(page.getByTestId('control-load-error')).toBeVisible()
  await shot(page, name('load-error'))
  await fixture(app, { mode: 'seed' })
  await page.getByTestId('control-retry').click()
  await expect(page.getByTestId('work-item-ui-run')).toBeVisible()
  await fixture(app, { mode: 'fail' })
  await push(app, { kind: 'control' })
  await expect(page.getByTestId('control-stale')).toBeVisible()
  await scrollToTop(page)
  await shot(page, name('refresh-failed-data-kept'))
  await fixture(app, { mode: 'seed' })

  // 8 (continued). The empty security panel.
  await fixture(app, { securityEmpty: true })
  await page.reload()
  await openControl(page)
  await bring(page, 'security-decisions')
  await shot(page, name('security-empty'))
  await fixture(app, { securityEmpty: false })

  // 9. Settings, Execution: the profile control in both values.
  await page.getByTestId('nav-settings').click()
  await page.getByTestId('settings-section-execution').click()
  await expect(page.getByTestId('exec-profile')).toBeVisible()
  await page.getByTestId('exec-profile').selectOption('STANDARD')
  await shot(page, name('settings-execution-standard'))
  await page.getByTestId('exec-profile').selectOption('RESTRICTED')
  await shot(page, name('settings-execution-restricted'))
  const revert = page.getByTestId('settings-revert')
  if (await revert.isEnabled()) await revert.click()
}

/** 10. Keyboard evidence: a focused row action, a dialog right after opening, and focus after Escape. Light theme, wide. */
async function captureFocus(app: ElectronApplication, page: Page): Promise<void> {
  await resize(app, 1440, 900)
  await fixture(app, { mode: 'seed', paused: false, claudeAvailable: true, connection: null })
  await page.reload()
  await openControl(page)
  const prefix = 'control-light-wide-focus'
  // Tab into the queue from the title button of a waiting item until the Hold button has focus.
  await bring(page, 'work-item-ui-q2')
  await page.getByTestId('work-item-open-ui-q2').focus()
  await page.keyboard.press('Shift+Tab')
  await page.keyboard.press('Tab')
  for (let i = 0; i < 8; i++) {
    if ((await focusOf(page)).testid === 'work-item-pause-ui-q2') break
    await page.keyboard.press('Tab')
  }
  await shot(page, `${prefix}-queue-row-action`)
  const rowFocus = await focusOf(page)
  notes.dialogs.push({ name: 'focus: Tab into the queue (no dialog)', theme: 'light', size: 'wide', trigger: null, openFocus: rowFocus, closeFocus: rowFocus, focusReturnedToTrigger: true })

  // A dialog opened by the keyboard: focus lands on the safe button; Escape returns it to the trigger.
  await bring(page, 'work-item-ui-run')
  const cancel = page.getByTestId('work-item-cancel-ui-run')
  await cancel.focus()
  await page.keyboard.press('Shift+Tab')
  await page.keyboard.press('Tab')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('cancel-dialog-ui-run')).toBeVisible()
  const openFocus = await focusOf(page)
  await shot(page, `${prefix}-dialog-open`)
  await page.keyboard.press('Tab')
  await shot(page, `${prefix}-dialog-second-button`)
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('cancel-dialog-ui-run')).toHaveCount(0)
  const closeFocus = await focusOf(page)
  await shot(page, `${prefix}-dialog-closed`)
  notes.dialogs.push({ name: 'focus: cancel dialog opened with the keyboard', theme: 'light', size: 'wide', trigger: 'work-item-cancel-ui-run', openFocus, closeFocus, focusReturnedToTrigger: closeFocus.testid === 'work-item-cancel-ui-run' })
}

test.describe('Control Center UI review capture', () => {
  test.skip(process.env['NEXUS_UI_REVIEW'] !== '1', 'Run with NEXUS_UI_REVIEW=1')

  test('the 0.7 surfaces, light and dark, wide and narrow', async () => {
    test.setTimeout(540_000)
    const repo = createRepo()
    const dataDir = tempDir('data')
    const { app, page } = await launchApp(dataDir, repo)
    try {
      await installFixtures(app)
      for (const theme of ['light', 'dark'] as const) {
        await setTheme(page, theme)
        for (const size of SIZES) {
          await capture(app, page, theme, size)
          if (theme === 'light' && size.name === 'wide') await captureFocus(app, page)
        }
      }

      // The one real disconnect: the runtime process is killed and the window shows the banner over stale content.
      // Fixtures are switched off so the page shows what the real runtime last said.
      await resize(app, 1440, 900)
      await fixture(app, { mode: 'off', connection: null })
      await page.reload()
      await page.getByTestId('nav-control').click()
      await expect(page.getByTestId('control-capacity-line')).toBeVisible()
      killRuntime(dataDir)
      await expect(page.getByTestId('connection-content')).toHaveAttribute('data-stale', 'true', { timeout: 60_000 })
      await shot(page, 'control-dark-wide-disconnected-real')
      notes.disconnected.push({
        theme: 'dark',
        size: 'wide',
        source: 'runtime process killed with killRuntime',
        contentInert: await page.getByTestId('connection-content').evaluate((el) => el.hasAttribute('inert')),
        contentDataStale: await page.getByTestId('connection-content').getAttribute('data-stale'),
        bannerFocusable: await page.getByTestId('connection-retry').evaluate((el) => !el.closest('[inert]')),
      })
      notes.notReached.push(
        'A security decision row cannot be expanded: the panel is a table whose reason column is always visible, so "one expanded why-was-this-blocked" is captured as the table with all reasons shown.',
        'The startup state is produced by a reload with desktop.connection answered as STARTING_RUNTIME / CONNECTING (a real start passes through it in well under a second).',
      )
    } finally {
      mkdirSync(OUT, { recursive: true })
      writeFileSync(join(OUT, 'control-notes.json'), JSON.stringify(notes, null, 2))
      await closeApp(app)
    }
  })
})
