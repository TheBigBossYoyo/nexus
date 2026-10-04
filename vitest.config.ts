import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

const alias = {
  '@shared': resolve(import.meta.dirname, 'src/shared'),
  '@main': resolve(import.meta.dirname, 'src/main'),
}

export default defineConfig({
  resolve: { alias },
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'unit',
          environment: 'node',
          include: ['tests/unit/**/*.test.ts'],
          sequence: { groupOrder: 0 },
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'integration',
          environment: 'node',
          // The overnight state-machine stress is fast (stub orchestrator, in-memory database) and runs with every suite.
          include: ['tests/integration/**/*.test.ts', 'tests/scenarios/**/*.test.ts', 'tests/stress/overnight-*.test.ts'],
          // Scenario tests drive real git and SQLite; leave headroom for a loaded machine.
          // Generous on purpose: these waits bound a hang, they are not performance assertions, and the machine may be busy.
          testTimeout: 240_000,
          // Scenario files each drive several git processes; too many at once starve one another.
          maxWorkers: 6,
          sequence: { groupOrder: 1 },
          hookTimeout: 60_000,
        },
      },
    ],
  },
})
