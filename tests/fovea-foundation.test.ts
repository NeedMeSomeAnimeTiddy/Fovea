import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { CredentialStore, type SecretCryptography } from '../src/main/storage/credential-store'
import { SettingsStore } from '../src/main/storage/settings-store'
import { ProfileManager } from '../src/main/providers/profile-manager'
import { ShortcutManager, type ShortcutRegistrar } from '../src/main/shortcuts/shortcut-manager'
import { DirectApiProvider } from '../src/main/providers/direct-api-provider'
import { parseSse } from '../src/main/providers/sse'

class FakeCryptography implements SecretCryptography {
  reEncrypt = false
  async isAsyncEncryptionAvailable(): Promise<boolean> { return true }
  async encryptStringAsync(value: string): Promise<Buffer> { return Buffer.from(`protected:${Buffer.from(value).toString('base64')}`) }
  async decryptStringAsync(value: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }> { return { result: Buffer.from(value.toString().replace('protected:', ''), 'base64').toString(), shouldReEncrypt: this.reEncrypt } }
}

async function stores(): Promise<{ settings: SettingsStore; credentials: CredentialStore; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'fovea-foundation-'))
  const settings = new SettingsStore(join(root, 'settings.json')); const credentials = new CredentialStore(join(root, 'credentials.json'), new FakeCryptography())
  await Promise.all([settings.load(), credentials.load()]); return { settings, credentials, root }
}

describe('Fovea secure profile foundation', () => {
  it('encrypts credentials separately and never writes plaintext to either document', async () => {
    const { settings, credentials, root } = await stores(); const manager = new ProfileManager(settings, credentials)
    const profile = await manager.createApiKey('openai', 'Work API', 'sk-super-secret')
    expect(await credentials.get(profile.id)).toBe('sk-super-secret')
    expect(await readFile(join(root, 'credentials.json'), 'utf8')).not.toContain('sk-super-secret')
    expect(await readFile(join(root, 'settings.json'), 'utf8')).not.toContain('sk-super-secret')
    expect(manager.list()[0]).not.toHaveProperty('credentialRef')
  })

  it('supports multiple BYOK profiles, one ChatGPT profile, and deterministic default reassignment', async () => {
    const { settings, credentials } = await stores(); const manager = new ProfileManager(settings, credentials)
    const first = await manager.createApiKey('openai', 'OpenAI', 'key-one'); const second = await manager.createApiKey('anthropic', 'Claude', 'key-two')
    expect(manager.list()).toHaveLength(2); expect(manager.list().find((item) => item.id === first.id)?.isDefault).toBe(true)
    await manager.setDefault(second.id); expect(manager.list().find((item) => item.id === second.id)?.isDefault).toBe(true)
    await manager.createChatGpt(); await expect(manager.createChatGpt('Another')).rejects.toThrow(/one ChatGPT/i)
    await manager.delete(second.id); expect(manager.list().some((item) => item.id === second.id)).toBe(false)
  })

  it('defaults fresh settings to light appearance and the documented region shortcut', async () => {
    const { settings } = await stores(); expect(settings.get().appearance).toBe('light'); expect(settings.get().shortcuts.region).toBe('CommandOrControl+Alt+Shift+Space')
  })
})

describe('provider normalisation and SSE', () => {
  it('keeps only confirmed image-capable direct-provider models', async () => {
    const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => { void input; void init; return new Response(JSON.stringify({ data: [{ id: 'gpt-5' }, { id: 'whisper-1' }] }), { status: 200 }) })
    const provider = new DirectApiProvider('openai', request as typeof fetch); const models = await provider.listModels('secret')
    expect(models.map((model) => model.id)).toEqual(['gpt-5']); expect(models[0]?.supportedReasoningEfforts).toEqual(['low', 'medium', 'high'])
    expect(request.mock.calls[0]?.[1]?.headers).toMatchObject({ authorization: 'Bearer secret' })
  })

  it('normalises fragmented SSE events without delaying complete deltas', async () => {
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('event: delta\ndata: {"text":"hel')); controller.enqueue(new TextEncoder().encode('lo"}\n\n')); controller.close() } })
    const events = []
    for await (const event of parseSse(new Response(stream))) events.push(event)
    expect(events).toEqual([{ event: 'delta', data: '{"text":"hello"}' }])
  })
})

describe('independent shortcut registration', () => {
  it('identifies internal and OS conflicts without disturbing registered actions', async () => {
    const { settings } = await stores(); const active = new Set<string>()
    const registrar: ShortcutRegistrar = { register: vi.fn((accelerator) => accelerator !== 'Ctrl+X' && (active.add(accelerator), true)), unregister: vi.fn((accelerator) => { active.delete(accelerator) }) }
    const handler = (): void => undefined
    const manager = new ShortcutManager(registrar, settings, { region: handler, display: handler, window: handler, 'repeat-last': handler, settings: handler })
    manager.initialise(); expect(active.has('CommandOrControl+Alt+Shift+Space')).toBe(true)
    await expect(manager.reset()).resolves.toBeUndefined()
    await expect(manager.set('display', 'CommandOrControl+Alt+Shift+Space')).rejects.toThrow(/already assigned to region/)
    await expect(manager.set('display', 'Ctrl+X')).rejects.toThrow(/display is unavailable/)
    expect(active.has('CommandOrControl+Alt+Shift+Space')).toBe(true)
    await manager.set('display', 'Ctrl+D'); expect(active.has('Ctrl+D')).toBe(true)
    await expect(manager.set('display', null)).resolves.toBeUndefined()
    expect(active.has('Ctrl+D')).toBe(false)
    await manager.set('display', 'Ctrl+D')
    manager.pause(); expect(active.size).toBe(0); manager.resume(); expect(active.size).toBe(2)
  })

  it('resets all bindings atomically and restores registrations when persistence fails', async () => {
    const { settings } = await stores()
    await settings.update({ shortcuts: { region: 'Ctrl+R', display: null, window: 'CommandOrControl+Alt+Shift+Space', 'repeat-last': null, settings: null } })
    const active = new Set<string>()
    const registrar: ShortcutRegistrar = {
      register: vi.fn((accelerator) => {
        if (active.has(accelerator)) return false
        active.add(accelerator)
        return true
      }),
      unregister: vi.fn((accelerator) => { active.delete(accelerator) })
    }
    const handler = (): void => undefined
    const manager = new ShortcutManager(registrar, settings, { region: handler, display: handler, window: handler, 'repeat-last': handler, settings: handler })
    manager.initialise()
    const persistence = vi.spyOn(settings, 'update').mockRejectedValueOnce(new Error('disk unavailable'))
    await expect(manager.reset()).rejects.toThrow(/disk unavailable/)
    expect(active).toEqual(new Set(['Ctrl+R', 'CommandOrControl+Alt+Shift+Space']))
    expect(settings.get().shortcuts.region).toBe('Ctrl+R')
    persistence.mockRestore()
    await manager.reset()
    expect(active).toEqual(new Set(['CommandOrControl+Alt+Shift+Space']))
    expect(settings.get().shortcuts).toEqual({ region: 'CommandOrControl+Alt+Shift+Space', display: null, window: null, 'repeat-last': null, settings: null })
  })
})
