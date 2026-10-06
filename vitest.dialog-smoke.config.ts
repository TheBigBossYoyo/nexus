import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

// Manually invoked only (`pnpm smoke:dialog`, after `pnpm build`). Starts the real runtime process and operates
// its native confirmation through UI Automation, off-screen. Never part of `pnpm test`.
export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(import.meta.dirname, 'src/shared'),
      '@main': resolve(import.meta.dirname, 'src/main'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/manual/runtime-dialog.smoke.ts'],
    testTimeout: 240_000,
  },
})
