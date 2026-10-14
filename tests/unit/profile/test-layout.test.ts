import { describe, expect, it } from 'vitest'
import { describeTestLayout } from '@main/modules/profile/test-layout'

describe('describeTestLayout', () => {
  const files = [
    'src/main/modules/progress/service.ts',
    'src/renderer/src/views/settings/settingsForm.ts',
    'src/shared/ids.ts',
    'tests/unit/progress/service.test.ts',
    'tests/unit/renderer/settingsForm.test.ts',
    'tests/integration/git/merge.test.ts',
    'tests/scenarios/overnight.test.ts',
    'package.json',
  ]
  const vitest = { name: 'vitest.config.ts', text: "test: { projects: [{ test: { environment: 'node' } }, { test: { environment: 'node' } }] }" }

  it('says where the tests are, how they are named, the environment, and that there is no DOM testing', () => {
    const lines = describeTestLayout({ files, deps: { vitest: '5' }, runnerConfigs: [vitest] })
    expect(lines[0]).toBe('Tests: 4 files, named *.test.ts; in tests/unit/ (2), tests/integration/ (1), tests/scenarios/ (1)')
    expect(lines).toContain('Test environment (vitest.config.ts): node')
    expect(lines).toContain('No DOM or component testing library installed: interface code is tested through the functions it uses.')
    expect(lines.at(-1)).toBe('For example: src/main/modules/progress/service.ts -> tests/unit/progress/service.test.ts')
  })

  it('names the DOM library when there is one, and says nothing for a project without tests', () => {
    expect(describeTestLayout({ files, deps: { '@testing-library/react': '16', jsdom: '25' }, runnerConfigs: [] })).toContain('DOM or component testing installed: React Testing Library, jsdom')
    expect(describeTestLayout({ files: ['src/a.ts'], deps: {}, runnerConfigs: [] })).toEqual([])
  })
})
