import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  GlassPanel,
  IconButton,
  Select,
  Spinner,
  StatusBanner,
  Switch,
  TextArea,
  TextInput,
  WindowControls
} from '../src/renderer/design-system'
import { WindowFrame } from '../src/renderer/window-chrome/WindowFrame'
import { WINDOW_SURFACE_INSET } from '../src/main/windows/window-appearance'
import { calculateTooltipPosition } from '../src/renderer/design-system/components/Tooltip'

describe('Fovea design-system components', () => {
  it('renders actions as native buttons with stable loading semantics', () => {
    const standard = renderToStaticMarkup(<Button disabled>Save</Button>)
    const loading = renderToStaticMarkup(<Button loading loadingLabel="Saving settings">Save</Button>)

    expect(standard).toContain('<button')
    expect(standard).toContain('type="button"')
    expect(standard).toContain('disabled=""')
    expect(loading).toContain('aria-busy="true"')
    expect(loading).toContain('disabled=""')
    expect(loading).toContain('fui-button__content">Save</span>')
    expect(loading).toContain('role="status">Saving settings</span>')
  })

  it('requires and renders an accessible IconButton label', () => {
    const markup = renderToStaticMarkup(
      <IconButton icon={<svg viewBox="0 0 24 24" />} label="Copy answer" />
    )

    expect(markup).toContain('aria-label="Copy answer"')
    expect(markup).toContain('aria-hidden="true"')
    expect(() => renderToStaticMarkup(<IconButton icon={<svg />} label=" " />)).toThrow(/non-empty accessible label/)
  })

  it('keeps tooltips inside the viewport and flips above bottom-row controls', () => {
    const tooltip = { width: 120, height: 28 }
    const viewport = { width: 480, height: 320 }
    const left = calculateTooltipPosition(
      { left: 0, right: 32, top: 100, bottom: 132, width: 32, height: 32 },
      tooltip,
      viewport
    )
    const bottomRight = calculateTooltipPosition(
      { left: 448, right: 480, top: 288, bottom: 320, width: 32, height: 32 },
      tooltip,
      viewport
    )

    expect(left).toMatchObject({ x: 68, placement: 'below' })
    expect(bottomRight).toMatchObject({ x: 412, placement: 'above', y: 252 })
  })

  it('wires input descriptions, errors, invalid state, and native props', () => {
    const markup = renderToStaticMarkup(
      <TextInput
        aria-describedby="external-help"
        description="Stored locally"
        disabled
        error="API key is required"
        id="api-key"
        label="API key"
        name="apiKey"
      />
    )

    expect(markup).toContain('<label class="fui-field__label" for="api-key"')
    expect(markup).toContain('id="api-key-description"')
    expect(markup).toContain('id="api-key-error"')
    expect(markup).toContain('aria-describedby="external-help api-key-description api-key-error"')
    expect(markup).toContain('aria-invalid="true"')
    expect(markup).toContain('name="apiKey"')
    expect(markup).toContain('disabled=""')
  })

  it('retains native textarea and select elements', () => {
    const textArea = renderToStaticMarkup(<TextArea label="Question" resize="none" rows={4} />)
    const select = renderToStaticMarkup(
      <Select defaultValue="fast" label="Model">
        <option value="fast">Fast</option>
      </Select>
    )

    expect(textArea).toContain('<textarea')
    expect(textArea).toContain('data-resize="none"')
    expect(textArea).toContain('rows="4"')
    expect(select).toContain('<select')
    expect(select).toContain('<option value="fast" selected="">Fast</option>')
  })

  it('uses native checkbox semantics for Switch', () => {
    const markup = renderToStaticMarkup(
      <Switch
        defaultChecked
        description="Starts after sign in"
        disabled
        label="Launch at startup"
        name="launchAtStartup"
      />
    )

    expect(markup).toContain('type="checkbox"')
    expect(markup).toContain('checked=""')
    expect(markup).toContain('disabled=""')
    expect(markup).toContain('name="launchAtStartup"')
    expect(markup).not.toContain('role="switch"')
  })

  it('renders ConfirmDialog as a labelled modal card with the cancel action focused first', () => {
    const markup = renderToStaticMarkup(
      <ConfirmDialog cancelLabel="Keep" confirmLabel="Delete all history" destination="everything.json" title="Delete history?" tone="danger" onCancel={() => undefined} onConfirm={() => undefined}>
        This cannot be undone.
      </ConfirmDialog>
    )

    expect(markup).toContain('role="presentation"')
    expect(markup).toContain('role="dialog"')
    expect(markup).toContain('aria-modal="true"')
    expect(markup).toMatch(/aria-labelledby="([^"]+)"[^>]*>[\s\S]*id="\1"[^>]*>Delete history\?</)
    expect(markup).toMatch(/aria-describedby="([^"]+)"[^>]*>[\s\S]*id="\1"[^>]*>This cannot be undone\.</)
    expect(markup).toContain('class="fui-card fui-confirm-dialog"')
    expect(markup).toContain('data-tone="danger"')
    expect(markup).toContain('<code>everything.json</code>')
    expect(markup).toMatch(/<button[^>]*data-modal-initial-focus="true"[^>]*data-variant="secondary"[^>]*>[\s\S]*?Keep</)
    expect(markup).toMatch(/<button[^>]*data-variant="danger"[^>]*>[\s\S]*?Delete all history</)
    expect(markup).not.toContain('role="alert"')
  })

  it('renders semantic surface elements without adding behaviour', () => {
    const card = renderToStaticMarkup(<Card as="section">Settings</Card>)
    const panel = renderToStaticMarkup(
      <GlassPanel as="article" elevation="floating" variant="strong">
        Conversation
      </GlassPanel>
    )

    expect(card).toContain('<section')
    expect(card).not.toContain('tabindex')
    expect(panel).toContain('<article')
    expect(panel).toContain('data-elevation="floating"')
    expect(panel).toContain('data-variant="strong"')
  })

  it('keeps Badge status text visible', () => {
    const markup = renderToStaticMarkup(<Badge tone="success">Connected</Badge>)

    expect(markup).toContain('data-tone="success"')
    expect(markup).toContain('fui-badge__text">Connected</span>')
  })

  it('labels standalone spinners and hides decorative spinners', () => {
    const decorative = renderToStaticMarkup(<Spinner />)
    const standalone = renderToStaticMarkup(<Spinner label="Loading conversation" size="large" />)

    expect(decorative).toContain('aria-hidden="true"')
    expect(standalone).toContain('role="status"')
    expect(standalone).toContain('aria-label="Loading conversation"')
  })

  it('uses status by default and alert only when requested', () => {
    const standard = renderToStaticMarkup(<StatusBanner>Connection restored</StatusBanner>)
    const urgent = renderToStaticMarkup(
      <StatusBanner role="alert" tone="error">
        Capture failed
      </StatusBanner>
    )

    expect(standard).toContain('role="status"')
    expect(standard).toContain('aria-hidden="true"')
    expect(urgent).toContain('role="alert"')
    expect(urgent).toContain('data-tone="error"')
  })

  it('renders only supplied window actions with labelled decorative SVGs', () => {
    const markup = renderToStaticMarkup(
      <WindowControls onClose={vi.fn()} onMinimize={vi.fn()} />
    )

    expect(markup).toContain('aria-label="Minimize window"')
    expect(markup).toContain('aria-label="Close window"')
    expect(markup).not.toContain('aria-label="Maximize window"')
    expect(markup).toContain('aria-hidden="true"')
    expect(markup).toContain('focusable="false"')
    expect(markup).toContain('stroke="currentColor"')
  })

  it('renders labelled minimize, maximize, restore, and close actions', () => {
    const floating = renderToStaticMarkup(
      <WindowControls onClose={vi.fn()} onMaximize={vi.fn()} onMinimize={vi.fn()} />
    )
    const maximized = renderToStaticMarkup(
      <WindowControls maximized onClose={vi.fn()} onMaximize={vi.fn()} onMinimize={vi.fn()} />
    )

    expect(floating).toContain('aria-label="Minimize window"')
    expect(floating).toContain('aria-label="Maximize window"')
    expect(floating).toContain('aria-label="Close window"')
    expect(floating).not.toContain('aria-label="Restore window"')
    expect(maximized).toContain('aria-label="Restore window"')
    expect(maximized).not.toContain('aria-label="Maximize window"')
    expect(maximized).toContain('aria-hidden="true"')
    expect(maximized).toContain('focusable="false"')
  })

  it('renders all eight unfocusable resize regions outside the application surface', () => {
    const markup = renderToStaticMarkup(<WindowFrame title="Settings">Content</WindowFrame>)
    const edges = [
      'top',
      'right',
      'bottom',
      'left',
      'top-left',
      'top-right',
      'bottom-right',
      'bottom-left'
    ]

    for (const edge of edges) expect(markup).toContain(`data-resize-edge="${edge}"`)
    expect(markup.match(/data-resize-edge=/g)).toHaveLength(8)
    expect(markup).not.toContain('tabindex=')
    expect(markup.indexOf('data-resize-edge=')).toBeLessThan(markup.indexOf('class="window-surface"'))
  })

  it('keeps the full-inset CSS partition on the one shared 12px metric', () => {
    const tokens = readFileSync(new URL('../src/renderer/design-system/styles/tokens.css', import.meta.url), 'utf8')
    const chrome = readFileSync(new URL('../src/renderer/window-chrome/window-chrome.css', import.meta.url), 'utf8')

    expect(WINDOW_SURFACE_INSET).toBe(12)
    expect(tokens).toMatch(/--fovea-space-6:\s*0\.75rem;/)
    expect(chrome).toContain('--window-frame-inset: var(--fovea-space-6);')
    expect(chrome.match(/var\(--window-frame-inset\)/g)).toHaveLength(14)
    expect(chrome).toContain('pointer-events: auto;')
    expect(chrome).not.toMatch(/window-resize-region[^}]+(?:11px|12px|0\.75rem)/s)
  })

  it('gives question sessions the shared labelled title-bar controls', () => {
    const markup = renderToStaticMarkup(<WindowFrame title="Fovea">Question content</WindowFrame>)

    expect(markup).toContain('<section aria-label="Fovea" class="window-surface">')
    expect(markup).toContain('aria-label="Minimize window"')
    expect(markup).toContain('aria-label="Maximize window"')
    expect(markup).toContain('aria-label="Close window"')
    expect(markup).toContain('window-titlebar__title">Fovea</span>')
  })

  it('can replace the full title bar with overlaid compact controls', () => {
    const markup = renderToStaticMarkup(
      <WindowFrame compactControlsIntegrated showCompactControls showTitlebar={false} title="Fovea" titlebarActions={<span>Pin action</span>}>
        Question content
      </WindowFrame>
    )

    expect(markup).toContain('class="window-compact-controls"')
    expect(markup).toContain('data-integrated="true"')
    expect(markup).toContain('Pin action')
    expect(markup).toContain('aria-label="Minimize window"')
    expect(markup).toContain('aria-label="Close window"')
    expect(markup).not.toContain('aria-label="Maximize window"')
    expect(markup).not.toContain('window-titlebar')
    expect(markup.indexOf('window-compact-controls')).toBeGreaterThan(markup.indexOf('window-frame__content'))

    const chrome = readFileSync(new URL('../src/renderer/window-chrome/window-chrome.css', import.meta.url), 'utf8')
    expect(chrome).toMatch(/\.window-compact-controls\s*\{[^}]*pointer-events:\s*auto;/s)
    expect(chrome).toMatch(/\.window-compact-controls,[^}]*-webkit-app-region:\s*no-drag;/s)
  })
})
