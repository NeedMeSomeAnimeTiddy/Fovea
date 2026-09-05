import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import { rendererCspPlugin } from './build/renderer-csp'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': resolve('src/shared') } },
    build: { rollupOptions: { input: resolve('src/main/app.ts') } }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': resolve('src/shared') } },
    build: { rollupOptions: { input: resolve('src/preload/index.ts') } }
  },
  renderer: {
    resolve: { alias: { '@shared': resolve('src/shared') } },
    // The CSP is added to built pages only; the dev server needs inline HMR and react-refresh scripts.
    plugins: [react(), rendererCspPlugin()],
    build: {
      rollupOptions: {
        input: {
          settings: resolve('src/renderer/settings/index.html'),
          overlay: resolve('src/renderer/capture-overlay/index.html'),
          question: resolve('src/renderer/question-window/index.html'),
          preview: resolve('src/renderer/image-preview/index.html'),
          'document-render': resolve('src/renderer/document-render/index.html')
        }
      }
    }
  }
})
