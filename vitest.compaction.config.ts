import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

// Manually invoked only. Runs ONE real session that is compacted once on purpose and checks what it still knows
// (see tests/manual/compaction-fidelity.smoke.ts). Consumes usage. Never part of `pnpm test`.
export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(import.meta.dirname, 'src/shared'),
      '@main': resolve(import.meta.dirname, 'src/main'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/manual/compaction-fidelity.smoke.ts'],
    testTimeout: 7_200_000,
  },
})
