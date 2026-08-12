import { readdirSync, type Dirent } from 'node:fs'
import { join, resolve } from 'node:path'
import { defineConfig } from '@playwright/test'

const visualPort = 4173
const snapshotRoot = resolve('tests/visual/__snapshots__')

/**
 * True once any approved baseline has been committed. Before that, every screenshot assertion
 * fails for the same reason and buries the assertions that describe real behaviour, so the
 * comparison is skipped rather than reported as a wall of identical failures.
 */
function hasApprovedBaselines(directory = snapshotRoot): boolean {
  let entries: Dirent[]
  try {
    entries = readdirSync(directory, { withFileTypes: true })
  } catch {
    return false
  }
  return entries.some((entry) => (
    entry.isDirectory()
      ? hasApprovedBaselines(join(directory, entry.name))
      : entry.isFile() && entry.name.endsWith('.png')
  ))
}

/*
 * Generating baselines must still write them, so an update run never skips the comparison.
 *
 * Playwright reloads this config in every worker process, and a worker's argv carries none of the
 * CLI flags. Reading argv alone therefore holds in the parent and silently flips back in the
 * workers, which is where the screenshots are actually taken: the run reports success and writes
 * nothing. The flag is promoted to the environment, which workers inherit, and CI sets the same
 * variable directly so the decision never depends on when this file happens to be evaluated.
 */
const UPDATE_ENV = 'FOVEA_VISUAL_UPDATE_BASELINES'
const updateRequestedOnCommandLine = process.argv.some((argument) => (
  argument === '-u' || argument === '--update-snapshots' || argument.startsWith('--update-snapshots=')
))
if (updateRequestedOnCommandLine) process.env[UPDATE_ENV] = 'true'
const updatingBaselines = updateRequestedOnCommandLine || process.env[UPDATE_ENV] === 'true'
const ignoreSnapshots = !updatingBaselines && !hasApprovedBaselines()
if (ignoreSnapshots) {
  console.warn(
    '[visual] No approved baselines found under tests/visual/__snapshots__, so screenshot ' +
    'comparison is skipped and this run only proves the non-screenshot assertions. Generate ' +
    'baselines with the visual workflow before reading a pass as visual coverage.'
  )
}

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
  ignoreSnapshots,
  outputDir: 'test-results/visual',
  snapshotPathTemplate: '{testDir}/__snapshots__/{projectName}/{arg}{ext}',
  // `github` annotates each failure with its message in the run summary. Without it the CI
  // reporter lists failed names only, which is how two real regressions stayed invisible.
  reporter: process.env.CI
    ? [['github'], ['line'], ['html', { open: 'never', outputFolder: 'playwright-report/visual' }]]
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
