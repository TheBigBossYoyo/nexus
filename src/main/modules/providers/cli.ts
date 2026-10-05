import { runProcess, type ProcessResult } from '@main/modules/process/run-process'
import type { CommandRunner } from './types'

/** Only these characters may appear in an argument handed to a provider's command line tool. */
const SAFE_ARG = /^[A-Za-z0-9._=:/\\-]+$/

/**
 * How a provider's command line tool is started. On Windows such tools are `.cmd` shims, which Node only
 * starts through `cmd.exe`; every argument is therefore checked against a strict character set first, and
 * anything free-form (the prompt) goes through stdin, never through the command line.
 */
export function cliInvocation(tool: string, args: readonly string[], platform: NodeJS.Platform = process.platform): { command: string; args: string[] } {
  for (const arg of [tool, ...args]) {
    if (!SAFE_ARG.test(arg)) throw new Error(`Refusing to start ${tool}: unsafe argument ${JSON.stringify(arg)}`)
  }
  if (platform === 'win32') return { command: 'cmd.exe', args: ['/d', '/s', '/c', tool, ...args] }
  return { command: tool, args: [...args] }
}

/** Runs a provider's tool to completion through the one process runner NEXUS has (timeout, abort, tree kill). */
export function runCli(tool: string, args: readonly string[], options: { cwd: string; input?: string; signal?: AbortSignal; timeoutMs?: number }): Promise<ProcessResult> {
  const invocation = cliInvocation(tool, args)
  return runProcess(invocation.command, invocation.args, {
    cwd: options.cwd,
    timeoutMs: options.timeoutMs ?? 15_000,
    ...(options.input !== undefined ? { input: options.input } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  })
}

export const runCommand: CommandRunner = async (tool, args, options = {}) => {
  try {
    const result = await runCli(tool, args, { cwd: options.cwd ?? process.cwd(), timeoutMs: options.timeoutMs ?? 10_000 })
    if (result.timedOut) return { code: null, stdout: result.stdout.slice(0, 20_000), stderr: result.stderr.slice(0, 20_000), error: 'timed out' }
    return { code: result.exitCode, stdout: result.stdout.slice(0, 20_000), stderr: result.stderr.slice(0, 20_000), error: null }
  } catch (e) {
    return { code: null, stdout: '', stderr: '', error: e instanceof Error ? e.message : String(e) }
  }
}
