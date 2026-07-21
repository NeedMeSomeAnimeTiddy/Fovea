import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface SecretCryptography {
  isAsyncEncryptionAvailable(): Promise<boolean>
  encryptStringAsync(value: string): Promise<Buffer>
  decryptStringAsync(value: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }>
}

export class CredentialStore {
  private encrypted = new Map<string, string>()

  constructor(
    private readonly path: string,
    private readonly cryptography: SecretCryptography
  ) {}

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as Record<string, unknown>
      this.encrypted = new Map(
        Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
      )
    } catch {
      this.encrypted.clear()
    }
  }

  async set(reference: string, secret: string): Promise<void> {
    if (!reference || !secret) throw new Error('A credential reference and secret are required.')
    if (!(await this.cryptography.isAsyncEncryptionAvailable())) {
      throw new Error('Windows credential encryption is unavailable.')
    }
    const encrypted = await this.cryptography.encryptStringAsync(secret)
    const previous = this.encrypted.get(reference)
    this.encrypted.set(reference, encrypted.toString('base64'))
    try {
      await this.persist()
    } catch (error) {
      if (previous === undefined) this.encrypted.delete(reference)
      else this.encrypted.set(reference, previous)
      throw error
    }
  }

  async get(reference: string): Promise<string> {
    const encoded = this.encrypted.get(reference)
    if (!encoded) throw new Error('This profile has no stored credential.')
    const decrypted = await this.cryptography.decryptStringAsync(Buffer.from(encoded, 'base64'))
    if (decrypted.shouldReEncrypt) await this.set(reference, decrypted.result)
    return decrypted.result
  }

  async delete(reference: string): Promise<void> {
    const previous = this.encrypted.get(reference)
    if (previous === undefined) return
    this.encrypted.delete(reference)
    try {
      await this.persist()
    } catch (error) {
      this.encrypted.set(reference, previous)
      throw error
    }
  }

  has(reference: string): boolean {
    return this.encrypted.has(reference)
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    const temporary = `${this.path}.tmp`
    await writeFile(temporary, JSON.stringify(Object.fromEntries(this.encrypted), null, 2), 'utf8')
    await rename(temporary, this.path)
  }
}
