import { basename } from 'node:path'
import { readFile, stat } from 'node:fs/promises'
import sharp, { type Metadata } from 'sharp'
import type { TempScreenshotStore } from '../storage/temp-screenshot-store'

export const IMAGE_IMPORT_LIMITS = {
  maximumFilesPerConversation: 10,
  maximumSourceBytes: 20 * 1024 * 1024,
  maximumNormalizedBytes: 25 * 1024 * 1024,
  maximumDimension: 16_384,
  maximumPixels: 40_000_000
} as const

export interface ImportedImage {
  imagePath: string
  name: string
}

export class ImageImportService {
  constructor(private readonly screenshots: Pick<TempScreenshotStore, 'saveImage'>) {}

  async importPath(path: string): Promise<ImportedImage> {
    const metadata = await stat(path)
    if (!metadata.isFile()) throw new Error('Only local image files can be attached.')
    if (metadata.size > IMAGE_IMPORT_LIMITS.maximumSourceBytes) throw new Error('Image is larger than 20 MiB.')
    return this.importBuffer(await readFile(path), basename(path))
  }

  async importBuffer(buffer: Buffer, name = 'Clipboard image'): Promise<ImportedImage> {
    if (!buffer.length) throw new Error('The image is empty.')
    if (buffer.length > IMAGE_IMPORT_LIMITS.maximumSourceBytes) throw new Error('Image is larger than 20 MiB.')
    const signature = imageSignature(buffer)
    if (!signature) throw new Error('Only PNG, JPEG, and WebP images are supported.')

    let metadata: Metadata
    try { metadata = await sharp(buffer, { animated: true, failOn: 'error' }).metadata() }
    catch { throw new Error('The image is corrupt or could not be decoded.') }
    if (metadata.format !== signature) throw new Error('The image contents do not match its file signature.')
    if ((metadata.pages ?? 1) > 1) throw new Error('Animated images are not supported.')
    const width = metadata.width ?? 0
    const height = metadata.height ?? 0
    if (width < 1 || height < 1) throw new Error('The image has invalid dimensions.')
    if (width > IMAGE_IMPORT_LIMITS.maximumDimension || height > IMAGE_IMPORT_LIMITS.maximumDimension || width * height > IMAGE_IMPORT_LIMITS.maximumPixels) {
      throw new Error('Image dimensions are too large. The limit is 40 megapixels and 16,384 pixels per side.')
    }

    const pipeline = sharp(buffer, { animated: false, failOn: 'error' }).rotate()
    const normalized = signature === 'jpeg'
      ? await pipeline.jpeg({ quality: 95, mozjpeg: true }).toBuffer()
      : signature === 'webp'
        ? await pipeline.webp({ quality: 95, lossless: metadata.hasAlpha === true }).toBuffer()
        : await pipeline.png({ compressionLevel: 9 }).toBuffer()
    if (normalized.length > IMAGE_IMPORT_LIMITS.maximumNormalizedBytes) throw new Error('The normalized image is larger than 25 MiB.')
    const extension = signature === 'jpeg' ? 'jpg' : signature
    return { imagePath: await this.screenshots.saveImage(normalized, extension), name }
  }
}

function imageSignature(buffer: Buffer): 'png' | 'jpeg' | 'webp' | null {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png'
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpeg'
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'webp'
  return null
}
