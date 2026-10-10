import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

// Manually invoked only. Runs ONE task of the real quality campaign in ONE arm on the real Claude runtime
// (see tests/manual/campaign/run.smoke.ts). Consumes usage. Never part of `pnpm test`.
export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(import.meta.dirname, 'src/shared'),
      '@main': resolve(import.meta.dirname, 'src/main'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/manual/campaign/run.smoke.ts'],
    testTimeout: 7_200_000,
  },
})
