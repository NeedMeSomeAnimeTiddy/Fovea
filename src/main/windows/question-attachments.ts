import { randomUUID } from 'node:crypto'
import { nativeImage } from 'electron'
import type { OcrResult, QuestionAttachment } from '@shared/types/app'

export interface SessionAttachment extends QuestionAttachment {
  imagePath: string
  ocrResult: OcrResult | null
  ocrSelectedRegionIds: Set<string>
  ocrRevision: number
}

export function createSessionAttachment(
  imagePath: string,
  status: QuestionAttachment['status'],
  edited = false,
  id: string = randomUUID(),
  createThumbnail: (path: string) => string = thumbnailForPath
): SessionAttachment {
  return {
    id,
    imagePath,
    thumbnailDataUrl: createThumbnail(imagePath),
    status,
    edited,
    ocr: { status: 'idle' },
    ocrResult: null,
    ocrSelectedRegionIds: new Set(),
    ocrRevision: 0
  }
}

export function requireSessionAttachment(
  attachments: SessionAttachment[],
  attachmentId: string
): SessionAttachment {
  const attachment = attachments.find((candidate) => candidate.id === attachmentId)
  if (!attachment) throw new Error('That screenshot is no longer attached.')
  return attachment
}

export function pathsForAttachmentIds(
  attachments: SessionAttachment[],
  attachmentIds: string[]
): string[] {
  return attachmentIds.map((attachmentId) => requireSessionAttachment(attachments, attachmentId).imagePath)
}

export function invalidateAttachmentOcr(attachment: SessionAttachment): void {
  attachment.ocrRevision += 1
  attachment.ocrResult = null
  attachment.ocrSelectedRegionIds.clear()
  attachment.ocr = { status: 'idle' }
}

export async function releaseSessionAttachments(
  attachments: SessionAttachment[],
  deletePath: (path: string) => Promise<void>
): Promise<void> {
  for (const attachment of attachments) invalidateAttachmentOcr(attachment)
  await Promise.all(attachments.map((attachment) => deletePath(attachment.imagePath)))
}

function thumbnailForPath(path: string): string {
  const image = nativeImage.createFromPath(path)
  return image.resize({ width: Math.min(380, image.getSize().width), quality: 'good' }).toDataURL()
}
