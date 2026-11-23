/**
 * The read-only MySQL gateway.
 *
 * Two promises are kept here and nowhere else:
 *
 *  1. A statement the viewer sends cannot modify data. The first word must be a
 *     read verb, one statement per request, and every pooled connection opens with
 *     `SET SESSION TRANSACTION READ ONLY`, so the server itself rejects a write even
 *     if a parser gap lets one through.
 *  2. Credentials stay in the Host process. The browser names a target id; the
 *     password never leaves this module.
 */
import { createPool } from 'mysql2/promise'
import { SYSTEM_SCHEMAS } from './discovery.js'

/** Statements a work viewer needs; everything else is refused before connecting. */
const ALLOWED_VERBS = new Set(['select', 'show', 'desc', 'describe', 'explain', 'with', 'table'])

/** Row ceiling when the caller does not choose one. */
const DEFAULT_LIMIT = 200

/** Hard row ceiling, so one accidental full scan cannot exhaust the browser. */
const MAX_LIMIT = 5000

/** Reject anything this large before it reaches the driver. */
const MAX_SQL_BYTES = 512 * 1024

export class ReadOnlyViolation extends Error {
  constructor(message) {
    super(message)
    this.code = 'read-only-violation'
  }
}

/** Strip `--`, `#` and block comments so the first word is really the first word. */
export function significantSql(sql) {
  let text = String(sql ?? '')
  // Block comments first: `/*! ... */` is executable in MySQL, and a viewer never
  // needs one, so the whole comment region is removed rather than trusted.
  text = text.replace(/\/\*[\s\S]*?\*\//g, ' ')
  text = text.replace(/^\s*(?:--[^\n]*|#[^\n]*)\s*$/gm, ' ')
  text = text.replace(/--[^\n]*/g, ' ')
  text = text.replace(/(^|\s)#[^\n]*/g, ' ')
  return text.trim()
}

/** Split one request into statements, honoring quotes and comments. */
export function splitStatements(sql) {
  const text = String(sql ?? '')
  const statements = []
  let current = ''
  let single = false
  let double = false
  let backtick = false
  let lineComment = false
  let blockComment = false
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    const next = text[index + 1]
    if (lineComment) {
      if (character === '\n') {
        lineComment = false
        current += character
      }
      continue
    }
    if (blockComment) {
      if (character === '*' && next === '/') {
        blockComment = false
        index += 1
      }
      continue
    }
    if (!single && !double && !backtick) {
      if (character === '-' && next === '-') {
        lineComment = true
        index += 1
        continue
      }
      if (character === '#') {
        lineComment = true
        continue
      }
      if (character === '/' && next === '*') {
        blockComment = true
        index += 1
        continue
      }
    }
    if (character === "'" && !double && !backtick) {
      single = text[index - 1] === '\\' ? single : !single
      current += character
      continue
    }
    if (character === '"' && !single && !backtick) {
      double = text[index - 1] === '\\' ? double : !double
      current += character
      continue
    }
    if (character === '`' && !single && !double) {
      backtick = !backtick
      current += character
      continue
    }
    if (character === ';' && !single && !double && !backtick) {
      if (current.trim() !== '') statements.push(current.trim())
      current = ''
      continue
    }
    current += character
  }
  if (current.trim() !== '') statements.push(current.trim())
  return statements
}

/**
 * Validate one statement as read-only.
 *
 * @returns the statement to run (single trailing semicolon removed).
 */
export function assertReadOnly(sql) {
  const text = String(sql ?? '')
  if (text.length > MAX_SQL_BYTES) throw new ReadOnlyViolation('sql-too-large')
  const statements = splitStatements(text)
  if (statements.length === 0) throw new ReadOnlyViolation('empty-sql')
  if (statements.length > 1) throw new ReadOnlyViolation('multiple-statements')
  const statement = statements[0]
  const first = /^[A-Za-z]+/.exec(significantSql(statement))
  if (first === null) throw new ReadOnlyViolation('unrecognized-sql')
  const verb = first[0].toLowerCase()
  if (!ALLOWED_VERBS.has(verb)) throw new ReadOnlyViolation(`forbidden-verb:${verb}`)
  const body = significantSql(statement).toLowerCase()
  if (/\binto\s+(out|dump)file\b/.test(body)) throw new ReadOnlyViolation('write-file')
  // `SHOW CREATE TABLE`, `SHOW INDEX`, `EXPLAIN` and `DESC` cannot write, so their
  // bodies are not scanned for write verbs — `create` is the whole point of the
  // statement the DDL viewer sends.
  if (verb === 'show' || verb === 'desc' || verb === 'describe' || verb === 'explain') return statement
  // A read-only transaction still allows a `SELECT` that writes through a
  // function, and `WITH ... DELETE` parses as `WITH`, so the write verbs are
  // refused anywhere in the statement rather than only at the front.
  if (/\b(insert|update|delete|replace|drop|alter|truncate|create|rename|grant|revoke|call|load|lock|unlock|handler|do)\b/.test(body)) {
    throw new ReadOnlyViolation('write-keyword')
  }
  // Row locks are a write of sorts: they block other sessions until this one ends.
  if (/\bfor\s+update\b|\block\s+in\s+share\s+mode\b/.test(body)) throw new ReadOnlyViolation('locking-select')
  return statement
}

/** Append a LIMIT to a bare SELECT so MySQL itself stops early. */
export function withRowLimit(statement, limit) {
  const trimmed = statement.replace(/;\s*$/, '').trim()
  if (!/^(select|with|table)\b/i.test(trimmed)) return trimmed
  if (/\blimit\s+[0-9]+\s*(,\s*[0-9]+)?\s*$/i.test(trimmed)) return trimmed
  return `${trimmed} LIMIT ${limit}`
}

/** One value a result cell may carry; MySQL can return types JSON cannot. */
function cellValue(value) {
  if (value === null || value === undefined) return null
  const type = typeof value
  if (type === 'string' || type === 'number' || type === 'boolean') return value
  if (type === 'bigint') return value.toString()
  if (value instanceof Date) {
    // Local wall-clock text is what a SQL client shows, and it round-trips back
    // into MySQL unchanged; an ISO string would move the value by the offset.
    const pad = (number, size = 2) => String(number).padStart(size, '0')
    const date = `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`
    const clock = `${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`
    const millis = value.getMilliseconds() === 0 ? '' : `.${pad(value.getMilliseconds(), 3)}`
    return `${date} ${clock}${millis}`
  }
  if (Buffer.isBuffer(value)) return `0x${value.toString('hex')}`
  if (Array.isArray(value)) return value.map(cellValue)
  if (type === 'object') {
    try {
      return JSON.stringify(value)
    } catch (error) {
      void error
      return String(value)
    }
  }
  return String(value)
}

/** Normalize one driver row into a plain array of cells. */
function rowValues(row, columns) {
  if (Array.isArray(row)) return row.map(cellValue)
  return columns.map((column) => cellValue(row[column]))
}

/** Key a pool by everything that changes its identity. */
function poolKey(target) {
  return `${target.host}:${target.port}|${target.user}|${target.database ?? ''}`
}

export class DataGateway {
  constructor(config = {}) {
    this.config = config
    this.targets = new Map()
    this.pools = new Map()
    /** Round-trip counters, surfaced in the panel's log line. */
    this.statementCount = 0
  }

  /** Replace the addressable targets; new ids win, old pools are dropped lazily. */
  setTargets(targets) {
    this.targets = targets instanceof Map ? targets : new Map(Object.entries(targets ?? {}))
    for (const [key, pool] of this.pools) {
      const stillUsed = [...this.targets.values()].some((target) => poolKey(target) === key)
      if (stillUsed) continue
      this.pools.delete(key)
      pool.end().catch(() => undefined)
    }
  }

  targetOf(id) {
    const key = String(id ?? '')
    const direct = this.targets.get(key)
    if (direct !== undefined) return direct
    // A schema revealed by "全部库" was never configured, so its id is the
    // instance id plus the schema name. Resolving it on demand keeps an open tab
    // usable across a rediscovery that replaced the whole target map.
    const separator = key.indexOf('~')
    if (separator > 0) {
      const instance = this.targets.get(key.slice(0, separator))
      if (instance !== undefined) {
        const derived = { ...instance, id: key, database: key.slice(separator + 1) }
        this.targets.set(key, derived)
        return derived
      }
    }
    const error = new Error('unknown-target')
    error.code = 'unknown-target'
    throw error
  }

  poolFor(target) {
    const key = poolKey(target)
    const existing = this.pools.get(key)
    if (existing !== undefined) return existing
    const pool = createPool({
      host: target.host,
      port: target.port,
      user: target.user,
      password: target.password,
      database: target.database,
      connectTimeout: Math.max(2000, Number(this.config.connectTimeoutMs ?? 8000)),
      connectionLimit: Math.max(1, Number(this.config.connectionLimit ?? 4)),
      charset: 'utf8mb4',
      // Every new socket starts read-only, before any statement the viewer sends.
      connectAttributes: { program_name: 'dsh-data-window' },
    })
    pool.on('connection', (connection) => {
      connection.query('SET SESSION TRANSACTION READ ONLY', () => undefined)
      const timeout = Number(this.config.statementTimeoutMs ?? 60000)
      if (Number.isFinite(timeout) && timeout > 0) {
        connection.query(`SET SESSION max_execution_time = ${Math.floor(timeout)}`, () => undefined)
      }
    })
    this.pools.set(key, pool)
    return pool
  }

  /** Run one statement and return table-shaped rows. */
  async run(id, sql, options = {}) {
    const target = this.targetOf(id)
    const statement = assertReadOnly(sql)
    const limit = Math.min(MAX_LIMIT, Math.max(1, Number(options.limit ?? DEFAULT_LIMIT)))
    // One row past the ceiling is how the response knows it was truncated: an exact
    // `limit` rows may be the whole table, and claiming a truncation that did not
    // happen is worse than asking for one extra row.
    const prepared = withRowLimit(statement, limit + 1)
    const pool = this.poolFor(target)
    const startedAt = Date.now()
    this.statementCount += 1
    try {
      const [rows, fields] = await pool.query({ sql: prepared, timeout: Number(this.config.statementTimeoutMs ?? 60000) })
      const elapsedMs = Date.now() - startedAt
      if (!Array.isArray(rows)) {
        // DML-shaped metadata (an affected-row count) can only come from a statement
        // the whitelist let through; report it instead of pretending it is a table.
        return { kind: 'ok', sql: prepared, elapsedMs, affectedRows: Number(rows?.affectedRows ?? 0), columns: [], rows: [], rowCount: 0 }
      }
      const columns = (fields ?? []).map((field) => ({
        name: field.name,
        type: String(field.columnType ?? ''),
        flags: Number(field.flags ?? 0),
        // The protocol reports TEXT and BLOB under one type code; the character set
        // is what separates them (63 is the binary collation).
        charset: Number(field.characterSet ?? 0),
      }))
      const names = columns.length > 0 ? columns.map((column) => column.name) : Object.keys(rows[0] ?? {})
      const allValues = rows.map((row) => rowValues(row, names))
      const truncated = allValues.length > limit
      const values = truncated ? allValues.slice(0, limit) : allValues
      return {
        kind: 'rows',
        sql: statement,
        elapsedMs,
        columns: names.map((name, index) => ({
          name,
          type: columns[index]?.type ?? '',
          flags: columns[index]?.flags ?? 0,
          charset: columns[index]?.charset ?? 0,
        })),
        rows: values,
        rowCount: values.length,
        truncated,
        limit,
      }
    } catch (error) {
      const wrapped = new Error(error?.message ?? String(error))
      wrapped.code = error?.code ?? 'query-failed'
      wrapped.elapsedMs = Date.now() - startedAt
      wrapped.sql = prepared
      throw wrapped
    }
  }

  /**
   * Every schema on one instance, minus the ones nobody browses.
   *
   * Each schema comes back with the id the browser must use later, which is the
   * instance id plus the schema name: discovery only registers the schemas the
   * project's own configuration named.
   */
  async listDatabases(id) {
    const target = this.targetOf(id)
    const result = await this.run(id, 'SHOW DATABASES', { limit: MAX_LIMIT })
    const databases = []
    for (const row of result.rows) {
      const name = String(row[0] ?? '')
      if (name === '' || SYSTEM_SCHEMAS.has(name.toLowerCase())) continue
      const derivedId = `${target.id}~${name}`
      this.targets.set(derivedId, { ...target, id: derivedId, database: name })
      databases.push({ name, id: derivedId })
    }
    return { databases, total: result.rowCount, scanned: result.elapsedMs }
  }

  /** Tables and views of one schema with their comment and estimated size. */
  async listTables(id) {
    const target = this.targetOf(id)
    if (typeof target.database !== 'string') {
      const error = new Error('database-required')
      error.code = 'database-required'
      throw error
    }
    const result = await this.run(
      id,
      `SELECT TABLE_NAME, TABLE_TYPE, COALESCE(TABLE_COMMENT, ''), COALESCE(TABLE_ROWS, 0), COALESCE(ENGINE, '')
         FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = ${sqlString(target.database)}
        ORDER BY TABLE_NAME`,
      { limit: MAX_LIMIT },
    )
    return {
      tables: result.rows.map((row) => ({
        name: String(row[0] ?? ''),
        kind: String(row[1] ?? '').toUpperCase() === 'VIEW' ? 'view' : 'table',
        comment: String(row[2] ?? ''),
        rows: Number(row[3] ?? 0),
        engine: String(row[4] ?? ''),
      })),
      elapsedMs: result.elapsedMs,
    }
  }

  /** Columns of one table, in declaration order. */
  async listColumns(id, table) {
    const target = this.targetOf(id)
    const result = await this.run(
      id,
      `SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COALESCE(COLUMN_KEY, ''), COLUMN_DEFAULT, COALESCE(EXTRA, ''), COALESCE(COLUMN_COMMENT, '')
         FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = ${sqlString(target.database)} AND TABLE_NAME = ${sqlString(table)}
        ORDER BY ORDINAL_POSITION`,
      { limit: MAX_LIMIT },
    )
    return {
      columns: result.rows.map((row) => ({
        name: String(row[0] ?? ''),
        type: String(row[1] ?? ''),
        nullable: String(row[2] ?? '').toUpperCase() === 'YES',
        key: String(row[3] ?? ''),
        defaultValue: row[4] === null ? null : String(row[4]),
        extra: String(row[5] ?? ''),
        comment: String(row[6] ?? ''),
      })),
    }
  }

  /**
   * Every table and column of one schema in one round trip.
   *
   * The SQL editor suggests table and column names; one map call per database
   * beats a `columns` call per referenced table, and it is what lets the editor
   * suggest columns of tables the tree has never expanded.
   */
  async schemaMap(id) {
    const target = this.targetOf(id)
    if (typeof target.database !== 'string') {
      const error = new Error('database-required')
      error.code = 'database-required'
      throw error
    }
    const result = await this.run(
      id,
      `SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE
         FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = ${sqlString(target.database)}
        ORDER BY TABLE_NAME, ORDINAL_POSITION`,
      { limit: MAX_LIMIT },
    )
    const tables = new Map()
    for (const row of result.rows) {
      const name = String(row[0] ?? '')
      if (name === '') continue
      let table = tables.get(name)
      if (table === undefined) {
        table = { name, columns: [] }
        tables.set(name, table)
      }
      table.columns.push({ name: String(row[1] ?? ''), type: String(row[2] ?? '') })
    }
    return {
      database: target.database,
      tables: [...tables.values()],
      truncated: result.truncated,
      elapsedMs: result.elapsedMs,
    }
  }

  /** The DDL of one table, plus its indexes. */
  async showCreate(id, table) {
    const target = this.targetOf(id)
    const schema = typeof target.database === 'string' ? target.database : undefined
    const qualified = `${schema === undefined ? '' : `${quoteIdentifier(schema)}.`}${quoteIdentifier(table)}`
    const create = await this.run(id, `SHOW CREATE TABLE ${qualified}`, { limit: 10 })
    const ddl = String(create.rows[0]?.[1] ?? '')
    const columns = await this.listColumns(id, table).catch(() => ({ columns: [] }))
    return {
      table,
      database: schema ?? '',
      ddl,
      statementTime: create.elapsedMs,
      // `SHOW CREATE TABLE` already embeds indexes, so no second round trip is
      // needed; the column list is what the panel shows above the DDL.
      columns: columns.columns,
    }
  }

  /** Cheap liveness check for one instance. */
  async ping(id) {
    const target = this.targetOf(id)
    const startedAt = Date.now()
    const result = await this.run(id, 'SELECT VERSION() AS server_version, DATABASE() AS database_name, CURRENT_USER() AS current_user_name', { limit: 1 })
    const row = result.rows[0] ?? []
    return {
      host: target.host,
      port: target.port,
      env: target.env,
      version: String(row[0] ?? ''),
      database: row[1] === null ? null : String(row[1]),
      currentUser: String(row[2] ?? ''),
      elapsedMs: Date.now() - startedAt,
    }
  }

  /** Tell the driver to stop serving this target. */
  async forget(id) {
    const target = this.targets.get(String(id ?? ''))
    if (target === undefined) return false
    const key = poolKey(target)
    const pool = this.pools.get(key)
    this.pools.delete(key)
    if (pool !== undefined) await pool.end().catch(() => undefined)
    return true
  }

  async close() {
    const pools = [...this.pools.values()]
    this.pools.clear()
    await Promise.all(pools.map((pool) => pool.end().catch(() => undefined)))
  }
}

/** Quote one identifier for a statement this module builds itself. */
export function quoteIdentifier(value) {
  return `\`${String(value).replace(/`/g, '``')}\``
}

/** Quote one literal for a statement this module builds itself. */
export function sqlString(value) {
  return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}
