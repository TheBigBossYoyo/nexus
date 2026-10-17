import type { PersistenceChange, PersistenceCoverage, PersistenceReport, PrivilegeSessionStatus,PrivilegedOperationReceipt, PrivilegedOperationReview, PrivilegedOutcome } from '@shared/privilege'
import type { ReceiptChainVerification } from './chain'

/**
 * 0.9.1: the PRIVILEGED ACTIVITY report (B12 to B14). Every privileged attempt of a run or a session, what it was
 * for, why it needed administrator rights, what the reviews and the policy said, the exact command as it may be
 * shown (secrets replaced), what was expected and what was seen, how it ended. The morning report carries the short
 * form; the Activity screen the full one. Nothing here is a model's words except the reviews' short reasons.
 */

const OUTCOME_TEXT: Record<PrivilegedOutcome, string> = {
  EXECUTED: 'SUCCESS',
  FAILED: 'FAILED',
  TIMEOUT: 'TIMED OUT',
  ABORTED: 'ABORTED',
  REJECTED_BY_POLICY: 'REJECTED BY POLICY',
  REJECTED_BY_DIRECTOR: 'REJECTED BY REVIEW',
  DECLINED_BY_OWNER: 'DECLINED BY YOU',
  EXECUTING: 'RUNNING (OR STOPPED WITH NEXUS)',
}

const time = (iso: string): string => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** A command as it may be shown: arguments quoted where they need it. */
export function shownCommand(r: Pick<PrivilegedOperationReceipt, 'executable' | 'args'>): string {
  const q = (a: string): string => (a === '' || /[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)
  return [r.executable, ...r.args].map(q).join(' ')
}

function reviewLine(reviews: readonly PrivilegedOperationReview[], councilRequired: boolean): string {
  const technical = reviews.find((r) => r.reviewer === 'CLAUDE_TECHNICAL_DIRECTOR')
  const council = reviews.find((r) => r.reviewer === 'DIRECTOR_COUNCIL')
  const t = technical ? `Claude Technical Director ${technical.failed ? 'gave no valid review' : `${technical.verdict === 'APPROVE' ? 'APPROVED' : technical.verdict} (risk ${technical.risk})`}` : 'Not reviewed (refused before review)'
  const c = council ? `Council ${council.failed ? 'gave no valid review' : `${council.verdict === 'APPROVE' ? 'APPROVED' : council.verdict} (risk ${council.risk})`}` : councilRequired ? 'Council required, not reached' : 'Council not required'
  return `${t}. ${c}.`
}

export function countsOf(receipts: readonly PrivilegedOperationReceipt[]): Record<PrivilegedOutcome, number> {
  const out: Record<PrivilegedOutcome, number> = { EXECUTED: 0, FAILED: 0, TIMEOUT: 0, ABORTED: 0, REJECTED_BY_POLICY: 0, REJECTED_BY_DIRECTOR: 0, DECLINED_BY_OWNER: 0, EXECUTING: 0 }
  for (const r of receipts) out[r.outcome]++
  return out
}

function headline(receipts: readonly PrivilegedOperationReceipt[]): string {
  const c = countsOf(receipts)
  const ran = c.EXECUTED + c.FAILED + c.TIMEOUT
  const refused = c.REJECTED_BY_POLICY + c.REJECTED_BY_DIRECTOR + c.DECLINED_BY_OWNER
  const parts = [`${ran} run`, ...(c.FAILED + c.TIMEOUT > 0 ? [`${c.FAILED + c.TIMEOUT} of them failed`] : []), ...(refused > 0 ? [`${refused} refused`] : []), ...(c.ABORTED > 0 ? [`${c.ABORTED} aborted`] : [])]
  return `${receipts.length} privileged attempt${receipts.length === 1 ? '' : 's'}: ${parts.join(', ')}.`
}

function sessionLines(sessions: readonly PrivilegeSessionStatus[]): string[] {
  return sessions.map(
    (s) =>
      `- Session ${s.id.slice(0, 8)} (${s.scope.toLowerCase().replace(/_/g, ' ')}): ${s.state.toLowerCase()}; UAC prompts: ${s.uacPrompts}; prepared ${time(s.createdAt)}${s.endedAt ? `, ended ${time(s.endedAt)} (${s.endReason ?? 'no reason recorded'})` : ', still active'}${s.elevated ? '' : s.state === 'ACTIVE' || s.state === 'ENDED' ? ' — NOT elevated (protocol test)' : ''}.`,
  )
}

/**
 * 0.9.1 (second review, L11): what an agent or a program wrote, as one line of plain text in the report: its line
 * breaks and Markdown removed, so that it cannot make lines of its own (a fake "DECLINED BY YOU").
 */
export function inline(text: string): string {
  return text.replace(/[\r\n]+/g, ' ').replace(/([\\`*_#>|<[\]~])/g, '\\$1')
}

/** A receipt with every field an agent, a reviewer or a program wrote made inline text. */
function shown(r: PrivilegedOperationReceipt): PrivilegedOperationReceipt {
  const t = (s: string | null): string | null => (s === null ? null : inline(s))
  return {
    ...r,
    goal: inline(r.goal),
    whyRequired: inline(r.whyRequired),
    whyElevation: inline(r.whyElevation),
    whyNoUnelevatedAlternative: inline(r.whyNoUnelevatedAlternative),
    rollback: inline(r.rollback),
    missionTitle: t(r.missionTitle),
    taskTitle: t(r.taskTitle),
    outcomeReason: inline(r.outcomeReason),
    observed: r.observed.map(inline),
    expected: { ...r.expected, files: r.expected.files.map(inline), registry: r.expected.registry.map(inline), services: r.expected.services.map(inline), network: inline(r.expected.network) },
    reviews: r.reviews.map((v) => ({ ...v, reason: inline(v.reason), restrictions: v.restrictions.map(inline) })),
    precheck: { ...r.precheck, reason: inline(r.precheck.reason) },
    finalPolicy: r.finalPolicy ? { ...r.finalPolicy, reason: inline(r.finalPolicy.reason) } : null,
    ...(r.persistence ? { persistence: shownPersistence(r.persistence) } : {}),
  }
}

const attrsShown = (a: Record<string, string> | undefined): Record<string, string> | undefined =>
  a === undefined ? undefined : Object.fromEntries(Object.entries(a).map(([k, v]) => [inline(k), inline(v)]))

const coverageShown = (c: PersistenceCoverage): PersistenceCoverage =>
  Object.fromEntries(Object.entries(c).map(([k, v]) => [k, v.note === undefined ? { state: v.state } : { state: v.state, note: inline(v.note) }])) as PersistenceCoverage

/** The persistence field with every string an installer could have chosen made inline text. */
function shownPersistence(p: PersistenceReport): PersistenceReport {
  return {
    ...p,
    changes: p.changes.map((c) => {
      const before = attrsShown(c.before)
      const after = attrsShown(c.after)
      return { ...c, id: inline(c.id), ...(before ? { before } : {}), ...(after ? { after } : {}) }
    }),
    coverageBefore: coverageShown(p.coverageBefore),
    coverageAfter: coverageShown(p.coverageAfter),
    note: inline(p.note),
  }
}

const PERSISTENCE_NOTE = 'These differences were observed during the operation and are not proven to have been caused by it; coverage is limited to what an unelevated user can read.'

const attrText = (a: Record<string, string> | undefined): string => {
  const e = Object.entries(a ?? {})
  return e.length ? e.map(([k, v]) => `${k}=${v}`).join('; ') : '(none)'
}

function persistenceLines(p: PersistenceReport): string[] {
  const n = (k: PersistenceChange['change']): number => p.changes.filter((c) => c.change === k).length
  const out = [`- Persistence: ${n('ADDED')} added, ${n('REMOVED')} removed, ${n('CHANGED')} changed${p.changes.some((c) => !c.expected) ? `, ${p.changes.filter((c) => !c.expected).length} UNEXPECTED (not declared)` : ''}`]
  for (const c of p.changes) out.push(`  - ${c.surface} ${c.id}: ${c.change}; ${attrText(c.before)} → ${attrText(c.after)}${c.expected ? '' : ' — UNEXPECTED (not declared)'}`)
  for (const [when, cov] of [['before', p.coverageBefore], ['after', p.coverageAfter]] as const)
    for (const [surface, v] of Object.entries(cov)) if (v.state !== 'COMPLETE') out.push(`  - Coverage ${when}: ${surface} ${v.state}${v.note ? ` (${v.note})` : ''}`)
  out.push(`  - ${PERSISTENCE_NOTE}`)
  return out
}

const unexpectedCount = (r: PrivilegedOperationReceipt): number => (r.persistence ? r.persistence.changes.filter((c) => !c.expected).length : 0)

/** The summary's one persistence line: the counts and any coverage that was not COMPLETE; null when there is nothing to say. */
function persistenceSummaryLine(p: PersistenceReport): string | null {
  const n = (k: PersistenceChange['change']): number => p.changes.filter((c) => c.change === k).length
  const u = p.changes.filter((c) => !c.expected).length
  const gaps: string[] = []
  for (const [when, cov] of [['before', p.coverageBefore], ['after', p.coverageAfter]] as const)
    for (const [surface, v] of Object.entries(cov)) if (v.state !== 'COMPLETE') gaps.push(`${surface} ${v.state} (${when})`)
  if (p.changes.length === 0 && gaps.length === 0) return null
  const counts = `${n('ADDED')} added, ${n('REMOVED')} removed, ${n('CHANGED')} changed${u > 0 ? `, ${u} UNEXPECTED change${u === 1 ? '' : 's'} (not declared)` : ''}`
  return `Persistence: ${counts}, observed during the operation.${gaps.length ? ` Coverage not complete: ${gaps.join(', ')}.` : ''}`
}

/** Inline code no text inside can close, on one line. */
function codeSpan(text: string): string {
  const flat = text.replace(/[\r\n]+/g, ' ')
  const longest = Math.max(0, ...[...flat.matchAll(/`+/g)].map((m) => m[0].length))
  const tick = '`'.repeat(longest + 1)
  return `${tick} ${flat} ${tick}`
}

/** A code block no text inside can close: its fence is longer than any run of backticks in it. */
function fenced(text: string): string[] {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length))
  const fence = '`'.repeat(Math.max(3, longest + 1))
  return [fence, text, fence]
}

/** The integrity verdict of the record, printed first. A BROKEN record is never left out, nor any of its findings. */
function integrityLines(integrity: ReceiptChainVerification): string[] {
  if (integrity.state === 'UNAVAILABLE') return [`Record integrity: not verified — ${inline(integrity.reason ?? 'the record could not be checked')}`, '']
  if (integrity.state === 'INTACT') {
    const extra = [
      ...(integrity.legacy > 0 ? [`${integrity.legacy} recorded before the chain existed`] : []),
      ...(integrity.pending > 0 ? [`${integrity.pending} pending`] : []),
      ...(integrity.evicted > 0 ? [`${integrity.evicted} evicted refusals`] : []),
    ]
    return [`Record integrity: intact — ${integrity.verified} receipt${integrity.verified === 1 ? '' : 's'} verified${extra.length ? `, ${extra.join(', ')}` : ''}.`, '']
  }
  const last = integrity.lastVerifiedChainSeq === null ? 'none' : String(integrity.lastVerifiedChainSeq)
  const count = integrity.findings.length
  const lines = [`Record integrity: BROKEN — the record was changed after it was written. Last verified position ${last}. ${count} finding${count === 1 ? '' : 's'}:`, '']
  for (const f of integrity.findings) {
    const where = [f.receiptId !== null ? `receipt ${codeSpan(f.receiptId)}` : null, f.chainSeq !== null ? `chain position ${f.chainSeq}` : null].filter((x) => x !== null).join(', ')
    lines.push(`- ${f.kind}${where ? ` — ${where}` : ''}: ${inline(f.detail)}`)
  }
  lines.push('')
  return lines
}

/** The full report: every attempt with every field (the Activity screen, the report file). */
export function buildPrivilegedActivityReport(receipts: readonly PrivilegedOperationReceipt[], sessions: readonly PrivilegeSessionStatus[], integrity: ReceiptChainVerification): string {
  const out = ['## Privileged activity', '', ...integrityLines(integrity)]
  if (sessions.length === 0 && receipts.length === 0) return [...out, 'No privilege session was prepared and no administrator operation was asked for.', ''].join('\n')
  out.push(headline(receipts), '', ...sessionLines(sessions), '')
  for (const raw of receipts) {
    const r = shown(raw)
    out.push(`### ${time(r.requestedAt)} — ${r.capability} — ${OUTCOME_TEXT[r.outcome]}`, '')
    out.push(`- Mission: ${r.missionTitle ?? r.runId ?? '—'}`, `- Task: ${r.taskTitle ?? r.taskId ?? '—'}`, `- Requested by: ${r.role}${r.agentId ? ` (${r.agentId.slice(0, 8)})` : ''}; provenance: ${r.provenance}`)
    if (r.followsOperationId) out.push(`- Follows operation: ${r.followsOperationId}`)
    out.push(`- Goal: ${r.goal}`, `- Why it was required: ${r.whyRequired}`, `- Why elevation was required: ${r.whyElevation}`, `- Why no unelevated alternative: ${r.whyNoUnelevatedAlternative}`)
    out.push(`- Security review: ${reviewLine(r.reviews, r.precheck.councilRequired)}`)
    for (const v of r.reviews) out.push(`  - ${v.reviewer === 'DIRECTOR_COUNCIL' ? 'Council' : 'Technical'}: ${v.reason}${v.restrictions.length ? ` Restrictions: ${v.restrictions.join('; ')}.` : ''}`)
    out.push(`- Deterministic policy: precheck ${r.precheck.verdict} (${r.precheck.reason})${r.finalPolicy ? `; final ${r.finalPolicy.verdict} (${r.finalPolicy.reason})` : ''}`)
    if (r.precheck.councilWhy.length) out.push(`- Council asked because: ${r.precheck.councilWhy.join('; ')}`)
    out.push(`- Command: ${codeSpan(shownCommand(r))}`, `- Working directory: ${r.cwd ?? '(the broker\'s own staging folder)'}`, `- Environment set: ${r.envNames.length ? r.envNames.join(', ') : 'none beyond the machine\'s own'}`)
    out.push(`- Expected: files ${r.expected.files.join(', ') || 'none'}; registry ${r.expected.registry.join(', ') || 'none'}; services/tasks ${r.expected.services.join(', ') || 'none'}; network ${r.expected.network}`)
    out.push(`- Observed: ${r.observed.length ? r.observed.join(' ') : 'nothing recorded'}`)
    if (r.persistence) out.push(...persistenceLines(r.persistence))
    out.push(`- Result: ${OUTCOME_TEXT[r.outcome]} — ${r.outcomeReason}${r.exitCode !== null ? ` Exit code ${r.exitCode}.` : ''}${r.durationMs !== null ? ` Duration ${(r.durationMs / 1000).toFixed(1)} s.` : ''}`)
    if (r.rollback) out.push(`- Rollback: ${r.rollback}`)
    out.push(`- Evidence: receipt ${r.id}${r.stagedSha256 ? `; program SHA-256 ${r.stagedSha256}` : ''}`)
    if (r.stderr.trim()) out.push('', ...fenced(r.stderr.trim().slice(0, 1500)))
    out.push('')
  }
  return out.join('\n')
}

/** The short form for the morning report and the Director Line: one block per attempt, the essentials. */
export function buildPrivilegedActivitySummary(receipts: readonly PrivilegedOperationReceipt[], sessions: readonly PrivilegeSessionStatus[], integrity: ReceiptChainVerification): string {
  const out = ['## Privileged activity', '', ...integrityLines(integrity)]
  if (sessions.length === 0 && receipts.length === 0) return [...out, 'No administrator access was prepared for this run.', ''].join('\n')
  const uac = sessions.reduce((n, s) => n + s.uacPrompts, 0)
  out.push(`${headline(receipts)} UAC prompts: ${uac}.${sessions.some((s) => s.state === 'ACTIVE') ? ' A broker is still active.' : ' No broker is left running.'}`, '')
  for (const raw of receipts) {
    const r = shown(raw)
    // A malformed request (L9) may have given no goal.
    out.push(`**${time(r.requestedAt)} — ${r.goal || '(no goal given)'}** (${r.capability})`)
    out.push(`Why admin: ${r.whyElevation}`)
    out.push(`Security review: ${reviewLine(r.reviews, r.precheck.councilRequired)} Deterministic policy: ${r.finalPolicy?.verdict ?? r.precheck.verdict}.`)
    out.push(`Command: ${codeSpan(shownCommand(r))}`)
    out.push(`Result: ${OUTCOME_TEXT[r.outcome]}${r.exitCode !== null ? ` (exit ${r.exitCode})` : ''} — ${r.outcomeReason}${r.observed.length ? ` Changed/seen: ${r.observed.join(' ')}` : ''}`)
    const p = r.persistence ? persistenceSummaryLine(r.persistence) : null
    if (p) out.push(p)
    out.push('')
  }
  const total = receipts.reduce((s, r) => s + unexpectedCount(r), 0)
  if (total > 0) out.push(`Unexpected persistence changes in total: ${total}.`, '')
  return out.join('\n')
}

/** What the Director says when asked what ran as administrator. */
export function privilegedActivitySpoken(receipts: readonly PrivilegedOperationReceipt[]): string {
  if (receipts.length === 0) return 'Nothing ran as administrator.'
  const ran = receipts.filter((r) => r.outcome === 'EXECUTED' || r.outcome === 'FAILED' || r.outcome === 'TIMEOUT')
  const refused = receipts.filter((r) => r.outcome === 'REJECTED_BY_POLICY' || r.outcome === 'REJECTED_BY_DIRECTOR')
  const parts = [`${ran.length} administrator operation${ran.length === 1 ? '' : 's'} ran${refused.length ? ` and ${refused.length} request${refused.length === 1 ? ' was' : 's were'} refused` : ''}.`]
  for (const r of ran.slice(-5)) parts.push(`At ${time(r.requestedAt)}: ${r.goal} — ${OUTCOME_TEXT[r.outcome].toLowerCase()}.`)
  if (refused.length) parts.push(`Refused: ${refused.slice(-3).map((r) => `${r.goal} (${r.outcomeReason})`).join(' ')}`)
  return parts.join(' ')
}
