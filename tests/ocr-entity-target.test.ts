import { describe, expect, it } from 'vitest'
import { ocrEntityExternalTarget } from '../src/main/external/ocr-entity-target'

describe('OCR detected entity targets', () => {
  it('normalises only supported explicit external actions', () => {
    expect(ocrEntityExternalTarget('url', 'www.example.com/help')).toBe('https://www.example.com/help')
    expect(ocrEntityExternalTarget('email', 'hello@example.com')).toBe('mailto:hello@example.com')
    expect(ocrEntityExternalTarget('phone', '+44 (0)20 7946 0958')).toBe('tel:+4402079460958')
  })

  it('rejects unsafe or malformed targets', () => {
    expect(() => ocrEntityExternalTarget('url', 'file:///C:/secret.txt')).toThrow('Only web links')
    expect(() => ocrEntityExternalTarget('email', 'not-an-email')).toThrow('Invalid email')
    expect(() => ocrEntityExternalTarget('phone', '123')).toThrow('Invalid phone')
  })
})
