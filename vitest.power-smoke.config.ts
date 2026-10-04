import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

// Manually invoked only (`pnpm smoke:power`). Talks to the real Windows shutdown timer: it schedules a
// shutdown an hour away and aborts it immediately. Never part of `pnpm test`.
export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(import.meta.dirname, 'src/shared'),
      '@main': resolve(import.meta.dirname, 'src/main'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/manual/power.smoke.ts'],
    testTimeout: 60_000,
  },
})
