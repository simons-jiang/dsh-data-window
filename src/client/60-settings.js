/**
 * The plugin's own settings page.
 *
 * It is a `settings.section`, so it gets its own row in DSH's settings navigation
 * (next to the other plugins' pages) instead of being buried in 通用设置. The
 * preferences are display defaults, not project data, so they live in the browser:
 * a different machine is expected to have its own window size and habits.
 */

/** Rows the settings page renders; a zero limit means "use the Host config". */
const DW_LIMIT_CHOICES = [0, 50, 100, 200, 500, 1000, 2000]

function DwSettingsSection({ translate, store }) {
  const tr = typeof translate === 'function' ? translate : (key) => key
  const [prefs, setPrefs] = useState(() => dwReadPrefs())
  const [recording, setRecording] = useState(false)
  const [recordError, setRecordError] = useState('')
  const themeId = useSyncExternalStore(dwSubscribeTheme, dwSharedTheme, dwSharedTheme)
  const binding = prefs.shortcutOpen ?? dwDefaultOpenShortcut()
  useEffect(() => { dwWatchTheme() }, [])

  const update = (changes) => {
    const next = dwWritePrefs(changes)
    setPrefs(next)
    if (changes.defaultLimit !== undefined && store !== undefined) {
      const configured = Number(store.getState?.()?.settings?.defaultLimit)
      store.setLimit(next.defaultLimit > 0 ? next.defaultLimit : (Number.isFinite(configured) && configured > 0 ? configured : 200))
    }
  }

  // Capture the next combination while "change" is armed. The window-level
  // open-shortcut listener checks the same flag, so the new key does not fire
  // while it is being recorded.
  useEffect(() => {
    globalThis.__dwShortcutRecording = recording
    if (!recording) return undefined
    const onKey = (event) => {
      event.preventDefault()
      event.stopPropagation()
      if (event.key === 'Escape') {
        setRecording(false)
        setRecordError('')
        return
      }
      if (DW_MODIFIER_KEYS.has(event.key)) return
      const modifiers = dwShortcutModifiers(event)
      if (!modifiers.includes('meta') && !modifiers.includes('ctrl') && !modifiers.includes('alt')) {
        setRecordError(tr('settingsShortcutNeedsModifier'))
        return
      }
      const next = dwWritePrefs({ shortcutOpen: { code: event.code, modifiers } })
      setPrefs(next)
      setRecording(false)
      setRecordError('')
    }
    globalThis.addEventListener('keydown', onKey, true)
    return () => {
      globalThis.removeEventListener('keydown', onKey, true)
      globalThis.__dwShortcutRecording = false
    }
  }, [recording])

  const resetShortcut = () => {
    const next = dwWritePrefs({ shortcutOpen: null })
    setPrefs(next)
    setRecording(false)
    setRecordError('')
  }

  const row = (key, label, description, control) => h('div', { key, className: 'dw-settings-row' }, [
    h('div', { key: 'head', className: 'dw-settings-head' }, [
      h('span', { key: 'label', className: 'dw-settings-label' }, label),
      control,
    ]),
    h('div', { key: 'desc', className: 'dw-settings-desc' }, description),
  ])

  const section = (key, title, children) => h('div', { key, className: 'dw-settings-section' }, [
    h('div', { key: 'title', className: 'dw-settings-section-title' }, title),
    ...children,
  ])

  return h('div', { className: 'dw-settings' }, [
    h('p', { key: 'intro', className: 'dw-settings-intro' }, tr('settingsIntro')),
    section('display', tr('settingsGroupDisplay'), [
      row(
        'sidebar',
        tr('settingsAutoHide'),
        tr('settingsAutoHideHint'),
        h('input', {
          key: 'control',
          type: 'checkbox',
          className: 'dw-settings-check',
          checked: prefs.autoHideSidebar,
          onChange: (event) => update({ autoHideSidebar: event.target.checked }),
        }),
      ),
      row(
        'limit',
        tr('settingsLimit'),
        tr('settingsLimitHint'),
        h('select', {
          key: 'control',
          className: 'dw-settings-select',
          value: String(prefs.defaultLimit),
          onChange: (event) => update({ defaultLimit: Number(event.target.value) }),
        }, DW_LIMIT_CHOICES.map((value) => h('option', {
          key: value,
          value: String(value),
        }, value === 0 ? tr('settingsLimitAuto') : String(value)))),
      ),
      row(
        'theme',
        tr('settingsTheme'),
        tr('settingsThemeHint'),
        h('span', { key: 'control', className: 'dw-settings-value' }, themeId === '' ? tr('settingsThemeDsh') : themeId),
      ),
    ]),
    section('shortcuts', tr('settingsShortcuts'), [
      h('div', { key: 'hint', className: 'dw-settings-desc' }, tr('settingsShortcutsHint')),
      h('div', { key: 'shortcut', className: 'dw-settings-row' }, [
        h('div', { key: 'head', className: 'dw-settings-head' }, [
          h('span', { key: 'label', className: 'dw-settings-label' }, tr('settingsShortcut')),
          h('div', { key: 'right', className: 'dw-settings-shortcut-actions' }, [
            h('span', { key: 'keys', className: recording ? 'dw-settings-key dw-settings-key-live' : 'dw-settings-key' },
              recording ? tr('settingsShortcutRecording') : dwFormatShortcut(binding)),
            h('button', {
              key: 'edit',
              type: 'button',
              className: 'dw-btn',
              onClick: () => {
                setRecording(recording !== true)
                setRecordError('')
              },
            }, recording ? tr('settingsShortcutCancel') : tr('settingsShortcutChange')),
            h('button', {
              key: 'reset',
              type: 'button',
              className: 'dw-btn',
              disabled: prefs.shortcutOpen === null,
              onClick: resetShortcut,
            }, tr('settingsShortcutReset')),
          ]),
        ]),
        h('div', { key: 'desc', className: 'dw-settings-desc' },
          recording ? tr('settingsShortcutRecordingHint') : tr('settingsShortcutHint')),
        recordError === '' ? null : h('div', { key: 'err', className: 'dw-settings-warn' }, recordError),
      ]),
    ]),
    section('storage', tr('settingsGroupStorage'), [
      h('div', { key: 'path', className: 'dw-settings-row' }, [
        h('div', { key: 'head', className: 'dw-settings-head' }, [
          h('span', { key: 'label', className: 'dw-settings-label' }, tr('settingsStorage')),
        ]),
        h('div', { key: 'desc', className: 'dw-settings-desc' }, tr('settingsStorageHint')),
        h('code', { key: 'value', className: 'dw-settings-path' }, '~/.dsh/storages/dsh-data-window/workspaces/'),
      ]),
    ]),
  ])
}
