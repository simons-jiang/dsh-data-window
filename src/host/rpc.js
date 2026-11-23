/**
 * The RPC surface the browser talks to.
 *
 * One route, one action per request. The Client never learns a password: it names
 * an opaque target id (`d:…` for a database, `i:…` for an instance) that discovery
 * registered in the Host, and only this module holds the credential map.
 */
import { existsSync, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { DiscoveryCache, fingerprint } from './cache.js'
import { ConsoleStore } from './consoles.js'
import { discoverProject } from './discovery.js'
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
    this.pending = new Map()
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
          this.gateway.setTargets(targets)
          return { ...cached.payload, cached: true, generatedAt: cached.at }
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
      return value
    })()
    this.pending.set(root, task)
    try {
      return await task
    } finally {
      this.pending.delete(root)
    }
  }

  /** Dispatch one action. */
  async handle(action, payload = {}) {
    switch (String(action ?? '')) {
      case 'discover':
        return this.discover(payload)
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
