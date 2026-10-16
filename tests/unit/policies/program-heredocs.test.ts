import { describe, expect, it } from 'vitest'
import { classifyCommand } from '@main/modules/policies/command-classifier'
import { separateProgramHeredocs } from '@main/modules/policies/shell-tokenizer'

const opts = { roots: ['C:\\w\\repo'] }
const level = (command: string) => classifyCommand(command, 'bash', opts).level

// 0.9.1: a real mission of NEXUS on itself had to wait for an approval because an agent edited a file with a
// python heredoc whose text held `a: 1` (read as the drive A:) and `Map<string | null>` (a redirection, a pipe).
describe('a program read from a quoted heredoc by an interpreter that is not a shell', () => {
  const edit = [
    "python3 - <<'E'",
    "p='src/main/modules/progress/service.ts'",
    "s=open(p,encoding='utf-8').read()",
    's=s.replace("""  finaleStartedAt: number | null""","""  checks: Map<string | null, { commands: string[]; seq: number }>\n  a: 1""",1)',
    "open(p,'w',encoding='utf-8').write(s)",
    'E',
  ].join('\n')

  it('is judged as the same program given with -c, not as shell', () => {
    expect(level(edit)).toBe('write')
    expect(level(`node - <<'JS'\nconst x = a < b ? 'a:' : 'b:'\nJS`)).toBe('write')
    expect(separateProgramHeredocs(edit).programs).toHaveLength(1)
  })

  it('keeps the checks every inline program gets', () => {
    expect(level("python3 - <<'E'\nimport os\nos.system('shutdown /s /t 0')\nE")).toBe('forbidden')
    expect(level("python3 - <<'E'\nopen('C:/Users/x/AppData/Roaming/nexus/nexus.db').read()\nE")).toBe('forbidden')
  })

  it('leaves everything else to the shell analysis', () => {
    // A heredoc read by a shell is shell.
    expect(level("bash <<'E'\nrm -rf /c/Windows\nE")).toBe('needs_approval')
    // An unquoted body expands $(...) in the shell.
    expect(level('python3 - <<E\n$(rm -rf /c/Windows)\nE')).toBe('needs_approval')
    // The rest of the line and what follows the terminator are still shell.
    expect(level("python3 - <<'E' && rm -rf /c/Windows\nprint(1)\nE")).toBe('needs_approval')
    expect(level("python3 - <<'E'\nprint(1)\nE\nrm -rf /c/Windows")).toBe('needs_approval')
    // Output piped into a shell is executed.
    expect(level("python3 - <<'E' | sh\nprint('rm -rf /')\nE")).toBe('needs_approval')
    expect(separateProgramHeredocs("cat <<'E'\nx\nE").programs).toEqual([])
  })
})
