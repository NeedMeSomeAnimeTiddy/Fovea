import { defineConfig } from '@playwright/test'

const visualPort = 4173

export default defineConfig({
  testDir: './tests/visual',
  testMatch: '**/*.visual.ts',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  timeout: 30_000,
  expect: {
    timeout: 8_000,
    toHaveScreenshot: {
      animations: 'disabled',
      caret: 'hide',
      maxDiffPixelRatio: 0.002,
      threshold: 0.2
    }
  },
  outputDir: 'test-results/visual',
  snapshotPathTemplate: '{testDir}/__snapshots__/{projectName}/{arg}{ext}',
  reporter: process.env.CI
    ? [['line'], ['html', { open: 'never', outputFolder: 'playwright-report/visual' }]]
    : [['list'], ['html', { open: 'never', outputFolder: 'playwright-report/visual' }]],
  use: {
    baseURL: `http://127.0.0.1:${visualPort}`,
    browserName: 'chromium',
    colorScheme: 'dark',
    deviceScaleFactor: 1,
    locale: 'en-GB',
    reducedMotion: 'no-preference',
    screenshot: 'only-on-failure',
    serviceWorkers: 'block',
    timezoneId: 'Europe/London',
    trace: 'retain-on-failure',
    viewport: { width: 744, height: 704 }
  },
  projects: [
    {
      name: 'chromium-windows',
      use: { browserName: 'chromium' }
    }
  ],
  webServer: {
    command: `npx vite --configLoader runner --config tests/visual/vite.config.ts --host 127.0.0.1 --port ${visualPort}`,
    reuseExistingServer: !process.env.CI,
    stderr: 'pipe',
    stdout: 'pipe',
    timeout: 120_000,
    url: `http://127.0.0.1:${visualPort}/tests/visual/harness/index.html`
  }
})
