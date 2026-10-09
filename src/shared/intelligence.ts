import { z } from 'zod'

export const COMPILATION_MODES = [
  'AUTO',
  'EXACT',
  'LIGHT',
  'STANDARD',
  'TECHNICAL',
  'COUNCIL',
] as const
export type CompilationMode = (typeof COMPILATION_MODES)[number]
/** Only the user-entry adapter may supply these fields; model outputs cannot claim this provenance. */
export const UserIntentMetadataSchema = z
  .object({
    entryPoint: z.enum([
      'MISSION',
      'MISSION_REPLAN',
      'CRITERION_UPDATE',
      'OVERNIGHT',
      'PROGRAM',
      'PROGRAM_REPLAN',
      'WORKSPACE_MISSION',
      'WORKSPACE_PROGRAM',
      'TASK_ADDITION',
      'TASK_INSTRUCTION',
    ]),
    goals: z.array(z.string().min(1).max(32000)).max(20),
    constraints: z.array(z.string().min(1).max(400)).max(20),
    acceptanceCriteria: z.array(z.string().min(1).max(2000)).max(20),
  })
  .strict()
  .refine((m) => JSON.stringify(m).length <= 64000, 'Explicit metadata needs bounded refinement')
export type UserIntentMetadata = z.infer<typeof UserIntentMetadataSchema>
export function defaultIntentMetadata(
  raw: string,
  entryPoint: UserIntentMetadata['entryPoint'] = 'MISSION',
): UserIntentMetadata {
  return { entryPoint, goals: [raw], constraints: [], acceptanceCriteria: [] }
}
export type CompilationExecutionScope =
  | { runId: string; taskId?: string }
  | { programId: string }
  | { workspaceMissionId: string }
  | { workspaceProgramId: string }
export interface CompilationSelection {
  compilationMode?: CompilationMode
  compiledSpecId?: string
}
export const Text = z.string().min(1).max(4000)
const Refs = z.array(z.string().min(1).max(200)).max(30)
export const RecommendationSchema = z
  .object({
    text: Text,
    kind: z.enum([
      'REQUIREMENT',
      'ACCEPTANCE',
      'CONSTRAINT',
      'NON_GOAL',
      'RISK',
      'ASSUMPTION',
      'UNKNOWN',
      'VERIFICATION',
    ]),
    provenance: z.enum([
      'CONTEXT_DERIVED',
      'DIRECTOR_RECOMMENDED',
      'TECHNICAL_REQUIREMENT',
      'ASSUMPTION',
    ]),
    evidenceRefs: Refs,
    requiresDecision: z.boolean(),
  })
  .strict()
export type Recommendation = z.infer<typeof RecommendationSchema>
export const CompilerOutputSchema = z
  .object({
    recommendations: z.array(RecommendationSchema).max(40),
    scopeChanged: z.boolean(),
    ambiguities: z.array(Text).max(10),
  })
  .strict()
export const DirectorMemoSchema = z
  .object({
    objective: Text,
    recommendation: Text,
    rationale: z.array(Text).max(10),
    alternatives: z.array(Text).max(8),
    risks: z.array(Text).max(10),
    unknowns: z.array(Text).max(10),
    requestedExperiments: z.array(Text).max(10),
    evidenceRefs: Refs,
    confidence: z.enum(['LOW', 'MEDIUM', 'HIGH']),
  })
  .strict()
export const DirectorChallengeSchema = z
  .object({
    agreements: z.array(Text).max(10),
    disagreements: z.array(Text).max(10),
    missingEvidence: z.array(Text).max(10),
    proposedChanges: z.array(Text).max(10),
    evidenceRefs: Refs,
  })
  .strict()
export const DirectorSynthesisSchema = z
  .object({
    decision: Text,
    acceptedClaims: z.array(Text).max(10),
    rejectedClaims: z.array(Text).max(10),
    unresolvedUnknowns: z.array(Text).max(10),
    nextActions: z.array(Text).max(10),
    evidenceRefs: Refs,
  })
  .strict()
export interface IntelligenceContext {
  id: string
  version: string
  text: string
}
export const IntentDriftSchema = z
  .object({
    changesIntent: z.boolean(),
    expandsScope: z.boolean(),
    conflicts: z.array(Text).max(10),
    unjustifiedRequirements: z.array(Text).max(10),
  })
  .strict()
export interface DirectorInvocation {
  id: string
  projectId: string
  objective: string
  level: 0 | 1 | 2 | 3
  reasons: string[]
  state: 'PENDING' | 'WAITING_FOR_PROVIDER' | 'COMPLETED' | 'FAILED'
  dependencies: { id: string; version: string }[]
  provider: string | null
  model: string | null
  memo: z.infer<typeof DirectorMemoSchema> | null
  challenge: z.infer<typeof DirectorChallengeSchema> | null
  synthesis: z.infer<typeof DirectorSynthesisSchema> | null
  unresolvedDisagreements: string[]
  message: string | null
  executionAuthorized: false
  createdAt: string
  updatedAt: string
  decisionId?: string | null
  escalationId?: string | null
  outcomeId?: string | null
}
/** A model recommendation is never a policy approval or a user decision. */
export interface DirectorDecision {
  id: string
  invocationId: string
  projectId: string
  kind: 'DECISION'
  recommendation: string
  unresolvedDisagreements: string[]
  evidenceRefs: string[]
  executionAuthorized: false
  createdAt: string
}
export interface StrategicEscalation {
  id: string
  invocationId: string | null
  projectId: string
  kind: 'ESCALATION'
  objective: string
  reasons: string[]
  level: 1 | 2 | 3
  runId: string | null
  taskId: string | null
  state: 'REQUESTED' | 'INVOKING' | 'WAITING_FOR_PROVIDER' | 'COMPLETED' | 'FAILED' | 'DISMISSED'
  executionAuthorized: false
  createdAt: string
  updatedAt: string
}
export interface DirectorOutcome {
  id: string
  invocationId: string
  projectId: string
  kind: 'OUTCOME'
  state: Exclude<DirectorInvocation['state'], 'PENDING'>
  completedStages: ('MEMO' | 'CHALLENGE' | 'SYNTHESIS')[]
  routingIds: string[]
  consumption: 'RECORDED_BY_PROVIDER_ADAPTER' | 'NONE' | 'UNKNOWN'
  replayAllowed: false
  executionAuthorized: false
  createdAt: string
}
export type DirectorRecord = DirectorDecision | StrategicEscalation | DirectorOutcome
export interface CompiledTaskSpec {
  id: string
  projectId: string
  rawIntent: string
  /** Canonical immutable record; rawIntent is hydrated for IPC and execution compatibility. */
  intentId?: string
  userMetadata?: UserIntentMetadata
  workspaceId?: string
  executionScope?: CompilationExecutionScope
  requestedMode: CompilationMode
  mode: Exclude<CompilationMode, 'AUTO'>
  status: 'READY' | 'USER_DECISION_REQUIRED' | 'WAITING_FOR_PROVIDER'
  reasons: string[]
  recommendations: Recommendation[]
  ambiguities: string[]
  dependencies: { id: string; version: string }[]
  identity: string
  createdAt: string
  waitUntil?: number | null
  driftCheck?: { structuredFlags: string[]; semantic: z.infer<typeof IntentDriftSchema> }
}
