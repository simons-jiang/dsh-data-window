/**
 * Connections this machine already resolved.
 *
 * Teams reuse the same RDS endpoint and account across projects: `pims-*` share one
 * host, several services share one account. Typing that by hand in the manual
 * connection form is both busywork and a place to introduce a typo, so the Host
 * offers what it already knows — from every workspace's discovery cache and from
 * every workspace's manually added connections — and the form fills itself.
 *
 * Only the *shape* of a connection is public here (host, port, user, schema names).
 * The password is looked up again on the Host when the form is saved, so the browser
 * never receives another workspace's credential.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { stableId } from './discovery.js'

/** A machine with more known connections than this cannot be a "picker" any more. */
const MAX_CONNECTIONS = 200

/** One cached discovery document is bounded; a corrupt one is skipped. */
const MAX_DOCUMENT_BYTES = 4 * 1024 * 1024

/** Keys one connection by what a user recognises and what identifies it. */
function connectionKey(host, port, user) {
  return `${host}\u0000${port}\u0000${user}`
}

/** Read one JSON file, skipping anything unreadable. */
function readJson(file) {
  try {
    const text = readFileSync(file, 'utf8')
    if (text.length > MAX_DOCUMENT_BYTES) return undefined
    return JSON.parse(text)
  } catch (error) {
    void error
    return undefined
  }
}

/** Every `i:` target of one discovery document, keyed by id. */
function instanceTargetsOf(document) {
  const targets = new Map()
  const raw = document?.targets
  const pairs = Array.isArray(raw) ? raw : (raw !== null && typeof raw === 'object' ? Object.entries(raw) : [])
  for (const pair of pairs) {
    if (!Array.isArray(pair) || pair.length !== 2) continue
    const [id, target] = pair
    if (typeof id !== 'string' || target === null || typeof target !== 'object') continue
    if (!id.startsWith('i:')) continue
    targets.set(id, target)
  }
  return targets
}

/** Collect connections from every workspace this plugin has discovered. */
export class ConnectionCatalog {
  /**
   * @param directory the plugin's storage directory; `workspaces/`, `manual/` and
   *   `remembered/` live under it
   */
  constructor(directory) {
    this.directory = directory
  }

  /** Every known connection, with the password, keyed and deduped. */
  entries() {
    const found = new Map()
    const ensure = (host, port, user, password) => {
      const id = `c:${stableId('connection', host, String(port), user)}`
      let entry = found.get(id)
      if (entry === undefined) {
        entry = { id, host, port, user, password, databases: new Set(), labels: new Set() }
        found.set(id, entry)
      }
      if (entry.password === '' && password !== '') entry.password = password
      return entry
    }

    for (const file of listFiles(join(this.directory, 'workspaces'))) {
      // The console snapshots share this directory; they hold no connection.
      if (!file.endsWith('.json') || file.endsWith('.consoles.json')) continue
      const document = readJson(join(this.directory, 'workspaces', file))
      const environments = document?.payload?.environments
      if (!Array.isArray(environments)) continue
      const targets = instanceTargetsOf(document)
      const workspace = typeof document?.root === 'string' ? basename(document.root) : ''
      for (const environment of environments) {
        for (const instance of Array.isArray(environment?.instances) ? environment.instances : []) {
          const host = String(instance?.host ?? '')
          const port = Number(instance?.port ?? 0)
          const user = String(instance?.user ?? '')
          if (host === '' || !Number.isInteger(port) || port < 1 || user === '') continue
          const target = targets.get(instance?.id)
          const entry = ensure(host, port, user, String(target?.password ?? ''))
          for (const database of Array.isArray(instance?.databases) ? instance.databases : []) {
            const name = String(database?.name ?? '')
            if (name !== '') entry.databases.add(name)
          }
          const label = [workspace, String(environment?.label ?? environment?.env ?? '')].filter((part) => part !== '').join(' · ')
          if (label !== '') entry.labels.add(label)
        }
      }
    }

    for (const file of listFiles(join(this.directory, 'manual'))) {
      if (!file.endsWith('.manual.json')) continue
      const document = readJson(join(this.directory, 'manual', file))
      const workspace = typeof document?.root === 'string' ? basename(document.root) : ''
      for (const stored of Array.isArray(document?.entries) ? document.entries : []) {
        const host = String(stored?.host ?? '')
        const port = Number(stored?.port ?? 0)
        const user = String(stored?.user ?? '')
        if (host === '' || !Number.isInteger(port) || port < 1 || user === '') continue
        const entry = ensure(host, port, user, String(stored?.password ?? ''))
        const database = String(stored?.database ?? '')
        if (database !== '') entry.databases.add(database)
        const label = [workspace, String(stored?.label ?? '')].filter((part) => part !== '').join(' · ')
        if (label !== '') entry.labels.add(label)
      }
    }

    return [...found.values()]
      .sort((left, right) => (left.host === right.host
        ? (left.port === right.port ? left.user.localeCompare(right.user) : left.port - right.port)
        : left.host.localeCompare(right.host)))
      .slice(0, MAX_CONNECTIONS)
  }

  /** The picker's list: no passwords. */
  list() {
    return this.entries().map((entry) => ({
      id: entry.id,
      host: entry.host,
      port: entry.port,
      user: entry.user,
      databases: [...entry.databases].sort(),
      labels: [...entry.labels].sort(),
    }))
  }

  /** The credential behind one picked entry, for the save path only. */
  passwordFor(id) {
    const target = String(id ?? '')
    if (target === '') return undefined
    const entry = this.entries().find((candidate) => candidate.id === target)
    return entry?.password
  }
}

/** File names under one directory, or an empty list when it does not exist yet. */
function listFiles(directory) {
  try {
    return readdirSync(directory).filter((name) => !name.startsWith('.')).sort()
  } catch (error) {
    void error
    return []
  }
}
