import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const configDirectory = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  root: resolve(configDirectory, '../..'),
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': resolve(configDirectory, '../../src/shared')
    }
  },
  server: {
    host: '127.0.0.1',
    strictPort: true
  }
})
