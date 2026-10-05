import { app, dialog } from 'electron'
import { errorMessage } from '@shared/result'
import { runDesktop } from './desktop'
import { RUNTIME_FLAG, runRuntime } from './runtime-electron'

/**
 * One executable, three roles (see docs/V0_7_DESIGN.md):
 *
 *   nexus-desktop    this file without arguments: the window, a client of the runtime
 *   nexus-runtime    this file with `--nexus-runtime`: the durable control plane, no window
 *   nexus-worker-N   `worker.js` run as Node by the runtime: one agent session at a time
 */
const role: 'runtime' | 'desktop' = process.argv.includes(RUNTIME_FLAG) ? 'runtime' : 'desktop'

void (role === 'runtime' ? runRuntime() : runDesktop()).catch((e: unknown) => {
  // A database or wiring failure at startup is terminal; say why instead of showing nothing.
  console.error(`[nexus] ${role} startup failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`)
  // The runtime has no window to put a message in front of; its failure is shown by the window that waits for it.
  if (role === 'desktop') dialog.showErrorBox('NEXUS failed to start', errorMessage(e))
  app.exit(1)
})
