import type { Artifact, Review, ReviewFinding } from '@shared/domain'
import { ArbiterOutputSchema, type ArbiterOutput } from '@shared/v2'
import { applyArbitration } from '@main/modules/review'

/**
 * The reviews table has no arbitration column, so the arbiter's output is stored as an Artifact of this
 * kind (title = the arbiter review's id, content = the ArbiterOutput JSON) and attached to the review
 * rows when they are read back.
 */
export const ARBITRATION_ARTIFACT = 'arbitration'

function parseArbitration(content: string): ArbiterOutput | null {
  try {
    const parsed = ArbiterOutputSchema.safeParse(JSON.parse(content))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/** Reviews with `arbitration` set on the arbiter's own row; the artifacts may belong to a task or a whole run. */
export function attachArbitration(reviews: Review[], artifacts: readonly Artifact[]): Review[] {
  const byReview = new Map<string, ArbiterOutput>()
  for (const a of artifacts) {
    if (a.kind !== ARBITRATION_ARTIFACT) continue
    const output = parseArbitration(a.content)
    if (output) byReview.set(a.title, output)
  }
  return reviews.map((r) => {
    const arbitration = byReview.get(r.id)
    return arbitration ? { ...r, arbitration } : r
  })
}

/** The findings of a review that count: for an arbiter row only the accepted ones, otherwise all of them. */
export function effectiveFindings(review: Review): ReviewFinding[] {
  if (!review.arbitration) return review.findings
  return applyArbitration(
    review.findings.map((finding) => ({ finding, reportedBy: [] })),
    review.arbitration.decisions,
  ).accepted
}
