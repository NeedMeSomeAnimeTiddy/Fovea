import { expect, test } from '@playwright/test'
import { openVisual, settleVisualPage } from './support'

test.describe('Settings visual states', () => {
  test('dark populated account', async ({ page }) => {
    await page.setViewportSize({ width: 744, height: 704 })
    await openVisual(page, { renderer: 'settings', scenario: 'default', theme: 'dark' })
    await expect(page.getByRole('heading', { level: 1, name: 'Account' })).toBeVisible()
    await expect(page).toHaveScreenshot('settings--account--dark--transparent--744x704--dsf1.png')
  })

  test('light appearance settings', async ({ page }) => {
    await page.setViewportSize({ width: 744, height: 704 })
    await openVisual(page, { renderer: 'settings', scenario: 'default', theme: 'light' })
    await page.getByRole('button', { name: 'Appearance' }).click()
    await expect(page.getByRole('heading', { level: 1, name: 'Appearance' })).toBeVisible()
    await settleVisualPage(page)
    await expect(page).toHaveScreenshot('settings--appearance--light--transparent--744x704--dsf1.png')
  })

  test('onboarding first step', async ({ page }) => {
    await page.setViewportSize({ width: 744, height: 704 })
    await openVisual(page, { renderer: 'settings', scenario: 'onboarding', theme: 'dark' })
    await expect(page.getByRole('heading', { level: 1, name: 'Ask anything you can see' })).toBeVisible()
    await expect(page).toHaveScreenshot('settings--onboarding--dark--transparent--744x704--dsf1.png')
  })

  test('solid fallback fills the native surface', async ({ page }) => {
    await page.setViewportSize({ width: 720, height: 680 })
    await openVisual(page, { renderer: 'settings', scenario: 'default', theme: 'dark', material: 'solid' })
    await expect(page.locator('.window-shell')).toHaveAttribute('data-material', 'solid')
    await expect(page).toHaveScreenshot('settings--account--dark--solid--720x680--dsf1.png')
  })

  test('synthetic available update', async ({ page }) => {
    await page.setViewportSize({ width: 744, height: 704 })
    await openVisual(page, { renderer: 'settings', scenario: 'default', theme: 'dark' })
    await page.getByRole('button', { name: 'Updates' }).click()
    await expect(page.getByRole('heading', { level: 2, name: 'Application updates' })).toBeVisible()
    await expect(page.getByText('Fovea synthetic visual release')).toBeVisible()
    await settleVisualPage(page)
    await expect(page).toHaveScreenshot('settings--updates-available--dark--transparent--744x704--dsf1.png')
  })
})
