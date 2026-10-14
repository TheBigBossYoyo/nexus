import { describe, expect, it } from 'vitest'
import { needsForFindings } from '@main/modules/autonomy/tool-capabilities'
import { classifyCommand, localFetchPorts } from '@main/modules/policies/command-classifier'

const opts = { roots: ['C:\\w\\repo'] }
const needs = (command: string, localPorts: number[]) => needsForFindings(classifyCommand(command, 'bash', opts).findings, { contained: true, localPorts }).map((n) => n.capability)

// 0.9.1: in a real mission on a web application, a worker's `curl 127.0.0.1:3999` and `kill %1` were put to the owner
// as "reach an external host" and "change Windows configuration".
describe('fetching from the project application, and stopping the shell own jobs', () => {
  it('a fetch from a port of the application NEXUS launched for the session is the project local endpoint', () => {
    expect(needs('curl -si 127.0.0.1:3999/lib/filter.js', [3999])).toEqual(['LOCALHOST_APP_NETWORK'])
    expect(needs('curl -s -X POST -H "content-type: application/json" -d "{}" http://localhost:3999/api/notes', [3999])).toEqual(['LOCALHOST_APP_NETWORK'])
    expect(needs('wget -qO- http://[::1]:3999/', [3999])).toEqual(['LOCALHOST_APP_NETWORK'])
  })

  it('any other loopback port, any rerouting, redirect-following or other address is still external', () => {
    expect(needs('curl -s http://localhost:3999/', [])).toEqual(['EXTERNAL_HOST_NETWORK'])
    expect(needs('curl -s http://localhost:5000/', [3999])).toEqual(['EXTERNAL_HOST_NETWORK'])
    expect(localFetchPorts('curl', ['-s', '--connect-to', 'localhost:3999:evil.example:80', 'http://localhost:3999/'])).toBeNull()
    expect(localFetchPorts('curl', ['-sL', 'http://localhost:3999/'])).toBeNull()
    expect(localFetchPorts('curl', ['-x', 'http://proxy:8080', 'http://localhost:3999/'])).toBeNull()
    expect(localFetchPorts('curl', ['-K', 'opts.txt', 'http://localhost:3999/'])).toBeNull()
    expect(localFetchPorts('curl', ['http://127.0.0.1:3999', 'http://evil.example'])).toBeNull()
    expect(localFetchPorts('curl', ['http://localhost/'])).toBeNull()
  })

  it('kill of the shell own jobs is not a change to the machine; kill of a pid still is', () => {
    for (const c of ['kill %1', 'kill -9 %1', 'kill -s TERM %%', 'kill $!']) expect(classifyCommand(c, 'bash', opts).findings, c).toEqual([])
    expect(needs('kill 1234', [])).toEqual(['MODIFY_SYSTEM_CONFIG'])
    expect(needs('kill %1 1234', [])).toEqual(['MODIFY_SYSTEM_CONFIG'])
  })
})
