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

describe('SettingsStore custom provider profiles', () => {
  const customProfile = {
    id: 'custom-1',
    name: 'DeepSeek',
    provider: 'custom',
    authentication: 'api-key',
    baseUrl: 'https://api.deepseek.com/v1/',
    modelIds: ['deepseek-v4-flash', 'deepseek-v4-flash', ''],
    defaultModelId: null,
    defaultReasoningEffort: null,
    health: 'unknown'
  }

  it('keeps a custom profile and tidies its address and model list', async () => {
    const path = await settingsPath()
    await writeFile(path, JSON.stringify({ version: 3, profiles: [customProfile] }))
    const store = new SettingsStore(path)
    await store.load()

    const [profile] = store.get().profiles
    expect(profile?.baseUrl).toBe('https://api.deepseek.com/v1')
    expect(profile?.modelIds).toEqual(['deepseek-v4-flash'])
  })

  it('drops a custom profile whose address could never be reached', async () => {
    const path = await settingsPath()
    await writeFile(path, JSON.stringify({
      version: 3,
      profiles: [
        { ...customProfile, id: 'no-url', baseUrl: undefined },
        { ...customProfile, id: 'plaintext', baseUrl: 'http://api.deepseek.com/v1' },
        { ...customProfile, id: 'nonsense', baseUrl: 'not a url' }
      ]
    }))
    const store = new SettingsStore(path)
    await store.load()

    expect(store.get().profiles).toEqual([])
  })

  it('does not let a built-in profile carry an address of its own', async () => {
    const path = await settingsPath()
    await writeFile(path, JSON.stringify({
      version: 3,
      profiles: [{ ...customProfile, id: 'openai-1', provider: 'openai', baseUrl: 'https://evil.example/v1', modelIds: ['x'] }]
    }))
    const store = new SettingsStore(path)
    await store.load()

    const [profile] = store.get().profiles
    expect(profile?.provider).toBe('openai')
    expect(profile?.baseUrl).toBeUndefined()
    expect(profile?.modelIds).toBeUndefined()
  })
})

describe('SettingsStore Explorer integration', () => {
  it('defaults to off and survives a round trip', async () => {
    const path = await settingsPath()
    const store = new SettingsStore(path)
    await store.load()
    expect(store.get().shellIntegrationEnabled).toBe(false)

    await store.update({ shellIntegrationEnabled: true })
    const reloaded = new SettingsStore(path)
    await reloaded.load()
    expect(reloaded.get().shellIntegrationEnabled).toBe(true)
  })

  it('treats a settings file written before this feature as off', async () => {
    const path = await settingsPath()
    // A version-3 file from an older build simply has no such key.
    await writeFile(path, JSON.stringify({ version: 3, launchAtLogin: true }))
    const store = new SettingsStore(path)
    await store.load()
    expect(store.get().shellIntegrationEnabled).toBe(false)
    expect(store.get().launchAtLogin).toBe(true)
  })

  it('rejects a non-boolean value from a tampered file', async () => {
    const path = await settingsPath()
    await writeFile(path, JSON.stringify({ version: 3, shellIntegrationEnabled: 'yes' }))
    const store = new SettingsStore(path)
    await store.load()
    expect(store.get().shellIntegrationEnabled).toBe(false)
  })
})

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

describe('SettingsStore OCR language preference', () => {
  it('persists a valid selected language and defaults invalid values to automatic', async () => {
    const path = await settingsPath()
    const store = new SettingsStore(path)
    await store.load()
    await store.update({ ocrLanguageCode: 'ja-JP' })

    const reloaded = new SettingsStore(path)
    await reloaded.load()
    expect(reloaded.get().ocrLanguageCode).toBe('ja-JP')

    await writeFile(path, JSON.stringify({ version: 3, ocrLanguageCode: '../unsafe' }))
    await reloaded.load()
    expect(reloaded.get().ocrLanguageCode).toBe('')
  })
})
