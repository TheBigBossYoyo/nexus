import { z } from 'zod'
import type {
  AgentPurpose,
  CheckCommands,
  Decision,
  Handoff,
  MemoryEntry,
  Message,
  ReviewFinding,
  Run,
  Task,
} from '@shared/domain'
import {
  HandoffSchema,
  MissionPlanSchema,
  ReviewOutputSchema,
  VerifierOutputSchema,
} from '@shared/domain'
import { ArbiterOutputSchema, PlanCritiqueOutputSchema, type RepositoryFact } from '@shared/v2'
import {
  SECTION_LIMITS,
  assemble,
  boundedList,
  bullets,
  criteriaSection,
  renderCheckCommands,
  renderHandoff,
  renderTaskSpec,
  truncate,
} from './render'
import { renderFinding } from './stage-prompts'
import type { PackSection } from './render'

export * from './stage-prompts'
export type { OrchestrationEvidence } from './render'
export { SECTION_LIMITS, truncate } from './render'
export type { PackSection } from './render'

// JSON Schemas (draft-07) for SDK structured output, generated from the zod contract.
function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, { target: 'draft-7' }) as Record<string, unknown>
}

export const missionPlanJsonSchema = toJsonSchema(MissionPlanSchema)
export const reviewOutputJsonSchema = toJsonSchema(ReviewOutputSchema)
export const verifierOutputJsonSchema = toJsonSchema(VerifierOutputSchema)
export const handoffJsonSchema = toJsonSchema(HandoffSchema)
export const planCritiqueJsonSchema = toJsonSchema(PlanCritiqueOutputSchema)
export const arbiterOutputJsonSchema = toJsonSchema(ArbiterOutputSchema)

export interface ContextPackInput {
  run: Run
  task: Task
  purpose: AgentPurpose
  missionCriteria: string[]
  dependencyOutputs: { key: string; title: string; summary: string }[]
  decisions: Decision[]
  memory: MemoryEntry[]
  /** v0.2: repository facts selected for the task. */
  facts?: RepositoryFact[]
  /** v0.2: significant findings of the task's latest review that this session must address. */
  reviewFindings?: ReviewFinding[]
  messages: Message[]
  repo: {
    worktreePath: string
    branch: string
    baseCommit: string
    projectName: string
    checks: CheckCommands
  }
  extra?: {
    handoff?: Handoff
    failure?: { kind: 'checks' | 'review' | 'verification'; summary: string; details: string }
    attempt?: number
    userInstructions?: string[]
  }
}

/** Assembles the per-task context an agent starts with. Pure: renders only what it is given. */
export function buildContextPack(input: ContextPackInput): {
  prompt: string
  sections: PackSection[]
} {
  const { task, repo, extra } = input

  const dependencies = input.dependencyOutputs.length
    ? boundedList(
        input.dependencyOutputs.map(
          (d) => `### ${d.key}: ${d.title}\n${truncate(d.summary, SECTION_LIMITS.dependencyItem)}`,
        ),
        SECTION_LIMITS.dependencies,
        'dependency outputs',
      )
    : null

  const decisions = input.decisions.length
    ? boundedList(
        input.decisions.map((d) => `- ${d.title}: ${d.decision} (why: ${d.rationale})`),
        SECTION_LIMITS.decisions,
        'decisions',
      )
    : null

  const memory = input.memory.length
    ? boundedList(
        input.memory.map((m) => {
          const files = m.filePaths.length > 0 ? ` [files: ${m.filePaths.join(', ')}]` : ''
          return `- ${m.title}: ${m.content}${files}`
        }),
        SECTION_LIMITS.memory,
        'memory entries',
      )
    : null

  const facts = input.facts?.length
    ? boundedList(
        input.facts.map((f) => `- [${f.kind}${f.source === 'agent' || f.source === 'verifier' || f.source === 'user' ? `, source: ${f.source}, ${f.confidence} confidence` : ''}] ${f.subject}: ${f.statement}`),
        SECTION_LIMITS.facts,
        'repository facts',
      )
    : null

  const reviewFindings = input.reviewFindings?.length
    ? boundedList(input.reviewFindings.map(renderFinding), SECTION_LIMITS.findings, 'findings')
    : null

  const messages = input.messages.length
    ? boundedList(
        input.messages.map(
          (m) =>
            `- [${m.type}${m.severity ? `/${m.severity}` : ''}] ${m.fromLabel} -> ${m.toLabel}: ${m.subject}\n  ${m.body}`,
        ),
        SECTION_LIMITS.messages,
        'messages',
      )
    : null

  const repoText = [
    `Project: ${repo.projectName}`,
    `Worktree: ${repo.worktreePath}`,
    `Branch: ${repo.branch}`,
    `Base commit: ${repo.baseCommit}`,
    'Check commands:',
    renderCheckCommands(repo.checks),
  ].join('\n')

  const attempt = extra?.attempt !== undefined && extra.attempt > 1 ? `Attempt ${extra.attempt}.` : null

  const failure = extra?.failure
    ? truncate(
        `Previous attempt failed (${extra.failure.kind}): ${extra.failure.summary}\n\n${extra.failure.details}`,
        SECTION_LIMITS.failure,
      )
    : null

  const instructions = extra?.userInstructions?.length
    ? truncate(bullets(extra.userInstructions), SECTION_LIMITS.instructions)
    : null

  return assemble([
    { name: 'Task', body: `Purpose: ${input.purpose}\n\n${renderTaskSpec(task)}` },
    { name: 'Acceptance criteria', body: criteriaSection(task, input.missionCriteria) },
    { name: 'Results of dependency tasks', body: dependencies },
    { name: 'Relevant decisions', body: decisions },
    { name: 'Repository intelligence', body: facts },
    { name: 'Project memory', body: memory },
    { name: 'Review findings to address', body: reviewFindings },
    { name: 'Messages from other agents', body: messages },
    { name: 'Repository state', body: truncate(repoText, SECTION_LIMITS.repo) },
    { name: 'Attempt', body: attempt },
    { name: 'Failure to address', body: failure },
    { name: 'Handoff from previous session', body: extra?.handoff ? renderHandoff(extra.handoff) : null },
    { name: 'User instructions', body: instructions },
  ])
}
