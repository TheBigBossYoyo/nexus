import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

// Manually invoked only (`pnpm accept:graph`). Runs one mission twice on the real Claude runtime (0.7.0 context, then with the Context Graph) and records both. Consumes usage.
export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(import.meta.dirname, 'src/shared'),
      '@main': resolve(import.meta.dirname, 'src/main'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/manual/context-graph-acceptance.smoke.ts'],
    testTimeout: 3_600_000,
  },
})
