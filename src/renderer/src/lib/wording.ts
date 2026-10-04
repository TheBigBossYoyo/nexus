/** Plain-language wording for enums and keys that must never reach the screen raw. Pure. */

const cap = (s: string): string => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s)

/** `BUILD` becomes "Build". */
export const strategyWord = (s: string): string => cap(s.toLowerCase())

const CATEGORY: Record<string, string> = {
  bugfix: 'Bug fix',
  feature: 'Feature',
  refactor: 'Refactor',
  migration: 'Migration',
  performance: 'Performance work',
  security: 'Security change',
  testing: 'Testing',
  ui: 'UI change',
  infrastructure: 'Infrastructure',
  architecture: 'Architecture',
}

/** `ui|medium|low` becomes "UI change · medium size · low risk". Wildcards read as "any". */
export function contextWords(key: string): string {
  if (key === '*|*|*') return 'All tasks'
  const [category = '', size = '*', risk = '*'] = key.split('|')
  const cat = category === '*' ? 'Any kind of task' : (CATEGORY[category] ?? cap(category))
  return `${cat} · ${size === '*' ? 'any size' : `${size} size`} · ${risk === '*' ? 'any risk' : `${risk} risk`}`
}

/** Short title for lists and headers: the first sentence, at most 60 characters. */
export function shortTitle(prompt: string, max = 60): string {
  const first =
    prompt
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? 'Untitled mission'
  const sentence = first.split(/(?<=[.!?])\s+/)[0] ?? first
  const clean = sentence.replace(/[.!?]+$/, '')
  if (clean.length <= max) return clean
  const cut = clean.slice(0, max - 1)
  const space = cut.lastIndexOf(' ')
  return `${(space > 24 ? cut.slice(0, space) : cut).trimEnd()}…`
}

const OVERNIGHT: Record<string, string> = {
  POWER_ACTION_SCHEDULED: 'Shutdown scheduled',
  QUOTA_PAUSED: 'Waiting for the usage limit',
  RUNNING: 'Running',
}

/** Friendly wording for an overnight state; unknown values are lower-cased words. */
export function overnightWord(state: string): string {
  return OVERNIGHT[state] ?? cap(state.replace(/_/g, ' ').toLowerCase())
}

/** Plain explanation of a planning recommendation; the backend's score text is not shown. */
export function planningWords(mode: string): string {
  return mode === 'single'
    ? 'A single planner is enough for a short, well-bounded task.'
    : 'Several planners compare approaches, which helps with a larger or riskier task.'
}

/** Rewrites raw context keys (`ui|medium|low`) inside free text into words. */
export function humanizeKeys(text: string): string {
  return text.replace(/\b[a-z*]+\|[a-z*]+\|[a-z*]+\b/g, (k) => contextWords(k))
}
