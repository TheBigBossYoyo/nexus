import { z } from 'zod'
import type { AdvisoryShape } from './compiler'

interface Issue {
  code?: unknown
  path?: unknown
}

/**
 * Where an answer departs from its schema, as positions and kinds only: `recommendations.0.kind: invalid_value`.
 * A path is made of the schema's own field names and of indexes; anything else in it is dropped. No key the model
 * invented and no value it wrote is ever part of it, so the line can be shown and stored.
 */
function describeIssues(error: unknown): string {
  const issues = (error as { issues?: unknown } | null)?.issues
  if (!Array.isArray(issues)) return ''
  const lines = (issues as Issue[]).slice(0, 6).map((issue) => {
    const path = Array.isArray(issue.path)
      ? issue.path.map((segment) => (typeof segment === 'number' ? String(segment) : typeof segment === 'string' && /^[A-Za-z][A-Za-z0-9]{0,39}$/.test(segment) ? segment : '?')).join('.')
      : ''
    const code = typeof issue.code === 'string' && /^[a-z_]{1,40}$/.test(issue.code) ? issue.code : 'invalid'
    return `${path || 'answer'}: ${code}`
  })
  return lines.length ? ` (${lines.join('; ')}${issues.length > lines.length ? `; ${issues.length - lines.length} more` : ''})` : ''
}

/** Schema diagnostics can echo private model-controlled keys or values. Only positions and kinds leave this function. */
export function parseAdvisoryArtifact<T>(schema: { parse(value: unknown): T }, value: unknown): T {
  let where: string
  try {
    return schema.parse(value)
  } catch (error) {
    where = describeIssues(error)
  }
  // Thrown outside the catch on purpose: the schema's own error carries the model's values and must not travel
  // with this one as its cause.
  throw new Error(`Advisory provider returned invalid structured output${where}`)
}

/** Keywords a provider's strict structured output does not take. The limits they state are checked here anyway. */
const UNENFORCED = new Set(['$schema', 'maxLength', 'minLength', 'maxItems', 'minItems', 'pattern', 'format'])

function enforceable(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(enforceable)
  if (!node || typeof node !== 'object') return node
  return Object.fromEntries(Object.entries(node as Record<string, unknown>).filter(([key]) => !UNENFORCED.has(key)).map(([key, value]) => [key, enforceable(value)]))
}

/**
 * The shape of an answer for a provider to enforce: the JSON Schema of the same schema the answer is validated
 * with, less the size limits a provider's strict mode does not accept. Words alone did not hold: the first real
 * answer of the strategic provider gave objects where the instructions asked for sentences.
 */
export function advisoryShape(name: string, schema: z.ZodType, evidenceIds?: readonly string[]): AdvisoryShape {
  const shape = enforceable(z.toJSONSchema(schema)) as Record<string, unknown>
  return { name, schema: evidenceIds && evidenceIds.length > 0 ? (withEvidenceIds(shape, evidenceIds) as Record<string, unknown>) : shape }
}

/** Every `evidenceRefs` of the shape may hold only the ids of the evidence that was supplied. */
function withEvidenceIds(node: unknown, ids: readonly string[]): unknown {
  if (Array.isArray(node)) return node.map((item) => withEvidenceIds(item, ids))
  if (!node || typeof node !== 'object') return node
  return Object.fromEntries(
    Object.entries(node as Record<string, unknown>).map(([key, value]) =>
      key === 'evidenceRefs' && value && typeof value === 'object' && (value as { type?: unknown }).type === 'array'
        ? [key, { ...(value as object), items: { type: 'string', enum: [...ids] } }]
        : [key, withEvidenceIds(value, ids)],
    ),
  )
}

/**
 * A reference to evidence that was not supplied is removed, and counted. An answer is not thrown away for it: the
 * first real TECHNICAL compilation was lost whole, paid for, to one such reference. What is stored never names
 * evidence outside the scope that was retrieved.
 */
export function withinScope<T extends { evidenceRefs: string[] }>(artifact: T, ids: ReadonlySet<string>, onRemoved?: (count: number) => void): T {
  const kept = artifact.evidenceRefs.filter((id) => ids.has(id))
  if (kept.length === artifact.evidenceRefs.length) return artifact
  onRemoved?.(artifact.evidenceRefs.length - kept.length)
  return { ...artifact, evidenceRefs: kept }
}
