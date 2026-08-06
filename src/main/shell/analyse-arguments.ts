export const ANALYSE_FLAG = '--analyse'
export const ANALYSE_ACTION_PREFIX = '--analyse-action='
/** Identifies a saved custom prompt. The text itself never travels on the command line. */
export const ANALYSE_PROMPT_PREFIX = '--analyse-prompt='
/** Explorer can hand over a whole selection; beyond this the response window stops being useful. */
export const MAX_ANALYSE_FILES = 8

/** One entry in the Explorer submenu. `analyse` is the default and needs no switch. */
export type AnalyseAction = 'analyse' | 'extract-text' | 'ask' | 'web-search'

const ANALYSE_ACTIONS: AnalyseAction[] = ['analyse', 'extract-text', 'ask', 'web-search']

export function isAnalyseAction(value: string): value is AnalyseAction {
  return (ANALYSE_ACTIONS as string[]).includes(value)
}

export interface AnalyseRequest {
  paths: string[]
  /** Files past the cap, reported so the user is told rather than silently ignored. */
  dropped: number
  action: AnalyseAction
  /** Set when a saved prompt was chosen from the Ask submenu. Resolved against settings later. */
  promptId?: string
}

export interface AnalyseArgumentOptions {
  /**
   * The application directory, which a development launch passes as its own argument. It is
   * indistinguishable from a file path once Chromium has reordered the command line.
   */
  appPath?: string
}

/**
 * Reads a context-menu launch out of a process argument list.
 *
 * Order carries no information here. When Electron forwards a second instance's command line it
 * hoists every switch ahead of the positional arguments and adds its own, so a launch arrives as
 * `[exe, --analyse, --allow-file-access-from-files, appPath, image.png]`. The flag is therefore
 * treated as a marker that may appear anywhere, and every non-switch argument is a candidate path.
 */
export function parseAnalyseArguments(
  argv: readonly string[],
  options: AnalyseArgumentOptions = {}
): AnalyseRequest | null {
  let requested = false
  let action: AnalyseAction = 'analyse'
  let promptId = ''
  const candidates: string[] = []

  for (const [index, argument] of argv.entries()) {
    if (argument === ANALYSE_FLAG) {
      requested = true
      continue
    }
    // Checked before the general switch skip, and before the `--analyse=` inline form it resembles.
    if (argument.startsWith(ANALYSE_ACTION_PREFIX)) {
      const requestedAction = argument.slice(ANALYSE_ACTION_PREFIX.length).trim()
      if (isAnalyseAction(requestedAction)) action = requestedAction
      continue
    }
    if (argument.startsWith(ANALYSE_PROMPT_PREFIX)) {
      const candidate = argument.slice(ANALYSE_PROMPT_PREFIX.length).trim()
      // Matches the identifier shape ProfileManager stores; anything else is ignored outright.
      if (/^[\w-]{1,100}$/.test(candidate)) promptId = candidate
      continue
    }
    if (argument.startsWith(`${ANALYSE_FLAG}=`)) {
      requested = true
      const inline = argument.slice(ANALYSE_FLAG.length + 1).trim()
      if (inline) candidates.push(inline)
      continue
    }
    if (argument.startsWith('-')) continue
    // The executable is always first, whichever way the rest has been shuffled.
    if (index === 0) continue
    candidates.push(argument)
  }
  if (!requested) return null

  const unique: string[] = []
  const seen = new Set<string>()
  for (const candidate of candidates) {
    const trimmed = candidate.trim()
    if (!trimmed || samePath(trimmed, options.appPath)) continue
    // Windows paths are case-insensitive, so the same file selected twice is one attachment.
    const key = trimmed.toLocaleLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(trimmed)
  }
  if (!unique.length) return null
  return {
    paths: unique.slice(0, MAX_ANALYSE_FILES),
    dropped: Math.max(0, unique.length - MAX_ANALYSE_FILES),
    action,
    ...(promptId ? { promptId } : {})
  }
}

function samePath(candidate: string, other?: string): boolean {
  if (!other) return false
  return normalise(candidate) === normalise(other)
}

function normalise(value: string): string {
  return value.replace(/[\\/]+$/, '').replace(/\//g, '\\').toLocaleLowerCase()
}
