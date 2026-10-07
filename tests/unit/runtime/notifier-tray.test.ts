import { describe, expect, it } from 'vitest'
import type { NotificationKind } from '@shared/control-plane'
import { RuntimeNotifier } from '@main/modules/control-plane'
import { buildRuntimeTrayModel } from '@main/modules/runtime/tray-model'

function notifier() {
  const said: { kind: NotificationKind; subject: string; title: string; body: string }[] = []
  const milestones = new Map<string, { key: string; title: string; state: string }[]>()
  const campaigns = new Map<string, { name: string; state: string; regressions: number }>()
  const n = new RuntimeNotifier({
    announce: (kind, subject, title, body) => void said.push({ kind, subject, title, body }),
    milestones: (id) => milestones.get(id) ?? [],
    programName: () => 'Checkout rewrite',
    campaign: (id) => campaigns.get(id) ?? null,
    regressions: (id) => campaigns.get(id)?.regressions ?? 0,
  })
  return { n, said, milestones, campaigns }
}

describe('runtime notifications', () => {
  it('announces a milestone when it completes, not the ones that were complete before the runtime started', () => {
    const { n, said, milestones } = notifier()
    milestones.set('p1', [
      { key: 'm1', title: 'Schema', state: 'COMPLETED' },
      { key: 'm2', title: 'API', state: 'ACTIVE' },
    ])
    n.prime(['p1'], [])
    n.onPush({ kind: 'program', programId: 'p1' })
    expect(said).toEqual([])
    milestones.set('p1', [
      { key: 'm1', title: 'Schema', state: 'COMPLETED' },
      { key: 'm2', title: 'API', state: 'COMPLETED' },
    ])
    n.onPush({ kind: 'program', programId: 'p1' })
    n.onPush({ kind: 'program', programId: 'p1' })
    expect(said).toEqual([{ kind: 'milestone_completed', subject: 'p1', title: 'Milestone completed', body: 'Checkout rewrite: API' }])
  })

  it('a program first seen after the start is not announced for what it had already finished', () => {
    const { n, said, milestones } = notifier()
    milestones.set('p2', [{ key: 'a', title: 'A', state: 'COMPLETED' }])
    n.onPush({ kind: 'program', programId: 'p2' })
    expect(said).toEqual([])
    milestones.set('p2', [
      { key: 'a', title: 'A', state: 'COMPLETED' },
      { key: 'b', title: 'B', state: 'COMPLETED' },
    ])
    n.onPush({ kind: 'program', programId: 'p2' })
    expect(said.map((s) => s.body)).toEqual(['Checkout rewrite: B'])
  })

  it('announces an Arena regression once, when the campaign has completed, and nothing for a clean campaign', () => {
    const { n, said, campaigns } = notifier()
    campaigns.set('c1', { name: 'Nightly', state: 'running', regressions: 2 })
    n.onPush({ kind: 'arena', campaignId: 'c1' })
    expect(said).toEqual([])
    campaigns.set('c1', { name: 'Nightly', state: 'completed', regressions: 2 })
    n.onPush({ kind: 'arena', campaignId: 'c1' })
    n.onPush({ kind: 'arena', campaignId: 'c1' })
    campaigns.set('c2', { name: 'Clean', state: 'completed', regressions: 0 })
    n.onPush({ kind: 'arena', campaignId: 'c2' })
    expect(said).toEqual([{ kind: 'arena_regression', subject: 'c1', title: 'Arena found a regression', body: 'Nightly: 2 groups did worse than before.' }])
  })

  it('announces the end of an overnight run and a refused tool call; an allowed or audited call is not news', () => {
    const { n, said } = notifier()
    n.onEvent({ id: 'e', seq: 1, runId: 'r1', taskId: null, agentId: null, type: 'overnight.report', payload: { path: 'x', chars: 10 }, createdAt: '' })
    n.onSecurityDecision({ runId: 'r1', decision: 'ALLOW_WITH_AUDIT', action: 'pnpm test', reason: 'audited' })
    n.onSecurityDecision({ runId: 'r1', decision: 'REQUIRE_APPROVAL', action: 'node -e', reason: 'inline code' })
    n.onSecurityDecision({ runId: 'r1', decision: 'DENY', action: 'powershell foo.ps1', reason: 'The script controls power.' })
    expect(said.map((s) => [s.kind, s.subject])).toEqual([
      ['overnight_completed', 'r1'],
      ['security_high', 'r1'],
    ])
    // Nothing of the command itself is put into the notification.
    expect(said[1]?.body).not.toContain('foo.ps1')
  })
})

describe('the runtime tray', () => {
  const base = { phase: 'READY' as const, running: 0, waiting: 0, blocked: 0, agents: 0, health: 'HEALTHY' as const, dispatchPaused: false }

  it('says what the runtime does', () => {
    expect(buildRuntimeTrayModel(base)).toMatchObject({ status: 'IDLE', tooltip: 'NEXUS · idle' })
    const busy = buildRuntimeTrayModel({ ...base, running: 3, waiting: 1, agents: 5 })
    expect(busy.status).toBe('RUNNING')
    expect(busy.lines).toEqual(['NEXUS · 3 workloads running', '5 agents active', '1 workload waiting'])
    expect(buildRuntimeTrayModel({ ...base, running: 1, agents: 1 }).lines[0]).toBe('NEXUS · 1 workload running')
    expect(buildRuntimeTrayModel({ ...base, waiting: 2 }).lines[0]).toBe('NEXUS · 2 workloads waiting')
    expect(buildRuntimeTrayModel({ ...base, phase: 'RECOVERING' })).toMatchObject({ status: 'RECOVERING' })
    expect(buildRuntimeTrayModel({ ...base, running: 1, blocked: 1 }).status).toBe('ATTENTION')
    expect(buildRuntimeTrayModel({ ...base, health: 'DEGRADED' }).status).toBe('ATTENTION')
    expect(buildRuntimeTrayModel({ ...base, running: 2, dispatchPaused: true })).toMatchObject({ status: 'PAUSED' })
    expect(buildRuntimeTrayModel({ ...base, running: 400, waiting: 400, blocked: 400, agents: 400, dispatchPaused: true, health: 'BLOCKED' }).tooltip.length).toBeLessThanOrEqual(127)
  })

  it('offers open, the Control Center, the dispatch switch and a stop that asks; nothing destructive is one click away', () => {
    const model = buildRuntimeTrayModel(base)
    expect(model.items.map((i) => i.action)).toEqual(['open', 'openControl', 'pauseDispatch', 'stop'])
    expect(model.items.find((i) => i.action === 'stop')?.label).toBe('Stop NEXUS…')
    expect(buildRuntimeTrayModel({ ...base, dispatchPaused: true }).items.map((i) => i.action)).toContain('resumeDispatch')
    // While recovering the dispatch switch is not offered; stopping still is.
    const recovering = buildRuntimeTrayModel({ ...base, phase: 'RECOVERING' })
    expect(recovering.items.find((i) => i.action === 'pauseDispatch')?.enabled).toBe(false)
    expect(recovering.items.find((i) => i.action === 'stop')?.enabled).toBe(true)
    // No item cancels or deletes work.
    expect(model.items.some((i) => /cancel|delete|remove/i.test(i.label))).toBe(false)
  })
})
