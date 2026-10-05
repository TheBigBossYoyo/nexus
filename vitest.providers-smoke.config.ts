import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

// Manually invoked only (`pnpm smoke:providers`). Detects the optional providers and, where Codex is signed in, runs one real
// read-only review with it. Uses that provider's quota, none of Claude's. Never part of `pnpm test`.
export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(import.meta.dirname, 'src/shared'),
      '@main': resolve(import.meta.dirname, 'src/main'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/manual/providers.smoke.ts'],
    testTimeout: 600_000,
  },
})
