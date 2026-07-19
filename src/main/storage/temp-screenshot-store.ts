import { randomUUID } from 'node:crypto'
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export class TempScreenshotStore {
  constructor(readonly directory: string) {}

  async initialise(): Promise<void> {
    await mkdir(this.directory, { recursive: true })
  }

  async save(png: Buffer): Promise<string> {
    await this.initialise()
    const path = join(this.directory, `snip-${Date.now()}-${randomUUID()}.png`)
    await writeFile(path, png, { mode: 0o600 })
    return path
  }

  async delete(path: string): Promise<void> {
    if (!this.isOwnedPath(path)) return
    await rm(path, { force: true })
  }

  async cleanup(olderThanMs = 0): Promise<number> {
    await this.initialise()
    const now = Date.now()
    let removed = 0
    for (const entry of await readdir(this.directory, { withFileTypes: true })) {
      if (!entry.isFile() || !/^snip-.*\.png$/i.test(entry.name)) continue
      const path = join(this.directory, entry.name)
      if (olderThanMs > 0) {
        const metadata = await stat(path)
        if (now - metadata.mtimeMs < olderThanMs) continue
      }
      await rm(path, { force: true })
      removed++
    }
    return removed
  }

  private isOwnedPath(path: string): boolean {
    const prefix = this.directory.endsWith('\\') ? this.directory : `${this.directory}\\`
    return path.toLowerCase().startsWith(prefix.toLowerCase())
  }
}
