import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { ANALYSE_ACTION_PREFIX, ANALYSE_PROMPT_PREFIX, type AnalyseAction } from './analyse-arguments'

const execFileAsync = promisify(execFile)
const REGISTRY_TIMEOUT_MS = 5_000

/** Fovea only ever writes below this key: per-user, no elevation, and removable in one delete. */
const CLASSES = 'HKCU\\Software\\Classes'
const CLASSES_ROOT = `${CLASSES}\\SystemFileAssociations`
/**
 * The menu lives in its own key tree, referenced by an `ExtendedSubCommandsKey` value holding a
 * path relative to HKEY_CLASSES_ROOT. Defining it once lets both file associations reuse it,
 * which is the documented benefit of the extended form.
 *
 * Static registry verbs support exactly one level of cascade. Saved prompts therefore sit
 * alongside the actions in this one menu rather than in a submenu of their own; nesting further
 * needs a COM shell extension, which is how applications like 7-Zip do it.
 *
 * @see https://learn.microsoft.com/en-us/windows/win32/shell/how-to-create-cascading-menus-with-the-extendedsubcommandskey-registry-entry
 */
const MENU_RELATIVE_KEY = 'Fovea.Menu'
const MENU_KEY = `${CLASSES}\\${MENU_RELATIVE_KEY}`
/** Written by an earlier attempt at a nested submenu. Removed so it cannot linger. */
export const LEGACY_ASK_MENU_KEY = `${CLASSES}\\Fovea.AskMenu`
/** Keeps a saved prompt readable as an action once it sits beside the fixed entries. */
const PROMPT_LABEL_PREFIX = 'Ask: '
const VERB = 'Fovea.Analyse'
const VERB_LABEL = 'Fovea'
/** `image` covers every extension Windows perceives as an image, so one key replaces a long list. */
const ASSOCIATIONS = ['image', '.pdf'] as const

export interface ExplorerAction {
  /** Registry key name. Explorer orders children alphabetically, so the number fixes the order. */
  key: string
  label: string
  /** Omitted for the default action, which needs no switch. */
  action?: AnalyseAction
}

/** The submenu, in the order Explorer will show it. */
export const EXPLORER_ACTIONS: ExplorerAction[] = [
  { key: '01Analyse', label: 'Analyse' },
  { key: '02ExtractText', label: 'Extract text', action: 'extract-text' },
  { key: '03Ask', label: 'Ask a question...', action: 'ask' },
  { key: '04WebSearch', label: 'Search the web about this', action: 'web-search' }
]

export type ExplorerIntegrationState = 'registered' | 'drifted' | 'absent' | 'unsupported'

export interface ExplorerCommandTarget {
  /** The launcher Explorer should run. Packaged builds use the Fovea executable. */
  executablePath: string
  /** Development builds run Electron against the project directory, which must be passed through. */
  appPath?: string
}

export type RegistryRunner = (arguments_: string[]) => Promise<string>

/** A saved custom prompt, reduced to what the Explorer menu needs. */
export interface ExplorerPrompt {
  id: string
  label: string
}

/** `SystemFileAssociations\<association>\shell\Fovea.Analyse`, one per registered association. */
export function explorerVerbKeys(): string[] {
  return ASSOCIATIONS.map((association) => `${CLASSES_ROOT}\\${association}\\shell\\${VERB}`)
}

/** The shared key tree the file associations point their `ExtendedSubCommandsKey` at. */
export function explorerMenuKey(): string {
  return MENU_KEY
}

/** Action verbs live in the shared menu tree, not under each association's verb key. */
export function explorerActionKey(action: ExplorerAction): string {
  return `${MENU_KEY}\\shell\\${action.key}`
}

export function explorerCommandKey(actionKey: string): string {
  return `${actionKey}\\command`
}

/**
 * A saved prompt, sorted after the fixed actions. Explorer orders children by key name, so the
 * `05` group keeps prompts below `04WebSearch` and the padding keeps them in their saved order.
 */
export function explorerPromptKey(position: number): string {
  return `${MENU_KEY}\\shell\\05Prompt${String(position).padStart(2, '0')}`
}

/** A saved prompt reads as an action once it sits beside the fixed entries. */
export function explorerPromptLabel(label: string): string {
  return `${PROMPT_LABEL_PREFIX}${label}`
}

/**
 * Every command key that should exist and the command it should hold. `enable` writes these and
 * `verify` reads them back, so the two cannot describe different menus.
 */
export function explorerCommandEntries(
  target: ExplorerCommandTarget,
  prompts: ExplorerPrompt[] = []
): Array<{ key: string; command: string }> {
  const entries = EXPLORER_ACTIONS.map((action) => ({
    key: explorerCommandKey(explorerActionKey(action)),
    command: explorerCommand(target, action.action)
  }))
  prompts.forEach((prompt, index) => {
    entries.push({
      key: explorerCommandKey(explorerPromptKey(index + 1)),
      command: explorerCommand(target, 'ask', prompt.id)
    })
  })
  return entries
}

/**
 * The command Explorer substitutes `%1` into. Arguments stay separately quoted so a path
 * containing spaces survives the round trip through the shell.
 */
export function explorerCommand(target: ExplorerCommandTarget, action?: AnalyseAction, promptId?: string): string {
  const parts = [quoted(target.executablePath)]
  if (target.appPath) parts.push(quoted(target.appPath))
  parts.push('--analyse')
  if (action) parts.push(`${ANALYSE_ACTION_PREFIX}${action}`)
  if (promptId) parts.push(`${ANALYSE_PROMPT_PREFIX}${promptId}`)
  parts.push(quoted('%1'))
  return parts.join(' ')
}

export function registryWriteArguments(key: string, name: string | null, value: string): string[] {
  return [
    'add',
    key,
    ...(name === null ? ['/ve'] : ['/v', name]),
    '/t',
    'REG_SZ',
    // reg.exe treats an omitted /d as empty data, which is what an empty SubCommands needs.
    ...(value === '' ? [] : ['/d', value]),
    '/f'
  ]
}

export function registryDeleteArguments(key: string): string[] {
  return ['delete', key, '/f']
}

export function registryQueryArguments(key: string, name: string | null): string[] {
  return ['query', key, ...(name === null ? ['/ve'] : ['/v', name])]
}

/**
 * `reg query` prints `    (Default)    REG_SZ    <value>`. The value itself may contain runs of
 * spaces, so only the first two column breaks are consumed.
 */
export function parseRegistryDefaultValue(stdout: string): string | null {
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^\s+(?:\(Default\)|\S+)\s+REG_SZ\s{4}(.*)$/.exec(line)
    if (match) return match[1]!.trim()
  }
  return null
}

export class ExplorerIntegration {
  constructor(
    private readonly target: ExplorerCommandTarget,
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly run: RegistryRunner = defaultRegistryRunner,
    /** Read fresh on every write, so the menu tracks the prompts currently saved. */
    private readonly listPrompts: () => ExplorerPrompt[] = () => []
  ) {}

  async enable(): Promise<void> {
    if (this.platform !== 'win32') return
    const prompts = this.listPrompts()
    // The menu is shared, so it is rebuilt once. Clearing first drops entries for prompts that
    // have since been renamed or deleted.
    await this.run(registryDeleteArguments(MENU_KEY)).catch(() => '')
    await this.run(registryDeleteArguments(LEGACY_ASK_MENU_KEY)).catch(() => '')
    for (const action of EXPLORER_ACTIONS) {
      const actionKey = explorerActionKey(action)
      await this.run(registryWriteArguments(actionKey, 'MUIVerb', action.label))
      // Player lets Explorer pass a whole multi-file selection to one invocation.
      await this.run(registryWriteArguments(actionKey, 'MultiSelectModel', 'Player'))
      await this.run(registryWriteArguments(
        explorerCommandKey(actionKey),
        null,
        explorerCommand(this.target, action.action)
      ))
    }
    for (const [index, prompt] of prompts.entries()) {
      await this.writePromptEntry(index + 1, prompt.label, prompt.id)
    }
    for (const verbKey of explorerVerbKeys()) {
      // Cleared first so an earlier registration cannot leave a stray `command` subkey or
      // `SubCommands` value competing with the extended key.
      await this.run(registryDeleteArguments(verbKey)).catch(() => '')
      // MUIVerb rather than the default value, which must stay unset on a menu key.
      await this.run(registryWriteArguments(verbKey, 'MUIVerb', VERB_LABEL))
      await this.run(registryWriteArguments(verbKey, 'Icon', this.target.executablePath))
      await this.run(registryWriteArguments(verbKey, 'ExtendedSubCommandsKey', MENU_RELATIVE_KEY))
    }
  }

  private async writePromptEntry(position: number, label: string, promptId: string): Promise<void> {
    const promptKey = explorerPromptKey(position)
    await this.run(registryWriteArguments(promptKey, 'MUIVerb', explorerPromptLabel(label)))
    await this.run(registryWriteArguments(promptKey, 'MultiSelectModel', 'Player'))
    await this.run(registryWriteArguments(
      explorerCommandKey(promptKey),
      null,
      explorerCommand(this.target, 'ask', promptId)
    ))
  }

  async disable(): Promise<void> {
    if (this.platform !== 'win32') return
    for (const verbKey of explorerVerbKeys()) {
      // Deleting the verb key removes its command subkey and every value with it.
      await this.run(registryDeleteArguments(verbKey)).catch(() => '')
    }
    // The menu sits outside the verb keys, so removing those does not take it with it.
    await this.run(registryDeleteArguments(MENU_KEY)).catch(() => '')
    await this.run(registryDeleteArguments(LEGACY_ASK_MENU_KEY)).catch(() => '')
  }

  async verify(): Promise<ExplorerIntegrationState> {
    if (this.platform !== 'win32') return 'unsupported'
    const entries = explorerCommandEntries(this.target, this.listPrompts())
    let matching = 0
    let present = 0
    for (const entry of entries) {
      const stdout = await this.run(registryQueryArguments(entry.key, null)).catch(() => null)
      if (stdout === null) continue
      present++
      if (parseRegistryDefaultValue(stdout) === entry.command) matching++
    }
    // A saved prompt added or removed since the last write leaves the menu stale, which reads as
    // drift and prompts the user to re-register.
    if (matching === entries.length) return 'registered'
    return present === 0 ? 'absent' : 'drifted'
  }
}

function quoted(value: string): string {
  return `"${value}"`
}

async function defaultRegistryRunner(arguments_: string[]): Promise<string> {
  // execFile with an argument array: reg.exe is never handed a shell string to re-parse.
  const { stdout } = await execFileAsync('reg.exe', arguments_, {
    encoding: 'utf8',
    timeout: REGISTRY_TIMEOUT_MS,
    windowsHide: true
  })
  return stdout
}
