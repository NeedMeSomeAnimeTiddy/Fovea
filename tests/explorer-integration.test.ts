import { describe, expect, it, vi } from 'vitest'
import {
  EXPLORER_ACTIONS,
  LEGACY_ASK_MENU_KEY,
  ExplorerIntegration,
  explorerActionKey,
  explorerCommand,
  explorerCommandEntries,
  explorerCommandKey,
  explorerMenuKey,
  explorerPromptKey,
  explorerPromptLabel,
  explorerVerbKeys,
  parseRegistryDefaultValue,
  registryDeleteArguments,
  registryQueryArguments,
  registryWriteArguments
} from '../src/main/shell/explorer-integration'

const PACKAGED = { executablePath: 'C:\\Program Files\\Fovea\\Fovea.exe' }
const PROMPTS = [
  { id: 'prompt-1', label: 'Summarise' },
  { id: 'prompt-2', label: 'Translate' }
]
const DEVELOPMENT = { executablePath: 'C:\\dev\\node_modules\\electron\\dist\\electron.exe', appPath: 'C:\\dev\\fovea' }

describe('Explorer context-menu registration', () => {
  it('registers only per-user keys for images and PDF files', () => {
    expect(explorerVerbKeys()).toEqual([
      'HKCU\\Software\\Classes\\SystemFileAssociations\\image\\shell\\Fovea.Analyse',
      'HKCU\\Software\\Classes\\SystemFileAssociations\\.pdf\\shell\\Fovea.Analyse'
    ])
    for (const key of explorerVerbKeys()) expect(key.startsWith('HKCU\\')).toBe(true)
  })

  it('quotes the executable and the substituted path separately', () => {
    expect(explorerCommand(PACKAGED)).toBe('"C:\\Program Files\\Fovea\\Fovea.exe" --analyse "%1"')
  })

  it('passes the project directory through when running from source', () => {
    expect(explorerCommand(DEVELOPMENT)).toBe(
      '"C:\\dev\\node_modules\\electron\\dist\\electron.exe" "C:\\dev\\fovea" --analyse "%1"'
    )
  })

  it('names the submenu action, and only for the non-default ones', () => {
    expect(explorerCommand(PACKAGED, 'extract-text'))
      .toBe('"C:\\Program Files\\Fovea\\Fovea.exe" --analyse --analyse-action=extract-text "%1"')
    expect(explorerCommand(PACKAGED)).not.toContain('--analyse-action')
  })

  it('puts action verbs in the shared menu tree', () => {
    expect(explorerActionKey(EXPLORER_ACTIONS[1]!))
      .toBe('HKCU\\Software\\Classes\\Fovea.Menu\\shell\\02ExtractText')
  })

  it('orders the submenu entries, since Explorer sorts them by key name', () => {
    const keys = EXPLORER_ACTIONS.map((action) => action.key)
    expect(keys).toEqual([...keys].sort())
    expect(EXPLORER_ACTIONS[0]!.action).toBeUndefined()
    expect(EXPLORER_ACTIONS.map((action) => action.action).slice(1)).toEqual(['extract-text', 'ask', 'web-search'])
  })

  it('builds reg.exe argument arrays rather than shell strings', () => {
    expect(registryWriteArguments('HKCU\\Test', null, 'Fovea'))
      .toEqual(['add', 'HKCU\\Test', '/ve', '/t', 'REG_SZ', '/d', 'Fovea', '/f'])
    expect(registryWriteArguments('HKCU\\Test', 'Icon', 'C:\\Fovea.exe'))
      .toEqual(['add', 'HKCU\\Test', '/v', 'Icon', '/t', 'REG_SZ', '/d', 'C:\\Fovea.exe', '/f'])
    expect(registryDeleteArguments('HKCU\\Test')).toEqual(['delete', 'HKCU\\Test', '/f'])
    expect(registryQueryArguments('HKCU\\Test', null)).toEqual(['query', 'HKCU\\Test', '/ve'])
  })

  it('omits /d for an empty value, which is how reg.exe writes empty data', () => {
    expect(registryWriteArguments('HKCU\\Test', 'SubCommands', ''))
      .toEqual(['add', 'HKCU\\Test', '/v', 'SubCommands', '/t', 'REG_SZ', '/f'])
  })

  it('reads a default value that itself contains spaces', () => {
    const stdout = [
      '',
      'HKEY_CURRENT_USER\\Software\\Classes\\SystemFileAssociations\\image\\shell\\Fovea.Analyse\\command',
      '    (Default)    REG_SZ    "C:\\Program Files\\Fovea\\Fovea.exe" --analyse "%1"',
      ''
    ].join('\r\n')
    expect(parseRegistryDefaultValue(stdout)).toBe('"C:\\Program Files\\Fovea\\Fovea.exe" --analyse "%1"')
  })

  it('returns null when the value is absent', () => {
    expect(parseRegistryDefaultValue('ERROR: The system was unable to find the specified registry key')).toBeNull()
  })

  /**
   * The shape Microsoft documents for cascading menus within cascading menus: each level is its
   * own key tree referenced by an ExtendedSubCommandsKey value relative to HKEY_CLASSES_ROOT.
   * A menu built by enumerating a `shell` subkey inline renders flat and will not nest.
   */
  it('points each association at the shared menu tree rather than enumerating inline', async () => {
    const run = vi.fn(async (arguments_: string[]) => { void arguments_; return '' })
    await new ExplorerIntegration(PACKAGED, 'win32', run).enable()

    const written = run.mock.calls.map(([arguments_]) => arguments_)
    for (const verbKey of explorerVerbKeys()) {
      expect(written).toContainEqual(registryWriteArguments(verbKey, 'MUIVerb', 'Fovea'))
      expect(written).toContainEqual(registryWriteArguments(verbKey, 'Icon', PACKAGED.executablePath))
      // Relative to HKEY_CLASSES_ROOT, not a full key path.
      expect(written).toContainEqual(registryWriteArguments(verbKey, 'ExtendedSubCommandsKey', 'Fovea.Menu'))
      // The undocumented inline form is what failed to cascade; it must not come back.
      expect(written.some((arguments_) => arguments_[1] === verbKey && arguments_[3] === 'SubCommands')).toBe(false)
    }
    expect(explorerMenuKey()).toBe('HKCU\\Software\\Classes\\Fovea.Menu')
  })

  it('builds the action menu once, shared by both associations', async () => {
    const run = vi.fn(async (arguments_: string[]) => { void arguments_; return '' })
    await new ExplorerIntegration(PACKAGED, 'win32', run).enable()

    const written = run.mock.calls.map(([arguments_]) => arguments_)
    for (const action of EXPLORER_ACTIONS) {
      const actionKey = explorerActionKey(action)
      expect(actionKey.startsWith(explorerMenuKey())).toBe(true)
      expect(written).toContainEqual(registryWriteArguments(actionKey, 'MUIVerb', action.label))
      expect(written).toContainEqual(registryWriteArguments(actionKey, 'MultiSelectModel', 'Player'))
      expect(written).toContainEqual(
        registryWriteArguments(explorerCommandKey(actionKey), null, explorerCommand(PACKAGED, action.action))
      )
      // MultiSelectModel belongs with the command, never on a key that opens a menu.
      // Written once even though two associations reference it.
      expect(written.filter((arguments_) => arguments_[1] === actionKey && arguments_[3] === 'MUIVerb')).toHaveLength(1)
    }
  })

  it('leaves every menu key without a command of its own, which the extended form requires', async () => {
    const run = vi.fn(async (arguments_: string[]) => { void arguments_; return '' })
    await new ExplorerIntegration(PACKAGED, 'win32', run, () => PROMPTS).enable()

    const menuKeys = explorerVerbKeys()
    for (const menuKey of menuKeys) {
      const command = `${menuKey}\\command`
      expect(run.mock.calls.some(([arguments_]) => arguments_[0] === 'add' && arguments_[1] === command)).toBe(false)
      // A default value on a menu key stops it opening; only named values are ever written.
      expect(run.mock.calls.some(([arguments_]) => arguments_[1] === menuKey && arguments_[2] === '/ve')).toBe(false)
      // Verb values belong on the leaf commands, not on a key whose job is to open a menu.
      expect(run.mock.calls.some(([arguments_]) => arguments_[1] === menuKey && arguments_[3] === 'MultiSelectModel')).toBe(false)
    }
  })

  it('clears both shared trees and every verb key before rewriting them', async () => {
    const run = vi.fn(async (arguments_: string[]) => { void arguments_; return '' })
    await new ExplorerIntegration(PACKAGED, 'win32', run, () => PROMPTS).enable()

    const written = run.mock.calls.map(([arguments_]) => arguments_)
    for (const root of [explorerMenuKey(), ...explorerVerbKeys()]) {
      const deleteIndex = written.findIndex((arguments_) => arguments_[0] === 'delete' && arguments_[1] === root)
      const firstWriteIndex = written.findIndex((arguments_) => arguments_[0] === 'add' && arguments_[1]!.startsWith(root))
      expect(deleteIndex, root).toBeGreaterThanOrEqual(0)
      if (firstWriteIndex >= 0) expect(deleteIndex, root).toBeLessThan(firstWriteIndex)
    }
  })

  /**
   * Static registry verbs support a single level of cascade, so saved prompts sit beside the
   * fixed actions rather than in a submenu of their own.
   */
  it('lists saved prompts as actions in the one menu', async () => {
    const run = vi.fn(async (arguments_: string[]) => { void arguments_; return '' })
    await new ExplorerIntegration(PACKAGED, 'win32', run, () => PROMPTS).enable()

    const written = run.mock.calls.map(([arguments_]) => arguments_)
    expect(written).toContainEqual(registryWriteArguments(explorerPromptKey(1), 'MUIVerb', 'Ask: Summarise'))
    expect(written).toContainEqual(
      registryWriteArguments(explorerCommandKey(explorerPromptKey(1)), null, explorerCommand(PACKAGED, 'ask', 'prompt-1'))
    )
    expect(written).toContainEqual(registryWriteArguments(explorerPromptKey(2), 'MUIVerb', 'Ask: Translate'))
    expect(explorerPromptKey(1).startsWith(explorerMenuKey())).toBe(true)
    expect(explorerPromptLabel('Summarise')).toBe('Ask: Summarise')
  })

  it('keeps prompts sorted after the fixed actions and in their saved order', () => {
    const actionKeys = EXPLORER_ACTIONS.map((action) => explorerActionKey(action))
    const promptKeys = Array.from({ length: 12 }, (_value, index) => explorerPromptKey(index + 1))
    const all = [...actionKeys, ...promptKeys]
    // Explorer sorts children by key name, so the written order must already be the sorted order.
    expect(all).toEqual([...all].sort())
  })

  it('keeps Ask working as a plain entry alongside the prompts', async () => {
    const run = vi.fn(async (arguments_: string[]) => { void arguments_; return '' })
    await new ExplorerIntegration(PACKAGED, 'win32', run, () => PROMPTS).enable()

    const written = run.mock.calls.map(([arguments_]) => arguments_)
    const askKey = explorerActionKey(EXPLORER_ACTIONS[2]!)
    expect(written).toContainEqual(registryWriteArguments(explorerCommandKey(askKey), null, explorerCommand(PACKAGED, 'ask')))
    // Nothing points anywhere else now; a second cascade is not reachable from static verbs.
    expect(written.some((arguments_) => arguments_[1] === askKey && arguments_[3] === 'ExtendedSubCommandsKey')).toBe(false)
  })

  it('removes the abandoned nested menu left by an earlier version', async () => {
    const run = vi.fn(async (arguments_: string[]) => { void arguments_; return '' })
    await new ExplorerIntegration(PACKAGED, 'win32', run, () => PROMPTS).enable()
    expect(run.mock.calls.map(([arguments_]) => arguments_))
      .toContainEqual(registryDeleteArguments(LEGACY_ASK_MENU_KEY))
  })

  it('removes the shared menu too, since it sits outside the verb keys', async () => {
    const run = vi.fn(async (arguments_: string[]) => { void arguments_; return '' })
    await new ExplorerIntegration(PACKAGED, 'win32', run, () => PROMPTS).disable()
    expect(run.mock.calls.map(([arguments_]) => arguments_)).toContainEqual(registryDeleteArguments(explorerMenuKey()))
  })

  it('describes the same menu from enable and verify', () => {
    const withoutPrompts = explorerCommandEntries(PACKAGED)
    const withPrompts = explorerCommandEntries(PACKAGED, PROMPTS)
    // One shared menu, so four commands regardless of how many associations point at it.
    expect(withoutPrompts).toHaveLength(4)
    // Prompts add one command each, in the same menu.
    expect(withPrompts).toHaveLength(4 + PROMPTS.length)
    expect(withPrompts.some((entry) => entry.command.includes('--analyse-prompt=prompt-2'))).toBe(true)
  })

  it('reports drift when a prompt was added since the menu was written', async () => {
    const stored = new Map(explorerCommandEntries(PACKAGED).map((entry) => [entry.key, entry.command]))
    const run = async (arguments_: string[]): Promise<string> => {
      const command = stored.get(arguments_[1] ?? '')
      if (!command) throw new Error('not found')
      return `    (Default)    REG_SZ    ${command}`
    }
    expect(await new ExplorerIntegration(PACKAGED, 'win32', run, () => PROMPTS).verify()).toBe('drifted')
  })

  it('removes each verb key so the whole submenu goes with it', async () => {
    const run = vi.fn(async (arguments_: string[]) => { void arguments_; return '' })
    await new ExplorerIntegration(PACKAGED, 'win32', run).disable()
    expect(run.mock.calls.map(([arguments_]) => arguments_)).toEqual([
      ...explorerVerbKeys().map((key) => registryDeleteArguments(key)),
      registryDeleteArguments(explorerMenuKey()),
      registryDeleteArguments(LEGACY_ASK_MENU_KEY)
    ])
  })

  it('still reports success when a key was already gone', async () => {
    const run = vi.fn(async () => { throw new Error('not found') })
    await expect(new ExplorerIntegration(PACKAGED, 'win32', run).disable()).resolves.toBeUndefined()
  })

  it('reports registered only when every action command matches the current executable', async () => {
    // The stub answers each query with the command that key is expected to hold.
    const run = async (arguments_: string[]): Promise<string> => {
      const key = arguments_[1] ?? ''
      const action = EXPLORER_ACTIONS.find((candidate) => key.includes(`\\${candidate.key}\\`))
      return `    (Default)    REG_SZ    ${explorerCommand(PACKAGED, action?.action)}`
    }
    expect(await new ExplorerIntegration(PACKAGED, 'win32', run).verify()).toBe('registered')
  })

  it('reports drift when only some of the submenu survived', async () => {
    const run = async (arguments_: string[]): Promise<string> => {
      const key = arguments_[1] ?? ''
      if (!key.includes('01Analyse')) throw new Error('not found')
      return `    (Default)    REG_SZ    ${explorerCommand(PACKAGED)}`
    }
    expect(await new ExplorerIntegration(PACKAGED, 'win32', run).verify()).toBe('drifted')
  })

  it('reports drift when a stale executable path is still registered', async () => {
    const stale = '    (Default)    REG_SZ    "C:\\Old\\Fovea.exe" --analyse "%1"'
    expect(await new ExplorerIntegration(PACKAGED, 'win32', async () => stale).verify()).toBe('drifted')
  })

  it('reports absent when no key exists', async () => {
    const run = async (): Promise<string> => { throw new Error('not found') }
    expect(await new ExplorerIntegration(PACKAGED, 'win32', run).verify()).toBe('absent')
  })

  it('does nothing away from Windows', async () => {
    const run = vi.fn(async (arguments_: string[]) => { void arguments_; return '' })
    const integration = new ExplorerIntegration(PACKAGED, 'darwin', run)
    await integration.enable()
    await integration.disable()
    expect(await integration.verify()).toBe('unsupported')
    expect(run).not.toHaveBeenCalled()
  })
})
