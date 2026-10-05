import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

// Manually invoked only (`pnpm smoke:usage`). Asks the real Claude runtime for its account information and
// its usage report. No prompt is sent and no model turn runs. Never part of `pnpm test`.
export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(import.meta.dirname, 'src/shared'),
      '@main': resolve(import.meta.dirname, 'src/main'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/manual/usage-report.smoke.ts'],
    testTimeout: 120_000,
  },
})
