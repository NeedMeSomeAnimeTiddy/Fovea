import { describe, expect, it, vi } from 'vitest'
import {
  createSessionAttachment,
  invalidateAttachmentOcr,
  pathsForAttachmentIds,
  releaseSessionAttachments,
  requireSessionAttachment
} from '../src/main/windows/question-attachments'

describe('question attachment ownership', () => {
  it('creates managed attachment state without exposing image processing to callers', () => {
    const attachment = createSessionAttachment('C:\\captures\\one.png', 'draft', true, 'attachment-1', () => 'data:image/png;base64,dGh1bWI=')

    expect(attachment).toMatchObject({
      id: 'attachment-1',
      imagePath: 'C:\\captures\\one.png',
      thumbnailDataUrl: 'data:image/png;base64,dGh1bWI=',
      status: 'draft',
      edited: true,
      ocr: { status: 'idle' },
      ocrRevision: 0
    })
  })

  it('resolves attachment ids in requested order and rejects stale ids', () => {
    const first = createSessionAttachment('first.png', 'sent', false, 'first', () => 'first-thumb')
    const second = createSessionAttachment('second.png', 'draft', false, 'second', () => 'second-thumb')

    expect(pathsForAttachmentIds([first, second], ['second', 'first'])).toEqual(['second.png', 'first.png'])
    expect(requireSessionAttachment([first, second], 'first')).toBe(first)
    expect(() => requireSessionAttachment([first, second], 'missing')).toThrow('no longer attached')
  })

  it('invalidates OCR and releases every owned temporary path', async () => {
    const first = createSessionAttachment('first.png', 'sent', false, 'first', () => 'first-thumb')
    const second = createSessionAttachment('second.png', 'draft', false, 'second', () => 'second-thumb')
    first.ocrResult = {
      attachmentId: 'first',
      text: 'text',
      confidence: 90,
      quality: 'normal',
      language: { code: 'eng', label: 'English', source: 'configured' },
      regions: [],
      truncated: false
    }
    first.ocrSelectedRegionIds.add('region-1')
    const remove = vi.fn(async () => undefined)

    invalidateAttachmentOcr(first)
    expect(first).toMatchObject({ ocrResult: null, ocr: { status: 'idle' }, ocrRevision: 1 })
    expect(first.ocrSelectedRegionIds.size).toBe(0)

    await releaseSessionAttachments([first, second], remove)
    expect(remove.mock.calls).toEqual([['first.png'], ['second.png']])
    expect(first.ocrRevision).toBe(2)
    expect(second.ocrRevision).toBe(1)
  })
})
