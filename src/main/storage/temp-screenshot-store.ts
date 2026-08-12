import { randomUUID } from 'node:crypto'
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

const MANAGED_SCREENSHOT_NAME = /^snip-[^\\/]+\.(?:png|jpe?g|webp)$/i

export class TempScreenshotStore {
  private readonly activePaths = new Set<string>()

  constructor(readonly directory: string) {}

  async initialise(): Promise<void> {
    await mkdir(this.directory, { recursive: true })
  }

  async save(png: Buffer): Promise<string> {
    return this.saveImage(png, 'png')
  }

  async saveImage(image: Buffer, extension: 'png' | 'jpg' | 'webp'): Promise<string> {
    await this.initialise()
    const path = join(this.directory, `snip-${Date.now()}-${randomUUID()}.${extension}`)
    await writeFile(path, image, { mode: 0o600 })
    this.activePaths.add(this.pathKey(path))
    return path
  }

  async delete(path: string): Promise<void> {
    const managedPath = this.managedPath(path)
    if (!managedPath) return
    await rm(managedPath, { force: true })
    this.activePaths.delete(this.pathKey(managedPath))
  }

  /**
   * Startup calls this before the tray appears, and a busy session can leave hundreds of files
   * behind, so each candidate is settled concurrently rather than one round trip at a time.
   */
  async cleanup(olderThanMs = 0, options: { preserveActive?: boolean } = {}): Promise<number> {
    await this.initialise()
    const now = Date.now()
    const entries = await readdir(this.directory, { withFileTypes: true })
    const candidates = entries.flatMap((entry) => {
      if (!entry.isFile() || !MANAGED_SCREENSHOT_NAME.test(entry.name)) return []
      const path = join(this.directory, entry.name)
      return options.preserveActive && this.activePaths.has(this.pathKey(path)) ? [] : [path]
    })
    const removals = await Promise.all(candidates.map(async (path) => {
      if (olderThanMs > 0) {
        const metadata = await stat(path)
        if (now - metadata.mtimeMs < olderThanMs) return false
      }
      await rm(path, { force: true })
      this.activePaths.delete(this.pathKey(path))
      return true
    }))
    return removals.filter(Boolean).length
  }

  private managedPath(path: string): string | null {
    const directory = resolve(this.directory)
    const candidate = resolve(path)
    const child = relative(directory, candidate)

    const isManaged = (
      child !== '' &&
      child !== '..' &&
      !child.startsWith(`..${sep}`) &&
      !isAbsolute(child) &&
      dirname(child) === '.' &&
      basename(child) === child &&
      MANAGED_SCREENSHOT_NAME.test(child)
    )
    return isManaged ? candidate : null
  }

  private pathKey(path: string): string {
    const canonicalPath = resolve(path)
    return process.platform === 'win32' ? canonicalPath.toLowerCase() : canonicalPath
  }
}
