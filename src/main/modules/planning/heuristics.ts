import type { ProjectProfile } from '@shared/domain'

export interface PlanningRecommendation {
  mode: 'single' | 'consensus'
  reasons: string[]
}

export interface PlannerLens {
  label: string
  lens: string
  guidance: string
}

/** Briefs for the three independent planners of consensus mode. */
export const PLANNER_LENSES: readonly PlannerLens[] = [
  {
    label: 'Planner A (risk-first)',
    lens: 'risk-first',
    guidance:
      'Plan for what can go wrong. Order work so the riskiest and least certain parts happen early, isolate them in their own tasks, give every risky task strong acceptance criteria and a verification step, and prefer reversible steps.',
  },
  {
    label: 'Planner B (parallelism-first)',
    lens: 'parallelism-first',
    guidance:
      'Plan for throughput. Split work into independent tasks that touch disjoint files so many agents can run at once, keep dependency chains short, and put shared interfaces in an early task so the rest can proceed in parallel.',
  },
  {
    label: 'Planner C (minimal-change)',
    lens: 'minimal-change',
    guidance:
      'Plan for the smallest correct change. Reuse existing code and conventions, touch as few files as possible, avoid new abstractions and refactors the goal does not need, and keep the task count low.',
  },
]

const BREADTH_KEYWORDS = [
  'refactor',
  'migrate',
  'migration',
  'architecture',
  'security',
  'across',
  'multiple',
  'redesign',
  'rewrite',
  'overhaul',
  'end-to-end',
]

const LONG_PROMPT_CHARS = 600
const VERY_LONG_PROMPT_CHARS = 1500
const LARGE_REPO_FILES = 500
const VERY_LARGE_REPO_FILES = 2000
const CONSENSUS_SCORE = 3

const CONSTRAINT_HEADING = /^(?:constraints?|rules?|restrictions?|limits?|do not|don't|never|notes?|tests?|testing|verification|checks?|style)\b/i
const INSTRUCTION_BULLET = /^(?:do not|don't|never|avoid|run|keep|follow|use|leave|no )\b/i
/** File paths a prompt names (`src/x/y.ts`, `run.css`). */
const FILE_MENTION = /(?:^|[\s`'"(])((?:[\w.-]+\/)*[\w.-]+\.(?:[cm]?[jt]sx?|css|scss|json|md|py|rs|go|java|kt|cs|cpp|h|vue|svelte|html|ya?ml|toml|sql))\b/g

/**
 * The part of a prompt that says what to build: the constraint sections and the instruction bullets left out
 * ("Do not change the database migrations" is not a migration). Length and scope keywords are read from it.
 */
export function buildPart(prompt: string): string {
  const kept: string[] = []
  let constraints = false
  for (const line of prompt.split(/\r?\n/)) {
    const bullet = /^\s*(?:\d+[.)]|[-*•])\s+(\S.*)$/.exec(line)
    if (bullet === null && /:\s*$/.test(line.trim())) {
      constraints = CONSTRAINT_HEADING.test(line.trim())
      if (!constraints) kept.push(line)
      continue
    }
    if (constraints && (bullet !== null || line.trim() === '')) continue
    if (constraints) constraints = false
    if (bullet !== null && INSTRUCTION_BULLET.test(bullet[1] ?? '')) continue
    kept.push(line)
  }
  return kept.join('\n')
}

/** Items in a numbered or bulleted list, or the longest short-phrase "a, b and c" list on one line. */
export function countDeliverables(prompt: string): number {
  let longestList = 0
  // 0.9.1: what a prompt forbids or asks to run is not something to build. A precise prompt lists its constraints
  // as bullets too, and those made a detailed request look like a broad one (and pick the costly planning).
  let constraints = false
  // The indentation of each bullet that says what to build: the details of one item (its sub-bullets) are not more items.
  const indents: number[] = []
  for (const line of prompt.split(/\r?\n/)) {
    const bullet = /^(\s*)(?:\d+[.)]|[-*•])\s+(\S.*)$/.exec(line)
    if (bullet === null && /:\s*$/.test(line.trim())) {
      constraints = CONSTRAINT_HEADING.test(line.trim())
      continue
    }
    if (bullet !== null) {
      if (!constraints && !INSTRUCTION_BULLET.test(bullet[2] ?? '')) indents.push((bullet[1] ?? '').replace(/\t/g, '    ').length)
      continue
    }
    const parts = line
      .split(/,|;|\band\b|&/i)
      .map((p) => p.trim())
      .filter((p) => p.length > 0)
    if (parts.length >= 3 && parts.every((p) => p.split(/\s+/).length <= 6)) {
      longestList = Math.max(longestList, parts.length)
    }
  }
  const outer = indents.length > 0 ? Math.min(...indents) : 0
  const markers = indents.filter((i) => i === outer).length
  return Math.max(markers, longestList)
}

/** Suggest consensus planning for long, multi-area prompts on larger repositories; otherwise one planner. */
export function recommendPlanningMode(
  prompt: string,
  profile: ProjectProfile | null,
): PlanningRecommendation {
  const reasons: string[] = []
  let score = 0
  // What to build, without the constraints: the length and the scope keywords are its.
  const build = buildPart(prompt)

  const length = build.trim().length
  if (length >= VERY_LONG_PROMPT_CHARS) {
    score += 2
    reasons.push(`Very long prompt (${length} characters).`)
  } else if (length >= LONG_PROMPT_CHARS) {
    score += 1
    reasons.push(`Long prompt (${length} characters).`)
  } else {
    reasons.push(`Short prompt (${length} characters).`)
  }

  const deliverables = countDeliverables(prompt)
  if (deliverables >= 5) {
    score += 2
    reasons.push(`Many distinct deliverables (${deliverables}).`)
  } else if (deliverables >= 3) {
    score += 1
    reasons.push(`Several distinct deliverables (${deliverables}).`)
  } else {
    reasons.push(`Few distinct deliverables (${deliverables}).`)
  }

  const lower = build.toLowerCase()
  // Whole words only: `security_reviewer`, an identifier the prompt names, is not a security task (0.9.1).
  const hits = BREADTH_KEYWORDS.filter((k) => new RegExp(`(?<![\\w])${k}(?![\\w])`).test(lower))
  if (hits.length >= 2) {
    score += 2
    reasons.push(`Broad scope keywords: ${hits.join(', ')}.`)
  } else if (hits.length === 1) {
    score += 1
    reasons.push(`Broad scope keyword: ${hits[0]}.`)
  }

  // 0.9.1: a prompt that names the files it is about has already done part of a planner's work.
  const named = new Set([...prompt.matchAll(FILE_MENTION)].map((m) => m[1])).size
  if (named >= 3) {
    score -= 2
    reasons.push(`Names the files to work on (${named}): the work is located.`)
  } else if (named >= 1) {
    score -= 1
    reasons.push(`Names ${named} file(s) to work on.`)
  }

  if (profile === null) {
    reasons.push('No repository profile available; repository size not considered.')
  } else if (profile.fileCount >= VERY_LARGE_REPO_FILES) {
    score += 2
    reasons.push(`Very large repository (${profile.fileCount} files).`)
  } else if (profile.fileCount >= LARGE_REPO_FILES) {
    score += 1
    reasons.push(`Large repository (${profile.fileCount} files).`)
  } else {
    reasons.push(`Small repository (${profile.fileCount} files).`)
  }

  const mode = score >= CONSENSUS_SCORE ? 'consensus' : 'single'
  reasons.push(
    mode === 'consensus'
      ? `Score ${score} >= ${CONSENSUS_SCORE}: independent planners are worth the extra cost.`
      : `Score ${score} < ${CONSENSUS_SCORE}: a single planner is enough.`,
  )
  return { mode, reasons }
}
