import { describe, expect, it } from 'vitest'
import { classifyCommand, onlyTestsExistence } from '@main/modules/policies/command-classifier'

// Two findings of the 0.8 acceptance with real sessions (2026-10-11): commands that are inside the project
// were put to the user as boundary requests. Each case here is a command a session actually ran, and its
// hostile neighbour, which must stay a finding.

const ROOT = 'C:\\work\\project'
const findings = (command: string, shell: 'bash' | 'powershell' = 'bash'): string[] => classifyCommand(command, shell, { roots: [ROOT] }).findings.map((f) => f.reason)

describe('0.8 classifier corrections', () => {
  it('a .NET write whose path is in the worktree is not outside it because of what is written', () => {
    expect(findings('[IO.File]::AppendAllText("$PWD\\README.md", "`nMaintained with NEXUS.`n"); Get-Content README.md', 'powershell')).toEqual([])
    expect(findings("[IO.File]::WriteAllText('notes.txt', 'a $value with `ticks`')", 'powershell')).toEqual([])
  })

  it('the same APIs with a path outside the worktree are still a finding', () => {
    expect(findings('[IO.File]::AppendAllText("C:\\Users\\x\\.bashrc", "x")', 'powershell').join(' ')).toMatch(/outside|\.NET/)
    expect(findings('[IO.File]::WriteAllText("$env:USERPROFILE\\x.txt", "x")', 'powershell').join(' ')).toMatch(/outside|\.NET/)
    // Where the method takes two paths, the second is one.
    expect(findings('[IO.File]::Copy("README.md", "C:\\Users\\x\\copy.md")', 'powershell').join(' ')).toMatch(/outside|\.NET/)
    expect(findings('[IO.File]::Move("README.md", "..\\..\\elsewhere.md")', 'powershell').join(' ')).toMatch(/outside|\.NET/)
  })

  it('the text echo and printf print is not a path, and where it is sent still is', () => {
    expect(findings("printf '\\r\\nMaintained with NEXUS.\\r\\n' >> README.md && git diff && npm test 2>&1 | tail -15")).toEqual([])
    expect(findings("echo '\\Users\\x is where it lives' >> notes.txt")).toEqual([])
    expect(findings("printf 'x' >> ../../outside.txt").join(' ')).toMatch(/outside/)
    expect(findings('echo x > C:\\Users\\x\\.bashrc').join(' ')).toMatch(/outside/)
  })

  it("reading the worktree's own .git entry is not a finding", () => {
    expect(findings('cat .git')).toEqual([])
    expect(findings('git status; cat .git; ls src')).toEqual([])
    expect(findings('Get-Content .git', 'powershell')).toEqual([])
    expect(findings('type .git', 'powershell')).toEqual([])
  })

  it('anything below a .git directory, and any write to the entry, still is', () => {
    expect(findings('cat .git/config').join(' ')).toMatch(/Git's own files/)
    expect(findings('cat .git/hooks/pre-commit').join(' ')).toMatch(/Git's own files/)
    expect(findings('Get-Content .git\\config', 'powershell').join(' ')).toMatch(/Git's own files/)
    expect(classifyCommand('echo "gitdir: /elsewhere" > .git', 'bash', { roots: [ROOT] }).level).toBe('forbidden')
    expect(classifyCommand('cat .git > copy.txt; rm .git', 'bash', { roots: [ROOT] }).level).toBe('forbidden')
    expect(findings('cat .git | tee .git').length).toBeGreaterThan(0)
  })

  it('two backslashes before a word are not a network path; a server and a share still are', () => {
    const bs = String.fromCharCode(92)
    expect(findings(`git cat-file -p HEAD:README.md | od -c | grep -c '${bs}${bs}r'; git ls-files --eol README.md`)).toEqual([])
    expect(findings(`grep -c '${bs}${bs}n' README.md`)).toEqual([])
    expect(findings(`cat ${bs}${bs}server${bs}share${bs}file.txt`, 'powershell').join(' ')).toMatch(/UNC path/)
    expect(findings(`type ${bs}${bs}.${bs}pipe${bs}other`, 'powershell').join(' ')).toMatch(/UNC path/)
    expect(findings('cat //server/share/file.txt').join(' ')).toMatch(/UNC path/)
  })

  it('a command that only tests whether paths exist may name Git\'s files and paths of the project', () => {
    const REPO = 'C:\\work\\repo'
    const of = (command: string): string[] => classifyCommand(command, 'powershell', { roots: [ROOT], projectRoot: REPO }).findings.map((f) => f.reason)
    // What the session ran.
    const real = `foreach ($d in 'C:/work/repo/.git/worktrees/task-1','C:/work/repo/.git') { "$d FETCH_HEAD: $(Test-Path "$d/FETCH_HEAD")"; "$d refs/remotes: $(Test-Path "$d/refs/remotes")" }`
    expect(onlyTestsExistence(real)).toBe(true)
    expect(of(real)).toEqual([])
    expect(of('Test-Path .git')).toEqual([])
    expect(of("if (Test-Path 'C:/work/repo/.git/FETCH_HEAD' -PathType Leaf) { 'yes' } else { 'no' }")).toEqual([])
    // A path that is in neither the worktree nor the project is still a question; a secret still is one.
    expect(of("Test-Path 'C:/Users/x/elsewhere'").join(' ')).toMatch(/outside the worktree/)
    expect(of('Test-Path ~/.ssh/id_rsa').join(' ')).toMatch(/secrets/)
    // Its neighbours: anything that can do more than test is read as before.
    for (const hostile of [
      `foreach ($d in 'C:/work/repo/.git') { Remove-Item "$d/config" }`,
      `foreach ($d in 'C:/work/repo/.git') { Test-Path "$d/config"; "x" > "$d/config" }`,
      `foreach ($d in 'C:/work/repo/.git') { Test-Path "$d/config" | Out-File "$d/hooks/pre-commit" }`,
      `foreach ($d in 'C:/work/repo/.git') { "$(Test-Path $d) $(Set-Content "$d/config" x)" }`,
      `foreach ($d in 'C:/work/repo/.git') { Test-Path (Remove-Item "$d/config") }`,
      `$d = Get-Item 'C:/work/repo/.git'; Test-Path $d.Delete()`,
      `foreach ($d in 'C:/work/repo/.git') { Test-Path $d; [IO.File]::Delete("$d/config") }`,
      `foreach ($d in 'C:/work/repo/.git') { Test-Path $d; & "$d/hooks/x" }`,
      "Test-Path 'C:/work/repo/.git'\nRemove-Item 'C:/work/repo/.git/config'",
      "Get-Content 'C:/work/repo/.git/config'",
    ]) {
      expect(onlyTestsExistence(hostile), hostile).toBe(false)
      expect(of(hostile).join(' '), hostile).toMatch(/Git's own|\.git/)
    }
    // Only PowerShell is read this way.
    expect(classifyCommand('Test-Path .git', 'bash', { roots: [ROOT], projectRoot: REPO }).findings.length).toBeGreaterThan(0)
  })
})
