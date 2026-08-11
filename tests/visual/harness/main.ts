import { createVisualFixture, type VisualRenderer } from '../fixtures/states'
import { createVisualFoveaApi } from '../fixtures/fovea-api'

const parameters = new URLSearchParams(location.search)
const renderer = rendererFrom(parameters.get('renderer'))
const fixture = createVisualFixture({
  renderer,
  scenario: parameters.get('scenario') ?? 'default',
  theme: parameters.get('theme') === 'light' ? 'light' : 'dark',
  material: parameters.get('material') === 'solid' ? 'solid' : 'transparent',
  width: numberParameter(parameters.get('width'), innerWidth),
  height: numberParameter(parameters.get('height'), innerHeight)
})

document.documentElement.dataset.appearance = fixture.theme
document.documentElement.dataset.theme = fixture.theme
document.documentElement.dataset.transparency = fixture.material === 'solid' ? 'off' : 'on'
document.documentElement.dataset.visualHarness = 'true'
window.fovea = createVisualFoveaApi(fixture)

const entries: Record<VisualRenderer, () => Promise<unknown>> = {
  settings: () => import('../../../src/renderer/settings/main'),
  overlay: () => import('../../../src/renderer/capture-overlay/main'),
  question: () => import('../../../src/renderer/question-window/main'),
  preview: () => import('../../../src/renderer/image-preview/main')
}

await entries[renderer]()
document.body.dataset.visualHarnessReady = 'true'

function rendererFrom(value: string | null): VisualRenderer {
  if (value === 'settings' || value === 'overlay' || value === 'question' || value === 'preview') return value
  throw new Error(`Unknown visual renderer: ${value ?? '(missing)'}`)
}

function numberParameter(value: string | null, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 64 && parsed <= 4096 ? Math.round(parsed) : fallback
}
