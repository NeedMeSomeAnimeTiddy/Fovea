// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FoveaApi } from '../src/shared/contracts/ipc'
import type { ApplicationUpdateState } from '../src/shared/types/update'
import { settingsCategoryFromSearch, UpdateSettings } from '../src/renderer/settings/main'

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'fovea')
})

describe('UpdateSettings', () => {
  it('explains why an unsigned local build cannot update', () => {
    render(<UpdateSettings state={state({ phase: 'unavailable', eligible: false, unavailableReason: 'development-build' })} working={false} onRun={vi.fn()} />)
    expect(screen.getByText('Updates unavailable in this build')).toBeTruthy()
    expect(screen.getByText(/never contact the production update feed/i)).toBeTruthy()
  })

  it('shows release notes and requires an explicit download action', async () => {
    const download = vi.fn(async () => state())
    Object.defineProperty(window, 'fovea', {
      configurable: true,
      value: { updates: { download } } as unknown as FoveaApi
    })
    const onRun = vi.fn(async (operation: () => Promise<unknown>) => { await operation(); return true })
    render(<UpdateSettings state={state()} working={false} onRun={onRun} />)

    expect(screen.getByText('Safer captures')).toBeTruthy()
    expect(screen.getByText('Review provider destinations before sending.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Download update' }))
    expect(onRun).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(download).toHaveBeenCalledOnce())
  })
})

describe('settings category navigation', () => {
  it('opens an explicitly requested settings category', () => {
    expect(settingsCategoryFromSearch('?category=Updates')).toBe('Updates')
    expect(settingsCategoryFromSearch('?category=Capture')).toBe('Capture')
  })

  it('falls back to Account for missing or unrecognised categories', () => {
    expect(settingsCategoryFromSearch('')).toBe('Account')
    expect(settingsCategoryFromSearch('?category=Billing')).toBe('Account')
  })
})

function state(patch: Partial<ApplicationUpdateState> = {}): ApplicationUpdateState {
  return {
    phase: 'available',
    eligible: true,
    unavailableReason: null,
    automaticChecks: false,
    currentVersion: '0.1.0',
    lastCheckedAt: '2026-08-10T10:00:00.000Z',
    availableUpdate: {
      version: '0.2.0',
      releaseName: 'Safer captures',
      releaseDate: '2026-08-10T09:00:00.000Z',
      releaseNotes: ['Review provider destinations before sending.']
    },
    downloadProgress: null,
    failure: null,
    ...patch
  }
}
