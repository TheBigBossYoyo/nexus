import type { Complexity, Risk } from '@shared/domain'
import { TASK_CATEGORIES, type ConcreteStrategy, type TaskCategory, type TaskProfileFeatures } from '@shared/v3'

/**
 * The DEFAULT POLICY: a small deterministic table. It describes what NEXUS did before it learned
 * anything (BUILD), with two evidence-free refinements that were already common practice. SWARM and
 * SPECULATIVE are never defaults; only promoted evidence or exploration reaches them.
 */

export interface DefaultInput {
  /** `*` in a component means "any" (a fallback context). */
  category: TaskCategory | '*'
  complexity: Complexity | '*'
  risk: Risk | '*'
  /** Present when called with a full profile. A localized fix must not span many files. */
  fileScope?: 'single' | 'few' | 'many'
}

export function parseContextKey(contextKey: string): DefaultInput {
  const [category = '*', complexity = '*', risk = '*'] = contextKey.split('|')
  const cat = (TASK_CATEGORIES as readonly string[]).includes(category) ? (category as TaskCategory) : '*'
  const cx = complexity === 'small' || complexity === 'medium' || complexity === 'large' ? complexity : '*'
  const rk = risk === 'low' || risk === 'medium' || risk === 'high' ? risk : '*'
  return { category: cat, complexity: cx, risk: rk }
}

export function defaultInputOf(source: string | DefaultInput | TaskProfileFeatures): DefaultInput {
  if (typeof source === 'string') return parseContextKey(source)
  if ('category' in source && typeof source.category === 'object') {
    const f = source as TaskProfileFeatures
    return {
      category: f.category.value,
      complexity: f.complexity.value,
      risk: f.risk.value,
      fileScope: f.fileScope.value,
    }
  }
  return source as DefaultInput
}

/** The table. Order matters: the first matching row wins. */
export const DEFAULT_RULES: readonly {
  id: string
  strategy: ConcreteStrategy
  matches: (i: DefaultInput) => boolean
  reason: string
}[] = [
  {
    id: 'consensus-high-stakes',
    strategy: 'CONSENSUS',
    matches: (i) =>
      (i.category === 'security' || i.risk === 'high') && (i.complexity === 'medium' || i.complexity === 'large'),
    reason: 'security-sensitive or high-risk work of medium or larger size gets consensus planning and dual review',
  },
  {
    id: 'single-small-localized',
    strategy: 'SINGLE',
    matches: (i) =>
      (i.category === 'bugfix' || i.category === 'testing') &&
      i.complexity === 'small' &&
      (i.risk === 'low' || i.risk === 'medium') &&
      i.fileScope !== 'many',
    reason: 'a small, localized fix or test addition does not need a planner',
  },
  {
    id: 'build',
    strategy: 'BUILD',
    matches: () => true,
    reason: 'everything else uses the standard planned build',
  },
]

const ruleFor = (source: string | DefaultInput | TaskProfileFeatures) => {
  const input = defaultInputOf(source)
  return DEFAULT_RULES.find((r) => r.matches(input)) ?? DEFAULT_RULES[DEFAULT_RULES.length - 1]!
}

export function defaultStrategy(source: string | DefaultInput | TaskProfileFeatures): ConcreteStrategy {
  return ruleFor(source).strategy
}

/** Plain-language reason for the default, e.g. for the decision text. */
export function defaultReason(source: string | DefaultInput | TaskProfileFeatures): string {
  const rule = ruleFor(source)
  return `default policy gives ${rule.strategy}: ${rule.reason}`
}
