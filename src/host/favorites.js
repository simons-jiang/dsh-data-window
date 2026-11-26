/**
 * Saved SQL statements.
 *
 * A statement worth keeping is kept with three facts: the name the user gives it,
 * the schema it was written against, and the table it belongs to. The name is what
 * the workbench indexes behind `@`, and the schema/table pair is what lets the
 * resource tree put the statement back where it came from instead of showing one
 * flat list.
 *
 * The store is shared by every workspace, like the tree itself: a statement written
 * in one project is still a statement the user wants in the next one, and the
 * schema/table pair survives a workspace switch because it is a name, not an id.
 * The file is 0600 and written through a temporary file + rename, so a crash cannot
 * leave a torn document and another process can never read it.
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Bump when the document shape changes so old files are ignored. */
const FAVORITE_VERSION = 1

/** One file for the whole machine: the favorites belong to the tree, not a root. */
const FAVORITES_FILE = 'favorites.json'

/** More favorites than this is a runaway script, not a personal collection. */
const MAX_FAVORITES = 500

/** One statement larger than this cannot be indexed into the `@` list sensibly. */
const MAX_SQL_BYTES = 128 * 1024

/** A name is a search key, so it stays short and printable. */
const MAX_NAME_LENGTH = 80

/** MySQL identifiers are at most 64 characters. */
const MAX_LABEL_LENGTH = 64

/** The name as a comparison key: the same name in another case is the same name. */
function favoriteNameKey(name) {
  return String(name ?? '').trim().toLowerCase()
}

/** Trim, strip NUL and cap one plain text field. */
function cleanText(value, limit) {
  const text = String(value ?? '').replace(/\u0000/g, '').trim()
  return text.length > limit ? text.slice(0, limit) : text
}

/** Coerce one stored entry; `undefined` when it cannot be rendered or indexed. */
function normalizeFavorite(value) {
  if (value === null || typeof value !== 'object') return undefined
  const id = String(value.id ?? '').trim()
  const name = cleanText(value.name, MAX_NAME_LENGTH)
  const sql = String(value.sql ?? '').replace(/\u0000/g, '').trim()
  const database = cleanText(value.database, MAX_LABEL_LENGTH)
  if (!/^[A-Za-z0-9-]{8,64}$/.test(id) || name === '' || sql === '' || database === '') return undefined
  if (Buffer.byteLength(sql) > MAX_SQL_BYTES) return undefined
  const createdAt = Number(value.createdAt)
  const updatedAt = Number(value.updatedAt)
  return {
    id,
    name,
    sql,
    database,
    table: cleanText(value.table, MAX_LABEL_LENGTH),
    env: cleanText(value.env, 40),
    createdAt: Number.isFinite(createdAt) && createdAt > 0 ? createdAt : Date.now(),
    updatedAt: Number.isFinite(updatedAt) && updatedAt > 0 ? updatedAt : Date.now(),
  }
}

/** A failure the RPC layer maps to a status code. */
function favoriteFailure(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

/** Saved SQL statements, one tiny JSON document for the whole machine. */
export class FavoriteStore {
  constructor(directory) {
    this.directory = directory
    if (this.directory !== '') mkdirSync(this.directory, { recursive: true, mode: 0o700 })
  }

  /** The document every favorite lives in. */
  file() {
    return join(this.directory, FAVORITES_FILE)
  }

  /** Read every favorite; a missing or unreadable file means "none saved yet". */
  list() {
    if (this.directory === '') return { favorites: [] }
    try {
      const parsed = JSON.parse(readFileSync(this.file(), 'utf8'))
      if (parsed?.version !== FAVORITE_VERSION) return { favorites: [] }
      const favorites = []
      for (const raw of Array.isArray(parsed.favorites) ? parsed.favorites : []) {
        const entry = normalizeFavorite(raw)
        if (entry === undefined) continue
        if (favorites.some((existing) => existing.id === entry.id)) continue
        favorites.push(entry)
      }
      return { favorites: favorites.slice(0, MAX_FAVORITES) }
    } catch (error) {
      return { favorites: [] }
    }
  }

  /** Replace the document atomically, 0600. */
  save(favorites) {
    if (this.directory === '') {
      throw favoriteFailure('favorite-unavailable', 'saved SQL is unavailable in this build')
    }
    const document = JSON.stringify({
      version: FAVORITE_VERSION,
      savedAt: Date.now(),
      favorites: favorites.slice(0, MAX_FAVORITES),
    })
    const file = this.file()
    const temporary = `${file}.${process.pid}.tmp`
    writeFileSync(temporary, document, { mode: 0o600 })
    renameSync(temporary, file)
    return { saved: true, favorites: favorites.length }
  }

  /**
   * Create or update one favorite.
   *
   * The name is the user-facing identity, so it is unique without regard to case;
   * the id is what an update (rename included) targets. Both are checked here
   * rather than in the Client because two panels can save at the same time.
   */
  upsert(value) {
    const { favorites } = this.list()
    const id = String(value?.id ?? '').trim()
    const name = cleanText(value?.name, MAX_NAME_LENGTH)
    const sql = String(value?.sql ?? '').replace(/\u0000/g, '').trim()
    const database = cleanText(value?.database, MAX_LABEL_LENGTH)
    const table = cleanText(value?.table, MAX_LABEL_LENGTH)
    const env = cleanText(value?.env, 40)
    if (name === '') throw favoriteFailure('invalid-favorite', 'a favorite needs a name')
    if (database === '') throw favoriteFailure('invalid-favorite', 'a favorite needs a database name')
    if (sql === '') throw favoriteFailure('invalid-favorite', 'a favorite needs a statement')
    if (Buffer.byteLength(sql) > MAX_SQL_BYTES) {
      throw favoriteFailure('favorite-too-large', 'the statement is too large to save')
    }
    const key = favoriteNameKey(name)
    const existing = id === '' ? undefined : favorites.find((entry) => entry.id === id)
    if (id !== '' && existing === undefined) {
      throw favoriteFailure('unknown-favorite', 'no saved SQL uses that id')
    }
    const conflict = favorites.find((entry) => entry.id !== existing?.id && favoriteNameKey(entry.name) === key)
    if (conflict !== undefined) {
      throw favoriteFailure('duplicate-favorite', `a saved statement is already named ${conflict.name}`)
    }
    const now = Date.now()
    if (existing === undefined && favorites.length >= MAX_FAVORITES) {
      throw favoriteFailure('favorite-limit', 'too many saved statements')
    }
    const favorite = {
      id: existing?.id ?? randomUUID(),
      name,
      sql,
      database,
      table,
      env,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }
    const next = existing === undefined
      ? [...favorites, favorite]
      : favorites.map((entry) => (entry.id === existing.id ? favorite : entry))
    this.save(next)
    return { favorite }
  }

  /** Drop one favorite; returns whether it was there. */
  remove(id) {
    const target = String(id ?? '').trim()
    if (target === '') return { removed: false }
    const { favorites } = this.list()
    const next = favorites.filter((entry) => entry.id !== target)
    if (next.length === favorites.length) return { removed: false }
    this.save(next)
    return { removed: true }
  }
}
