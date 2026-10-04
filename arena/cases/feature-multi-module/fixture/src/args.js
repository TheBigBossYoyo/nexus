/**
 * Split argv into positional arguments and `--flag value` pairs. Flags named in
 * `booleans` take no value.
 */
export function parseArgs(argv, { booleans = [] } = {}) {
  const positionals = []
  const flags = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) {
      positionals.push(arg)
      continue
    }
    const name = arg.slice(2)
    if (booleans.includes(name)) {
      flags[name] = true
      continue
    }
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) {
      throw new TypeError(`flag --${name} needs a value`)
    }
    flags[name] = value
    i += 1
  }
  return { positionals, flags }
}
