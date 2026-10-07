import { createHmac, randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startRuntimeCore } from './runtime/core'

/**
 * The runtime hosted by plain Node instead of Electron. It is the same core with no tray, no notifications
 * and a signing key that lives in memory. Tests use it to start, kill and restart a real runtime process
 * without a window; it is not what the app ships as its runtime.
 */
const dataDir = process.env['NEXUS_DATA_DIR']
if (!dataDir) {
  console.error('[nexus] NEXUS_DATA_DIR is required')
  process.exit(2)
}
const secret = randomBytes(32)

startRuntimeCore({
  dataDir,
  version: process.env['NEXUS_VERSION'] ?? '0.0.0-node',
  isPackaged: false,
  resourcesPath: undefined,
  casesDir: process.env['NEXUS_CASES_DIR'] ?? join(process.cwd(), 'arena', 'cases'),
  tempDir: tmpdir(),
  sdkVersion: 'unknown',
  env: process.env,
  worker: { entry: process.env['NEXUS_WORKER_ENTRY'] ?? join(import.meta.dirname, 'worker.js') },
  createSealer: () => ({ sign: (payload) => createHmac('sha256', secret).update(payload).digest('base64') }),
  exit: (code) => process.exit(code),
})
  .then((core) => {
    // The parent test reads this line to know that the runtime listens.
    console.log(`NEXUS_RUNTIME_READY ${core.identity.bootId}`)
    process.on('SIGTERM', () => void core.shutdown())
  })
  .catch((e: unknown) => {
    console.error(`[nexus] runtime startup failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`)
    process.exit(1)
  })
