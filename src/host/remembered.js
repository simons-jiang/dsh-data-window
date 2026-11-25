/**
 * Databases the user opened from an instance's full list.
 *
 * An instance usually carries more schemas than the project's configuration names
 * — `bw_order` is configured, `bw_inventory` is not. The tree can list every schema
 * on demand, but that list used to live only in the panel's memory: the next open
 * of the workspace forgot it, and the user had to find the database again.
 *
 * This store remembers the databases a user actually opened, per workspace, so the
 * next discovery puts them next to the configured ones. It stores only the instance
 * id and the schema name: the credentials behind the instance are already in the
 * discovery cache, so a remembered database needs no secret of its own.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, isAbsolute, join } from 'node:path'

/** Bump when the document shape changes so old files are ignored. */
const REMEMBERED_VERSION = 1

/** A user who opened more schemas than this has a different problem. */
const MAX_REMEMBERED = 200

/** One workspace's file, named so a human can tell them apart. */
function rememberedFile(directory, root) {
  const hash = createHash('sha256').update(root).digest('hex').slice(0, 16)
  const name = basename(root).replace(/[^\w.-]+/g, '_').slice(0, 40) || 'workspace'
  return join(directory, `${hash}-${name}.databases.json`)
}

/** Coerce one stored entry into `{ instanceId, database }`; undefined when unsuited. */
function normalizeEntry(value) {
  if (value === null || typeof value !== 'object') return undefined
  const instanceId = String(value.instanceId ?? '').trim()
  const database = String(value.database ?? '').trim()
  if (instanceId === '' || database === '') return undefined
  if (!/^i:[\w-]+$/.test(instanceId)) return undefined
  return { instanceId, database }
}

/** Remembered extra databases, one small JSON file per workspace. */
export class RememberedStore {
  constructor(directory) {
    this.directory = directory
    if (this.directory !== '') mkdirSync(this.directory, { recursive: true, mode: 0o700 })
  }

  /** The file one workspace's remembered databases live in. */
  fileFor(root) {
    return rememberedFile(this.directory, root)
  }

  /** Read the entries; a missing or unreadable file means "none remembered yet". */
  load(root) {
    if (this.directory === '') return { databases: [] }
    if (typeof root !== 'string' || root === '' || !isAbsolute(root)) return { databases: [] }
    try {
      const parsed = JSON.parse(readFileSync(this.fileFor(root), 'utf8'))
      if (parsed?.version !== REMEMBERED_VERSION) return { databases: [] }
      const databases = []
      for (const raw of Array.isArray(parsed.databases) ? parsed.databases : []) {
        const entry = normalizeEntry(raw)
        if (entry === undefined) continue
        if (databases.some((existing) => existing.instanceId === entry.instanceId && existing.database === entry.database)) continue
        databases.push(entry)
      }
      return { databases: databases.slice(0, MAX_REMEMBERED) }
    } catch (error) {
      void error
      return { databases: [] }
    }
  }

  /** Replace one workspace's entries atomically, 0600. */
  save(root, databases) {
    if (this.directory === '') {
      const error = new Error('remembered databases are unavailable in this build')
      error.code = 'remembered-unavailable'
      throw error
    }
    if (typeof root !== 'string' || root === '' || !isAbsolute(root)) {
      const error = new Error('workspace root must be an absolute path')
      error.code = 'invalid-root'
      throw error
    }
    const document = JSON.stringify({
      version: REMEMBERED_VERSION,
      root,
      savedAt: Date.now(),
      databases: databases.slice(0, MAX_REMEMBERED),
    })
    const file = this.fileFor(root)
    const temporary = `${file}.${process.pid}.tmp`
    writeFileSync(temporary, document, { mode: 0o600 })
    renameSync(temporary, file)
    return { saved: true, databases: databases.length }
  }

  /** Remember one database; a duplicate is a no-op. */
  add(root, entry) {
    const normalized = normalizeEntry(entry)
    if (normalized === undefined) return false
    const { databases } = this.load(root)
    if (databases.some((existing) => existing.instanceId === normalized.instanceId && existing.database === normalized.database)) return false
    this.save(root, [...databases, normalized])
    return true
  }

  /**
   * Replace everything remembered for one instance with this list.
   *
   * The picker edits a set, not individual rows: an unchecked schema must disappear
   * from the tree, which only a replace can express.
   */
  replaceInstance(root, instanceId, databases) {
    const { databases: existing } = this.load(root)
    const kept = existing.filter((entry) => entry.instanceId !== instanceId)
    const seen = new Set()
    const next = [...kept]
    for (const name of Array.isArray(databases) ? databases : []) {
      const database = String(name ?? '').trim()
      if (database === '' || database.length > 64 || database.includes('\u0000')) continue
      if (seen.has(database)) continue
      seen.add(database)
      next.push({ instanceId, database })
    }
    this.save(root, next.slice(0, MAX_REMEMBERED))
    return { databases: [...seen] }
  }

  /**
   * Move remembered schemas to their instance's new id.
   *
   * Renaming a manual environment changes the derived instance id; without this the
   * user's picked databases would silently disappear from the tree.
   */
  remap(root, mapping) {
    if (!(mapping instanceof Map) || mapping.size === 0) return 0
    const { databases } = this.load(root)
    const seen = new Set()
    const next = []
    let moved = 0
    for (const entry of databases) {
      const target = mapping.get(entry.instanceId) ?? entry.instanceId
      if (target !== entry.instanceId) moved += 1
      const key = `${target}\u0000${entry.database}`
      if (seen.has(key)) continue
      seen.add(key)
      next.push({ instanceId: target, database: entry.database })
    }
    if (moved > 0) this.save(root, next)
    return moved
  }

  /** Drop every remembered schema of the given instances (a deleted environment). */
  forgetInstances(root, instanceIds) {
    const ids = new Set((Array.isArray(instanceIds) ? instanceIds : []).filter((id) => typeof id === 'string' && id !== ''))
    if (ids.size === 0) return 0
    const { databases } = this.load(root)
    const next = databases.filter((entry) => !ids.has(entry.instanceId))
    const removed = databases.length - next.length
    if (removed > 0) this.save(root, next)
    return removed
  }

  /** Forget one database; returns whether it was remembered. */
  remove(root, entry) {
    const normalized = normalizeEntry(entry)
    if (normalized === undefined) return false
    const { databases } = this.load(root)
    const next = databases.filter((existing) => !(existing.instanceId === normalized.instanceId && existing.database === normalized.database))
    if (next.length === databases.length) return false
    this.save(root, next)
    return true
  }
}
