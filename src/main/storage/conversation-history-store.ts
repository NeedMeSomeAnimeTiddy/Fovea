import { DatabaseSync, type SQLOutputValue } from 'node:sqlite'
import { chmod, copyFile, mkdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import type {
  ConversationExchange,
  ConversationHistorySummary,
  ConversationSegment,
  ConversationSelection
} from '@shared/types/app'

const STORE_VERSION = 2
export const HISTORY_LIST_LIMIT = 200

export interface HistoryAttachment {
  id: string
  imagePath: string
  edited: boolean
}

export interface ConversationHistoryRecord {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  exchanges: ConversationExchange[]
  segments: ConversationSegment[]
  selection: ConversationSelection | null
  attachments: HistoryAttachment[]
}

export interface HistoryAttachmentSource {
  id: string
  imagePath: string
  edited: boolean
}

interface StoredHistory {
  conversations: ConversationHistoryRecord[]
}

interface ConversationRow extends Record<string, SQLOutputValue> {
  id: string
  title: string
  created_at: string
  updated_at: string
  exchanges_json: string
  segments_json: string
  selection_json: string
}

interface AttachmentArchive {
  attachments: HistoryAttachment[]
  copied: HistoryAttachment[]
  obsolete: HistoryAttachment[]
}

export class ConversationHistoryStore {
  private database: DatabaseSync | null = null

  constructor(
    private readonly databasePath: string,
    private readonly imageDirectory: string,
    private readonly legacyJsonPath?: string
  ) {}

  async initialise(): Promise<void> {
    if (this.database) return
    await mkdir(dirname(this.databasePath), { recursive: true, mode: 0o700 })
    await mkdir(this.imageDirectory, { recursive: true, mode: 0o700 })
    await chmod(this.imageDirectory, 0o700).catch(() => undefined)

    const database = new DatabaseSync(this.databasePath)
    this.database = database
    try {
      database.exec('PRAGMA foreign_keys = ON')
      database.exec('PRAGMA journal_mode = WAL')
      database.exec('PRAGMA synchronous = NORMAL')
      database.exec(`
        CREATE TABLE IF NOT EXISTS history_metadata (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        ) STRICT;

        CREATE TABLE IF NOT EXISTS conversations (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          exchanges_json TEXT NOT NULL,
          segments_json TEXT NOT NULL,
          selection_json TEXT NOT NULL,
          message_count INTEGER NOT NULL,
          has_screenshots INTEGER NOT NULL,
          search_text TEXT NOT NULL
        ) STRICT;

        CREATE INDEX IF NOT EXISTS conversations_updated_at_idx
          ON conversations(updated_at DESC);

        CREATE TABLE IF NOT EXISTS conversation_attachments (
          conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
          id TEXT NOT NULL,
          image_path TEXT NOT NULL,
          edited INTEGER NOT NULL,
          PRIMARY KEY (conversation_id, id)
        ) STRICT;

        CREATE VIRTUAL TABLE IF NOT EXISTS conversation_search USING fts5(
          conversation_id UNINDEXED,
          content,
          tokenize = 'trigram'
        );

        PRAGMA user_version = ${STORE_VERSION};
      `)
      await chmod(this.databasePath, 0o600).catch(() => undefined)
      await this.migrateLegacyJson()
      this.removeUnsafeAttachmentRows()
    } catch (error) {
      database.close()
      this.database = null
      throw error
    }
  }

  list(query = ''): ConversationHistorySummary[] {
    const database = this.requireDatabase()
    const needle = query.trim().toLocaleLowerCase()
    const columns = `
      SELECT c.id, c.title, c.created_at, c.updated_at, c.message_count, c.has_screenshots
    `
    const rows = !needle
      ? database.prepare(`${columns}
          FROM conversations c
          ORDER BY c.updated_at DESC
          LIMIT ?`).all(HISTORY_LIST_LIMIT)
      : needle.length >= 3
        ? database.prepare(`${columns}
            FROM conversation_search
            JOIN conversations c ON c.id = conversation_search.conversation_id
            WHERE conversation_search MATCH ?
            ORDER BY c.updated_at DESC
            LIMIT ?`).all(ftsPhrase(needle), HISTORY_LIST_LIMIT)
        : database.prepare(`${columns}
            FROM conversations c
            WHERE c.search_text LIKE ? ESCAPE '\\'
            ORDER BY c.updated_at DESC
            LIMIT ?`).all(`%${escapeLikePattern(needle)}%`, HISTORY_LIST_LIMIT)

    return rows.map((row) => ({
      id: stringValue(row.id),
      title: stringValue(row.title),
      createdAt: stringValue(row.created_at),
      updatedAt: stringValue(row.updated_at),
      messageCount: numberValue(row.message_count),
      hasScreenshots: numberValue(row.has_screenshots) > 0
    }))
  }

  get(id: string): ConversationHistoryRecord | null {
    const database = this.requireDatabase()
    const row = database.prepare(`
      SELECT id, title, created_at, updated_at, exchanges_json, segments_json, selection_json
      FROM conversations
      WHERE id = ?
    `).get(id) as ConversationRow | undefined
    if (!row) return null
    const attachments = database.prepare(`
      SELECT id, image_path, edited
      FROM conversation_attachments
      WHERE conversation_id = ?
      ORDER BY rowid
    `).all(id).map((attachment) => ({
      id: stringValue(attachment.id),
      imagePath: stringValue(attachment.image_path),
      edited: numberValue(attachment.edited) > 0
    })).filter((attachment) => isPathInside(this.imageDirectory, attachment.imagePath))

    return sanitizeRecord({
      id: row.id,
      title: row.title,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      exchanges: jsonArray<ConversationExchange>(row.exchanges_json),
      segments: jsonArray<ConversationSegment>(row.segments_json),
      selection: jsonValue<ConversationSelection | null>(row.selection_json, null),
      attachments
    })
  }

  async upsert(
    record: Omit<ConversationHistoryRecord, 'attachments'>,
    sources: HistoryAttachmentSource[],
    retainScreenshots: boolean
  ): Promise<void> {
    const existing = this.get(record.id)?.attachments ?? []
    const archive = retainScreenshots
      ? await this.archiveAttachments(record.id, sources, existing)
      : { attachments: [], copied: [], obsolete: existing }
    const next = sanitizeRecord({ ...structuredClone(record), attachments: archive.attachments })

    try {
      this.writeRecords([next])
    } catch (error) {
      await this.deleteAttachmentFiles(archive.copied)
      throw error
    }
    await this.deleteAttachmentFiles(archive.obsolete)
  }

  async delete(id: string): Promise<boolean> {
    const database = this.requireDatabase()
    const attachments = this.get(id)?.attachments ?? []
    const removed = this.inTransaction(() => {
      database.prepare('DELETE FROM conversation_search WHERE conversation_id = ?').run(id)
      return database.prepare('DELETE FROM conversations WHERE id = ?').run(id).changes > 0
    })
    if (removed) await this.deleteAttachmentFiles(attachments)
    return removed
  }

  async clear(): Promise<number> {
    const database = this.requireDatabase()
    const attachments = this.allAttachments()
    const removed = this.inTransaction(() => {
      const count = numberValue(database.prepare('SELECT COUNT(*) AS count FROM conversations').get()?.count)
      database.prepare('DELETE FROM conversation_search').run()
      database.prepare('DELETE FROM conversations').run()
      return count
    })
    await this.deleteAttachmentFiles(attachments)
    return removed
  }

  async applyRetention(retentionDays: number, now = Date.now()): Promise<number> {
    const database = this.requireDatabase()
    const cutoff = new Date(now - Math.max(1, retentionDays) * 24 * 60 * 60 * 1_000).toISOString()
    const attachments = database.prepare(`
      SELECT a.id, a.image_path, a.edited
      FROM conversation_attachments a
      JOIN conversations c ON c.id = a.conversation_id
      WHERE c.updated_at < ?
    `).all(cutoff).map(attachmentFromRow)
    const removed = this.inTransaction(() => {
      database.prepare(`
        DELETE FROM conversation_search
        WHERE conversation_id IN (SELECT id FROM conversations WHERE updated_at < ?)
      `).run(cutoff)
      return numberValue(database.prepare('DELETE FROM conversations WHERE updated_at < ?').run(cutoff).changes)
    })
    await this.deleteAttachmentFiles(attachments)
    return removed
  }

  async removeAllScreenshots(): Promise<number> {
    const database = this.requireDatabase()
    const attachments = this.allAttachments()
    if (!attachments.length) return 0
    this.inTransaction(() => {
      database.prepare('DELETE FROM conversation_attachments').run()
      database.prepare('UPDATE conversations SET has_screenshots = 0').run()
    })
    await this.deleteAttachmentFiles(attachments)
    return attachments.length
  }

  dispose(): void {
    if (!this.database) return
    this.database.close()
    this.database = null
  }

  private async migrateLegacyJson(): Promise<void> {
    if (!this.legacyJsonPath) return
    const database = this.requireDatabase()
    const migrated = database.prepare(
      "SELECT value FROM history_metadata WHERE key = 'legacy_json_migrated'"
    ).get()
    if (migrated) return

    let raw: string
    try {
      raw = await readFile(this.legacyJsonPath, 'utf8')
    } catch (error) {
      if (isMissingFile(error)) return
      throw error
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      console.warn(`[history] Legacy history could not be parsed and was left untouched: ${safeErrorMessage(error)}`)
      return
    }

    const records = migrate(parsed).conversations.map((record) => ({
      ...record,
      attachments: record.attachments.filter((attachment) => isPathInside(this.imageDirectory, attachment.imagePath))
    }))
    this.writeRecords(records, () => {
      database.prepare(`
        INSERT INTO history_metadata (key, value)
        VALUES ('legacy_json_migrated', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(new Date().toISOString())
    })

    const backupPath = await this.availableBackupPath()
    try {
      await rename(this.legacyJsonPath, backupPath)
      await chmod(backupPath, 0o600).catch(() => undefined)
    } catch (error) {
      console.warn(`[history] Legacy history was imported but could not be renamed as a backup: ${safeErrorMessage(error)}`)
    }
  }

  private writeRecords(records: ConversationHistoryRecord[], afterWrite?: () => void): void {
    const database = this.requireDatabase()
    const writeConversation = database.prepare(`
      INSERT INTO conversations (
        id, title, created_at, updated_at, exchanges_json, segments_json, selection_json,
        message_count, has_screenshots, search_text
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        exchanges_json = excluded.exchanges_json,
        segments_json = excluded.segments_json,
        selection_json = excluded.selection_json,
        message_count = excluded.message_count,
        has_screenshots = excluded.has_screenshots,
        search_text = excluded.search_text
    `)
    const deleteAttachments = database.prepare(
      'DELETE FROM conversation_attachments WHERE conversation_id = ?'
    )
    const writeAttachment = database.prepare(`
      INSERT INTO conversation_attachments (conversation_id, id, image_path, edited)
      VALUES (?, ?, ?, ?)
    `)
    const deleteSearch = database.prepare('DELETE FROM conversation_search WHERE conversation_id = ?')
    const writeSearch = database.prepare(
      'INSERT INTO conversation_search (conversation_id, content) VALUES (?, ?)'
    )

    this.inTransaction(() => {
      for (const candidate of records) {
        const record = sanitizeRecord(candidate)
        const searchText = searchableText(record)
        writeConversation.run(
          record.id,
          record.title,
          record.createdAt,
          record.updatedAt,
          JSON.stringify(record.exchanges),
          JSON.stringify(record.segments),
          JSON.stringify(record.selection),
          record.exchanges.length,
          record.attachments.length > 0 ? 1 : 0,
          searchText
        )
        deleteAttachments.run(record.id)
        for (const attachment of record.attachments) {
          writeAttachment.run(record.id, attachment.id, attachment.imagePath, attachment.edited ? 1 : 0)
        }
        deleteSearch.run(record.id)
        writeSearch.run(record.id, searchText)
      }
      afterWrite?.()
    })
  }

  private inTransaction<T>(action: () => T): T {
    const database = this.requireDatabase()
    database.exec('BEGIN IMMEDIATE')
    try {
      const result = action()
      database.exec('COMMIT')
      return result
    } catch (error) {
      if (database.isTransaction) database.exec('ROLLBACK')
      throw error
    }
  }

  private removeUnsafeAttachmentRows(): void {
    const database = this.requireDatabase()
    const rows = database.prepare(`
      SELECT conversation_id, id, image_path
      FROM conversation_attachments
    `).all()
    const unsafe = rows.filter((row) => !isPathInside(this.imageDirectory, stringValue(row.image_path)))
    if (!unsafe.length) return
    const remove = database.prepare(
      'DELETE FROM conversation_attachments WHERE conversation_id = ? AND id = ?'
    )
    this.inTransaction(() => {
      for (const row of unsafe) remove.run(stringValue(row.conversation_id), stringValue(row.id))
      database.prepare(`
        UPDATE conversations
        SET has_screenshots = EXISTS (
          SELECT 1 FROM conversation_attachments a WHERE a.conversation_id = conversations.id
        )
      `).run()
    })
  }

  private async archiveAttachments(
    conversationId: string,
    sources: HistoryAttachmentSource[],
    existing: HistoryAttachment[]
  ): Promise<AttachmentArchive> {
    const retained: HistoryAttachment[] = []
    const copied: HistoryAttachment[] = []
    const seen = new Set<string>()
    for (const source of sources) {
      if (seen.has(source.id)) continue
      seen.add(source.id)
      const previous = existing.find((attachment) => attachment.id === source.id)
      if (previous && await fileExists(previous.imagePath)) {
        retained.push({ ...previous, edited: source.edited })
        continue
      }
      const candidateExtension = extname(basename(source.imagePath)).toLocaleLowerCase()
      const extension = ['.png', '.jpg', '.jpeg', '.webp'].includes(candidateExtension) ? candidateExtension : '.png'
      const destination = join(this.imageDirectory, `${safeFilePart(conversationId)}-${safeFilePart(source.id)}${extension}`)
      await copyFile(source.imagePath, destination)
      await chmod(destination, 0o600).catch(() => undefined)
      const attachment = { id: source.id, imagePath: destination, edited: source.edited }
      retained.push(attachment)
      copied.push(attachment)
    }
    const retainedIds = new Set(retained.map((attachment) => attachment.id))
    return {
      attachments: retained,
      copied,
      obsolete: existing.filter((attachment) => !retainedIds.has(attachment.id))
    }
  }

  private allAttachments(): HistoryAttachment[] {
    return this.requireDatabase().prepare(`
      SELECT id, image_path, edited
      FROM conversation_attachments
    `).all().map(attachmentFromRow)
  }

  private async deleteAttachmentFiles(attachments: HistoryAttachment[]): Promise<void> {
    await Promise.all(attachments.map(async (attachment) => {
      if (!isPathInside(this.imageDirectory, attachment.imagePath)) return
      await rm(attachment.imagePath, { force: true })
    }))
  }

  private requireDatabase(): DatabaseSync {
    if (!this.database) throw new Error('Conversation history store has not been initialised')
    return this.database
  }

  private async availableBackupPath(): Promise<string> {
    const preferred = `${this.legacyJsonPath}.migrated.bak`
    if (!await fileExists(preferred)) return preferred
    return `${this.legacyJsonPath}.migrated-${Date.now()}.bak`
  }
}

function migrate(value: unknown): StoredHistory {
  if (!value || typeof value !== 'object') return { conversations: [] }
  const candidate = value as { conversations?: unknown }
  const conversations = Array.isArray(candidate.conversations)
    ? candidate.conversations.filter(isConversationRecord).map(sanitizeRecord)
    : []
  return { conversations }
}

function isConversationRecord(value: unknown): value is ConversationHistoryRecord {
  if (!value || typeof value !== 'object') return false
  const record = value as Partial<ConversationHistoryRecord>
  return Boolean(
    typeof record.id === 'string' &&
    typeof record.title === 'string' &&
    typeof record.createdAt === 'string' &&
    typeof record.updatedAt === 'string' &&
    Array.isArray(record.exchanges) &&
    Array.isArray(record.segments)
  )
}

function sanitizeRecord(record: ConversationHistoryRecord): ConversationHistoryRecord {
  return {
    id: record.id.slice(0, 100),
    title: record.title.trim().slice(0, 160) || 'Saved conversation',
    createdAt: validIso(record.createdAt),
    updatedAt: validIso(record.updatedAt),
    exchanges: structuredClone(record.exchanges),
    segments: structuredClone(record.segments),
    selection: record.selection ? structuredClone(record.selection) : null,
    attachments: sanitizeAttachments(record.attachments)
  }
}

function sanitizeAttachments(value: unknown): HistoryAttachment[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const attachments: HistoryAttachment[] = []
  for (const attachment of value) {
    if (!attachment || typeof attachment !== 'object') continue
    const candidate = attachment as Partial<HistoryAttachment>
    if (typeof candidate.id !== 'string' || typeof candidate.imagePath !== 'string' || seen.has(candidate.id)) continue
    seen.add(candidate.id)
    attachments.push({ id: candidate.id, imagePath: candidate.imagePath, edited: candidate.edited === true })
  }
  return attachments
}

function searchableText(record: ConversationHistoryRecord): string {
  return [
    record.title,
    ...record.exchanges.flatMap((exchange) => [
      exchange.question,
      exchange.answer,
      exchange.metadata?.summary ?? ''
    ])
  ].join('\n').toLocaleLowerCase()
}

function attachmentFromRow(row: Record<string, SQLOutputValue>): HistoryAttachment {
  return {
    id: stringValue(row.id),
    imagePath: stringValue(row.image_path),
    edited: numberValue(row.edited) > 0
  }
}

function jsonArray<T>(value: string): T[] {
  const parsed = jsonValue<unknown>(value, [])
  return Array.isArray(parsed) ? parsed as T[] : []
}

function jsonValue<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function stringValue(value: SQLOutputValue | undefined): string {
  return typeof value === 'string' ? value : ''
}

function numberValue(value: SQLOutputValue | undefined): number {
  return typeof value === 'number' ? value : typeof value === 'bigint' ? Number(value) : 0
}

function ftsPhrase(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&')
}

function validIso(value: string): string {
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : new Date(0).toISOString()
}

function safeFilePart(value: string): string {
  return value.replace(/[^a-z0-9_-]/gi, '_').slice(0, 100)
}

function isPathInside(directory: string, path: string): boolean {
  const normalizedDirectory = directory.replace(/\//g, '\\').replace(/\\+$/, '').toLocaleLowerCase()
  const normalizedPath = path.replace(/\//g, '\\').toLocaleLowerCase()
  return normalizedPath.startsWith(`${normalizedDirectory}\\`)
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}
