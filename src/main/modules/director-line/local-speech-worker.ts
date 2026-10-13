import { createRequire } from 'node:module'
import { parentPort } from 'node:worker_threads'
import { serveStt, type HostToWorker, type PortLike, type WorkerToHost } from './local-speech-protocol'
import type { SherpaModule } from './local-speech-core'

/**
 * 0.9.1, local speech: the entry of the worker thread that holds speech recognition (built as its own entry,
 * `speech-worker`, next to the main bundle). The runtime process never runs a model on its own thread.
 */
if (parentPort !== null) {
  const require = createRequire(import.meta.url)
  serveStt(parentPort as unknown as PortLike<WorkerToHost, HostToWorker>, (spec) => require(spec) as SherpaModule)
}
