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
  // Stored images of the screens that are the same on every run (see tests/e2e/v3.spec.ts). They are specific
  // to the machine's font rendering; regenerate with `pnpm test:e2e --update-snapshots` after a deliberate change.
  expect: { timeout: 30_000, toHaveScreenshot: { maxDiffPixelRatio: 0.01 } },
  snapshotPathTemplate: 'tests/e2e/__screenshots__/{arg}{ext}',
  reporter: [['list']],
  outputDir: 'test-results/e2e-artifacts',
  use: {
    trace: 'off',
    actionTimeout: 15_000,
  },
})
