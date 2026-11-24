/**
 * Client activation.
 *
 * Three seats and one mode:
 *
 *  - `main` (keyed `dsh-data-window:database`) — the DataGrip-style window itself.
 *  - `sidebar.footer.action` — one always-visible control beside Settings, so the
 *    window is reachable without hunting through the navigation column.
 *  - `conversation.header.leading` is deliberately left alone: it is a single seat
 *    that another plugin already holds, and a second registration would replace
 *    that plugin's entry rather than sit beside it.
 *  - `shell.overlay` — a headless tracker that keeps the last Workspace while the
 *    Conversation still holds the main column.
 *
 * Opening the panel goes through `ctx.layout.selectPanel`, the same service the
 * shipped navigation uses, so the window is a real main-column page rather than an
 * overlay that would fight the layout.
 */
const DW_TRANSLATE_FALLBACK = (key) => key

/**
 * Whether the data window is the panel the main column is showing.
 *
 * The foot control is an action, not a navigation row: DSH paints the selected
 * panel itself, and an occupant that brings a filled button reads as permanently
 * selected. The highlight therefore follows `layout.panelInfo` — the source DSH's
 * own panel rows read — and stays off where the layout service exposes none.
 */
function dwUsePanelActive(store) {
  const info = store.layout?.()?.panelInfo
  const subscribe = useCallback((onChange) => {
    if (info === undefined || typeof info.subscribe !== 'function') return () => {}
    return info.subscribe(onChange)
  }, [info])
  const getSnapshot = useCallback(() => info !== undefined
    && typeof info.getSnapshot === 'function'
    && info.getSnapshot()?.activePanelId === DW_PANEL_ID, [info])
  return useSyncExternalStore(subscribe, getSnapshot, () => false)
}

/** The sidebar-foot control: icon-only, or with its label when the column is wide. */
function DwFooterAction({ store, translate, wide }) {
  const tr = typeof translate === 'function' ? translate : DW_TRANSLATE_FALLBACK
  const active = dwUsePanelActive(store)
  const onClick = () => {
    const layout = store.layout?.()
    if (layout !== undefined && typeof layout.selectPanel === 'function') layout.selectPanel(DW_PANEL_ID)
  }
  return h('button', {
    type: 'button',
    className: active ? 'dw-foot-btn on' : 'dw-foot-btn',
    title: tr('openPanelHint'),
    'aria-label': tr('openPanelHint'),
    'aria-current': active ? 'page' : undefined,
    onClick,
    style: wide === true ? { padding: '0 8px', gap: 6 } : { minWidth: 26, padding: '0 4px' },
  }, [
    h(DwStyles, { key: 'style' }),
    h(DwIcon, { key: 'i', name: 'database', size: 15 }),
    wide === true ? h('span', { key: 't' }, tr('openPanel')) : null,
  ])
}

function apply(ctx) {
  let bound
  try {
    if (ctx.locale !== undefined && typeof ctx.locale.register === 'function') {
      ctx.locale.register(DW_NS, { en: DW_TEXT_EN, zh: DW_TEXT_ZH })
      for (const alias of ['zh-CN', 'zh-Hans']) {
        try {
          ctx.locale.register(DW_NS, alias, DW_TEXT_ZH)
        } catch (error) {
          void error
        }
      }
      const candidate = ctx.locale.bind(DW_NS)
      if (typeof candidate === 'function') bound = candidate
    }
  } catch (error) {
    // A host without the locale face still renders: the translator falls back to
    // the dictionary the bundle carries.
    void error
  }
  const translate = dwMakeTranslator(ctx, bound)
  const store = dwCreateStore(translate)

  // `layout` is an optional service: it is resolved in its own scope so the plugin
  // still activates where the shell has no panel navigation.
  const layoutRef = { current: undefined }
  try {
    ctx.inject(['layout'], (scoped) => {
      layoutRef.current = scoped.layout
    })
  } catch (error) {
    void error
  }
  Object.defineProperty(store, 'layout', { value: () => layoutRef.current, enumerable: false })

  // `uiWorkspace` opens the directory picker. It is resolved in its own scope, so
  // a shell without it still activates — the pick button then simply reports that
  // no picker is available instead of failing at click time.
  const workspaceRef = { current: undefined }
  try {
    ctx.inject(['uiWorkspace'], (scoped) => {
      workspaceRef.current = scoped.uiWorkspace
    })
  } catch (error) {
    void error
  }
  const pickDirectory = async () => {
    const service = workspaceRef.current
    if (service === undefined || typeof service.pickDirectory !== 'function') return null
    return await service.pickDirectory()
  }

  ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: DW_PANEL_ID,
    registrant: DW_NS,
    locale: DW_NS,
    inject: () => ({
      store,
      translate,
      pickDirectory,
    }),
  }, DwPanel)), 'dsh-data-window: database panel')

  ctx.effect(() => ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: `${DW_NS}:open`,
    order: 7,
    label: () => translate('openPanel'),
    registrant: DW_NS,
    locale: DW_NS,
    inject: () => ({ store, translate }),
  }, DwFooterAction)), 'dsh-data-window: footer action')

  ctx.effect(() => dwInstallBridge({
    store,
    translate,
    layout: () => layoutRef.current,
  }), 'dsh-data-window: code workspace bridge')

  ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: `${DW_NS}:settings`,
    order: 60,
    label: () => translate('settingsNav'),
    registrant: DW_NS,
    locale: DW_NS,
    inject: () => ({ translate, store }),
  }, DwSettingsSection)), 'dsh-data-window: settings section')

  ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: `${DW_NS}:tracker`,
    order: 42,
    registrant: DW_NS,
    inject: () => ({ store }),
  }, DwTracker)), 'dsh-data-window: workspace tracker')

  // Requirement: the open shortcut works from anywhere, with ⌘3 as its default.
  // DSH's shortcut service owns its own catalog and the code workspace binds its
  // panel the same way — a window-level listener, so the key works before the
  // panel is open. The binding is editable in the plugin's settings section.
  ctx.effect(() => {
    dwWatchTheme()
    const onKey = (event) => {
      if (event.repeat === true) return
      if (globalThis.__dwShortcutRecording === true) return
      if (!dwShortcutMatches(dwOpenShortcut(), event)) return
      const layout = layoutRef.current
      if (layout === undefined || typeof layout.selectPanel !== 'function') return
      event.preventDefault()
      event.stopPropagation()
      layout.selectPanel(DW_PANEL_ID)
    }
    globalThis.addEventListener('keydown', onKey, true)
    return () => globalThis.removeEventListener('keydown', onKey, true)
  }, 'dsh-data-window: open shortcut')
}

export { apply, DwFooterAction }
