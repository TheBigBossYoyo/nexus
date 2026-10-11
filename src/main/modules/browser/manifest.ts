import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'

/**
 * 0.8: what NEXUS needs to know to start the application a project builds and to look at it: how to launch it,
 * how to tell that it is ready, and where it answers. Found from `package.json` where that is safe, or stated
 * by the project in `.nexus/app.json`.
 *
 * Both files are repository content. They decide how the project's own code is started, which happens inside
 * the project's containment whatever they say. They do not decide what the application may reach: the network
 * of an application under test comes from the user's settings for the project, never from the repository.
 */

export const APP_TYPES = ['web', 'electron'] as const
export type AppType = (typeof APP_TYPES)[number]

export const AppReadySchema = z.discriminatedUnion('kind', [
  /** Ready when this local URL answers with any status below 500. */
  z.object({ kind: z.literal('http'), url: z.string().max(300) }).strict(),
  /** Ready when something listens on this local port. */
  z.object({ kind: z.literal('port'), port: z.number().int().min(1).max(65535) }).strict(),
  /** Ready when the application prints a line that matches; a local URL in that line names the endpoint. */
  z.object({ kind: z.literal('log'), pattern: z.string().min(1).max(200) }).strict(),
])
export type AppReady = z.infer<typeof AppReadySchema>

export const AppManifestSchema = z
  .object({
    type: z.enum(APP_TYPES),
    /** The command that starts the development server (web), as a program and its arguments. No shell operators. */
    launchCommand: z.string().min(1).max(400).optional(),
    /** Directory of the command, relative to the worktree. */
    cwd: z.string().max(200).default('.'),
    ready: AppReadySchema.optional(),
    /** Seconds to wait for readiness. */
    startTimeoutSeconds: z.number().int().min(2).max(600).default(90),
    /** Electron: the application's entry, relative to `cwd` (default: the directory itself), and extra arguments. */
    electron: z.object({ entry: z.string().max(200).default('.'), args: z.array(z.string().max(200)).max(20).default([]) }).strict().optional(),
    /** Variables for the application, by name. Values that read as secrets are refused where the environment is built. */
    env: z.record(z.string().max(60), z.string().max(400)).default({}),
  })
  .strict()
export type AppManifest = z.infer<typeof AppManifestSchema>

export type ManifestSource = 'project-file' | 'package-json' | 'none'

export interface DiscoveredManifest {
  manifest: AppManifest | null
  source: ManifestSource
  /** Why nothing was found, or what was assumed. */
  note: string
}

const WEB_SCRIPTS = ['dev', 'start', 'serve', 'preview']
const SHELL_OPERATORS = /[&|;<>`$()]/

function packageManager(dir: string): string {
  if (existsSync(join(dir, 'pnpm-lock.yaml'))) return 'pnpm'
  if (existsSync(join(dir, 'yarn.lock'))) return 'yarn'
  if (existsSync(join(dir, 'bun.lockb')) || existsSync(join(dir, 'bun.lock'))) return 'bun'
  return 'npm'
}

/**
 * The manifest of the project in `worktree`. `.nexus/app.json` wins when it is there and valid; otherwise the
 * project's `package.json` is read: Electron as a dependency means an Electron application started from its
 * own `electron` binary; a `dev`, `start`, `serve` or `preview` script means a web application whose readiness
 * is read from what it prints.
 */
export function discoverManifest(worktree: string): DiscoveredManifest {
  const explicit = join(worktree, '.nexus', 'app.json')
  if (existsSync(explicit)) {
    try {
      const parsed = AppManifestSchema.safeParse(JSON.parse(readFileSync(explicit, 'utf8')))
      if (!parsed.success) return { manifest: null, source: 'project-file', note: `.nexus/app.json is not a valid application manifest: ${parsed.error.issues[0]?.message ?? 'invalid'}` }
      if (parsed.data.launchCommand && SHELL_OPERATORS.test(parsed.data.launchCommand)) return { manifest: null, source: 'project-file', note: 'The launch command of .nexus/app.json uses shell operators; it must be a program and its arguments.' }
      return { manifest: parsed.data, source: 'project-file', note: 'From .nexus/app.json.' }
    } catch {
      return { manifest: null, source: 'project-file', note: '.nexus/app.json is not JSON.' }
    }
  }
  let pkg: { scripts?: Record<string, unknown>; dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown>; main?: unknown }
  try {
    pkg = JSON.parse(readFileSync(join(worktree, 'package.json'), 'utf8')) as typeof pkg
  } catch {
    return { manifest: null, source: 'none', note: 'The project has no package.json and no .nexus/app.json, so NEXUS does not know how to start its application.' }
  }
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }
  if ('electron' in deps) {
    return {
      manifest: AppManifestSchema.parse({ type: 'electron', electron: { entry: '.', args: [] } }),
      source: 'package-json',
      note: 'Electron is a dependency: the application is started from its own Electron binary with the project directory as its entry. It must have been built if it needs a build.',
    }
  }
  const scripts = pkg.scripts ?? {}
  const script = WEB_SCRIPTS.find((name) => typeof scripts[name] === 'string')
  if (script !== undefined) {
    const pm = packageManager(worktree)
    return {
      manifest: AppManifestSchema.parse({ type: 'web', launchCommand: pm === 'npm' ? `npm run ${script}` : `${pm} run ${script}`, ready: { kind: 'log', pattern: 'https?://(localhost|127\\.0\\.0\\.1|\\[::1\\]):\\d+' } }),
      source: 'package-json',
      note: `From the "${script}" script of package.json; the address is read from what the server prints.`,
    }
  }
  return { manifest: null, source: 'none', note: 'package.json has no dev, start, serve or preview script and Electron is not a dependency. Describe the application in .nexus/app.json.' }
}

/** A local URL in a line of output, as `{ host, port }`; null when there is none. */
export function localEndpointIn(line: string): { host: '127.0.0.1' | 'localhost' | '::1'; port: number; url: string } | null {
  // eslint-disable-next-line no-control-regex
  const clean = line.replace(/\u001b\[[0-9;]*m/g, '')
  const m = /\bhttps?:\/\/(localhost|127\.0\.0\.1|\[::1\]):(\d{2,5})\b/i.exec(clean)
  if (m === null) return null
  const port = Number(m[2])
  if (port < 1 || port > 65535) return null
  const host = (m[1] as string).toLowerCase() === 'localhost' ? 'localhost' : m[1] === '[::1]' ? '::1' : '127.0.0.1'
  return { host, port, url: `${clean.slice(m.index, m.index + m[0].length)}/` }
}
