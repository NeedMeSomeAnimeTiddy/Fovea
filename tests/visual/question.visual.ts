import { expect, test } from '@playwright/test'
import { openVisual } from './support'

test.describe('Question visual states', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 504, height: 504 })
  })

  test('initial automatic question', async ({ page }) => {
    await openVisual(page, { renderer: 'question', scenario: 'initial', theme: 'dark' })
    await expect(page.getByText('Looking at your capture…')).toBeVisible()
    await expect(page).toHaveScreenshot('question--initial--dark--transparent--504x504--dsf1.png')
  })

  test('streaming answer', async ({ page }) => {
    await openVisual(page, { renderer: 'question', scenario: 'streaming', theme: 'dark' })
    await expect(page.getByText('Writing the answer…')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Stop answering' })).toBeVisible()
    await expect(page).toHaveScreenshot('question--streaming--dark--transparent--504x504--dsf1.png')
  })

  test('completed answer in light appearance', async ({ page }) => {
    await openVisual(page, { renderer: 'question', scenario: 'completed', theme: 'light' })
    await expect(page.getByText('This is a privacy-safe synthetic report with a clear primary action.')).toBeVisible()
    await expect(page).toHaveScreenshot('question--completed--light--transparent--504x504--dsf1.png')
  })

  test('long provider error', async ({ page }) => {
    await openVisual(page, { renderer: 'question', scenario: 'error', theme: 'dark' })
    await expect(page.getByRole('alert')).toContainText('The answer could not be completed')
    await expect(page).toHaveScreenshot('question--error-long--dark--transparent--504x504--dsf1.png')
  })

  test('long answer keeps its own scroll region', async ({ page }) => {
    await openVisual(page, { renderer: 'question', scenario: 'long-answer', theme: 'dark' })
    await expect(page.getByRole('heading', { name: 'Recommended interpretation' })).toBeVisible()
    const scrollable = await page.locator('.response-content').evaluate((element) => element.scrollHeight > element.clientHeight)
    expect(scrollable).toBe(true)
    await expect(page).toHaveScreenshot('question--answer-long--dark--transparent--504x504--dsf1.png')
  })

  test('wide tall and tiny attachments', async ({ page }) => {
    await openVisual(page, { renderer: 'question', scenario: 'attachments', theme: 'light' })
    await expect(page.getByRole('region', { name: 'Conversation images' })).toContainText('3 images')
    await expect(page.locator('.attachment-thumbnail')).toHaveCount(3)
    await expect(page).toHaveScreenshot('question--attachments-wide-tall-tiny--light--504x504--dsf1.png')
  })
})
