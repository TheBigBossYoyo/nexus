import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const alias = {
  '@shared': resolve(import.meta.dirname, 'src/shared'),
  '@main': resolve(import.meta.dirname, 'src/main'),
}

const packageVersion = (
  JSON.parse(readFileSync(resolve(import.meta.dirname, 'package.json'), 'utf8')) as {
    version: string
  }
).version
const gitRead = (args: string[]) => {
  try {
    return execFileSync('git', args, {
      cwd: import.meta.dirname,
      encoding: 'utf8',
      windowsHide: true,
    }).trim()
  } catch {
    return 'unknown'
  }
}
// The channel is read from the version and from nothing else: `x.y.z-development` while the source moves,
// `x.y.z-rc.n` for a candidate, a plain `x.y.z` for a release.
function buildChannel(version: string): 'development' | 'candidate' | 'release' {
  if (/^\d+\.\d+\.\d+$/.test(version)) return 'release'
  return /-rc(\.\d+)?$/.test(version) ? 'candidate' : 'development'
}
const buildDefine = {
  __NEXUS_BUILD__: JSON.stringify({
    version: packageVersion,
    commit: gitRead(['rev-parse', 'HEAD']),
    dirty: gitRead(['status', '--porcelain']) !== '',
    builtAt: new Date().toISOString(),
    channel: buildChannel(packageVersion),
  }),
}

export default defineConfig({
  main: {
    define: buildDefine,
    resolve: { alias },
    build: {
      // Three entry points: the app (window or runtime, by argument), the worker the runtime forks, and the
      // runtime hosted by plain Node, which tests start and kill without a window.
      rollupOptions: {
        input: {
          index: resolve(import.meta.dirname, 'src/main/index.ts'),
          worker: resolve(import.meta.dirname, 'src/main/worker.ts'),
          'runtime-node': resolve(import.meta.dirname, 'src/main/runtime-node.ts'),
          // 0.9.1: speech recognition of a call runs in a thread of its own.
          'speech-worker': resolve(import.meta.dirname, 'src/main/modules/director-line/local-speech-worker.ts'),
        },
      },
    },
  },
  preload: {
    resolve: { alias },
    build: {
      rollupOptions: {
        input: { index: resolve(import.meta.dirname, 'src/preload/index.ts') },
        // Sandboxed preload scripts cannot be ES modules.
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: resolve(import.meta.dirname, 'src/renderer'),
    resolve: {
      alias: { ...alias, '@renderer': resolve(import.meta.dirname, 'src/renderer/src') },
    },
    plugins: [react(), tailwindcss()],
    build: {
      rollupOptions: { input: { index: resolve(import.meta.dirname, 'src/renderer/index.html') } },
    },
  },
})
