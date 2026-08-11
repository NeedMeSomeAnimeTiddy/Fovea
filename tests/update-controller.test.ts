import type { AppUpdater } from 'electron-updater'
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import {
  UpdateController,
  type UpdateAdapter,
  type UpdateAdapterEvent,
  type UpdateAdapterListener,
  type UpdatePreferences
} from '../src/main/updates/update-controller'
import type { UpdateReleaseMarker } from '../src/shared/types/update'

const RELEASE_MARKER: UpdateReleaseMarker = {
  schemaVersion: 1,
  enabled: true,
  provider: 'github',
  repository: 'NeedMeSomeAnimeTiddy/Fovea',
  channel: 'latest',
  architectures: ['x64'],
  publisherName: 'Fovea Test Publisher',
  integrity: 'sha512-and-authenticode',
  installMode: 'user-confirmed'
}

class FakeUpdater implements UpdateAdapter {
  autoDownload = true
  autoInstallOnAppQuit = true
  autoRunAppAfterInstall = false
  allowPrerelease = true
  allowDowngrade = true
  disableWebInstaller = false
  forceDevUpdateConfig = true
  fullChangelog = false
  readonly checkForUpdates = vi.fn(async () => { await this.onCheck?.(); return null })
  readonly downloadUpdate = vi.fn(async () => { await this.onDownload?.(); return [] })
  readonly quitAndInstall = vi.fn((isSilent?: boolean, isForceRunAfter?: boolean) => {
    void isSilent
    void isForceRunAfter
  })
  onCheck: (() => void | Promise<void>) | null = null
  onDownload: (() => void | Promise<void>) | null = null
  private readonly listeners = new Map<UpdateAdapterEvent, Set<UpdateAdapterListener>>()

  on(event: UpdateAdapterEvent, listener: UpdateAdapterListener): this {
    const listeners = this.listeners.get(event) ?? new Set<UpdateAdapterListener>()
    listeners.add(listener)
    this.listeners.set(event, listeners)
    return this
  }

  off(event: UpdateAdapterEvent, listener: UpdateAdapterListener): this {
    this.listeners.get(event)?.delete(listener)
    return this
  }

  emit(event: UpdateAdapterEvent, ...arguments_: unknown[]): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...arguments_)
  }

  listenerCount(event: UpdateAdapterEvent): number {
    return this.listeners.get(event)?.size ?? 0
  }
}

class FakePreferences implements UpdatePreferences {
  readonly setAutomaticChecks = vi.fn(async (enabled: boolean) => { this.enabled = enabled })
  constructor(private enabled: boolean) {}
  getAutomaticChecks(): boolean { return this.enabled }
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('UpdateController release eligibility', () => {
  it('keeps unpackaged and unmarked builds offline even when an updater is supplied', async () => {
    const developmentUpdater = new FakeUpdater()
    const development = new UpdateController({
      runtime: runtime({ isPackaged: false, releaseMarker: RELEASE_MARKER }),
      preferences: new FakePreferences(true),
      updater: developmentUpdater
    })
    expect(development.initialise()).toMatchObject({
      phase: 'unavailable',
      eligible: false,
      unavailableReason: 'development-build',
      automaticChecks: false
    })
    await development.check()
    expect(developmentUpdater.checkForUpdates).not.toHaveBeenCalled()
    expect(developmentUpdater.forceDevUpdateConfig).toBe(true)

    const unmarkedUpdater = new FakeUpdater()
    const unmarked = new UpdateController({
      runtime: runtime({ releaseMarker: undefined }),
      preferences: new FakePreferences(true),
      updater: unmarkedUpdater
    })
    expect(unmarked.initialise()).toMatchObject({
      phase: 'unavailable',
      unavailableReason: 'release-unmarked'
    })
    await unmarked.check()
    expect(unmarkedUpdater.checkForUpdates).not.toHaveBeenCalled()
  })

  it('rejects a marker for another architecture or repository', () => {
    const arm = new UpdateController({
      runtime: runtime({ architecture: 'arm64' }),
      preferences: new FakePreferences(false),
      updater: new FakeUpdater()
    })
    expect(arm.getState().unavailableReason).toBe('architecture-unsupported')

    const wrongRepository = new UpdateController({
      runtime: runtime({ releaseMarker: { ...RELEASE_MARKER, repository: 'someone/else' } }),
      preferences: new FakePreferences(false),
      updater: new FakeUpdater()
    })
    expect(wrongRepository.getState().unavailableReason).toBe('release-marker-invalid')
  })
})

describe('UpdateController updater orchestration', () => {
  it('accepts the stable electron-updater 6.8.9 AppUpdater surface', () => {
    expectTypeOf<AppUpdater>().toMatchTypeOf<UpdateAdapter>()
  })

  it('hardens the v6 updater and runs an opted-in check only after the startup delay', async () => {
    vi.useFakeTimers()
    const updater = new FakeUpdater()
    updater.onCheck = () => {
      updater.emit('checking-for-update')
      updater.emit('update-not-available', { version: '0.1.0' })
    }
    const controller = new UpdateController({
      runtime: runtime(),
      preferences: new FakePreferences(true),
      updater,
      now: () => new Date('2026-08-10T12:00:00.000Z')
    })

    controller.initialise()
    expect(updater).toMatchObject({
      autoDownload: false,
      autoInstallOnAppQuit: false,
      autoRunAppAfterInstall: true,
      allowPrerelease: false,
      allowDowngrade: false,
      disableWebInstaller: true,
      forceDevUpdateConfig: false,
      fullChangelog: true
    })
    expect(updater.checkForUpdates).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(29_999)
    expect(updater.checkForUpdates).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1)
    expect(controller.getState()).toMatchObject({
      phase: 'up-to-date',
      lastCheckedAt: '2026-08-10T12:00:00.000Z',
      failure: null
    })
    controller.dispose()
  })

  it('requires explicit check, download, and visible install actions', async () => {
    const updater = new FakeUpdater()
    updater.onCheck = () => {
      updater.emit('update-available', {
        version: '0.2.0',
        releaseName: '<b>Fovea 0.2.0</b>',
        releaseDate: '2026-08-10T10:00:00Z',
        releaseNotes: [
          { version: '0.2.0', note: '<script>bad()</script><p>New capture tools &amp; safer updates.</p>' },
          { version: '0.1.1', note: 'Stability fixes.' }
        ]
      })
    }
    updater.onDownload = () => {
      updater.emit('download-progress', { percent: 140, transferred: 1_200, total: 1_000, bytesPerSecond: 50 })
      updater.emit('update-downloaded', { version: '0.2.0', releaseName: 'Fovea 0.2.0' })
    }
    const controller = new UpdateController({
      runtime: runtime(),
      preferences: new FakePreferences(false),
      updater,
      now: () => new Date('2026-08-10T12:00:00.000Z')
    })
    controller.initialise()

    expect(updater.checkForUpdates).not.toHaveBeenCalled()
    await controller.check()
    expect(controller.getState()).toMatchObject({
      phase: 'available',
      availableUpdate: {
        version: '0.2.0',
        releaseName: 'Fovea 0.2.0',
        releaseDate: '2026-08-10T10:00:00.000Z',
        releaseNotes: ['New capture tools & safer updates.', 'Stability fixes.']
      }
    })
    expect(updater.downloadUpdate).not.toHaveBeenCalled()

    await controller.download()
    expect(controller.getState()).toMatchObject({
      phase: 'downloaded',
      availableUpdate: { releaseNotes: ['New capture tools & safer updates.', 'Stability fixes.'] },
      downloadProgress: { percent: 100, transferred: 1_000, total: 1_000, bytesPerSecond: 50 }
    })
    expect(updater.quitAndInstall).not.toHaveBeenCalled()

    controller.install()
    expect(controller.getState().phase).toBe('installing')
    expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true)
  })

  it('reports signature and integrity failures without throwing or installing', async () => {
    const updater = new FakeUpdater()
    updater.onCheck = () => {
      updater.emit('error', new Error('New version is not signed by the application owner: publisher mismatch'))
      throw new Error('New version is not signed by the application owner: publisher mismatch')
    }
    const controller = new UpdateController({
      runtime: runtime(),
      preferences: new FakePreferences(false),
      updater
    })
    controller.initialise()

    await expect(controller.check()).resolves.toMatchObject({ phase: 'error' })
    expect(controller.getState().failure).toMatchObject({
      code: 'invalid-signature',
      retryable: false
    })
    expect(updater.downloadUpdate).not.toHaveBeenCalled()
    expect(updater.quitAndInstall).not.toHaveBeenCalled()

    updater.onCheck = () => updater.emit('error', new Error('sha512 checksum mismatch'))
    await controller.check()
    expect(controller.getState().failure).toMatchObject({
      code: 'integrity-check-failed',
      retryable: true
    })
  })

  it('persists automatic-check opt-in, cancels it on opt-out, and detaches events on dispose', async () => {
    vi.useFakeTimers()
    const updater = new FakeUpdater()
    const preferences = new FakePreferences(false)
    const controller = new UpdateController({ runtime: runtime(), preferences, updater })
    controller.initialise()
    expect(updater.listenerCount('update-available')).toBe(1)

    await controller.setAutomaticChecks(true)
    expect(preferences.setAutomaticChecks).toHaveBeenLastCalledWith(true)
    await controller.setAutomaticChecks(false)
    expect(preferences.setAutomaticChecks).toHaveBeenLastCalledWith(false)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(updater.checkForUpdates).not.toHaveBeenCalled()

    const beforeDispose = controller.getState()
    controller.dispose()
    expect(updater.listenerCount('update-available')).toBe(0)
    updater.emit('update-available', { version: '9.9.9' })
    expect(controller.getState()).toEqual(beforeDispose)
  })
})

function runtime(overrides: Partial<{
  isPackaged: boolean
  platform: NodeJS.Platform
  architecture: string
  currentVersion: string
  releaseMarker: unknown
}> = {}): {
  isPackaged: boolean
  platform: NodeJS.Platform
  architecture: string
  currentVersion: string
  releaseMarker?: unknown
} {
  return {
    isPackaged: true,
    platform: 'win32',
    architecture: 'x64',
    currentVersion: '0.1.0',
    releaseMarker: RELEASE_MARKER,
    ...overrides
  }
}
