import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type {
  ConversationExchange,
  ConversationHistorySummary,
  ConversationSegment,
  ConversationSelection
} from '@shared/types/app'

const STORE_VERSION = 1

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
  version: 1
  conversations: ConversationHistoryRecord[]
}

export class ConversationHistoryStore {
  private value: StoredHistory = { version: STORE_VERSION, conversations: [] }

  constructor(
    private readonly path: string,
    private readonly imageDirectory: string
  ) {}

  async initialise(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    await mkdir(this.imageDirectory, { recursive: true, mode: 0o700 })
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as unknown
      this.value = migrate(parsed)
      for (const conversation of this.value.conversations) {
        conversation.attachments = conversation.attachments.filter((attachment) => isPathInside(this.imageDirectory, attachment.imagePath))
      }
    } catch {
      this.value = { version: STORE_VERSION, conversations: [] }
    }
    await this.persist()
  }

  list(query = ''): ConversationHistorySummary[] {
    const needle = query.trim().toLocaleLowerCase()
    return this.value.conversations
      .filter((conversation) => !needle || searchableText(conversation).includes(needle))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map((conversation) => ({
        id: conversation.id,
        title: conversation.title,
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt,
        messageCount: conversation.exchanges.length,
        hasScreenshots: conversation.attachments.length > 0
      }))
  }

  get(id: string): ConversationHistoryRecord | null {
    const record = this.value.conversations.find((conversation) => conversation.id === id)
    return record ? structuredClone(record) : null
  }

  async upsert(
    record: Omit<ConversationHistoryRecord, 'attachments'>,
    sources: HistoryAttachmentSource[],
    retainScreenshots: boolean
  ): Promise<void> {
    const existing = this.value.conversations.find((conversation) => conversation.id === record.id)
    const attachments = retainScreenshots
      ? await this.archiveAttachments(record.id, sources, existing?.attachments ?? [])
      : []
    if (!retainScreenshots && existing) await this.deleteAttachmentFiles(existing.attachments)
    const next: ConversationHistoryRecord = {
      ...structuredClone(record),
      attachments
    }
    const index = this.value.conversations.findIndex((conversation) => conversation.id === record.id)
    if (index >= 0) this.value.conversations[index] = next
    else this.value.conversations.push(next)
    await this.persist()
  }

  async delete(id: string): Promise<boolean> {
    const index = this.value.conversations.findIndex((conversation) => conversation.id === id)
    if (index < 0) return false
    const [removed] = this.value.conversations.splice(index, 1)
    if (removed) await this.deleteAttachmentFiles(removed.attachments)
    await this.persist()
    return true
  }

  async clear(): Promise<number> {
    const removed = this.value.conversations
    this.value = { version: STORE_VERSION, conversations: [] }
    await Promise.all(removed.map((conversation) => this.deleteAttachmentFiles(conversation.attachments)))
    await this.persist()
    return removed.length
  }

  async applyRetention(retentionDays: number, now = Date.now()): Promise<number> {
    const cutoff = now - Math.max(1, retentionDays) * 24 * 60 * 60 * 1_000
    const expired = this.value.conversations.filter((conversation) => {
      const updated = Date.parse(conversation.updatedAt)
      return !Number.isFinite(updated) || updated < cutoff
    })
    if (!expired.length) return 0
    const expiredIds = new Set(expired.map((conversation) => conversation.id))
    this.value.conversations = this.value.conversations.filter((conversation) => !expiredIds.has(conversation.id))
    await Promise.all(expired.map((conversation) => this.deleteAttachmentFiles(conversation.attachments)))
    await this.persist()
    return expired.length
  }

  async removeAllScreenshots(): Promise<number> {
    const attachments = this.value.conversations.flatMap((conversation) => conversation.attachments)
    if (!attachments.length) return 0
    await this.deleteAttachmentFiles(attachments)
    for (const conversation of this.value.conversations) conversation.attachments = []
    await this.persist()
    return attachments.length
  }

  private async archiveAttachments(
    conversationId: string,
    sources: HistoryAttachmentSource[],
    existing: HistoryAttachment[]
  ): Promise<HistoryAttachment[]> {
    const retained: HistoryAttachment[] = []
    for (const source of sources) {
      const previous = existing.find((attachment) => attachment.id === source.id)
      if (previous && await fileExists(previous.imagePath)) {
        retained.push({ ...previous, edited: source.edited })
        continue
      }
      const extension = basename(source.imagePath).toLocaleLowerCase().endsWith('.png') ? '.png' : '.png'
      const destination = join(this.imageDirectory, `${safeFilePart(conversationId)}-${safeFilePart(source.id)}${extension}`)
      await copyFile(source.imagePath, destination)
      retained.push({ id: source.id, imagePath: destination, edited: source.edited })
    }
    const retainedIds = new Set(retained.map((attachment) => attachment.id))
    await this.deleteAttachmentFiles(existing.filter((attachment) => !retainedIds.has(attachment.id)))
    return retained
  }

  private async deleteAttachmentFiles(attachments: HistoryAttachment[]): Promise<void> {
    await Promise.all(attachments.map(async (attachment) => {
      if (!isPathInside(this.imageDirectory, attachment.imagePath)) return
      await rm(attachment.imagePath, { force: true })
    }))
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    const temporary = `${this.path}.tmp`
    await writeFile(temporary, JSON.stringify(this.value, null, 2), { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, this.path)
  }
}

function migrate(value: unknown): StoredHistory {
  if (!value || typeof value !== 'object') return { version: STORE_VERSION, conversations: [] }
  const candidate = value as { version?: unknown; conversations?: unknown }
  const conversations = Array.isArray(candidate.conversations)
    ? candidate.conversations.filter(isConversationRecord).map(sanitizeRecord)
    : []
  return { version: STORE_VERSION, conversations }
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
    attachments: Array.isArray(record.attachments)
      ? record.attachments.filter((attachment) => (
          attachment &&
          typeof attachment.id === 'string' &&
          typeof attachment.imagePath === 'string'
        )).map((attachment) => ({ ...attachment, edited: attachment.edited === true }))
      : []
  }
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

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}
