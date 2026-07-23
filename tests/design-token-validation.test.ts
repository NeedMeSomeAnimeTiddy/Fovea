import { describe, expect, it } from 'vitest'

// @ts-expect-error -- the production validator intentionally ships as dependency-free JavaScript.
const validator = await import('../scripts/validate-design-tokens.mjs') as {
  formatReport(result: ValidationResult): string
  toDisplayPath(filePath: string, rootDir?: string): string
  validateSource(options: { filePath: string; rootDir?: string; source: string }): ValidationResult
  validateTokenReferences(sources: Array<{ filePath: string; source: string }>, rootDir?: string): Finding[]
}

interface Finding {
  file: string
  line: number
  property: string
  reason?: string
  remedy: string
  rule: string
  value: string
}

interface ValidationResult {
  exceptions: Finding[]
  violations: Finding[]
}

const WINDOWS_ROOT = 'C:\\repo'
const CSS_FILE = 'C:\\repo\\src\\renderer\\fixture.css'
const TSX_FILE = 'C:\\repo\\src\\renderer\\fixture.tsx'

describe('design-token validator', () => {
  it('allows semantic tokens, geometry, CSS-wide values, system colours, and reduced-motion zero durations', () => {
    const css = `.panel {
  color: var(--fovea-color-text-primary);
  background: transparent;
  border-radius: var(--fovea-radius-lg);
  box-shadow: none;
}
@media (prefers-reduced-motion: reduce) {
  .panel { transition-duration: 0ms; color: CanvasText; }
}`
    const tsx = `const overlay = <div style={{ left: rectangle.x, top: rectangle.y, width: rectangle.width, height: rectangle.height }} />
const highContrast = <div style={{ color: 'CanvasText', background: 'transparent' }} />`

    expect(validate(CSS_FILE, css).violations).toEqual([])
    expect(validate(TSX_FILE, tsx).violations).toEqual([])
  })

  it('reports colour, radius, shadow, duration, and private-reference violations with remedies', () => {
    const css = `.panel {
  color: #ffffff;
  outline-color: rebeccapurple;
  border-radius: 8px;
  box-shadow: 0 8px 24px rgb(0 0 0 / 30%);
  text-shadow: 0 1px black;
  transition: color 180ms ease;
  border-color: var(--fovea-ref-neutral-200);
}`
    const result = validate(CSS_FILE, css)

    expect(new Set(result.violations.map((finding) => finding.rule))).toEqual(
      new Set(['colour', 'radius', 'shadow', 'duration', 'reference'])
    )
    expect(result.violations.every((finding) => finding.file === 'src/renderer/fixture.css')).toBe(true)
    expect(result.violations.every((finding) => finding.line > 1)).toBe(true)
    expect(result.violations.every((finding) => finding.property.length > 0 && finding.remedy.includes('--fovea'))).toBe(true)
  })

  it('accepts and visibly reports an immediately preceding specific exception', () => {
    const css = `.selection {
  /* fovea-design-allow: preserves functional full-screen mask geometry */
  box-shadow: 0 0 0 99999px var(--fovea-color-scrim);
}`
    const result = validate(CSS_FILE, css)
    const report = validator.formatReport(result)

    expect(result.violations).toEqual([])
    expect(result.exceptions).toHaveLength(1)
    expect(result.exceptions[0]?.reason).toBe('preserves functional full-screen mask geometry')
    expect(report).toContain('ALLOW src/renderer/fixture.css:3 [box-shadow]')
    expect(report).toContain('preserves functional full-screen mask geometry')
  })

  it('flags literal TSX visual styles while allowing dynamic geometry', () => {
    const tsx = `const geometry = <div style={{ left: rectangle.x, top: rectangle.y }} />
const invalid = <div style={{ backgroundColor: '#fff', borderRadius: 8, boxShadow: '0 2px 8px black' }} />`
    const result = validate(TSX_FILE, tsx)

    expect(result.violations.map((finding) => finding.property)).toEqual([
      'backgroundColor',
      'borderRadius',
      'boxShadow'
    ])
  })

  it('flags colour strings outside inline styles', () => {
    const result = validate(TSX_FILE, `const localAccent = 'hsl(190 90% 50%)'`)

    expect(result.violations).toHaveLength(1)
    expect(result.violations[0]).toMatchObject({ property: 'string literal', rule: 'colour' })
  })

  it('allows controlled token and theme files', () => {
    const tokenFile = 'C:\\repo\\src\\renderer\\design-system\\styles\\tokens.css'
    const themeFile = 'C:\\repo\\src\\renderer\\design-system\\styles\\theme-dark.css'
    const source = `:root { --example: #fff; --radius: 8px; --shadow: 0 2px 8px black; --motion: 180ms; }`

    expect(validate(tokenFile, source).violations).toEqual([])
    expect(validate(themeFile, source).violations).toEqual([])
  })

  it('normalises Windows paths for stable reports', () => {
    expect(validator.toDisplayPath('C:\\repo\\src\\renderer\\settings\\main.tsx', WINDOWS_ROOT)).toBe(
      'src/renderer/settings/main.tsx'
    )
  })

  it('reports semantic token references that are not declared anywhere', () => {
    const findings = validator.validateTokenReferences([
      { filePath: CSS_FILE, source: ':root { --fovea-known: red; } .panel { color: var(--fovea-known); border-color: var(--fovea-missing); }' }
    ], WINDOWS_ROOT)

    expect(findings).toEqual([expect.objectContaining({ rule: 'undefined', value: '--fovea-missing' })])
  })
})

function validate(filePath: string, source: string): ValidationResult {
  return validator.validateSource({ filePath, rootDir: WINDOWS_ROOT, source })
}
