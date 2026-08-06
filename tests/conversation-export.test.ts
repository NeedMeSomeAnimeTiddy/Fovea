import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConversationExportRecord } from '../src/main/export/conversation-export-service'

const { showSaveDialog } = vi.hoisted(() => ({ showSaveDialog: vi.fn() }))
vi.mock('electron', () => ({ dialog: { showSaveDialog } }))

import {
  conversationExportPreview,
  exportConversation,
  jsonExport,
  markdownExport
} from '../src/main/export/conversation-export-service'

const roots: string[] = []

afterEach(async () => {
  showSaveDialog.mockReset()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function record(imagePath = 'C:/private/session-image.png'): ConversationExportRecord {
  return {
    id: 'conversation-1',
    title: 'Release review',
    createdAt: '2026-08-04T10:00:00.000Z',
    updatedAt: '2026-08-04T10:01:00.000Z',
    selection: { profileId: 'secret-profile-id', provider: 'openai', modelId: 'gpt-5', reasoningEffort: 'medium' },
    segments: [{
      id: 'segment-1',
      startedAt: '2026-08-04T10:00:00.000Z',
      selection: { profileId: 'secret-profile-id', provider: 'openai', modelId: 'gpt-5', reasoningEffort: 'medium' },
      disclosure: 'Using OpenAI.'
    }],
    exchanges: [{
      id: 'exchange-1',
      question: 'Explain this code:',
      answer: '```ts\nconst answer = 42\n```',
      phase: 'completed',
      segmentId: 'segment-1',
      createdAt: '2026-08-04T10:00:02.000Z',
      completedAt: '2026-08-04T10:00:04.000Z',
      attachmentIds: ['attachment-1']
    }],
    attachments: [{ id: 'attachment-1', imagePath, edited: false, ocr: null }]
  }
}

describe('conversation export', () => {
  it('returns without creating output when the save dialog is cancelled', async () => {
    showSaveDialog.mockResolvedValue({ canceled: true })
    await expect(exportConversation(undefined, record(), {
      format: 'markdown', includeScreenshots: true, includeProviderMetadata: true
    })).resolves.toBe(false)
  })

  it('keeps provider identity and internal paths private by default', () => {
    const options = { format: 'json' as const, includeScreenshots: false, includeProviderMetadata: false }
    const json = JSON.stringify(jsonExport(record(), options))
    expect(json).not.toContain('secret-profile-id')
    expect(json).not.toContain('C:/private')
    expect(json).not.toContain('openai')
    expect(json).toContain('"schemaVersion":1')
    expect(conversationExportPreview(record())).toMatchObject({ messageCount: 1, screenshotCount: 1 })
  })

  it('preserves Markdown code fences and adds provider metadata only when selected', () => {
    const hidden = markdownExport(record(), { format: 'markdown', includeScreenshots: false, includeProviderMetadata: false })
    const visible = markdownExport(record(), { format: 'markdown', includeScreenshots: false, includeProviderMetadata: true })
    expect(hidden).toContain('```ts\nconst answer = 42\n```')
    expect(hidden).not.toContain('gpt-5')
    expect(visible).toContain('openai · gpt-5 · medium reasoning')
    expect(visible).not.toContain('secret-profile-id')
  })

  it('writes the transcript last with deterministic sidecar asset names', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fovea-export-test-'))
    roots.push(root)
    const source = join(root, 'source.png')
    await writeFile(source, 'image-data')
    const destination = join(root, 'My export.md')
    showSaveDialog.mockResolvedValue({ canceled: false, filePath: destination })

    await expect(exportConversation(undefined, record(source), {
      format: 'markdown', includeScreenshots: true, includeProviderMetadata: false
    })).resolves.toBe(true)
    await expect(readFile(destination, 'utf8')).resolves.toContain('My-export-assets/image-001.png')
    await expect(readFile(join(root, 'My-export-assets', 'image-001.png'), 'utf8')).resolves.toBe('image-data')
  })

  it('atomically replaces an existing transcript after save-dialog overwrite confirmation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fovea-export-test-'))
    roots.push(root)
    const destination = join(root, 'existing.md')
    await writeFile(destination, 'previous export')
    showSaveDialog.mockResolvedValue({ canceled: false, filePath: destination })

    await expect(exportConversation(undefined, record(), {
      format: 'markdown', includeScreenshots: false, includeProviderMetadata: false
    })).resolves.toBe(true)
    const exported = await readFile(destination, 'utf8')
    expect(exported).toContain('# Release review')
    expect(exported).not.toContain('previous export')
  })

  it('leaves no document or asset folder when attachment copying fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fovea-export-test-'))
    roots.push(root)
    const destination = join(root, 'failed.md')
    showSaveDialog.mockResolvedValue({ canceled: false, filePath: destination })

    await expect(exportConversation(undefined, record(join(root, 'missing.png')), {
      format: 'markdown', includeScreenshots: true, includeProviderMetadata: false
    })).rejects.toThrow()
    await expect(readFile(destination)).rejects.toThrow()
    await expect(readFile(join(root, 'failed-assets', 'image-001.png'))).rejects.toThrow()
  })
})
