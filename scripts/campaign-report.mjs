// Reads the evidence files of the real quality campaign (docs/acceptance/campaign) and prints two tables:
// quality and efficiency. They are never combined into one score. With several files for one task and arm,
// the latest is used and the others are counted. Usage: node scripts/campaign-report.mjs [directory]
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const dir = resolve(process.argv[2] ?? 'docs/acceptance/campaign')
const ARMS = ['070', '071', '071-graph']
const TASKS = ['localized-bug', 'cross-module-bug', 'feature', 'refactor', 'architecture', 'security', 'program', 'workspace']

const latest = new Map()
const counts = new Map()
for (const name of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
  const run = JSON.parse(readFileSync(join(dir, name), 'utf8'))
  if (run.kind !== 'campaign-run') continue
  const key = `${run.task}|${run.arm}`
  latest.set(key, { ...run, file: name })
  counts.set(key, (counts.get(key) ?? 0) + 1)
}

const k = (n) => (n >= 10_000 ? `${(n / 1000).toFixed(0)}k` : String(n))
const yes = (b) => (b ? 'yes' : '**no**')
const rows = (f) => TASKS.flatMap((task) => ARMS.flatMap((arm) => (latest.has(`${task}|${arm}`) ? [f(latest.get(`${task}|${arm}`), counts.get(`${task}|${arm}`))] : [])))

console.log('### Quality\n')
console.log('| Task | Arm | Completed | Hidden evaluation | First-pass verification | Reviewer findings (by severity) | Repairs | Regressions | Human intervention | Runs on file |')
console.log('| --- | --- | --- | --- | --- | --- | ---: | --- | --- | ---: |')
for (const line of rows((r, n) => {
  const q = r.quality
  const hidden = q.evaluations.map((e) => `${e.hidden?.pass ?? '?'}/${(e.hidden?.pass ?? 0) + (e.hidden?.fail ?? 0)}`).join(' + ')
  const sev = Object.entries(q.findingsBySeverity).map(([s, c]) => `${c} ${s}`).join(', ') || 'none'
  const human = q.humanIntervention.approvalsRequestedAndRefused + q.humanIntervention.pauses.length === 0 ? 'none' : `${q.humanIntervention.approvalsRequestedAndRefused} approvals refused, ${q.humanIntervention.pauses.length} pauses`
  return `| ${r.task} | ${r.arm} | ${yes(q.completed)}${q.timedOut ? ' (timed out)' : ''} | ${yes(q.hiddenPassed)} (${hidden}) | ${yes(q.firstPassAllPassed)} | ${q.reviewerFindings} (${sev}) | ${q.repairs} | ${q.regressions.length === 0 ? 'none' : q.regressions.join(', ')} | ${human} | ${n} |`
})) console.log(line)

console.log('\n### Efficiency\n')
console.log('| Task | Arm | Sessions | Turns | Tool calls (context) | Uncached input | Cache written | Cache read | Output | Rotations | Compactions | Wall time | Weekly window |')
console.log('| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |')
for (const line of rows((r) => {
  const e = r.efficiency
  const week = (w) => w?.find((x) => x.limitType === 'seven_day')?.utilizationPercent
  const window = week(e.usageWindowsBefore) == null ? 'n/a' : `${week(e.usageWindowsBefore)}% -> ${week(e.usageWindowsAfter)}%`
  return `| ${r.task} | ${r.arm} | ${e.sessions} | ${e.turns} | ${e.toolCalls} (${e.contextToolCalls.length}) | ${k(e.inputTokensUncached)} | ${k(e.cacheCreationTokens)} | ${k(e.cacheReadTokens)} | ${k(e.outputTokens)} | ${e.sessionRotations} | ${e.compactions} | ${Math.round(e.wallMs / 1000)} s | ${window} |`
})) console.log(line)

console.log('\n### Against 0.7.0, per task\n')
console.log('| Task | Arm | Turns | Cache read | Cache written | Output | Wall time | Hidden evaluation |')
console.log('| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |')
const pct = (a, b) => (b ? `${a - b >= 0 ? '+' : ''}${(((a - b) / b) * 100).toFixed(1)}%` : 'n/a')
for (const task of TASKS) {
  const base = latest.get(`${task}|070`)
  if (!base) continue
  for (const arm of ARMS.slice(1)) {
    const r = latest.get(`${task}|${arm}`)
    if (!r) continue
    const [a, b] = [r.efficiency, base.efficiency]
    console.log(`| ${task} | ${arm} | ${a.turns - b.turns >= 0 ? '+' : ''}${a.turns - b.turns} (${pct(a.turns, b.turns)}) | ${pct(a.cacheReadTokens, b.cacheReadTokens)} | ${pct(a.cacheCreationTokens, b.cacheCreationTokens)} | ${pct(a.outputTokens, b.outputTokens)} | ${pct(a.wallMs, b.wallMs)} | ${base.quality.hiddenPassed ? 'pass' : 'FAIL'} -> ${r.quality.hiddenPassed ? 'pass' : 'FAIL'} |`)
  }
}
