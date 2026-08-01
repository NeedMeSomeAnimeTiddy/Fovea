import { describe, expect, it } from 'vitest'
import type { CaptureFeature } from '../src/shared/types/app'
import {
  mapDetectorPayload,
  mergeScreenshotElementFeatures
} from '../src/main/capture/screenshot-element-detector-service'

describe('OmniParser screenshot detector adapter', () => {
  it('maps normalized detector boxes to stable visual controls and rejects invalid geometry', () => {
    const features = mapDetectorPayload({
      detections: [
        { confidence: 0.91, source: 'full', bounds: [0.1, 0.2, 0.08, 0.12] },
        { confidence: 0.94, source: 'face-native', kind: 'face', bounds: [0.4, 0.2, 0.06, 0.14] },
        { confidence: 0.5, source: 'tile', bounds: [0.99, 0.99, 0.2, 0.2] },
        { confidence: 0.8, source: 'tile', bounds: [0.2, 0.2, -0.1, 0.1] }
      ]
    })

    expect(features).toHaveLength(3)
    expect(features[0]).toMatchObject({
      kind: 'control',
      label: 'Unlabelled button',
      source: 'visual',
      detector: 'omniparser',
      role: 'button',
      visibility: 0.91,
      bounds: { x: 0.1, y: 0.2, width: 0.08, height: 0.12 }
    })
    expect(features[1]).toMatchObject({
      kind: 'face',
      label: 'Face 1',
      source: 'visual',
      detector: 'yunet',
      role: 'face',
      visibility: 0.94,
      visibilityVerified: true,
      bounds: { x: 0.4, y: 0.2, width: 0.06, height: 0.14 }
    })
    expect(features[2]?.bounds).toEqual({ x: 0.99, y: 0.99, width: 0.01, height: 0.01 })
  })

  it('keeps a face separate from an overlapping generic control', () => {
    const [face, control] = mapDetectorPayload({
      detections: [
        { confidence: 0.96, source: 'face-native', kind: 'face', bounds: [0.2, 0.2, 0.1, 0.12] },
        { confidence: 0.82, source: 'full', bounds: [0.2, 0.2, 0.1, 0.12] }
      ]
    })

    expect(mergeScreenshotElementFeatures([face!], [control!]).map(({ kind }) => kind)).toEqual(['face', 'control'])
  })

  it('prefers model geometry while retaining a useful heuristic label', () => {
    const model: CaptureFeature = {
      id: 'model',
      kind: 'control',
      label: 'Unlabelled button',
      source: 'visual',
      detector: 'omniparser',
      role: 'button',
      visibility: 0.82,
      bounds: { x: 0.1, y: 0.1, width: 0.12, height: 0.1 }
    }
    const heuristic: CaptureFeature = {
      id: 'heuristic',
      kind: 'control',
      label: 'Save',
      source: 'visual',
      detector: 'heuristic',
      role: 'button',
      visibility: 0.9,
      bounds: { x: 0.105, y: 0.105, width: 0.11, height: 0.09 }
    }

    expect(mergeScreenshotElementFeatures([heuristic], [model])).toEqual([
      expect.objectContaining({
        id: 'model',
        label: 'Save',
        detector: 'omniparser',
        bounds: model.bounds
      })
    ])
  })
})
