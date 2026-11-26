/**
 * The RPC surface the browser talks to.
 *
 * One route, one action per request. The Client never learns a password: it names
 * an opaque target id (`d:…` for a database, `i:…` for an instance) that discovery
 * registered in the Host, and only this module holds the credential map.
 */
import { existsSync, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { AiDiscovery } from './ai.js'
import { ConnectionCatalog } from './catalog.js'
import { DiscoveryCache, fingerprint } from './cache.js'
import { ConsoleStore } from './consoles.js'
import { discoverProject } from './discovery.js'
import { FavoriteStore } from './favorites.js'
import { ManualStore, manualEnvironments, normalizeManualEntry } from './manual.js'
import { stableId } from './discovery.js'
import { RememberedStore } from './remembered.js'
import { buildSharedTree } from './shared.js'
import { DataGateway, ReadOnlyViolation } from './mysql.js'

/** Payload ceiling for one request. */
export const MAX_BODY_BYTES = 4 * 1024 * 1024

/** Resolved plugin configuration with the defaults this build ships. */
export function resolveConfig(config = {}) {
  const number = (value, fallback, minimum, maximum) => {
    const parsed = Number(value)
    if (!Number.isFinite(parsed)) return fallback
    return Math.min(maximum, Math.max(minimum, parsed))
  }
  return {
    nacosHome: typeof config.nacosHome === 'string' ? config.nacosHome : '',
    groups: Array.isArray(config.groups) ? config.groups.filter((group) => typeof group === 'string') : [],
    envOrder: Array.isArray(config.envOrder) ? config.envOrder.filter((env) => typeof env === 'string') : [],
    connectTimeoutMs: number(config.connectTimeoutMs, 8000, 2000, 60000),
    statementTimeoutMs: number(config.statementTimeoutMs, 60000, 0, 600000),
    connectionLimit: number(config.connectionLimit, 4, 1, 16),
    defaultLimit: number(config.defaultLimit, 200, 1, 5000),
    cache: config.cache === false ? false : true,
  }
}

export function createGateway(config) {
  return new DataGateway({ ...config })
}

/** One Host-side controller shared by every request the browser makes. */
export class DataController {
  constructor(options = {}) {
    this.config = resolveConfig(options.config ?? {})
    this.gateway = options.gateway ?? createGateway(this.config)
    this.cache = options.cache ?? new DiscoveryCache(options.cacheDirectory ?? '', options.pluginVersion ?? '')
    this.consoles = options.consoles ?? new ConsoleStore(options.cacheDirectory === undefined || options.cacheDirectory === '' ? '' : join(options.cacheDirectory, 'workspaces'))
    // Manual connections and picked databases are shared by every workspace: the
    // resource tree is one tree, so its user-owned parts cannot be per workspace.
    this.manual = options.manual ?? new ManualStore(options.cacheDirectory === undefined || options.cacheDirectory === '' ? '' : join(options.cacheDirectory, 'manual'), { shared: true })
    this.remembered = options.remembered ?? new RememberedStore(options.cacheDirectory === undefined || options.cacheDirectory === '' ? '' : join(options.cacheDirectory, 'remembered'), { shared: true })
    // Saved statements are shared like the tree: a name and a schema/table pair
    // outlive the workspace that produced them.
    this.favoriteStore = options.favorites ?? new FavoriteStore(options.cacheDirectory === undefined || options.cacheDirectory === '' ? '' : join(options.cacheDirectory, 'favorites'))
    this.catalog = options.catalog ?? new ConnectionCatalog(options.cacheDirectory ?? '')
    // `llm` is a getter: the Host may provide the LLM service after this plugin
    // activates, and the fallback must not pin a service that is still arriving.
    this.ai = options.ai ?? new AiDiscovery({
      llm: options.llm,
      defaultModel: options.defaultModel,
      gateway: this.gateway,
      config: this.config,
    })
    this.pending = new Map()
  }

  /**
   * Which configured databases contain a table.
   *
   * The code workspace only knows the table name from `@TableName`; resolving it
   * here keeps the browser from guessing. Only the project's own databases are
   * searched, one `information_schema` probe each.
   */
  async findTable(payload = {}) {
    const root = typeof payload.root === 'string' ? payload.root.trim() : ''
    if (root === '' || !isAbsolute(root)) throw new RouteFailure(400, 'invalid-root', 'workspace root must be an absolute path')
    const table = typeof payload.table === 'string' ? payload.table.trim() : ''
    if (table === '') throw new RouteFailure(400, 'invalid-table', 'table name is required')
    const schema = typeof payload.schema === 'string' ? payload.schema.trim() : ''
    const discovered = await this.discover({ root })
    const candidates = []
    for (const environment of Array.isArray(discovered.environments) ? discovered.environments : []) {
      for (const instance of Array.isArray(environment.instances) ? environment.instances : []) {
        for (const database of Array.isArray(instance.databases) ? instance.databases : []) {
          const name = String(database.name ?? '')
          if (name === '') continue
          if (schema !== '' && name !== schema) continue
          try {
            if (await this.gateway.hasTable(database.id, name, table)) {
              candidates.push({
                dbId: database.id,
                database: name,
                env: environment.env,
                envLabel: environment.label ?? environment.env,
                instanceLabel: instance.label ?? '',
              })
            }
          } catch (error) {
            void error
          }
        }
      }
    }
    return { root, table, schema, candidates }
  }

  /** Re-read the workspace configuration, or serve it from the cache. */
  async discover(payload = {}) {
    const root = typeof payload.root === 'string' ? payload.root.trim() : ''
    if (root === '' || !isAbsolute(root)) throw new RouteFailure(400, 'invalid-root', 'workspace root must be an absolute path')
    if (!existsSync(root) || !statSync(root).isDirectory()) throw new RouteFailure(404, 'missing-root', `workspace not found: ${root}`)

    const refresh = payload.refresh === true
    if (!refresh) {
      const cached = this.cache.get(root)
      if (cached !== undefined && cached.payload !== undefined) {
        const paths = Array.isArray(cached.fingerprintPaths) ? cached.fingerprintPaths : []
        if (this.config.cache && fingerprint(paths) === cached.fingerprint) {
          const targets = new Map(Array.isArray(cached.targets) ? cached.targets : [])
          return this.withSharedTree(root, { ...cached.payload, cached: true, generatedAt: cached.at }, targets)
        }
      }
    }

    // Two panels opening the same workspace at once must not scan twice.
    const running = this.pending.get(root)
    if (running !== undefined) return running
    const startedAt = Date.now()
    const task = (async () => {
      const discovery = discoverProject(root, {
        home: this.config.nacosHome,
        groups: this.config.groups,
        envOrder: this.config.envOrder,
      })
      const { targets, ...rest } = discovery
      this.gateway.setTargets(targets)
      const fingerprintPaths = []
      for (const environment of rest.environments) {
        for (const file of environment.variableFiles ?? []) fingerprintPaths.push(file)
        for (const source of environment.sources) fingerprintPaths.push(source)
      }
      for (const file of rest.project?.configFiles ?? []) fingerprintPaths.push(file)
      const value = {
        ...rest,
        cached: false,
        generatedAt: Date.now(),
        elapsedMs: Date.now() - startedAt,
      }
      // An empty result is deliberately not cached: a service that starts after the
      // first open, or a datasource added to a workspace that had none, must show up
      // without the user having to press "reload". Scanning an empty workspace is
      // cheap; a stale empty tree is not.
      if (this.config.cache && rest.environments.length > 0) {
        this.cache.put(root, {
          payload: rest,
          targets: [...(targets instanceof Map ? targets : new Map())],
          fingerprintPaths,
          fingerprint: fingerprint(fingerprintPaths),
        })
      }
      return this.withSharedTree(root, value, targets)
    })()
    this.pending.set(root, task)
    try {
      return await task
    } finally {
      this.pending.delete(root)
    }
  }

  /**
   * Merge this workspace into the machine-wide resource tree.
   *
   * The tree is the union of every workspace's discovery cache, the shared manual
   * connections and the shared database picks; the workspace being opened only
   * contributes its own part and names it in `focus` so the panel can expand it.
   * Ids are unchanged, so saved consoles keep resolving their targets.
   *
   * @param root the workspace being opened
   * @param payload its own discovery payload
   * @param targets its own connection targets (the union's credentials come from
   *   every cache, so this is the most recent word on this workspace's hosts)
   */
  withSharedTree(root, payload, targets) {
    const tree = buildSharedTree({
      caches: this.cache.list().filter((document) => document.root !== root),
      current: payload,
      currentTargets: targets instanceof Map ? targets : new Map(),
      manualEntries: this.manual.load(root).entries,
      remembered: this.remembered.load(root).databases,
      envOrder: this.config.envOrder,
    })
    this.gateway.setTargets(tree.targets)
    return {
      ...payload,
      environments: tree.environments,
      focus: tree.focus,
      shared: true,
      defaultEnv: payload.defaultEnv ?? tree.focus.envs[0],
    }
  }

  /** Remember one database the user opened from an instance's full list. */
  rememberDatabase(payload = {}) {
    const root = typeof payload.root === 'string' ? payload.root.trim() : ''
    if (root === '' || !isAbsolute(root)) throw new RouteFailure(400, 'invalid-root', 'workspace root must be an absolute path')
    const entry = { instanceId: String(payload.instanceId ?? '').trim(), database: String(payload.database ?? '').trim() }
    if (!/^i:[\w-]+$/.test(entry.instanceId) || entry.database === '') {
      throw new RouteFailure(400, 'invalid-database', 'an instance id and a database name are required')
    }
    return { remembered: this.remembered.add(root, entry) }
  }

  /** Connections already resolved or added on this machine, without passwords. */
  savedConnections() {
    return { connections: this.catalog.list() }
  }

  /** Replace the databases shown for one instance (the picker's Apply). */
  selectDatabases(payload = {}) {
    const root = typeof payload.root === 'string' ? payload.root.trim() : ''
    if (root === '' || !isAbsolute(root)) throw new RouteFailure(400, 'invalid-root', 'workspace root must be an absolute path')
    const instanceId = String(payload.instanceId ?? '').trim()
    if (!/^i:[\w-]+$/.test(instanceId)) throw new RouteFailure(400, 'invalid-database', 'an instance id is required')
    const names = Array.isArray(payload.databases) ? payload.databases : []
    if (names.length > 200) throw new RouteFailure(400, 'invalid-database', 'too many databases selected')
    const value = this.remembered.replaceInstance(root, instanceId, names)
    return { databases: value.databases }
  }

  /** Forget one remembered database. */
  forgetDatabase(payload = {}) {
    const root = typeof payload.root === 'string' ? payload.root.trim() : ''
    if (root === '' || !isAbsolute(root)) throw new RouteFailure(400, 'invalid-root', 'workspace root must be an absolute path')
    const entry = { instanceId: String(payload.instanceId ?? '').trim(), database: String(payload.database ?? '').trim() }
    if (!/^i:[\w-]+$/.test(entry.instanceId) || entry.database === '') {
      throw new RouteFailure(400, 'invalid-database', 'an instance id and a database name are required')
    }
    return { forgotten: this.remembered.remove(root, entry) }
  }

  /** Every saved statement; the Client groups them by schema and table. */
  favorites() {
    return this.favoriteStore.list()
  }

  /** Create or update one saved statement under a unique name. */
  saveFavorite(payload = {}) {
    try {
      return this.favoriteStore.upsert(payload.favorite ?? payload)
    } catch (error) {
      throw favoriteRouteFailure(error)
    }
  }

  /** Forget one saved statement by id. */
  removeFavorite(payload = {}) {
    try {
      return this.favoriteStore.remove(payload.id)
    } catch (error) {
      throw favoriteRouteFailure(error)
    }
  }

  /**
   * Save one manually entered connection after proving it.
   *
   * The connection test uses the same read-only gateway as everything else, so a
   * mistyped host or account fails here with the server's message instead of
   * becoming a row that never opens.
   */
  async manualSave(payload = {}) {
    const root = typeof payload.root === 'string' ? payload.root.trim() : ''
    if (root === '' || !isAbsolute(root)) throw new RouteFailure(400, 'invalid-root', 'workspace root must be an absolute path')
    const submitted = payload.entry !== null && typeof payload.entry === 'object' ? { ...payload.entry } : undefined
    // The picker sends `sourceId` instead of a password: the credential stays on the
    // Host, which is also what lets another workspace's connection be reused without
    // the browser ever seeing its secret.
    const sourceId = typeof payload.sourceId === 'string' ? payload.sourceId.trim() : ''
    if (sourceId !== '' && String(submitted?.password ?? '') === '') {
      const stored = this.catalog.passwordFor(sourceId)
      if (stored === undefined) throw new RouteFailure(400, 'saved-connection-missing', 'the imported connection is no longer available')
      submitted.password = stored
    }
    const entry = normalizeManualEntry(submitted)
    if (entry === undefined) throw new RouteFailure(400, 'invalid-connection', 'host, port and user are required')
    const probeId = `m:${entry.id.slice(2)}:probe`
    try {
      this.gateway.addTargets(new Map([[probeId, {
        id: probeId,
        env: 'manual',
        host: entry.host,
        port: entry.port,
        user: entry.user,
        password: entry.password,
        database: entry.database === '' ? undefined : entry.database,
        manual: true,
      }]]))
      await this.gateway.ping(probeId)
    } catch (error) {
      await this.gateway.forget(probeId).catch(() => undefined)
      throw new RouteFailure(400, 'manual-connect-failed', error?.message ?? String(error))
    }
    await this.gateway.forget(probeId).catch(() => undefined)
    this.manual.upsert(root, entry)
    return { entry: { ...entry, password: undefined }, environments: manualEnvironments(this.manual.load(root).entries).environments }
  }

  /**
   * Rename one manually added environment.
   *
   * The environment name is part of every derived id (entry, instance, remembered
   * schemas), so a rename moves all three together — otherwise the user's picked
   * databases would be stranded under an id nothing renders any more.
   */
  renameManualEnvironment(payload = {}) {
    const root = typeof payload.root === 'string' ? payload.root.trim() : ''
    if (root === '' || !isAbsolute(root)) throw new RouteFailure(400, 'invalid-root', 'workspace root must be an absolute path')
    const from = String(payload.from ?? '').trim()
    const to = String(payload.to ?? '').trim().slice(0, 40)
    if (from === '' || to === '') throw new RouteFailure(400, 'invalid-connection', 'both names are required')
    const { entries } = this.manual.load(root)
    const affected = entries.filter((entry) => entry.label === from)
    if (affected.length === 0) throw new RouteFailure(404, 'unknown-environment', 'no manual connection uses that environment name')
    if (from === to) return { renamed: 0 }
    const untouched = entries.filter((entry) => entry.label !== from)
    const renamed = []
    for (const entry of affected) {
      const next = normalizeManualEntry({ ...entry, label: to })
      if (next === undefined) continue
      if (untouched.some((existing) => existing.id === next.id)) {
        throw new RouteFailure(400, 'duplicate-connection', 'another connection already uses that name for this host and account')
      }
      renamed.push(next)
    }
    const mapping = new Map()
    for (const entry of affected) {
      const next = renamed.find((candidate) => candidate.host === entry.host && candidate.port === entry.port && candidate.user === entry.user)
      if (next === undefined) continue
      mapping.set(
        `i:${stableId('manual', `manual:${stableId('manual-env', from)}`, entry.host, String(entry.port), entry.user)}`,
        `i:${stableId('manual', `manual:${stableId('manual-env', to)}`, entry.host, String(entry.port), entry.user)}`,
      )
    }
    this.manual.save(root, [...untouched, ...renamed])
    this.remembered.remap(root, mapping)
    return { renamed: renamed.length }
  }

  /**
   * Delete one manually added environment: every connection under it, the schemas
   * picked for them, and the pools those schemas used.
   *
   * The connection stays re-importable: its catalog entry comes from other
   * workspaces' data, not from this one, so "unless imported again" is exactly how
   * it behaves.
   */
  removeManualEnvironment(payload = {}) {
    const root = typeof payload.root === 'string' ? payload.root.trim() : ''
    if (root === '' || !isAbsolute(root)) throw new RouteFailure(400, 'invalid-root', 'workspace root must be an absolute path')
    const from = String(payload.from ?? '').trim()
    if (from === '') throw new RouteFailure(400, 'invalid-connection', 'an environment name is required')
    const { entries } = this.manual.load(root)
    const affected = entries.filter((entry) => entry.label === from)
    if (affected.length === 0) throw new RouteFailure(404, 'unknown-environment', 'no manual connection uses that environment name')
    const { targets } = manualEnvironments(affected)
    const instanceIds = [...targets.values()].filter((target) => target.database === undefined).map((target) => target.id)
    this.manual.save(root, entries.filter((entry) => entry.label !== from))
    this.remembered.forgetInstances(root, instanceIds)
    if (typeof this.gateway.removeTargets === 'function') this.gateway.removeTargets([...targets.keys()])
    return { removed: affected.length }
  }

  /** Drop one manually added connection. */
  async manualRemove(payload = {}) {
    const root = typeof payload.root === 'string' ? payload.root.trim() : ''
    const id = typeof payload.id === 'string' ? payload.id.trim() : ''
    if (root === '' || !isAbsolute(root)) throw new RouteFailure(400, 'invalid-root', 'workspace root must be an absolute path')
    if (id === '') throw new RouteFailure(400, 'invalid-connection', 'a connection id is required')
    const before = manualEnvironments(this.manual.load(root).entries).targets
    const removed = this.manual.remove(root, id)
    const after = manualEnvironments(this.manual.load(root).entries).targets
    if (removed && typeof this.gateway.removeTargets === 'function') {
      // The tree no longer names these ids, so their pools must not stay open.
      const stale = [...before.keys()].filter((key) => !after.has(key))
      this.gateway.removeTargets(stale)
    }
    return { removed, environments: manualEnvironments(this.manual.load(root).entries).environments }
  }

  /**
   * Analyze the workspace with one model. Model text is only a proposal: the
   * answer is parsed, its cited paths are confined to the workspace, and every
   * candidate is proven with a real connection before it reaches the tree.
   */
  async aiDiscover(payload = {}) {
    try {
      return await this.ai.run(payload)
    } catch (error) {
      const code = typeof error?.code === 'string' ? error.code : 'ai-failed'
      if (code === 'llm-unavailable') throw new RouteFailure(503, code, error?.message ?? String(error))
      if (code === 'invalid-ai-request') throw new RouteFailure(400, code, error?.message ?? String(error))
      throw new RouteFailure(502, 'ai-failed', error?.message ?? String(error))
    }
  }

  /** Ask the configured model to optimize one statement (advisory, never executed). */
  async optimizeSql(payload = {}) {
    try {
      return await this.ai.optimize(payload)
    } catch (error) {
      const code = typeof error?.code === 'string' ? error.code : 'ai-failed'
      if (code === 'llm-unavailable') throw new RouteFailure(503, code, error?.message ?? String(error))
      if (code === 'invalid-ai-request' || code === 'invalid-ai-answer') throw new RouteFailure(400, code, error?.message ?? String(error))
      throw new RouteFailure(502, 'ai-failed', error?.message ?? String(error))
    }
  }

  /** Dispatch one action. */
  async handle(action, payload = {}) {
    switch (String(action ?? '')) {
      case 'discover':
        return this.discover(payload)
      case 'models':
        return this.ai.models()
      case 'aiDiscover':
        return this.aiDiscover(payload)
      case 'optimizeSql':
        return this.optimizeSql(payload)
      case 'manualSave':
        return this.manualSave(payload)
      case 'savedConnections':
        return this.savedConnections()
      case 'manualRemove':
        return this.manualRemove(payload)
      case 'renameManualEnvironment':
        return this.renameManualEnvironment(payload)
      case 'removeManualEnvironment':
        return this.removeManualEnvironment(payload)
      case 'rememberDatabase':
        return this.rememberDatabase(payload)
      case 'forgetDatabase':
        return this.forgetDatabase(payload)
      case 'favorites':
        return this.favorites()
      case 'saveFavorite':
        return this.saveFavorite(payload)
      case 'removeFavorite':
        return this.removeFavorite(payload)
      case 'selectDatabases':
        return this.selectDatabases(payload)
      case 'ping':
        return this.gateway.ping(payload.id)
      case 'databases':
        return this.gateway.listDatabases(payload.id)
      case 'tables':
        return this.gateway.listTables(payload.id)
      case 'columns':
        return this.gateway.listColumns(payload.id, payload.table)
      case 'schema':
        return this.gateway.schemaMap(payload.id)
      case 'findTable':
        return this.findTable(payload)
      case 'consoles':
        return this.consoles.load(payload.root)
      case 'saveConsoles':
        return this.consoles.save(payload.root, payload.value)
      case 'ddl':
        return this.gateway.showCreate(payload.id, payload.table)
      case 'count':
        return this.gateway.countRows(payload.id, payload.sql)
      case 'query':
        return this.gateway.run(payload.id, payload.sql, { limit: payload.limit ?? this.config.defaultLimit })
      case 'forget':
        return { forgotten: await this.gateway.forget(payload.id) }
      case 'config':
        return {
          nacosHome: this.config.nacosHome,
          groups: this.config.groups,
          defaultLimit: this.config.defaultLimit,
          statementTimeoutMs: this.config.statementTimeoutMs,
        }
      default:
        throw new RouteFailure(404, 'unknown-action', `unknown action: ${String(action ?? '')}`)
    }
  }

  async close() {
    await this.gateway.close()
  }
}

/** A failure with an HTTP status the route maps directly. */
export class RouteFailure extends Error {
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
  }
}

/**
 * Map one saved-SQL failure to the status the route should answer.
 *
 * A duplicate name is the one failure the user can fix in the dialog, so it gets
 * its own code; the Client turns it into a sentence instead of an enum.
 */
function favoriteRouteFailure(error) {
  const code = typeof error?.code === 'string' ? error.code : 'favorite-failed'
  const status = code === 'duplicate-favorite'
    ? 409
    : code === 'unknown-favorite'
      ? 404
      : code === 'favorite-unavailable'
        ? 503
        : 400
  return new RouteFailure(status, code, error?.message ?? String(error))
}

/** Map any thrown value into the shape the route writes. */
export function toRouteError(error) {
  if (error instanceof RouteFailure) return { status: error.status, code: error.code, message: error.message }
  if (error instanceof ReadOnlyViolation) {
    return { status: 400, code: error.code, message: error.message }
  }
  const code = typeof error?.code === 'string' ? error.code : 'internal'
  // A target that discovery dropped (a Host restart, a workspace switch) is not a
  // bug in the query, so it gets its own code for the Client to recover from.
  const status = code === 'unknown-target' ? 409 : code === 'database-required' ? 400 : 500
  return { status, code, message: error?.message ?? String(error) }
}
