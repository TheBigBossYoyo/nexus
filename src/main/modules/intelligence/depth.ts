import type { CompilationMode } from '@shared/intelligence'
import type { StrategyStatistic } from '@shared/v3'
import { fileMentions, profileTask } from '@main/modules/policy/profiler'
import { buildPart } from '@main/modules/planning/heuristics'

/**
 * The depth AUTO gives a request: the least that is enough for it.
 *
 * AUTO used to read five words. Any request that said "refactor" was compiled with two providers and any that
 * said "security" with a council, however small and exact it was; everything else got the strategic provider
 * unless it said "typo". In the real campaign that cost 18% more agent turns and input than the same missions
 * admitted as written, with the same result.
 *
 * The depth now follows the task profile that the strategy policy already uses (category, complexity, risk,
 * file scope, ambiguity, security sensitivity; deterministic, from the request alone), in this order:
 *
 * - COUNCIL: a high-risk or security-sensitive change that is also broad or changes the design.
 * - TECHNICAL: work whose shape depends on the repository: a workspace, an architecture or a migration, a large
 *   task, or a broad one that is not precisely stated; and a risky task that is vague.
 * - STANDARD: a risky or security-sensitive task that is bounded; and everything not listed elsewhere.
 * - LIGHT: a localized task with low risk that says precisely what is wanted: it names the one to three files
 *   it is about and is not vague. It asks no provider and adds one line; nothing a model wrote stands between
 *   the request and the planner.
 *
 * Recorded evidence can raise a depth and never lowers one: where Arena trials or finished missions of the same
 * kind of task have a low pass rate here on moderate or strong evidence, a task that would be LIGHT is developed
 * with the strategic provider after all. No trial compares depths with each other yet, so nothing else is
 * decided by evidence.
 *
 * EXACT is never chosen here: it is the user's own override.
 */
export const DEPTH_POLICY_VERSION = 'depth-2'

/** Below this upper bound of the 95% interval on the pass rate, work of this kind is taken to fail often here. */
export const LOW_PASS_UPPER_BOUND = 0.6

export interface DepthDecision {
  mode: Exclude<CompilationMode, 'AUTO' | 'EXACT'>
  reasons: string[]
}

const MECHANICAL = /\b(typo|spelling|rename label)\b/i
/** Putting something in front of users: with high risk it is a major change however few words ask for it. */
const RELEASE = /\b(release|deploy\w*|publish|ship|roll ?out)\b.{0,80}\b(production|prod|public|live|customers|users)\b/i
/** Words of an attack, or of a boundary that keeps one out, beyond the profiler's list: such a task is never LIGHT. */
const ATTACK_SURFACE = /\b(traversal|escap\w* (?:the )?(?:root|sandbox)|exploit\w*|privilege\w*|untrusted|malicious|attack\w*|sandbox\w*|denial of service|overflow)\b/i

export function compilationDepth(
  text: string,
  options: { workspace?: boolean; statistics?: readonly StrategyStatistic[] } = {},
): DepthDecision {
  // 0.9.1: read from what the request asks to build, not from its constraints ("do not push or tag" is not a
  // release, "do not change the migrations" is not a migration): those made a small, precise request a COUNCIL one.
  const essential = buildPart(text)
  const profile = profileTask({ prompt: essential, profile: null, facts: [], ids: { id: 'depth', projectId: null, runId: null, arenaTrialId: null, createdAt: '' } })
  const f = profile.features
  const category = f.category.value, complexity = f.complexity.value, risk = f.risk.value
  const scope = f.fileScope.value, ambiguity = f.ambiguity.value
  const sensitive = f.securitySensitive.value || risk === 'high' || ATTACK_SURFACE.test(essential)
  const design = category === 'architecture' || category === 'migration'
  // The request itself says where the work is: one to three files, named.
  const named = fileMentions(text).length
  const anchored = named >= 1 && named <= 3
  // A request that names a few files and touches few is not large because it is long: its length is detail.
  const located = named >= 1 && named <= 8 && scope !== 'many'
  const broad = (complexity === 'large' && !located) || scope === 'many'
  // What was read from the request, kept with the specification: the decision can be checked, and outcomes can
  // later be compared by kind of task and depth.
  const read = `PROFILE:${profile.contextKey}:scope=${scope}:ambiguity=${ambiguity}${sensitive ? ':sensitive' : ''}`

  let mode: DepthDecision['mode']
  let reason: string
  if (sensitive && (broad || design || RELEASE.test(essential))) [mode, reason] = ['COUNCIL', 'MAJOR_HIGH_RISK_CHANGE']
  // 0.9.1: a long request that names the files it changes and leaves little open is detailed, not broad: its
  // length is precision. (A mission naming eight files of one panel took the technical depth, with several
  // Director passes, for a change its worker made in a minute and a half.)
  else if (!options.workspace && !design && named >= 1 && named <= 8 && ambiguity !== 'high' && !(anchored && ambiguity === 'low' && risk === 'low') && !(MECHANICAL.test(text) && text.length < 250)) [mode, reason] = ['STANDARD', 'NAMED_FILES_WELL_SPECIFIED']
  else if (options.workspace || design || complexity === 'large' || (scope === 'many' && ambiguity !== 'low')) [mode, reason] = ['TECHNICAL', 'REPOSITORY_DEPENDENT_BREADTH']
  else if (sensitive) [mode, reason] = ambiguity === 'high' ? ['TECHNICAL', 'HIGH_RISK_UNDERSPECIFIED'] : ['STANDARD', 'HIGH_RISK_BOUNDED']
  else if (MECHANICAL.test(text) && text.length < 250) [mode, reason] = ['LIGHT', 'LOCAL_MECHANICAL_TASK']
  else if (anchored && ambiguity === 'low' && risk === 'low') [mode, reason] = ['LIGHT', 'LOCALIZED_WELL_SPECIFIED_TASK']
  else [mode, reason] = ['STANDARD', 'ENGINEERING_REQUIREMENT_DEVELOPMENT']

  const reasons = [reason, read, `DEPTH_POLICY:${DEPTH_POLICY_VERSION}`]
  if (mode === 'LIGHT' && failsOftenHere(options.statistics ?? [], profile.contextKey)) {
    mode = 'STANDARD'
    reasons.push('RECORDED_EVIDENCE_LOW_PASS_RATE')
  }
  return { mode, reasons }
}

/** Moderate or strong evidence, for exactly this kind of task, that it passes less often than the bound. */
function failsOftenHere(statistics: readonly StrategyStatistic[], contextKey: string): boolean {
  return statistics.some((s) => s.contextKey === contextKey && (s.label === 'MODERATE' || s.label === 'STRONG') && s.passInterval !== null && s.passInterval.high < LOW_PASS_UPPER_BOUND)
}
