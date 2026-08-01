import { describe, expect, it } from 'vitest'
import {
  aggregateAnalyzeReports,
  evaluateAnalyzeFixture,
  evaluateAnalyzeThresholds
} from '../scripts/evaluate-analyze.mjs'

describe('Analyze evaluation', () => {
  it('separates misses, duplicates, forbidden boxes, tiny controls, and invalid labels', () => {
    const report = evaluateAnalyzeFixture({
      id: 'toolbar',
      features: [
        { id: 'save', kind: 'control', label: 'Save', bounds: { x: 0.1, y: 0.1, width: 0.1, height: 0.08 } },
        { id: 'tiny-menu', kind: 'control', label: 'Menu', bounds: { x: 0.3, y: 0.1, width: 0.02, height: 0.03 } }
      ],
      forbiddenRegions: [{ x: 0.7, y: 0.1, width: 0.1, height: 0.1 }]
    }, {
      timingMs: 420,
      features: [
        { id: 'save-found', kind: 'control', label: 'Save', bounds: { x: 0.1, y: 0.1, width: 0.1, height: 0.08 } },
        { id: 'save-duplicate', kind: 'control', label: 'Button', bounds: { x: 0.105, y: 0.105, width: 0.1, height: 0.08 } },
        { id: 'hidden', kind: 'control', label: 'undefined', bounds: { x: 0.7, y: 0.1, width: 0.1, height: 0.1 } }
      ]
    })

    expect(report.counts).toMatchObject({
      matched: 1,
      missed: 1,
      falsePositives: 2,
      duplicates: 1,
      forbiddenFalsePositives: 1,
      invalidLabels: 2,
      tinyExpected: 1,
      tinyMatched: 0
    })
    expect(report.metrics.recall).toBe(0.5)
    expect(report.metrics.tinyRecall).toBe(0)
    expect(report.metrics.labelAccuracy).toBe(1)
  })

  it('aggregates fixture counts instead of averaging percentages', () => {
    const first = evaluateAnalyzeFixture({
      features: [{ id: 'a', kind: 'control', label: 'A', bounds: { x: 0, y: 0, width: 0.1, height: 0.1 } }]
    }, {
      features: [{ id: 'a', kind: 'control', label: 'A', bounds: { x: 0, y: 0, width: 0.1, height: 0.1 } }]
    })
    const second = evaluateAnalyzeFixture({
      features: [
        { id: 'b', kind: 'text', label: 'B', bounds: { x: 0.2, y: 0, width: 0.1, height: 0.1 } },
        { id: 'c', kind: 'text', label: 'C', bounds: { x: 0.4, y: 0, width: 0.1, height: 0.1 } }
      ]
    }, { features: [] })

    expect(aggregateAnalyzeReports([first, second]).metrics.recall).toBeCloseTo(1 / 3)
  })

  it('does not count unannotated targets as false positives in partial benchmark screenshots', () => {
    const report = evaluateAnalyzeFixture({
      partialAnnotations: true,
      features: [{ id: 'save', kind: 'control', label: 'Save', bounds: { x: 0.1, y: 0.1, width: 0.1, height: 0.1 } }]
    }, {
      features: [
        { id: 'save-found', kind: 'control', label: 'Save', bounds: { x: 0.1, y: 0.1, width: 0.1, height: 0.1 } },
        { id: 'other-valid-target', kind: 'control', label: 'Open', bounds: { x: 0.6, y: 0.6, width: 0.1, height: 0.1 } }
      ]
    })

    expect(report.partialAnnotations).toBe(true)
    expect(report.counts).toMatchObject({ actual: 2, scoredActual: 1, falsePositives: 0 })
    expect(report.metrics).toMatchObject({ precision: 1, recall: 1 })
    expect(report.falsePositives).toEqual([])
  })

  it('uses click-center grounding for ScreenSpot targets without accepting a broad enclosing box', () => {
    const expected = {
      partialAnnotations: true,
      matchMode: 'target-center',
      features: [{ id: 'target', kind: 'any', label: 'Minimize', bounds: { x: 0.8, y: 0.1, width: 0.05, height: 0.05 } }]
    }
    const hit = evaluateAnalyzeFixture(expected, {
      features: [{ id: 'small-button', kind: 'control', label: 'Minimize', bounds: { x: 0.805, y: 0.105, width: 0.02, height: 0.02 } }]
    })
    const miss = evaluateAnalyzeFixture(expected, {
      features: [{ id: 'whole-window', kind: 'control', label: 'Calculator', bounds: { x: 0.5, y: 0.05, width: 0.4, height: 0.8 } }]
    })

    expect(hit.metrics.recall).toBe(1)
    expect(miss.metrics.recall).toBe(0)
  })

  it('reports release threshold failures', () => {
    const failures = evaluateAnalyzeThresholds({
      metrics: { recall: 0.8, duplicateRate: 0.01, invalidLabelRate: 0.2, emptyFixtureRate: 0.1 },
      averageTimingMs: 2500
    }, {
      minimumRecall: 0.85,
      maximumInvalidLabelRate: 0.25,
      maximumAverageTimingMs: 3000
    })

    expect(failures).toEqual([{ name: 'minimumRecall', actual: 0.8, threshold: 0.85 }])
  })
})
