/**
 * Keyboard shortcuts of the data window.
 *
 * One registry, so the settings page and the window-level listener cannot drift
 * apart: add an entry here and it appears in the settings group automatically.
 * A binding is `{ code, modifiers }` — a physical key plus the exact modifier
 * set, independent of the keyboard layout.
 */

/** Platforms where the primary modifier draws as ⌘. */
function dwIsMac() {
  const platform = String(globalThis.navigator?.platform ?? '')
  return /Mac|iPhone|iPad/.test(platform)
}

/** "Open the data window": ⌘3 on macOS, Ctrl+3 elsewhere. */
function dwDefaultOpenShortcut() {
  return dwIsMac() ? { code: 'Digit3', modifiers: ['meta'] } : { code: 'Digit3', modifiers: ['ctrl'] }
}

/** The binding in force for opening the panel (custom preference or default). */
function dwOpenShortcut() {
  const saved = dwReadPrefs().shortcutOpen
  if (saved !== null && saved !== undefined && typeof saved.code === 'string') return saved
  return dwDefaultOpenShortcut()
}

/** Whether one keyboard event is exactly the binding (extra modifiers fail). */
function dwShortcutMatches(binding, event) {
  if (binding === null || binding === undefined || event.code !== binding.code) return false
  const modifiers = Array.isArray(binding.modifiers) ? binding.modifiers : []
  if (event.metaKey !== modifiers.includes('meta')) return false
  if (event.ctrlKey !== modifiers.includes('ctrl')) return false
  if (event.altKey !== modifiers.includes('alt')) return false
  if (event.shiftKey !== modifiers.includes('shift')) return false
  return true
}

/** The modifiers of one keyboard event, in a stable order. */
function dwShortcutModifiers(event) {
  const modifiers = []
  if (event.ctrlKey === true) modifiers.push('ctrl')
  if (event.altKey === true) modifiers.push('alt')
  if (event.shiftKey === true) modifiers.push('shift')
  if (event.metaKey === true) modifiers.push('meta')
  return modifiers
}

/** Keys that are only a modifier press, and therefore not a complete binding. */
const DW_MODIFIER_KEYS = new Set(['Control', 'Alt', 'Shift', 'Meta', 'CapsLock'])

/** One keycap for a physical code; letters/digits are the common case. */
function dwKeycapForCode(code) {
  const text = String(code ?? '')
  if (text.startsWith('Key') && text.length === 4) return text.slice(3)
  if (text.startsWith('Digit') && text.length === 6) return text.slice(5)
  if (text.startsWith('Numpad') && text.length > 6) return text.slice(6)
  const named = {
    Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']',
    Backslash: '\\', Semicolon: ';', Quote: '\'', Comma: ',', Period: '.', Slash: '/',
    Space: 'Space', Enter: 'Enter', Escape: 'Esc', Tab: 'Tab', Backspace: '⌫',
    Delete: 'Del', Insert: 'Ins', Home: 'Home', End: 'End', PageUp: 'PgUp', PageDown: 'PgDn',
    ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
  }
  if (named[text] !== undefined) return named[text]
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(text)) return text
  return text
}

/** Human keycap string: `⌘3`, `⌃⇧4`, `Ctrl+Shift+3`. */
function dwFormatShortcut(binding) {
  const modifiers = Array.isArray(binding?.modifiers) ? binding.modifiers : []
  const key = dwKeycapForCode(binding?.code)
  if (dwIsMac()) {
    let text = ''
    if (modifiers.includes('ctrl')) text += '⌃'
    if (modifiers.includes('alt')) text += '⌥'
    if (modifiers.includes('shift')) text += '⇧'
    if (modifiers.includes('meta')) text += '⌘'
    return `${text}${key}`
  }
  const parts = []
  if (modifiers.includes('ctrl')) parts.push('Ctrl')
  if (modifiers.includes('alt')) parts.push('Alt')
  if (modifiers.includes('shift')) parts.push('Shift')
  if (modifiers.includes('meta')) parts.push('Meta')
  parts.push(key)
  return parts.join('+')
}
