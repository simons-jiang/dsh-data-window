/**
 * Cross-plugin bridge: the code workspace asks for a table or a statement.
 *
 * The code workspace (`dsh-ide-window`) is a separate client bundle, so the two
 * plugins cannot import each other. They share events instead — the same style as
 * the `dsh-theme` contract:
 *
 * - capability marker `window.__DSH_DATA_WINDOW_BRIDGE__ = { v: 1 }`, set while
 *   this plugin is active, so the code workspace can enable/disable its menus;
 * - request `dsh-data-window:request` with `{ v, id, action, root, ... }`;
 * - response `dsh-data-window:response` with `{ v, id, action, ok, reason, ... }`.
 *
 * Requests are serialized: a workspace switch and its discovery must not race a
 * second request. The data window never trusts the payload for anything but UI
 * text — table lookups and queries still go through the read-only Host gateway.
 */

const DW_BRIDGE_REQUEST = 'dsh-data-window:request'
const DW_BRIDGE_RESPONSE = 'dsh-data-window:response'
const DW_BRIDGE_CAPABILITY = '__DSH_DATA_WINDOW_BRIDGE__'
const DW_BRIDGE_VERSION = 1
const DW_BRIDGE_TIMEOUT_MS = 20000

function dwBridgeRespond(id, action, payload) {
  try {
    globalThis.dispatchEvent(new CustomEvent(DW_BRIDGE_RESPONSE, {
      detail: { v: DW_BRIDGE_VERSION, id, action, ...payload },
    }))
  } catch (error) {
    void error
  }
}

/** Every configured database of the loaded workspace, in tree order. */
function dwBridgeDatabases(state) {
  const databases = []
  for (const environment of Array.isArray(state.environments) ? state.environments : []) {
    for (const instance of Array.isArray(environment.instances) ? environment.instances : []) {
      for (const database of Array.isArray(instance.databases) ? instance.databases : []) {
        databases.push({
          dbId: database.id,
          database: String(database.name ?? ''),
          env: environment.env,
          envLabel: environment.label ?? environment.env,
          instanceLabel: instance.label ?? '',
        })
      }
    }
  }
  return databases
}

/** Wait until a workspace is the current root and discovery has settled. */
function dwBridgeWaitForRoot(store, root, deadline) {
  return new Promise((resolve, reject) => {
    const tick = () => {
      const state = store.getState()
      if (state.root === root && (state.phase === 'ready' || state.phase === 'empty' || state.phase === 'error')) {
        resolve(state)
        return
      }
      if (Date.now() > deadline) {
        reject(new Error(state.phase === 'error' ? 'discovery-failed' : 'workspace-timeout'))
        return
      }
      setTimeout(tick, 100)
    }
    tick()
  })
}

async function dwBridgeEnsureRoot(store, root, deadline) {
  if (store.getState().root !== root) {
    // Permanent switch, matching the workspace chip: the user came here to work
    // in this workspace, and the next request for the same root is instant.
    store.setManualRoot(root)
  }
  return await dwBridgeWaitForRoot(store, root, deadline)
}

/** Resolve one request; always answers exactly once. */
async function dwBridgeHandle(detail, deps) {
  const id = typeof detail?.id === 'string' ? detail.id : ''
  if (id === '') return
  const action = typeof detail?.action === 'string' ? detail.action : ''
  if (detail?.v !== DW_BRIDGE_VERSION) {
    dwBridgeRespond(id, action, { ok: false, reason: 'unsupported-version' })
    return
  }
  const root = typeof detail?.root === 'string' ? detail.root.trim() : ''
  if (root === '') {
    dwBridgeRespond(id, action, { ok: false, reason: 'invalid-root' })
    return
  }
  const { store, layout } = deps
  const deadline = Date.now() + DW_BRIDGE_TIMEOUT_MS
  try {
    if (action === 'openTable') {
      const table = String(detail.table ?? '').trim()
      if (table === '') throw new Error('invalid-table')
      const schema = typeof detail.schema === 'string' ? detail.schema.trim() : ''
      await dwBridgeEnsureRoot(store, root, deadline)
      const found = await dwRpc('findTable', { root, table, schema })
      const candidates = Array.isArray(found?.candidates) ? found.candidates : []
      if (candidates.length === 0) {
        dwBridgeRespond(id, action, { ok: false, reason: 'table-not-found', table })
        return
      }
      // Phase one: the first environment wins, the response carries the rest so the
      // caller can tell the user another database also has this table.
      const target = candidates[0]
      layout()?.selectPanel?.(DW_PANEL_ID)
      const sql = `SELECT *\nFROM \`${target.database}\`.\`${table}\`\nLIMIT 100`
      store.seedStatement({
        dbId: target.dbId,
        database: target.database,
        env: target.env,
        instanceLabel: target.instanceLabel ?? '',
        table,
      }, sql)
      await store.runActiveTab(sql)
      const state = store.getState()
      const tab = state.tabs.find((entry) => entry.id === `sql:${target.dbId}:tbl:${table}`)
      if (tab?.error !== undefined && tab.error !== '') {
        dwBridgeRespond(id, action, {
          ok: false,
          reason: 'query-failed',
          error: tab.error,
          database: target.database,
          env: target.env,
          candidates,
        })
        return
      }
      dwBridgeRespond(id, action, {
        ok: true,
        database: target.database,
        env: target.env,
        instanceLabel: target.instanceLabel ?? '',
        tabId: tab?.id ?? '',
        candidates,
      })
      return
    }
    if (action === 'openSql') {
      const sql = typeof detail.sql === 'string' ? detail.sql.trim() : ''
      if (sql === '') throw new Error('empty-sql')
      const title = String(detail.title ?? '').trim() || 'SQL'
      await dwBridgeEnsureRoot(store, root, deadline)
      const state = store.getState()
      const databases = dwBridgeDatabases(state)
      if (databases.length === 0) {
        dwBridgeRespond(id, action, { ok: false, reason: 'no-datasource' })
        return
      }
      const schema = typeof detail.schema === 'string' ? detail.schema.trim() : ''
      const target = databases.find((entry) => schema !== '' && entry.database === schema) ?? databases[0]
      layout()?.selectPanel?.(DW_PANEL_ID)
      // Paste only: Mapper SQL usually carries #{...} parameters and dynamic
      // fragments, so running it automatically would just produce an error.
      const tab = store.openSqlConsole({ ...target, sql, title })
      dwBridgeRespond(id, action, {
        ok: true,
        database: target.database,
        env: target.env,
        instanceLabel: target.instanceLabel ?? '',
        tabId: tab?.id ?? '',
      })
      return
    }
    dwBridgeRespond(id, action, { ok: false, reason: 'unknown-action' })
  } catch (error) {
    dwBridgeRespond(id, action, { ok: false, reason: String(error?.message ?? error) })
  }
}

/** Install the bridge; returns the disposer used by the plugin effect. */
function dwInstallBridge(deps) {
  const capability = Object.freeze({ v: DW_BRIDGE_VERSION })
  globalThis[DW_BRIDGE_CAPABILITY] = capability
  let queue = Promise.resolve()
  const bus = globalThis.window ?? globalThis
  const onRequest = (event) => {
    const detail = event?.detail
    if (detail === null || typeof detail !== 'object') return
    queue = queue.then(() => dwBridgeHandle(detail, deps)).catch(() => undefined)
  }
  bus.addEventListener(DW_BRIDGE_REQUEST, onRequest)
  return () => {
    bus.removeEventListener(DW_BRIDGE_REQUEST, onRequest)
    if (globalThis[DW_BRIDGE_CAPABILITY] === capability) delete globalThis[DW_BRIDGE_CAPABILITY]
  }
}
