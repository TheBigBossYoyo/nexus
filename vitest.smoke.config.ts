import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

// Manually invoked only (`pnpm smoke:claude`). Uses the real Claude Agent SDK and consumes usage.
export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(import.meta.dirname, 'src/shared'),
      '@main': resolve(import.meta.dirname, 'src/main'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/smoke/**/*.smoke.ts'],
    testTimeout: 300_000,
    hookTimeout: 60_000,
  },
})
