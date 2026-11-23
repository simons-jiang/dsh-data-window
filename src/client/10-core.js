/**
 * Store, translator and Host RPC for the database window.
 *
 * One store instance is created in `apply` and shared by the panel and the sidebar
 * entry, so opening the panel from either place shows the same workspace. Every
 * read goes through `getSnapshot`, which keeps the React tree a pure function of
 * one plain object — the panel never keeps a second copy of the tree.
 *
 * Two rules the store owns, because no component can enforce them safely:
 *
 *  - the window follows the workspace the shell is showing, unless the user
 *    deliberately picked another directory;
 *  - a workbench that already holds the user's SQL is never overwritten by a tree
 *    action.
 */

/** Persisted manual workspace, so a reload reopens where the user left it. */
const DW_ROOT_KEY = 'dsh-data-window:root'

/** Locale namespace, shared with `locale/*.json`. */
const DW_NS = 'dsh-data-window'

/** Keyed main-panel id of the database window. */
const DW_PANEL_ID = 'dsh-data-window:database'

/** Rows kept in the run log before the oldest is dropped. */
const DW_LOG_LIMIT = 400

/** How many rows the panel asks for until the Host reports its configured default. */
const DW_DEFAULT_LIMIT = 200

/** Monotonic suffix for second and later consoles of one database. */
let dwStatementSequence = 0

/** The bytes that read like a statement, so "is this the user's SQL" is decidable. */
const DW_SQL_EMPTY = /^\s*(?:--[^\n]*\n?)*\s*$/

/**
 * Build the plugin's translator.
 *
 * The framework's `t` echoes the key back for a locale the bundle has no
 * dictionary for, and a raw key in the UI is never acceptable, so the bundle's own
 * dictionaries are the guaranteed last resort.
 */
function dwMakeTranslator(ctx, boundT) {
  const localeId = () => {
    try {
      const snapshot = ctx?.locale?.getSnapshot?.()
      if (typeof snapshot?.active === 'string' && snapshot.active !== '') return snapshot.active
    } catch (error) {
      void error
    }
    if (typeof document !== 'undefined' && typeof document.documentElement?.lang === 'string') {
      return document.documentElement.lang
    }
    return typeof navigator !== 'undefined' && typeof navigator.language === 'string' ? navigator.language : ''
  }
  const dictionary = () => (/^zh/i.test(localeId()) ? DW_TEXT_ZH : DW_TEXT_EN)
  const translate = (key, values) => {
    let template
    if (typeof boundT === 'function') {
      const value = boundT(key)
      if (typeof value === 'string' && value !== '' && value !== key) template = value
    }
    if (template === undefined) {
      const table = dictionary()
      const value = table[key]
      template = typeof value === 'string' ? value : key
    }
    if (values === undefined) return template
    return template.replace(/\{(\w+)\}/g, (match, name) => {
      const replacement = values[name]
      return replacement === undefined || replacement === null ? match : String(replacement)
    })
  }
  translate.localeId = localeId
  return translate
}

/** Call the Host route once. */
async function dwRpc(action, payload = {}) {
  const base = typeof document !== 'undefined' && typeof document.baseURI === 'string' ? document.baseURI : 'http://dsh.internal/'
  const response = await fetch(new URL('dsh-data/rpc', base).href, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, ...payload }),
  })
  let body
  try {
    body = await response.json()
  } catch (error) {
    void error
    throw new Error(`${action}: HTTP ${response.status}`)
  }
  if (body?.ok !== true) {
    const failure = new Error(body?.error?.message ?? `${action} failed`)
    failure.code = body?.error?.code ?? 'request-failed'
    throw failure
  }
  return body.value
}

/** Compose one tree-node key; every level of the tree is addressable. */
function dwNodeKey(kind, ...parts) {
  return [kind, ...parts].join(':')
}

/** Format a duration for the log and the result bar. */
function dwDuration(milliseconds) {
  const value = Number(milliseconds)
  if (!Number.isFinite(value)) return ''
  if (value < 1000) return `${Math.round(value)} ms`
  return `${(value / 1000).toFixed(2)} s`
}

/** Format a row count the way a SQL client does. */
function dwRowCount(count) {
  const value = Number(count)
  if (!Number.isFinite(value)) return '0'
  if (value < 10000) return String(value)
  if (value < 1000000) return `${(value / 1000).toFixed(1)}k`
  return `${(value / 1000000).toFixed(2)}M`
}

/** One line for the run log. */
function dwLogEntry(level, text) {
  return { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, at: new Date(), level, text }
}

/**
 * Turn a Host failure into a sentence.
 *
 * The read-only gate answers with codes such as `write-keyword`, and a user who is
 * stopped by the one rule this window enforces deserves an explanation rather than
 * an enum.
 */
function dwExplainFailure(translate, error) {
  const code = String(error?.code ?? '')
  const detail = String(error?.message ?? '')
  const known = {
    'read-only-violation': 'error.readOnly',
    'unknown-target': 'error.hostRestarted',
    'database-required': 'error.databaseRequired',
    'ER_NO_SUCH_TABLE': 'error.noSuchTable',
    'ER_BAD_FIELD_ERROR': 'error.badField',
    'ER_ACCESS_DENIED_ERROR': 'error.accessDenied',
    'ETIMEDOUT': 'error.timeout',
    'ECONNREFUSED': 'error.refused',
    'ENOTFOUND': 'error.unresolved',
    'ER_QUERY_INTERRUPTED': 'error.interrupted',
  }
  const key = known[code]
  if (key !== undefined) {
    const text = translate(key)
    if (text !== key) return `${text}${detail === '' ? '' : `（${detail}）`}`
  }
  return detail === '' ? code : `${code}: ${detail}`
}

/** Read the persisted manual workspace, tolerating a blocked storage. */
function dwStoredRoot() {
  try {
    return globalThis.localStorage?.getItem(DW_ROOT_KEY) ?? ''
  } catch (error) {
    void error
    return ''
  }
}

/** Persist (or clear) the manual workspace. */
function dwPersistRoot(root) {
  try {
    if (root === '') globalThis.localStorage?.removeItem(DW_ROOT_KEY)
    else globalThis.localStorage?.setItem(DW_ROOT_KEY, root)
  } catch (error) {
    void error
  }
}

function dwCreateStore(translate) {
  const t = typeof translate === 'function' ? translate : (key) => key

  let state = {
    // workspace
    root: '',
    detected: '',
    manual: false,
    // Loaded once, so a workspace picked by hand wins from the first paint instead
    // of losing a race against the shell's own detection.
    preferred: dwStoredRoot(),
    phase: 'idle',
    refreshing: false,
    project: null,
    environments: [],
    warnings: [],
    discoveryError: '',
    discoveryMs: 0,
    fromCache: false,
    settings: null,
    // tree
    filter: '',
    expanded: new Set(),
    loadState: new Map(),
    children: new Map(),
    selected: '',
    selectedNode: null,
    // workbench
    tabs: [],
    activeTab: '',
    limit: DW_DEFAULT_LIMIT,
    // log
    logOpen: false,
    log: [dwLogEntry('info', t('log.ready'))],
  }

  const listeners = new Set()
  const getState = () => state
  const subscribe = (listener) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }
  const emit = () => {
    for (const listener of [...listeners]) listener()
  }
  const patch = (changes) => {
    state = { ...state, ...changes }
    emit()
  }

  const pushLog = (level, text) => {
    const next = [...state.log, dwLogEntry(level, text)]
    patch({ log: next.length > DW_LOG_LIMIT ? next.slice(next.length - DW_LOG_LIMIT) : next })
  }

  /** Run one Host call, retrying once after a rediscovery when the Host forgot us. */
  const call = async (action, payload) => {
    try {
      return await dwRpc(action, payload)
    } catch (error) {
      if (error?.code !== 'unknown-target' || state.root === '') throw error
      pushLog('warn', t('log.hostRestarted'))
      await store.loadDiscovery({ refresh: true, quiet: true })
      return await dwRpc(action, payload)
    }
  }

  const store = {
    getState,
    subscribe,
    patch,
    pushLog,
    call,
    t,

    /** What the overlay tracker last resolved, so a remount keeps the project. */
    detectedRoot() {
      return state.detected
    },

    /**
     * Record the workspace the shell is showing.
     *
     * The window follows it unless the user picked another directory, which is the
     * whole point of requirement 1: switching workspace switches the database
     * window, and the previous project's tree and tabs are not kept.
     */
    setDetectedRoot(root) {
      const next = typeof root === 'string' ? root : ''
      if (next === '') return
      if (state.detected !== next) patch({ detected: next })
      if (state.preferred !== '') {
        // A stored choice outlives a reload. It is applied as a manual pick, which
        // is what keeps the follow-workspace button meaningful.
        if (state.root !== state.preferred) {
          patch({ manual: true })
          store.setRoot(state.preferred)
        }
        return
      }
      if (state.root !== next) store.setRoot(next)
    },

    /** Drop a manual pick and follow the shell's workspace again. */
    followDetected() {
      dwPersistRoot('')
      patch({ manual: false, preferred: '' })
      if (state.detected !== '' && state.detected !== state.root) store.setRoot(state.detected)
    },

    /** Follow a workspace chosen by hand instead of the shell's. */
    setManualRoot(root) {
      const next = typeof root === 'string' ? root : ''
      if (next === '') return
      dwPersistRoot(next)
      patch({ manual: true, preferred: next })
      store.setRoot(next)
    },

    /** Show the panel with nothing loaded yet. */
    reset() {
      patch({
        root: '',
        manual: false,
        phase: 'idle',
        refreshing: false,
        project: null,
        environments: [],
        warnings: [],
        discoveryError: '',
        filter: '',
        expanded: new Set(),
        loadState: new Map(),
        children: new Map(),
        selected: '',
        selectedNode: null,
        tabs: [],
        activeTab: '',
      })
    },

    /**
     * Point the window at one workspace.
     *
     * A changed root resets the tree and the workbench: another project's databases
     * have nothing to do with this one.
     */
    setRoot(root) {
      const next = typeof root === 'string' ? root : ''
      if (next === state.root) return
      if (next === '') {
        store.reset()
        return
      }
      patch({
        root: next,
        phase: 'loading',
        project: null,
        environments: [],
        warnings: [],
        discoveryError: '',
        filter: '',
        expanded: new Set(),
        loadState: new Map(),
        children: new Map(),
        selected: '',
        selectedNode: null,
        tabs: [],
        activeTab: '',
      })
      void store.loadDiscovery({ refresh: false })
      void store.loadSettings()
    },

    /** One Host round trip for the tunables the panel mirrors. */
    async loadSettings() {
      try {
        const settings = await dwRpc('config')
        const limit = Number(settings?.defaultLimit)
        patch({
          settings,
          limit: Number.isFinite(limit) && limit > 0 ? limit : state.limit,
        })
      } catch (error) {
        void error
      }
    },

    /** Read the workspace's configuration through the Host. */
    async loadDiscovery(options = {}) {
      const root = state.root
      if (root === '') return
      const refreshing = options.refresh === true
      patch({
        phase: state.environments.length === 0 ? 'loading' : state.phase,
        refreshing,
        discoveryError: '',
      })
      const startedAt = Date.now()
      try {
        const discovery = await dwRpc('discover', { root, refresh: refreshing })
        if (state.root !== root) return
        const environments = Array.isArray(discovery.environments) ? discovery.environments : []
        const defaultEnv = discovery.defaultEnv ?? environments[0]?.env
        const base = refreshing ? new Set() : new Set(state.expanded)
        for (const environment of environments) {
          if (environment.env === defaultEnv) base.add(dwNodeKey('env', environment.env))
        }
        patch({
          phase: environments.length === 0 ? 'empty' : 'ready',
          refreshing: false,
          project: discovery.project ?? null,
          environments,
          warnings: Array.isArray(discovery.warnings) ? discovery.warnings : [],
          discoveryMs: Date.now() - startedAt,
          fromCache: discovery.cached === true,
          expanded: base,
          // A reload replaces the metadata too: keeping a cached table list after
          // the user asked for a reload is exactly the stale tree they asked about.
          children: refreshing ? new Map() : state.children,
          loadState: refreshing ? new Map() : state.loadState,
        })
        if (options.quiet !== true) {
          const databases = environments.reduce((total, environment) => total + (environment.databaseCount ?? 0), 0)
          pushLog('info', t('log.discovered', {
            envs: environments.length,
            databases,
            cached: discovery.cached === true ? t('log.cachedSuffix') : '',
          }))
        }
      } catch (error) {
        if (state.root !== root) return
        patch({ phase: 'error', refreshing: false, discoveryError: dwExplainFailure(t, error) })
        pushLog('error', t('log.discoverFailed', { message: dwExplainFailure(t, error) }))
      }
    },

    /** Expand or collapse one tree node, loading its children on first open. */
    async toggleNode(node) {
      if (node === null || node === undefined) return
      const expanded = new Set(state.expanded)
      if (expanded.has(node.key)) {
        expanded.delete(node.key)
        patch({ expanded })
        return
      }
      expanded.add(node.key)
      patch({ expanded })
      await store.ensureChildren(node)
    },

    /** Add keys to the expansion set without toggling them. */
    expand(...keys) {
      const expanded = new Set(state.expanded)
      for (const key of keys) if (typeof key === 'string' && key !== '') expanded.add(key)
      patch({ expanded })
    },

    /** Forget one node's cached children so the next expand re-reads them. */
    retryNode(node) {
      if (node === null || node === undefined) return
      const children = new Map(state.children)
      children.delete(node.key)
      const loadState = new Map(state.loadState)
      loadState.delete(node.key)
      patch({ children, loadState })
      void store.ensureChildren(node)
    },

    /** Load the children a node needs, once. */
    async ensureChildren(node) {
      if (node === null || node === undefined) return
      if (node.kind === 'env') return
      if (node.kind === 'instance') {
        // A project whose configuration never named this instance still gets a
        // usable tree: opening it asks the server which schemas exist.
        if ((node.databases ?? []).length === 0 && state.loadState.get(node.key) !== 'ready') {
          await store.loadAllDatabases(node)
        }
        return
      }
      if (node.kind !== 'database' && node.kind !== 'table' && node.kind !== 'view') return
      if (Array.isArray(state.children.get(node.key))) return
      if (state.loadState.get(node.key) === 'loading') return
      const loadState = new Map(state.loadState)
      loadState.set(node.key, 'loading')
      patch({ loadState })
      try {
        if (node.kind === 'database') {
          const value = await call('tables', { id: node.dbId })
          const children = (value.tables ?? []).map((table) => ({
            key: dwNodeKey('tbl', node.dbId, table.name),
            kind: table.kind === 'view' ? 'view' : 'table',
            label: table.name,
            detail: table.comment !== '' ? table.comment : table.rows > 0 ? dwRowCount(table.rows) : '',
            dbId: node.dbId,
            database: node.database,
            env: node.env,
            instanceLabel: node.instanceLabel,
            table: table.name,
            info: table,
          }))
          const nextChildren = new Map(state.children)
          nextChildren.set(node.key, children)
          const nextState = new Map(state.loadState)
          nextState.set(node.key, 'ready')
          patch({ children: nextChildren, loadState: nextState })
          pushLog('info', t('log.tables', { database: node.database, count: children.length, ms: dwDuration(value.elapsedMs) }))
          return
        }
        const value = await call('columns', { id: node.dbId, table: node.table })
        const children = (value.columns ?? []).map((column) => ({
          key: dwNodeKey('col', node.dbId, node.table, column.name),
          kind: 'column',
          label: column.name,
          detail: column.type,
          column,
          dbId: node.dbId,
          database: node.database,
          env: node.env,
          instanceLabel: node.instanceLabel,
          table: node.table,
        }))
        const nextChildren = new Map(state.children)
        nextChildren.set(node.key, children)
        const nextState = new Map(state.loadState)
        nextState.set(node.key, 'ready')
        patch({ children: nextChildren, loadState: nextState })
      } catch (error) {
        // A failure stays a load state, not a fake child row: a child would make
        // every later expand a no-op and only a restart could clear it.
        const nextState = new Map(state.loadState)
        nextState.set(node.key, 'error')
        patch({ loadState: nextState })
        pushLog('error', t('log.loadFailed', { name: node.label, message: dwExplainFailure(t, error) }))
      }
    },

    /** Reveal every schema on one instance, not only the configured ones. */
    async loadAllDatabases(instanceNode) {
      if (instanceNode === null || instanceNode === undefined || instanceNode.id === undefined) return
      const key = instanceNode.key
      if (state.loadState.get(key) === 'loading') return
      const loadState = new Map(state.loadState)
      loadState.set(key, 'loading')
      const expanded = new Set(state.expanded)
      expanded.add(key)
      patch({ loadState, expanded })
      try {
        const value = await call('databases', { id: instanceNode.id })
        const seen = new Set((state.children.get(key) ?? []).map((entry) => entry.label))
        const children = (value.databases ?? [])
          .filter((entry) => !seen.has(entry.name))
          .map((entry) => ({
            key: dwNodeKey('db', entry.id),
            kind: 'database',
            label: entry.name,
            dbId: entry.id,
            database: entry.name,
            env: instanceNode.env,
            instanceLabel: instanceNode.label,
          }))
        const nextChildren = new Map(state.children)
        nextChildren.set(key, [...(nextChildren.get(key) ?? []), ...children])
        const nextState = new Map(state.loadState)
        nextState.set(key, 'ready')
        patch({ children: nextChildren, loadState: nextState })
        pushLog('info', t('log.allDatabases', { instance: instanceNode.label, count: value.databases?.length ?? 0 }))
      } catch (error) {
        const nextState = new Map(state.loadState)
        nextState.set(key, 'error')
        patch({ loadState: nextState })
        pushLog('error', t('log.databasesFailed', { message: dwExplainFailure(t, error) }))
      }
    },

    /** Select one row; a table also becomes the target of the DDL shortcut. */
    select(node) {
      patch({ selected: node?.key ?? '', selectedNode: node ?? null })
    },

    /**
     * Open (or focus) the SQL workbench of one database.
     *
     * @returns the tab, so a caller may seed a statement only when the console is
     * still empty.
     */
    openDatabase(node) {
      if (node === null || node === undefined || node.dbId === undefined) return undefined
      const id = `sql:${node.dbId}`
      const existing = state.tabs.find((tab) => tab.id === id)
      if (existing !== undefined) {
        patch({ activeTab: id })
        return existing
      }
      const tab = {
        id,
        kind: 'sql',
        title: node.database,
        env: node.env ?? '',
        subtitle: [node.env, node.instanceLabel].filter((part) => typeof part === 'string' && part !== '').join(' · '),
        dbId: node.dbId,
        database: node.database,
        instanceLabel: node.instanceLabel ?? '',
        // An empty console, so the placeholder explains what to do; a canned
        // statement would be overwritten by the user's first keystroke anyway.
        sql: '',
        result: undefined,
        error: '',
        running: false,
      }
      patch({ tabs: [...state.tabs, tab], activeTab: id })
      return tab
    },

    /**
     * Put a statement in a workbench without destroying what the user typed.
     *
     * A tree action ("open table data") must never cost the user an unsaved
     * query, so an occupied console gets a second tab instead.
     */
    seedStatement(node, sql) {
      const open = store.openDatabase(node)
      if (open === undefined) return
      if (!DW_SQL_EMPTY.test(String(open.sql ?? ''))) {
        dwStatementSequence += 1
        const sequence = dwStatementSequence
        const id = `sql:${node.dbId}:${sequence}`
        const tab = {
          ...open,
          id,
          title: `${node.database} (${sequence})`,
          sql,
          result: undefined,
          error: '',
        }
        patch({ tabs: [...state.tabs, tab], activeTab: id })
        return
      }
      store.setTabSql(open.id, sql)
      store.setActiveTab(open.id)
    },

    /**
     * Open the DDL of one table.
     *
     * Requirement: the create statement is one keystroke away. The tab is keyed by
     * table, so asking twice focuses the same document instead of stacking copies.
     */
    async openDdl(node) {
      if (node === null || node === undefined || node.table === undefined) return
      const id = `ddl:${node.dbId}:${node.table}`
      const existing = state.tabs.find((tab) => tab.id === id)
      if (existing !== undefined) {
        patch({ activeTab: id })
        if (existing.loading !== true && existing.ddl !== '') return
        await store.refreshDdl(id)
        return
      }
      const tab = {
        id,
        kind: 'ddl',
        title: node.table,
        env: node.env ?? '',
        subtitle: [node.env, node.database].filter((part) => typeof part === 'string' && part !== '').join(' · '),
        dbId: node.dbId,
        database: node.database,
        instanceLabel: node.instanceLabel ?? '',
        table: node.table,
        ddl: '',
        columns: [],
        loading: true,
        error: '',
      }
      patch({ tabs: [...state.tabs, tab], activeTab: id })
      await store.refreshDdl(id)
    },

    /** Re-read one DDL tab (a schema change is exactly why the tab exists). */
    async refreshDdl(id) {
      const tab = state.tabs.find((entry) => entry.id === id)
      if (tab === undefined || tab.kind !== 'ddl') return
      patch({ tabs: state.tabs.map((entry) => (entry.id === id ? { ...entry, loading: true, error: '' } : entry)) })
      try {
        const value = await call('ddl', { id: tab.dbId, table: tab.table })
        patch({
          tabs: state.tabs.map((entry) => (entry.id === id
            ? { ...entry, ddl: value.ddl ?? '', columns: value.columns ?? [], loading: false, error: '' }
            : entry)),
        })
        pushLog('info', t('log.ddl', { table: tab.table, ms: dwDuration(value.statementTime) }))
      } catch (error) {
        patch({ tabs: state.tabs.map((entry) => (entry.id === id ? { ...entry, loading: false, error: dwExplainFailure(t, error) } : entry)) })
        pushLog('error', t('log.loadFailed', { name: tab.table, message: dwExplainFailure(t, error) }))
      }
    },

    /** Close one tab and pick a neighbour. */
    closeTab(id) {
      const index = state.tabs.findIndex((tab) => tab.id === id)
      if (index < 0) return
      const tabs = state.tabs.filter((tab) => tab.id !== id)
      let activeTab = state.activeTab
      if (activeTab === id) {
        const neighbour = tabs[index] ?? tabs[index - 1]
        activeTab = neighbour?.id ?? ''
      }
      patch({ tabs, activeTab })
    },

    setActiveTab(id) {
      patch({ activeTab: id })
    },

    setTabSql(id, sql) {
      patch({ tabs: state.tabs.map((tab) => (tab.id === id ? { ...tab, sql } : tab)) })
    },

    setLimit(limit) {
      patch({ limit })
    },

    setLogOpen(open) {
      patch({ logOpen: open })
    },

    /** Run the active tab's statement. */
    async runActiveTab() {
      const tab = state.tabs.find((entry) => entry.id === state.activeTab)
      if (tab === undefined || tab.kind !== 'sql' || tab.running === true) return
      const sql = String(tab.sql ?? '').trim()
      if (DW_SQL_EMPTY.test(sql)) {
        pushLog('warn', t('log.noStatement'))
        return
      }
      patch({ tabs: state.tabs.map((entry) => (entry.id === tab.id ? { ...entry, running: true, error: '' } : entry)) })
      try {
        const value = await call('query', { id: tab.dbId, sql, limit: state.limit })
        patch({
          tabs: state.tabs.map((entry) => (entry.id === tab.id ? { ...entry, running: false, result: value, error: '' } : entry)),
        })
        pushLog('info', t('log.query', {
          database: tab.database,
          rows: value.rowCount,
          ms: dwDuration(value.elapsedMs),
          truncated: value.truncated === true ? t('log.truncatedSuffix', { limit: value.limit }) : '',
        }))
      } catch (error) {
        const message = dwExplainFailure(t, error)
        patch({
          tabs: state.tabs.map((entry) => (entry.id === tab.id ? { ...entry, running: false, error: message } : entry)),
        })
        pushLog('error', message)
      }
    },
  }

  return store
}

export { DW_NS, DW_PANEL_ID, DW_DEFAULT_LIMIT, DW_ROOT_KEY, dwMakeTranslator, dwRpc, dwNodeKey, dwCreateStore, dwDuration, dwRowCount, dwExplainFailure, DW_SQL_EMPTY }
