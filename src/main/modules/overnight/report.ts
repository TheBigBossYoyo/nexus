import type { Run } from '@shared/domain'
import { outcomeLabel, type OvernightRun, type RunCheckpoint, type TerminalReason } from '@shared/overnight'
import type { CommitInfo, GitStatus } from '@main/modules/git'
import type { Repositories } from '@main/modules/persistence'

/** Git facts captured during finalization (after agents stopped, before the report is written). */
export interface GitStateCapture {
  projectRoot: string
  branch: string | null
  status: GitStatus | null
  integrationBranch: string | null
  integrationHead: string | null
  commits: CommitInfo[]
  filesChanged: string[]
  /** Unfinished task worktrees whose pending changes were committed on their task branch. */
  checkpointCommits: { task: string; branch: string; commit: string }[]
  error: string | null
}

export interface ReportInput {
  repos: Repositories
  record: OvernightRun
  run: Run
  reason: TerminalReason
  detail: string | null
  finishedAt: string
  git: GitStateCapture | null
  /** One line on the power action as decided at report time; the outcome is appended afterwards. */
  powerPlan: string
}

const fmt = (iso: string | null | undefined): string => (iso ? iso : 'n/a')

function duration(fromIso: string, toIso: string): string {
  const ms = Math.max(0, Date.parse(toIso) - Date.parse(fromIso))
  const minutes = Math.floor(ms / 60_000)
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}

/** Agent-written text is quoted as data on one line, so it cannot restructure the report. */
function oneLine(text: string | null | undefined, max = 240): string {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}...` : flat
}

function countBy<T>(items: readonly T[], key: (item: T) => string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const item of items) out[key(item)] = (out[key(item)] ?? 0) + 1
  return out
}

const list = (lines: string[], empty = '- none'): string => (lines.length > 0 ? lines.join('\n') : empty)

/** The durable end-of-run report, built only from persisted state and the captured Git facts. */
export function buildOvernightReport(input: ReportInput): string {
  const { repos, record, run, reason } = input
  const project = repos.projects.get(run.projectId)
  const tasks = repos.tasks.listByRun(run.id)
  const planned = tasks.filter((t) => t.parentTaskId === null)
  const completed = planned.filter((t) => t.state === 'completed')
  const agents = repos.agents.listByRun(run.id)
  const sessions = agents.flatMap((a) => repos.sessions.listByAgent(a.id))
  const reviews = repos.reviews.listByRun(run.id)
  const verifications = repos.verifications.listByRun(run.id)
  const checks = verifications.filter((v) => v.kind === 'checks')
  const verifier = verifications.filter((v) => v.kind === 'verifier')
  const revisions = repos.graphRevisions.listByRun(run.id)
  const proposals = repos.graphProposals.listByRun(run.id)
  const repairs = tasks.filter((t) => t.kind === 'repair')
  const lastChecks = checks.filter((v) => v.taskId === null).at(-1) ?? checks.at(-1)
  const policy = record.policy
  const out: string[] = []

  out.push('# NEXUS Overnight Run', '')
  out.push(`- Run ID: ${run.id}`)
  out.push(`- Project: ${project ? `${project.name} (${project.rootPath})` : run.projectId}`)
  out.push(`- Started: ${record.startedAt}`)
  out.push(`- Finished: ${input.finishedAt}`)
  out.push(`- Duration: ${duration(record.startedAt, input.finishedAt)}`)
  out.push(`- Mission deadline: ${record.deadlineAt}`, '')

  out.push('## Mission', '', run.prompt.trim(), '')

  out.push('## Outcome', '')
  out.push(`**${outcomeLabel(reason, completed.length, planned.length)}** (terminal reason: ${reason}; run state: ${run.state})`)
  if (input.detail) out.push('', `Detail: ${oneLine(input.detail, 600)}`)
  if (run.error) out.push('', `Run error: ${oneLine(run.error, 600)}`)
  out.push('')

  out.push('## Plan versions', '')
  out.push(list(revisions.map((r) => `- v${r.version} (${r.createdAt}): ${oneLine(r.reason)}`), '- no plan was accepted'), '')

  out.push('## Tasks', '')
  out.push(`Completed ${completed.length}/${planned.length} planned task(s). By state: ${JSON.stringify(countBy(planned, (t) => t.state))}`, '')
  out.push(list(planned.map((t) => `- \`${t.key}\` [${t.state}] ${oneLine(t.title, 120)}${t.repairCycles > 0 ? ` (repair cycles: ${t.repairCycles})` : ''}`)), '')

  out.push('## Agents', '')
  out.push(`- Agents: ${agents.length}; SDK sessions: ${sessions.length} (rotated: ${sessions.filter((s) => s.state === 'rotated').length})`)
  out.push(`- Models: ${JSON.stringify(countBy(agents, (a) => a.model ?? 'unknown'))}`)
  out.push(`- Roles: ${JSON.stringify(countBy(agents, (a) => a.role))}`)
  const failedAgents = agents.filter((a) => a.state === 'failed')
  out.push(`- Failed agents: ${failedAgents.length}`)
  for (const a of failedAgents.slice(0, 20)) out.push(`  - ${a.label}: ${oneLine(a.error, 160)}`)
  out.push('')

  out.push('## Tests', '')
  if (lastChecks) {
    out.push(`Latest check run (${lastChecks.taskId === null ? 'integration branch' : 'task'}, ${lastChecks.createdAt}): ${lastChecks.passed ? 'passed' : 'FAILED'}. ${oneLine(lastChecks.summary)}`)
    for (const c of lastChecks.commands) out.push(`- \`${c.command}\` exit ${c.exitCode ?? 'n/a'}${c.timedOut ? ' (timed out)' : ''}, ${Math.round(c.durationMs / 1000)} s`)
  } else out.push('No check command was run.')
  out.push(`Check runs: ${checks.length} (${checks.filter((c) => c.passed).length} passed).`, '')

  out.push('## Reviews', '')
  out.push(`${reviews.length} review(s): ${reviews.filter((r) => r.verdict === 'approved').length} approved, ${reviews.filter((r) => r.verdict === 'changes_requested').length} requested changes.`, '')

  out.push('## Repairs', '')
  out.push(`${repairs.length} repair task(s): ${JSON.stringify(countBy(repairs, (t) => t.state))}`, '')

  out.push('## Verification', '')
  out.push(`${verifier.length} verifier run(s): ${verifier.filter((v) => v.passed).length} passed, ${verifier.filter((v) => !v.passed).length} failed.`)
  const mission = verifier.filter((v) => v.taskId === null).at(-1)
  if (mission) out.push(`Mission verification: ${mission.passed ? 'passed' : 'FAILED'}. ${oneLine(mission.summary)}`)
  out.push('')

  out.push('## Graph revisions', '')
  out.push(`${revisions.length} revision(s); ${proposals.length} proposal(s): ${JSON.stringify(countBy(proposals, (p) => p.status))}`)
  for (const p of proposals.slice(0, 30)) out.push(`- ${p.type} by ${oneLine(p.proposedBy, 60)} [${p.status}]: ${oneLine(p.reason, 160)}`)
  out.push('')

  out.push('## Files changed', '')
  if (input.git) {
    out.push(`Integration branch: ${input.git.integrationBranch ?? 'none'}${input.git.integrationHead ? ` at ${input.git.integrationHead.slice(0, 12)}` : ''}`)
    out.push(list(input.git.filesChanged.slice(0, 200).map((f) => `- ${f}`), '- no files changed on the integration branch'))
    if (input.git.filesChanged.length > 200) out.push(`- ... ${input.git.filesChanged.length - 200} more`)
  } else out.push('Git state was not captured.')
  out.push('')

  out.push('## Commits', '')
  if (input.git) {
    out.push(list(input.git.commits.map((c) => `- ${c.sha.slice(0, 12)} ${oneLine(c.subject, 120)}`), '- no commits on the integration branch'))
    if (input.git.checkpointCommits.length > 0) {
      out.push('', 'Unfinished work committed on task branches during finalization:')
      for (const c of input.git.checkpointCommits) out.push(`- \`${c.task}\` on ${c.branch}: ${c.commit.slice(0, 12)}`)
    }
    out.push('', `Your checkout (${input.git.projectRoot}): branch ${input.git.branch ?? 'n/a'}, ${input.git.status ? (input.git.status.clean ? 'clean' : 'has local changes (untouched by NEXUS)') : 'status unavailable'}.`)
    out.push('NEXUS does not merge into your branch. Merge the integration branch yourself after reviewing it.')
    if (input.git.error) out.push(`Git capture problem: ${oneLine(input.git.error, 300)}`)
  }
  out.push('')

  out.push('## Remaining issues', '')
  const open = tasks.filter((t) => t.state !== 'completed' && t.state !== 'cancelled')
  out.push(
    list(
      open.map((t) => `- \`${t.key}\` [${t.state}]${t.error ? ` ${oneLine(t.error.what, 120)}${t.error.why ? `: ${oneLine(t.error.why, 160)}` : ''}` : ''}${t.blockedReason ? ` blocked: ${oneLine(t.blockedReason, 160)}` : ''}`),
      '- none: every task is completed or cancelled',
    ),
  )
  const failedCriteria = repos.criteria.listByRun(run.id).filter((c) => c.status === 'failed')
  for (const c of failedCriteria.slice(0, 30)) out.push(`- criterion not met: ${oneLine(c.text, 200)}`)
  out.push('')

  if (record.quota) {
    out.push('## Usage limit', '')
    out.push(`Paused at ${record.quota.pausedAt}; reset reported: ${fmt(record.quota.resetsAt)}; waits: ${record.quota.waits}.`, '')
  }

  if (record.watchdog.length > 0) {
    out.push('## Watchdog', '')
    for (const d of record.watchdog) out.push(`- ${d.at} ${d.stage}: ${oneLine(d.detail, 200)} (run ${d.runState}, active agents ${d.activeAgents}, tasks ${JSON.stringify(d.tasks)})`)
    out.push('')
  }

  out.push('## Policy', '')
  out.push(`- Authorized at: ${record.authorization.authorizedAt} ("${record.authorization.confirmation}")`)
  out.push(`- End action: ${policy.endAction}; applies on: ${Object.entries(policy.shutdownOn).filter(([, v]) => v).map(([k]) => k).join(', ') || 'nothing'}`)
  out.push(`- Final delay: ${policy.finalDelaySeconds} s; force close applications: ${policy.forceCloseApplications ? 'yes' : 'no'}`)
  out.push(`- Budgets: ${policy.budgets.maxAgentSessions} sessions, ${policy.budgets.maxTotalRepairs} repairs; quota policy: ${policy.quotaPolicy}`)
  for (const a of record.amendments) out.push(`- Changed by the user at ${a.at}: ${a.change}`)
  out.push('')

  out.push('## Power action', '')
  out.push(input.powerPlan, '')

  out.push('## Failsafe', '')
  if (record.failsafe) {
    out.push(`- Armed at: ${record.failsafe.scheduledAt} (accepted: ${record.failsafe.result.ok ? 'yes' : 'no'})`)
    out.push(`- Deadline: ${record.failsafe.deadline}`)
    out.push(`- Cancelled at: ${fmt(record.failsafe.cancelledAt)}`)
    if (record.failsafe.lostAt) out.push(`- Lost at: ${record.failsafe.lostAt} (Windows restarted)`)
  } else out.push('- Not armed.')
  out.push('')

  out.push('## Final shutdown', '')
  out.push('Recorded below once the power action is scheduled.', '')
  return out.join('\n')
}

/** Appended after the power step; the report itself is saved before any power action is scheduled. */
export function powerAddendum(record: OvernightRun): string {
  const lines = ['', '### Power action result', '']
  if (record.failsafe) lines.push(`- Failsafe cancelled at: ${fmt(record.failsafe.cancelledAt)}`)
  const action = record.powerAction
  if (action) {
    lines.push(`- Action: ${action.action} (${action.forced ? 'forced close' : 'normal close'}, ${action.mechanism === 'os_timer' ? 'Windows timer' : 'NEXUS countdown'})`)
    lines.push(`- Scheduled at: ${action.scheduledAt}`)
    lines.push(`- Takes effect at: ${action.executeAt}`)
    if (action.result) lines.push(`- Command accepted: ${action.result.ok ? 'yes' : `no (exit ${action.result.exitCode ?? 'n/a'}: ${oneLine(action.result.output, 200)})`}`)
  } else lines.push('- No power action was scheduled.')
  if (record.error) lines.push(`- Problem: ${oneLine(record.error, 300)}`)
  lines.push('')
  return lines.join('\n')
}

/** Durable facts a crash recovery starts from. */
export function buildCheckpoint(repos: Repositories, run: Run): RunCheckpoint['snapshot'] {
  const tasks = repos.tasks.listByRun(run.id)
  const agents = repos.agents.listByRun(run.id)
  const checks = repos.verifications.listByRun(run.id).filter((v) => v.kind === 'checks')
  return {
    runState: run.state,
    graphVersion: repos.graphRevisions.listByRun(run.id).at(-1)?.version ?? null,
    integrationBranch: run.integrationBranch,
    tasks: tasks.map((t) => ({ id: t.id, key: t.key, state: t.state, leaseOwner: t.leaseOwner, branch: t.branch, repairCycles: t.repairCycles })),
    worktrees: repos.worktrees.listByRun(run.id).map((w) => ({ id: w.id, taskId: w.taskId, branch: w.branch, state: w.state })),
    sessions: agents.flatMap((a) => repos.sessions.listByAgent(a.id).map((s) => ({ agentId: a.id, sdkSessionId: s.sdkSessionId, state: s.state }))),
    messages: repos.messages.listByRun(run.id).length,
    decisions: repos.decisions.listByRun(run.id).length,
    lastChecks: (checks.at(-1)?.commands ?? []).map((c) => ({ name: c.name, exitCode: c.exitCode })),
  }
}
