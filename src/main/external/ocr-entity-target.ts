import type { OcrExternalActionKind } from '@shared/types/app'

const EMAIL_PATTERN = /^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+$/i
const PHONE_PATTERN = /^\+?[\d\s().-]+$/

export function ocrEntityExternalTarget(kind: OcrExternalActionKind, rawValue: string): string {
  const value = rawValue.trim()
  if (!value || value.length > 2_048) throw new Error('Invalid detected value.')

  if (kind === 'url') {
    const target = /^www\./i.test(value) ? `https://${value}` : value
    const url = new URL(target)
    if (!['https:', 'http:'].includes(url.protocol)) throw new Error('Only web links can be opened.')
    return url.toString()
  }

  if (kind === 'email') {
    if (value.length > 254 || !EMAIL_PATTERN.test(value)) throw new Error('Invalid email address.')
    return `mailto:${value}`
  }

  if (!PHONE_PATTERN.test(value)) throw new Error('Invalid phone number.')
  const digits = value.replace(/\D/g, '')
  if (digits.length < 7 || digits.length > 15) throw new Error('Invalid phone number.')
  return `tel:${value.startsWith('+') ? '+' : ''}${digits}`
}
