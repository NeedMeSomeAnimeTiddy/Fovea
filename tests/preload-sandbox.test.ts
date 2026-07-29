import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('sandboxed preload', () => {
  it('does not import Node built-ins that Electron removes from sandboxed preloads', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'preload', 'index.ts'), 'utf8')

    expect(source).not.toMatch(/\bfrom\s+['"]node:/)
    expect(source).not.toMatch(/\brequire\(\s*['"]node:/)
  })
})
