import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { TempScreenshotStore } from '../src/main/storage/temp-screenshot-store'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

describe('TempScreenshotStore', () => {
  it('removes stale screenshots but leaves unrelated and recent files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fovea-test-'))
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

  it('preserves current-process captures during manual cleanup while default startup cleanup removes them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fovea-test-'))
    roots.push(root)
    const store = new TempScreenshotStore(root)
    const active = await store.save(Buffer.from('active capture'))
    const orphaned = join(root, 'snip-orphaned.png')
    await writeFile(orphaned, 'orphaned capture')

    expect(await store.cleanup(0, { preserveActive: true })).toBe(1)
    await expect(readFile(active, 'utf8')).resolves.toBe('active capture')
    await expect(readFile(orphaned, 'utf8')).rejects.toThrow()

    expect(await store.cleanup()).toBe(1)
    await expect(readFile(active, 'utf8')).rejects.toThrow()
  })

  it('deletes direct managed screenshots', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fovea-test-'))
    roots.push(root)
    const store = new TempScreenshotStore(root)
    const screenshot = await store.save(Buffer.from('managed capture'))

    await store.delete(screenshot)

    await expect(readFile(screenshot, 'utf8')).rejects.toThrow()
  })

  it('refuses to delete traversal, sibling, nested, mixed-separator, or unrelated paths', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'fovea-test-'))
    roots.push(sandbox)
    const root = join(sandbox, 'captures')
    const sibling = join(sandbox, 'captures-sibling')
    const outside = join(sandbox, 'outside')
    const nested = join(root, 'nested')
    await Promise.all([
      mkdir(root, { recursive: true }),
      mkdir(sibling, { recursive: true }),
      mkdir(outside, { recursive: true }),
      mkdir(nested, { recursive: true }),
    ])

    const siblingSentinel = join(sibling, 'snip-sibling.png')
    const outsideSentinel = join(outside, 'snip-outside.png')
    const nestedSentinel = join(nested, 'snip-nested.png')
    const unrelatedSentinel = join(root, 'unrelated.png')
    await Promise.all([
      writeFile(siblingSentinel, 'sibling sentinel'),
      writeFile(outsideSentinel, 'outside sentinel'),
      writeFile(nestedSentinel, 'nested sentinel'),
      writeFile(unrelatedSentinel, 'unrelated sentinel'),
    ])

    const store = new TempScreenshotStore(root)
    const traversalPath = join(root, '..', 'outside', 'snip-outside.png')
    const mixedSeparatorTraversal = `${root}/../outside\\snip-outside.png`
    await Promise.all([
      store.delete(traversalPath),
      store.delete(siblingSentinel),
      store.delete(nestedSentinel),
      store.delete(mixedSeparatorTraversal),
      store.delete(unrelatedSentinel),
    ])

    await expect(readFile(siblingSentinel, 'utf8')).resolves.toBe('sibling sentinel')
    await expect(readFile(outsideSentinel, 'utf8')).resolves.toBe('outside sentinel')
    await expect(readFile(nestedSentinel, 'utf8')).resolves.toBe('nested sentinel')
    await expect(readFile(unrelatedSentinel, 'utf8')).resolves.toBe('unrelated sentinel')
  })
})
