// Manual acceptance against the REAL Claude runtime: does a session read the prompt prefix another session
// wrote, and what changes that? Consumes a small amount of usage (seven one-turn sessions on the smallest
// model, each answering one word). Run with `pnpm smoke:cache`. Writes evidence to docs/acceptance.
//
// Every figure in the evidence is what the runtime reported. Nothing here asserts a saving: it records
// what happened so that the release report can say which defaults the evidence supports.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { ClaudeSdkRuntime } from '@main/modules/agent-runtime/claude-sdk-runtime'
import { resolveClaudeExecutable } from '@main/modules/agent-runtime/resolve-executable'
import type { AgentEvent, NexusToolHandlers, RuntimeContextUsage, SessionContextOptions, SessionSpec } from '@main/modules/agent-runtime/types'
import { rolePrompt } from '@main/modules/context/prompts'
import { toolsForRole } from '@main/modules/policies/tools'
import { classifyCacheResult } from '@main/modules/token'

const MODEL = process.env['NEXUS_CACHE_SMOKE_MODEL'] ?? 'haiku'
const runtime = new ClaudeSdkRuntime({ resolveExecutable: () => resolveClaudeExecutable() })
const dirs = [mkdtempSync(join(tmpdir(), 'nexus-cache-a-')), mkdtempSync(join(tmpdir(), 'nexus-cache-b-'))] as const
afterAll(async () => {
  await runtime.shutdown()
  for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

const said = async (): Promise<string> => 'ok'
const nexusTools: NexusToolHandlers = { sendMessage: said, reportBlocker: said, recordDecision: said, proposeMemory: said, contextTool: said }

interface Observed {
  label: string
  cwd: 'A' | 'B'
  options: SessionContextOptions
  role: string
  requests: { inputTokens: number; cacheReadTokens: number; cacheCreationTokens: number; outputTokens: number }[]
  firstRequest: string
  context: Pick<RuntimeContextUsage, 'totalTokens' | 'maxTokens' | 'categories' | 'messageBreakdown'> & { systemPromptTokens: number; systemToolTokens: number; mcpToolsLoaded: number; mcpToolsDeferred: number; mcpToolTokensLoaded: number } | null
  outcome: string
  durationMs: number
}

async function session(label: string, cwd: 0 | 1, options: SessionContextOptions, over: { role?: 'worker' | 'reviewer'; prompt?: string } = {}): Promise<Observed> {
  const role = over.role ?? 'worker'
  const spec: SessionSpec = {
    agentId: `cache-smoke-${label}`,
    role,
    cwd: dirs[cwd],
    model: MODEL,
    maxTurns: 1,
    systemPromptAppend: rolePrompt(role, role === 'worker' ? 'implement' : 'review'),
    prompt: over.prompt ?? 'Reply with the single word OK. Do not use any tool.',
    tools: toolsForRole(role, { allowNetworkTools: false }),
    authorize: async () => ({ behavior: 'deny', reason: 'No tool is needed for this check.' }),
    requestApproval: async () => false,
    nexusTools,
    loadProjectSettings: false,
    subscriptionMode: true,
    contextOptions: options,
  }
  const started = Date.now()
  const handle = runtime.startSession(spec)
  const events: AgentEvent[] = []
  for await (const e of handle.events) {
    events.push(e)
    if (e.type === 'turn.completed') handle.end()
  }
  const requests = events.flatMap((e) => (e.type === 'request.usage' ? [{ inputTokens: e.inputTokens, cacheReadTokens: e.cacheReadTokens, cacheCreationTokens: e.cacheCreationTokens, outputTokens: e.outputTokens }] : []))
  const usage = events.flatMap((e) => (e.type === 'context.usage' ? [e.usage] : [])).at(-1) ?? null
  const turn = events.flatMap((e) => (e.type === 'turn.completed' ? [e.result] : [])).at(-1)
  const first = requests[0]
  const sum = (xs: readonly { tokens: number }[]): number => xs.reduce((n, x) => n + x.tokens, 0)
  const observed: Observed = {
    label,
    cwd: cwd === 0 ? 'A' : 'B',
    options,
    role,
    requests,
    firstRequest: first ? classifyCacheResult({ inputTokens: first.inputTokens, cacheReadTokens: first.cacheReadTokens, cacheWriteTokens: first.cacheCreationTokens }) : 'no request reported',
    context: usage
      ? {
          totalTokens: usage.totalTokens,
          maxTokens: usage.maxTokens,
          categories: usage.categories,
          messageBreakdown: usage.messageBreakdown,
          systemPromptTokens: sum(usage.systemPromptSections),
          systemToolTokens: sum(usage.systemTools),
          mcpToolsLoaded: usage.mcpTools.filter((t) => t.isLoaded !== false).length,
          mcpToolsDeferred: usage.mcpTools.filter((t) => t.isLoaded === false).length,
          mcpToolTokensLoaded: sum(usage.mcpTools.filter((t) => t.isLoaded !== false)),
        }
      : null,
    outcome: turn?.outcome ?? 'no result',
    durationMs: Date.now() - started,
  }
  console.log(`${label}: first request ${observed.firstRequest}, ${JSON.stringify(first ?? null)}, context ${usage?.totalTokens ?? 'n/a'}`)
  return observed
}

describe('real Claude runtime: prompt cache across sessions', () => {
  it('records what each session read and wrote', async () => {
    const startedAt = new Date().toISOString()
    const base: SessionContextOptions = { stablePrefix: false, alwaysLoadNexusTools: false, contextUsageDetail: 'summary' }
    const stable: SessionContextOptions = { ...base, stablePrefix: true }
    const sessions: Observed[] = []
    // 0.7.0 behaviour: the same role in two different working directories.
    sessions.push(await session('baseline-A', 0, base))
    sessions.push(await session('baseline-B', 1, base))
    // The stable prefix: the same two directories.
    sessions.push(await session('stable-A', 0, stable))
    sessions.push(await session('stable-B', 1, stable))
    // A different dynamic suffix (another prompt) with the same stable prefix.
    sessions.push(await session('stable-B-other-prompt', 1, stable, { prompt: 'Reply with the single word DONE. Do not use any tool.' }))
    // A different stable part: another role's prompt and tools.
    sessions.push(await session('stable-A-reviewer', 0, stable, { role: 'reviewer' }))
    // The NEXUS tools loaded upfront instead of deferred.
    sessions.push(await session('stable-B-tools-upfront', 1, { ...stable, alwaysLoadNexusTools: true }))

    const evidence = { kind: 'cache-acceptance', startedAt, finishedAt: new Date().toISOString(), model: MODEL, promptSent: true, note: 'One-turn sessions; every figure is runtime-reported. `firstRequest` classifies the first request of each session: write (prefix written), read (prefix read from cache), partial.', sessions }
    const dir = resolve(import.meta.dirname, '../../docs/acceptance')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `cache-acceptance-${startedAt.replace(/[:.]/g, '-')}.json`)
    writeFileSync(file, `${JSON.stringify(evidence, null, 2)}\n`)
    console.log(`evidence: ${file}`)

    expect(sessions.every((s) => s.outcome === 'success')).toBe(true)
    expect(sessions.every((s) => s.requests.length >= 1)).toBe(true)
  })
})
