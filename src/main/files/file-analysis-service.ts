import { readFile, realpath, stat } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import sharp from 'sharp'
import type { AnalyseAction } from '../shell/analyse-arguments'
import type { TempScreenshotStore } from '../storage/temp-screenshot-store'

export type AnalysableKind = 'image' | 'pdf'

/** Providers only accept PNG, and a capture-sized image keeps request cost predictable. */
const MAX_IMAGE_EDGE = 2_000
const SIZE_LIMITS: Record<AnalysableKind, number> = {
  image: 25 * 1024 * 1024,
  pdf: 32 * 1024 * 1024
}
const EXTENSION_KINDS = new Map<string, AnalysableKind>([
  ['.png', 'image'],
  ['.jpg', 'image'],
  ['.jpeg', 'image'],
  ['.webp', 'image'],
  ['.gif', 'image'],
  ['.bmp', 'image'],
  ['.tif', 'image'],
  ['.tiff', 'image'],
  ['.avif', 'image'],
  ['.pdf', 'pdf']
])
const HEIF_IMAGE_BRANDS = new Set(['avif', 'avis', 'mif1', 'msf1'])

export interface AnalysedDocument {
  name: string
  text: string
  truncated: boolean
  /** Pages whose text was read, which can exceed the pages rendered as images. */
  pageCount: number
  totalPages: number
}

export interface PreparedFileAnalysis {
  imagePaths: string[]
  documents: AnalysedDocument[]
  /** User-facing notes about files that were skipped or truncated. */
  notices: string[]
  /** Which Explorer submenu entry started this. */
  action: AnalyseAction
  /** The saved prompt chosen from the Ask submenu, already resolved to its text. */
  prompt?: string
}

export interface PdfIngestionResult {
  pages: Buffer[]
  text: string
  truncated: boolean
  pageCount: number
  totalPages: number
}

export interface PdfIngestion {
  ingest(pdf: Buffer): Promise<PdfIngestionResult>
}

export function analysableKindForExtension(path: string): AnalysableKind | null {
  return EXTENSION_KINDS.get(extname(path).toLocaleLowerCase()) ?? null
}

/**
 * Explorer hands over whatever the user right-clicked, and an extension is only a claim. The
 * leading bytes decide what Fovea actually opens.
 */
export function sniffAnalysableKind(header: Buffer): AnalysableKind | null {
  if (header.length >= 5 && header.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf'
  if (header.length >= 8 && header.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') return 'image'
  if (header.length >= 3 && header.subarray(0, 3).toString('hex') === 'ffd8ff') return 'image'
  if (header.length >= 6 && ['GIF87a', 'GIF89a'].includes(header.subarray(0, 6).toString('latin1'))) return 'image'
  if (header.length >= 2 && header.subarray(0, 2).toString('latin1') === 'BM') return 'image'
  if (header.length >= 4 && ['49492a00', '4d4d002a'].includes(header.subarray(0, 4).toString('hex'))) return 'image'
  if (
    header.length >= 12 &&
    header.subarray(0, 4).toString('latin1') === 'RIFF' &&
    header.subarray(8, 12).toString('latin1') === 'WEBP'
  ) return 'image'
  if (
    header.length >= 12 &&
    header.subarray(4, 8).toString('latin1') === 'ftyp' &&
    HEIF_IMAGE_BRANDS.has(header.subarray(8, 12).toString('latin1'))
  ) return 'image'
  return null
}

export class FileAnalysisError extends Error {}

export class FileAnalysisService {
  constructor(
    private readonly screenshots: TempScreenshotStore,
    private readonly onPrepared: (analysis: PreparedFileAnalysis) => Promise<void>,
    private readonly onError: (message: string) => void,
    private readonly pdf?: PdfIngestion
  ) {}

  async analyse(paths: string[], dropped = 0, action: AnalyseAction = 'analyse', prompt?: string): Promise<void> {
    const imagePaths: string[] = []
    const documents: AnalysedDocument[] = []
    const notices: string[] = []
    if (dropped > 0) notices.push(`Only the first ${paths.length} selected files were opened; ${dropped} more were skipped.`)

    try {
      for (const path of paths) {
        try {
          const prepared = await this.prepare(path)
          imagePaths.push(...prepared.imagePaths)
          if (prepared.document) documents.push(prepared.document)
          if (prepared.notice) notices.push(prepared.notice)
        } catch (error) {
          const reason = error instanceof FileAnalysisError ? error.message : 'This file could not be opened.'
          notices.push(`${basename(path)}: ${reason}`)
        }
      }
      if (!imagePaths.length && !documents.length) {
        throw new FileAnalysisError(notices[0] ?? 'None of the selected files could be analysed.')
      }
      await this.onPrepared({ imagePaths, documents, notices, action, ...(prompt ? { prompt } : {}) })
    } catch (error) {
      await Promise.all(imagePaths.map((path) => this.screenshots.delete(path)))
      this.onError(error instanceof FileAnalysisError ? error.message : 'The selected files could not be analysed.')
    }
  }

  private async prepare(path: string): Promise<{ imagePaths: string[]; document?: AnalysedDocument; notice?: string }> {
    // Resolve first: a shortcut or junction must be judged by what it actually points at.
    const resolved = await realpath(path).catch(() => {
      throw new FileAnalysisError('That file no longer exists.')
    })
    const metadata = await stat(resolved)
    if (metadata.isDirectory()) throw new FileAnalysisError('Folders cannot be analysed.')
    if (!metadata.isFile()) throw new FileAnalysisError('Only ordinary files can be analysed.')

    const claimed = analysableKindForExtension(resolved)
    if (!claimed) throw new FileAnalysisError('Fovea can only analyse images and PDF files.')
    if (metadata.size < 1) throw new FileAnalysisError('That file is empty.')
    if (metadata.size > SIZE_LIMITS[claimed]) {
      throw new FileAnalysisError(`That file is larger than the ${Math.round(SIZE_LIMITS[claimed] / (1024 * 1024))} MB limit.`)
    }

    const content = await readFile(resolved)
    const actual = sniffAnalysableKind(content.subarray(0, 16))
    if (actual !== claimed) throw new FileAnalysisError('That file’s contents do not match its file type.')
    // Paths and contents stay out of the log; only the shape of the work is recorded.
    console.info(`[files] Preparing ${extname(resolved).toLocaleLowerCase()} of ${metadata.size} bytes.`)

    if (claimed === 'image') return { imagePaths: [await this.saveImage(content)] }
    return this.preparePdf(content, basename(resolved))
  }

  private async preparePdf(content: Buffer, name: string): Promise<{ imagePaths: string[]; document?: AnalysedDocument; notice?: string }> {
    if (!this.pdf) throw new FileAnalysisError('PDF analysis is unavailable in this build.')
    const result = await this.pdf.ingest(content).catch((error: unknown) => {
      throw new FileAnalysisError(error instanceof Error && error.message ? error.message : 'That PDF could not be opened.')
    })
    if (!result.pages.length) throw new FileAnalysisError('That PDF has no pages Fovea could read.')
    const imagePaths: string[] = []
    for (const page of result.pages) imagePaths.push(await this.screenshots.save(page))
    console.info(`[files] Prepared ${result.pages.length} of ${result.totalPages} PDF pages.`)
    return {
      imagePaths,
      ...(result.text
        ? {
            document: {
              name,
              text: result.text,
              truncated: result.truncated,
              pageCount: result.pageCount,
              totalPages: result.totalPages
            }
          }
        : {}),
      ...(result.pages.length < result.totalPages
        ? { notice: `${name}: showing the first ${result.pages.length} of ${result.totalPages} pages.` }
        : {})
    }
  }

  private async saveImage(content: Buffer): Promise<string> {
    const png = await sharp(content, { failOn: 'error' })
      // Honour EXIF orientation so a phone photo is not analysed sideways.
      .rotate()
      .resize({ width: MAX_IMAGE_EDGE, height: MAX_IMAGE_EDGE, fit: 'inside', withoutEnlargement: true })
      .png()
      .toBuffer()
      .catch(() => {
        throw new FileAnalysisError('That image could not be read.')
      })
    return this.screenshots.save(png)
  }
}
