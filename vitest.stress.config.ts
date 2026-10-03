import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

// Seeded orchestration stress campaign (`pnpm stress`). Scripted agents only; no Claude usage.
export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(import.meta.dirname, 'src/shared'),
      '@main': resolve(import.meta.dirname, 'src/main'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/stress/**/*.test.ts'],
    testTimeout: 6 * 60 * 60 * 1000,
    hookTimeout: 120_000,
  },
})
