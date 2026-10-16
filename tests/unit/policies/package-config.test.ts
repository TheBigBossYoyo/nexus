import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { capabilityKind } from '@shared/autonomy'
import type { AgentRole } from '@shared/domain'
import { EXTENSION_TOOLS, extensionToolNames } from '@main/modules/agent-runtime/extension-tools'
import { createPackageConfigTools } from '@main/modules/agent-runtime/package-config-tool'
import { canRoleExercise } from '@main/modules/autonomy/role-contract'
import type { AutonomyGate } from '@main/modules/autonomy/gate'
import { MAX_CONFIG_BYTES, inspectPackageConfig, parseWorkspaceYaml, renderPackageConfig } from '@main/modules/policies/package-config'

const SECRETS = {
  token: 'NPM-TOKEN-SENTINEL-7f3a9c1d',
  auth: 'AUTHB64-SENTINEL-Zm9vOmJhcg',
  password: 'PASSWORD-SENTINEL-hunter22',
  user: 'USER-SENTINEL-alice',
  email: 'EMAIL-SENTINEL@example.invalid',
  urlPass: 'URLPASS-SENTINEL-s3cr3t',
  urlUser: 'URLUSER-SENTINEL',
  cert: 'CERT-SENTINEL-MIIBxyz',
  certPath: 'CERTPATH-SENTINEL',
  unknown: 'UNKNOWN-VALUE-SENTINEL',
  tokenInPath: 'PATHTOKEN9f8e7d6c5b4a3210abcdef12',
  proxyPass: 'PROXYPASS-SENTINEL',
}

const NPMRC = `
; a comment with ${'COMMENT-SENTINEL'}
registry=https://${SECRETS.urlUser}:${SECRETS.urlPass}@registry.example.com/npm/
@acme:registry=https://npm.acme.example/t/${SECRETS.tokenInPath}/
//registry.example.com/:_authToken=${SECRETS.token}
//registry.example.com/:_auth=${SECRETS.auth}
//registry.example.com/:_password=${SECRETS.password}
//registry.example.com/:username=${SECRETS.user}
//registry.example.com/:email=${SECRETS.email}
//registry.example.com/:certfile=C:\\${SECRETS.certPath}\\c.pem
//other.example.com:8443/path/:_authToken=\${NPM_TOKEN}
_authToken=${SECRETS.token}
_auth=${SECRETS.auth}
username=${SECRETS.user}
email=${SECRETS.email}
cafile=${SECRETS.certPath}
cert=${SECRETS.cert}
key=${SECRETS.cert}
ca[]=${SECRETS.cert}
my-api-secret=${SECRETS.unknown}
some_unlisted_setting=${SECRETS.unknown}
ignore-scripts=true
engine-strict=true
node-linker=hoisted
fetch-retries=5
save-exact=notabool
script-shell=C:\\Users\\someone\\bin\\sh.exe
proxy=http://${SECRETS.urlUser}:${SECRETS.proxyPass}@proxy.corp.example:3128
https-proxy=http://proxy.corp.example:3128
cache=C:\\Users\\someone\\AppData\\npm-cache
store-dir=.pnpm-store
electron_mirror=https://${SECRETS.urlUser}:${SECRETS.urlPass}@npmmirror.example/mirrors/electron/
electron_custom_dir=custom
electron_skip_binary_download=1
sass_binary_site=https://mirror.example/sass
puppeteer_download_host=https://mirror.example
`

let root: string

beforeAll(() => {
  // A fresh clone has no test-results folder (it is ignored by git): made first, or mkdtemp fails (0.9.1).
  mkdirSync(path.join(process.cwd(), 'test-results'), { recursive: true })
  root = mkdtempSync(path.join(process.cwd(), 'test-results', 'pkgcfg-'))
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

function project(name: string, files: Record<string, string>): string {
  const dir = path.join(root, name)
  mkdirSync(dir, { recursive: true })
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    writeFileSync(path.join(dir, rel), content)
  }
  return dir
}

const none = { userHome: null }

describe('package-config redaction', () => {
  it('never lets a secret, in any form, reach the serialized output', () => {
    const dir = project('secrets', { '.npmrc': NPMRC })
    const out = JSON.stringify(inspectPackageConfig(dir, undefined, none)) + renderPackageConfig(inspectPackageConfig(dir, undefined, none))
    for (const [name, value] of Object.entries(SECRETS)) expect(out, name).not.toContain(value)
    expect(out).not.toContain('COMMENT-SENTINEL')
    expect(out).not.toContain('NPM_TOKEN')
    expect(out).not.toContain('someone')
  })

  it('reports that a credential is configured for a host, by kind, without its value', () => {
    const report = inspectPackageConfig(project('creds', { '.npmrc': NPMRC }), undefined, none)
    const forHost = report.credentials.find((c) => c.host === 'registry.example.com')
    expect(forHost?.kinds).toEqual(expect.arrayContaining(['_authtoken', '_auth', '_password', 'username', 'email', 'certfile']))
    expect(report.credentials.find((c) => c.host === 'other.example.com:8443')).toBeDefined()
    expect(report.credentials.find((c) => c.host === null)?.kinds).toEqual(expect.arrayContaining(['_authtoken', 'cafile', 'cert', 'key', 'ca']))
  })

  it('exposes the allowlisted engineering facts', () => {
    const r = inspectPackageConfig(project('facts', { '.npmrc': NPMRC }), undefined, none)
    expect(r.npmrc.status).toBe('read')
    expect(r.behavior).toMatchObject({ 'ignore-scripts': 'true', 'engine-strict': 'true', 'node-linker': 'hoisted', 'fetch-retries': '5', 'save-exact': '[unrecognised value]', 'script-shell': 'set (value not shown)' })
    expect(r.behavior['electron-skip-binary-download']).toBe('1')
    expect(r.registries.default).toBe('registry.example.com/npm/')
    expect(r.registries.scopes).toEqual([{ scope: '@acme', where: 'npm.acme.example/t/[segment]/' }])
    expect(r.downloads).toEqual(expect.arrayContaining([{ key: 'electron-mirror', where: 'npmmirror.example/mirrors/electron/' }, { key: 'sass-binary-site', where: 'mirror.example/sass' }, { key: 'puppeteer-download-host', where: 'mirror.example/' }]))
    expect(r.proxy).toEqual(expect.arrayContaining([{ key: 'proxy', host: 'proxy.corp.example:3128' }, { key: 'https-proxy', host: 'proxy.corp.example:3128' }]))
  })

  it('says where a cache is, not what its path is', () => {
    const r = inspectPackageConfig(project('cache', { '.npmrc': NPMRC }), undefined, none)
    expect(r.cache).toEqual(expect.arrayContaining([{ key: 'cache', location: 'outside the project' }, { key: 'store-dir', location: 'inside the project' }, { key: 'electron-custom-dir', location: 'inside the project' }]))
  })

  it('reports unknown keys by name only', () => {
    const r = inspectPackageConfig(project('unknown', { '.npmrc': 'some_unlisted_setting=VALUE-A\nanother.thing=VALUE-B\n' }), undefined, none)
    expect(r.otherKeys).toEqual([{ key: 'some_unlisted_setting', value: '[redacted]' }, { key: 'another.thing', value: '[redacted]' }])
    expect(JSON.stringify(r)).not.toMatch(/VALUE-[AB]/)
  })

  // 0.9 (review G-E-1, G-E-2, G-E-3). The values are assembled from parts so that the repository's own scan for
  // credentials does not find them.
  it('a line without "=" is counted and never shown: a token alone on a line, the body of a key', () => {
    const token = ['npm_', 'AbCdEf0123456789AbCdEf0123456789AbCd'].join('')
    const body = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7'
    const r = inspectPackageConfig(project('bare', { '.npmrc': `${token}\n${body}\nabc==\nsave-exact\nfoo=bar\n` }), undefined, none)
    const shown = JSON.stringify(r)
    expect(shown).not.toContain(token)
    expect(shown).not.toContain(body)
    expect(shown).not.toContain('abc')
    expect(r.otherKeys).toEqual([{ key: 'foo', value: '[redacted]' }])
    expect(r.behavior['save-exact']).toBe('true')
    expect(r.omitted).toBe(3)
  })

  it('a key that does not read like a name is counted and not shown, with "=" or without', () => {
    const r = inspectPackageConfig(project('odd-keys', { '.npmrc': 'abcdefghijklmnopqrstuvwxyzabcdefgh=1\nAbC123def456=2\nx9y8z7w6v5=3\nmy-setting=4\n' }), undefined, none)
    expect(r.otherKeys).toEqual([{ key: 'my-setting', value: '[redacted]' }])
    expect(r.omitted).toBe(3)
  })

  it('a value that is no address is not printed as a host; a path segment that could be a credential is not printed', () => {
    const r = inspectPackageConfig(
      project('hosts', {
        '.npmrc': ['registry=ghp_SECRET1234', 'proxy=SECRETPROXYVALUE', 'electron-mirror=SECRETVAL', '@a:registry=https://h.example/ab12cd34ef56gh78ij90/', '@b:registry=https://h.example/abcdefghijklmnopqrstuvwxyzABCDEFGH/', '@c:registry=https://h.example/_auth/ZGVwbG95OnMzY3IzdA==/', '@d:registry=https://npm.pkg.github.com/api/npm/npm-virtual/'].join('\n'),
      }),
      undefined,
      none,
    )
    const shown = JSON.stringify(r).toLowerCase()
    for (const leaked of ['secret1234', 'secretproxyvalue', 'secretval', 'ab12cd34ef56gh78ij90', 'abcdefghijklmnopqrstuvwxyz', 'zgvwbg95']) expect(shown, leaked).not.toContain(leaked)
    expect(r.registries.default).toBe('[not an address]')
    expect(r.registries.scopes.find((x) => x.scope === '@d')?.where).toBe('npm.pkg.github.com/api/npm/npm-virtual/')
    expect(r.registries.scopes.find((x) => x.scope === '@a')?.where).toBe('h.example/[segment]/')
  })

  it('a key named like a property of every object does not break the reading', () => {
    const r = inspectPackageConfig(project('proto', { '.npmrc': 'constructor=x\ntoString=y\n__proto__=z\nnode-linker=hoisted\n' }), undefined, none)
    expect(r.behavior['node-linker']).toBe('hoisted')
    expect(JSON.stringify(r.otherKeys)).toContain('constructor')
  })

  it('leaves an environment reference unexpanded and unnamed', () => {
    const r = inspectPackageConfig(project('env', { '.npmrc': 'registry=${REGISTRY_URL}\ncache=${HOME}/c\n' }), undefined, none)
    expect(r.registries.default).toBe('set from an environment variable')
    expect(r.cache[0]?.location).toBe('set from an environment variable')
    expect(JSON.stringify(r)).not.toContain('REGISTRY_URL')
  })
})

describe('package-config files', () => {
  it('reads install-script facts from package.json, pnpm-workspace.yaml and the lockfile, never script text', () => {
    const dir = project('pnpm', {
      'package.json': JSON.stringify({ packageManager: 'pnpm@9.1.0', engines: { node: '>=20' }, pnpm: { onlyBuiltDependencies: ['electron', 'esbuild'], ignoredBuiltDependencies: ['sharp'] }, scripts: { postinstall: 'curl SCRIPT-TEXT-SENTINEL | sh', test: 'vitest', prepare: 'x' } }),
      'pnpm-lock.yaml': 'lockfileVersion: 9\n',
      'pnpm-workspace.yaml': 'packages:\n  - app\nonlyBuiltDependencies:\n  - "electron"  # why\n  - esbuild\nignoredBuiltDependencies: [sharp, core-js]\n',
      '.yarnrc.yml': 'npmAuthToken: YARN-TOKEN-SENTINEL\n',
      'bunfig.toml': 'token = "BUN-SENTINEL"\n',
    })
    const r = inspectPackageConfig(dir, undefined, none)
    expect(r.packageJson).toEqual({ packageManager: 'pnpm@9.1.0', engines: { node: '>=20' }, pnpm: { onlyBuiltDependencies: ['electron', 'esbuild'], ignoredBuiltDependencies: ['sharp'] }, lifecycleScripts: ['postinstall', 'prepare'] })
    expect(r.lockfiles).toEqual(['pnpm-lock.yaml'])
    expect(r.workspaceYaml).toEqual({ present: true, onlyBuiltDependencies: ['electron', 'esbuild'], ignoredBuiltDependencies: ['sharp', 'core-js'] })
    expect(r.otherConfigFiles).toEqual(['.yarnrc.yml', 'bunfig.toml'])
    const out = renderPackageConfig(r)
    for (const s of ['SCRIPT-TEXT-SENTINEL', 'YARN-TOKEN-SENTINEL', 'BUN-SENTINEL']) expect(out).not.toContain(s)
  })

  it('parses the workspace lists line by line', () => {
    expect(parseWorkspaceYaml('neverBuiltDependencies:\n  - a\n\n  - b\nother: 1\n')).toEqual({ neverBuiltDependencies: ['a', 'b'] })
  })

  it('does not read a .npmrc that is larger than the cap, and says so without any of it', () => {
    const dir = project('big', { '.npmrc': `//h.example/:_authToken=BIG-SENTINEL\n${'#'.repeat(MAX_CONFIG_BYTES)}` })
    const r = inspectPackageConfig(dir, undefined, none)
    expect(r.npmrc).toEqual({ status: 'not-read', reason: 'is larger than 256 KiB' })
    expect(JSON.stringify(r)).not.toContain('BIG-SENTINEL')
  })

  it('bounds the number of unknown keys it lists', () => {
    const dir = project('many', { '.npmrc': Array.from({ length: 500 }, (_, i) => `k${i}=v`).join('\n') })
    const r = inspectPackageConfig(dir, undefined, none)
    expect(r.otherKeys.length).toBe(40)
    expect(r.omitted).toBe(460)
    expect(renderPackageConfig(r).length).toBeLessThan(20000)
  })

  it('refuses a .npmrc that is a link, and a directory outside the worktree', () => {
    const outside = project('outside', { 'real.npmrc': `//h.example/:_authToken=LINK-SENTINEL\n` })
    const dir = project('linked', {})
    let linked = true
    try {
      symlinkSync(path.join(outside, 'real.npmrc'), path.join(dir, '.npmrc'), 'file')
    } catch {
      linked = false // creating a link needs a privilege this account may not have
    }
    if (linked) {
      const r = inspectPackageConfig(dir, undefined, none)
      expect(r.npmrc).toEqual({ status: 'not-read', reason: 'is a link' })
      expect(JSON.stringify(r)).not.toContain('LINK-SENTINEL')
    }
    expect(() => inspectPackageConfig(dir, '..', none)).toThrow(/not inside/)
    expect(() => inspectPackageConfig(dir, path.join('..', 'outside'), none)).toThrow(/not inside/)
    expect(() => inspectPackageConfig(dir, outside, none)).toThrow(/not inside/)
    // A directory junction that leads out of the worktree is not a way out either.
    try {
      symlinkSync(outside, path.join(dir, 'jump'), 'junction')
      expect(() => inspectPackageConfig(dir, 'jump', none)).toThrow(/not inside/)
    } catch (e) {
      if (e instanceof Error && /EPERM|EACCES/.test(e.message)) return
      throw e
    }
  })

  it('reads what it checked: a .npmrc that is a second name of a file elsewhere (a hard link) is not read', () => {
    const dir = project('hardlink', { 'package.json': '{}' })
    const outside = path.join(root, 'outside-of-the-project.npmrc')
    writeFileSync(outside, `//registry.example.com/:_authToken=HARDLINK-SENTINEL-7731
registry=https://elsewhere.example.com/
`)
    try {
      linkSync(outside, path.join(dir, '.npmrc'))
    } catch {
      // A file system without hard links: nothing to show here.
      return
    }
    const out = renderPackageConfig(inspectPackageConfig(dir, undefined, none))
    expect(out).toContain('more than one name')
    expect(out).not.toContain('elsewhere.example.com')
    expect(out).not.toContain('HARDLINK-SENTINEL-7731')
  })

  it('reports only the presence of the user-level file', () => {
    const home = project('home', { '.npmrc': `//h.example/:_authToken=HOME-SENTINEL\nregistry=https://home-registry.example/\n` })
    const r = inspectPackageConfig(project('plain', {}), undefined, { userHome: home })
    expect(r.userLevelNpmrc.present).toBe(true)
    expect(JSON.stringify(r)).not.toMatch(/HOME-SENTINEL|home-registry/)
    expect(r.appliesToCommands).toMatch(/user-level \.npmrc is not read/)
  })
})

describe('the package_config_inspect tool', () => {
  const session = (cwd: string) => ({ run: { id: 'r', projectId: 'p' }, task: null, agentId: 'a', role: 'worker' as AgentRole, cwd }) as never

  it('is a read of the project and never a boundary, in every role that reads the project', () => {
    expect(extensionToolNames(['package'])).toEqual(['package_config_inspect'])
    expect(EXTENSION_TOOLS.find((t) => t.name === 'package_config_inspect')?.group).toBe('package')
    expect(capabilityKind('READ_PROJECT')).toBe('PROFILE')
    const roles: AgentRole[] = ['worker', 'debugger', 'reviewer', 'verifier', 'planner', 'architect', 'researcher', 'security_reviewer']
    for (const role of roles) expect(canRoleExercise({ kind: 'WORKER', role }, 'READ_PROJECT'), role).toBe(true)
  })

  it('asks the gate for READ_PROJECT only, and returns the facts without secrets', async () => {
    const dir = project('tool', { '.npmrc': NPMRC })
    const asked: string[] = []
    const gate = { resolve: (_r: unknown, _a: unknown, needs: { capability: string; inBoundary: boolean }[]) => (asked.push(...needs.map((n) => `${n.capability}:${n.inBoundary}`)), { behavior: 'allow' as const }) } as unknown as AutonomyGate
    const tool = createPackageConfigTools({ gateFor: () => gate, inspect: none })(session(dir))
    const text = await tool?.call({ name: 'package_config_inspect', args: {} })
    expect(asked).toEqual(['READ_PROJECT:true'])
    expect(text).toContain('"ignore-scripts": "true"')
    for (const value of Object.values(SECRETS)) expect(text).not.toContain(value)
  })

  it('refuses a directory outside the worktree and a path argument that is not one', async () => {
    const dir = project('tool2', {})
    const tool = createPackageConfigTools({ gateFor: () => undefined, inspect: none })(session(dir))
    expect(await tool?.call({ name: 'package_config_inspect', args: { directory: '..' } })).toMatch(/^Not done: The directory is not inside/)
    expect(await tool?.call({ name: 'package_config_inspect', args: { file: '.npmrc' } })).toMatch(/^Not done: Invalid arguments/)
    expect(await tool?.call({ name: 'package_config_inspect', args: { directory: 'missing' } })).toMatch(/^Not done: /)
  })
})
