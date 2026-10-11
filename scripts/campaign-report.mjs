// Reads the evidence files of the real quality campaign (docs/acceptance/campaign) and prints quality and
// efficiency tables. They are never combined into one score. EVERY run on file counts: quality is shown as
// counts over the runs of a cell, efficiency as the mean of its runs. Usage: node scripts/campaign-report.mjs [directory]
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const dir = resolve(process.argv[2] ?? 'docs/acceptance/campaign')
// The arms to show, the first one the baseline: NEXUS_CAMPAIGN_ARMS=071-graph,072,072-auto compares 0.7.2 with 0.7.1.
const ARMS = (process.env.NEXUS_CAMPAIGN_ARMS ?? '070,071,071-graph').split(',')
const BASE = ARMS[0]
const TASKS = ['localized-bug', 'cross-module-bug', 'feature', 'refactor', 'architecture', 'security', 'program', 'workspace']

const cells = new Map()
for (const name of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
  const run = JSON.parse(readFileSync(join(dir, name), 'utf8'))
  if (run.kind !== 'campaign-run') continue
  const key = `${run.task}|${run.arm}`
  cells.set(key, [...(cells.get(key) ?? []), run])
}

const k = (n) => (n >= 10_000 ? `${(n / 1000).toFixed(0)}k` : String(Math.round(n)))
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)
const of = (runs, f) => `${runs.filter(f).length}/${runs.length}`
const each = (f) => TASKS.flatMap((task) => ARMS.flatMap((arm) => (cells.has(`${task}|${arm}`) ? [f(task, arm, cells.get(`${task}|${arm}`))] : [])))

console.log('### Quality (counts over the runs of each cell)\n')
console.log('| Task | Arm | Runs | Completed | Hidden evaluation passed | First-pass verification | Reviewer findings (critical / high / other) | Repairs | Regressions | Approvals refused / pauses |')
console.log('| --- | --- | ---: | --- | --- | --- | --- | ---: | ---: | --- |')
for (const line of each((task, arm, runs) => {
  const q = runs.map((r) => r.quality)
  const sev = (s) => q.reduce((n, x) => n + (x.findingsBySeverity[s] ?? 0), 0)
  const all = q.reduce((n, x) => n + x.reviewerFindings, 0)
  return `| ${task} | ${arm} | ${runs.length} | ${of(runs, (r) => r.quality.completed)} | ${of(runs, (r) => r.quality.hiddenPassed)} | ${of(runs, (r) => r.quality.firstPassAllPassed)} | ${sev('critical')} / ${sev('high')} / ${all - sev('critical') - sev('high')} | ${q.reduce((n, x) => n + x.repairs, 0)} | ${q.reduce((n, x) => n + x.regressions.length, 0)} | ${q.reduce((n, x) => n + x.humanIntervention.approvalsRequestedAndRefused, 0)} / ${q.reduce((n, x) => n + x.humanIntervention.pauses.length, 0)} |`
})) console.log(line)

console.log('\n### Efficiency (mean of the runs of each cell)\n')
console.log('| Task | Arm | Runs | Sessions | Turns | Tool calls recorded | Context-tool calls | Uncached input | Cache written | Cache read | Output | Rotations | Compactions | Wall time |')
console.log('| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |')
const m = (runs, f) => mean(runs.map((r) => f(r.efficiency)))
for (const line of each((task, arm, runs) => `| ${task} | ${arm} | ${runs.length} | ${m(runs, (e) => e.sessions).toFixed(1)} | ${m(runs, (e) => e.turns).toFixed(1)} | ${m(runs, (e) => e.toolCallsRecorded ?? e.toolCalls).toFixed(1)} | ${m(runs, (e) => e.contextToolCalls.length).toFixed(1)} | ${k(m(runs, (e) => e.inputTokensUncached))} | ${k(m(runs, (e) => e.cacheCreationTokens))} | ${k(m(runs, (e) => e.cacheReadTokens))} | ${k(m(runs, (e) => e.outputTokens))} | ${m(runs, (e) => e.sessionRotations).toFixed(1)} | ${m(runs, (e) => e.compactions).toFixed(1)} | ${Math.round(m(runs, (e) => e.wallMs) / 1000)} s |`)) console.log(line)

// Missions and the two engine-level tasks are totalled apart: a Program or Workspace run that is blocked
// early has done less work than one that finished, so its efficiency figures compare nothing.
const input = (e) => e.inputTokensUncached + e.cacheCreationTokens + e.cacheReadTokens
const pct = (a, b) => (b ? `${a - b >= 0 ? '+' : ''}${(((a - b) / b) * 100).toFixed(1)}%` : 'n/a')
for (const [title, set] of [['the six mission categories', TASKS.slice(0, 6)], ['Program and Workspace', TASKS.slice(6)]]) {
  const shared = set.filter((t) => ARMS.every((a) => cells.has(`${t}|${a}`)))
  console.log(`\n### Totals over ${title} (sum of cell means; tasks every arm has run: ${shared.join(', ') || 'none yet'})\n`)
  if (shared.length === 0) continue
  console.log('| Arm | Runs | Completed | Hidden evaluation passed | Turns | Uncached input | Cache written | Cache read | Output | Wall time | Against the first arm: turns / all input / output / wall |')
  console.log('| --- | ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |')
  const total = (arm, f) => shared.reduce((n, t) => n + m(cells.get(`${t}|${arm}`), f), 0)
  for (const arm of ARMS) {
    const runs = shared.flatMap((t) => cells.get(`${t}|${arm}`))
    const against = arm === BASE ? 'baseline' : `${pct(total(arm, (e) => e.turns), total(BASE, (e) => e.turns))} / ${pct(total(arm, input), total(BASE, input))} / ${pct(total(arm, (e) => e.outputTokens), total(BASE, (e) => e.outputTokens))} / ${pct(total(arm, (e) => e.wallMs), total(BASE, (e) => e.wallMs))}`
    console.log(`| ${arm} | ${runs.length} | ${of(runs, (r) => r.quality.completed)} | ${of(runs, (r) => r.quality.hiddenPassed)} | ${total(arm, (e) => e.turns).toFixed(0)} | ${k(total(arm, (e) => e.inputTokensUncached))} | ${k(total(arm, (e) => e.cacheCreationTokens))} | ${k(total(arm, (e) => e.cacheReadTokens))} | ${k(total(arm, (e) => e.outputTokens))} | ${Math.round(total(arm, (e) => e.wallMs) / 1000)} s | ${against} |`)
  }
}

