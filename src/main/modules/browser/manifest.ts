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

/** A ready line is read as text, never as a regular expression: the manifest is the repository's, and a pattern with nested repetition would freeze the runtime. */
const READY_TEXT = /^[ -~]+$/

/** The URL NEXUS may ask for readiness: http or https on this machine's loopback only. The runtime sends the request, so the repository does not get to choose the host. */
export function loopbackReadyUrl(raw: string): URL | null {
  try {
    const url = new URL(raw)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    if (url.username !== '' || url.password !== '') return null
    if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost' && url.hostname !== '[::1]') return null
    return url
  } catch {
    return null
  }
}

/**
 * The switches an Electron application of a project may be given besides NEXUS's own. A list of what is known
 * to be harmless, not a list of what is known to be harmful: Chromium has far too many switches (log files, crash
 * dump and cache directories, `--app=`, file access, `--require`) and takes the Windows form `/switch` as well.
 */
const ELECTRON_SWITCHES = new Set(['--lang', '--window-size', '--window-position', '--force-device-scale-factor', '--force-color-profile', '--high-dpi-support', '--disable-gpu', '--disable-software-rasterizer', '--mute-audio', '--hide-scrollbars', '--start-maximized', '--start-fullscreen', '--disable-renderer-backgrounding', '--force-prefers-reduced-motion', '--disable-background-timer-throttling'])
const ELECTRON_SWITCH_VALUE = /^[A-Za-z0-9.,_-]{0,60}$/
const ELECTRON_POSITIONAL = /^[A-Za-z0-9_.][A-Za-z0-9_.,=+@/-]{0,199}$/

/** Why an argument of `electron.args` is refused, or null when it is allowed. */
export function electronArgProblem(arg: string): string | null {
  if (arg.startsWith('--')) {
    const eq = arg.indexOf('=')
    const name = (eq < 0 ? arg : arg.slice(0, eq)).toLowerCase()
    if (!ELECTRON_SWITCHES.has(name)) return `${arg.slice(0, 60)} is not a switch NEXUS passes on (allowed: ${[...ELECTRON_SWITCHES].join(', ')}, each with an optional =value of letters, digits and . , _ -)`
    if (eq >= 0 && !ELECTRON_SWITCH_VALUE.test(arg.slice(eq + 1))) return `The value of ${name} may hold letters, digits and . , _ - only`
    return null
  }
  if (arg.startsWith('-') || arg.startsWith('/')) return `${arg.slice(0, 60)} starts with "-" or "/": only plain positional arguments and the listed --switches are passed to an Electron application`
  return ELECTRON_POSITIONAL.test(arg) ? null : `${arg.slice(0, 60)} is not a plain positional argument (letters, digits and . , _ = + @ / -; no drive letters or backslashes)`
}

export const AppReadySchema = z.discriminatedUnion('kind', [
  /** Ready when this local URL answers with any status below 500. Only http(s) on 127.0.0.1, localhost or [::1]. */
  z.object({ kind: z.literal('http'), url: z.string().max(300).refine((u) => loopbackReadyUrl(u) !== null, { message: 'ready.url must be an http or https address on 127.0.0.1, localhost or [::1]: NEXUS sends the readiness request itself and only to the machine it runs on.' }) }).strict(),
  /** Ready when something listens on this local port. */
  z.object({ kind: z.literal('port'), port: z.number().int().min(1).max(65535) }).strict(),
  /** Ready when the application prints a line that contains this text (any case; "*" stands for any text); a local URL in that line names the endpoint. */
  z.object({ kind: z.literal('log'), pattern: z.string().min(1).max(200).regex(READY_TEXT, { message: 'ready.pattern is literal text, matched in any case, where "*" stands for any text. It is not a regular expression, and it may hold printable ASCII characters only.' }) }).strict(),
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
    electron: z.object({ entry: z.string().max(200).default('.'), args: z.array(z.string().max(200).superRefine((a, ctx) => { const why = electronArgProblem(a); if (why !== null) ctx.addIssue({ code: 'custom', message: `electron.args: ${why}` }) })).max(20).default([]) }).strict().optional(),
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
      manifest: AppManifestSchema.parse({ type: 'web', launchCommand: pm === 'npm' ? `npm run ${script}` : `${pm} run ${script}`, ready: { kind: 'log', pattern: 'http' } }),
      source: 'package-json',
      note: `From the "${script}" script of package.json; the address is read from what the server prints.`,
    }
  }
  return { manifest: null, source: 'none', note: 'package.json has no dev, start, serve or preview script and Electron is not a dependency. Describe the application in .nexus/app.json.' }
}

/**
 * Whether a line contains the text of `ready.pattern`: case-insensitive, "*" for any text. Segments are looked
 * for in order with indexOf, so the work is bounded by the lengths and nothing backtracks.
 */
export function readyLineMatches(pattern: string, line: string): boolean {
  const hay = line.toLowerCase()
  let from = 0
  for (const segment of pattern.toLowerCase().split('*')) {
    if (segment === '') continue
    const at = hay.indexOf(segment, from)
    if (at < 0) return false
    from = at + segment.length
  }
  return true
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
