import { dialog, type BrowserWindow, type SaveDialogOptions } from 'electron'
import { copyFile, mkdir, mkdtemp, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import type {
  ConversationExchange,
  ConversationExportOptions,
  ConversationExportPreview,
  ConversationSegment,
  ConversationSelection,
  OcrResult
} from '@shared/types/app'

export interface ExportAttachment {
  id: string
  imagePath: string
  edited: boolean
  ocr?: OcrResult | null
}

export interface ConversationExportRecord {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  exchanges: ConversationExchange[]
  segments: ConversationSegment[]
  selection: ConversationSelection | null
  attachments: ExportAttachment[]
}

export function conversationExportPreview(record: ConversationExportRecord): ConversationExportPreview {
  const transcript = record.exchanges.flatMap((exchange) => [exchange.question, exchange.answer]).filter(Boolean).join('\n')
  return {
    title: record.title,
    messageCount: record.exchanges.length,
    screenshotCount: record.attachments.length,
    ocrCharacterCount: record.exchanges.filter((exchange) => exchange.source === 'ocr').reduce((total, exchange) => total + exchange.answer.length, 0) + record.attachments.reduce((total, attachment) => total + (attachment.ocr?.text.length ?? 0), 0),
    providerTransitionCount: record.segments.length,
    excerpt: transcript.replace(/\s+/g, ' ').trim().slice(0, 500)
  }
}

export async function exportConversation(
  owner: BrowserWindow | undefined,
  record: ConversationExportRecord,
  options: ConversationExportOptions
): Promise<boolean> {
  const extension = options.format === 'json' ? 'json' : 'md'
  const dialogOptions: SaveDialogOptions = {
    title: 'Export conversation',
    defaultPath: `${safeFilePart(record.title) || 'fovea-conversation'}.${extension}`,
    filters: [{ name: options.format === 'json' ? 'Fovea JSON export' : 'Markdown', extensions: [extension] }]
  }
  const selected = owner ? await dialog.showSaveDialog(owner, dialogOptions) : await dialog.showSaveDialog(dialogOptions)
  if (selected.canceled || !selected.filePath) return false
  const destination = withExtension(selected.filePath, extension)
  const destinationDirectory = dirname(destination)
  const base = basename(destination, extname(destination))
  const assetsName = `${safeFilePart(base) || 'conversation'}-assets`
  const assetsDestination = join(destinationDirectory, assetsName)
  if (options.includeScreenshots && record.attachments.length && await exists(assetsDestination)) {
    throw new Error('The export asset folder already exists. Choose a different filename or remove the existing export first.')
  }

  await mkdir(destinationDirectory, { recursive: true })
  const staging = await mkdtemp(join(destinationDirectory, '.fovea-export-'))
  let movedAssets = false
  let movedPreviousDocument = false
  const previousDocument = join(staging, '.previous-document')
  try {
    const attachmentFiles = new Map<string, string>()
    if (options.includeScreenshots && record.attachments.length) {
      const stagingAssets = join(staging, assetsName)
      await mkdir(stagingAssets)
      const copied = await Promise.all(record.attachments.map(async (attachment, index) => {
        const extension = safeImageExtension(attachment.imagePath)
        const file = `image-${String(index + 1).padStart(3, '0')}${extension}`
        await copyFile(attachment.imagePath, join(stagingAssets, file))
        return [attachment.id, `${assetsName}/${file}`] as const
      }))
      // Numbering stays tied to the attachment's own index, so concurrency cannot reorder it.
      for (const [id, file] of copied) attachmentFiles.set(id, file)
    }
    const content = options.format === 'json'
      ? JSON.stringify(jsonExport(record, options, attachmentFiles), null, 2)
      : markdownExport(record, options, attachmentFiles)
    const stagedDocument = join(staging, basename(destination))
    await writeFile(stagedDocument, content, { encoding: 'utf8', mode: 0o600 })
    if (attachmentFiles.size) {
      await rename(join(staging, assetsName), assetsDestination)
      movedAssets = true
    }
    if (await exists(destination)) {
      await rename(destination, previousDocument)
      movedPreviousDocument = true
    }
    await rename(stagedDocument, destination)
    await rm(staging, { recursive: true, force: true }).catch(() => undefined)
    return true
  } catch (error) {
    if (movedPreviousDocument && !await exists(destination)) {
      await rename(previousDocument, destination).catch(() => undefined)
    }
    if (movedAssets) await rm(assetsDestination, { recursive: true, force: true }).catch(() => undefined)
    await rm(staging, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
}

export function markdownExport(
  record: ConversationExportRecord,
  options: ConversationExportOptions,
  attachmentFiles = new Map<string, string>()
): string {
  const segmentById = new Map(record.segments.map((segment) => [segment.id, segment]))
  const lines = [
    `# ${escapeHeading(record.title)}`,
    '',
    `Created: ${formatTimestamp(record.createdAt)}`,
    `Updated: ${formatTimestamp(record.updatedAt)}`,
    ''
  ]
  let previousSegment = ''
  for (const [index, exchange] of record.exchanges.entries()) {
    if (exchange.segmentId !== previousSegment) {
      previousSegment = exchange.segmentId
      const segment = segmentById.get(exchange.segmentId)
      lines.push('---', '')
      if (options.includeProviderMetadata && segment) {
        lines.push(`Provider context: ${segment.selection.provider} · ${segment.selection.modelId}${segment.selection.reasoningEffort ? ` · ${segment.selection.reasoningEffort} reasoning` : ''}`, '')
      } else if (index > 0) lines.push('Provider context changed.', '')
      if (segment?.disclosure) lines.push(segment.disclosure, '')
    }
    lines.push(`## ${exchange.source === 'ocr' ? 'Local OCR' : exchange.retryOf ? 'Retry' : exchange.automatic ? 'Automatic request' : 'Question'}`, '')
    lines.push(`Started: ${exchange.createdAt ? formatTimestamp(exchange.createdAt) : 'Unavailable (legacy record)'}`)
    lines.push(`Completed: ${exchange.completedAt ? formatTimestamp(exchange.completedAt) : 'Unavailable (legacy record)'}`, '')
    lines.push(exchange.question, '')
    if (exchange.attachmentIds?.length) {
      for (const id of exchange.attachmentIds) {
        const file = attachmentFiles.get(id)
        if (file) lines.push(`![Attached image](${encodeURI(file)})`, '')
      }
    }
    lines.push('### Response', '', exchange.answer || '_No response text._', '')
    if (exchange.error) lines.push(`Exported status: ${exchange.error.title} — ${exchange.error.message}`, '')
  }
  const attachmentOcr = record.attachments.filter((attachment) => attachment.ocr?.text)
  if (attachmentOcr.length) {
    lines.push('---', '', '## Local OCR details', '')
    for (const [index, attachment] of attachmentOcr.entries()) {
      lines.push(`### Image ${index + 1}`, '', '```text', attachment.ocr!.text.replaceAll('```', '``\u200b`'), '```', '')
    }
  }
  return `${lines.join('\n').trim()}\n`
}

export function jsonExport(
  record: ConversationExportRecord,
  options: ConversationExportOptions,
  attachmentFiles = new Map<string, string>()
): Record<string, unknown> {
  const includeProviders = options.includeProviderMetadata
  return {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    conversation: {
      id: record.id,
      title: record.title,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      ...(includeProviders && record.selection ? { selection: publicSelection(record.selection) } : {}),
      segments: record.segments.map((segment) => ({
        id: segment.id,
        startedAt: segment.startedAt,
        disclosure: segment.disclosure,
        ...(includeProviders ? { selection: publicSelection(segment.selection) } : {})
      })),
      exchanges: record.exchanges.map((exchange) => ({
        id: exchange.id,
        question: exchange.question,
        answer: exchange.answer,
        phase: exchange.phase,
        segmentId: exchange.segmentId,
        createdAt: exchange.createdAt ?? null,
        completedAt: exchange.completedAt ?? null,
        source: exchange.source ?? 'ai',
        automatic: exchange.automatic === true,
        retryOf: exchange.retryOf ?? null,
        attachmentIds: exchange.attachmentIds ?? [],
        ocr: exchange.ocr ? structuredClone(exchange.ocr) : null,
        webSearch: exchange.webSearch ? { query: exchange.webSearch.query, status: exchange.webSearch.status } : null,
        error: exchange.error ? { code: exchange.error.code, title: exchange.error.title, message: exchange.error.message } : null
      })),
      attachments: record.attachments.map((attachment) => ({
        id: attachment.id,
        edited: attachment.edited,
        file: attachmentFiles.get(attachment.id) ?? null,
        ocr: attachment.ocr ? structuredClone(attachment.ocr) : null
      }))
    }
  }
}

function publicSelection(selection: ConversationSelection): Record<string, unknown> {
  return { provider: selection.provider, modelId: selection.modelId, reasoningEffort: selection.reasoningEffort }
}

function safeFilePart(value: string): string {
  const printable = [...value].map((character) => character.charCodeAt(0) < 32 ? ' ' : character).join('')
  return printable.replace(/[<>:"/\\|?*]/g, ' ').replace(/[. ]+$/g, '').replace(/\s+/g, '-').slice(0, 100)
}

function withExtension(path: string, extension: string): string {
  return extname(path).toLocaleLowerCase() === `.${extension}` ? path : `${path}.${extension}`
}

function safeImageExtension(path: string): string {
  const extension = extname(path).toLocaleLowerCase()
  return ['.png', '.jpg', '.jpeg', '.webp'].includes(extension) ? extension : '.png'
}

function escapeHeading(value: string): string { return value.replace(/[\r\n]+/g, ' ').replace(/^#+\s*/, '') }
function formatTimestamp(value: string): string { const date = new Date(value); return Number.isNaN(date.getTime()) ? value : date.toISOString() }
async function exists(path: string): Promise<boolean> { try { await stat(path); return true } catch { return false } }
