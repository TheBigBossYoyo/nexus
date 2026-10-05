import { projectCommandEnv } from '../process'

/** On top of the shared project-command environment: every ANTHROPIC_* variable and an inherited test-runner context. */
const ALSO_WITHHELD = /^(ANTHROPIC_.*|NODE_TEST_CONTEXT)$/i

/**
 * Environment for everything the Arena executes on behalf of a case (setup commands, evaluator, node
 * preflight). Credentials of the user's Claude account never reach a case command, and nothing can redirect how
 * Node loads code or runs the test runner.
 */
export function cleanEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = projectCommandEnv(base)
  for (const k of Object.keys(env)) if (ALSO_WITHHELD.test(k)) delete env[k]
  return env
}
