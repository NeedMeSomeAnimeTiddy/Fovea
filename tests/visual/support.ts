import { expect, type Page } from '@playwright/test'
import type { VisualMaterial, VisualRenderer } from './fixtures/states'

export const VISUAL_BASE_URL = 'http://127.0.0.1:4173'

export interface OpenVisualOptions {
  renderer: VisualRenderer
  scenario: string
  theme?: 'dark' | 'light'
  material?: VisualMaterial
  width?: number
  height?: number
}

export async function openVisual(page: Page, options: OpenVisualOptions): Promise<void> {
  const externalRequests: string[] = []
  page.on('request', (request) => {
    const url = new URL(request.url())
    if ((url.protocol === 'http:' || url.protocol === 'https:') && !isHarnessHost(url.hostname)) {
      externalRequests.push(url.toString())
    }
  })
  const parameters = new URLSearchParams({
    renderer: options.renderer,
    scenario: options.scenario,
    theme: options.theme ?? 'dark',
    material: options.material ?? 'transparent',
    session: 'visual-session'
  })
  if (options.width) parameters.set('width', String(options.width))
  if (options.height) parameters.set('height', String(options.height))

  await page.goto(`/tests/visual/harness/index.html?${parameters}`)
  await page.locator('body[data-visual-harness-ready="true"]').waitFor()
  await settleVisualPage(page)
  expect(externalRequests, 'visual fixtures must not request public network resources').toEqual([])
}

export async function settleVisualPage(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.ready
    await Promise.all([...document.images].map(async (image) => {
      if (image.complete) return
      await image.decode().catch(() => undefined)
    }))
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
  })
}

export async function expectNoPageOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => ({
    x: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    y: document.documentElement.scrollHeight - document.documentElement.clientHeight
  }))
  expect(overflow).toEqual({ x: 0, y: 0 })
}

function isHarnessHost(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === 'localhost'
}
