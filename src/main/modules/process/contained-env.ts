/**
 * 0.8: the environment of a contained process. An allowlist: a variable reaches project code only when its name
 * is one a toolchain needs, and never when its name says it carries a secret. `projectCommandEnv` (0.3) removes
 * six names from the user's environment and passes the rest; this passes nothing it was not told to.
 *
 * Names compare without case, as Windows does. The result never contains a variable of NEXUS, of a model
 * provider or of a credential helper, whatever the allowlist or the project's own additions say.
 */

/** What Windows and its tools need to run at all. */
const SYSTEM = [
  'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'PATHEXT', 'PATH', 'OS',
  'PROCESSOR_ARCHITECTURE', 'PROCESSOR_ARCHITEW6432', 'PROCESSOR_IDENTIFIER', 'PROCESSOR_LEVEL', 'PROCESSOR_REVISION', 'NUMBER_OF_PROCESSORS',
  'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432', 'COMMONPROGRAMFILES', 'COMMONPROGRAMFILES(X86)', 'COMMONPROGRAMW6432', 'PROGRAMDATA', 'ALLUSERSPROFILE', 'PUBLIC',
  'USERNAME', 'USERDOMAIN', 'COMPUTERNAME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'HOME', 'APPDATA', 'LOCALAPPDATA',
  'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES', 'TZ', 'TERM', 'COLORTERM', 'NO_COLOR', 'FORCE_COLOR', 'CI',
  'PSMODULEPATH', 'DRIVERDATA', 'MSYSTEM', 'MSYS', 'CHERE_INVOKING', 'SHELL',
]

/** Where toolchains are installed and how they are configured. No value here is a credential. */
const TOOLCHAIN = [
  'JAVA_HOME', 'JDK_HOME', 'GRADLE_HOME', 'GRADLE_USER_HOME', 'MAVEN_HOME', 'M2_HOME', 'ANDROID_HOME', 'ANDROID_SDK_ROOT', 'ANDROID_NDK_HOME',
  'GOROOT', 'GOPATH', 'GOCACHE', 'GOMODCACHE', 'GOFLAGS', 'GOPROXY', 'GO111MODULE',
  'CARGO_HOME', 'RUSTUP_HOME', 'RUSTUP_TOOLCHAIN', 'RUSTFLAGS',
  'PYTHONHOME', 'PYTHONIOENCODING', 'PYTHONUTF8', 'PYTHONDONTWRITEBYTECODE', 'VIRTUAL_ENV', 'CONDA_PREFIX', 'CONDA_DEFAULT_ENV', 'PIPENV_VENV_IN_PROJECT', 'POETRY_VIRTUALENVS_IN_PROJECT',
  'PNPM_HOME', 'NVM_HOME', 'NVM_SYMLINK', 'VOLTA_HOME', 'FNM_DIR', 'COREPACK_HOME', 'YARN_CACHE_FOLDER', 'NODE_ENV',
  'DOTNET_ROOT', 'DOTNET_CLI_TELEMETRY_OPTOUT', 'DOTNET_NOLOGO', 'NUGET_PACKAGES', 'MSBUILDDISABLENODEREUSE',
  'VCINSTALLDIR', 'VSINSTALLDIR', 'VCTOOLSINSTALLDIR', 'WINDOWSSDKDIR', 'WINDOWSSDKVERSION', 'INCLUDE', 'LIB', 'LIBPATH', 'VSCMD_ARG_TGT_ARCH', 'VSCMD_VER',
  'CC', 'CXX', 'CMAKE_GENERATOR', 'CMAKE_PREFIX_PATH', 'VCPKG_ROOT', 'CHOCOLATEYINSTALL', 'SCOOP',
  'ELECTRON_CACHE', 'ELECTRON_MIRROR', 'PLAYWRIGHT_BROWSERS_PATH', 'PUPPETEER_CACHE_DIR', 'CYPRESS_CACHE_FOLDER',
  'GIT_EXEC_PATH', 'GIT_TEMPLATE_DIR',
]

const ALLOWED = new Set([...SYSTEM, ...TOOLCHAIN])

/** Families that are allowed by prefix: Visual Studio's versioned tool variables. */
const ALLOWED_PATTERN = /^VS\d+COMNTOOLS$/

/**
 * Never passed, whatever allows it. A name that says "secret" is one; so is every variable of NEXUS, of a model
 * provider, of a cloud or source-hosting account, of a credential helper, and every variable that makes a
 * runtime load code or reach the network through something the user configured for themselves.
 */
const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSW|PASSPHRASE|CREDENTIAL|COOKIE|SESSION|AUTH|BEARER|SIGNATURE|PRIVATE|CERT_PASS|_PAT$|^PAT_|_DSN$|CONNECTION_?STRING|WEBHOOK)/
const DENIED_PREFIX = /^(NEXUS_|ANTHROPIC_|CLAUDE_|CLAUDECODE|OPENAI_|CODEX_|CHATGPT_|GEMINI_|GOOGLE_|AWS_|AZURE_|ARM_|GCP_|GCLOUD_|CLOUDSDK_|GH_|GITHUB_|GITLAB_|BITBUCKET_|NPM_CONFIG_|PNPM_CONFIG_|YARN_NPM|DOCKER_|KUBE|SSH_|GPG_|VAULT_|SENTRY_|STRIPE_|TWILIO_|SLACK_|DISCORD_|HF_|HUGGING|ELECTRON_RUN_AS_NODE$|NODE_CHANNEL_)/
const DENIED_EXACT = new Set(['NODE_OPTIONS', 'NODE_PATH', 'NODE_EXTRA_CA_CERTS', 'PYTHONPATH', 'PYTHONSTARTUP', 'RUBYOPT', 'PERL5OPT', 'JAVA_TOOL_OPTIONS', '_JAVA_OPTIONS', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'GIT_ASKPASS', 'GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'EDITOR', 'VISUAL', 'PAGER', 'BROWSER', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'ONEDRIVE', 'ONEDRIVECONSUMER', 'ONEDRIVECOMMERCIAL'])

export function isSecretEnvName(name: string): boolean {
  const upper = name.toUpperCase()
  return SECRET_NAME.test(upper) || DENIED_PREFIX.test(upper) || DENIED_EXACT.has(upper)
}

export interface ContainedEnvOptions {
  /** The session's temporary directory: TEMP, TMP and TMPDIR point there, never at the user's own. */
  tempDir: string
  /**
   * Extra names the user allowed for this project (its own toolchain variables). A name that reads as a secret
   * is refused here too: the list widens what is useful, never what is protected.
   */
  extraNames?: readonly string[]
  /** Values NEXUS sets for the process: the proxy it must use, the app-data directory of an application under test. */
  set?: Readonly<Record<string, string>>
  /** Directories removed from PATH: NEXUS's own, so project code does not find its executables by name. */
  dropPathEntries?: readonly string[]
}

function filterPath(value: string, drop: readonly string[]): string {
  if (drop.length === 0) return value
  const dropped = drop.map((d) => d.replace(/[\\/]+$/, '').toLowerCase())
  return value
    .split(';')
    .filter((entry) => {
      const e = entry.trim().replace(/[\\/]+$/, '').toLowerCase()
      return e !== '' && !dropped.some((d) => e === d || e.startsWith(`${d}\\`))
    })
    .join(';')
}

/**
 * Builds the environment of a contained process from the runtime's own. Returns the names it withheld, for
 * the record of the launch (names only, never values).
 */
export function containedEnv(base: NodeJS.ProcessEnv, options: ContainedEnvOptions): { env: Record<string, string>; withheld: string[] } {
  const extra = new Set((options.extraNames ?? []).map((n) => n.toUpperCase()))
  const env: Record<string, string> = {}
  const withheld: string[] = []
  for (const [name, value] of Object.entries(base)) {
    if (value === undefined) continue
    const upper = name.toUpperCase()
    const allowed = (ALLOWED.has(upper) || ALLOWED_PATTERN.test(upper) || extra.has(upper)) && !isSecretEnvName(upper)
    if (!allowed) {
      withheld.push(name)
      continue
    }
    env[name] = upper === 'PATH' ? filterPath(value, options.dropPathEntries ?? []) : value
  }
  // What NEXUS sets is not subject to the name rules: it is NEXUS's own choice of value, not the user's secret.
  for (const [name, value] of Object.entries(options.set ?? {})) {
    for (const existing of Object.keys(env)) if (existing.toUpperCase() === name.toUpperCase()) delete env[existing]
    env[name] = value
  }
  for (const name of ['TEMP', 'TMP', 'TMPDIR']) {
    for (const existing of Object.keys(env)) if (existing.toUpperCase() === name) delete env[existing]
    env[name] = options.tempDir
  }
  return { env, withheld: withheld.sort() }
}
