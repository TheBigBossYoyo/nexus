import type { EvidenceLabel, Interval } from '@shared/v3'

/**
 * Statistics used by the Arena and the policy engine. Pure. Deliberately small: proportions with Wilson
 * intervals, medians and means, and a sample-size label. No p-values.
 */

/** Thresholds of the evidence labels. Documented in docs/BENCHMARK_METHODOLOGY.md; not tuned per result. */
export const EVIDENCE_THRESHOLDS = {
  /** Below this many observations nothing is said. */
  weak: 5,
  moderate: 12,
  strong: 30,
  /** STRONG also needs the 95% interval to be at most this wide. */
  strongMaxWidth: 0.3,
} as const

const Z95 = 1.959963984540054

/**
 * Wilson score interval for a binomial proportion (95% by default). Unlike the normal approximation it
 * stays inside [0, 1] and behaves for small n and for 0 or n successes. Null for n = 0.
 */
export function wilsonInterval(successes: number, n: number, z = Z95): Interval | null {
  if (!(n > 0)) return null
  const s = Math.min(Math.max(successes, 0), n)
  const p = s / n
  const z2 = z * z
  const denom = 1 + z2 / n
  const centre = (p + z2 / (2 * n)) / denom
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom
  return { low: Math.max(0, centre - half), high: Math.min(1, centre + half) }
}

export const intervalWidth = (i: Interval | null): number => (i ? i.high - i.low : 1)

/** True when the two intervals share no point. Null intervals overlap everything (nothing is known). */
export function intervalsSeparated(a: Interval | null, b: Interval | null): boolean {
  if (!a || !b) return false
  return a.low > b.high || b.low > a.high
}

export function evidenceLabel(n: number, interval: Interval | null): EvidenceLabel {
  if (n < EVIDENCE_THRESHOLDS.weak) return 'INSUFFICIENT'
  if (n < EVIDENCE_THRESHOLDS.moderate) return 'WEAK'
  if (n >= EVIDENCE_THRESHOLDS.strong && intervalWidth(interval) <= EVIDENCE_THRESHOLDS.strongMaxWidth) return 'STRONG'
  return 'MODERATE'
}

const LABEL_ORDER: Record<EvidenceLabel, number> = { INSUFFICIENT: 0, WEAK: 1, MODERATE: 2, STRONG: 3 }
export const labelAtLeast = (label: EvidenceLabel, floor: EvidenceLabel): boolean => LABEL_ORDER[label] >= LABEL_ORDER[floor]

export function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null
  return values.reduce((a, b) => a + b, 0) / values.length
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

/** Histogram of non-negative integers; the last bucket holds `buckets - 1` or more. */
export function distribution(values: readonly number[], buckets = 5): number[] {
  const out = Array.from({ length: buckets }, () => 0)
  for (const v of values) out[Math.min(buckets - 1, Math.max(0, Math.floor(v)))]! += 1
  return out
}

/** Exponential recency weight: 1 for now, 0.5 at one half-life. Evidence from the future counts as now. */
export function recencyWeight(ageDays: number, halfLifeDays: number): number {
  if (!(halfLifeDays > 0)) return 1
  return Math.pow(0.5, Math.max(0, ageDays) / halfLifeDays)
}

/**
 * True when `a` is better than `b` by more than a band (lower is better), e.g. band 0.2 means at least
 * 20% lower. Differences inside the band are ties. Null values are never better.
 */
export function betterByBand(a: number | null, b: number | null, band: number): boolean {
  if (a === null || b === null) return false
  if (b <= 0) return false
  return a < b * (1 - band)
}

/** Small deterministic PRNG (mulberry32). The same seed always gives the same sequence. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Standard normal draw (Box-Muller) from a uniform generator. */
function gaussian(rand: () => number): number {
  let u = 0
  while (u === 0) u = rand()
  const v = rand()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

/** Gamma(shape, 1) draw, Marsaglia and Tsang. */
function gamma(shape: number, rand: () => number): number {
  if (shape < 1) {
    let u = 0
    while (u === 0) u = rand()
    return gamma(shape + 1, rand) * Math.pow(u, 1 / shape)
  }
  const d = shape - 1 / 3
  const c = 1 / Math.sqrt(9 * d)
  for (;;) {
    let x = 0
    let v = 0
    do {
      x = gaussian(rand)
      v = 1 + c * x
    } while (v <= 0)
    v = v * v * v
    const u = rand()
    if (u < 1 - 0.0331 * x * x * x * x) return d * v
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v
  }
}

/** Beta(alpha, beta) draw. Used for Thompson sampling over pass proportions. */
export function sampleBeta(alpha: number, beta: number, rand: () => number): number {
  const x = gamma(Math.max(alpha, 1e-6), rand)
  const y = gamma(Math.max(beta, 1e-6), rand)
  return x + y === 0 ? 0.5 : x / (x + y)
}
