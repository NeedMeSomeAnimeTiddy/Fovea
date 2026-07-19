import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { TempScreenshotStore } from '../src/main/storage/temp-screenshot-store'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

describe('TempScreenshotStore', () => {
  it('removes stale screenshots but leaves unrelated and recent files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'snipchat-test-'))
    roots.push(root)
    const store = new TempScreenshotStore(root)
    await store.initialise()
    const stale = join(root, 'snip-stale.png')
    const recent = join(root, 'snip-recent.png')
    const unrelated = join(root, 'notes.txt')
    await Promise.all([writeFile(stale, 'stale'), writeFile(recent, 'recent'), writeFile(unrelated, 'keep')])
    const old = new Date(Date.now() - 60_000)
    await utimes(stale, old, old)
    expect(await store.cleanup(30_000)).toBe(1)
    await expect(readFile(recent, 'utf8')).resolves.toBe('recent')
    await expect(readFile(unrelated, 'utf8')).resolves.toBe('keep')
  })
})
