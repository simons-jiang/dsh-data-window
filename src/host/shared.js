/**
 * The shared resource tree.
 *
 * A project's configuration says *how to find* its databases; it is not the list a
 * user wants to browse. Teams open several workspaces that all point at the same
 * few RDS instances, so a per-workspace tree shows the same hosts again and again
 * and forgets everything the moment the workspace changes.
 *
 * This module builds one tree out of every fact the machine already has:
 *
 *   - every workspace's discovery cache (what its own configuration resolved),
 *   - the shared manual connections,
 *   - the shared set of extra databases a user picked.
 *
 * Opening a workspace therefore *adds* its instances to the tree and reports which
 * environment belongs to it (`focus`), instead of replacing the tree with its own.
 * Ids are unchanged from the per-workspace era, so saved consoles keep pointing at
 * the same targets.
 */
import { manualEnvironments } from './manual.js'

/** The environment order a project configured, then anything else alphabetically. */
function envRank(order, env) {
  const index = Array.isArray(order) ? order.indexOf(env) : -1
  return index >= 0 ? index : order.length
}

/** Clone one payload database into the shared shape (no credential is involved). */
function databaseEntry(database, instance) {
  return {
    id: String(database?.id ?? ''),
    name: String(database?.name ?? ''),
    user: String(database?.user ?? instance?.user ?? ''),
    alias: String(database?.alias ?? ''),
    configured: database?.configured !== false,
    ...(database?.remembered === true ? { remembered: true } : {}),
    ...(database?.manual === true ? { manual: true } : {}),
  }
}

/**
 * Merge every source into one tree.
 *
 * @param options `{ caches, current, currentTargets, manualEntries, remembered, envOrder }`
 *   where `caches` are the *other* workspaces' discovery documents
 * @returns `{ environments, targets, focus }`; `targets` still carries passwords
 */
export function buildSharedTree(options) {
  const envOrder = Array.isArray(options?.envOrder) ? options.envOrder : []
  const environments = new Map()
  const targets = new Map()

  const envOf = (env, label) => {
    const key = String(env ?? label ?? '').trim()
    if (key === '') return undefined
    let entry = environments.get(key)
    if (entry === undefined) {
      entry = { env: key, label: String(label ?? key), instances: [], databaseCount: 0, manual: false, rule: false }
      environments.set(key, entry)
    }
    return entry
  }

  const mergePayload = (payload, targetMap, isCurrent) => {
    for (const environment of Array.isArray(payload?.environments) ? payload.environments : []) {
      const entry = envOf(environment?.env, environment?.label)
      if (entry === undefined) continue
      entry.rule = true
      for (const instance of Array.isArray(environment?.instances) ? environment.instances : []) {
        if (instance === null || typeof instance !== 'object' || typeof instance?.id !== 'string') continue
        let current = entry.instances.find((candidate) => candidate.id === instance.id)
        if (current === undefined) {
          current = {
            id: instance.id,
            host: String(instance.host ?? ''),
            port: Number(instance.port ?? 3306),
            label: String(instance.label ?? `${instance.host}:${instance.port}`),
            aliases: Array.isArray(instance.aliases) ? [...instance.aliases] : [],
            user: String(instance.user ?? ''),
            manual: instance.manual === true,
            ...(typeof instance.entryId === 'string' ? { entryId: instance.entryId } : {}),
            databases: [],
            inWorkspace: isCurrent === true,
          }
          entry.instances.push(current)
        } else if (isCurrent === true) {
          current.inWorkspace = true
        }
        for (const database of Array.isArray(instance.databases) ? instance.databases : []) {
          const name = String(database?.name ?? '')
          if (name === '') continue
          if (current.databases.some((candidate) => candidate.name === name)) continue
          current.databases.push(databaseEntry(database, current))
        }
      }
    }
    for (const [id, target] of targetMap instanceof Map ? targetMap : []) {
      if (target === null || typeof target !== 'object') continue
      targets.set(id, target)
    }
  }

  for (const document of Array.isArray(options?.caches) ? options.caches : []) {
    mergePayload(document?.payload, new Map(Array.isArray(document?.targets) ? document.targets : []), false)
  }
  // The workspace being opened merges last: its labels and databases win ties.
  mergePayload(options?.current, options?.currentTargets, true)

  const manual = manualEnvironments(options?.manualEntries ?? [])
  for (const [id, target] of manual.targets) targets.set(id, target)
  for (const environment of manual.environments) {
    const entry = envOf(environment.env, environment.label)
    if (entry === undefined) continue
    entry.manual = true
    entry.label = environment.label
    for (const instance of environment.instances) {
      if (entry.instances.some((candidate) => candidate.id === instance.id)) continue
      entry.instances.push({ ...instance, databases: [...instance.databases], inWorkspace: false })
    }
  }

  for (const remembered of Array.isArray(options?.remembered) ? options.remembered : []) {
    const instanceId = String(remembered?.instanceId ?? '')
    const database = String(remembered?.database ?? '')
    if (instanceId === '' || database === '') continue
    for (const environment of environments.values()) {
      const instance = environment.instances.find((candidate) => candidate.id === instanceId)
      if (instance === undefined) continue
      if (instance.databases.some((candidate) => candidate.name === database)) break
      instance.databases.push({
        id: `${instanceId}~${database}`,
        name: database,
        user: instance.user,
        alias: database,
        configured: true,
        remembered: true,
      })
      break
    }
  }

  const focusEnvs = []
  const focusInstances = []
  for (const environment of environments.values()) {
    let count = 0
    for (const instance of environment.instances) {
      count += instance.databases.length
      if (instance.inWorkspace === true) {
        focusInstances.push(instance.id)
        if (!focusEnvs.includes(environment.env)) focusEnvs.push(environment.env)
      }
      delete instance.inWorkspace
    }
    environment.databaseCount = count
  }

  const ordered = [...environments.values()].sort((left, right) => {
    if (left.manual !== right.manual) return left.manual ? 1 : -1
    const rank = envRank(envOrder, left.env) - envRank(envOrder, right.env)
    if (rank !== 0) return rank
    return left.env < right.env ? -1 : left.env > right.env ? 1 : 0
  })
  for (const environment of ordered) {
    delete environment.rule
  }

  return {
    environments: ordered,
    targets,
    focus: { envs: focusEnvs, instances: focusInstances },
  }
}
