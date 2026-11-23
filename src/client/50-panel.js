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

/** Bounds for the explorer column, in pixels. */
const DW_SIDE_MIN = 200
const DW_SIDE_MAX = 720
const DW_SIDE_DEFAULT = 268
const DW_SIDE_KEY = 'dsh-data-window:side-width'

/** Wide layouts collapse the navigation column; below this the toggle is a drawer. */
const DW_WIDE_LAYOUT = 1024

/** Last path segment, used when a Workspace has no title. */
function dwBasename(path) {
  const parts = String(path ?? '').split('/').filter((part) => part !== '')
  return parts.length === 0 ? String(path ?? '') : parts[parts.length - 1]
}

/** `~/Documents/x` instead of an absolute home path. */
function dwShortPath(path) {
  return String(path ?? '').replace(/^\/(?:Users|home)\/[^/]+\//, '~/')
}

/** Stored explorer width, clamped so a bad value cannot hide the tree. */
function dwReadSideWidth() {
  const raw = Number(globalThis.localStorage?.getItem(DW_SIDE_KEY))
  if (!Number.isFinite(raw) || raw <= 0) return DW_SIDE_DEFAULT
  return Math.min(DW_SIDE_MAX, Math.max(DW_SIDE_MIN, raw))
}

/**
 * Whether the shell's navigation column is collapsed.
 *
 * `layout.toggleSidebar()` is a bare toggle with no readable state, so the frame's
 * own marker is the only way to avoid flipping a column the user had already
 * folded.
 */
function dwSidebarCollapsed() {
  try {
    const layer = document.querySelector('[data-shell-overlay]')
    const frame = layer === null ? null : layer.parentElement
    return frame === null ? false : frame.hasAttribute('data-sidebar-collapsed')
  } catch (error) {
    void error
    return false
  }
}

/** Fold the navigation column; false when it was already folded or unavailable. */
function dwHideSidebar(store) {
  const layout = store.layout?.()
  if (layout === undefined || typeof layout.toggleSidebar !== 'function') return false
  if ((Number(globalThis.innerWidth) || 0) < DW_WIDE_LAYOUT) return false
  if (dwSidebarCollapsed()) return false
  layout.toggleSidebar()
  return true
}

/** Unfold the navigation column, but only when it is still folded. */
function dwShowSidebar(store) {
  const layout = store.layout?.()
  if (layout === undefined || typeof layout.toggleSidebar !== 'function') return
  if (!dwSidebarCollapsed()) return
  layout.toggleSidebar()
  try {
    globalThis.dispatchEvent(new Event('resize'))
  } catch (error) {
    void error
  }
}

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

/** The workspace chip and its menu: switching here re-roots the window in place. */
function DwProjectMenu({ state, projects, tr, onSelect }) {
  const [open, setOpen] = useState(false)
  const root = state.root === '' ? '' : state.root.replace(/\/+$/, '')
  const current = projects.find((item) => item.path === root)
  const label = current === undefined
    ? (state.root === '' ? tr('noWorkspace') : dwBasename(state.root))
    : current.title

  useEffect(() => {
    if (!open) return undefined
    const onDown = (event) => {
      const element = event.target
      if (element instanceof Element && element.closest('.dw-project') !== null) return
      setOpen(false)
    }
    globalThis.addEventListener('pointerdown', onDown, true)
    return () => globalThis.removeEventListener('pointerdown', onDown, true)
  }, [open])

  return h('div', { className: 'dw-project' }, [
    h('button', {
      key: 'btn',
      type: 'button',
      className: 'dw-project-btn',
      title: tr('projectSwitch'),
      'aria-label': tr('projectSwitch'),
      onClick: () => setOpen(!open),
    }, [
      h('span', { key: 'nm', className: 'dw-project-name' }, label),
      h('span', { key: 'c', className: 'dw-project-caret' }, '\u25be'),
    ]),
    open
      ? h('div', { key: 'menu', className: 'dw-project-menu', role: 'menu' }, projects.map((item) => h('button', {
        key: item.path,
        type: 'button',
        role: 'menuitem',
        className: item.path === root ? 'dw-project-row active' : 'dw-project-row',
        title: item.path,
        onClick: () => {
          setOpen(false)
          if (item.path !== root) onSelect(item.path)
        },
      }, [
        h('span', { key: 't', className: 'dw-project-row-title' }, item.title),
        h('span', { key: 'p', className: 'dw-project-row-path' }, dwShortPath(item.path)),
      ])))
      : null,
  ])
}

function DwPanel({ store, translate, useSessions, useWorkspaces, pickDirectory }) {
  const tr = typeof translate === 'function' ? translate : (key) => key
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState)
  const [menu, setMenu] = useState(null)
  const [editorHeight, setEditorHeight] = useState(168)
  const [sideWidth, setSideWidth] = useState(() => dwReadSideWidth())
  const [sidebarHidden, setSidebarHidden] = useState(false)
  const panelRef = useRef(null)
  const logRef = useRef(null)
  const sideWidthRef = useRef(sideWidth)
  const sidebarHiddenRef = useRef(false)

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

  // Requirement: entering the window folds the shell's navigation column, so the
  // explorer and the workbench get the whole frame. Leaving unfolds it again, but
  // only if it is still folded.
  useEffect(() => {
    // The settings page can keep the shell's navigation column where it is; the
    // toolbar button still folds it on demand.
    if (dwReadPrefs().autoHideSidebar === false) return undefined
    if (dwHideSidebar(store)) {
      sidebarHiddenRef.current = true
      setSidebarHidden(true)
    }
    return () => {
      if (!sidebarHiddenRef.current) return
      sidebarHiddenRef.current = false
      dwShowSidebar(store)
    }
  }, [store])

  const toggleSidebar = () => {
    if (sidebarHiddenRef.current || dwSidebarCollapsed()) {
      sidebarHiddenRef.current = false
      setSidebarHidden(false)
      dwShowSidebar(store)
      return
    }
    if (dwHideSidebar(store)) {
      sidebarHiddenRef.current = true
      setSidebarHidden(true)
    }
  }

  // Drag the divider between the explorer and the workbench; the width is stored
  // per browser because it is a reading preference, not a per-project fact.
  const startSideResize = (event) => {
    if (event.button !== 0) return
    event.preventDefault()
    const startX = event.clientX
    const startWidth = sideWidthRef.current
    const panelWidth = panelRef.current?.getBoundingClientRect?.().width ?? globalThis.innerWidth
    const max = Math.max(DW_SIDE_MIN + 40, Math.min(DW_SIDE_MAX, panelWidth - 360))
    const previousSelect = document.body.style.userSelect
    document.body.style.userSelect = 'none'
    const move = (moveEvent) => {
      const width = Math.min(max, Math.max(DW_SIDE_MIN, startWidth + moveEvent.clientX - startX))
      sideWidthRef.current = width
      setSideWidth(width)
    }
    const stop = () => {
      globalThis.removeEventListener('pointermove', move)
      globalThis.removeEventListener('pointerup', stop)
      document.body.style.userSelect = previousSelect
      globalThis.localStorage?.setItem(DW_SIDE_KEY, String(sideWidthRef.current))
    }
    globalThis.addEventListener('pointermove', move)
    globalThis.addEventListener('pointerup', stop)
  }

  const resetSideWidth = () => {
    sideWidthRef.current = DW_SIDE_DEFAULT
    setSideWidth(DW_SIDE_DEFAULT)
    globalThis.localStorage?.setItem(DW_SIDE_KEY, String(DW_SIDE_DEFAULT))
  }

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
  // The palette is owned by the code workspace; watch it so switching there
  // recolours this panel without a reload.
  const themeId = useSyncExternalStore(dwSubscribeTheme, dwSharedTheme, dwSharedTheme)
  useEffect(() => { dwWatchTheme() }, [])

  // Every Workspace the shell knows, plus the current root when it is not a
  // registered Workspace yet (a directory picked by hand).
  const projectItems = []
  const seenProjectPaths = new Set()
  for (const item of Array.isArray(workspaces?.items) ? workspaces.items : []) {
    const path = typeof item?.path === 'string' ? item.path.replace(/\/+$/, '') : ''
    if (path === '' || seenProjectPaths.has(path)) continue
    seenProjectPaths.add(path)
    const title = typeof item?.title === 'string' && item.title.trim() !== '' ? item.title.trim() : dwBasename(path)
    projectItems.push({ path, title })
  }
  const currentRoot = state.root === '' ? '' : state.root.replace(/\/+$/, '')
  if (currentRoot !== '' && !seenProjectPaths.has(currentRoot)) {
    projectItems.unshift({ path: currentRoot, title: dwBasename(currentRoot) })
  }

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

  const toolbar = h('div', { key: 'toolbar', className: 'dw-toolbar' }, [
    h('span', { key: 'ic', className: 'dw-node-icon' }, h(DwIcon, { name: 'database-play', size: 15 })),
    h('div', { key: 'title', className: 'dw-toolbar-title' }, [
      h(DwProjectMenu, {
        key: 'ws',
        state,
        projects: projectItems,
        tr,
        onSelect: (path) => store.setManualRoot(path),
      }),
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
      key: 'sidebar',
      type: 'button',
      className: 'dw-btn dw-btn-icon',
      onClick: toggleSidebar,
      title: sidebarHidden ? tr('showSidebar') : tr('hideSidebar'),
      'aria-label': sidebarHidden ? tr('showSidebar') : tr('hideSidebar'),
    }, h(DwIcon, { name: 'panel', size: 13 })),
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

  const side = h('aside', { key: 'side', className: 'dw-side', style: { width: sideWidth } }, [
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
      onPick: pickWorkspace,
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
        ? h(DwEmpty, { key: 'empty', tr, state, onPick: pickWorkspace })
        : activeTab.kind === 'ddl'
          ? h(DwDdlView, { key: activeTab.id, tab: activeTab, tr, store })
          : h(React.Fragment, { key: activeTab.id }, [
            h(DwEditor, {
              key: 'editor',
              store,
              tab: activeTab,
              tr,
              height: editorHeight,
              schema: state.schemas?.get(activeTab.dbId),
              onRun: (statement) => void store.runActiveTab(statement),
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
      className: `dw-log-line ${entry.level === 'error' ? 'dw-log-error' : entry.level === 'warn' ? 'dw-log-warn' : entry.level === 'ok' ? 'dw-log-ok' : entry.level === 'sql' ? 'dw-log-sql' : ''}`,
    }, [
      h('b', { key: 't' }, `[${dwClock(entry.at)}] `),
      entry.level === 'sql' ? h('span', { key: 'tag', className: 'dw-log-tag' }, 'SQL') : null,
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

  return h('div', { className: 'dw-root', ref: panelRef, 'data-dsh-theme': themeId === '' ? undefined : themeId }, [
    h(DwStyles, { key: 'style' }),
    toolbar,
    h('div', { key: 'body', className: 'dw-body' }, [
      side,
      h('div', {
        key: 'resizer',
        className: 'dw-resizer',
        role: 'separator',
        'aria-orientation': 'vertical',
        title: tr('resizeTree'),
        onPointerDown: startSideResize,
        onDoubleClick: resetSideWidth,
      }),
      main,
    ]),
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
      const statement = `SELECT *\nFROM \`${node.database}\`.\`${node.table}\`\nLIMIT 100`
      store.seedStatement(node, statement)
      void store.runActiveTab(statement)
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
function DwEmpty({ tr, state, onPick }) {
  const warnings = state.warnings ?? []
  const states = []
  if (state.root === '') {
    states.push({ title: tr('emptyTitle'), hint: tr('emptyHint') })
  } else if (state.phase === 'error') {
    states.push({ title: tr('stateError'), hint: state.discoveryError })
  } else if ((state.environments ?? []).length === 0) {
    states.push({ title: tr('emptyNoEnvTitle'), hint: tr('emptyNoEnvHint') })
  } else {
    states.push({ title: tr('emptyReadyTitle'), hint: tr('emptyReadyHint') })
  }
  const current = states[0]

  return h('div', { className: 'dw-empty' }, [
    h('div', { key: 't', className: 'dw-empty-title' }, current.title),
    h('div', { key: 'h', className: 'dw-empty-hint' }, current.hint),
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
