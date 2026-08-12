import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { openVisual, settleVisualPage } from './support'

const wcagTags = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']

test.describe('Visual accessibility states', () => {
  for (const theme of ['dark', 'light'] as const) {
    test(`Settings has no automated WCAG A or AA violations in ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width: 744, height: 704 })
      await openVisual(page, { renderer: 'settings', scenario: 'default', theme })
      await expectNoAxeViolations(page)
    })
  }

  test('completed question has no automated WCAG A or AA violations', async ({ page }) => {
    await page.setViewportSize({ width: 504, height: 504 })
    await openVisual(page, { renderer: 'question', scenario: 'completed', theme: 'dark' })
    await expectNoAxeViolations(page)
  })

  test('keyboard focus remains visibly distinct', async ({ page }) => {
    await page.setViewportSize({ width: 744, height: 704 })
    await openVisual(page, { renderer: 'settings', scenario: 'default', theme: 'dark' })
    // Counting :focus-visible only proves something took focus. The selected category already
    // carries an elevation of its own, and when that quietly replaced the shared focus ring this
    // screenshot stayed byte-identical to the unfocused view, so the appearance has to be
    // compared directly.
    const selectedCategory = page.locator('.settings-nav button').first()
    const resting = await selectedCategory.evaluate((element) => getComputedStyle(element).boxShadow)
    await page.keyboard.press('Tab')
    await expect(page.locator(':focus-visible')).toHaveCount(1)
    await expect(selectedCategory).toBeFocused()
    const focused = await selectedCategory.evaluate((element) => getComputedStyle(element).boxShadow)
    expect(focused).not.toBe(resting)
    await settleVisualPage(page)
    await expect(page).toHaveScreenshot('settings--keyboard-focus--dark--744x704--dsf1.png')
  })

  test('overlay keyboard focus is visible over captured content', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 })
    await openVisual(page, { renderer: 'overlay', scenario: 'idle', theme: 'light', width: 1280, height: 720 })
    await page.keyboard.press('Tab')
    await expect(page.locator(':focus-visible')).toHaveCount(1)
    await settleVisualPage(page)
    await expect(page).toHaveScreenshot('overlay--keyboard-focus--light--1280x720--dsf1.png')
  })

  test('reduced motion removes streaming animation', async ({ page }) => {
    await page.setViewportSize({ width: 504, height: 504 })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await openVisual(page, { renderer: 'question', scenario: 'streaming', theme: 'dark' })
    const animations = await page.evaluate(() => ({
      edge: getComputedStyle(document.querySelector('.window-edge-glow')!, '::before').animationName,
      message: getComputedStyle(document.querySelector('.conversation-message')!).animationName
    }))
    expect(animations).toEqual({ edge: 'none', message: 'none' })
    await expect(page).toHaveScreenshot('question--streaming--reduced-motion--dark--504x504--dsf1.png', { animations: 'allow' })
  })

  test('increased contrast uses opaque material tokens', async ({ page }) => {
    await page.setViewportSize({ width: 504, height: 504 })
    await page.emulateMedia({ contrast: 'more' })
    await openVisual(page, { renderer: 'question', scenario: 'completed', theme: 'light' })
    const material = await page.evaluate(() => ({
      blur: getComputedStyle(document.documentElement).getPropertyValue('--fovea-material-blur-strong').trim(),
      glow: getComputedStyle(document.documentElement).getPropertyValue('--fovea-glow-focus').trim()
    }))
    expect(material).toEqual({ blur: '0px', glow: 'none' })
    await expect(page).toHaveScreenshot('question--completed--increased-contrast--light--504x504--dsf1.png')
  })
})

async function expectNoAxeViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(wcagTags).analyze()
  const violations = results.violations.map((violation) => ({
    id: violation.id,
    targets: violation.nodes.map((node) => node.target)
  }))
  expect(violations).toEqual([])
}
