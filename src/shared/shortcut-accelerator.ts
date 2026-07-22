const MODIFIER_KEYS = new Set(['Alt', 'AltGraph', 'Control', 'Meta', 'OS', 'Shift'])
const MODIFIER_TOKENS = new Set(['alt', 'altgr', 'cmd', 'cmdorctrl', 'command', 'commandorcontrol', 'control', 'ctrl', 'meta', 'option', 'shift', 'super'])
const KEY_ALIASES: Record<string, string> = { ' ': 'Space', '+': 'Plus', '-': 'Minus', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up' }

export interface ShortcutKeyInput {
  key: string
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  metaKey: boolean
}

export function acceleratorFromKeyInput(input: ShortcutKeyInput): string | null {
  if (MODIFIER_KEYS.has(input.key) || ['Dead', 'Process', 'Unidentified'].includes(input.key)) return null
  const key = KEY_ALIASES[input.key] ?? (input.key.length === 1 ? input.key.toUpperCase() : input.key)
  if (!key) return null
  const modifiers = [input.ctrlKey && 'Ctrl', input.altKey && 'Alt', input.shiftKey && 'Shift', input.metaKey && 'Meta'].filter((value): value is string => Boolean(value))
  return modifiers.length ? [...modifiers, key].join('+') : null
}

export function isCompleteAccelerator(value: string): boolean {
  const tokens = value.split('+')
  if (tokens.some((token) => !token.trim())) return false
  return tokens.some((token) => !MODIFIER_TOKENS.has(token.trim().toLowerCase()))
}
