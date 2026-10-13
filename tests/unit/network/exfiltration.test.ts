import { describe, expect, it } from 'vitest'
import { budgetDomain, MAX_QUERY_CHARS, screenOutboundUrl } from '@main/modules/network/exfiltration'

// 0.9 (review finding K-1): a URL an agent names can be the leak. The values that look like credentials are
// assembled from parts, so that the repository's own scan for credentials does not find them.
const join = (...parts: string[]): string => parts.join('')
const rule = (url: string, secrets: string[] = []): string => {
  const verdict = screenOutboundUrl(url, secrets)
  return verdict.allowed ? 'ALLOWED' : verdict.rule
}

describe('what a URL an agent names may carry out', () => {
  it('ordinary pages are opened: documentation, searches, commits, packages, issues', () => {
    for (const url of [
      'https://learn.microsoft.com/en-us/windows/win32/secauthz/appcontainer-isolation',
      'https://www.electronjs.org/docs/latest/tutorial/security#17-validate-the-sender-of-all-ipc-messages',
      'https://github.com/libuv/libuv/commit/8a499e13f4a40f8c9ca4dee3a9dc4abbc17ac87e',
      'https://github.com/nodejs/node/issues?q=is%3Aissue+named+pipe+appcontainer&sort=updated',
      'https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk/v/0.3.288',
      'https://registry.npmjs.org/better-sqlite3/-/better-sqlite3-13.0.3.tgz',
      'https://duckduckgo.com/html/?q=windows+appcontainer+capability+sid+per+session+access+check',
      'https://docs.python.org/3/library/pathlib.html?highlight=resolve#pathlib.Path.resolve',
      'https://example.org/blog/2026/10/13/a-rather-long-title-about-windows-sandboxing-and-its-many-surprises-in-practice/',
      'https://cdn.example.org/files/3b1c2f0de4a59b6c7d8e9f00112233445566778899aabbccddeeff0011223344/manual.pdf',
      'https://stackoverflow.com/questions/61442219/what-is-the-difference-between-a-capability-sid-and-a-package-sid',
    ]) expect(rule(url), url).toBe('ALLOWED')
  })

  it('a query that is data is refused: by its length, by its number of parameters, by a run of encoded text', () => {
    expect(rule(`https://collector.example/?d=${'word '.repeat(120).replace(/ /g, '+')}`)).toBe('QUERY_LENGTH')
    expect(rule(`https://collector.example/?${Array.from({ length: 21 }, (_, i) => `p${i}=v`).join('&')}`)).toBe('QUERY_PARAMETERS')
    expect(rule(`https://collector.example/?d=${Buffer.from('export const TOKEN = process.env.API; // notes').toString('base64')}`)).toBe('TOKEN_RUN')
    expect(rule(`https://collector.example/?d=${Buffer.from('the contents of a file of the project').toString('hex')}`)).toBe('TOKEN_RUN')
    expect(rule(`https://collector.example/?d=${Buffer.from('the contents of a file of the project!').toString('base64url')}`)).toBe('TOKEN_RUN')
    expect(`x`.repeat(MAX_QUERY_CHARS).length).toBe(512)
  })

  it('a path or a host name that is data is refused', () => {
    expect(rule(`https://collector.example/${Buffer.from('a whole paragraph of what the session read in the worktree, as hex').toString('hex')}`)).toBe('TOKEN_RUN')
    expect(rule(`https://${Buffer.from('secret project text here').toString('hex').slice(0, 48)}.collector.example/`)).toBe('TOKEN_RUN')
  })

  it('what looks like a credential is refused wherever it stands, encoded or not', () => {
    const github = join('ghp_', 'Zk3vQ9mT7wLx2NcR8pYbH5dJq4sWu6eG7iKo')
    const anthropic = join('sk-ant-', 'oat01-Zk3vQ9mT')
    expect(rule(`https://collector.example/?t=${github}`)).toBe('CREDENTIAL_SHAPE')
    expect(rule(`https://collector.example/${anthropic}/x`)).toBe('CREDENTIAL_SHAPE')
    expect(rule(`https://collector.example/?h=${encodeURIComponent(join('Bearer ', 'Zk3vQ9mT7wLx2NcR8pYb'))}`)).toBe('CREDENTIAL_SHAPE')
    expect(rule(join('https://collector.example/?k=', 'AKIA', 'QZ3VK9MT7WLX2NCR'))).toBe('CREDENTIAL_SHAPE')
  })

  it("a value this machine holds as a credential is refused as it is, percent-encoded, in base64 and in hex", () => {
    const secret = 'correct horse battery staple!'
    expect(rule(`https://collector.example/?q=${encodeURIComponent(secret)}`, [secret])).toBe('KNOWN_SECRET')
    expect(rule(`https://collector.example/x/${Buffer.from(secret).toString('base64url')}`, [secret])).toBe('KNOWN_SECRET')
    expect(rule(`https://collector.example/?q=${Buffer.from(secret).toString('hex')}`, [secret])).toBe('KNOWN_SECRET')
    // A short value is no credential to match on: it would refuse ordinary words.
    expect(rule('https://example.org/?q=test', ['test'])).toBe('ALLOWED')
  })

  it('a URL that cannot be read is refused', () => {
    expect(rule('not a url')).toBe('URL_INVALID')
  })
})

describe('the name a research budget is counted under', () => {
  it('every name below a registrable domain is one account', () => {
    expect(budgetDomain('a1.collector.example')).toBe('collector.example')
    expect(budgetDomain('b2.x.y.collector.example')).toBe('collector.example')
    expect(budgetDomain('collector.example')).toBe('collector.example')
    expect(budgetDomain('Docs.Python.ORG.')).toBe('python.org')
  })

  it('a second-level public name keeps three labels', () => {
    expect(budgetDomain('www.bbc.co.uk')).toBe('bbc.co.uk')
    expect(budgetDomain('a.b.example.com.tn')).toBe('example.com.tn')
  })

  it('on shared hosting each name is its own party', () => {
    expect(budgetDomain('someone.github.io')).toBe('someone.github.io')
    expect(budgetDomain('x.someone.github.io')).toBe('someone.github.io')
    expect(budgetDomain('1.1.1.1.nip.io')).toBe('1.nip.io')
  })

  it('an address is itself', () => {
    expect(budgetDomain('93.184.216.34')).toBe('93.184.216.34')
    expect(budgetDomain('[2606:2800:220:1:248:1893:25c8:1946]')).toBe('2606:2800:220:1:248:1893:25c8:1946')
  })
})
