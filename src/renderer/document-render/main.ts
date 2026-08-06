import * as pdfjs from 'pdfjs-dist'
import { WorkerMessageHandler } from 'pdfjs-dist/build/pdf.worker.mjs'
import type { DocumentRenderOptions, DocumentRenderResult } from '@shared/types/document-render'

// Publishing the handler makes pdf.js use its in-process message handler instead of spawning a
// Worker, which a sandboxed file:// renderer is not allowed to do.
;(globalThis as { pdfjsWorker?: { WorkerMessageHandler: unknown } }).pdfjsWorker = { WorkerMessageHandler }

/**
 * This renderer exists only so pdf.js has a canvas. It has no UI, is never shown, and is driven
 * entirely by `executeJavaScript` from the main process, so no preload surface is added for it.
 */
async function renderDocument(options: DocumentRenderOptions): Promise<DocumentRenderResult> {
  const loading = pdfjs.getDocument({ url: options.url })
  const document_ = await loading.promise
  try {
    const totalPages = document_.numPages
    const pages: string[] = []
    const paragraphs: string[] = []
    let characters = 0
    let truncated = false
    let pagesRead = 0

    for (let pageNumber = 1; pageNumber <= Math.min(totalPages, options.maxTextPages); pageNumber++) {
      const page = await document_.getPage(pageNumber)
      try {
        if (pages.length < options.maxRenderPages) pages.push(await renderPage(page, options.maxEdge))
        if (characters < options.maxCharacters) {
          const text = await readPageText(page)
          if (text) {
            const remaining = options.maxCharacters - characters
            const clipped = text.slice(0, remaining)
            truncated ||= clipped.length < text.length
            paragraphs.push(clipped)
            characters += clipped.length
          }
          pagesRead = pageNumber
        }
      } finally {
        page.cleanup()
      }
    }
    truncated ||= pagesRead < totalPages
    return { pages, text: paragraphs.join('\n\n').trim(), truncated, pageCount: pagesRead, totalPages }
  } finally {
    // Destroying the loading task tears down the document and its in-process message handler.
    await loading.destroy()
  }
}

async function renderPage(page: pdfjs.PDFPageProxy, maxEdge: number): Promise<string> {
  const base = page.getViewport({ scale: 1 })
  // Match the cap applied to imported images, and never upscale a small page beyond 2x.
  const scale = Math.min(maxEdge / Math.max(base.width, base.height), 2)
  const viewport = page.getViewport({ scale })
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.ceil(viewport.width))
  canvas.height = Math.max(1, Math.ceil(viewport.height))
  const context = canvas.getContext('2d')
  if (!context) throw new Error('This PDF page could not be drawn.')
  // PDF pages are transparent; a white sheet is what the user expects to see.
  // fovea-design-allow: PDF paper stock in an offscreen canvas, not a Fovea surface, and it must not follow the theme.
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, canvas.width, canvas.height)
  await page.render({ canvas, canvasContext: context, viewport }).promise
  return canvas.toDataURL('image/png').replace(/^data:image\/png;base64,/, '')
}

async function readPageText(page: pdfjs.PDFPageProxy): Promise<string> {
  const content = await page.getTextContent()
  let text = ''
  for (const item of content.items) {
    if (!('str' in item)) continue
    text += item.str
    if (item.hasEOL) text += '\n'
  }
  return text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

declare global {
  interface Window {
    __foveaRenderDocument(options: DocumentRenderOptions): Promise<DocumentRenderResult>
  }
}

window.__foveaRenderDocument = renderDocument
