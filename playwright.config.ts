import { defineConfig } from '@playwright/test'

/**
 * End-to-end tests drive the built Electron app (`out/`) through `_electron`; no browser downloads are needed.
 * One worker: the app takes a single-instance lock and each test owns a whole app + data directory.
 */
export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 180_000,
  expect: { timeout: 30_000 },
  reporter: [['list']],
  outputDir: 'test-results/e2e-artifacts',
  use: {
    trace: 'off',
    actionTimeout: 15_000,
  },
})
