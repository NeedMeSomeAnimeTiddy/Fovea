import { describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { correctOcrGeometry, detectDocumentQuad } from '../src/main/ocr/document-image'

describe('OCR document geometry correction', () => {
  it('rectifies a clearly photographed page quadrilateral', async () => {
    const image = await sharp(Buffer.from(`
      <svg xmlns="http://www.w3.org/2000/svg" width="600" height="450">
        <rect width="600" height="450" fill="#202225"/>
        <polygon points="105,35 500,68 558,398 52,420" fill="#f8f7f2"/>
        <path d="M125 115L500 135M110 165L515 180M95 220L525 230M82 278L535 282M68 338L545 332"
          stroke="#242424" stroke-width="7"/>
      </svg>
    `)).png().toBuffer()
    const analysis = await sharp(image).grayscale().raw().toBuffer({ resolveWithObject: true })
    expect(detectDocumentQuad(Uint8Array.from(analysis.data), analysis.info.width, analysis.info.height)).not.toBeNull()

    const corrected = await correctOcrGeometry(image, { width: 600, height: 450 })
    const metadata = await sharp(corrected.image).metadata()

    expect(corrected.correction).toBe('perspective-corrected')
    expect(metadata.width).toBe(corrected.size.width)
    expect(metadata.height).toBe(corrected.size.height)
    expect(corrected.size.width).toBeGreaterThan(350)
    expect(corrected.size.height).toBeGreaterThan(280)
  })

  it('deskews a modestly rotated text-like image without treating it as a document warp', async () => {
    const source = await sharp(Buffer.from(`
      <svg xmlns="http://www.w3.org/2000/svg" width="640" height="260">
        <rect width="640" height="260" fill="#ffffff"/>
        <g fill="#151515">
          <rect x="80" y="55" width="480" height="6"/>
          <rect x="105" y="95" width="430" height="6"/>
          <rect x="70" y="135" width="500" height="6"/>
          <rect x="115" y="175" width="400" height="6"/>
        </g>
      </svg>
    `)).rotate(3, { background: '#ffffff' }).png().toBuffer()
    const metadata = await sharp(source).metadata()

    const corrected = await correctOcrGeometry(source, {
      width: metadata.width!,
      height: metadata.height!
    })

    expect(corrected.correction).toBe('deskewed')
    expect(Math.abs(corrected.angle)).toBeGreaterThanOrEqual(2.5)
    expect(Math.abs(corrected.angle)).toBeLessThanOrEqual(3.5)
  })

  it('leaves ordinary flat screenshots alone', async () => {
    const image = await sharp({
      create: { width: 800, height: 500, channels: 3, background: '#f5f5f5' }
    }).png().toBuffer()

    const corrected = await correctOcrGeometry(image, { width: 800, height: 500 })

    expect(corrected.correction).toBe('none')
    expect(corrected.image).toEqual(image)
  })
})
