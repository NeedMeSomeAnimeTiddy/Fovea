import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const handlers = new Map<string, (request: { url: string }) => Response | Promise<Response>>()
  const protocol = {
    registerSchemesAsPrivileged: vi.fn(),
    handle: vi.fn((scheme: string, handler: (request: { url: string }) => Response | Promise<Response>) => { handlers.set(scheme, handler) })
  }
  const renderResult = { pages: [Buffer.from('png').toString('base64')], text: 'Hello', truncated: false, pageCount: 1, totalPages: 1 }
  const executeJavaScript = vi.fn<(script: string) => Promise<unknown>>(async () => renderResult)
  class FakeWindow {
    destroyed = false
    readonly webContents = { setWindowOpenHandler: vi.fn(), executeJavaScript }
    isDestroyed(): boolean { return this.destroyed }
    destroy(): void { this.destroyed = true }
  }
  const windows: FakeWindow[] = []
  const secureWindow = vi.fn<(options: unknown, secure?: unknown) => FakeWindow>(() => {
    const window = new FakeWindow()
    windows.push(window)
    return window
  })
  const loadRenderer = vi.fn(async () => undefined)
  return { executeJavaScript, handlers, loadRenderer, protocol, secureWindow, windows }
})

vi.mock('electron', () => ({ protocol: mocks.protocol }))
vi.mock('../src/main/windows/window-factory', () => ({ loadRenderer: mocks.loadRenderer, secureWindow: mocks.secureWindow }))

import { DOCUMENT_SCHEME, PdfIngestionService } from '../src/main/files/pdf-ingestion-service'

/** Recovers the options object from the `window.__foveaRenderDocument({...})` script. */
function renderOptions(script: string): { url: string } {
  return JSON.parse(script.slice(script.indexOf('(') + 1, script.lastIndexOf(')'))) as { url: string }
}

describe('PdfIngestionService', () => {
  beforeEach(() => {
    mocks.windows.length = 0
    mocks.handlers.clear()
    mocks.secureWindow.mockClear()
    mocks.loadRenderer.mockClear()
    mocks.executeJavaScript.mockClear()
    mocks.protocol.handle.mockClear()
  })

  it('renders through a hidden window that carries no preload bridge', async () => {
    const service = new PdfIngestionService()
    const result = await service.ingest(Buffer.from('%PDF-1.7'))

    expect(mocks.secureWindow).toHaveBeenCalledTimes(1)
    const [options, secure] = mocks.secureWindow.mock.calls[0]!
    expect(options).toMatchObject({ show: false, webPreferences: { backgroundThrottling: false } })
    expect(secure).toEqual({ preload: false })
    expect(mocks.loadRenderer).toHaveBeenCalledWith(mocks.windows[0], 'document-render')
    expect(result).toEqual({ pages: [Buffer.from('png')], text: 'Hello', truncated: false, pageCount: 1, totalPages: 1 })
    expect(mocks.windows[0]!.isDestroyed()).toBe(true)
  })

  it('serves the PDF on a single-use fovea-doc URL that stops resolving once ingestion ends', async () => {
    const service = new PdfIngestionService()
    const pdf = Buffer.from('%PDF-1.7 body')
    let url = ''
    let responseDuringRender: Response | undefined
    mocks.executeJavaScript.mockImplementationOnce(async (script) => {
      url = renderOptions(script).url
      responseDuringRender = await mocks.handlers.get(DOCUMENT_SCHEME)!({ url })
      return { pages: [], text: '', truncated: false, pageCount: 0, totalPages: 0 }
    })

    await service.ingest(pdf)

    expect(url).toMatch(new RegExp(`^${DOCUMENT_SCHEME}://document/[0-9a-f-]{36}$`))
    expect(responseDuringRender?.status).toBe(200)
    expect(Buffer.from(await responseDuringRender!.arrayBuffer())).toEqual(pdf)
    const afterwards = await mocks.handlers.get(DOCUMENT_SCHEME)!({ url })
    expect(afterwards.status).toBe(404)
  })

  it('destroys the window when the renderer fails to load', async () => {
    const service = new PdfIngestionService()
    mocks.loadRenderer.mockRejectedValueOnce(new Error('load failed'))

    await expect(service.ingest(Buffer.from('%PDF-1.7'))).rejects.toThrow('load failed')
    expect(mocks.windows[0]!.isDestroyed()).toBe(true)
  })
})
