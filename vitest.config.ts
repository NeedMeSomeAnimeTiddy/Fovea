import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

// Test files resolve `@shared/*` the same way the electron-vite builds do. Without this only
// type-only `@shared` imports survive, because those are erased before the test ever runs.
export default defineConfig({
  resolve: { alias: { '@shared': resolve('src/shared') } },
  test: {
    // The website and Playwright harness have separate runners and dependencies.
    // Keep this positive match rooted in the desktop suite so nested projects cannot
    // be collected merely by adding another `*.test.*` file.
    include: ['tests/**/*.{test,spec}.?(c|m)[jt]s?(x)'],
    exclude: ['tests/visual/**']
  }
})
