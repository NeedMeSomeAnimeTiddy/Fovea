/** Contract between the main process and the hidden `document-render` renderer. */
export interface DocumentRenderOptions {
  /** A `fovea-doc://` URL that resolves to the single queued file. */
  url: string
  /** Pages drawn as images and attached to the conversation. */
  maxRenderPages: number
  /** Pages whose embedded text is read, which may exceed the pages drawn. */
  maxTextPages: number
  maxCharacters: number
  maxEdge: number
}

export interface DocumentRenderResult {
  /** Base64 PNG page images, without a data-URL prefix. */
  pages: string[]
  text: string
  truncated: boolean
  pageCount: number
  totalPages: number
}
