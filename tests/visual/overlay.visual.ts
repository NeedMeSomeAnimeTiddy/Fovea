import { expect, test } from '@playwright/test'
import { openVisual, settleVisualPage } from './support'

test.describe('Capture overlay visual states', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 })
  })

  test('dark idle overlay on a synthetic desktop', async ({ page }) => {
    await openVisual(page, { renderer: 'overlay', scenario: 'idle', theme: 'dark', width: 1280, height: 720 })
    await expect(page.getByText('Drag to capture')).toBeVisible()
    await expect(page).toHaveScreenshot('overlay--idle--dark--1280x720--dsf1.png')
  })

  test('light active selection', async ({ page }) => {
    await openVisual(page, { renderer: 'overlay', scenario: 'selection', theme: 'light', width: 1280, height: 720 })
    await page.getByRole('button', { name: 'Edit before sending' }).click()
    await page.mouse.move(260, 170)
    await page.mouse.down()
    await page.mouse.move(780, 510, { steps: 4 })
    await page.mouse.up()
    await expect(page.locator('.selection-root.editing')).toBeVisible()
    await settleVisualPage(page)
    await expect(page).toHaveScreenshot('overlay--selection--light--1280x720--dsf1.png')
  })

  test('Analyze mode with deterministic features', async ({ page }) => {
    await openVisual(page, { renderer: 'overlay', scenario: 'analyze', theme: 'dark', width: 1280, height: 720 })
    await page.getByRole('button', { name: 'Analyze full screen' }).click()
    await expect(page.locator('.analyze-feature')).toHaveCount(3)
    await settleVisualPage(page)
    await expect(page).toHaveScreenshot('overlay--analyze--dark--1280x720--dsf1.png')
  })

  test('live surface leaves the desktop visible', async ({ page }) => {
    await openVisual(page, { renderer: 'overlay', scenario: 'live-idle', theme: 'dark', width: 1280, height: 720 })
    await expect(page.getByText('Drag to capture')).toBeVisible()
    await expect(page.locator('.overlay.live')).toBeVisible()
    await expect(page.locator('.frozen-frame')).toHaveCount(0)
    await expect(page).toHaveScreenshot('overlay--live-idle--dark--1280x720--dsf1.png')
  })

  test('live selection outline during a drag', async ({ page }) => {
    await openVisual(page, { renderer: 'overlay', scenario: 'live-selection', theme: 'dark', width: 1280, height: 720 })
    await page.mouse.move(260, 170)
    await page.mouse.down()
    await page.mouse.move(780, 510, { steps: 4 })
    // Screenshot mid-drag: releasing a live selection submits it immediately.
    await expect(page.locator('.overlay.live.selecting .selection-root')).toBeVisible()
    await settleVisualPage(page)
    await expect(page).toHaveScreenshot('overlay--live-selection--dark--1280x720--dsf1.png')
    await page.mouse.up()
  })

  test('live surface held for editing', async ({ page }) => {
    await openVisual(page, { renderer: 'overlay', scenario: 'live-hold', theme: 'light', width: 1280, height: 720 })
    await page.getByRole('button', { name: 'Edit before sending' }).click()
    await page.mouse.move(260, 170)
    await page.mouse.down()
    await page.mouse.move(780, 510, { steps: 4 })
    await page.mouse.up()
    // Releasing over a live surface holds the screen, so the editor works from a still frame.
    await expect(page.locator('.overlay.frozen')).toBeVisible()
    await expect(page.locator('.selection-root.editing')).toBeVisible()
    await settleVisualPage(page)
    await expect(page).toHaveScreenshot('overlay--live-hold--light--1280x720--dsf1.png')
  })

  test('privacy-safe capture error', async ({ page }) => {
    await openVisual(page, { renderer: 'overlay', scenario: 'error', theme: 'dark', width: 1280, height: 720 })
    await expect(page.getByRole('alert')).toContainText('Screen image unavailable')
    await expect(page).toHaveScreenshot('overlay--error--dark--1280x720--dsf1.png')
  })
})
