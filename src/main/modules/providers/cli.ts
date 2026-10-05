import { tmpdir } from 'node:os'
import { delimiter, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { resolveExecutable } from '@main/modules/process/command-line'
import { projectCommandEnv, runProcess, type ProcessResult } from '@main/modules/process/run-process'
import type { CommandRunner } from './types'

/** Only these characters may appear in an argument handed to a provider's command line tool. */
const SAFE_ARG = /^[A-Za-z0-9._=:/\\-]+$/
/** A resolved tool path may also contain spaces and parentheses ("Program Files (x86)"); it is quoted. */
const SAFE_PATH = /^[A-Za-z0-9._=:/\\ ()~+@,-]+$/

const envGet = (env: NodeJS.ProcessEnv, name: string): string | undefined => {
  const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase())
  return key ? env[key] : undefined
}

const isInside = (path: string, dir: string): boolean => {
  const rel = relative(resolve(dir), resolve(path))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * The environment a provider's tool runs in: NEXUS's own, without the Claude credentials and Node options
 * that are withheld from every project command, and with the rule that Windows must not look for programs
 * in the current directory.
 */
export function toolEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...projectCommandEnv(base), NoDefaultCurrentDirectoryInExePath: '1' }
}

/**
 * Finds a provider's tool on PATH and nowhere else. The directory a session works in is never searched and a
 * tool found inside it is refused: a file named like the tool in a repository or a worktree must not run.
 * Relative PATH entries are ignored for the same reason.
 */
export async function resolveTool(tool: string, workingDir: string | null, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  if (!/^[A-Za-z0-9._-]+$/.test(tool)) return null
  const path = (envGet(env, 'PATH') ?? '')
    .split(delimiter)
    .map((d) => d.replace(/^"(.*)"$/, '$1'))
    .filter((d) => d.length > 0 && isAbsolute(d) && (workingDir === null || !isInside(d, workingDir)))
  const found = await resolveExecutable(tool, { cwd: tmpdir(), env: { ...env, PATH: path.join(delimiter), Path: path.join(delimiter) } })
  if (!found || !isAbsolute(found)) return null
  if (workingDir !== null && isInside(found, workingDir)) return null
  return found
}

/**
 * How a resolved tool is started. On Windows such tools are `.cmd` shims, which only `cmd.exe` runs; `cmd.exe`
 * is addressed by its absolute path, the shim by its absolute, quoted path, and every argument is checked
 * against a strict character set first. Anything free-form (the prompt) goes through stdin, never through the
 * command line.
 */
export function cliInvocation(toolPath: string, args: readonly string[], platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): { command: string; args: string[]; verbatim: boolean } {
  for (const arg of args) {
    if (!SAFE_ARG.test(arg)) throw new Error(`Refusing to start ${toolPath}: unsafe argument ${JSON.stringify(arg)}`)
  }
  if (!isAbsolute(toolPath) && !/^[A-Za-z]:[\\/]/.test(toolPath)) throw new Error(`Refusing to start a tool that is not addressed by an absolute path: ${JSON.stringify(toolPath)}`)
  if (!SAFE_PATH.test(toolPath)) throw new Error(`Refusing to start a tool whose path contains characters cmd.exe interprets: ${JSON.stringify(toolPath)}`)
  const ext = extname(toolPath).toLowerCase()
  if (platform === 'win32' && (ext === '.cmd' || ext === '.bat')) {
    const root = envGet(env, 'SystemRoot') ?? 'C:\\Windows'
    const comspec = join(root, 'System32', 'cmd.exe')
    return { command: comspec, args: ['/d', '/s', '/c', `""${toolPath}" ${args.join(' ')}"`], verbatim: true }
  }
  return { command: toolPath, args: [...args], verbatim: false }
}

/** Runs a provider's tool to completion through the one process runner NEXUS has (timeout, abort, tree kill). */
export async function runCli(tool: string, args: readonly string[], options: { cwd: string; input?: string; signal?: AbortSignal; timeoutMs?: number }): Promise<ProcessResult> {
  const env = toolEnv()
  const toolPath = await resolveTool(tool, options.cwd, env)
  if (!toolPath) throw new Error(`The ${tool} command line tool was not found on PATH (the working directory is never searched).`)
  const invocation = cliInvocation(toolPath, args, process.platform, env)
  return runProcess(invocation.command, invocation.args, {
    cwd: options.cwd,
    env,
    timeoutMs: options.timeoutMs ?? 15_000,
    ...(invocation.verbatim ? { windowsVerbatimArguments: true } : {}),
    ...(options.input !== undefined ? { input: options.input } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  })
}

export const runCommand: CommandRunner = async (tool, args, options = {}) => {
  try {
    // Detection runs in the system's temporary directory, never in a project.
    const result = await runCli(tool, args, { cwd: options.cwd ?? tmpdir(), timeoutMs: options.timeoutMs ?? 10_000 })
    if (result.timedOut) return { code: null, stdout: result.stdout.slice(0, 20_000), stderr: result.stderr.slice(0, 20_000), error: 'timed out' }
    return { code: result.exitCode, stdout: result.stdout.slice(0, 20_000), stderr: result.stderr.slice(0, 20_000), error: null }
  } catch (e) {
    return { code: null, stdout: '', stderr: '', error: e instanceof Error ? e.message : String(e) }
  }
}
