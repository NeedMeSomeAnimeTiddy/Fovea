import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { expectNoPageOverflow, openVisual, VISUAL_BASE_URL } from './support'
import type { VisualRenderer } from './fixtures/states'

const scales = [1.25, 1.5, 2] as const
const cases: Array<{
  renderer: VisualRenderer
  scenario: string
  viewport: { width: number; height: number }
}> = [
  { renderer: 'settings', scenario: 'default', viewport: { width: 744, height: 704 } },
  { renderer: 'overlay', scenario: 'idle', viewport: { width: 960, height: 540 } },
  { renderer: 'question', scenario: 'completed', viewport: { width: 504, height: 504 } }
]

for (const scale of scales) {
  test.describe(`renderer raster checks at ${Math.round(scale * 100)}%`, () => {
    for (const visualCase of cases) {
      test(`${visualCase.renderer} remains contained`, async ({ browser }) => {
        const { context, page } = await scaledPage(browser, visualCase.viewport, scale)
        try {
          await openVisual(page, {
            renderer: visualCase.renderer,
            scenario: visualCase.scenario,
            theme: 'dark',
            width: visualCase.viewport.width,
            height: visualCase.viewport.height
          })
          await expectNoPageOverflow(page)
          const scaleName = String(scale).replace('.', '_')
          await expect(page).toHaveScreenshot(
            `${visualCase.renderer}--${visualCase.scenario}--dark--dsf${scaleName}.png`
          )
        } finally {
          await context.close()
        }
      })
    }
  })
}

async function scaledPage(
  browser: Browser,
  viewport: { width: number; height: number },
  deviceScaleFactor: number
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    baseURL: VISUAL_BASE_URL,
    colorScheme: 'dark',
    deviceScaleFactor,
    locale: 'en-GB',
    reducedMotion: 'no-preference',
    serviceWorkers: 'block',
    timezoneId: 'Europe/London',
    viewport
  })
  return { context, page: await context.newPage() }
}
