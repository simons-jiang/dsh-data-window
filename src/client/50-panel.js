/**
 * Panel and workspace binding.
 *
 * Requirement 1 is "opening a workspace loads its own configuration". A global main
 * panel is not a conversation, so the panel cannot read the Session on screen at
 * paint time; a headless tracker in the frame's overlay layer remembers the Session
 * — and therefore the Workspace — while the Conversation still holds the column,
 * and the store follows whatever that tracker last saw.
 */

/** Bounds for the editor/document split, in pixels. */
const DW_EDITOR_MIN = 88
const DW_EDITOR_MAX = 620

/** The workspace a Session belongs to, tolerating both snapshot spellings. */
function dwResolveRoot(sessionsState, workspacesState) {
  const byId = sessionsState?.byId ?? {}
  const ids = Array.isArray(sessionsState?.ids) ? sessionsState.ids : []
  const workspaceItems = Array.isArray(workspacesState?.items) ? workspacesState.items : []

  const candidates = []
  for (const id of ids) {
    const row = byId[id]
    if (row === undefined) continue
    const retained = Number(row.retainedBy?.mainView ?? 0)
    const cwd = typeof row.cwd === 'string' ? row.cwd : ''
    candidates.push({ id, retained: Number.isFinite(retained) ? retained : 0, cwd })
  }
  candidates.sort((left, right) => right.retained - left.retained)

  for (const candidate of candidates) {
    const workspace = workspaceItems.find((item) => {
      const sessionIds = Array.isArray(item?.sessionIds) ? item.sessionIds : []
      return sessionIds.includes(candidate.id)
    })
    const fromWorkspace = typeof workspace?.path === 'string' ? workspace.path : ''
    if (fromWorkspace !== '') return fromWorkspace
    if (candidate.cwd !== '') return candidate.cwd
  }
  // No Session yet (a fresh window): the first Workspace is the best answer.
  const first = workspaceItems.find((item) => typeof item?.path === 'string' && item.path !== '')
  return typeof first?.path === 'string' ? first.path : ''
}

/** Headless entry that keeps the resolved workspace in the store. */
function DwTracker({ store, useSessions, useWorkspaces }) {
  const selectSessions = typeof useSessions === 'function' ? useSessions : () => undefined
  const selectWorkspaces = typeof useWorkspaces === 'function' ? useWorkspaces : () => undefined
  const sessions = selectSessions((snapshot) => snapshot)
  const workspaces = selectWorkspaces((snapshot) => snapshot)
  const root = dwResolveRoot(sessions, workspaces)
  useEffect(() => {
    if (root === '') return
    store.setDetectedRoot(root)
  }, [root, store])
  return null
}

function DwPanel({ store, translate, useSessions, useWorkspaces, pickDirectory }) {
  const tr = typeof translate === 'function' ? translate : (key) => key
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState)
  const [menu, setMenu] = useState(null)
  const [editorHeight, setEditorHeight] = useState(168)
  const panelRef = useRef(null)
  const logRef = useRef(null)

  // The tracker in the overlay reports first; these hooks read the same data, so
  // whichever mounted first decides, and a Workspace switch updates both.
  const selectSessions = typeof useSessions === 'function' ? useSessions : () => undefined
  const selectWorkspaces = typeof useWorkspaces === 'function' ? useWorkspaces : () => undefined
  const sessions = selectSessions((snapshot) => snapshot)
  const workspaces = selectWorkspaces((snapshot) => snapshot)
  const detected = dwResolveRoot(sessions, workspaces)

  useEffect(() => {
    if (detected !== '') store.setDetectedRoot(detected)
  }, [detected, store])

  // Requirement 3: one keystroke from the selected table to its create statement.
  useEffect(() => {
    const onKey = (event) => {
      const modifier = event.metaKey || event.ctrlKey
      const isDdl = event.key === 'F4' || (modifier && event.shiftKey && (event.key === 'd' || event.key === 'D'))
      if (!isDdl) return
      const selected = store.getState().selectedNode
      if (selected === null || selected === undefined) return
      if (selected.kind !== 'table' && selected.kind !== 'view') return
      event.preventDefault()
      event.stopPropagation()
      void store.openDdl(selected)
    }
    globalThis.addEventListener('keydown', onKey, true)
    return () => globalThis.removeEventListener('keydown', onKey, true)
  }, [store])

  // Escape closes the context menu, the same way the shipped menus behave.
  useEffect(() => {
    if (menu === null) return
    const onKey = (event) => {
      if (event.key === 'Escape') setMenu(null)
    }
    globalThis.addEventListener('keydown', onKey)
    return () => globalThis.removeEventListener('keydown', onKey)
  }, [menu])

  // The log follows the newest line while it is open; a user who scrolled up is
  // left where they are, because the next line would otherwise yank them away.
  useEffect(() => {
    const node = logRef.current
    if (node === null || state.logOpen !== true) return
    node.scrollTop = node.scrollHeight
  }, [state.log, state.logOpen])

  const activeTab = (state.tabs ?? []).find((tab) => tab.id === state.activeTab)
  const environments = state.environments ?? []
  const project = state.project
  const configured = environments.reduce((total, environment) => total + (environment.databaseCount ?? 0), 0)

  const pickWorkspace = async () => {
    if (typeof pickDirectory !== 'function') return
    try {
      const picked = await pickDirectory()
      if (typeof picked !== 'string' || picked === '') return
      store.setManualRoot(picked)
    } catch (error) {
      store.pushLog('error', tr('log.pickFailed', { message: error?.message ?? error }))
    }
  }

  /** Open the first instance of the default environment and list every schema. */
  const browseFirstInstance = () => {
    const environment = environments[0]
    const instance = environment?.instances?.[0]
    if (environment === undefined || instance === undefined) return
    store.expand(dwNodeKey('env', environment.env))
    void store.loadAllDatabases({
      key: dwNodeKey('inst', instance.id),
      id: instance.id,
      label: instance.aliases?.[0] ?? instance.host,
      env: environment.env,
      databases: instance.databases,
    })
  }

  const toolbar = h('div', { key: 'toolbar', className: 'dw-toolbar' }, [
    h('span', { key: 'ic', className: 'dw-node-icon' }, h(DwIcon, { name: 'database-play', size: 15 })),
    h('div', { key: 'title', className: 'dw-toolbar-title' }, [
      h('span', { key: 'p', className: 'dw-toolbar-project' }, project?.name ?? (state.phase === 'error' ? tr('stateError') : state.root === '' ? tr('noWorkspace') : tr('loading'))),
      h('span', { key: 'path', className: 'dw-toolbar-path', title: state.root }, state.root),
    ]),
    environments.length > 0 ? h('span', { key: 'envs', className: 'dw-badge', style: { marginLeft: 0 } }, `${environments.length} ${tr('environments')}`) : null,
    state.manual === true
      ? h('span', { key: 'manual', className: 'dw-badge', style: { marginLeft: 0 }, title: state.detected }, tr('manualWorkspace'))
      : null,
    h('span', { key: 'sp', className: 'dw-spacer' }),
    state.manual === true
      ? h('button', { key: 'follow', type: 'button', className: 'dw-btn', onClick: () => store.followDetected() }, tr('followWorkspace'))
      : null,
    h('button', { key: 'pick', type: 'button', className: 'dw-btn', onClick: pickWorkspace, title: tr('pickWorkspaceHint') }, [
      h(DwIcon, { key: 'i', name: 'panel', size: 12 }),
      h('span', { key: 't' }, tr('pickWorkspace')),
    ]),
    h('button', {
      key: 'refresh',
      type: 'button',
      className: 'dw-btn',
      disabled: state.root === '' || state.refreshing === true || state.phase === 'loading',
      onClick: () => void store.loadDiscovery({ refresh: true }),
      title: tr('refreshHint'),
    }, [
      h(DwIcon, { key: 'i', name: state.refreshing === true || state.phase === 'loading' ? 'spinner' : 'refresh', size: 12 }),
      h('span', { key: 't' }, tr('refresh')),
    ]),
  ])

  const selectedTable = state.selectedNode !== null
    && state.selectedNode !== undefined
    && (state.selectedNode.kind === 'table' || state.selectedNode.kind === 'view')

  const side = h('aside', { key: 'side', className: 'dw-side' }, [
    h('div', { key: 'head', className: 'dw-side-head' }, [
      h('span', { key: 't' }, tr('treeTitle')),
      h('span', { key: 'sp', className: 'dw-spacer' }),
      selectedTable === true ? h('span', { key: 'n' }, tr('ddlShortcutHint')) : null,
    ]),
    h('div', { key: 'filter', style: { padding: '5px 8px', borderBottom: '1px solid var(--dsw-alias-border-l1)' } }, [
      h('input', {
        key: 'i',
        type: 'search',
        value: state.filter ?? '',
        placeholder: tr('filterPlaceholder'),
        onChange: (event) => store.patch({ filter: event.target.value }),
        style: {
          width: '100%',
          height: 24,
          padding: '0 8px',
          borderRadius: 6,
          border: '1px solid var(--dsw-alias-border-l1, #31353d)',
          background: 'var(--dsw-alias-bg-layer-2, #262930)',
          color: 'inherit',
          font: 'inherit',
          fontSize: 12,
          outline: 'none',
        },
      }),
    ]),
    h(DwTree, {
      key: 'tree',
      store,
      state,
      tr,
      onContextMenu: (event, node) => setMenu({ x: event.clientX, y: event.clientY, node }),
    }),
  ])

  let main
  if (state.root === '') {
    main = h('div', { key: 'main', className: 'dw-main' }, h(DwEmpty, {
      tr,
      state,
      configured,
      onPick: pickWorkspace,
      onBrowse: browseFirstInstance,
    }))
  } else if (state.phase === 'loading' && environments.length === 0) {
    main = h('div', { key: 'main', className: 'dw-main' }, h('div', { className: 'dw-empty' }, [
      h(DwIcon, { key: 'i', name: 'spinner', size: 20 }),
      h('div', { key: 't', className: 'dw-empty-title' }, tr('discovering')),
      h('div', { key: 'h', className: 'dw-empty-hint' }, tr('discoveringHint')),
    ]))
  } else {
    main = h('div', { key: 'main', className: 'dw-main' }, [
      h(DwTabs, { key: 'tabs', store, state, tr }),
      activeTab === undefined
        ? h(DwEmpty, { key: 'empty', tr, state, configured, onPick: pickWorkspace, onBrowse: browseFirstInstance })
        : activeTab.kind === 'ddl'
          ? h(DwDdlView, { key: activeTab.id, tab: activeTab, tr, store })
          : h(React.Fragment, { key: activeTab.id }, [
            h(DwEditor, {
              key: 'editor',
              store,
              tab: activeTab,
              tr,
              height: editorHeight,
              onRun: () => void store.runActiveTab(),
            }),
            h(DwDragHandle, {
              key: 'drag',
              value: editorHeight,
              min: DW_EDITOR_MIN,
              max: DW_EDITOR_MAX,
              onChange: setEditorHeight,
            }),
            h(DwResults, { key: 'results', store, state, tab: activeTab, tr }),
          ]),
    ])
  }

  const log = h('div', { key: 'log', className: `dw-log${state.logOpen === true ? '' : ' dw-log-collapsed'}` }, [
    h('div', { key: 'bar', className: 'dw-log-bar' }, [
      h('button', {
        key: 'toggle',
        type: 'button',
        className: 'dw-log-toggle',
        title: tr('logTitle'),
        onClick: () => store.setLogOpen(state.logOpen !== true),
      }, [
        h(DwIcon, { key: 'i', name: 'chevron', size: 10, className: state.logOpen === true ? 'dw-rot-down' : '' }),
        h('span', { key: 't' }, tr('logTitle')),
        h('span', { key: 'c' }, `${state.log.length}`),
      ]),
      state.log.some((entry) => entry.level === 'error')
        ? h('span', { key: 'err', className: 'dw-log-error' }, tr('logHasError'))
        : null,
      h('span', { key: 'sp', className: 'dw-spacer' }),
      h('button', {
        key: 'clear',
        type: 'button',
        className: 'dw-btn',
        style: { height: 20, fontSize: 11 },
        onClick: () => store.patch({ log: [] }),
      }, tr('clear')),
    ]),
    h('div', { key: 'body', className: 'dw-log-body', ref: logRef }, state.log.map((entry) => h('div', {
      key: entry.id,
      className: `dw-log-line ${entry.level === 'error' ? 'dw-log-error' : entry.level === 'warn' ? 'dw-log-warn' : entry.level === 'ok' ? 'dw-log-ok' : ''}`,
    }, [
      h('b', { key: 't' }, `[${dwClock(entry.at)}] `),
      entry.text,
    ]))),
  ])

  // The menu is fixed-positioned inside a clipped panel, so it is clamped to the
  // panel's own rectangle instead of the viewport: otherwise a menu opened near the
  // bottom edge would be cut in half.
  let menuLayer = null
  if (menu !== null) {
    const rect = panelRef.current?.getBoundingClientRect?.()
    const width = 210
    const height = 190
    const left = rect === undefined ? menu.x : Math.min(menu.x, rect.right - width)
    const top = rect === undefined ? menu.y : Math.min(menu.y, rect.bottom - height)
    menuLayer = h(React.Fragment, null, [
      h('div', { key: 'backdrop', className: 'dw-backdrop', onClick: () => setMenu(null), onContextMenu: (event) => { event.preventDefault(); setMenu(null) } }),
      h('div', {
        key: 'menu',
        className: 'dw-menu',
        style: {
          left: Math.max(rect === undefined ? 0 : rect.left, left),
          top: Math.max(rect === undefined ? 0 : rect.top, top),
        },
      }, dwMenuItems(menu.node, store, tr, () => setMenu(null))),
    ])
  }

  return h('div', { className: 'dw-root', ref: panelRef }, [
    h(DwStyles, { key: 'style' }),
    toolbar,
    h('div', { key: 'body', className: 'dw-body' }, [side, main]),
    log,
    menuLayer,
  ])
}

/** Local wall-clock time for one log line. */
function dwClock(date) {
  const value = date instanceof Date ? date : new Date()
  const pad = (number) => String(number).padStart(2, '0')
  return `${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`
}

/** The context menu of one node. */
function dwMenuItems(node, store, tr, close) {
  const items = []
  const add = (key, label, shortcut, run) => items.push(h('button', {
    key,
    type: 'button',
    className: 'dw-menu-item',
    onClick: () => {
      close()
      run()
    },
  }, [h('span', { key: 'l' }, label), shortcut === '' ? null : h('span', { key: 's', className: 'dw-menu-shortcut' }, shortcut)]))

  if (node.kind === 'table' || node.kind === 'view') {
    add('ddl', tr('menuDdl'), 'F4', () => void store.openDdl(node))
    add('data', tr('menuOpenData'), '', () => {
      store.seedStatement(node, `SELECT *\nFROM \`${node.database}\`.\`${node.table}\`\nLIMIT 100`)
      void store.runActiveTab()
    })
    add('name', tr('menuCopyName'), '', () => {
      const write = globalThis.navigator?.clipboard?.writeText?.(node.table)
      if (write !== undefined) write.then(() => store.pushLog('info', tr('log.copiedName', { name: node.table }))).catch(() => undefined)
    })
  } else if (node.kind === 'database') {
    add('open', tr('menuOpenConsole'), '', () => store.openDatabase(node))
  } else if (node.kind === 'instance') {
    add('all', tr('browseAllDatabases'), '', () => void store.loadAllDatabases(node))
  } else if (node.kind === 'env') {
    add('expand', tr('menuExpand'), '', () => void store.toggleNode(node))
  } else if (node.kind === 'column') {
    add('name', tr('menuCopyName'), '', () => {
      const write = globalThis.navigator?.clipboard?.writeText?.(node.label)
      if (write !== undefined) write.then(() => store.pushLog('info', tr('log.copiedName', { name: node.label }))).catch(() => undefined)
    })
  }
  if (items.length === 0) items.push(h('div', { key: 'none', className: 'dw-menu-item', style: { opacity: .5 } }, tr('menuEmpty')))
  return items
}

/**
 * The panel's empty state.
 *
 * Three different situations used to share one misleading sentence: no workspace,
 * a workspace whose configuration resolved no database, and a workspace whose
 * configuration failed. Each one now says what happened and what to do next.
 */
function DwEmpty({ tr, state, configured, onPick, onBrowse }) {
  const warnings = state.warnings ?? []
  const states = []
  if (state.root === '') {
    states.push({ title: tr('emptyTitle'), hint: tr('emptyHint') })
  } else if (state.phase === 'error') {
    states.push({ title: tr('stateError'), hint: state.discoveryError })
  } else if ((state.environments ?? []).length === 0) {
    states.push({ title: tr('emptyNoEnvTitle'), hint: tr('emptyNoEnvHint') })
  } else if (configured === 0) {
    states.push({ title: tr('emptyNoConfigTitle'), hint: tr('emptyNoConfigHint') })
  } else {
    states.push({ title: tr('emptyReadyTitle'), hint: tr('emptyReadyHint') })
  }
  const current = states[0]

  return h('div', { className: 'dw-empty' }, [
    h('div', { key: 't', className: 'dw-empty-title' }, current.title),
    h('div', { key: 'h', className: 'dw-empty-hint' }, current.hint),
    state.root !== '' && configured === 0
      ? h('button', { key: 'browse', type: 'button', className: 'dw-btn dw-btn-accent', onClick: onBrowse }, tr('browseFirstInstance'))
      : null,
    h('div', { key: 'k', className: 'dw-empty-hint', style: { fontSize: 11.5, opacity: .8 } }, tr('shortcutSummary')),
    h('button', { key: 'b', type: 'button', className: 'dw-btn', onClick: onPick }, tr('pickWorkspace')),
    warnings.length > 0
      ? h('div', { key: 'w', className: 'dw-code-block' }, warnings.map((warning) => dwWarningText(warning, tr)).join('\n'))
      : null,
  ])
}

/** Turn one discovery warning code into a sentence. */
function dwWarningText(code, tr) {
  // A code may carry a detail after a colon (`unparsed-jdbc-url:spring.datasource`);
  // the dictionary is keyed by the code alone.
  const base = String(code).split(':')[0]
  const key = `warning.${base}`
  const text = tr(key)
  return text === key ? `· ${code}` : `· ${text}`
}

export { DwPanel, DwTracker, dwResolveRoot, DwEmpty, dwWarningText }
