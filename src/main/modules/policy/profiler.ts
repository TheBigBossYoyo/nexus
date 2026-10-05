import type { Complexity, ProjectProfile, Risk } from '@shared/domain'
import type { RepositoryFact } from '@shared/v2'
import {
  contextKeyOf,
  type Feature,
  type FeatureBasis,
  type Level,
  type TaskCategory,
  type TaskProfile,
  type TaskProfileFeatures,
} from '@shared/v3'

/**
 * TaskProfiler. A pure function from (prompt, project profile, repository facts, user-specified fields)
 * to a TaskProfile. Its input type deliberately holds no Arena result, no outcome and no statistic, and
 * this file imports nothing from persistence, the Arena or policy learning (a test asserts it): what NEXUS
 * has learned must never leak into how a task is described, or the learning would grade its own input.
 *
 * Every rule below is a plain keyword or counting rule. They are exported so tests and docs can cite them.
 */

export const PROFILER_VERSION = 'profiler-v1'

export interface ProfilerInput {
  prompt: string
  profile: ProjectProfile | null
  facts: RepositoryFact[]
  /** Fields the user set explicitly. They win over every inference. */
  user?: Partial<{ category: TaskCategory; complexity: Complexity; risk: Risk }>
  ids: {
    id: string
    projectId: string | null
    runId: string | null
    arenaTrialId: string | null
    createdAt: string
  }
}

// ───────────────────────────── category ─────────────────────────────

export interface CategoryRule {
  category: TaskCategory
  /** Each match of `pattern` in the lower-cased prompt scores `weight`, up to MAX_MATCHES_PER_CATEGORY matches. */
  pattern: RegExp
  weight: number
}

export const MAX_MATCHES_PER_CATEGORY = 3

export const CATEGORY_RULES: readonly CategoryRule[] = [
  {
    category: 'security',
    pattern:
      /\b(security|secure|vulnerab\w*|cve|xss|csrf|sql injection|injection|sanitiz\w*|authenticat\w*|authoriz\w*|auth|permissions?|encrypt\w*|secrets?|credentials?|passwords?|exploit\w*)\b/g,
    // Security wording is deliberate: a bugfix in the auth flow is still security work.
    weight: 2,
  },
  {
    category: 'migration',
    pattern: /\b(migrat\w*|upgrade|port(?:ing)? to|convert(?:ing)? (?:the )?\w+ to|schema change|move (?:everything )?(?:from|to))\b/g,
    weight: 1.5,
  },
  {
    category: 'performance',
    pattern: /\b(performance|slow\w*|speed(?:ing)? up|optimi[sz]\w*|latency|faster|memory leak|throughput|cach(?:e|ing)|bottleneck)\b/g,
    weight: 1.5,
  },
  {
    category: 'architecture',
    pattern: /\b(architect\w*|re-?design|rewrite|from scratch|system design|microservices?|monolith|module boundar\w*)\b/g,
    weight: 1.5,
  },
  {
    category: 'infrastructure',
    pattern: /\b(ci|cd|pipelines?|docker\w*|kubernetes|k8s|terraform|github actions|deploy\w*|infrastructure|packaging|build system|release process)\b/g,
    weight: 1.5,
  },
  {
    category: 'testing',
    pattern: /\b(coverage|flaky|unit tests?|integration tests?|e2e tests?|add (?:more )?tests?|write (?:more )?tests?|test suite|test cases?)\b/g,
    weight: 1.5,
  },
  {
    category: 'ui',
    pattern: /\b(ui|ux|button|page|layout|css|styl(?:e|ing)|theme|dark mode|modal|dialog|screen|responsive|frontend|front-end|sidebar|tooltip|icon)\b/g,
    weight: 1,
  },
  {
    category: 'refactor',
    pattern: /\b(refactor\w*|clean ?up|restructur\w*|renam\w*|simplif\w*|extract\w*|dedup\w*|reorgani[sz]\w*|tidy)\b/g,
    weight: 1.5,
  },
  {
    category: 'bugfix',
    pattern: /\b(fix\w*|bugs?|crash\w*|broken|regress\w*|errors?|fail(?:s|ing|ure)?|not working|doesn'?t work|incorrect|wrong|typo|exception)\b/g,
    weight: 1,
  },
  {
    category: 'feature',
    pattern: /\b(add|implement\w*|create|build|introduce|support|new|feature|enable)\b/g,
    // The weakest signal: nearly every prompt contains one of these verbs.
    weight: 0.5,
  },
]

/** Wins score ties: earlier is preferred. */
export const CATEGORY_PRIORITY: readonly TaskCategory[] = [
  'security',
  'migration',
  'performance',
  'architecture',
  'infrastructure',
  'testing',
  'ui',
  'refactor',
  'bugfix',
  'feature',
]

export const DEFAULT_CATEGORY: TaskCategory = 'feature'

// ───────────────────────────── complexity ─────────────────────────────

/** Points added by the category before the prompt is read. */
export const CATEGORY_COMPLEXITY_BASE: Record<TaskCategory, number> = {
  bugfix: 0,
  testing: 0,
  refactor: 1,
  feature: 1,
  ui: 1,
  performance: 1,
  infrastructure: 1,
  security: 1,
  migration: 2,
  architecture: 3,
}

/** Prompt length in words → points. */
export const LENGTH_POINTS: readonly { minWords: number; points: number }[] = [
  { minWords: 150, points: 3 },
  { minWords: 60, points: 2 },
  { minWords: 15, points: 1 },
]

export const BREADTH_PATTERN =
  /\b(across|entire|whole|every|throughout|codebase|system-?wide|end-to-end|multiple|all (?:the )?(?:files|modules|components|tests|services))\b/g
export const NARROWING_PATTERN = /\b(typo|one-?line|tiny|trivial|small|simple|single|just|only|a variable)\b/g
export const DELIVERABLE_VERB_PATTERN =
  /\b(add|implement|create|fix|update|remove|refactor|write|migrate|replace|rename|build|support|document|extract)\b/g
export const LIST_ITEM_PATTERN = /^\s*(?:[-*•]|\d+[.)])\s+\S/gm
export const FILE_MENTION_PATTERN = /[\w./\\-]+\.(?:tsx?|jsx?|mjs|cjs|py|go|rs|java|kt|cs|rb|php|css|scss|html|json|ya?ml|toml|md|sql|sh)\b/gi

/** Complexity score → class. 0 small; 1 to 3 medium; 4 or more large. */
export const COMPLEXITY_THRESHOLDS = { medium: 1, large: 4 } as const

// ───────────────────────────── risk ─────────────────────────────

/** Two points each: touching these can lose data, money or trust. */
export const STRONG_RISK_PATTERN =
  /\b(production|prod|payments?|billing|charge|money|data loss|drop (?:the )?(?:table|database)|delete (?:all|every|user|customer)|irreversible|credentials?|pii|gdpr|customer data|secrets?)\b/g
/** One point each. */
export const MODERATE_RISK_PATTERN =
  /\b(migrat\w*|schema|auth\w*|permissions?|security|vulnerab\w*|encrypt\w*|passwords?|delete|remove all|force push|rollback|infrastructure|deploy\w*)\b/g
/** Category points: these categories carry intrinsic risk. */
export const CATEGORY_RISK_BASE: Partial<Record<TaskCategory, number>> = { security: 1, migration: 1 }
/** Risk score → class. 0 low; 1 medium; 2 or more high. */
export const RISK_THRESHOLDS = { medium: 1, high: 2 } as const

export const SECURITY_SENSITIVE_PATTERN =
  /\b(security|vulnerab\w*|cve|xss|csrf|injection|sanitiz\w*|authenticat\w*|authoriz\w*|auth|permissions?|encrypt\w*|secrets?|credentials?|passwords?|tokens?|payments?|pii)\b/

// ───────────────────────────── ambiguity and parallelism ─────────────────────────────

export const VAGUE_PATTERN = /\b(improve|better|nice|somehow|something|etc|maybe|whatever|make it|look into|investigate|figure out)\b/g
export const EXPECTATION_PATTERN = /\b(should|must|when|expect\w*|so that|ensure|returns?|acceptance|criteria)\b/g
/** Fewer words than this adds one ambiguity point. */
export const SHORT_PROMPT_WORDS = 8

export const PARALLEL_PATTERN = /\b(independent\w*|in parallel|separately|each of|several|multiple|every|all of)\b/g
export const SEQUENTIAL_PATTERN = /\b(sequential\w*|step by step|then|after that|depends on|in order|first .* then)\b/g

// ───────────────────────────── helpers ─────────────────────────────

const countMatches = (text: string, pattern: RegExp): number => (text.match(pattern) ?? []).length
const inferred = <T>(value: T): Feature<T> => ({ value, basis: 'INFERRED' })
const feature = <T>(value: T, basis: FeatureBasis): Feature<T> => ({ value, basis })
const wordsOf = (text: string): number => (text.trim() === '' ? 0 : text.trim().split(/\s+/).length)

/** Distinct file-like tokens in the prompt. */
export function fileMentions(prompt: string): string[] {
  return [...new Set((prompt.match(FILE_MENTION_PATTERN) ?? []).map((m) => m.replace(/\\/g, '/').toLowerCase()))]
}

/** Category scores for the prompt, highest first (ties broken by CATEGORY_PRIORITY). */
export function scoreCategories(prompt: string): { category: TaskCategory; score: number }[] {
  const text = prompt.toLowerCase()
  const scores = new Map<TaskCategory, number>()
  for (const rule of CATEGORY_RULES) {
    const hits = Math.min(MAX_MATCHES_PER_CATEGORY, countMatches(text, rule.pattern))
    if (hits > 0) scores.set(rule.category, (scores.get(rule.category) ?? 0) + hits * rule.weight)
  }
  return [...scores.entries()]
    .map(([category, score]) => ({ category, score }))
    .sort((a, b) => b.score - a.score || CATEGORY_PRIORITY.indexOf(a.category) - CATEGORY_PRIORITY.indexOf(b.category))
}

export function inferCategory(prompt: string): TaskCategory {
  return scoreCategories(prompt)[0]?.category ?? DEFAULT_CATEGORY
}

/** Number of separate things the prompt asks for: list items when it has a list, else distinct action verbs. */
export function countDeliverables(prompt: string): number {
  const items = countMatches(prompt, LIST_ITEM_PATTERN)
  if (items >= 2) return items
  return Math.max(1, countMatches(prompt.toLowerCase(), DELIVERABLE_VERB_PATTERN))
}

export function inferComplexity(prompt: string, category: TaskCategory): Complexity {
  const text = prompt.toLowerCase()
  const words = wordsOf(prompt)
  let score = CATEGORY_COMPLEXITY_BASE[category]
  score += LENGTH_POINTS.find((l) => words >= l.minWords)?.points ?? 0
  const deliverables = countDeliverables(prompt)
  if (deliverables >= 6) score += 2
  else if (deliverables >= 3) score += 1
  score += Math.min(2, countMatches(text, BREADTH_PATTERN))
  if (fileMentions(prompt).length >= 3) score += 1
  if (countMatches(text, NARROWING_PATTERN) > 0) score -= 1
  score = Math.max(0, score)
  if (score >= COMPLEXITY_THRESHOLDS.large) return 'large'
  if (score >= COMPLEXITY_THRESHOLDS.medium) return 'medium'
  return 'small'
}

export function inferRisk(prompt: string, category: TaskCategory): Risk {
  const text = prompt.toLowerCase()
  const score =
    2 * countMatches(text, STRONG_RISK_PATTERN) + countMatches(text, MODERATE_RISK_PATTERN) + (CATEGORY_RISK_BASE[category] ?? 0)
  if (score >= RISK_THRESHOLDS.high) return 'high'
  if (score >= RISK_THRESHOLDS.medium) return 'medium'
  return 'low'
}

export function inferFileScope(prompt: string, complexity: Complexity): 'single' | 'few' | 'many' {
  const mentions = fileMentions(prompt).length
  if (mentions === 1) return 'single'
  if (mentions >= 2 && mentions <= 3) return 'few'
  if (mentions >= 4) return 'many'
  if (countMatches(prompt.toLowerCase(), BREADTH_PATTERN) > 0) return 'many'
  return complexity === 'small' ? 'single' : complexity === 'medium' ? 'few' : 'many'
}

export function inferAmbiguity(prompt: string): Level {
  const text = prompt.toLowerCase()
  const specific = fileMentions(prompt).length > 0 || countMatches(text, EXPECTATION_PATTERN) >= 2
  let score = specific ? 0 : 1
  score += Math.min(2, countMatches(text, VAGUE_PATTERN))
  if (wordsOf(prompt) < SHORT_PROMPT_WORDS) score += 1
  return score >= 2 ? 'high' : score === 1 ? 'medium' : 'low'
}

export function inferParallelizability(prompt: string, scope: 'single' | 'few' | 'many'): Level {
  const text = prompt.toLowerCase()
  let score = countMatches(text, PARALLEL_PATTERN) - countMatches(text, SEQUENTIAL_PATTERN)
  if (scope === 'many') score += 1
  if (scope === 'single') score -= 1
  if (countDeliverables(prompt) >= 3) score += 1
  return score >= 2 ? 'high' : score <= -1 ? 'low' : 'medium'
}

/**
 * Test files per 100 source files, from `test_mapping` facts only. Null when there are none: a repository
 * with no mapping facts is "unknown", not "no tests".
 */
export function measureTestDensity(facts: RepositoryFact[], fileCount: number | null): number | null {
  const mappings = facts.filter((f) => f.kind === 'test_mapping' && !f.stale)
  if (mappings.length === 0 || !fileCount || fileCount <= 0) return null
  const testFiles = new Set<string>()
  let directoryTotal = 0
  for (const f of mappings) {
    if (f.subject.endsWith('/')) {
      // "<dir>/ holds N test files"
      const m = /holds (\d+) test file/.exec(f.statement)
      if (m) directoryTotal += Number(m[1])
    } else testFiles.add(f.subject)
  }
  const tests = Math.max(testFiles.size, directoryTotal)
  if (tests === 0) return null
  const source = Math.max(1, fileCount - tests)
  return Math.round((tests / source) * 100)
}

// ───────────────────────────── profile ─────────────────────────────

export function profileTask(input: ProfilerInput): TaskProfile {
  const { prompt, profile, facts, user = {}, ids } = input
  const liveFacts = facts.filter((f) => !f.stale)

  const category = user.category ? feature(user.category, 'USER_SPECIFIED') : inferred(inferCategory(prompt))
  const complexity = user.complexity
    ? feature(user.complexity, 'USER_SPECIFIED')
    : inferred(inferComplexity(prompt, category.value))
  const risk = user.risk ? feature(user.risk, 'USER_SPECIFIED') : inferred(inferRisk(prompt, category.value))

  const languageFacts = liveFacts.filter((f) => f.kind === 'language').map((f) => f.subject)
  const frameworkFacts = liveFacts.filter((f) => f.kind === 'framework').map((f) => f.subject)
  const moduleFacts = liveFacts.filter((f) => f.kind === 'module')
  const fileCount = profile ? profile.fileCount : null

  const scope = inferFileScope(prompt, complexity.value)
  const securitySensitive = category.value === 'security' || SECURITY_SENSITIVE_PATTERN.test(prompt.toLowerCase())

  const features: TaskProfileFeatures = {
    category,
    complexity,
    risk,
    primaryLanguage: feature(profile?.languages[0] ?? languageFacts[0] ?? null, 'MEASURED'),
    frameworks: feature(profile?.frameworks ?? [...new Set(frameworkFacts)], 'MEASURED'),
    repoFileCount: feature(fileCount, 'MEASURED'),
    moduleCount: feature(moduleFacts.length > 0 ? moduleFacts.length : null, 'MEASURED'),
    testDensity: feature(measureTestDensity(liveFacts, fileCount), 'MEASURED'),
    fileScope: inferred(scope),
    ambiguity: inferred(inferAmbiguity(prompt)),
    securitySensitive: inferred(securitySensitive),
    parallelizability: inferred(inferParallelizability(prompt, scope)),
  }

  return {
    id: ids.id,
    projectId: ids.projectId,
    runId: ids.runId,
    arenaTrialId: ids.arenaTrialId,
    contextKey: contextKeyOf(category.value, complexity.value, risk.value),
    features,
    profilerVersion: PROFILER_VERSION,
    createdAt: ids.createdAt,
  }
}
