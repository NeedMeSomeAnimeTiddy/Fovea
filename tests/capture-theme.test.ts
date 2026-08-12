import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const lightTheme = readFileSync(
  new URL('../src/renderer/design-system/styles/theme-light.css', import.meta.url),
  'utf8'
)
const darkTheme = readFileSync(
  new URL('../src/renderer/design-system/styles/theme-dark.css', import.meta.url),
  'utf8'
)
const overlayStyles = readFileSync(
  new URL('../src/renderer/capture-overlay/overlay.css', import.meta.url),
  'utf8'
)

const tokenValue = (source: string, token: string): string | undefined =>
  source.match(new RegExp(`${token}:\\s*([^;]+);`))?.[1]?.trim()

describe('capture overlay themes', () => {
  it('uses a complete, distinct light palette for the captured frame and controls', () => {
    const themeSpecificTokens = [
      '--fovea-capture-image-filter',
      '--fovea-capture-scrim',
      '--fovea-capture-hud-fill',
      '--fovea-capture-hud-border',
      '--fovea-capture-control-fill',
      '--fovea-capture-control-fill-hover',
      '--fovea-capture-text',
      '--fovea-capture-text-muted',
      '--fovea-capture-selection-stroke',
      '--fovea-capture-selection-fill',
      '--fovea-capture-guide',
      '--fovea-capture-error',
      '--fovea-capture-error-border',
      '--fovea-capture-selection-glow',
      '--fovea-capture-hud-shadow'
    ]

    for (const token of themeSpecificTokens) {
      expect(tokenValue(lightTheme, token), `${token} should be defined in light mode`).toBeTruthy()
      expect(tokenValue(lightTheme, token), `${token} should differ between themes`).not.toBe(
        tokenValue(darkTheme, token)
      )
    }
  })

  it('keeps the idle frozen frame visually neutral until selection begins', () => {
    expect(overlayStyles).toMatch(/\.frozen-frame\s*\{[^}]*filter:\s*none;/s)
    expect(overlayStyles).toMatch(/\.capture-scrim\s*\{[^}]*background:\s*transparent;/s)
    expect(overlayStyles).toMatch(/\.overlay\.selecting \.capture-scrim,[^{]*\{[^}]*background:\s*var\(--fovea-capture-scrim\);/s)
  })

  it('shows the initial capture controls without an entrance animation', () => {
    expect(overlayStyles).toMatch(/\.capture-hud\s*\{[^}]*animation:\s*none;/s)
  })

  it('keeps a prewarmed live overlay completely transparent until activation', () => {
    expect(overlayStyles).toMatch(/:root,\s*body\s*\{[^}]*background:\s*transparent;/s)
    expect(overlayStyles).toMatch(/\.overlay\.live\s*\{[^}]*background:\s*transparent;/s)
    expect(overlayStyles).toMatch(/\.overlay\.loading\s*\{[^}]*background:\s*transparent;[^}]*pointer-events:\s*none;/s)
    expect(overlayStyles).toMatch(/\.overlay\.loading \.capture-hud,\s*\.overlay\.loading \.capture-scrim\s*\{[^}]*display:\s*none;/s)
  })

  it('keeps the live desktop undimmed while selecting', () => {
    expect(overlayStyles).toMatch(/\.overlay\.live \.capture-scrim\s*\{[^}]*background:\s*transparent;/s)
    expect(overlayStyles).toMatch(/\.overlay\.live \.selection-root\s*\{[^}]*animation:\s*none;/s)
    expect(overlayStyles).toMatch(/\.overlay\.live \.selection-outline\s*\{[^}]*background:\s*transparent;/s)
  })

  it('keeps the text composer clear of the live annotation preview', () => {
    expect(overlayStyles).toMatch(
      /\.capture-editor-inline-text\s*\{[^}]*--capture-text-preview-clearance:\s*var\(--fovea-space-8\);/s
    )
    expect(overlayStyles).toMatch(
      /\.capture-editor-inline-text\[data-align-y='above'\]\s*\{[^}]*--capture-text-offset-y:\s*calc\(-100% - var\(--capture-text-preview-clearance\)\);/s
    )
  })

  it('does not draw a blue focus box around the text composer', () => {
    expect(overlayStyles).not.toContain('.capture-editor-inline-text:focus-within')
    expect(overlayStyles).toMatch(
      /\.capture-editor-inline-text input:focus-visible\s*\{[^}]*box-shadow:\s*none;/s
    )
  })
})
