import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

// Test files resolve `@shared/*` the same way the electron-vite builds do. Without this only
// type-only `@shared` imports survive, because those are erased before the test ever runs.
export default defineConfig({
  resolve: { alias: { '@shared': resolve('src/shared') } }
})
