import { tmpdir } from 'node:os'
import { errorMessage } from '@shared/result'
import { resolveExecutable, runProcess } from '../process'
import { cleanEnv } from './env'

/** Built-in cases are Node.js projects run with `node --test`; they need a Node.js on PATH (none is shipped). */
export const MIN_NODE_MAJOR = 20

export interface NodeStatus {
  nodeFound: boolean
  nodeVersion: string | null
  /** Node is present and new enough. */
  ok: boolean
  /** One clear sentence for the UI. */
  message: string
  path: string | null
}

/** Resolves the `node` that case commands will run (same resolution as `runCommandLine`) and asks it for its version. */
export async function checkNode(cwd: string = tmpdir()): Promise<NodeStatus> {
  const env = cleanEnv()
  const path = await resolveExecutable('node', { cwd, env })
  if (!path) {
    return { nodeFound: false, nodeVersion: null, ok: false, path: null, message: 'Arena cases run with Node.js; `node` was not found on PATH' }
  }
  try {
    const r = await runProcess(path, ['--version'], { cwd, env, timeoutMs: 15_000, maxOutputBytes: 4096 })
    const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(r.stdout.trim())
    if (r.exitCode !== 0 || !m) {
      return { nodeFound: true, nodeVersion: null, ok: false, path, message: `\`node --version\` failed (${path})` }
    }
    const version = `v${m[1]}.${m[2]}.${m[3]}`
    const ok = Number(m[1]) >= MIN_NODE_MAJOR
    return {
      nodeFound: true,
      nodeVersion: version,
      ok,
      path,
      message: ok ? `Node.js ${version}` : `Arena cases need Node.js ${MIN_NODE_MAJOR} or newer; found ${version}`,
    }
  } catch (e) {
    return { nodeFound: true, nodeVersion: null, ok: false, path, message: `Could not run node: ${errorMessage(e)}` }
  }
}
