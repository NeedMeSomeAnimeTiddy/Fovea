import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ResponsePhase } from '../src/shared/types/app'
import { createAppError, redactTechnicalDetails, toAppError, toIpcResult } from '../src/main/errors/app-error'
import { WindowFrame } from '../src/renderer/window-chrome/WindowFrame'
import {
  AppStatusNotice,
  ResponseStatus,
  spectralStateForPhase
} from '../src/renderer/status/status-presentation'

describe('spectral lifecycle presentation', () => {
  it.each([
    ['idle', 'idle'],
    ['connecting', 'connecting'],
    ['thinking', 'thinking'],
    ['streaming', 'streaming'],
    ['awaiting-approval', 'idle'],
    ['completed', 'completed'],
    ['stopped', 'stopped'],
    ['failed', 'error']
  ] satisfies Array<[ResponsePhase, ReturnType<typeof spectralStateForPhase>]>)('maps %s to %s', (phase, edge) => {
    expect(spectralStateForPhase(phase)).toBe(edge)
  })

  it('renders one hidden, pointer-transparent animated edge without glow runners', () => {
    const markup = renderToStaticMarkup(<WindowFrame edgeState="streaming" title="Fovea">Content</WindowFrame>)
    const css = readFileSync(new URL('../src/renderer/window-chrome/window-chrome.css', import.meta.url), 'utf8')

    expect(markup.match(/class="window-edge-glow"/g)).toHaveLength(1)
    expect(markup).not.toContain('window-edge-glow__runner')
    expect(markup).toContain('aria-hidden="true"')
    expect(markup).toContain('data-edge-state="streaming"')
    expect(css).toContain('pointer-events: none;')
    expect(css).toContain("[data-visible='false'] .window-edge-glow::before")
    expect(css).toMatch(/\.window-edge-glow\s*\{[\s\S]+overflow: hidden;/)
    expect(css).toMatch(/\.window-edge-glow::before\s*\{[\s\S]+animation: fovea-edge-spectrum/)
    expect(css).toContain('@keyframes fovea-edge-spectrum')
    expect(css).not.toContain('window-edge-glow__runner')
    expect(css).not.toContain('fovea-edge-runner')
    expect(css).toMatch(/\[data-edge-state='stopped'\][\s\S]+\[data-edge-state='error'\][\s\S]+animation: none;/)
    expect(css).not.toContain('150vmax')
    expect(css).not.toContain('fovea-spectral-flow')
    expect(css).toMatch(/prefers-reduced-motion:[^)]+reduce[\s\S]+animation: none !important/)
  })

  it('uses visible text and icons for active, complete, stopped, and failed phases', () => {
    for (const [phase, label] of [
      ['streaming', 'Answering…'],
      ['completed', 'Complete'],
      ['stopped', 'Stopped'],
      ['failed', 'Failed']
    ] as const) {
      const markup = renderToStaticMarkup(<ResponseStatus phase={phase} />)
      expect(markup).toContain('role="status"')
      expect(markup).toContain(label)
    }
  })
})

describe('structured application failures', () => {
  it.each([
    [new Error('Provider request failed (401)'), 'authentication-required'],
    [new TypeError('fetch failed: ENOTFOUND'), 'offline'],
    [new Error('Gateway timed out (504)'), 'timeout'],
    [new Error('Too many requests (429)'), 'rate-limited'],
    [new Error('No image-capable model is available'), 'no-compatible-models'],
    [new Error('Codex app-server exited'), 'sidecar-terminated']
  ] as const)('normalises %s', (error, code) => {
    expect(toAppError(error).code).toBe(code)
  })

  it('redacts secrets, auth URLs, image payloads, and bounds technical details', () => {
    const raw = `sk-secret https://example.com/oauth/callback access_token=secret data:image/png;base64,${'a'.repeat(800)}`
    const safe = redactTechnicalDetails(raw)

    expect(safe).not.toContain('sk-secret')
    expect(safe).not.toContain('access_token=secret')
    expect(safe).not.toContain('base64')
    expect(safe.length).toBeLessThanOrEqual(500)
  })

  it('transports failures as a typed result and keeps details collapsed in the notice', async () => {
    const failure = await toIpcResult(() => { throw new Error('fetch failed for sk-secret') })
    expect(failure).toMatchObject({ ok: false, error: { code: 'offline' } })

    const error = createAppError('offline', 'You appear to be offline', 'Check the connection.', 'retry', 'fetch failed')
    const markup = renderToStaticMarkup(<AppStatusNotice error={error} onRecovery={vi.fn()} />)
    expect(markup).toContain('role="alert"')
    expect(markup).toContain('Try again')
    expect(markup).toContain('<details class="app-status__details">')
    expect(markup).not.toContain('<details open=""')
  })
})
