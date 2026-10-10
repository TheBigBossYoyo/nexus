import { describe, expect, it } from 'vitest'
import { FakeAgentRuntime, defaultFakeAuthStatus } from '@main/modules/agent-runtime/fake-runtime'
import type { AgentEvent, SessionSpec } from '@main/modules/agent-runtime/types'
import { FakeRuntimeProvider } from '@main/modules/providers/providers'
import { ProviderService } from '@main/modules/providers/service'
import { WorkerCapacityRouting } from '@main/modules/capacity/worker-routing'
import { UsageIntelligenceService } from '@main/modules/usage/service'
import { EventBus } from '@main/modules/events'
import { makeAgent, makeRun } from '../persistence/fixtures'
import { graphHarness } from '../../helpers/context-graph'

/**
 * After a start the providers are detected in the background. A session asked for before that has finished used
 * to find no provider at all and wait "for capacity": its run paused in its first second, with nothing wrong.
 */
describe('a session asked for before the providers are detected', () => {
  it('waits for the detection and is admitted, not paused for capacity', async () => {
    const h = graphHarness()
    const run = h.repos.runs.insert(makeRun(h.project.id, { state: 'executing' }))
    const claude = new FakeAgentRuntime({ authStatus: defaultFakeAuthStatus(), script: async (_spec, ctx) => { await ctx.completeTurn({ text: 'done' }) } })
    const providers = new ProviderService({ providers: [new FakeRuntimeProvider('claude', claude)], sessions: h.repos.providerSessions, settings: h.repos.settings, runOfAgent: (id) => h.repos.agents.get(id)?.runId ?? null })
    // No `await providers.refresh()` here: this is the first second of a runtime.
    expect(providers.list()).toEqual([])
    const usage = new UsageIntelligenceService({ repos: h.repos, bus: new EventBus(h.repos.events, h.repos.transaction), runtime: claude, push: () => undefined })
    const routing = new WorkerCapacityRouting({ repos: h.repos, providers, usage, dataDir: 'discovery-fixture', bootId: 'discovery-boot', maxAgents: () => 2 })
    try {
      const agent = h.repos.agents.insert(makeAgent(run.id, null, { role: 'worker' }))
      const spec: SessionSpec = { agentId: agent.id, role: 'worker', model: 'fake-claude', cwd: h.project.rootPath, prompt: 'Do the task', systemPromptAppend: 'Worker policy', maxTurns: 1, tools: [], authorize: async () => ({ behavior: 'deny', reason: 'fixture' }), requestApproval: async () => false, subscriptionMode: true, loadProjectSettings: false }
      const handle = providers.router.startSession(spec)
      const events: AgentEvent[] = []
      for await (const event of handle.events) {
        events.push(event)
        if (event.type === 'turn.completed') handle.end()
      }
      expect(events.some((e) => e.type === 'capacity.wait')).toBe(false)
      expect(events.some((e) => e.type === 'turn.completed')).toBe(true)
      expect(claude.sessions).toHaveLength(1)
    } finally {
      await claude.shutdown()
      await routing.dispose()
      usage.dispose()
      h.close()
    }
  })
})
