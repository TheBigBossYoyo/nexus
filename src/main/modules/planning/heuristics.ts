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

/** Items in a numbered or bulleted list, or the longest short-phrase "a, b and c" list on one line. */
export function countDeliverables(prompt: string): number {
  let markers = 0
  let longestList = 0
  for (const line of prompt.split(/\r?\n/)) {
    if (/^\s*(?:\d+[.)]|[-*•])\s+\S/.test(line)) {
      markers++
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
  return Math.max(markers, longestList)
}

/** Suggest consensus planning for long, multi-area prompts on larger repositories; otherwise one planner. */
export function recommendPlanningMode(
  prompt: string,
  profile: ProjectProfile | null,
): PlanningRecommendation {
  const reasons: string[] = []
  let score = 0

  const length = prompt.trim().length
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

  const lower = prompt.toLowerCase()
  const hits = BREADTH_KEYWORDS.filter((k) => lower.includes(k))
  if (hits.length >= 2) {
    score += 2
    reasons.push(`Broad scope keywords: ${hits.join(', ')}.`)
  } else if (hits.length === 1) {
    score += 1
    reasons.push(`Broad scope keyword: ${hits[0]}.`)
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
