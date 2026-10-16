import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AgentRole } from '@shared/domain'
import { classifyCommand, createAuthorizer } from '@main/modules/policies'

// 0.2.1 follow-up: quoted-delimiter heredocs consumed by cat/tee are data, not shell.

let tmp: string
let project: string
let wt: string

beforeAll(() => {
  tmp = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'nexus-hd-')))
  project = path.join(tmp, 'project')
  wt = path.join(project, '.nexus', 'wt1')
  mkdirSync(path.join(wt, 'src'), { recursive: true })
})
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

const bash = (c: string) => classifyCommand(c, 'bash', { roots: [wt] })
const ps = (c: string) => classifyCommand(c, 'powershell', { roots: [wt] })
async function decide(role: AgentRole, toolName: 'Bash' | 'PowerShell', command: string) {
  const authorize = createAuthorizer({ role, worktreeRoot: wt, projectRoot: project, safeCommandPrefixes: [], allowNetworkTools: false })
  return authorize({ agentId: 'a', toolName, input: { command }, toolUseId: 't' })
}

// Source text that used to be parsed as shell: regex literals, `=>`, relative requires, quotes, $, backticks.
const SRC = [
  "'use strict'",
  "const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')",
  "const home = process.env.HOME || `${process.cwd()}/x`; // $(echo not-run) and (parens) & more; | pipes",
  'module.exports = { slugify }',
].join('\n')
const TEST = [
  "const test = require('node:test')",
  "const assert = require('node:assert')",
  "const { slugify } = require('../src/text')",
  "test('slug', () => { assert.strictEqual(slugify('A b'), 'a-b') })",
].join('\n')

const ACCEPTANCE = [
  `cat > src/text.js <<'EOF'\n${SRC}\nEOF`,
  `cat > test/text.test.js <<'EOF'\n${TEST}\nEOF`,
  'npm test 2>&1 | grep -E "^# (pass|fail)"',
  'git add src/text.js test/text.test.js && git commit -q -m "Add slugify" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"',
].join('\n')

const WRITING: AgentRole[] = ['worker', 'debugger']

describe('acceptance-run command (cat heredocs + npm test | grep + git commit with trailer)', () => {
  it('classifies as allowed, no approval', () => {
    const r = bash(ACCEPTANCE)
    expect(r.level, r.reasons.join('; ')).toBe('write')
    expect(r.reasons).toEqual([])
    expect(r.commandClass).toBe('GIT_LOCAL')
  })

  it('is allowed for worker and debugger', async () => {
    for (const role of WRITING) expect((await decide(role, 'Bash', ACCEPTANCE)).behavior, role).toBe('allow')
  })

  it('each piece is individually fine', () => {
    expect(bash(`cat > src/text.js <<'EOF'\n${SRC}\nEOF`).commandClass).toBe('SAFE_PROJECT_WRITE')
    expect(bash('npm test 2>&1 | grep -E "^# (pass|fail)"').level).toBe('write')
    expect(bash('git commit -q -m "Add slugify" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"').level).toBe('write')
  })

  it('still needs approval when a redirect target is outside the worktree', async () => {
    const outside = ACCEPTANCE.replace('> src/text.js', '> ../../elsewhere/text.js')
    const r = bash(outside)
    expect(r.level).toBe('needs_approval')
    expect(r.reasons.join(' ')).toMatch(/outside the worktree/)
    for (const role of WRITING) expect((await decide(role, 'Bash', outside)).behavior, role).toBe('ask')
  })
})

describe('angle-bracket email inside a quoted argument is not a redirection', () => {
  it.each(['bash', 'powershell'] as const)('%s', (shell) => {
    const run = shell === 'bash' ? bash : ps
    for (const c of [
      'git commit -m "Co-Authored-By: X <a@b.c>"',
      'git commit -m "t" -m "Co-Authored-By: X <a@b.c>"',
      "git commit -m 'Co-Authored-By: X <a@b.c>'",
      'echo "mail <a@b.c>"',
    ]) {
      const r = run(c)
      expect(r.level, `${shell}: ${c} -> ${r.reasons.join('; ')}`).not.toBe('needs_approval')
    }
  })
})

describe('generalized heredoc neutralization', () => {
  it.each([
    `cat > src/a.js <<'EOF'\n${SRC}\nEOF`,
    `cat > src/a.js <<"EOF"\n${SRC}\nEOF`,
    `cat >> src/a.js <<'EOF'\n${SRC}\nEOF`,
    `cat <<'EOF' > src/a.js\n${SRC}\nEOF`,
    `cat <<'EOF' >> src/a.js\n${SRC}\nEOF`,
    `cat <<-'EOF' > src/a.js\n\t${SRC}\n\tEOF`,
    `tee src/a.js <<'EOF'\n${SRC}\nEOF`,
    `tee -a src/a.js <<'EOF' > /dev/null\n${SRC}\nEOF`,
    `cat > src/a.js <<'EOF'\r\n${SRC}\r\nEOF\r\n`,
    `cat > src/a.js <<'EOF' && echo done\n${SRC}\nEOF`,
    `mkdir -p src && cat > src/a.js <<'EOF'\n${SRC}\nEOF`,
  ])('is data: %s', (c) => {
    const r = bash(c)
    expect(r.level, r.reasons.join('; ')).toBe('write')
    expect(r.commandClass).toBe('SAFE_PROJECT_WRITE')
  })

  it('handles several heredocs independently and analyses the text between and after them', () => {
    const two = `cat > src/a.js <<'EOF'\n${SRC}\nEOF\ncat > src/b.js <<"B"\n${TEST}\nB\ngit add -A`
    const ok = bash(two)
    expect(ok.level, ok.reasons.join('; ')).toBe('write')
    expect(ok.commandClass).toBe('GIT_LOCAL')
    // text between the heredocs is real shell
    expect(bash(`cat > src/a.js <<'EOF'\nx\nEOF\ngit push\ncat > src/b.js <<'EOF'\ny\nEOF`).reasons.join(' ')).toMatch(/git push/)
    // a second heredoc whose target is outside is still caught while the first is relaxed
    expect(bash(`cat > src/a.js <<'EOF'\nx\nEOF\ncat > ../out.txt <<'EOF'\ny\nEOF`).level).toBe('needs_approval')
  })

  it('works for the read-only form (cat <<EOF with no redirection) as well', () => {
    expect(bash(`cat <<'EOF'\nrm -rf / (not run) <a@b>\nEOF`).level).toBe('safe')
  })

  it.each([
    // shells and anything that executes stdin as shell
    `bash <<'EOF'\nrm -rf /\nEOF`,
    `sh <<'EOF'\nrm -rf /\nEOF`,
    `zsh <<'EOF'\nrm -rf /\nEOF`,
    `pwsh -Command - <<'EOF'\nrm -rf /\nEOF`,
    `powershell - <<'EOF'\nrm -rf /\nEOF`,
    `cmd <<'EOF'\nrm -rf /\nEOF`,
    `ssh host <<'EOF'\nrm -rf /\nEOF`,
    `xargs <<'EOF'\nrm -rf /\nEOF`,
    `eval <<'EOF'\nrm -rf /\nEOF`,
    `source /dev/stdin <<'EOF'\nrm -rf /\nEOF`,
    `sudo bash <<'EOF'\nrm -rf /\nEOF`,
    `sudo cat > f <<'EOF'\nrm -rf /\nEOF`,
    `sudo tee f <<'EOF'\nrm -rf /\nEOF`,
    `env bash <<'EOF'\nrm -rf /\nEOF`,
    // consumer is cat, but the output goes somewhere executable
    `cat <<'EOF' | bash\nrm -rf /\nEOF`,
    `cat <<'EOF' | sh\nrm -rf /\nEOF`,
    `cat <<'EOF' |bash\nrm -rf /\nEOF`,
    `cat > src/a.sh <<'EOF' | bash\nrm -rf /\nEOF`,
    `tee src/a.sh <<'EOF' | sh\nrm -rf /\nEOF`,
    // unquoted delimiter: the body expands
    'cat > src/a.txt <<EOF\n$(rm -rf /)\nEOF',
    'cat > src/a.txt <<EOF\n`rm -rf /`\nEOF',
    'cat <<EOF\n$(rm -rf x)\nEOF',
    // a here-string is not a heredoc
    "cat <<< 'x'; rm -rf /",
    // cat with other arguments or another consumer first
    `cat /etc/passwd > src/a.txt <<'EOF'\nrm -rf /\nEOF`,
    `echo hi | cat > src/a.txt <<'EOF'\nrm -rf /\nEOF; rm -rf /`,
  ])('is NOT relaxed: %s', (c) => {
    const r = bash(c)
    expect(r.level, c).not.toBe('safe')
    expect(['needs_approval', 'forbidden'], `${c} -> ${r.level}`).toContain(r.level)
  })

  it('redirect target outside the worktree keeps its strictness (heredoc placed after or before the redirect)', () => {
    for (const c of [
      `cat <<'EOF' > ../outside.txt\nhello\nEOF`,
      `cat > ../outside.txt <<'EOF'\nhello\nEOF`,
      `cat >> /etc/hosts <<'EOF'\nhello\nEOF`,
      `tee ../outside.txt <<'EOF'\nhello\nEOF`,
      `tee -a /tmp/x <<'EOF'\nhello\nEOF`,
    ]) {
      const r = bash(c)
      expect(r.level, c).toBe('needs_approval')
      expect(r.reasons.join(' '), c).toMatch(/outside the worktree/)
    }
  })

  it('a command smuggled after the terminator (or on the opener line) is analysed', () => {
    for (const c of [
      `cat > src/a.txt <<'EOF'\nhi\nEOF\nrm -rf /`,
      `cat > src/a.txt <<'EOF'\nhi\nEOF\ngit push --force`,
      `cat > src/a.txt <<'EOF'\nhi\nEOF && rm -rf /`,
      `cat > src/a.txt <<'EOF'\nhi\n EOF\nrm -rf /`, // indented terminator does not terminate; body runs to the end
      `cat > src/a.txt <<'EOF'; rm -rf /\nhi\nEOF`,
      `cat > src/a.txt <<'EOF' && rm -rf /\nhi\nEOF`,
      `cat > src/a.txt <<'EOF' $(rm -rf /)\nhi\nEOF`,
      `cat > src/a.txt <<'EOF' \`rm -rf /\`\nhi\nEOF`,
    ]) {
      const r = bash(c)
      expect(r.level, c).toBe('needs_approval')
    }
  })

  it('does not look inside the body of a heredoc it cannot vouch for', () => {
    const c = `xargs <<'EOF'\ncat > f <<'EOF2'\nrm -rf /\nEOF2\nEOF`
    expect(bash(c).level).toBe('needs_approval')
  })

  // 0.9.1: a quoted heredoc read by python, node, perl or ruby is a program in that language, judged as the same
  // program given with -c (opaque, with the power and NEXUS-data checks). Read as shell, it only caught shell text
  // the interpreter would refuse, and stopped real edits for an approval (see program-heredocs.test.ts).
  it.each([
    [`python - <<'EOF'\nimport os; os.system('rm -rf /')\nrm -rf /\nEOF`, `python -c "import os; os.system('rm -rf /')\nrm -rf /"`],
    [`python3 - <<'EOF'\nrm -rf /\nEOF`, `python3 -c "rm -rf /"`],
    [`node - <<'EOF'\nrm -rf /\nEOF`, `node -e "rm -rf /"`],
    [`perl <<'EOF'\nrm -rf /\nEOF`, `perl -e "rm -rf /"`],
    [`ruby <<'EOF'\nrm -rf /\nEOF`, `ruby -e "rm -rf /"`],
  ])('judges an interpreter heredoc as the inline form of the same program: %s', (heredoc, inline) => {
    expect(bash(heredoc).level, heredoc).toBe(bash(inline).level)
  })

  it('an unterminated heredoc is left alone', () => {
    expect(bash(`cat > src/a.txt <<'EOF'\nrm -rf /\n`).level).toBe('needs_approval')
  })
})
