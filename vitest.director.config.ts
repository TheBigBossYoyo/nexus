import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

// Manually invoked only. Runs ONE real Technical Director request (Director level 1) through the production advisory routing
// (see tests/manual/technical-director.smoke.ts). Consumes usage. Never part of `pnpm test`.
export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(import.meta.dirname, 'src/shared'),
      '@main': resolve(import.meta.dirname, 'src/main'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/manual/technical-director.smoke.ts'],
    testTimeout: 900_000,
  },
})
