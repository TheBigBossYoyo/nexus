// Manual acceptance against the REAL Claude runtime: ONE Technical Director request (Director level 1), wired
// as the runtime process wires it: the provider service, the usage service, the production advisory routing
// (capacity kernel, leases) and the Director gateway on a real database. Consumes usage: one session of one
// turn on the strongest model tier. Run with `pnpm accept:director`. Writes evidence to docs/acceptance.
//
// What is and is not tested:
//  - ChatGPT is not connected here (a signed-out connection): no strategic or Council stage is exercised, and
//    nothing is sent to OpenAI. Level 1 is the Technical Director alone;
//  - the session is observed through a wrapper on the runtime: the options it was started with (tools, MCP
//    servers, settings, working directory) and every event it emitted are recorded, so "no tool was used" is
//    an observation, not a reading of the code;
//  - the objective asks for a file to be read and a command to be run. A session that could do either would
//    show a tool event; the adapter is expected to refuse or never to offer them.
// Nothing is faked: if the provider is not authenticated the evidence says NOT VERIFIED and the test fails.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ClaudeSdkRuntime } from '@main/modules/agent-runtime/claude-sdk-runtime'
import { resolveClaudeExecutable } from '@main/modules/agent-runtime/resolve-executable'
import type { AgentEvent, AgentRuntime, AgentSessionHandle, SessionSpec } from '@main/modules/agent-runtime/types'
import { EventBus } from '@main/modules/events'
import { TaskAdmissionService } from '@main/modules/intelligence/admission'
import type { ChatGPTConnection } from '@main/modules/intelligence/connection'
import { DirectorGateway } from '@main/modules/intelligence/gateway'
import { createProductionAdvisoryRouting } from '@main/modules/intelligence/production-routing'
import { ClaudeAgentRuntimeProvider } from '@main/modules/providers/providers'
import { ProviderService } from '@main/modules/providers/service'
import { UsageIntelligenceService } from '@main/modules/usage/service'
import { graphHarness } from '../helpers/context-graph'

const OBJECTIVE =
  'We plan to replace the hand-written retry loop of the telemetry uploader with an exponential backoff that has jitter. ' +
  'Before you answer, read the file src/uploader/retry.ts and run the test suite to see what breaks. ' +
  'Then say whether the plan is technically sound and what must be verified.'

/** Passes every call through to the real runtime and keeps what was asked of it and what it emitted. */
function observed(real: AgentRuntime): { runtime: AgentRuntime; specs: SessionSpec[]; events: AgentEvent[] } {
  const specs: SessionSpec[] = []
  const events: AgentEvent[] = []
  const runtime = new Proxy(real, {
    get(target, key, receiver) {
      if (key !== 'startSession') {
        const value: unknown = Reflect.get(target, key, receiver)
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value
      }
      return (spec: SessionSpec): AgentSessionHandle => {
        specs.push(spec)
        const handle = target.startSession(spec)
        const tapped = (async function* () {
          for await (const event of handle.events) {
            events.push(event)
            yield event
          }
        })()
        // The handle itself, with only its event stream replaced by the recording one.
        return new Proxy(handle, {
          get(h, k) {
            if (k === 'events') return tapped
            const value: unknown = Reflect.get(h, k, h)
            return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(h) : value
          },
        })
      }
    },
  })
  return { runtime, specs, events }
}

describe('real Claude runtime: the Technical Director (Director level 1)', () => {
  it('answers one advisory request with no tool, no project and no authority, and gives its slot back', async () => {
    const startedAt = new Date().toISOString()
    const dataDir = resolve(import.meta.dirname, '../../test-results/accept-director')
    rmSync(dataDir, { recursive: true, force: true })
    mkdirSync(dataDir, { recursive: true })
    const h = graphHarness()
    const real = new ClaudeSdkRuntime({ resolveExecutable: () => resolveClaudeExecutable() })
    const { runtime, specs, events } = observed(real)
    const providers = new ProviderService({
      providers: [new ClaudeAgentRuntimeProvider({ runtime, subscriptionMode: () => true, probeCwd: () => dataDir })],
      sessions: h.repos.providerSessions,
      settings: h.repos.settings,
      runOfAgent: () => null,
    })
    await providers.refresh()
    const bus = new EventBus(h.repos.events, h.repos.transaction)
    const usage = new UsageIntelligenceService({ repos: h.repos, bus, runtime, push: () => undefined })
    // The state of a user who never connected ChatGPT.
    const chatgpt = { status: () => ({ state: 'SIGNED_OUT', profiles: [], activeProfile: null, model: null, models: [], error: null, includedOnlyConfirmed: false, capacity: null }), provider: () => undefined, canInfer: () => false } as unknown as ChatGPTConnection
    const routing = createProductionAdvisoryRouting({ repos: h.repos, providers, usage, chatgpt, bootId: 'accept-director', dataDir, maxAgents: () => 3 })
    const gateway = new DirectorGateway(h.repos.intelligenceArtifacts, routing.service)
    const store = h.repos.intelligenceArtifacts
    let evidence: Record<string, unknown> = { kind: 'technical-director-acceptance', startedAt, verdict: 'NOT VERIFIED' }
    try {
      await h.graph.syncProject(h.project.id)
      h.graph.writeNote({ space: h.space, title: 'Uploader retry policy', body: 'The telemetry uploader retries at most five times; the fifth failure is reported to the operator.', author: { source: 'user' } })
      const context = new TaskAdmissionService(h.repos).retrieve(h.project.id, OBJECTIVE)
      const account = await real.getAccountInfo({ subscriptionMode: true })
      const began = Date.now()
      const invocation = await gateway.invoke({ projectId: h.project.id, objective: OBJECTIVE, level: 1, reasons: ['USER_SELECTED_LEVEL'], context, provider: null, model: null })
      const durationMs = Date.now() - began
      await routing.service.reconcileStops()
      const routes = store.routingHistory(h.project.id, invocation.id)
      const leases = (h.db.prepare("SELECT body FROM capacity_checkpoints WHERE id LIKE 'capacity-leases:%'").all() as { body: string }[])
        .flatMap((row) => (JSON.parse(row.body) as { leases?: { role: string; state: string }[] }).leases ?? [])
      const outcome = invocation.outcomeId ? store.directorRecord(h.project.id, invocation.outcomeId) : null
      const spec = specs[0]
      const toolEvents = events.filter((e) => e.type.startsWith('tool.'))
      const result = events.find((e): e is Extract<AgentEvent, { type: 'turn.completed' }> => e.type === 'turn.completed')
      const text = JSON.stringify(invocation.challenge ?? invocation.memo ?? invocation.synthesis ?? null)
      evidence = {
        kind: 'technical-director-acceptance',
        startedAt,
        // No identity is recorded: only what kind of account the runtime says it is.
        account: { state: account.state, mode: account.mode, subscriptionType: account.subscriptionType ?? null },
        chatgpt: 'SIGNED_OUT (nothing was sent to OpenAI)',
        request: { level: 1, objectiveChars: OBJECTIVE.length, contextItems: context.length },
        session: spec
          ? {
              count: specs.length,
              role: spec.role,
              label: spec.label ?? null,
              model: spec.model ?? null,
              tools: spec.tools,
              nexusTools: spec.nexusTools ? Object.keys(spec.nexusTools) : null,
              loadProjectSettings: spec.loadProjectSettings,
              cwdIsDataDir: resolve(spec.cwd) === dataDir,
              cwdIsProject: resolve(spec.cwd) === resolve(h.project.rootPath),
              maxTurns: spec.maxTurns,
              promptChars: spec.prompt.length,
            }
          : null,
        observed: {
          eventTypes: [...new Set(events.map((e) => e.type))],
          toolEvents: toolEvents.map((e) => e.type),
          turns: result?.result.numTurns ?? null,
          outcome: result?.result.outcome ?? null,
          usage: result?.result.usage ?? null,
          durationMs,
        },
        invocation: {
          state: invocation.state,
          provider: invocation.provider,
          model: invocation.model,
          executionAuthorized: invocation.executionAuthorized,
          message: invocation.message,
          stages: { memo: invocation.memo !== null, challenge: invocation.challenge !== null, synthesis: invocation.synthesis !== null },
          answerChars: text.length,
          answer: invocation.challenge ?? invocation.memo ?? null,
        },
        outcome,
        routing: routes.map((r) => ({ role: r.role, provider: r.provider, model: r.model, action: r.action, state: r.state, consumption: r.consumption, reasons: r.reasons, qualityEvidence: r.qualityEvidence, failure: r.failure ?? null, usage: r.usage ?? null })),
        leases,
        verdict: 'PENDING',
      }

      expect(account.state, 'the provider must be authenticated for this acceptance').toBe('authenticated')
      expect(invocation.state).toBe('COMPLETED')
      expect(invocation.executionAuthorized).toBe(false)
      // A level 1 request names no strategic provider, and no strategic stage ran.
      expect(invocation.provider).toBeNull()
      expect(invocation.synthesis).toBeNull()
      // One session, with nothing to act with.
      expect(specs).toHaveLength(1)
      expect(spec!.tools).toEqual([])
      expect(spec!.nexusTools).toBeUndefined()
      expect(spec!.loadProjectSettings).toBe(false)
      expect(resolve(spec!.cwd)).not.toBe(resolve(h.project.rootPath))
      // Asked to read a file and run the tests, it did neither.
      expect(toolEvents).toEqual([])
      // The decision, the dispatch and the outcome are on record, on Claude, with what the provider reported.
      const route = routes.find((r) => r.provider === 'claude')
      expect(route).toMatchObject({ role: 'technical', state: 'COMPLETED' })
      expect(route!.qualityEvidence.join(' ')).toContain('PRIMARY_ROLE_POLICY')
      // Its slot was given back.
      expect(leases.filter((l) => l.state !== 'RELEASED')).toEqual([])
      evidence['verdict'] = 'PASS'
    } catch (e) {
      evidence['verdict'] = 'FAIL'
      evidence['failure'] = e instanceof Error ? e.message.slice(0, 2000) : String(e)
      throw e
    } finally {
      const dir = resolve(import.meta.dirname, '../../docs/acceptance')
      mkdirSync(dir, { recursive: true })
      const file = join(dir, `technical-director-${startedAt.replace(/[:.]/g, '-')}.json`)
      writeFileSync(file, `${JSON.stringify(evidence, null, 2)}\n`)
      console.log(`evidence: ${file}`)
      await routing.dispose().catch(() => undefined)
      usage.dispose()
      await real.shutdown().catch(() => undefined)
      h.close()
    }
  })
})
