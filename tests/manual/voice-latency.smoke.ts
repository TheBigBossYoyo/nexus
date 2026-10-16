// Manual measurement against the REAL Claude runtime: how fast does a warm, tool-less, fast-tier session answer?
// About seven model turns (one warm-up, six questions). Run with `pnpm smoke:voice-latency`.
// Writes evidence to test-results/voice-latency. Its working directory is inside the project, never %TEMP%.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ClaudeSdkRuntime } from '@main/modules/agent-runtime/claude-sdk-runtime'
import { resolveClaudeExecutable } from '@main/modules/agent-runtime/resolve-executable'
import { DirectorVoice } from '@main/modules/director-line/director-voice'

const MODEL = process.env['VOICE_MODEL'] || 'haiku'
const FACTS = 'RaceDeck: 73%, verifying.\n25–40 min of active work remain.\nTasks: 16 done, 2 running.'
const QUESTIONS = [
  'How is RaceDeck doing?',
  'How long until it is finished?',
  'How many tasks are done?',
  'Is anything still running?',
  'What is the weather like today?',
  'Give me the short version.',
]

describe('real Claude runtime: Director voice latency', () => {
  it('measures cold start and warm first-sentence latency', async () => {
    const root = resolve(import.meta.dirname, '../../test-results/voice-latency')
    const cwd = join(root, 'cwd')
    mkdirSync(cwd, { recursive: true })
    const runtime = new ClaudeSdkRuntime({ resolveExecutable: () => resolveClaudeExecutable() })
    // DirectorVoice does not report the warm turn through onTurn, so the session's events are timed here.
    const seen: { at: number; type: string; detail?: string }[] = []
    const observed = {
      startSession: (opts: Parameters<typeof runtime.startSession>[0]) => {
        seen.push({ at: Date.now(), type: 'startSession' })
        const handle = runtime.startSession(opts)
        const events = (async function* () {
          for await (const e of handle.events) {
            const ev = e as { type: string; text?: string; result?: unknown }
            seen.push({ at: Date.now(), type: ev.type, ...(ev.type === 'turn.completed' ? { detail: JSON.stringify(ev.result).slice(0, 600) } : ev.type === 'text.delta' ? { detail: ev.text } : {}) })
            yield e
          }
        })()
        return new Proxy(handle, { get: (t, k) => (k === 'events' ? events : Reflect.get(t, k).bind?.(t) ?? Reflect.get(t, k)) })
      },
    }
    const turns: { outcome: string; firstWordMs: number | null; totalMs: number; usage: unknown }[] = []
    const voice = new DirectorVoice({
      runtime: observed,
      cwd,
      model: MODEL,
      subscriptionMode: true,
      firstWordTimeoutMs: 30_000,
      turnTimeoutMs: 60_000,
      settleTimeoutMs: 30_000,
      onTurn: (t) => turns.push(t),
    })
    const rows: Record<string, unknown>[] = []
    try {
      const t0 = Date.now()
      voice.warm()
      // warm() is not awaitable; a turn arriving at onTurn is the warm turn completing.
      while (!seen.some((e) => e.type === 'turn.completed') && Date.now() - t0 < 90_000) await new Promise((r) => setTimeout(r, 25))
      const done = seen.find((e) => e.type === 'turn.completed')
      const coldMs = done ? done.at - (seen.find((e) => e.type === 'startSession')?.at ?? t0) : -1
      console.log(`cold start (startSession to warm turn completed): ${coldMs} ms
warm events: ${JSON.stringify(seen.map((e) => ({ ...e, at: e.at - t0 })))}`)
      expect(done).toBeDefined()

      for (const said of QUESTIONS) {
        const asked = Date.now()
        let firstSentenceMs: number | null = null
        const sentences: string[] = []
        const before = turns.length
        const answer = await voice.answer({ said, facts: FACTS }, (s) => {
          if (firstSentenceMs === null) firstSentenceMs = Date.now() - asked
          sentences.push(s)
        })
        const totalMs = Date.now() - asked
        const turn = turns[before]
        const row = {
          said,
          firstSentenceMs,
          totalMs,
          firstDeltaMs: turn?.firstWordMs ?? null,
          by: answer.by,
          outcome: turn?.outcome ?? null,
          text: answer.text,
          sentences: sentences.length,
          usage: turn?.usage ?? null,
        }
        rows.push(row)
        console.log(`Q: ${said}\n   first sentence ${firstSentenceMs} ms | first delta ${row.firstDeltaMs} ms | total ${totalMs} ms | by ${answer.by} | ${row.outcome}\n   "${answer.text}"`)
      }
      const evidence = { kind: 'voice-latency-smoke', model: MODEL, coldMs, warmEvents: seen.map((e) => ({ ...e, at: e.at - t0 })), rows, allTurns: turns }
      writeFileSync(join(root, `voice-latency-${new Date().toISOString().replace(/[:.]/g, '-')}.json`), `${JSON.stringify(evidence, null, 2)}\n`)
      console.log(`usage per turn: ${JSON.stringify(turns.map((t) => t.usage))}`)
    } finally {
      await voice.close()
      await runtime.shutdown()
    }
  })
})
