import { basename, dirname } from 'node:path'
import type { Plugin } from 'vite'

/**
 * Content-Security-Policy for each built renderer page.
 *
 * The policy is injected at build time rather than written into the source HTML because the dev
 * server relies on Vite HMR and the react-refresh preamble, both of which are inline scripts that
 * `script-src 'self'` would refuse. Packaged pages are loaded from `file://`, where `'self'`
 * matches the bundled assets next to each `index.html`.
 *
 * `frame-ancestors` is deliberately absent: browsers ignore it in a `<meta>` element and log an
 * error on every page load. Renderers never open child frames, so `frame-src 'none'` covers the
 * embedding direction that a meta policy can control.
 */
export type RendererPage = 'settings' | 'capture-overlay' | 'question-window' | 'image-preview' | 'document-render'

type Policy = Readonly<Record<string, readonly string[]>>

/** Every page starts here; a page only widens a directive it has a demonstrated need for. */
const BASE_POLICY: Policy = {
  'default-src': ["'self'"],
  'script-src': ["'self'"],
  // React inline `style` attributes and the design-system custom properties need inline styles.
  'style-src': ["'self'", "'unsafe-inline'"],
  // Screenshots, thumbnails, and Vite-inlined assets arrive as data: URLs; nothing uses blob:.
  'img-src': ["'self'", 'data:'],
  'font-src': ["'self'", 'data:'],
  // No renderer fetches anything; the preload bridge talks to main over IPC, not the network.
  'connect-src': ["'none'"],
  'worker-src': ["'none'"],
  // The capture overlay attaches a MediaStream through `srcObject`, which is not a URL fetch and
  // is therefore not governed by media-src, so no page needs media sources.
  'media-src': ["'none'"],
  'frame-src': ["'none'"],
  'object-src': ["'none'"],
  'base-uri': ["'none'"],
  'form-action': ["'none'"]
}

const PAGE_OVERRIDES: Readonly<Record<RendererPage, Policy>> = {
  settings: {},
  'capture-overlay': {},
  'question-window': {},
  'image-preview': {},
  'document-render': {
    // pdf.js reads the queued PDF from the privileged `fovea-doc:` scheme (see
    // src/main/files/pdf-ingestion-service.ts) and decodes embedded images via blob URLs.
    'connect-src': ["'self'", 'fovea-doc:'],
    'img-src': ["'self'", 'data:', 'blob:']
  }
}

export const RENDERER_PAGES = Object.keys(PAGE_OVERRIDES) as readonly RendererPage[]

export function isRendererPage(value: string): value is RendererPage {
  return Object.prototype.hasOwnProperty.call(PAGE_OVERRIDES, value)
}

/** The serialised policy for one page, as it appears in the meta tag. */
export function rendererCspPolicy(page: RendererPage): string {
  const policy = { ...BASE_POLICY, ...PAGE_OVERRIDES[page] }
  return Object.entries(policy).map(([directive, sources]) => `${directive} ${sources.join(' ')}`).join('; ')
}

export function rendererCspMetaTag(page: RendererPage): string {
  return `<meta http-equiv="Content-Security-Policy" content="${rendererCspPolicy(page)}">`
}

/**
 * Places the policy first in `<head>` so it is enforced before any script or stylesheet tag that
 * Vite has already injected. Throws when the page has no CSP entry so a new renderer cannot ship
 * without declaring what it is allowed to load.
 */
export function injectRendererCsp(html: string, page: RendererPage): string {
  if (!isRendererPage(page)) throw new Error(`No Content-Security-Policy is defined for renderer page "${page}".`)
  if (/http-equiv=["']Content-Security-Policy["']/i.test(html)) return html
  const head = html.match(/<head[^>]*>/i)
  if (!head || head.index === undefined) throw new Error(`Renderer page "${page}" has no <head> to carry its Content-Security-Policy.`)
  const insertAt = head.index + head[0].length
  return `${html.slice(0, insertAt)}${rendererCspMetaTag(page)}${html.slice(insertAt)}`
}

/** Renderer pages are identified by the directory that holds their `index.html`. */
export function rendererPageFromPath(path: string): RendererPage {
  const page = basename(dirname(path))
  if (!isRendererPage(page)) throw new Error(`No Content-Security-Policy is defined for renderer page "${page}" (${path}).`)
  return page
}

export function rendererCspPlugin(): Plugin {
  return {
    name: 'fovea:renderer-csp',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler: (html, context) => injectRendererCsp(html, rendererPageFromPath(context.filename || context.path))
    }
  }
}
