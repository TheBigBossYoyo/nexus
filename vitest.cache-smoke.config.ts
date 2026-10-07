import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

// Manually invoked only (`pnpm smoke:cache`). Runs seven one-turn sessions on the real Claude runtime and records the prompt-cache figures of each. Consumes a little usage.
export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(import.meta.dirname, 'src/shared'),
      '@main': resolve(import.meta.dirname, 'src/main'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/manual/cache-acceptance.smoke.ts'],
    testTimeout: 600_000,
  },
})
