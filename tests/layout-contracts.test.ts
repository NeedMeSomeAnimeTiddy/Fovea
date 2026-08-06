import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const settingsCss = readFileSync(new URL('../src/renderer/settings/settings.css', import.meta.url), 'utf8')
const questionCss = readFileSync(new URL('../src/renderer/question-window/question.css', import.meta.url), 'utf8')
const chromeCss = readFileSync(new URL('../src/renderer/window-chrome/window-chrome.css', import.meta.url), 'utf8')
const componentsCss = readFileSync(new URL('../src/renderer/design-system/styles/components.css', import.meta.url), 'utf8')

describe('floating UI geometry contracts', () => {
  it('raises an open provider menu above following settings cards', () => {
    expect(settingsCss).toMatch(
      /\.provider-profiles-section:has\(\.profile-menu__popover\)\s*\{[^}]*z-index:\s*var\(--fovea-z-overlay\);/s
    )
  })

  it('insets the Ask menu from both viewport edges', () => {
    expect(questionCss).toMatch(
      /\.ask-menu\s*\{[^}]*position:\s*fixed;[^}]*right:\s*var\(--fovea-space-10\);[^}]*left:\s*var\(--fovea-space-10\);[^}]*width:\s*auto;/s
    )
  })

  it('keeps integrated window controls circular', () => {
    expect(chromeCss).toMatch(
      /\.window-compact-controls \.fui-window-controls__button\s*\{[^}]*width:\s*var\(--fovea-control-target-compact\);[^}]*height:\s*var\(--fovea-control-target-compact\);[^}]*min-height:\s*var\(--fovea-control-target-compact\);[^}]*aspect-ratio:\s*1;/s
    )
  })

  it('reserves response-header space for export, pin, minimize, and close', () => {
    expect(questionCss).toMatch(
      /\.response-card__header\s*\{[^}]*padding:[^;]*calc\(\(var\(--fovea-control-target-compact\) \* 4\) \+ var\(--fovea-space-8\)\)/s
    )
  })

  it('keeps tooltips on one safely truncated line', () => {
    expect(componentsCss).toMatch(
      /\.fui-tooltip\s*\{[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap;/s
    )
  })
})
