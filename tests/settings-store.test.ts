import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SettingsStore } from '../src/main/storage/settings-store'

const roots: string[] = []

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

async function settingsPath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'fovea-settings-test-'))
  roots.push(root)
  return join(root, 'settings.v2.json')
}

describe('SettingsStore custom prompts', () => {
  it('persists custom prompts in their saved order', async () => {
    const path = await settingsPath()
    const store = new SettingsStore(path)
    await store.load()
    await store.update({
      customPrompts: [
        { id: 'first', label: 'Summarise', prompt: 'Summarise this in three bullets.' },
        { id: 'second', label: 'Translate', prompt: 'Translate the visible text into French.' }
      ]
    })

    const reloaded = new SettingsStore(path)
    await reloaded.load()
    expect(reloaded.get().customPrompts).toEqual([
      { id: 'first', label: 'Summarise', prompt: 'Summarise this in three bullets.' },
      { id: 'second', label: 'Translate', prompt: 'Translate the visible text into French.' }
    ])
    expect(JSON.parse(await readFile(path, 'utf8')).customPrompts).toHaveLength(2)
  })

  it('drops malformed, duplicate, and oversized custom prompts when loading', async () => {
    const path = await settingsPath()
    await writeFile(path, JSON.stringify({
      version: 2,
      customPrompts: [
        { id: 'valid', label: '  Review  ', prompt: '  Review this UI.  ' },
        { id: 'valid', label: 'Duplicate', prompt: 'This should be discarded.' },
        { id: 'empty', label: ' ', prompt: 'Question' },
        { id: 'oversized', label: 'Too long', prompt: 'x'.repeat(2_001) }
      ]
    }))

    const store = new SettingsStore(path)
    await store.load()
    expect(store.get().customPrompts).toEqual([
      { id: 'valid', label: 'Review', prompt: 'Review this UI.' }
    ])
  })
})

describe('SettingsStore onboarding status', () => {
  it('defaults fresh settings to pending', async () => {
    const path = await settingsPath()
    const store = new SettingsStore(path)
    await store.load()
    expect(store.get().onboardingStatus).toBe('pending')
  })

  it.each([
    [true, 'completed'],
    [false, 'pending']
  ] as const)('migrates legacy onboardingCompleted=%s to %s', async (onboardingCompleted, expected) => {
    const path = await settingsPath()
    await writeFile(path, JSON.stringify({
      version: 2,
      onboardingCompleted,
      customPrompts: [{ id: 'keep', label: 'Keep me', prompt: 'Preserve unrelated settings.' }]
    }))
    const store = new SettingsStore(path)
    await store.load()
    expect(store.get().onboardingStatus).toBe(expected)
    expect(store.get().customPrompts).toEqual([{ id: 'keep', label: 'Keep me', prompt: 'Preserve unrelated settings.' }])
  })

  it('persists terminal status without retaining the legacy boolean', async () => {
    const path = await settingsPath()
    const store = new SettingsStore(path)
    await store.load()
    await store.update({ onboardingStatus: 'skipped' })
    const saved = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    expect(saved.onboardingStatus).toBe('skipped')
    expect(saved).not.toHaveProperty('onboardingCompleted')

    const reloaded = new SettingsStore(path)
    await reloaded.load()
    expect(reloaded.get().onboardingStatus).toBe('skipped')
  })

  it('sanitizes an invalid status to pending', async () => {
    const path = await settingsPath()
    await writeFile(path, JSON.stringify({ version: 2, onboardingStatus: 'later' }))
    const store = new SettingsStore(path)
    await store.load()
    expect(store.get().onboardingStatus).toBe('pending')
  })
})

describe('SettingsStore history privacy', () => {
  it('migrates version 2 settings to private-safe history defaults', async () => {
    const path = await settingsPath()
    await writeFile(path, JSON.stringify({ version: 2, appearance: 'dark' }))
    const store = new SettingsStore(path)
    await store.load()

    expect(store.get()).toMatchObject({
      version: 3,
      appearance: 'dark',
      history: { privateMode: false, retentionDays: 30, retainScreenshots: false }
    })
  })

  it('sanitizes and persists history preferences', async () => {
    const path = await settingsPath()
    const store = new SettingsStore(path)
    await store.load()
    await store.update({ history: { privateMode: true, retentionDays: 90, retainScreenshots: true } })

    const reloaded = new SettingsStore(path)
    await reloaded.load()
    expect(reloaded.get().history).toEqual({ privateMode: true, retentionDays: 90, retainScreenshots: true })
  })
})
