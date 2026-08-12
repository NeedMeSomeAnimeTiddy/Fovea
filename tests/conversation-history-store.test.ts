import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ConversationHistoryStore,
  HISTORY_LIST_LIMIT,
  type ConversationHistoryRecord
} from '../src/main/storage/conversation-history-store'

interface StoreLocation {
  root: string
  databasePath: string
  legacyJsonPath: string
  images: string
}

const roots: string[] = []
const stores: ConversationHistoryStore[] = []

afterEach(async () => {
  for (const store of stores.splice(0)) store.dispose()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  vi.restoreAllMocks()
})

async function createLocation(): Promise<StoreLocation> {
  const root = await mkdtemp(join(tmpdir(), 'fovea-history-test-'))
  roots.push(root)
  return {
    root,
    databasePath: join(root, 'history.v2.sqlite'),
    legacyJsonPath: join(root, 'history.v1.json'),
    images: join(root, 'conversation-images')
  }
}

async function openStore(location: StoreLocation): Promise<ConversationHistoryStore> {
  const store = new ConversationHistoryStore(
    location.databasePath,
    location.images,
    location.legacyJsonPath
  )
  stores.push(store)
  await store.initialise()
  return store
}

async function createStore(): Promise<StoreLocation & { store: ConversationHistoryStore }> {
  const location = await createLocation()
  return { ...location, store: await openStore(location) }
}

describe('ConversationHistoryStore', () => {
  it('imports an unversioned JSON store once and keeps the source as a backup', async () => {
    const location = await createLocation()
    await writeFile(location.legacyJsonPath, JSON.stringify({
      conversations: [record('legacy', '2026-01-02T00:00:00.000Z', 'Legacy question')]
    }))

    const migrated = await openStore(location)

    expect(migrated.list()).toEqual([expect.objectContaining({ id: 'legacy', title: 'Legacy question' })])
    await expect(stat(location.databasePath)).resolves.toBeTruthy()
    await expect(stat(`${location.legacyJsonPath}.migrated.bak`)).resolves.toBeTruthy()
    await expect(readFile(location.legacyJsonPath, 'utf8')).rejects.toThrow()
  })

  it('leaves malformed legacy JSON untouched and reports the failed import', async () => {
    const location = await createLocation()
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await writeFile(location.legacyJsonPath, '{ valid history that was truncated')

    const store = await openStore(location)

    expect(store.list()).toEqual([])
    await expect(readFile(location.legacyJsonPath, 'utf8')).resolves.toBe('{ valid history that was truncated')
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('left untouched'))
  })

  it('searches transcript substrings and deletes one conversation or all history', async () => {
    const { store } = await createStore()
    await store.upsert(withoutAttachments(record('alpha', '2026-01-02T00:00:00.000Z', 'Quarterly chart')), [], false)
    await store.upsert(withoutAttachments(record('beta', '2026-01-03T00:00:00.000Z', 'Login error')), [], false)

    expect(store.list('arterly').map((item) => item.id)).toEqual(['alpha'])
    expect(store.list('og').map((item) => item.id)).toEqual(['beta'])
    expect(store.list('useful answer').map((item) => item.id)).toEqual(['beta', 'alpha'])
    await expect(store.delete('alpha')).resolves.toBe(true)
    expect(store.list().map((item) => item.id)).toEqual(['beta'])
    await expect(store.clear()).resolves.toBe(1)
    expect(store.list()).toEqual([])
  })

  it('applies retention and removes expired records', async () => {
    const { store } = await createStore()
    await store.upsert(withoutAttachments(record('old', '2026-01-01T00:00:00.000Z', 'Old')), [], false)
    await store.upsert(withoutAttachments(record('recent', '2026-01-30T00:00:00.000Z', 'Recent')), [], false)

    await expect(store.applyRetention(7, Date.parse('2026-02-01T00:00:00.000Z'))).resolves.toBe(1)
    expect(store.list().map((item) => item.id)).toEqual(['recent'])
  })

  it('archives screenshots only after explicit opt-in and removes copies when disabled', async () => {
    const { root, store } = await createStore()
    const source = join(root, 'source.png')
    await writeFile(source, 'png bytes')
    const base = withoutAttachments(record('images', '2026-01-02T00:00:00.000Z', 'Image'))

    await store.upsert(base, [{ id: 'capture', imagePath: source, edited: true }], false)
    expect(store.get('images')?.attachments).toEqual([])

    await store.upsert(base, [{ id: 'capture', imagePath: source, edited: true }], true)
    const archived = store.get('images')?.attachments[0]
    expect(archived).toEqual(expect.objectContaining({ id: 'capture', edited: true }))
    await expect(stat(archived!.imagePath)).resolves.toBeTruthy()

    await expect(store.removeAllScreenshots()).resolves.toBe(1)
    expect(store.get('images')?.attachments).toEqual([])
    await expect(stat(archived!.imagePath)).rejects.toThrow()
  })

  it('rolls back earlier attachment copies when a later source cannot be archived', async () => {
    const { root, images, store } = await createStore()
    const first = join(root, 'first.png')
    await writeFile(first, 'first image')

    await expect(store.upsert(
      withoutAttachments(record('partial-copy', '2026-01-02T00:00:00.000Z', 'Image')),
      [
        { id: 'first', imagePath: first, edited: false },
        { id: 'missing', imagePath: join(root, 'missing.png'), edited: false }
      ],
      true
    )).rejects.toThrow()

    expect(store.get('partial-copy')).toBeNull()
    await expect(readdir(images)).resolves.toEqual([])
  })

  it('rejects traversal paths from attachment rows without deleting the outside file', async () => {
    const location = await createLocation()
    const store = await openStore(location)
    await store.upsert(
      withoutAttachments(record('unsafe', '2026-01-02T00:00:00.000Z', 'Unsafe image')),
      [],
      false
    )
    store.dispose()

    const outside = join(location.root, 'outside.png')
    const traversal = `${location.images}${sep}nested${sep}..${sep}..${sep}outside.png`
    await writeFile(outside, 'must remain')
    const database = new DatabaseSync(location.databasePath)
    database.prepare(`
      INSERT INTO conversation_attachments (conversation_id, id, image_path, edited)
      VALUES (?, ?, ?, ?)
    `).run('unsafe', 'escape', traversal, 0)
    database.prepare('UPDATE conversations SET has_screenshots = 1 WHERE id = ?').run('unsafe')
    database.close()

    const reopened = await openStore(location)
    expect(reopened.get('unsafe')?.attachments).toEqual([])
    await expect(reopened.clear()).resolves.toBe(1)
    await expect(readFile(outside, 'utf8')).resolves.toBe('must remain')
  })

  it('rejects cwd-relative attachment rows even when they resolve inside the image directory', async () => {
    const location = await createLocation()
    const store = await openStore(location)
    await store.upsert(
      withoutAttachments(record('relative', '2026-01-02T00:00:00.000Z', 'Relative image')),
      [],
      false
    )
    store.dispose()

    const image = join(location.images, 'relative.png')
    await writeFile(image, 'must remain')
    const database = new DatabaseSync(location.databasePath)
    database.prepare(`
      INSERT INTO conversation_attachments (conversation_id, id, image_path, edited)
      VALUES (?, ?, ?, ?)
    `).run('relative', 'relative-path', relative(process.cwd(), image), 0)
    database.close()

    const reopened = await openStore(location)
    expect(reopened.get('relative')?.attachments).toEqual([])
    await expect(reopened.clear()).resolves.toBe(1)
    await expect(readFile(image, 'utf8')).resolves.toBe('must remain')
  })

  it('retries queued attachment deletion on the next initialisation', async () => {
    const location = await createLocation()
    const store = await openStore(location)
    store.dispose()
    const orphan = join(location.images, 'queued-orphan.png')
    await writeFile(orphan, 'orphan')

    const database = new DatabaseSync(location.databasePath)
    database.prepare('INSERT INTO attachment_deletion_queue (image_path) VALUES (?)').run(orphan)
    database.close()

    await openStore(location)
    await expect(stat(orphan)).rejects.toThrow()
  })

  it('reconciles managed screenshot orphans left without database rows', async () => {
    const location = await createLocation()
    const store = await openStore(location)
    store.dispose()
    const orphan = join(location.images, 'old-conversation-capture.png')
    const unrelated = join(location.images, 'readme.txt')
    await writeFile(orphan, 'sensitive orphan')
    await writeFile(unrelated, 'not an app-managed screenshot')

    await openStore(location)

    await expect(stat(orphan)).rejects.toThrow()
    await expect(readFile(unrelated, 'utf8')).resolves.toBe('not an app-managed screenshot')
  })

  it('directly removes copied screenshots when both the history write and cleanup queue fail', async () => {
    const { root, images, databasePath, store } = await createStore()
    const source = join(root, 'source.png')
    await writeFile(source, 'sensitive image')
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const database = new DatabaseSync(databasePath)
    database.exec(`
      DROP TABLE attachment_deletion_queue;
      CREATE TRIGGER reject_conversation_insert
      BEFORE INSERT ON conversations
      BEGIN
        SELECT RAISE(FAIL, 'forced history write failure');
      END;
    `)
    database.close()

    await expect(store.upsert(
      withoutAttachments(record('write-failure', '2026-01-02T00:00:00.000Z', 'Image')),
      [{ id: 'capture', imagePath: source, edited: false }],
      true
    )).rejects.toThrow('forced history write failure')

    await expect(readdir(images)).resolves.toEqual([])
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('could not be queued'))
  })

  it('keeps list and indexed substring search bounded with 10,000 records', async () => {
    const location = await createLocation()
    const conversations = Array.from({ length: 10_000 }, (_, index) => {
      const suffix = String(index).padStart(5, '0')
      return record(
        `history-${suffix}`,
        new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
        `Question ${suffix} unique-suffix`
      )
    })
    await writeFile(location.legacyJsonPath, JSON.stringify({ version: 1, conversations }))
    const startupStarted = performance.now()
    const store = await openStore(location)
    const startupElapsed = performance.now() - startupStarted

    const listStarted = performance.now()
    const recent = store.list()
    const listElapsed = performance.now() - listStarted
    const searchStarted = performance.now()
    const matches = store.list('09999 unique')
    const searchElapsed = performance.now() - searchStarted
    const upsertStarted = performance.now()
    await store.upsert(withoutAttachments(record('history-new', '2026-02-01T00:00:00.000Z', 'New record')), [], false)
    const upsertElapsed = performance.now() - upsertStarted

    expect(recent).toHaveLength(HISTORY_LIST_LIMIT)
    expect(recent[0]?.id).toBe('history-09999')
    expect(matches.map((item) => item.id)).toEqual(['history-09999'])
    expect(startupElapsed).toBeLessThan(20_000)
    expect(Math.max(listElapsed, searchElapsed)).toBeLessThan(1_000)
    expect(upsertElapsed).toBeLessThan(1_000)
  }, 30_000)
})

function record(id: string, updatedAt: string, question: string): ConversationHistoryRecord {
  return {
    id,
    title: question,
    createdAt: updatedAt,
    updatedAt,
    exchanges: [{
      id: `${id}-exchange`,
      question,
      answer: 'Useful answer',
      phase: 'completed',
      segmentId: `${id}-segment`
    }],
    segments: [],
    selection: null,
    attachments: []
  }
}

function withoutAttachments(value: ConversationHistoryRecord): Omit<ConversationHistoryRecord, 'attachments'> {
  const copy = { ...value } as Partial<ConversationHistoryRecord>
  delete copy.attachments
  return copy as Omit<ConversationHistoryRecord, 'attachments'>
}
