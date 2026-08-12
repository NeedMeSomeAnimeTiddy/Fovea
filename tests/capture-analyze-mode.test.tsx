// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CaptureContext } from '../src/shared/contracts/ipc'
import type { CaptureFeature } from '../src/shared/types/app'
import {
  AnalyzeLegend,
  CaptureHud,
  FeatureAskMenu,
  captureRectangleForFeature,
  displayFeatureLabel,
  featuresAtPoint,
  holdLiveSurfaceForAnalyze,
  overlaySurfaceClass,
  questionsForFeature,
  webQuestionForFeature
} from '../src/renderer/capture-overlay/main'

afterEach(cleanup)

const context: CaptureContext = {
  width: 1_000,
  height: 600,
  minSelectionSize: 24,
  surface: 'frozen',
  imageDataUrl: 'data:image/png;base64,',
  canEditBeforeSending: true
}

describe('capture Analyze mode', () => {
  it('shows a color key for every feature category', () => {
    render(<AnalyzeLegend />)

    expect(screen.getByRole('list', { name: 'Analyze color key' })).toBeTruthy()
    expect(screen.getAllByRole('listitem').map(({ textContent }) => textContent)).toEqual([
      'Controls',
      'Text',
      'Links',
      'Values',
      'Faces',
      'Visuals',
      'Issues'
    ])
  })

  it('offers Analyze from the bottom bar and exposes its active state', async () => {
    const user = userEvent.setup()
    const onToggleAnalyze = vi.fn()
    const { rerender } = render(
      <CaptureHud
        canEditBeforeSending
        detail="Select a region"
        editBeforeSending={false}
        error={false}
        extractText={false}
        ocrLanguageCode=""
        ocrLanguages={[]}
        preferWebSearch={false}
        onCancel={vi.fn()}
        onOcrLanguageChange={vi.fn()}
        onToggleAnalyze={onToggleAnalyze}
        onToggleEdit={vi.fn()}
        onToggleExtractText={vi.fn()}
        onToggleWebSearch={vi.fn()}
      />
    )

    await user.click(screen.getByRole('button', { name: 'Analyze full screen' }))
    expect(onToggleAnalyze).toHaveBeenCalledTimes(1)

    rerender(
      <CaptureHud
        analyzeActive
        canEditBeforeSending
        detail="Choose one of 12 identified features"
        editBeforeSending={false}
        error={false}
        extractText={false}
        ocrLanguageCode=""
        ocrLanguages={[]}
        preferWebSearch={false}
        onCancel={vi.fn()}
        onOcrLanguageChange={vi.fn()}
        onToggleAnalyze={onToggleAnalyze}
        onToggleEdit={vi.fn()}
        onToggleExtractText={vi.fn()}
        onToggleWebSearch={vi.fn()}
      />
    )
    expect(screen.getByRole('button', { name: 'Exit Analyze mode' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByText('Analyze mode')).toBeTruthy()
  })

  it('locks Analyze while the live frame is being held', () => {
    render(
      <CaptureHud
        analyzeBusy
        analyzeHoldInFlight
        canEditBeforeSending
        detail="Holding this moment for Analyze…"
        editBeforeSending={false}
        error={false}
        extractText={false}
        ocrLanguageCode=""
        ocrLanguages={[]}
        preferWebSearch={false}
        onCancel={vi.fn()}
        onOcrLanguageChange={vi.fn()}
        onToggleAnalyze={vi.fn()}
        onToggleEdit={vi.fn()}
        onToggleExtractText={vi.fn()}
        onToggleWebSearch={vi.fn()}
      />
    )

    const analyze = screen.getByRole('button', { name: 'Holding current screen for Analyze' }) as HTMLButtonElement
    expect(analyze.disabled).toBe(true)
    expect(screen.getByText('Holding current screen')).toBeTruthy()
  })

  it('does not freeze after a live frame hold has been cancelled', async () => {
    let finishFrame!: (value: boolean) => void
    const captureVideoFrame = vi.fn(() => new Promise<boolean>((resolve) => { finishFrame = resolve }))
    const freeze = vi.fn(async () => ({ ...context, surface: 'frozen' as const, imageDataUrl: 'data:image/png;base64,' }))
    let current = true

    const holding = holdLiveSurfaceForAnalyze({ captureVideoFrame, freeze }, () => current)
    current = false
    finishFrame(false)

    await expect(holding).resolves.toBeNull()
    expect(freeze).not.toHaveBeenCalled()
  })

  it('shows predetermined questions for a selected feature', async () => {
    const user = userEvent.setup()
    const onAsk = vi.fn()
    const onCopy = vi.fn()
    const onExtractText = vi.fn()
    const onSearchWeb = vi.fn()
    const feature: CaptureFeature = {
      id: 'error-1',
      kind: 'error',
      label: 'Connection failed',
      description: 'The server did not respond',
      role: 'alert',
      bounds: { x: 0.2, y: 0.3, width: 0.18, height: 0.06 }
    }
    render(
      <FeatureAskMenu
        context={context}
        feature={feature}
        onAsk={onAsk}
        onClose={vi.fn()}
        onCopy={onCopy}
        onExtractText={onExtractText}
        onSearchWeb={onSearchWeb}
      />
    )

    await user.click(screen.getByRole('menuitem', { name: 'How do I fix this?' }))
    expect(onAsk).toHaveBeenCalledWith('How do I fix this?')
    expect(screen.getByText('The server did not respond')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Extract text from this feature' }))
    await user.click(screen.getByRole('button', { name: 'Copy detected text' }))
    await user.click(screen.getByRole('button', { name: 'Search the web about this feature' }))
    expect(onExtractText).toHaveBeenCalledTimes(1)
    expect(onCopy).toHaveBeenCalledTimes(1)
    expect(onSearchWeb).toHaveBeenCalledTimes(1)
    expect(questionsForFeature(feature)).toEqual([
      'Explain this error',
      'How do I fix this?',
      'What caused this?',
      'What should I try first?'
    ])
    expect(webQuestionForFeature(feature)).toBe('Search for this error and explain the most likely fix: Connection failed')
  })

  it('disables Copy when a visual feature has no detected text', () => {
    render(
      <FeatureAskMenu
        context={context}
        feature={{ id: 'visual-1', kind: 'visual', label: 'Visual element', bounds: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } }}
        onAsk={vi.fn()}
        onClose={vi.fn()}
        onCopy={vi.fn()}
        onExtractText={vi.fn()}
        onSearchWeb={vi.fn()}
      />
    )

    expect((screen.getByRole('button', { name: 'Copy detected text' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('offers person-specific questions and web search for a detected face', async () => {
    const user = userEvent.setup()
    const onAsk = vi.fn()
    const onSearchWeb = vi.fn()
    const feature: CaptureFeature = {
      id: 'face-1',
      kind: 'face',
      label: 'Face 1',
      role: 'face',
      bounds: { x: 0.25, y: 0.15, width: 0.12, height: 0.2 }
    }
    render(
      <FeatureAskMenu
        context={context}
        feature={feature}
        onAsk={onAsk}
        onClose={vi.fn()}
        onCopy={vi.fn()}
        onExtractText={vi.fn()}
        onSearchWeb={onSearchWeb}
      />
    )

    await user.click(screen.getByRole('menuitem', { name: 'Who is this person?' }))
    await user.click(screen.getByRole('button', { name: 'Search the web for this person' }))

    expect(onAsk).toHaveBeenCalledWith('Who is this person?')
    expect(onSearchWeb).toHaveBeenCalledTimes(1)
    expect((screen.getByRole('button', { name: 'Copy detected text' }) as HTMLButtonElement).disabled).toBe(true)
    expect(webQuestionForFeature(feature)).toContain('do not guess')
  })

  it('never exposes undefined as a feature label', () => {
    expect(displayFeatureLabel({ kind: 'control', label: 'undefined' })).toBe('Unlabelled button')
    expect(displayFeatureLabel({ kind: 'visual', label: undefined as never })).toBe('Unlabelled feature')
    expect(displayFeatureLabel({ kind: 'face', label: undefined as never })).toBe('Face')
  })

  it('expands small detected features to a valid capture around their centre', () => {
    expect(captureRectangleForFeature({
      id: 'tiny',
      kind: 'visual',
      label: 'Visual element',
      bounds: { x: 0.99, y: 0.99, width: 0.005, height: 0.005 }
    }, context)).toEqual({
      x: 976,
      y: 576,
      width: 24,
      height: 24
    })
  })

  it('ranks every overlapping target so repeated clicks can reach boxes behind a container', () => {
    const features: CaptureFeature[] = [
      {
        id: 'container',
        kind: 'text',
        label: 'Settings panel',
        rank: 50,
        bounds: { x: 0.1, y: 0.1, width: 0.7, height: 0.7 }
      },
      {
        id: 'button',
        kind: 'control',
        label: 'Save',
        rank: 95,
        bounds: { x: 0.2, y: 0.2, width: 0.1, height: 0.08 }
      }
    ]

    expect(featuresAtPoint(features, { x: 0.25, y: 0.24 }).map(({ id }) => id)).toEqual(['button', 'container'])
  })
})

describe('capture overlay surface class', () => {
  const error = { code: 'capture-failed', title: 'Screen image unavailable', message: 'No screen image.', recovery: 'retry' } as const

  it('keeps the controls inert only while a surface is still being prepared', () => {
    expect(overlaySurfaceClass(null, null)).toBe('loading')
  })

  it('does not reuse the inert loading class for a context that failed', () => {
    // `.overlay.loading` hides the capture bar and disables pointer events, which would leave a
    // failed capture with no visible error, no Retry, and no right-click cancel.
    expect(overlaySurfaceClass(null, error)).toBe('failed')
  })

  it('follows the surface once one exists, whatever happened earlier', () => {
    expect(overlaySurfaceClass(context, null)).toBe('frozen')
    expect(overlaySurfaceClass({ ...context, surface: 'live', imageDataUrl: null }, error)).toBe('live')
  })
})
