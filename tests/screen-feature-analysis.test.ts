import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { buildCaptureAnalysis, buildCaptureAnalysisStage, classifyText, validateCaptureAnalysis } from '../src/main/capture/screen-feature-analysis'

function markedScreen(rectangles: Array<{ x: number; y: number; width: number; height: number }>): Promise<Buffer> {
  const marks = rectangles.map(({ x, y, width, height }) => `<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="#111"/>`).join('')
  return sharp(Buffer.from(`<svg width="320" height="180"><rect width="320" height="180" fill="#f4f4f4"/>${marks}</svg>`)).png().toBuffer()
}

function svgScreen(marks: string): Promise<Buffer> {
  return sharp(Buffer.from(`<svg width="320" height="180"><rect width="320" height="180" fill="#f4f4f4"/>${marks}</svg>`)).png().toBuffer()
}

describe('frozen-screen feature analysis', () => {
  it('classifies common actionable screen text', () => {
    expect(classifyText('Save')).toBe('control')
    expect(classifyText('Connection failed')).toBe('error')
    expect(classifyText('https://example.com/help')).toBe('link')
    expect(classifyText('£42.50')).toBe('value')
    expect(classifyText('Quarterly revenue')).toBe('text')
  })

  it('turns local OCR lines into bounded clickable features', async () => {
    const image = await markedScreen([{ x: 36, y: 40, width: 50, height: 8 }])
    const analysis = await buildCaptureAnalysis(image, { lines: [{
      id: 'line-1',
      text: '  Try again  ',
      confidence: 96,
      bounds: { x: 0.1, y: 0.2, width: 0.2, height: 0.08 }
    }] })

    expect(analysis.features).toContainEqual(expect.objectContaining({
      kind: 'control',
      label: 'Try again',
      bounds: expect.objectContaining({ x: 0.096, y: 0.194 })
    }))
    expect(analysis.truncated).toBe(false)
  })

  it('accepts visible text from Windows OCR when confidence is unavailable', async () => {
    const image = await markedScreen([
      { x: 30, y: 30, width: 210, height: 8 },
      { x: 30, y: 52, width: 180, height: 8 },
      { x: 30, y: 74, width: 225, height: 8 }
    ])
    const analysis = await buildCaptureAnalysis(image, {
      lines: [
        { id: 'line-1', text: 'A screen full of visible text', confidence: 0, bounds: { x: 0.09, y: 0.16, width: 0.68, height: 0.07 } },
        { id: 'line-2', text: 'must remain identifiable', confidence: 0, bounds: { x: 0.09, y: 0.28, width: 0.59, height: 0.07 } },
        { id: 'line-3', text: 'when Windows has no confidence score', confidence: 0, bounds: { x: 0.09, y: 0.4, width: 0.72, height: 0.07 } }
      ]
    })

    expect(analysis.features.map(({ label }) => label)).toEqual([
      'A screen full of visible text must remain identifiable when Windows has no confidence score'
    ])
  })

  it('uses word geometry to tighten a sentence box without exposing individual words', async () => {
    const image = await markedScreen([{ x: 34, y: 38, width: 88, height: 9 }])
    const analysis = await buildCaptureAnalysis(image, {
      lines: [{ id: 'line-1', text: 'Save changes', confidence: 96, bounds: { x: 0.1, y: 0.2, width: 0.3, height: 0.08 } }],
      words: [
        { id: 'word-1', text: 'Save', confidence: 96, bounds: { x: 0.1, y: 0.2, width: 0.1, height: 0.08 } },
        { id: 'word-2', text: 'changes', confidence: 96, bounds: { x: 0.21, y: 0.2, width: 0.19, height: 0.08 } }
      ]
    })

    const sentence = analysis.features.find(({ label }) => label === 'Save changes')
    expect(sentence).toMatchObject({ source: 'ocr-line', bounds: expect.objectContaining({ x: 0.096 }) })
    expect(sentence?.bounds.width).toBeCloseTo(0.308)
    expect(analysis.features).toHaveLength(1)
    expect(analysis.features).not.toContainEqual(expect.objectContaining({ source: 'ocr-word' }))
  })

  it('groups adjacent wrapped OCR lines into one paragraph target', () => {
    const analysis = buildCaptureAnalysisStage({
      lines: [
        {
          id: 'line-1',
          text: 'Analyze should treat these adjacent wrapped lines',
          confidence: 94,
          bounds: { x: 0.1, y: 0.2, width: 0.42, height: 0.035 }
        },
        {
          id: 'line-2',
          text: 'as one coherent paragraph instead of separate boxes.',
          confidence: 93,
          bounds: { x: 0.1, y: 0.242, width: 0.4, height: 0.035 }
        },
        {
          id: 'line-3',
          text: 'The final wrapped line remains in the same target.',
          confidence: 92,
          bounds: { x: 0.1, y: 0.284, width: 0.38, height: 0.035 }
        }
      ]
    }, 'text')

    expect(analysis.features).toEqual([
      expect.objectContaining({
        label: 'Analyze should treat these adjacent wrapped lines as one coherent paragraph instead of separate boxes. The final wrapped line remains in the same target.',
        source: 'ocr-line',
        bounds: expect.objectContaining({ x: 0.096, y: 0.194 })
      })
    ])
  })

  it('keeps interleaved columns grouped into their own paragraph targets', () => {
    const analysis = buildCaptureAnalysisStage({
      lines: [
        { id: 'left-1', text: 'The left paragraph begins with a complete thought', confidence: 94, bounds: { x: 0.08, y: 0.2, width: 0.36, height: 0.035 } },
        { id: 'right-1', text: 'The right paragraph starts alongside the first one', confidence: 94, bounds: { x: 0.56, y: 0.201, width: 0.36, height: 0.035 } },
        { id: 'left-2', text: 'and continues on its own second wrapped line.', confidence: 93, bounds: { x: 0.08, y: 0.242, width: 0.34, height: 0.035 } },
        { id: 'right-2', text: 'and also continues without splitting into two boxes.', confidence: 93, bounds: { x: 0.56, y: 0.243, width: 0.35, height: 0.035 } }
      ]
    }, 'text')

    expect(analysis.features).toHaveLength(2)
    expect(analysis.features.map(({ label }) => label)).toEqual(expect.arrayContaining([
      'The left paragraph begins with a complete thought and continues on its own second wrapped line.',
      'The right paragraph starts alongside the first one and also continues without splitting into two boxes.'
    ]))
  })

  it('keeps vertically separated interface labels as distinct targets', () => {
    const analysis = buildCaptureAnalysisStage({
      lines: [
        { id: 'line-1', text: 'Home', confidence: 95, bounds: { x: 0.1, y: 0.2, width: 0.06, height: 0.025 } },
        { id: 'line-2', text: 'Search', confidence: 95, bounds: { x: 0.1, y: 0.26, width: 0.07, height: 0.025 } }
      ]
    }, 'text')

    expect(analysis.features.map(({ label }) => label)).toEqual(['Search', 'Home'])
  })

  it('enriches a screenshot text target with its verified app role and tooltip', async () => {
    const image = await markedScreen([{ x: 30, y: 34, width: 70, height: 18 }])
    const analysis = await buildCaptureAnalysis(image, {
      lines: [{ id: 'line-1', text: 'Save', confidence: 96, bounds: { x: 0.12, y: 0.21, width: 0.12, height: 0.05 } }],
      uiFeatures: [{
        id: 'uia-save',
        kind: 'control',
        label: 'Save',
        source: 'uia',
        role: 'button',
        description: 'Save the current document',
        enabled: true,
        visibility: 1,
        bounds: { x: 0.09, y: 0.18, width: 0.24, height: 0.13 }
      }]
    })

    expect(analysis.features).toEqual([
      expect.objectContaining({
        id: 'uia-save',
        label: 'Save',
        source: 'hybrid',
        role: 'button',
        description: 'Save the current document',
        bounds: { x: 0.09, y: 0.18, width: 0.24, height: 0.13 }
      })
    ])
  })

  it('never renders accessibility-only controls in screenshot-anchored mode', async () => {
    const image = await markedScreen([{ x: 30, y: 34, width: 70, height: 18 }])
    const analysis = await buildCaptureAnalysis(image, {
      lines: [],
      screenshotAnchored: true,
      uiFeatures: [{
        id: 'uia-hidden-save',
        kind: 'control',
        label: 'Save',
        source: 'uia',
        role: 'button',
        description: 'Hidden window control',
        visibility: 1,
        visibilityVerified: true,
        bounds: { x: 0.09, y: 0.18, width: 0.24, height: 0.13 }
      }]
    })

    expect(analysis.features).toEqual([])
  })

  it('uses frozen-screen geometry while attaching accessibility labels and tooltips', async () => {
    const image = await markedScreen([{ x: 38, y: 36, width: 42, height: 18 }])
    const analysis = await buildCaptureAnalysis(image, {
      lines: [],
      screenshotAnchored: true,
      visualFeatures: [{
        id: 'omniparser-save',
        kind: 'control',
        label: 'Unlabelled button',
        source: 'visual',
        detector: 'omniparser',
        role: 'button',
        visibility: 0.91,
        bounds: { x: 0.11, y: 0.18, width: 0.16, height: 0.14 }
      }],
      uiFeatures: [{
        id: 'uia-save',
        kind: 'control',
        label: 'Save',
        source: 'uia',
        role: 'button',
        description: 'Save the current document',
        visibility: 1,
        visibilityVerified: true,
        bounds: { x: 0.09, y: 0.17, width: 0.2, height: 0.16 }
      }]
    })

    expect(analysis.features).toEqual([
      expect.objectContaining({
        id: 'uia-save',
        kind: 'control',
        label: 'Save',
        source: 'hybrid',
        detector: 'omniparser',
        role: 'button',
        description: 'Save the current document',
        bounds: { x: 0.11, y: 0.18, width: 0.16, height: 0.14 }
      })
    ])
  })

  it('keeps a detected face while suppressing OCR noise and a generic control over it', () => {
    const faceBounds = { x: 0.2, y: 0.18, width: 0.12, height: 0.2 }
    const analysis = buildCaptureAnalysisStage({
      screenshotAnchored: true,
      lines: [{
        id: 'face-ocr-noise',
        text: 'QX',
        confidence: 91,
        bounds: { x: 0.23, y: 0.24, width: 0.04, height: 0.04 }
      }],
      visualFeatures: [
        {
          id: 'face-1',
          kind: 'face',
          label: 'Face 1',
          source: 'visual',
          detector: 'yunet',
          role: 'face',
          visibility: 0.94,
          visibilityVerified: true,
          bounds: faceBounds
        },
        {
          id: 'model-face-false-control',
          kind: 'control',
          label: 'Unlabelled button',
          source: 'visual',
          detector: 'omniparser',
          role: 'button',
          visibility: 0.8,
          bounds: faceBounds
        }
      ]
    }, 'text')

    expect(analysis.features).toEqual([
      expect.objectContaining({ id: 'face-1', kind: 'face', detector: 'yunet' })
    ])
  })

  it('does not promote sentence text inside a generic model box to an unlabelled button', () => {
    const analysis = buildCaptureAnalysisStage({
      screenshotAnchored: true,
      lines: [{
        id: 'sentence',
        text: 'This ordinary sentence is visible content, not an interactive control.',
        confidence: 96,
        bounds: { x: 0.1, y: 0.3, width: 0.46, height: 0.05 }
      }],
      visualFeatures: [{
        id: 'model-text-false-positive',
        kind: 'control',
        label: 'Unlabelled button',
        source: 'visual',
        detector: 'omniparser',
        role: 'button',
        visibility: 0.81,
        bounds: { x: 0.095, y: 0.294, width: 0.47, height: 0.062 }
      }]
    }, 'text')

    expect(analysis.features).toEqual([
      expect.objectContaining({
        kind: 'text',
        label: 'This ordinary sentence is visible content, not an interactive control.',
        source: 'ocr-line'
      })
    ])
    expect(analysis.features).not.toContainEqual(expect.objectContaining({
      label: 'Unlabelled button'
    }))
  })

  it('drops low-confidence model boxes that tightly hug ordinary compact text', () => {
    const analysis = buildCaptureAnalysisStage({
      screenshotAnchored: true,
      lines: [{
        id: 'heading',
        text: 'Quarterly revenue',
        confidence: 96,
        bounds: { x: 0.12, y: 0.2, width: 0.18, height: 0.04 }
      }],
      visualFeatures: [{
        id: 'model-heading-false-positive',
        kind: 'control',
        label: 'Unlabelled button',
        source: 'visual',
        detector: 'omniparser',
        role: 'button',
        visibility: 0.31,
        bounds: { x: 0.115, y: 0.194, width: 0.19, height: 0.052 }
      }]
    }, 'text')

    expect(analysis.features).toEqual([
      expect.objectContaining({
        kind: 'text',
        label: 'Quarterly revenue',
        source: 'ocr-line'
      })
    ])
  })

  it('still uses a high-confidence model box for explicitly actionable text', () => {
    const analysis = buildCaptureAnalysisStage({
      screenshotAnchored: true,
      lines: [{
        id: 'save-label',
        text: 'Save',
        confidence: 98,
        bounds: { x: 0.12, y: 0.2, width: 0.05, height: 0.04 }
      }],
      visualFeatures: [{
        id: 'model-save',
        kind: 'control',
        label: 'Unlabelled button',
        source: 'visual',
        detector: 'omniparser',
        role: 'button',
        visibility: 0.91,
        bounds: { x: 0.1, y: 0.185, width: 0.09, height: 0.07 }
      }]
    }, 'text')

    expect(analysis.features).toEqual([
      expect.objectContaining({
        kind: 'control',
        label: 'Save',
        source: 'hybrid',
        detector: 'omniparser',
        bounds: { x: 0.1, y: 0.185, width: 0.09, height: 0.07 }
      })
    ])
  })

  it('keeps only the named button when OCR mistakes its icon for a letter', async () => {
    const image = await markedScreen([{ x: 62, y: 32, width: 28, height: 28 }])
    const analysis = await buildCaptureAnalysis(image, {
      lines: [{
        id: 'line-1',
        text: 'A',
        confidence: 91,
        bounds: { x: 0.22, y: 0.2, width: 0.035, height: 0.08 }
      }],
      uiFeatures: [{
        id: 'uia-account',
        kind: 'control',
        label: 'Account',
        source: 'uia',
        role: 'button',
        description: 'Open your account menu',
        enabled: true,
        visibility: 1,
        visibilityVerified: true,
        bounds: { x: 0.18, y: 0.14, width: 0.14, height: 0.22 }
      }]
    })

    expect(analysis.features).toEqual([
      expect.objectContaining({
        id: 'uia-account',
        label: 'Account',
        role: 'button',
        description: 'Open your account menu',
        bounds: { x: 0.18, y: 0.14, width: 0.14, height: 0.22 }
      })
    ])
  })

  it('lets tab geometry override a slightly corrupted OCR title', async () => {
    const image = await markedScreen([{ x: 62, y: 8, width: 76, height: 8 }])
    const analysis = await buildCaptureAnalysis(image, {
      lines: [{
        id: 'tab-title',
        text: 'OpenAl Researcn',
        confidence: 86,
        bounds: { x: 0.2, y: 0.04, width: 0.23, height: 0.045 }
      }],
      uiFeatures: [{
        id: 'uia-openai-tab',
        kind: 'control',
        label: 'OpenAI Research',
        source: 'uia',
        role: 'tab item',
        enabled: true,
        visibility: 1,
        visibilityVerified: true,
        bounds: { x: 0.18, y: 0.025, width: 0.28, height: 0.08 }
      }]
    })

    expect(analysis.features).toEqual([
      expect.objectContaining({
        id: 'uia-openai-tab',
        kind: 'control',
        label: 'OpenAI Research',
        role: 'tab item',
        source: 'hybrid'
      })
    ])
  })

  it('classifies an OCR-only website title beside detected tabs as a tab control', async () => {
    const image = await markedScreen([{ x: 112, y: 8, width: 60, height: 8 }])
    const analysis = await buildCaptureAnalysis(image, {
      lines: [{
        id: 'missing-tab-title',
        text: 'Example website',
        confidence: 93,
        bounds: { x: 0.35, y: 0.04, width: 0.19, height: 0.045 }
      }],
      uiFeatures: [
        {
          id: 'uia-tab-one',
          kind: 'control',
          label: 'First tab',
          source: 'uia',
          role: 'tab item',
          enabled: true,
          visibility: 1,
          visibilityVerified: true,
          bounds: { x: 0.05, y: 0.025, width: 0.13, height: 0.08 }
        },
        {
          id: 'uia-tab-two',
          kind: 'control',
          label: 'Second tab',
          source: 'uia',
          role: 'tab item',
          enabled: true,
          visibility: 1,
          visibilityVerified: true,
          bounds: { x: 0.2, y: 0.025, width: 0.13, height: 0.08 }
        }
      ]
    })

    expect(analysis.features).toContainEqual(expect.objectContaining({
      id: 'ocr-line-1',
      kind: 'control',
      label: 'Example website',
      role: 'tab item',
      source: 'hybrid'
    }))
    expect(analysis.features).not.toContainEqual(expect.objectContaining({
      label: 'Example website',
      kind: 'text'
    }))
  })

  it('does not promote ordinary page text below the top toolbar band', async () => {
    const image = await markedScreen([{ x: 112, y: 60, width: 80, height: 8 }])
    const analysis = await buildCaptureAnalysis(image, {
      lines: [{
        id: 'page-heading',
        text: 'Example website',
        confidence: 93,
        bounds: { x: 0.35, y: 0.34, width: 0.25, height: 0.045 }
      }],
      uiFeatures: [{
        id: 'uia-tab-one',
        kind: 'control',
        label: 'First tab',
        source: 'uia',
        role: 'tab item',
        enabled: true,
        visibility: 1,
        visibilityVerified: true,
        bounds: { x: 0.05, y: 0.025, width: 0.13, height: 0.08 }
      }]
    })

    expect(analysis.features).toContainEqual(expect.objectContaining({
      label: 'Example website',
      kind: 'text',
      source: 'ocr-line'
    }))
  })

  it('keeps a tooltip when OCR reads several random letters from its icon', async () => {
    const image = await markedScreen([{ x: 62, y: 32, width: 28, height: 28 }])
    const analysis = await buildCaptureAnalysis(image, {
      lines: [{
        id: 'line-1',
        text: 'xQmL7',
        confidence: 91,
        bounds: { x: 0.22, y: 0.2, width: 0.05, height: 0.08 }
      }],
      uiFeatures: [{
        id: 'uia-notifications',
        kind: 'control',
        label: 'Open notifications',
        source: 'uia',
        role: 'button',
        description: 'Show recent alerts',
        enabled: true,
        visibility: 1,
        visibilityVerified: true,
        bounds: { x: 0.18, y: 0.14, width: 0.14, height: 0.22 }
      }]
    })

    expect(analysis.features).toEqual([
      expect.objectContaining({
        id: 'uia-notifications',
        label: 'Open notifications',
        role: 'button'
      })
    ])
  })

  it('does not promote OCR garbage to the name of an unlabelled button', async () => {
    const image = await markedScreen([{ x: 62, y: 32, width: 28, height: 28 }])
    const analysis = await buildCaptureAnalysis(image, {
      lines: [{
        id: 'line-1',
        text: 'xQmL7',
        confidence: 91,
        bounds: { x: 0.22, y: 0.2, width: 0.05, height: 0.08 }
      }],
      uiFeatures: [{
        id: 'uia-unlabelled',
        kind: 'control',
        label: 'undefined',
        source: 'uia',
        role: 'button',
        enabled: true,
        visibility: 1,
        visibilityVerified: true,
        bounds: { x: 0.18, y: 0.14, width: 0.14, height: 0.22 }
      }]
    })

    expect(analysis.features).toEqual([
      expect.objectContaining({
        id: 'uia-unlabelled',
        label: 'Unlabelled button',
        role: 'button'
      })
    ])
  })

  it('keeps a pixel-backed visible icon control but rejects covered app metadata', async () => {
    const image = await markedScreen([{ x: 190, y: 30, width: 32, height: 32 }])
    const analysis = await buildCaptureAnalysis(image, {
      lines: [],
      uiFeatures: [
        {
          id: 'visible-settings',
          kind: 'control',
          label: 'Settings',
          source: 'uia',
          role: 'button',
          description: 'Open settings',
          enabled: true,
          visibility: 0.8,
          bounds: { x: 0.58, y: 0.14, width: 0.14, height: 0.24 }
        },
        {
          id: 'covered-save',
          kind: 'control',
          label: 'Save',
          source: 'uia',
          role: 'button',
          enabled: true,
          visibility: 0,
          bounds: { x: 0.1, y: 0.6, width: 0.2, height: 0.12 }
        },
        {
          id: 'static-app-text',
          kind: 'text',
          label: 'Hidden application content',
          source: 'uia',
          role: 'text',
          visibility: 1,
          bounds: { x: 0.1, y: 0.7, width: 0.3, height: 0.08 }
        }
      ]
    })

    expect(analysis.features).toEqual([
      expect.objectContaining({ id: 'visible-settings', label: 'Settings', source: 'uia', role: 'button' })
    ])
  })

  it('groups word-only OCR into phrases', () => {
    const analysis = buildCaptureAnalysisStage({
      lines: [],
      words: [
        { id: 'word-1', text: 'Quarterly', confidence: 90, bounds: { x: 0.1, y: 0.2, width: 0.08, height: 0.04 } },
        { id: 'word-2', text: 'revenue', confidence: 90, bounds: { x: 0.19, y: 0.2, width: 0.07, height: 0.04 } }
      ]
    }, 'text')

    expect(analysis).toMatchObject({ stage: 'text', complete: false })
    expect(analysis.features).toHaveLength(1)
    expect(analysis.features[0]).toMatchObject({ label: 'Quarterly revenue', source: 'ocr-line' })
  })

  it('does not manufacture anonymous boxes from visual edges', async () => {
    const image = await markedScreen([
      { x: 24, y: 20, width: 80, height: 50 },
      { x: 180, y: 90, width: 60, height: 40 }
    ])
    const analysis = await buildCaptureAnalysis(image, { lines: [] })

    expect(analysis).toMatchObject({ stage: 'text', complete: true, features: [] })
  })

  it('recovers visually distinct toolbar neighbours beside an accessibility seed', async () => {
    const image = await svgScreen([
      '<rect x="39" y="39" width="12" height="12" rx="2" fill="#111"/>',
      '<rect x="75" y="39" width="12" height="12" rx="2" fill="#111"/>',
      '<rect x="115" y="39" width="12" height="12" rx="2" fill="#111"/>'
    ].join(''))
    const analysis = await buildCaptureAnalysis(image, {
      lines: [],
      uiFeatures: [{
        id: 'uia-seed',
        kind: 'control',
        label: 'Detected toolbar button',
        source: 'uia',
        role: 'button',
        enabled: true,
        visibility: 1,
        bounds: { x: 30 / 320, y: 30 / 180, width: 30 / 320, height: 30 / 180 }
      }]
    })

    const buttons = analysis.features.filter(({ role }) => role === 'button')
    expect(buttons).toContainEqual(expect.objectContaining({ id: 'uia-seed' }))
    expect(buttons.filter(({ source }) => source === 'visual')).toHaveLength(2)
    expect(buttons.filter(({ source }) => source === 'visual')).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'Unlabelled button', bounds: expect.objectContaining({ x: expect.any(Number) }) })
    ]))
  })

  it('does not infer buttons from isolated visual marks without toolbar evidence', async () => {
    const image = await markedScreen([
      { x: 75, y: 39, width: 12, height: 12 },
      { x: 115, y: 39, width: 12, height: 12 }
    ])

    await expect(buildCaptureAnalysis(image, { lines: [] })).resolves.toMatchObject({ features: [] })
  })

  it('promotes actionable OCR inside a visible control outline to a button', async () => {
    const image = await svgScreen(
      '<rect x="170" y="90" width="90" height="34" rx="5" fill="none" stroke="#111" stroke-width="2"/>' +
      '<rect x="195" y="104" width="34" height="7" fill="#111"/>'
    )
    const analysis = await buildCaptureAnalysis(image, {
      lines: [{
        id: 'save-line',
        text: 'Save',
        confidence: 96,
        bounds: { x: 195 / 320, y: 104 / 180, width: 34 / 320, height: 7 / 180 }
      }]
    })

    expect(analysis.features).toEqual([
      expect.objectContaining({
        label: 'Save',
        role: 'button',
        source: 'hybrid'
      })
    ])
  })

  it('exposes a locally decoded QR code only when the detector supplies pixel bounds', async () => {
    const image = await markedScreen([{ x: 32, y: 36, width: 64, height: 36 }])
    const analysis = await buildCaptureAnalysis(image, {
      lines: [],
      entities: [{
        id: 'entity-1',
        kind: 'qr',
        value: 'https://example.com/help',
        bounds: { x: 0.09, y: 0.18, width: 0.23, height: 0.24 }
      }, {
        id: 'entity-2',
        kind: 'qr',
        value: 'https://example.com/no-location'
      }]
    })

    expect(analysis.features).toEqual([
      expect.objectContaining({
        kind: 'link',
        label: 'https://example.com/help',
        role: 'QR code',
        source: 'visual'
      })
    ])
  })

  it('collapses overlapping partial OCR results into the most complete line', () => {
    const analysis = buildCaptureAnalysisStage({
      lines: [
        {
          id: 'line-1',
          text: 'Quarterly revenue increased by 12 percent',
          confidence: 94,
          bounds: { x: 0.1, y: 0.2, width: 0.5, height: 0.06 }
        },
        {
          id: 'line-2',
          text: 'Quarterly revenue',
          confidence: 97,
          bounds: { x: 0.1, y: 0.205, width: 0.24, height: 0.045 }
        }
      ]
    }, 'text')

    expect(analysis.features).toEqual([
      expect.objectContaining({
        label: 'Quarterly revenue increased by 12 percent',
        source: 'ocr-line'
      })
    ])
  })

  it('rejects low-confidence OCR candidates before rendering', () => {
    const analysis = buildCaptureAnalysisStage({
      lines: [{
        id: 'line-1',
        text: 'phantom',
        confidence: 22,
        bounds: { x: 0.1, y: 0.2, width: 0.1, height: 0.06 }
      }]
    }, 'text')

    expect(analysis.features).toEqual([])
  })

  it('rejects OCR boxes that contain no visible screenshot evidence', async () => {
    const blank = await sharp({
      create: { width: 320, height: 180, channels: 3, background: '#f4f4f4' }
    }).png().toBuffer()
    const marked = await markedScreen([{ x: 40, y: 42, width: 38, height: 10 }])
    const analysis = {
      features: [{
        id: 'ocr-line-1',
        kind: 'control' as const,
        label: 'Save',
        source: 'ocr-line' as const,
        rank: 100,
        bounds: { x: 0.1, y: 0.2, width: 0.2, height: 0.12 }
      }],
      truncated: false,
      stage: 'semantic' as const,
      complete: false
    }

    await expect(validateCaptureAnalysis(blank, analysis)).resolves.toMatchObject({ features: [] })
    await expect(validateCaptureAnalysis(marked, analysis)).resolves.toMatchObject({
      features: [expect.objectContaining({ id: 'ocr-line-1', rank: expect.any(Number) })]
    })
  })
})
