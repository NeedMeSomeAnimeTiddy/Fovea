import { rename, stat } from 'node:fs/promises'

export async function preserveCorruptFile(path: string): Promise<string> {
  const backupPath = await availableBackupPath(path)
  await rename(path, backupPath)
  return backupPath
}

export function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
}

async function availableBackupPath(path: string): Promise<string> {
  const preferred = `${path}.corrupt.bak`
  if (!await pathExists(preferred)) return preferred

  let index = 2
  while (await pathExists(`${path}.corrupt-${index}.bak`)) index += 1
  return `${path}.corrupt-${index}.bak`
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (isMissingFile(error)) return false
    throw error
  }
}
