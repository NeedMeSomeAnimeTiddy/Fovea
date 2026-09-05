import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  injectRendererCsp,
  RENDERER_PAGES,
  rendererCspMetaTag,
  rendererCspPlugin,
  rendererCspPolicy,
  rendererPageFromPath,
  type RendererPage
} from '../build/renderer-csp'

const rendererRoot = join(process.cwd(), 'src', 'renderer')

function directive(policy: string, name: string): string | undefined {
  return policy.split(';').map((item) => item.trim()).find((item) => item.startsWith(`${name} `))
}

/** Mirrors what Vite hands the hook after it has injected the bundled script and stylesheet tags. */
function builtHtml(page: RendererPage): string {
  const source = readFileSync(join(rendererRoot, page, 'index.html'), 'utf8')
  return source
    .replace(/<script type="module" src="\.\/main\.tsx?"><\/script>/, '')
    .replace('</head>', `<script type="module" crossorigin src="../assets/${page}.js"></script><link rel="stylesheet" crossorigin href="../assets/${page}.css"></head>`)
}

describe('renderer Content-Security-Policy', () => {
  it('covers every renderer page that electron-vite builds', () => {
    const configured = readFileSync(join(process.cwd(), 'electron.vite.config.ts'), 'utf8')
    for (const page of RENDERER_PAGES) expect(configured).toContain(`src/renderer/${page}/index.html`)
  })

  it('applies only to production builds', () => {
    const plugin = rendererCspPlugin()
    expect(plugin.apply).toBe('build')
    expect(plugin.transformIndexHtml).toMatchObject({ order: 'post' })
  })

  it.each(RENDERER_PAGES)('injects the policy for %s ahead of the bundled tags', (page) => {
    const plugin = rendererCspPlugin()
    const handler = (plugin.transformIndexHtml as { handler: (html: string, context: { path: string; filename: string }) => string }).handler
    const filename = join(rendererRoot, page, 'index.html')
    const output = handler(builtHtml(page), { path: `/${page}/index.html`, filename })

    expect(output).toContain(rendererCspMetaTag(page))
    expect(output.indexOf('Content-Security-Policy')).toBeLessThan(output.indexOf('<script'))
    expect(output.indexOf('Content-Security-Policy')).toBeLessThan(output.indexOf('<link'))
    expect(output.match(/Content-Security-Policy/g)).toHaveLength(1)
  })

  it('forbids remote scripts, eval, plugins, frames, and form submission everywhere', () => {
    for (const page of RENDERER_PAGES) {
      const policy = rendererCspPolicy(page)
      expect(directive(policy, 'script-src')).toBe("script-src 'self'")
      expect(policy).not.toContain('unsafe-eval')
      expect(directive(policy, 'object-src')).toBe("object-src 'none'")
      expect(directive(policy, 'frame-src')).toBe("frame-src 'none'")
      expect(directive(policy, 'base-uri')).toBe("base-uri 'none'")
      expect(directive(policy, 'form-action')).toBe("form-action 'none'")
      expect(directive(policy, 'worker-src')).toBe("worker-src 'none'")
      expect(directive(policy, 'media-src')).toBe("media-src 'none'")
      // Ignored inside a <meta> tag, and Chromium logs an error for it on every load.
      expect(policy).not.toContain('frame-ancestors')
    }
  })

  it('lets only the hidden document renderer reach the fovea-doc scheme', () => {
    expect(directive(rendererCspPolicy('document-render'), 'connect-src')).toBe("connect-src 'self' fovea-doc:")
    for (const page of RENDERER_PAGES.filter((item) => item !== 'document-render')) {
      expect(directive(rendererCspPolicy(page), 'connect-src')).toBe("connect-src 'none'")
      expect(rendererCspPolicy(page)).not.toContain('blob:')
    }
  })

  it('does not duplicate a policy that is already present', () => {
    const once = injectRendererCsp('<html><head></head><body></body></html>', 'settings')
    expect(injectRendererCsp(once, 'settings')).toBe(once)
  })

  it('refuses a page without a declared policy', () => {
    expect(() => rendererPageFromPath(join(rendererRoot, 'new-page', 'index.html'))).toThrow(/new-page/)
    expect(() => injectRendererCsp('<html><head></head></html>', 'new-page' as RendererPage)).toThrow(/new-page/)
    expect(() => injectRendererCsp('<html><body></body></html>', 'settings')).toThrow(/<head>/)
  })
})
