import sharp from 'sharp'
import { describe, expect, it, vi } from 'vitest'
import { ImageImportService } from '../src/main/capture/image-import-service'

describe('ImageImportService', () => {
  it.each([
    ['PNG', 'png' as const],
    ['JPEG', 'jpeg' as const],
    ['WebP', 'webp' as const]
  ])('decodes, normalizes, and stores a managed %s copy', async (_label, format) => {
    const source = sharp({
      create: { width: 6, height: 4, channels: 4, background: { r: 20, g: 40, b: 60, alpha: 0.75 } }
    })
    const buffer = format === 'png'
      ? await source.png().toBuffer()
      : format === 'jpeg'
        ? await source.jpeg().toBuffer()
        : await source.webp().toBuffer()
    const saveImage = vi.fn(async (normalized: Buffer, extension: 'png' | 'jpg' | 'webp') => {
      expect((await sharp(normalized).metadata()).width).toBe(6)
      return `managed/snip.${extension}`
    })
    const service = new ImageImportService({ saveImage })

    await expect(service.importBuffer(buffer, `sample.${format}`)).resolves.toEqual({
      imagePath: `managed/snip.${format === 'jpeg' ? 'jpg' : format}`,
      name: `sample.${format}`
    })
    expect(saveImage).toHaveBeenCalledOnce()
  })

  it('rejects unsupported, corrupt, and signature-mismatched input without storing it', async () => {
    const saveImage = vi.fn()
    const service = new ImageImportService({ saveImage })
    await expect(service.importBuffer(Buffer.from('not-an-image'))).rejects.toThrow('Only PNG, JPEG, and WebP')
    await expect(service.importBuffer(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]))).rejects.toThrow('corrupt')
    const jpeg = await sharp({ create: { width: 2, height: 2, channels: 3, background: 'red' } }).jpeg().toBuffer()
    const mismatched = Buffer.concat([Buffer.from('RIFF'), jpeg.subarray(4, 8), Buffer.from('WEBP'), jpeg.subarray(12)])
    await expect(service.importBuffer(mismatched)).rejects.toThrow()
    expect(saveImage).not.toHaveBeenCalled()
  })

  it('rejects source files over the byte cap before reading their contents', async () => {
    const saveImage = vi.fn()
    const service = new ImageImportService({ saveImage })
    await expect(service.importBuffer(Buffer.alloc(20 * 1024 * 1024 + 1))).rejects.toThrow('20 MiB')
    expect(saveImage).not.toHaveBeenCalled()
  })
})
