import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

// Manually invoked only (`pnpm smoke:sip`). A rehearsal of a whole call with a stand-in for the telephone (after pnpm build).
// Never part of `pnpm test`.
export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(import.meta.dirname, 'src/shared'),
      '@main': resolve(import.meta.dirname, 'src/main'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/manual/voice-call.smoke.ts'],
    testTimeout: 600_000,
  },
})
