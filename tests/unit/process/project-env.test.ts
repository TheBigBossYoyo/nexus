import { describe, expect, it } from 'vitest'
import { projectCommandEnv } from '@main/modules/process'

describe('environment of project commands', () => {
  it('withholds Claude credentials and Node redirection, in any letter case, and keeps the rest', () => {
    const env = projectCommandEnv({
      PATH: 'C:/Windows',
      ANTHROPIC_API_KEY: 'sk-secret',
      Anthropic_Auth_Token: 'token',
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth',
      NODE_OPTIONS: '--require ./evil.js',
      node_path: 'C:/elsewhere',
      APPDATA: 'C:/Users/x/AppData',
      EMPTY: undefined,
    })
    expect(env).toEqual({ PATH: 'C:/Windows', APPDATA: 'C:/Users/x/AppData' })
  })

  it('never mutates the environment it was given', () => {
    const base = { ANTHROPIC_API_KEY: 'sk-secret', PATH: 'x' }
    projectCommandEnv(base)
    expect(base).toEqual({ ANTHROPIC_API_KEY: 'sk-secret', PATH: 'x' })
  })
})
