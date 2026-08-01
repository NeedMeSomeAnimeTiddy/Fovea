import { describe, expect, it } from 'vitest'
import { aggregateAnalyzeReports, evaluateAnalyzeFixture } from '../scripts/evaluate-analyze.mjs'

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
})
