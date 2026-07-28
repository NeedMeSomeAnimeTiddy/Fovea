import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterEach, describe, expect, it } from 'vitest'
import { ImageEditorService } from '../src/main/capture/image-editor-service'
import { TempScreenshotStore } from '../src/main/storage/temp-screenshot-store'

const roots: string[] = []

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

describe('ImageEditorService', () => {
  it('creates a separate derivative with a solid redaction region', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fovea-editor-test-'))
    roots.push(root)
    const source = join(root, 'source.png')
    await writeFile(source, await sharp({
      create: { width: 100, height: 100, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } }
    }).png().toBuffer())
    const store = new TempScreenshotStore(join(root, 'temporary'))
    const editor = new ImageEditorService(store)

    const derivative = await editor.createDerivative(source, [{
      id: 'redaction',
      tool: 'redact',
      points: [{ x: 0.2, y: 0.2 }, { x: 0.8, y: 0.8 }]
    }])

    expect(derivative).not.toBe(source)
    const { data, info } = await sharp(await readFile(derivative)).raw().toBuffer({ resolveWithObject: true })
    const center = (50 * info.width + 50) * info.channels
    const corner = (5 * info.width + 5) * info.channels
    expect([...data.subarray(center, center + 3)]).toEqual([0, 0, 0])
    expect([...data.subarray(corner, corner + 3)]).toEqual([255, 255, 255])
  })

  it('rejects empty or out-of-contract edit sets', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fovea-editor-test-'))
    roots.push(root)
    const source = join(root, 'source.png')
    await writeFile(source, await sharp({ create: { width: 10, height: 10, channels: 4, background: 'white' } }).png().toBuffer())
    const editor = new ImageEditorService(new TempScreenshotStore(join(root, 'temporary')))

    await expect(editor.createDerivative(source, [])).rejects.toThrow('at least one edit')
  })
})
