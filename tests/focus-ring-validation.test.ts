import { describe, expect, it } from 'vitest'

// @ts-expect-error -- the production validator intentionally ships as dependency-free JavaScript.
const validator = await import('../scripts/validate-focus-rings.mjs') as {
  collectFocusableClasses(sources: Array<{ source: string }>): Set<string>
  formatReport(result: ValidationResult): string
  specificityOf(selector: string): { ids: number; classes: number; types: number }
  validateSource(options: {
    filePath: string
    rootDir?: string
    source: string
    focusableClasses?: Set<string>
    exceptions?: Array<{ file: string; selector: string; reason: string }>
  }): ValidationResult
}

interface Finding {
  file: string
  line: number
  selector: string
  specificity: string
  remedy: string
  reason?: string
}

interface ValidationResult {
  exceptions: Finding[]
  violations: Finding[]
}

const FILE = 'src/renderer/fixture.css'

function check(source: string, focusableClasses = new Set<string>()): ValidationResult {
  return validator.validateSource({ filePath: FILE, rootDir: '.', source, focusableClasses })
}

describe('focus-ring validator', () => {
  it('reports a resting-state shadow that outranks the shared ring', () => {
    const { violations } = check('.nav button.active { box-shadow: var(--fovea-shadow-surface); }')

    expect(violations.map(({ selector }) => selector)).toEqual(['.nav button.active'])
    expect(violations[0]?.specificity).toBe('(0,2,1)')
  })

  it('accepts a rule that restates the ring on focus', () => {
    const { violations } = check(`
      .nav button.active { box-shadow: var(--fovea-shadow-surface); }
      .nav button.active:focus-visible { box-shadow: var(--fovea-focus-ring); }
    `)

    expect(violations).toEqual([])
  })

  it('accepts a broader focus rule that still wins, such as one covering an active variant', () => {
    // `.control:focus-visible` ties `.control.recording` on specificity and follows it, so it wins.
    const { violations } = check(`
      .control { box-shadow: var(--inset); }
      .control.recording { box-shadow: var(--ring); }
      .control:focus-visible { box-shadow: var(--fovea-focus-ring); }
    `, new Set(['control']))

    expect(violations).toEqual([])
  })

  it('rejects a focus rule that loses the cascade to the rule it should override', () => {
    // Both are (0,2,0), so the later resting rule wins and the ring never paints. `:focus-visible`
    // counts as a class, so a bare `.control:focus-visible` would have outranked plain `.control`
    // whatever the order; it takes a matching class on the other side to make the order decide.
    const { violations } = check(`
      .control:focus-visible { box-shadow: var(--fovea-focus-ring); }
      .control.active { box-shadow: var(--inset); }
    `, new Set(['control']))

    expect(violations.map(({ selector }) => selector)).toEqual(['.control.active'])
  })

  it('ignores a shadow named only in a transition', () => {
    const { violations } = check('.nav button { transition: box-shadow 120ms ease; }')

    expect(violations).toEqual([])
  })

  it('ignores pointer-gated and disabled rules, and non-focusable subjects', () => {
    const { violations } = check(`
      .nav button:hover { box-shadow: var(--hover); }
      .nav button:disabled { box-shadow: none; }
      .card { box-shadow: var(--surface); }
    `)

    expect(violations).toEqual([])
  })

  it('treats a class as focusable when the markup puts it on a focusable element', () => {
    const classes = validator.collectFocusableClasses([
      { source: `<button className={recording ? 'shortcut-input recording' : 'shortcut-input'}>x</button>` }
    ])
    expect(classes.has('shortcut-input')).toBe(true)

    const { violations } = check('.shortcut-input { box-shadow: var(--inset); }', classes)
    expect(violations.map(({ selector }) => selector)).toEqual(['.shortcut-input'])
  })

  it('does not treat the same class as focusable when it sits on a plain element', () => {
    const classes = validator.collectFocusableClasses([{ source: `<div className="panel">x</div>` }])

    expect(check('.panel { box-shadow: var(--surface); }', classes).violations).toEqual([])
  })

  it('counts :where() as contributing nothing, which is why the shared ring loses', () => {
    expect(validator.specificityOf(':where(button, a):focus-visible')).toEqual({ ids: 0, classes: 1, types: 0 })
    expect(validator.specificityOf('.nav button.active')).toEqual({ ids: 0, classes: 2, types: 1 })
  })

  it('moves a documented exception out of the violations', () => {
    const source = '.trigger { box-shadow: var(--surface); }'
    const exceptions = [{ file: FILE, selector: '.trigger', reason: 'Covered by the shared component rule.' }]
    const result = validator.validateSource({
      filePath: FILE,
      rootDir: '.',
      source,
      focusableClasses: new Set(['trigger']),
      exceptions
    })

    expect(result.violations).toEqual([])
    expect(result.exceptions.map(({ reason }) => reason)).toEqual(['Covered by the shared component rule.'])
    expect(validator.formatReport(result)).toContain('Accepted focus-ring exceptions (1)')
  })
})
