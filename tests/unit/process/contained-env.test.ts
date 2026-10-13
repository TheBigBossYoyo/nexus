import { describe, expect, it } from 'vitest'
import { containedEnv, isSecretEnvName } from '@main/modules/process/contained-env'

const SENTINEL = 'NEXUS-SENTINEL-do-not-leak-7f3a'

/** A user's environment with a sentinel in every place a secret is known to sit. */
const SECRETS: Record<string, string> = {
  ANTHROPIC_API_KEY: SENTINEL,
  ANTHROPIC_AUTH_TOKEN: SENTINEL,
  CLAUDE_CODE_OAUTH_TOKEN: SENTINEL,
  OPENAI_API_KEY: SENTINEL,
  CODEX_HOME: SENTINEL,
  NEXUS_DATA_DIR: SENTINEL,
  NEXUS_WORKER_ID: SENTINEL,
  GITHUB_TOKEN: SENTINEL,
  GH_TOKEN: SENTINEL,
  NPM_TOKEN: SENTINEL,
  npm_config__authToken: SENTINEL,
  AWS_ACCESS_KEY_ID: SENTINEL,
  AWS_SECRET_ACCESS_KEY: SENTINEL,
  AZURE_CLIENT_SECRET: SENTINEL,
  GOOGLE_APPLICATION_CREDENTIALS: SENTINEL,
  DATABASE_URL: SENTINEL,
  MY_SERVICE_PASSWORD: SENTINEL,
  SESSION_COOKIE: SENTINEL,
  SLACK_WEBHOOK_URL: SENTINEL,
  SSH_AUTH_SOCK: SENTINEL,
  GIT_ASKPASS: SENTINEL,
  NODE_OPTIONS: `--require ${SENTINEL}`,
  NODE_PATH: SENTINEL,
  HTTPS_PROXY: `http://user:${SENTINEL}@proxy`,
  OneDrive: SENTINEL,
  SOME_UNKNOWN_VARIABLE: SENTINEL,
  ELECTRON_RUN_AS_NODE: '1',
}

const BASE: Record<string, string> = {
  SystemRoot: 'C:\\WINDOWS',
  Path: 'C:\\WINDOWS\\system32;C:\\Program Files\\nodejs;C:\\Program Files\\NEXUS;C:\\Program Files\\NEXUS\\resources;C:\\Program Files\\Git\\cmd',
  PATHEXT: '.COM;.EXE;.BAT;.CMD',
  ComSpec: 'C:\\WINDOWS\\system32\\cmd.exe',
  USERPROFILE: 'C:\\Users\\dev',
  APPDATA: 'C:\\Users\\dev\\AppData\\Roaming',
  LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local',
  TEMP: 'C:\\Users\\dev\\AppData\\Local\\Temp',
  TMP: 'C:\\Users\\dev\\AppData\\Local\\Temp',
  JAVA_HOME: 'C:\\jdk',
  PNPM_HOME: 'C:\\Users\\dev\\AppData\\Local\\pnpm',
  VS170COMNTOOLS: 'C:\\VS\\Common7\\Tools',
  ...SECRETS,
}

describe('the environment of a contained process', () => {
  it('lets no sentinel through, by name or by value', () => {
    const { env, withheld } = containedEnv(BASE, { tempDir: 'C:\\nexus\\tmp\\s1' })
    expect(JSON.stringify(env)).not.toContain(SENTINEL)
    for (const name of Object.keys(SECRETS)) {
      expect(Object.keys(env).map((k) => k.toUpperCase()), name).not.toContain(name.toUpperCase())
      expect(withheld).toContain(name)
    }
  })

  it('keeps what a toolchain needs and points the temporary directory at the session', () => {
    const { env } = containedEnv(BASE, { tempDir: 'C:\\nexus\\tmp\\s1' })
    expect(env['SystemRoot']).toBe('C:\\WINDOWS')
    expect(env['JAVA_HOME']).toBe('C:\\jdk')
    expect(env['PNPM_HOME']).toBeDefined()
    expect(env['VS170COMNTOOLS']).toBeDefined()
    expect(env['USERPROFILE']).toBe('C:\\Users\\dev')
    expect(env['TEMP']).toBe('C:\\nexus\\tmp\\s1')
    expect(env['TMP']).toBe('C:\\nexus\\tmp\\s1')
    expect(env['TMPDIR']).toBe('C:\\nexus\\tmp\\s1')
    expect(Object.keys(env).filter((k) => k.toUpperCase() === 'TEMP')).toHaveLength(1)
  })

  it('is an allowlist: a name nobody listed does not pass, however harmless it looks', () => {
    const { env } = containedEnv({ ...BASE, FAVOURITE_COLOUR: 'blue', npm_lifecycle_event: 'test' }, { tempDir: 'C:\\t' })
    expect(env['FAVOURITE_COLOUR']).toBeUndefined()
    expect(env['npm_lifecycle_event']).toBeUndefined()
  })

  it("takes a project's own names, and refuses one of them that reads as a secret", () => {
    const { env, withheld } = containedEnv({ ...BASE, RACEDECK_FLAVOUR: 'dev', RACEDECK_API_KEY: SENTINEL }, { tempDir: 'C:\\t', extraNames: ['racedeck_flavour', 'RACEDECK_API_KEY', 'GITHUB_TOKEN', 'NODE_OPTIONS'] })
    expect(env['RACEDECK_FLAVOUR']).toBe('dev')
    expect(JSON.stringify(env)).not.toContain(SENTINEL)
    expect(withheld).toEqual(expect.arrayContaining(['RACEDECK_API_KEY', 'GITHUB_TOKEN', 'NODE_OPTIONS']))
  })

  it('removes NEXUS from PATH and leaves the other entries in order', () => {
    const { env } = containedEnv(BASE, { tempDir: 'C:\\t', dropPathEntries: ['C:\\Program Files\\NEXUS\\'] })
    expect(env['Path']).toBe('C:\\WINDOWS\\system32;C:\\Program Files\\nodejs;C:\\Program Files\\Git\\cmd')
  })

  it('sets what NEXUS sets, replacing a value of the same name in any case', () => {
    const { env } = containedEnv({ ...BASE, node_env: 'production' }, { tempDir: 'C:\\t', set: { NODE_ENV: 'test', HTTPS_PROXY: 'http://127.0.0.1:41000', ELECTRON_USER_DATA: 'C:\\nexus\\app-data\\s1' } })
    expect(env['NODE_ENV']).toBe('test')
    expect(env['node_env']).toBeUndefined()
    expect(env['HTTPS_PROXY']).toBe('http://127.0.0.1:41000')
    expect(env['ELECTRON_USER_DATA']).toBe('C:\\nexus\\app-data\\s1')
  })

  it('does not change the environment it was given', () => {
    const copy = { ...BASE }
    containedEnv(BASE, { tempDir: 'C:\\t', set: { NODE_ENV: 'test' } })
    expect(BASE).toEqual(copy)
  })

  it('reads a name as a secret without regard to case', () => {
    for (const name of ['github_token', 'Anthropic_Api_Key', 'my_private_thing', 'nexus_data_dir', 'node_options', 'x_auth', 'stripe_live']) expect(isSecretEnvName(name), name).toBe(true)
    for (const name of ['PATH', 'JAVA_HOME', 'SystemRoot', 'NUMBER_OF_PROCESSORS', 'LANG']) expect(isSecretEnvName(name), name).toBe(false)
  })

  it('passes nothing from the real environment of this process that reads as a secret', () => {
    const { env } = containedEnv(process.env, { tempDir: 'C:\\t' })
    for (const name of Object.keys(env)) if (!['TEMP', 'TMP', 'TMPDIR'].includes(name)) expect(isSecretEnvName(name), name).toBe(false)
    expect(Object.keys(env).some((k) => k.toUpperCase() === 'PATH')).toBe(true)
  })
})
