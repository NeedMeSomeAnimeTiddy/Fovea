import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CodexRuntimeManager, type CodexRuntimeTarget } from '../src/main/runtime/codex-runtime-manager'

const roots: string[] = []

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

describe('CodexRuntimeManager', () => {
  it('downloads a pinned runtime, verifies it, and installs it atomically', async () => {
    const root = await temporaryRoot()
    const payload = Buffer.from('verified codex test runtime')
    const target = runtimeTarget(payload)
    const fetcher = vi.fn(async () => new Response(payload)) as unknown as typeof fetch
    const manager = new CodexRuntimeManager({ runtimeDirectory: join(root, 'runtime'), architecture: 'test', target, fetcher })

    await manager.initialise()
    expect(manager.getStatus().state).toBe('not-installed')
    await expect(manager.install()).resolves.toMatchObject({ state: 'installed', installedBytes: payload.length })
    await expect(readFile(manager.binaryPath)).resolves.toEqual(payload)
    expect(fetcher).toHaveBeenCalledWith(expect.stringContaining(target.asset), expect.objectContaining({ redirect: 'follow' }))
  })

  it('never replaces the executable when a download fails verification', async () => {
    const root = await temporaryRoot()
    const expected = Buffer.from('expected runtime')
    const existing = Buffer.from('existing corrupt runtime')
    const target = runtimeTarget(expected)
    const manager = new CodexRuntimeManager({
      runtimeDirectory: join(root, 'runtime'),
      architecture: 'test',
      target,
      fetcher: vi.fn(async () => new Response('tampered runtime')) as unknown as typeof fetch
    })
    await mkdirFor(manager.binaryPath)
    await writeFile(manager.binaryPath, existing)

    await manager.initialise()
    expect(manager.getStatus().state).toBe('error')
    await expect(manager.install()).rejects.toThrow(/SHA-256/i)
    await expect(readFile(manager.binaryPath)).resolves.toEqual(existing)
    await expect(stat(`${manager.binaryPath}.download`)).rejects.toThrow()
  })

  it('keeps app data intact when a runtime is removed after an offline failure', async () => {
    const root = await temporaryRoot()
    const historyPath = join(root, 'history.v2.sqlite')
    await writeFile(historyPath, 'history stays')
    const manager = new CodexRuntimeManager({
      runtimeDirectory: join(root, 'runtime'),
      architecture: 'test',
      target: runtimeTarget(Buffer.from('runtime')),
      fetcher: vi.fn(async () => { throw new Error('offline') }) as unknown as typeof fetch
    })

    await manager.initialise()
    await expect(manager.install()).rejects.toThrow(/offline/i)
    expect(manager.getStatus()).toMatchObject({ state: 'error', error: 'offline' })
    await expect(manager.remove()).resolves.toMatchObject({ state: 'not-installed' })
    await expect(readFile(historyPath, 'utf8')).resolves.toBe('history stays')
  })
})

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'fovea-runtime-test-'))
  roots.push(root)
  return root
}

async function mkdirFor(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
}

function runtimeTarget(payload: Buffer): CodexRuntimeTarget {
  return {
    architecture: 'test',
    asset: 'codex-test.exe',
    sha256: createHash('sha256').update(payload).digest('hex'),
    sizeBytes: payload.length
  }
}
