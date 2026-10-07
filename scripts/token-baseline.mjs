// Baseline of NEXUS 0.7.0 token use, from two sources that cost no Claude usage:
//  1. the evidence files of real acceptance runs under docs/acceptance (observed, runtime-reported tokens), and
//  2. the prompts NEXUS itself builds (role prompts, NEXUS tool descriptions), measured statically.
// Run: node scripts/token-baseline.mjs [--json]
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { build } from 'esbuild'

const root = resolve(import.meta.dirname, '..')
const dir = join(root, 'docs', 'acceptance')

/** chars/4 is the estimate NEXUS uses where no runtime count exists; every figure derived from it is labelled "estimated". */
const estimateTokens = (text) => Math.ceil(text.length / 4)

const ZERO = { sessions: 0, turns: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, durationMs: 0 }
const pick = (u) => ({
  sessions: u.sessions ?? 0,
  turns: u.turns ?? 0,
  inputTokens: u.inputTokens ?? 0,
  outputTokens: u.outputTokens ?? 0,
  cacheReadTokens: u.cacheReadTokens ?? 0,
  cacheCreationTokens: u.cacheCreationTokens ?? 0,
  durationMs: u.durationMs ?? 0,
})

/** Totals of one evidence file, when it recorded cache fields (0.3 and later). Null otherwise. */
function totalsOf(j) {
  const t = j.observedUsage?.totals ?? j.usage?.totals ?? j.usage?.session ?? j.claudeUsage?.session ?? j.observedUsage?.session
  return t && typeof t.cacheReadTokens === 'number' ? pick(t) : null
}

function derived(t) {
  const processed = t.inputTokens + t.cacheReadTokens + t.cacheCreationTokens
  return {
    ...t,
    processedInput: processed,
    cacheReadShare: processed ? t.cacheReadTokens / processed : 0,
    cacheWriteShare: processed ? t.cacheCreationTokens / processed : 0,
    uncachedShare: processed ? t.inputTokens / processed : 0,
    cacheWritePerSession: t.sessions ? Math.round(t.cacheCreationTokens / t.sessions) : 0,
    processedPerTurn: t.turns ? Math.round(processed / t.turns) : 0,
    outputPerTurn: t.turns ? Math.round(t.outputTokens / t.turns) : 0,
    turnsPerSession: t.sessions ? +(t.turns / t.sessions).toFixed(1) : 0,
  }
}

const runs = []
for (const file of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
  let j
  try {
    j = JSON.parse(readFileSync(join(dir, file), 'utf8'))
  } catch {
    continue
  }
  const totals = totalsOf(j)
  if (!totals || totals.sessions === 0) continue
  const kind = j.kind ?? file.replace(/-\d{4}-.*$/, '')
  const strategy = j.strategy?.resolved ?? j.strategy?.requested ?? null
  const byRole = (j.observedUsage?.byRole ?? j.usage?.byRole ?? []).map((r) => ({ role: r.key, ...derived(pick(r)) }))
  const byStrategy = (j.usage?.byStrategy ?? []).map((r) => ({ strategy: r.key, ...derived(pick(r)) }))
  const trials = (j.trials ?? [])
    .filter((t) => t.metrics)
    .map((t) => ({ case: t.case, strategy: t.strategy, state: t.state, sessions: t.metrics.sessions, turns: t.metrics.turns, inputTokens: t.metrics.inputTokens, outputTokens: t.metrics.outputTokens, toolCalls: t.metrics.toolCalls, wallClockMs: t.metrics.wallClockMs }))
  runs.push({ file, kind, strategy, ...derived(totals), byRole, byStrategy, trials })
}

// Static prompt components: bundle the prompt module and measure what NEXUS adds to every session.
const tmp = mkdtempSync(join(tmpdir(), 'nexus-baseline-'))
let components = []
let shared = null
try {
  const out = join(tmp, 'prompts.mjs')
  await build({
    stdin: {
      contents: `export { rolePrompt } from '@main/modules/context/prompts'`,
      resolveDir: root,
      loader: 'ts',
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: out,
    alias: { '@shared': join(root, 'src/shared'), '@main': join(root, 'src/main') },
    logLevel: 'silent',
  })
  const { rolePrompt } = await import(pathToFileURL(out).href)
  const pairs = [
    ['planner', 'plan'],
    ['architect', 'research'],
    ['worker', 'implement'],
    ['debugger', 'diagnose'],
    ['reviewer', 'review'],
    ['verifier', 'verify'],
    ['researcher', 'research'],
    ['security_reviewer', 'review'],
    ['planner', 'critique'],
    ['planner', 'synthesize'],
    ['reviewer', 'arbitrate'],
  ]
  const texts = pairs.map(([role, purpose]) => ({ role, purpose, text: rolePrompt(role, purpose) }))
  components = texts.map((t) => ({ role: t.role, purpose: t.purpose, chars: t.text.length, estimatedTokens: estimateTokens(t.text) }))
  // Paragraphs present in every role prompt: transmitted once per session whatever the role.
  const paragraphs = texts.map((t) => new Set(t.text.split('\n\n')))
  const common = [...paragraphs[0]].filter((p) => paragraphs.every((s) => s.has(p)))
  const commonChars = common.join('\n\n').length
  shared = {
    paragraphs: common.length,
    chars: commonChars,
    estimatedTokens: estimateTokens(common.join('\n\n')),
    /** Position of the first shared paragraph in the worker prompt: a shared block that does not come first cannot be a shared cache prefix. */
    firstSharedParagraphIndexInWorkerPrompt: texts[2].text.split('\n\n').findIndex((p) => common.includes(p)),
  }
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

const byKind = {}
for (const r of runs) {
  const k = (byKind[r.kind] ??= { ...ZERO, runs: 0 })
  k.runs++
  for (const f of Object.keys(ZERO)) k[f] += r[f]
}
const summary = Object.entries(byKind).map(([kind, t]) => ({ kind, runs: t.runs, ...derived(t) }))

const report = { generatedFrom: 'docs/acceptance', runs, summary, rolePrompts: components, sharedRolePromptText: shared }

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(report, null, 2))
} else {
  const pct = (x) => `${(x * 100).toFixed(1)}%`
  console.log('kind | runs | sessions | turns | uncached in | cache read | cache write | output | read share | write share | write/session | processed/turn')
  for (const s of summary) {
    console.log([s.kind, s.runs, s.sessions, s.turns, s.inputTokens, s.cacheReadTokens, s.cacheCreationTokens, s.outputTokens, pct(s.cacheReadShare), pct(s.cacheWriteShare), s.cacheWritePerSession, s.processedPerTurn].join(' | '))
  }
  console.log('\nper run')
  for (const r of runs) {
    console.log([r.file, r.kind, r.strategy ?? '-', r.sessions, r.turns, r.inputTokens, r.cacheReadTokens, r.cacheCreationTokens, r.outputTokens, pct(r.cacheReadShare), r.cacheWritePerSession].join(' | '))
    for (const b of r.byRole) console.log(`   role ${b.role}: sessions ${b.sessions}, turns ${b.turns}, uncached ${b.inputTokens}, read ${b.cacheReadTokens}, write ${b.cacheCreationTokens}, out ${b.outputTokens}, write/session ${b.cacheWritePerSession}`)
    for (const b of r.byStrategy) console.log(`   strategy ${b.strategy}: sessions ${b.sessions}, turns ${b.turns}, uncached ${b.inputTokens}, read ${b.cacheReadTokens}, write ${b.cacheCreationTokens}, out ${b.outputTokens}, write/session ${b.cacheWritePerSession}`)
  }
  console.log('\nrole prompts (estimated tokens = chars/4)')
  for (const c of components) console.log(`   ${c.role}/${c.purpose}: ${c.chars} chars, ~${c.estimatedTokens} tokens`)
  console.log(`   shared by every role prompt: ${shared.paragraphs} paragraphs, ${shared.chars} chars, ~${shared.estimatedTokens} tokens; first shared paragraph is paragraph #${shared.firstSharedParagraphIndexInWorkerPrompt} of the worker prompt`)
}
