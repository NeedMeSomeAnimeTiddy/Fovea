import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import sharp from 'sharp'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  FileAnalysisService,
  analysableKindForExtension,
  sniffAnalysableKind,
  type PdfIngestion,
  type PreparedFileAnalysis
} from '../src/main/files/file-analysis-service'
import { TempScreenshotStore } from '../src/main/storage/temp-screenshot-store'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

async function workspace(): Promise<{ root: string; store: TempScreenshotStore }> {
  const root = await mkdtemp(join(tmpdir(), 'fovea-files-'))
  roots.push(root)
  const store = new TempScreenshotStore(join(root, 'temp'))
  await store.initialise()
  return { root, store }
}

async function png(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: '#3366cc' } }).png().toBuffer()
}

function harness(store: TempScreenshotStore, pdf?: PdfIngestion): {
  service: FileAnalysisService
  prepared: PreparedFileAnalysis[]
  errors: string[]
} {
  const prepared: PreparedFileAnalysis[] = []
  const errors: string[] = []
  const service = new FileAnalysisService(
    store,
    async (analysis) => { prepared.push(analysis) },
    (message) => errors.push(message),
    pdf
  )
  return { service, prepared, errors }
}

describe('extension and content agreement', () => {
  it('accepts only image and PDF extensions', () => {
    expect(analysableKindForExtension('C:\\a.PNG')).toBe('image')
    expect(analysableKindForExtension('C:\\a.jpeg')).toBe('image')
    expect(analysableKindForExtension('C:\\a.pdf')).toBe('pdf')
    expect(analysableKindForExtension('C:\\a.docx')).toBeNull()
    expect(analysableKindForExtension('C:\\a.exe')).toBeNull()
    expect(analysableKindForExtension('C:\\noextension')).toBeNull()
  })

  it('identifies formats from their leading bytes', () => {
    expect(sniffAnalysableKind(Buffer.from('89504e470d0a1a0a', 'hex'))).toBe('image')
    expect(sniffAnalysableKind(Buffer.from('ffd8ffe0', 'hex'))).toBe('image')
    expect(sniffAnalysableKind(Buffer.from('GIF89a....', 'latin1'))).toBe('image')
    expect(sniffAnalysableKind(Buffer.from('RIFF____WEBP', 'latin1'))).toBe('image')
    expect(sniffAnalysableKind(Buffer.from('%PDF-1.7', 'latin1'))).toBe('pdf')
    expect(sniffAnalysableKind(Buffer.from('MZ\u0090\u0000', 'latin1'))).toBeNull()
  })
})

describe('FileAnalysisService', () => {
  it('converts an imported picture to a PNG in the temporary store', async () => {
    const { root, store } = await workspace()
    const source = join(root, 'photo.jpg')
    await writeFile(source, await sharp(await png(40, 20)).jpeg().toBuffer())
    const { service, prepared, errors } = harness(store)

    await service.analyse([source])

    expect(errors).toEqual([])
    expect(prepared[0]!.imagePaths).toHaveLength(1)
    const saved = prepared[0]!.imagePaths[0]!
    expect(saved.startsWith(store.directory)).toBe(true)
    expect((await readFile(saved)).subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
    // The original is left exactly as the user had it.
    await expect(readFile(source)).resolves.toBeTruthy()
  })

  it('shrinks an oversized picture to the provider-friendly edge', async () => {
    const { root, store } = await workspace()
    const source = join(root, 'huge.png')
    await writeFile(source, await png(4_000, 1_000))
    const { service, prepared } = harness(store)

    await service.analyse([source])

    const size = await sharp(prepared[0]!.imagePaths[0]!).metadata()
    expect(size.width).toBe(2_000)
    expect(size.height).toBe(500)
  })

  it('rejects a file whose contents contradict its extension', async () => {
    const { root, store } = await workspace()
    const source = join(root, 'not-really.png')
    await writeFile(source, Buffer.from('MZ this is an executable', 'latin1'))
    const { service, prepared, errors } = harness(store)

    await service.analyse([source])

    expect(prepared).toEqual([])
    expect(errors[0]).toContain('do not match')
  })

  it('refuses folders', async () => {
    const { root, store } = await workspace()
    const folder = join(root, 'pictures.png')
    await mkdir(folder)
    const { service, errors } = harness(store)

    await service.analyse([folder])

    expect(errors[0]).toContain('Folders cannot be analysed')
  })

  it('refuses an unsupported type', async () => {
    const { root, store } = await workspace()
    const source = join(root, 'notes.docx')
    await writeFile(source, 'content')
    const { service, errors } = harness(store)

    await service.analyse([source])

    expect(errors[0]).toContain('images and PDF files')
  })

  it('keeps the readable files when one of a selection fails', async () => {
    const { root, store } = await workspace()
    const good = join(root, 'good.png')
    const bad = join(root, 'bad.png')
    await writeFile(good, await png(10, 10))
    await writeFile(bad, Buffer.from('nonsense', 'latin1'))
    const { service, prepared, errors } = harness(store)

    await service.analyse([good, bad])

    expect(errors).toEqual([])
    expect(prepared[0]!.imagePaths).toHaveLength(1)
    expect(prepared[0]!.notices.some((notice) => notice.startsWith('bad.png:'))).toBe(true)
  })

  it('reports files dropped beyond the selection cap', async () => {
    const { root, store } = await workspace()
    const source = join(root, 'one.png')
    await writeFile(source, await png(10, 10))
    const { service, prepared } = harness(store)

    await service.analyse([source], 4)

    expect(prepared[0]!.notices[0]).toContain('4 more were skipped')
  })

  it('attaches PDF pages and carries their text through', async () => {
    const { root, store } = await workspace()
    const source = join(root, 'report.pdf')
    await writeFile(source, Buffer.concat([Buffer.from('%PDF-1.7\n', 'latin1'), Buffer.alloc(64)]))
    const pdf: PdfIngestion = {
      ingest: vi.fn(async () => ({
        pages: [await png(30, 40), await png(30, 40)],
        text: 'Quarterly summary',
        truncated: true,
        pageCount: 12,
        totalPages: 12
      }))
    }
    const { service, prepared, errors } = harness(store, pdf)

    await service.analyse([source])

    expect(errors).toEqual([])
    expect(prepared[0]!.imagePaths).toHaveLength(2)
    expect(prepared[0]!.documents[0]).toMatchObject({ name: 'report.pdf', text: 'Quarterly summary', totalPages: 12 })
    expect(prepared[0]!.notices[0]).toContain('first 2 of 12 pages')
  })

  it('cleans up saved pages when the session cannot be opened', async () => {
    const { root, store } = await workspace()
    const source = join(root, 'photo.png')
    await writeFile(source, await png(10, 10))
    const errors: string[] = []
    const saved: string[] = []
    const service = new FileAnalysisService(
      store,
      async (analysis) => { saved.push(...analysis.imagePaths); throw new Error('window failed') },
      (message) => errors.push(message)
    )

    await service.analyse([source])

    expect(errors).toHaveLength(1)
    for (const path of saved) await expect(readFile(path)).rejects.toThrow()
  })

  it('explains that PDFs need the renderer when it is unavailable', async () => {
    const { root, store } = await workspace()
    const source = join(root, 'report.pdf')
    await writeFile(source, Buffer.concat([Buffer.from('%PDF-1.7\n', 'latin1'), Buffer.alloc(64)]))
    const { service, errors } = harness(store)

    await service.analyse([source])

    expect(errors[0]).toContain('PDF analysis is unavailable')
  })
})

/**
 * Images dropped, pasted, or picked into an existing conversation share this service with the
 * Explorer context menu, so they get the same validation rather than a parallel implementation.
 */
describe('preparing images for an existing conversation', () => {
  it('normalises clipboard bytes to a PNG in the temporary store', async () => {
    const { store } = await workspace()
    const { service } = harness(store)

    const saved = await service.prepareImage(await sharp(await png(40, 30)).jpeg().toBuffer())

    expect(saved.startsWith(store.directory)).toBe(true)
    expect((await readFile(saved)).subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
  })

  it('rejects clipboard content that is empty or not an image', async () => {
    const { store } = await workspace()
    const { service } = harness(store)

    await expect(service.prepareImage(Buffer.alloc(0))).rejects.toThrow(/empty/)
    await expect(service.prepareImage(Buffer.from('MZ not an image', 'latin1'))).rejects.toThrow(/not an image/)
  })

  it('refuses an image beyond the pixel budget', async () => {
    const { store } = await workspace()
    const { service } = harness(store)
    // 20000 wide exceeds the 16,384-per-side limit, read from the header before any decoding.
    const huge = await sharp({ create: { width: 20_000, height: 4, channels: 3, background: '#000000' } }).png().toBuffer()

    await expect(service.prepareImage(huge)).rejects.toThrow(/16,384 pixels per side/)
  })

  it('gives a dropped file the same treatment as a right-clicked one', async () => {
    const { root, store } = await workspace()
    const source = join(root, 'dropped.png')
    await writeFile(source, await png(3_000, 1_000))
    const { service } = harness(store)

    const prepared = await service.prepareFile(source)

    expect(prepared.imagePaths).toHaveLength(1)
    const size = await sharp(prepared.imagePaths[0]!).metadata()
    expect(size.width).toBe(2_000)
  })
})
