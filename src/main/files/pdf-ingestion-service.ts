import { randomUUID } from 'node:crypto'
import { protocol, type BrowserWindow } from 'electron'
import type { DocumentRenderOptions, DocumentRenderResult } from '@shared/types/document-render'
import type { PdfIngestion, PdfIngestionResult } from './file-analysis-service'
import { loadRenderer, secureWindow } from '../windows/window-factory'

/** The renderer serves one queued PDF at a time from this scheme and nothing else. */
export const DOCUMENT_SCHEME = 'fovea-doc'
const RENDER_TIMEOUT_MS = 60_000
/** Pages sent to a provider. Every page is another image in the request, so this stays small. */
const MAX_RENDER_PAGES = 5
/** Text is cheap, so it is read well past the pages that are drawn. */
const MAX_TEXT_PAGES = 50
/** Matches the local OCR context budget in QuestionSessions. */
const MAX_CHARACTERS = 20_000
const MAX_EDGE = 2_000

/**
 * Registers `fovea-doc:` as a privileged scheme. Must run before the app is ready, otherwise the
 * hidden renderer cannot fetch from it.
 */
export function registerDocumentScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: DOCUMENT_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }
  ])
}

export class PdfIngestionService implements PdfIngestion {
  /** Only the PDF currently being ingested is reachable, keyed by a single-use identifier. */
  private readonly queued = new Map<string, Buffer>()
  private handling = false

  async ingest(pdf: Buffer): Promise<PdfIngestionResult> {
    this.installHandler()
    const token = randomUUID()
    this.queued.set(token, pdf)
    let window: BrowserWindow | null = null
    try {
      // A never-shown window still runs canvas work; throttling is disabled so a background
      // render is not stalled while the user is looking at something else. The page is driven
      // entirely by executeJavaScript below and never touches window.fovea, so it gets no preload.
      window = secureWindow(
        { show: false, width: 1, height: 1, frame: false, skipTaskbar: true, webPreferences: { backgroundThrottling: false } },
        { preload: false }
      )
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      await loadRenderer(window, 'document-render')
      const options: DocumentRenderOptions = {
        url: `${DOCUMENT_SCHEME}://document/${token}`,
        maxRenderPages: MAX_RENDER_PAGES,
        maxTextPages: MAX_TEXT_PAGES,
        maxCharacters: MAX_CHARACTERS,
        maxEdge: MAX_EDGE
      }
      const result = await withTimeout(
        window.webContents.executeJavaScript(`window.__foveaRenderDocument(${JSON.stringify(options)})`) as Promise<DocumentRenderResult>,
        RENDER_TIMEOUT_MS
      )
      return {
        pages: result.pages.map((page) => Buffer.from(page, 'base64')),
        text: result.text,
        truncated: result.truncated,
        pageCount: result.pageCount,
        totalPages: result.totalPages
      }
    } finally {
      this.queued.delete(token)
      if (window && !window.isDestroyed()) window.destroy()
    }
  }

  private installHandler(): void {
    if (this.handling) return
    this.handling = true
    protocol.handle(DOCUMENT_SCHEME, (request) => {
      const token = new URL(request.url).pathname.replace(/^\//, '')
      const queued = this.queued.get(token)
      if (!queued) return new Response('Not found', { status: 404 })
      return new Response(new Uint8Array(queued), { status: 200, headers: { 'content-type': 'application/pdf' } })
    })
  }
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('That PDF took too long to open.')), timeoutMs)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
