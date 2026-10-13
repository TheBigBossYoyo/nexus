import { describe, expect, it } from 'vitest'
// @ts-expect-error a script, plain JavaScript
import { scanText } from '../../../scripts/secret-scan.mjs'

// 0.9: the scan that reads logs, evidence and release files for credentials. The values below are made up for
// this test; they are assembled from parts so that the scan of the repository itself does not find them.
const join = (...parts: string[]): string => parts.join('')
const kinds = (text: string, options?: { allowFakes: boolean }): string[] => (scanText(text, options) as { kind: string }[]).map((f) => f.kind)

describe('secret scan', () => {
  it('finds each kind of credential in a line of a log', () => {
    const cases: [string, string][] = [
      ['Anthropic key or OAuth token', join('token=', 'sk-ant-', 'oat01-Zk3vQ9mT7wLx2NcR8pYbH5dJ')],
      ['GitHub token', join('remote: ', 'ghp_', 'Zk3vQ9mT7wLx2NcR8pYbH5dJq4sWu6eG7iKo')],
      ['npm token', join('//registry.npmjs.org/:_authToken=', 'npm_', 'Zk3vQ9mT7wLx2NcR8pYbH5dJq4sWu6eG7iKo')],
      ['npm credential line', join('_auth', '=', 'dXNlcjpodW50ZXIyaHVudGVyMg==')],
      ['Authorization header', join('authorization', ': Bearer ', 'Zk3vQ9mT7wLx2NcR8pYbH5dJq4sW')],
      ['JSON Web Token', join('eyJ', 'hbGciOiJSUzI1NiJ9', '.', 'eyJ', 'zdWIiOiJ1c2VyLTQyIn0', '.', 'Zk3vQ9mT7wLx2NcR')],
      ['OAuth token field', join('{"refresh', '_token":"', 'rt_Zk3vQ9mT7wLx2NcR8pYbH5dJq4sW', '"}')],
      ['Cookie header', join('cookie', ': session=', 'Zk3vQ9mT7wLx2NcR8pYbH5dJ')],
      ['AWS access key', join('AKIA', 'QZ3VK9MT7WLX2NCR')],
      ['Credential in a URL', join('https://', 'deploy', ':', 'hunter2hunter2', '@', 'registry.internal/pkg')],
    ]
    for (const [kind, line] of cases) expect(kinds(`2026-10-13 worker: ${line}`), kind).toContain(kind)
  })

  it('never prints the value it found', () => {
    const value = join('sk-ant-', 'oat01-Zk3vQ9mT7wLx2NcR8pYbH5dJ')
    const [finding] = scanText(`x ${value} y`) as { shown: string; line: number }[]
    expect(finding?.line).toBe(1)
    expect(finding?.shown).not.toContain(value.slice(8))
    expect(finding?.shown).toContain(`${value.length} characters`)
  })

  it('a private key is a header with a body; the header alone, as every TLS library carries it, is not', () => {
    const header = join('-----BEGIN ', 'PRIVATE KEY-----')
    expect(kinds(`const PEM = '${header}'`)).toEqual([])
    expect(kinds(`${header}\n${'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQ'}\n`)).toEqual(['Private key'])
    expect(kinds(`"key":"${header}\n${'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQ'}"`)).toEqual(['Private key'])
  })

  it('the sentinels and placeholders the tests use on purpose are not findings, unless asked for', () => {
    const line = join('ANTHROPIC_API_KEY=', 'sk-ant-', 'NEXUS-ISOLATION-SENTINEL-9d2e-env-000')
    expect(kinds(line)).toEqual([])
    expect(kinds(line, { allowFakes: false })).toContain('Anthropic key or OAuth token')
    expect(kinds(join('https://', 'user:password@', 'example.com/'))).toEqual([])
  })

  it('ordinary lines of a log are not findings', () => {
    const text = ['commit 3795306d9dd47256f87579958d0f9b3c3389e08f', 'sha256 6e263d154d8548d1eb936f65d1d8312c80df31c45974e48d6335e4dcc0f4f34c', 'GET https://registry.npmjs.org/react 200', 'S-1-15-3-1024-913607018-890609827-841438636-1361414428', 'the bearer of the lease is agent-7', 'authorization: granted for the mission', '_authToken=${NPM_TOKEN}'].join('\n')
    expect(kinds(text)).toEqual([])
  })
})
