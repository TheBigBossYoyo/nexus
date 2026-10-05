import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const alias = {
  '@shared': resolve(import.meta.dirname, 'src/shared'),
  '@main': resolve(import.meta.dirname, 'src/main'),
}

export default defineConfig({
  main: {
    resolve: { alias },
    build: {
      // Three entry points: the app (window or runtime, by argument), the worker the runtime forks, and the
      // runtime hosted by plain Node, which tests start and kill without a window.
      rollupOptions: {
        input: {
          index: resolve(import.meta.dirname, 'src/main/index.ts'),
          worker: resolve(import.meta.dirname, 'src/main/worker.ts'),
          'runtime-node': resolve(import.meta.dirname, 'src/main/runtime-node.ts'),
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
