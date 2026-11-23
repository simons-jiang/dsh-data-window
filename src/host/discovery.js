/**
 * Workspace configuration discovery.
 *
 * A project rarely spells out its database host: the datasource block inside its
 * Nacos data-id references `${some.namespace.<alias>}` placeholders whose values
 * live in another data-id of the same snapshot. Both halves are cached locally by
 * the Nacos client under `~/nacos/config`, so the plugin resolves the chain the
 * same way the JVM does:
 *
 *   project bootstrap.yml  → spring.application.name
 *   nacos snapshot         → <group>/<app-name>   (jdbc url, schema name)
 *   nacos snapshot         → any other YAML file  (the values the placeholders need)
 *
 * The data-id that carries those values is a per-project decision: `yunwei-db.yml`
 * in some repositories, `db.yml`, `datasource.yml` or an ops-specific name in
 * others. Nothing here assumes a file name: every YAML file in the group is a
 * candidate, and the placeholders in the project's own datasource decide which
 * values matter.
 *
 * The result is one entry per environment, which is what the UI shows as
 * "环境 → 实例 → 库".
 *
 * Only the instances and databases this project's own `spring.datasource`
 * entries name are returned. Hosts declared by other means never reach the tree,
 * because those belong to other projects and this project has no account for them.
 */
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { homedir } from 'node:os'
import { flattenYaml, parseYaml, placeholderNames, readVariables, resolveTemplate } from './yaml.js'

/** Directories that never hold a project's own configuration. */
const SKIP_DIRECTORIES = new Set(['node_modules', 'target', 'build', 'dist', 'out', '.git', '.idea', '.gradle', 'test', 'tests'])

/** How deep to look for `src/main/resources`. */
const MAX_DEPTH = 7

/** How many configuration files one project may contribute. */
const MAX_PROJECT_FILES = 60

/** Schemas nobody browses in a work viewer. */
const SYSTEM_SCHEMAS = new Set(['information_schema', 'mysql', 'performance_schema', 'sys', '__recycle_bin__'])

/** Stable short id for a connection target. */
export function stableId(...parts) {
  const hash = createHash('sha1')
  hash.update(parts.join('\u0000'))
  return hash.digest('hex').slice(0, 14)
}

/** Escape a value for a `LIKE` pattern. */
export function likeEscape(value) {
  return String(value).replace(/[\\%_]/g, (character) => `\\${character}`)
}

/** Read a file as UTF-8, or `undefined` when it is missing or unreadable. */
function readText(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch (error) {
    void error
    return undefined
  }
}

/** `~/nacos` unless the user configured another home. */
export function nacosHome(configured) {
  const value = typeof configured === 'string' ? configured.trim() : ''
  if (value === '') return join(homedir(), 'nacos')
  return value.startsWith('~') ? join(homedir(), value.slice(1)) : value
}

/** The application name a project's own configuration declares. */
function applicationNamesIn(text) {
  const names = []
  for (const document of parseYaml(text)) {
    for (const [key, value] of flattenYaml(document)) {
      if (key !== 'spring.application.name') continue
      if (typeof value !== 'string') continue
      const normalized = value.trim()
      if (normalized !== '' && !normalized.includes('${') && !names.includes(normalized)) names.push(normalized)
    }
  }
  return names
}

/** Walk the project for `bootstrap.yml` / `application.yml` style configuration. */
function projectConfigFiles(root) {
  const files = []
  const walk = (directory, depth) => {
    if (depth > MAX_DEPTH || files.length >= MAX_PROJECT_FILES) return
    let entries
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch (error) {
      void error
      return
    }
    for (const entry of entries) {
      if (files.length >= MAX_PROJECT_FILES) return
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIRECTORIES.has(entry.name)) continue
        walk(path, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      if (!/^(bootstrap|application)(-[A-Za-z0-9._-]+)?\.(yml|yaml)$/.test(entry.name)) continue
      files.push(path)
    }
  }
  walk(root, 0)
  return files
}

/** Locate every Nacos snapshot directory this machine cached. */
export function nacosSnapshots(home) {
  const configRoot = join(home, 'config')
  const snapshots = []
  let keys
  try {
    keys = readdirSync(configRoot, { withFileTypes: true })
  } catch (error) {
    void error
    return snapshots
  }
  for (const key of keys) {
    if (!key.isDirectory()) continue
    const base = join(configRoot, key.name)
    // The local cache namespaces per tenant as `snapshot-tenant/<tenant>`; a
    // cache without a namespace keeps the group folders directly in `snapshot`.
    const candidates = [
      { dir: join(base, 'snapshot-tenant'), perTenant: true },
      { dir: join(base, 'snapshot'), perTenant: false },
    ]
    for (const candidate of candidates) {
      if (!existsSync(candidate.dir)) continue
      if (candidate.perTenant) {
        let tenants = []
        try {
          tenants = readdirSync(candidate.dir, { withFileTypes: true }).filter((entry) => entry.isDirectory())
        } catch (error) {
          void error
          continue
        }
        for (const tenant of tenants) {
          snapshots.push({ cache: key.name, env: tenant.name, dir: join(candidate.dir, tenant.name) })
        }
      } else {
        snapshots.push({ cache: key.name, env: 'default', dir: candidate.dir })
      }
    }
  }
  return snapshots
}

/** Group folders (`business`, `ops`, …) inside one snapshot. */
function groupDirectories(snapshotDir, groups) {
  let entries = []
  try {
    entries = readdirSync(snapshotDir, { withFileTypes: true }).filter((entry) => entry.isDirectory())
  } catch (error) {
    void error
    return []
  }
  const allowed = Array.isArray(groups) && groups.length > 0 ? new Set(groups) : undefined
  return entries
    .filter((entry) => allowed === undefined || allowed.has(entry.name))
    .map((entry) => ({ group: entry.name, dir: join(snapshotDir, entry.name) }))
}

/** Every `jdbc:mysql://host:port/schema` datasource a document set declares. */
export function datasourceEntries(text) {
  const entries = []
  const seen = new Set()
  for (const document of parseYaml(text)) {
    const flat = flattenYaml(document)
    // A datasource is any subtree that carries a `url`/`jdbc-url` and sits under a
    // path segment named `datasource` (primary, `dwd.datasource`, `shardingsphere…`).
    for (const [key, value] of flat) {
      if (typeof value !== 'string') continue
      if (!/(^|\.)(url|jdbc-url)$/.test(key)) continue
      if (!/^jdbc:mysql:\/\//i.test(value)) continue
      const prefix = key.replace(/\.(url|jdbc-url)$/, '')
      if (!/datasource/i.test(prefix)) continue
      if (seen.has(prefix)) continue
      seen.add(prefix)
      entries.push({
        prefix,
        url: value,
        username: flat.get(`${prefix}.username`) ?? flat.get(`${prefix}.user`) ?? '',
        password: flat.get(`${prefix}.password`) ?? flat.get(`${prefix}.passwd`) ?? '',
      })
    }
  }
  return entries
}

/**
 * Split a resolved JDBC URL into its host, port and schema.
 *
 * The authority is a comma separated list when the driver fails over, so only the
 * first host is used; the viewer connects to one instance at a time.
 */
export function parseJdbcUrl(url) {
  const match = /^jdbc:mysql:\/\/([^/?#]+)\/([^?#]*)/i.exec(String(url).trim())
  if (match === null) return undefined
  const authority = match[1].split(',')[0].trim()
  const schema = decodeURIComponent(match[2].trim())
  const separator = authority.lastIndexOf(':')
  const host = separator > 0 && /^[0-9]+$/.test(authority.slice(separator + 1)) ? authority.slice(0, separator) : authority
  const port = separator > 0 && /^[0-9]+$/.test(authority.slice(separator + 1)) ? Number(authority.slice(separator + 1)) : 3306
  if (host === '') return undefined
  return { host, port, schema }
}

/** Placeholders whose last segment names nothing a user would recognise. */
const GENERIC_PLACEHOLDER_NAMES = new Set(['host', 'hostname', 'url', 'addr', 'address', 'server', 'endpoint', 'port'])

/**
 * The alias a project gives a host, read from its own URL template.
 *
 * `jdbc:mysql://${acme.dbs.mysql-main}/shop` names the host `mysql-main`. Nothing
 * else has to know where that variable is defined or how the operations team names
 * their file, which is why this replaced the old fixed-namespace alias scan.
 */
function hostAliasOf(template) {
  const match = /^jdbc:mysql:\/\/([^/?#]+)\//i.exec(String(template ?? '').trim())
  if (match === null) return undefined
  const authority = match[1].split(',')[0].trim().replace(/:\d+$/, '')
  const placeholder = /^\$\{([^}:]+)(?::[^}]*)?\}$/.exec(authority)
  if (placeholder === null) return undefined
  const alias = placeholder[1].split('.').filter(Boolean).pop()
  if (alias === undefined || alias === '') return undefined
  if (GENERIC_PLACEHOLDER_NAMES.has(alias.toLowerCase())) return undefined
  return alias
}

/** Build the connection object the MySQL layer expects. */
function connectionOf({ host, port, user, password }) {
  return { host, port, user, password }
}

/**
 * The Nacos servers a project's own bootstrap declares.
 *
 * `server-addr` is normally a placeholder whose fallback carries the real
 * address, so the fallback is what identifies the local cache directory. The host
 * alone is enough: cache directories are named `fixed-<host>[-<env>]_nacos`.
 */
function projectNacosServers(files) {
  const servers = []
  const consider = (value) => {
    if (typeof value !== 'string') return
    const text = value.trim()
    if (text === '') return
    const withoutScheme = text.replace(/^[a-z]+:\/\//i, '')
    const host = withoutScheme.split(':')[0].split('/')[0].trim()
    if (host === '' || host.includes('${') || host.includes('}')) return
    if (!/^[A-Za-z0-9._-]+$/.test(host)) return
    if (!servers.includes(host)) servers.push(host)
  }
  for (const file of files) {
    const text = readText(file)
    if (text === undefined) continue
    for (const document of parseYaml(text)) {
      for (const [key, value] of flattenYaml(document)) {
        if (!/nacos\.(config|discovery)\.(server-addr|endpoint)$/i.test(key)) continue
        const resolved = resolveTemplate(String(value ?? ''), new Map())
        consider(resolved)
        const fallback = /\$\{[^}]*:([^}]*)\}/.exec(String(value ?? ''))
        if (fallback !== null) consider(fallback[1])
      }
    }
  }
  return servers
}

/**
 * Discover every environment the current project can reach.
 *
 * @param root absolute workspace path
 * @param options `{ home, groups, envOrder }`
 */
export function discoverProject(root, options = {}) {
  const home = nacosHome(options.home)
  const groups = Array.isArray(options.groups) ? options.groups : []
  const warnings = []

  const configFiles = projectConfigFiles(root)
  const applicationNames = []
  for (const file of configFiles) {
    const text = readText(file)
    if (text === undefined) continue
    for (const name of applicationNamesIn(text)) {
      if (!applicationNames.includes(name)) applicationNames.push(name)
    }
  }
  const fallbackName = basename(root)
  if (applicationNames.length === 0) {
    applicationNames.push(fallbackName)
    warnings.push('project-no-application-name')
  }

  const snapshots = nacosSnapshots(home)
  if (snapshots.length === 0) warnings.push('nacos-cache-missing')

  // Which Nacos server the project itself points at decides which local cache is
  // authoritative: several caches can hold a tenant with the same name (`dev1`
  // exists under both the application Nacos and another cluster's Nacos), and merging
  // would put another cluster's hosts into this project's tree.
  const servers = projectNacosServers(configFiles)

  /** Every environment one cache declares, before a single cache is chosen. */
  const candidatesByEnv = new Map()

  for (const snapshot of snapshots) {
    const groupDirs = groupDirectories(snapshot.dir, groups)
    if (groupDirs.length === 0) continue

    // The project's data-ids are the ones named after `spring.application.name`;
    // every other YAML file in the groups is a candidate variable source. Which
    // data-id carries the host and credential map differs per project
    // (`yunwei-db.yml` in some, `db.yml` / `datasource.yml` / … in others), so no
    // file name is singled out: the placeholders in the project's own configuration
    // decide which values are needed.
    const projectFiles = []
    const variableFiles = []
    for (const groupDir of groupDirs) {
      let entries = []
      try {
        entries = readdirSync(groupDir.dir, { withFileTypes: true }).filter((entry) => entry.isFile())
      } catch (error) {
        void error
        continue
      }
      for (const entry of entries) {
        const name = entry.name
        // Nacos keeps a data-id either as `name` or as `name.yml`; both spellings
        // occur in the same snapshot, so neither may be assumed.
        if (!/\.(ya?ml)$/i.test(name) && name.includes('.')) continue
        const dataId = name.replace(/\.(ya?ml)$/i, '')
        const file = join(groupDir.dir, name)
        const item = { file, group: groupDir.group }
        if (applicationNames.includes(dataId)) projectFiles.push(item)
        else variableFiles.push(item)
      }
    }

    // Read the project's own files first; without a datasource there is nothing to
    // resolve and no reason to read the rest of the group.
    const projectTexts = []
    for (const { file } of projectFiles) {
      const text = readText(file)
      if (text === undefined) continue
      const datasources = datasourceEntries(text)
      if (datasources.length === 0) continue
      projectTexts.push({ file, text, datasources })
    }
    if (projectTexts.length === 0) continue

    // Only files that define a placeholder the project actually references are
    // read: a group holds every service's data-id, and reading them all would drag
    // other services' values into the picture. One placeholder's value can name
    // another key, so the search repeats until no new file matches.
    const needed = new Set()
    for (const { datasources } of projectTexts) {
      for (const datasource of datasources) {
        for (const value of [datasource.url, datasource.username, datasource.password]) {
          for (const key of placeholderNames(value)) needed.add(key)
        }
      }
    }

    // A value defined beside the project wins over the same key in another group:
    // one environment often carries several teams' maps.
    const projectGroups = new Set(projectFiles.map((entry) => entry.group))
    const orderedFiles = [
      ...variableFiles.filter((entry) => projectGroups.has(entry.group)),
      ...variableFiles.filter((entry) => !projectGroups.has(entry.group)),
    ]
    const parsedFiles = new Map()
    const variablesOf = (file) => {
      if (!parsedFiles.has(file)) {
        const text = readText(file)
        parsedFiles.set(file, text === undefined ? undefined : readVariables(text))
      }
      return parsedFiles.get(file)
    }
    const variables = new Map()
    const readVariableFiles = []
    let merged = true
    while (merged && needed.size > 0) {
      merged = false
      for (const { file } of orderedFiles) {
        if (readVariableFiles.includes(file)) continue
        const values = variablesOf(file)
        if (values === undefined || values.size === 0) continue
        let relevant = false
        for (const key of values.keys()) {
          if (!needed.has(key)) continue
          relevant = true
          break
        }
        if (!relevant) continue
        merged = true
        readVariableFiles.push(file)
        for (const [key, value] of values) {
          if (!variables.has(key)) variables.set(key, value)
          for (const referenced of placeholderNames(value)) needed.add(referenced)
        }
      }
    }

    const candidate = {
      env: snapshot.env,
      cache: snapshot.cache,
      serverMatch: servers.some((server) => snapshot.cache.includes(server)),
      variableFiles: [...new Set(readVariableFiles)],
      sources: [],
      instances: new Map(),
      configuredDatabases: [],
    }

    // The environment is part of the identity: one RDS host carries several
    // tenants' schemas, and a `dev1` instance is not the `qa2` instance that
    // happens to share its hostname.
    const ensureInstance = (host, port) => {
      const id = `i:${stableId(candidate.env, host, String(port))}`
      const current = candidate.instances.get(id)
      if (current !== undefined) return current
      const created = { id, host, port, aliases: [], databases: [], label: `${host}:${port}` }
      candidate.instances.set(id, created)
      return created
    }

    for (const { file, text, datasources } of projectTexts) {
      // A project that keeps its values inline still resolves, and a key it states
      // itself wins over the same key in a shared file.
      const context = new Map(variables)
      for (const [key, value] of readVariables(text)) context.set(key, value)
      candidate.sources.push(file)
      for (const datasource of datasources) {
        const url = resolveTemplate(datasource.url, context)
        const target = parseJdbcUrl(url)
        if (target === undefined) {
          warnings.push(`unparsed-jdbc-url:${datasource.prefix}`)
          continue
        }
        if (target.schema === '') continue
        const user = resolveTemplate(String(datasource.username ?? ''), context).trim()
        const password = resolveTemplate(String(datasource.password ?? ''), context)
        const database = {
          name: target.schema,
          user,
          password,
          configured: true,
          source: file,
          alias: datasource.prefix,
          id: `d:${stableId(candidate.env, target.host, String(target.port), user, target.schema)}`,
        }
        const instance = ensureInstance(target.host, target.port)
        if (instance.databases.some((existing) => existing.name === database.name)) continue
        const alias = hostAliasOf(datasource.url)
        if (alias !== undefined && !instance.aliases.includes(alias)) instance.aliases.push(alias)
        instance.databases.push(database)
        candidate.configuredDatabases.push(database)
        // The first datasource of an instance names the credential the viewer
        // uses when it opens a database this project's config never mentioned.
        if (instance.user === undefined && user !== '') {
          instance.user = user
          instance.password = password
        }
      }
    }

    // The name a user recognises is the one its own URL gives the host
    // (`mysql-main`); several aliases can point at one host, shortest wins.
    for (const instance of candidate.instances.values()) {
      instance.aliases.sort((left, right) => left.length - right.length)
      if (instance.aliases.length === 0) instance.aliases.push(instance.host.split('.')[0])
    }

    const list = candidatesByEnv.get(candidate.env) ?? []
    list.push(candidate)
    candidatesByEnv.set(candidate.env, list)
  }

  /**
   * Choose one cache per environment.
   *
   * Preference: the cache the project's own bootstrap.yml points at, then the one
   * that resolved the most databases, then a stable name order.
   */
  const compareCandidates = (left, right) => {
    if (left.serverMatch !== right.serverMatch) return left.serverMatch ? -1 : 1
    if (left.configuredDatabases.length !== right.configuredDatabases.length) {
      return right.configuredDatabases.length - left.configuredDatabases.length
    }
    if (left.cache === right.cache) return 0
    return left.cache < right.cache ? -1 : 1
  }

  const order = Array.isArray(options.envOrder) && options.envOrder.length > 0
    ? options.envOrder
    : ['dev1', 'dev', 'qa2', 'qa1', 'qa', 'uat3', 'uat', 'test', 'staging', 'prod']

  const chosen = []
  for (const [env, candidates] of candidatesByEnv) {
    candidates.sort(compareCandidates)
    const best = candidates[0]
    // The tree shows only the instances this project's own configuration names,
    // and only when that configuration also supplied a usable account.
    const instances = [...best.instances.values()]
      .filter((instance) => typeof instance.user === 'string')
      .filter((instance) => instance.databases.length > 0)
    if (instances.length === 0) continue
    chosen.push({ candidate: best, instances })
  }

  const rankOf = (env) => {
    const index = order.indexOf(env)
    return index >= 0 ? index : order.length
  }
  chosen.sort((left, right) => {
    const difference = rankOf(left.candidate.env) - rankOf(right.candidate.env)
    if (difference !== 0) return difference
    return left.candidate.env < right.candidate.env ? -1 : 1
  })

  if (chosen.length === 0) warnings.push('no-environment')

  // Every connection the browser may name, including the password. The public
  // payload drops this map, so credentials never leave the Host process.
  const targets = new Map()

  const environments = chosen.map((entry) => {
    const environment = entry.candidate
    return {
      env: environment.env,
      label: environment.env,
      cacheServerMatch: environment.serverMatch,
      variableFiles: environment.variableFiles,
      sources: [...new Set(environment.sources)],
      databaseCount: environment.configuredDatabases.length,
      instances: entry.instances.map((instance) => {
        targets.set(instance.id, {
          id: instance.id,
          env: environment.env,
          host: instance.host,
          port: instance.port,
          user: instance.user,
          password: instance.password,
          database: undefined,
        })
        return {
          id: instance.id,
          host: instance.host,
          port: instance.port,
          label: instance.label,
          aliases: instance.aliases,
          user: instance.user,
          databases: instance.databases.map((database) => {
            targets.set(database.id, {
              id: database.id,
              env: environment.env,
              host: instance.host,
              port: instance.port,
              user: database.user === '' ? instance.user : database.user,
              password: database.password === '' ? instance.password : database.password,
              database: database.name,
            })
            return {
              id: database.id,
              name: database.name,
              user: database.user,
              alias: database.alias,
              configured: true,
            }
          }),
        }
      }),
    }
  })

  return {
    project: {
      name: applicationNames[0],
      root,
      applicationNames,
      configFiles,
      nacosServers: servers,
    },
    nacos: { home, snapshotCount: snapshots.length },
    warnings: [...new Set(warnings)],
    defaultEnv: environments.find((environment) => environment.databaseCount > 0)?.env ?? environments[0]?.env,
    environments,
    targets,
  }
}

export { connectionOf, hostAliasOf, SYSTEM_SCHEMAS }
