import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

// Manually invoked only (`pnpm smoke:voice-latency`). Runs about seven real model turns on the fast tier to
// measure how fast a warm, tool-less session answers. Never part of `pnpm test`.
export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(import.meta.dirname, 'src/shared'),
      '@main': resolve(import.meta.dirname, 'src/main'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/manual/voice-latency.smoke.ts'],
    testTimeout: 600_000,
  },
})
