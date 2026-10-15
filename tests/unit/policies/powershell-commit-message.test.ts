import { describe, expect, it } from 'vitest'
import { classifyCommand } from '@main/modules/policies/command-classifier'
import { neutralizePowerShellCommitHereStrings } from '@main/modules/policies/shell-tokenizer'

const opts = { roots: ['C:\\w\\repo'] }
const ps = (command: string) => classifyCommand(command, 'powershell', opts)

// 0.9.1: a repair agent's commit, its message in a single-quoted here-string, was put to the owner as a branch write
// and a redirection: the message quoted `git branch --list` and its own <noreply@anthropic.com> address.
describe('a PowerShell commit message in a single-quoted here-string', () => {
  const message = [
    "git add tests/scenarios/read-snapshot.test.ts; git commit -q -m @'",
    'fix(tests): the read-snapshot scenario retries a branch listing',
    '',
    'The test polls `git branch --list`; git branch -D x and rm -rf / are only words here.',
    '',
    'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>',
    "'@; git log --oneline -1",
  ].join('\n')

  it('is the message, not commands', () => {
    expect(ps(message).level).not.toBe('needs_approval')
    expect(neutralizePowerShellCommitHereStrings(message)).toBe('git add tests/scenarios/read-snapshot.test.ts; git commit -q -m MESSAGE; git log --oneline -1')
  })

  it('leaves what follows the terminator, the double-quoted form and other commands to the analysis', () => {
    expect(ps("git commit -m @'\nmsg\n'@; Remove-Item -Recurse -Force C:\\Windows").level).not.toBe('write')
    expect(neutralizePowerShellCommitHereStrings('git commit -m @"\n$(Remove-Item x)\n"@')).toContain('Remove-Item')
    expect(neutralizePowerShellCommitHereStrings("Write-Output @'\ngit branch -D main\n'@")).toContain('git branch -D main')
    expect(neutralizePowerShellCommitHereStrings("git commit -m @'\nno terminator")).toContain('no terminator')
  })
})
