/**
 * Manually added connections.
 *
 * The rule scan and the AI fallback both try to *derive* a connection from files.
 * Neither helps when the database a user needs simply is not described anywhere in
 * the workspace — a local container, a shared test instance, a customer's replica.
 * This module is the third path: the user types host, port, account and database,
 * and the window keeps them.
 *
 * Two properties follow from the plugin's existing rules:
 *
 *  - **A manual connection is proven before it is saved.** The same read-only
 *    gateway opens it once; a typo then fails at save time with the server's own
 *    message instead of becoming a tree row that never works.
 *  - **The password stays in the Host.** It is written to a 0600 file next to the
 *    discovery cache (one file per workspace) and never appears in the payload the
 *    browser renders; the browser only ever names a target id.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, isAbsolute, join } from 'node:path'
import { stableId } from './discovery.js'

/** Bump when the document shape changes so old files are ignored. */
const MANUAL_VERSION = 1

/** More manual connections than this in one workspace is a mistake, not a workflow. */
const MAX_ENTRIES = 60

/** A label long enough to tell two connections apart, short enough for the tree. */
const MAX_LABEL = 40

/** One workspace's file, named so a human can tell them apart. */
function manualFile(directory, root) {
  const hash = createHash('sha256').update(root).digest('hex').slice(0, 16)
  const name = basename(root).replace(/[^\w.-]+/g, '_').slice(0, 40) || 'workspace'
  return join(directory, `${hash}-${name}.manual.json`)
}

/** Coerce one submitted entry into the shape the store keeps; undefined when unsuited. */
export function normalizeManualEntry(value) {
  if (value === null || typeof value !== 'object') return undefined
  const host = String(value.host ?? '').trim()
  const user = String(value.user ?? '').trim()
  const port = Number(value.port ?? 3306)
  if (host === '' || !/^[A-Za-z0-9._:[\]-]+$/.test(host)) return undefined
  if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined
  if (user === '' || user.includes('\u0000')) return undefined
  const database = String(value.database ?? '').trim()
  const label = String(value.label ?? '').trim().slice(0, MAX_LABEL) || `${host}:${port}`
  return {
    id: `m:${stableId('manual-entry', label, host, String(port), user)}`,
    label,
    host,
    port,
    user,
    password: String(value.password ?? ''),
    database,
  }
}

/** Manual entries, one small JSON file per workspace. */
export class ManualStore {
  constructor(directory) {
    this.directory = directory
    if (this.directory !== '') mkdirSync(this.directory, { recursive: true, mode: 0o700 })
  }

  /** The file one workspace's manual connections live in. */
  fileFor(root) {
    return manualFile(this.directory, root)
  }

  /** Read the entries; a missing or unreadable file means "none added yet". */
  load(root) {
    if (this.directory === '') return { entries: [] }
    if (typeof root !== 'string' || root === '' || !isAbsolute(root)) return { entries: [] }
    try {
      const parsed = JSON.parse(readFileSync(this.fileFor(root), 'utf8'))
      if (parsed?.version !== MANUAL_VERSION) return { entries: [] }
      const entries = []
      for (const raw of Array.isArray(parsed.entries) ? parsed.entries : []) {
        const entry = normalizeManualEntry(raw)
        // A hand-edited file can contain the same id twice; the first one wins.
        if (entry === undefined || entries.some((existing) => existing.id === entry.id)) continue
        entries.push(entry)
      }
      return { entries: entries.slice(0, MAX_ENTRIES) }
    } catch (error) {
      void error
      return { entries: [] }
    }
  }

  /** Replace one workspace's entries atomically, 0600. */
  save(root, entries) {
    if (this.directory === '') {
      const error = new Error('manual connections are unavailable in this build')
      error.code = 'manual-unavailable'
      throw error
    }
    if (typeof root !== 'string' || root === '' || !isAbsolute(root)) {
      const error = new Error('workspace root must be an absolute path')
      error.code = 'invalid-root'
      throw error
    }
    const document = JSON.stringify({
      version: MANUAL_VERSION,
      root,
      savedAt: Date.now(),
      entries: entries.slice(0, MAX_ENTRIES),
    })
    const file = this.fileFor(root)
    const temporary = `${file}.${process.pid}.tmp`
    writeFileSync(temporary, document, { mode: 0o600 })
    renameSync(temporary, file)
    return { saved: true, entries: entries.length }
  }

  /** Add or replace one entry, keyed by its stable id. */
  upsert(root, entry) {
    const { entries } = this.load(root)
    const next = entries.some((existing) => existing.id === entry.id)
      ? entries.map((existing) => (existing.id === entry.id ? entry : existing))
      : [...entries, entry]
    this.save(root, next)
    return entry
  }

  /** Drop one entry; returns whether it existed. */
  remove(root, id) {
    const { entries } = this.load(root)
    const next = entries.filter((entry) => entry.id !== id)
    if (next.length === entries.length) return false
    this.save(root, next)
    return true
  }
}

/**
 * Turn stored entries into the environment shape the panel already renders.
 *
 * Entries sharing a label form one environment, so "本地" can hold both MySQL 5.7
 * and 8.0 without inventing two entries a user has to tell apart.
 *
 * @returns `{ environments, targets }`; only `targets` carries passwords
 */
export function manualEnvironments(entries) {
  const groups = new Map()
  const targets = new Map()
  for (const entry of Array.isArray(entries) ? entries : []) {
    const env = `manual:${stableId('manual-env', entry.label)}`
    const instanceId = `i:${stableId('manual', env, entry.host, String(entry.port), entry.user)}`
    const databaseId = `d:${stableId('manual', instanceId, entry.database)}`
    let group = groups.get(env)
    if (group === undefined) {
      group = { env, label: entry.label, instances: [], targets: [], databaseCount: 0 }
      groups.set(env, group)
    }
    let instance = group.instances.find((candidate) => candidate.id === instanceId)
    if (instance === undefined) {
      instance = {
        id: instanceId,
        host: entry.host,
        port: entry.port,
        label: `${entry.host}:${entry.port}`,
        // The user typed this host, so it is the name to show in the tree — unlike
        // a discovered instance, there is no configuration alias hiding behind it.
        aliases: [entry.host],
        user: entry.user,
        manual: true,
        entryId: entry.id,
        databases: [],
      }
      group.instances.push(instance)
      group.targets.push([instanceId, {
        id: instanceId,
        env,
        host: entry.host,
        port: entry.port,
        user: entry.user,
        password: entry.password,
        database: undefined,
        manual: true,
      }])
    }
    if (entry.database !== '' && !instance.databases.some((database) => database.name === entry.database)) {
      instance.databases.push({
        id: databaseId,
        name: entry.database,
        user: entry.user,
        alias: entry.label,
        configured: true,
        manual: true,
      })
      group.targets.push([databaseId, {
        id: databaseId,
        env,
        host: entry.host,
        port: entry.port,
        user: entry.user,
        password: entry.password,
        database: entry.database,
        manual: true,
      }])
    }
  }

  const environments = []
  for (const group of groups.values()) {
    const databaseCount = group.instances.reduce((total, instance) => total + instance.databases.length, 0)
    for (const [id, target] of group.targets) targets.set(id, target)
    environments.push({
      env: group.env,
      label: group.label,
      manual: true,
      cacheServerMatch: false,
      variableFiles: [],
      sources: [],
      databaseCount,
      instances: group.instances,
    })
  }
  return { environments, targets }
}
