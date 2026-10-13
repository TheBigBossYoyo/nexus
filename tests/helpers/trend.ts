/**
 * 0.9: judging a long run by its trend, not by its last number. The limits a soak is judged by are written down
 * before it runs (docs/V0_9_SOAK_THRESHOLDS.md, SOAK_LIMITS below); this file only measures a series against
 * them. Pure: no clock, no files.
 */

export interface Point {
  /** Hours since the start of the segment. */
  t: number
  v: number
}

export interface GrowthLimit {
  /** The most the metric may gain per hour, by the robust slope. */
  perHour: number
  /** The most the median of the last quarter may be, as a multiple of the median of the first quarter (after warm-up). */
  ratio: number
  /** Added to the first quarter's median before the ratio is applied: small numbers double without meaning anything. */
  slack: number
}

export interface TrendVerdict {
  samples: number
  hours: number
  slopePerHour: number
  firstQuarterMedian: number
  lastQuarterMedian: number
  /** Share of consecutive steps that go up: near 1 for a leak, near 0.5 for noise. */
  risingShare: number
  verdict: 'PASS' | 'FAIL' | 'TOO_SHORT'
  reason: string
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2
}

/** Theil–Sen: the median of the slopes between pairs of points. One spike does not move it. */
export function robustSlope(points: readonly Point[]): number {
  const slopes: number[] = []
  // Every pair up to 400 points; beyond that, each point against a spread of later ones.
  const step = Math.max(1, Math.floor(points.length / 400))
  for (let i = 0; i < points.length; i += step) {
    for (let j = i + step; j < points.length; j += step) {
      const a = points[i] as Point
      const b = points[j] as Point
      if (b.t > a.t) slopes.push((b.v - a.v) / (b.t - a.t))
    }
  }
  return slopes.length === 0 ? 0 : median(slopes)
}

/**
 * A metric of one uninterrupted segment (one start of a process). The first tenth is warm-up and is left out.
 * FAIL needs both signs of growth without bound: the slope above its limit and the last quarter above the
 * first by more than the ratio. A step up that then stays flat passes the slope; noise passes the ratio.
 */
export function judgeGrowth(series: readonly Point[], limit: GrowthLimit, minSamples = 12, minHours = 0.5): TrendVerdict {
  const ordered = [...series].sort((a, b) => a.t - b.t)
  const steady = ordered.slice(Math.floor(ordered.length / 10))
  const hours = steady.length > 1 ? (steady.at(-1) as Point).t - (steady[0] as Point).t : 0
  const quarter = Math.max(1, Math.floor(steady.length / 4))
  const first = median(steady.slice(0, quarter).map((p) => p.v))
  const last = median(steady.slice(-quarter).map((p) => p.v))
  const slope = robustSlope(steady)
  let rising = 0
  for (let i = 1; i < steady.length; i += 1) if ((steady[i] as Point).v > (steady[i - 1] as Point).v) rising += 1
  const base = { samples: steady.length, hours, slopePerHour: slope, firstQuarterMedian: first, lastQuarterMedian: last, risingShare: steady.length > 1 ? rising / (steady.length - 1) : 0 }
  if (steady.length < minSamples || hours < minHours) return { ...base, verdict: 'TOO_SHORT', reason: `${steady.length} samples over ${hours.toFixed(2)} h: not enough to speak of a trend` }
  const overSlope = slope > limit.perHour
  const overRatio = last > (first + limit.slack) * limit.ratio
  if (overSlope && overRatio) return { ...base, verdict: 'FAIL', reason: `grows ${slope.toFixed(2)}/h (limit ${limit.perHour}) and ends at ${last.toFixed(1)} against ${first.toFixed(1)} at the beginning (limit x${limit.ratio} after +${limit.slack})` }
  return { ...base, verdict: 'PASS', reason: overSlope ? 'slope above its limit, level within its ratio: a step, not a climb' : overRatio ? 'level above its ratio, slope within its limit' : 'within both limits' }
}

/**
 * Something that should grow with the work done and no faster: bytes of database per finished item, rows of
 * the event log per finished item. Compares the cost per unit of work in the last third with the first third.
 */
export function judgeProportional(series: readonly { work: number; v: number }[], maxRatio: number): { firstPerUnit: number; lastPerUnit: number; verdict: 'PASS' | 'FAIL' | 'TOO_SHORT'; reason: string } {
  const ordered = [...series].sort((a, b) => a.work - b.work)
  const third = Math.floor(ordered.length / 3)
  if (third < 2) return { firstPerUnit: Number.NaN, lastPerUnit: Number.NaN, verdict: 'TOO_SHORT', reason: 'too few samples' }
  const rate = (from: { work: number; v: number }, to: { work: number; v: number }): number => (to.work > from.work ? (to.v - from.v) / (to.work - from.work) : Number.NaN)
  const first = rate(ordered[0] as { work: number; v: number }, ordered[third] as { work: number; v: number })
  const last = rate(ordered[ordered.length - 1 - third] as { work: number; v: number }, ordered.at(-1) as { work: number; v: number })
  if (!Number.isFinite(first) || !Number.isFinite(last)) return { firstPerUnit: first, lastPerUnit: last, verdict: 'TOO_SHORT', reason: 'no work was done in one of the thirds' }
  if (first <= 0) return { firstPerUnit: first, lastPerUnit: last, verdict: last <= 0 ? 'PASS' : 'TOO_SHORT', reason: 'nothing grew in the first third' }
  const ok = last <= first * maxRatio
  return { firstPerUnit: first, lastPerUnit: last, verdict: ok ? 'PASS' : 'FAIL', reason: ok ? `${last.toFixed(4)} per unit of work at the end against ${first.toFixed(4)} at the beginning` : `the cost per unit of work rose from ${first.toFixed(4)} to ${last.toFixed(4)} (limit x${maxRatio})` }
}

export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return Number.NaN
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))] as number
}

/** The p95 of the last quarter against the p95 of the first quarter. */
export function judgeLatency(samplesMs: readonly number[], maxRatio: number, slackMs: number): { firstP95: number; lastP95: number; verdict: 'PASS' | 'FAIL' | 'TOO_SHORT' } {
  const quarter = Math.floor(samplesMs.length / 4)
  if (quarter < 5) return { firstP95: Number.NaN, lastP95: Number.NaN, verdict: 'TOO_SHORT' }
  const firstP95 = percentile(samplesMs.slice(0, quarter), 95)
  const lastP95 = percentile(samplesMs.slice(-quarter), 95)
  return { firstP95, lastP95, verdict: lastP95 <= firstP95 * maxRatio + slackMs ? 'PASS' : 'FAIL' }
}

/**
 * The limits of the 0.9 soak, fixed on 2026-10-13 before any long run was made. A change to a number here after
 * a run is a change of the question, and the release report must say so.
 */
export const SOAK_LIMITS = {
  growth: {
    /** Resident memory of the runtime process, MB. */
    rssMb: { perHour: 15, ratio: 1.5, slack: 20 },
    heapUsedMb: { perHour: 8, ratio: 1.6, slack: 15 },
    /** Private bytes of the runtime process as Windows counts them, MB. */
    privateMb: { perHour: 15, ratio: 1.5, slack: 20 },
    /** Handles of the runtime process as Windows counts them. */
    osHandles: { perHour: 40, ratio: 1.5, slack: 100 },
    threads: { perHour: 2, ratio: 1.5, slack: 8 },
    /** libuv's own count of active handles and of pending timers. */
    handles: { perHour: 5, ratio: 2, slack: 20 },
    timers: { perHour: 5, ratio: 2, slack: 20 },
    /** Processes on the machine that belong to the soak (workers, launchers, shells, browsers). */
    processes: { perHour: 1, ratio: 1.5, slack: 6 },
  } satisfies Record<string, GrowthLimit>,
  /** Cost per finished item in the last third against the first third. */
  proportional: { dbBytes: 2, eventRows: 2, graphRows: 2 },
  latency: { ratio: 2, slackMs: 50 },
  /** What must be exactly zero when the soak has drained and stopped. */
  zeroAtEnd: ['orphanProcesses', 'orphanBrowsers', 'listeningPorts', 'browserProfiles', 'specFiles', 'sessionDirectories', 'orphanCapabilityEntries', 'activeLeases', 'duplicateTerminalStates', 'itemsFinishedTwice'] as const,
  /** What must be the same before and after. */
  unchanged: ['scheduledTasksNamedNexus', 'firewallRulesNamedNexus', 'mountManagerAccessList', 'sandboxRootAccessList'] as const,
  walMbMax: 200,
} as const
