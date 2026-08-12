import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CredentialStore, type SecretCryptography } from '../src/main/storage/credential-store'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  vi.restoreAllMocks()
})

class FakeCryptography implements SecretCryptography {
  async isAsyncEncryptionAvailable(): Promise<boolean> { return true }
  async encryptStringAsync(value: string): Promise<Buffer> { return Buffer.from(`encrypted:${value}`) }
  async decryptStringAsync(value: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }> {
    return { result: value.toString().replace('encrypted:', ''), shouldReEncrypt: false }
  }
}

describe('CredentialStore corruption recovery', () => {
  it('preserves the whole credential document when any entry is structurally invalid', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fovea-credentials-test-'))
    roots.push(root)
    const path = join(root, 'credentials.json')
    const corrupt = JSON.stringify({ usable: 'encrypted:value', damaged: 42 })
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await writeFile(path, corrupt)

    const store = new CredentialStore(path, new FakeCryptography())
    await store.load()

    expect(store.has('usable')).toBe(false)
    await expect(readFile(`${path}.corrupt.bak`, 'utf8')).resolves.toBe(corrupt)
    await expect(readFile(path, 'utf8')).rejects.toThrow()
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('.corrupt.bak'))

    await store.set('replacement', 'new secret')
    expect(await store.get('replacement')).toBe('new secret')
    await expect(readFile(`${path}.corrupt.bak`, 'utf8')).resolves.toBe(corrupt)
  })
})
