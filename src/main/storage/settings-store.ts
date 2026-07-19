import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface AppSettings {
  selectedModelId: string | null
  launchAtLogin: boolean
}

const DEFAULTS: AppSettings = { selectedModelId: null, launchAtLogin: false }

export class SettingsStore {
  private value: AppSettings = { ...DEFAULTS }

  constructor(private readonly path: string) {}

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as Partial<AppSettings>
      this.value = {
        selectedModelId: typeof parsed.selectedModelId === 'string' ? parsed.selectedModelId : null,
        launchAtLogin: parsed.launchAtLogin === true
      }
    } catch {
      this.value = { ...DEFAULTS }
    }
  }

  get(): AppSettings {
    return { ...this.value }
  }

  async update(patch: Partial<AppSettings>): Promise<AppSettings> {
    this.value = { ...this.value, ...patch }
    await mkdir(dirname(this.path), { recursive: true })
    const temporary = `${this.path}.tmp`
    await writeFile(temporary, JSON.stringify(this.value, null, 2), 'utf8')
    await rename(temporary, this.path)
    return this.get()
  }
}
