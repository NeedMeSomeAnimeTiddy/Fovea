import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ConversationHistoryStore, type ConversationHistoryRecord } from '../src/main/storage/conversation-history-store'

const roots: string[] = []

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

async function createStore(): Promise<{ root: string; path: string; images: string; store: ConversationHistoryStore }> {
  const root = await mkdtemp(join(tmpdir(), 'fovea-history-test-'))
  roots.push(root)
  const path = join(root, 'history.v1.json')
  const images = join(root, 'conversation-images')
  const store = new ConversationHistoryStore(path, images)
  await store.initialise()
  return { root, path, images, store }
}

describe('ConversationHistoryStore', () => {
  it('initialises and migrates an unversioned local store', async () => {
    const { path, images } = await createStore()
    await writeFile(path, JSON.stringify({ conversations: [record('legacy', '2026-01-02T00:00:00.000Z', 'Legacy question')] }))

    const migrated = new ConversationHistoryStore(path, images)
    await migrated.initialise()

    expect(migrated.list()).toEqual([expect.objectContaining({ id: 'legacy', title: 'Legacy question' })])
    expect(JSON.parse(await readFile(path, 'utf8')).version).toBe(1)
  })

  it('searches transcript text and deletes one conversation or all history', async () => {
    const { store } = await createStore()
    await store.upsert(withoutAttachments(record('alpha', '2026-01-02T00:00:00.000Z', 'Quarterly chart')), [], false)
    await store.upsert(withoutAttachments(record('beta', '2026-01-03T00:00:00.000Z', 'Login error')), [], false)

    expect(store.list('quarterly')).toHaveLength(1)
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
