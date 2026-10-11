import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { IntelligenceStore } from '../persistence/repositories/intelligence'
import type { IntelligenceProvider, IntelligenceRole } from '@shared/capacity'

export interface QualityScope {
  provider: IntelligenceProvider
  model: string
  role: IntelligenceRole
  profile: string
  policyVersion: string
  runtimeVersion: string
}
const Scope = z
  .object({
    provider: z.enum(['openai', 'claude', 'codex']),
    model: z.string().min(1).max(200),
    role: z.enum(['strategic', 'technical', 'compiler', 'worker', 'reviewer']),
    profile: z.string().min(1).max(200),
    policyVersion: z.string().min(1).max(200),
    runtimeVersion: z.string().min(1).max(200),
  })
  .strict()
const Approval = z
  .object({
    scope: Scope,
    evidence: z.array(z.string().min(1).max(400)).min(1).max(20),
    approvedAt: z.string().datetime(),
  })
  .strict()

/** Only controlled quality validation may write approvals. No renderer channel grants one. */
export class ProviderQualityRegistry {
  constructor(private readonly store: IntelligenceStore) {}
  private key(scope: QualityScope): string {
    return `provider-quality:${createHash('sha256')
      .update(JSON.stringify(Scope.parse(scope)))
      .digest('hex')}`
  }
  evidence(scope: QualityScope): string[] {
    const record = this.store.readCheckpoint(this.key(scope))
    if (!record) return []
    const approval = Approval.parse(record.body)
    if (this.key(approval.scope) !== this.key(scope))
      throw new Error('Quality evidence scope mismatch')
    return [...approval.evidence]
  }
  recordValidated(scope: QualityScope, evidence: string[], approvedAt: string): void {
    const approval = Approval.parse({ scope, evidence, approvedAt })
    if (!this.store.checkpoint(this.key(scope), null, approval))
      throw new Error('Quality approval is immutable; use a new validation policy version')
  }
}
