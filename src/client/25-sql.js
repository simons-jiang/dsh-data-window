/**
 * SQL lexer, completion and formatter.
 *
 * The editor is a textarea, so highlighting is an overlay of tokens and the
 * completion list is built from the schema the Host already exposes. All three
 * features share one lexer: a single definition of strings, comments and
 * keywords that cannot drift apart.
 *
 * Nothing here touches the DOM or React; the functions are pure so they can be
 * exercised from Node.
 */

/**
 * Words the editor colours as keywords.
 *
 * The list deliberately covers DDL as well as queries: a create statement is what
 * the DDL dialog shows, and a statement whose `NOT NULL`, `DEFAULT`, `COMMENT` and
 * storage options stay white reads as one flat block.
 */
const DW_SQL_KEYWORDS = new Set(`select from where group by order having limit offset union all distinct join inner left right outer full cross natural on using and or not in is null like between exists case when then else end as asc desc insert into values update set delete create drop alter table index view show describe explain with recursive partition over window primary key foreign references constraint unique fulltext spatial btree hash default auto_increment collate collation charset character engine comment unsigned zerofill generated always stored virtual check cascade restrict rename change modify add column after first temporary if replace ignore low_priority high_priority quick delayed row_format checksum delay_key_write max_rows min_rows pack_keys stats_auto_recalc stats_persistent stats_sample_pages connection directory start transaction begin commit rollback savepoint lock unlock read write grant revoke flush analyze optimize repair truncate load infile outfile fields lines terminated enclosed escaped optionally duplicates procedure function trigger event returns deterministic reads modifies contains sql language call declare while repeat loop leave iterate signal resignal condition handler continue exit undo open close fetch cursor prepare execute deallocate delimiter names current_date current_time current_timestamp current_user localtime localtimestamp`.split(' '))

/** Data types, coloured apart from keywords and user identifiers. */
const DW_SQL_TYPES = new Set(`bit tinyint smallint mediumint int integer bigint decimal numeric dec fixed float double real char varchar nchar nvarchar binary varbinary tinyblob blob mediumblob longblob tinytext text mediumtext longtext enum json jsonb date datetime timestamp time year boolean bool serial geometry point linestring polygon multipoint multilinestring multipolygon geometrycollection`.split(' '))

/** Words coloured as functions; the schema supplies the rest. */
const DW_SQL_FUNCTIONS = new Set(`count sum avg min max coalesce ifnull nullif isnull greatest least concat concat_ws substr substring substring_index length char_length character_length octet_length lower upper lcase ucase trim ltrim rtrim left right mid locate instr position replace round ceil ceiling floor abs mod pow power sqrt exp ln log log2 log10 sign rand truncate pi sin cos tan asin acos atan atan2 radians degrees cast convert date_format str_to_date now curdate curtime datediff date_add date_sub timestampdiff timestampadd adddate subdate addtime subtime period_add period_diff convert_tz get_format extract year month day hour minute second dayofweek dayofmonth dayofyear last_day week weekday monthname quarter makedate maketime sec_to_time time_to_sec utc_date utc_time utc_timestamp from_days to_days if group_concat json_extract json_unquote json_length json_type json_valid json_object json_array json_set json_insert json_replace json_remove json_contains json_contains_path json_keys json_search json_pretty json_quote json_depth unix_timestamp from_unixtime row_number rank dense_rank lag lead`.split(' '))

/** Literals that are keywords in effect. */
const DW_SQL_LITERALS = new Set(['null', 'true', 'false'])

const DW_SQL_OPERATORS = ['<=>', '<=', '>=', '<>', '!=', '||', '&&', ':=', '=', '<', '>', '+', '-', '*', '/', '%', '!', '&', '|', '^', '~']
const DW_SQL_PUNCT = new Set(['(', ')', ',', '.', ';', '[', ']'])

/** Split SQL into tokens; whitespace is kept so highlighting reproduces it. */
export function dwSqlLex(text) {
  const source = String(text ?? '')
  const tokens = []
  let index = 0
  while (index < source.length) {
    const start = index
    const char = source[index]
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
      while (index < source.length && /[ \t\n\r]/.test(source[index])) index += 1
      tokens.push({ type: 'space', value: source.slice(start, index), start, end: index })
      continue
    }
    if (char === '-' && source[index + 1] === '-') {
      index += 2
      while (index < source.length && source[index] !== '\n') index += 1
      tokens.push({ type: 'comment', value: source.slice(start, index), start, end: index })
      continue
    }
    if (char === '#') {
      index += 1
      while (index < source.length && source[index] !== '\n') index += 1
      tokens.push({ type: 'comment', value: source.slice(start, index), start, end: index })
      continue
    }
    if (char === '/' && source[index + 1] === '*') {
      index += 2
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) index += 1
      index = Math.min(source.length, index + 2)
      tokens.push({ type: 'comment', value: source.slice(start, index), start, end: index })
      continue
    }
    if (char === "'" || char === '"' || char === '`') {
      index += 1
      while (index < source.length) {
        if (source[index] === '\\') {
          index += 2
          continue
        }
        if (source[index] === char) {
          if (source[index + 1] === char) {
            index += 2
            continue
          }
          index += 1
          break
        }
        index += 1
      }
      const value = source.slice(start, index)
      const closed = value.length > 1 && value[value.length - 1] === char
      tokens.push({ type: closed ? (char === '`' ? 'identifier' : 'string') : 'string', value, start, end: index })
      continue
    }
    if (/[0-9]/.test(char)) {
      while (index < source.length && /[0-9]/.test(source[index])) index += 1
      if (source[index] === '.') {
        index += 1
        while (index < source.length && /[0-9]/.test(source[index])) index += 1
      }
      if (/[eE]/.test(source[index] ?? '')) {
        index += 1
        if (/[+-]/.test(source[index] ?? '')) index += 1
        while (index < source.length && /[0-9]/.test(source[index])) index += 1
      }
      tokens.push({ type: 'number', value: source.slice(start, index), start, end: index })
      continue
    }
    if (char === '@' || char === '?') {
      index += 1
      while (index < source.length && /[A-Za-z0-9_$.@]/.test(source[index])) index += 1
      tokens.push({ type: 'variable', value: source.slice(start, index), start, end: index })
      continue
    }
    if (/[A-Za-z_$]/.test(char)) {
      while (index < source.length && /[A-Za-z0-9_$]/.test(source[index])) index += 1
      const value = source.slice(start, index)
      const lower = value.toLowerCase()
      // Keywords win over types because a few words are both (`SET` in an UPDATE
      // and `SET(...)` in DDL); the statement form is the common one.
      const type = DW_SQL_LITERALS.has(lower)
        ? 'literal'
        : DW_SQL_KEYWORDS.has(lower)
          ? 'keyword'
          : DW_SQL_TYPES.has(lower)
            ? 'type'
            : DW_SQL_FUNCTIONS.has(lower) ? 'function' : 'identifier'
      tokens.push({ type, value, start, end: index })
      continue
    }
    const operator = DW_SQL_OPERATORS.find((candidate) => source.startsWith(candidate, index))
    if (operator !== undefined) {
      index += operator.length
      tokens.push({ type: 'operator', value: operator, start, end: index })
      continue
    }
    index += 1
    tokens.push({ type: DW_SQL_PUNCT.has(char) ? 'punct' : 'identifier', value: char, start, end: index })
  }
  return tokens
}

/**
 * Split one statement's outermost trailing `LIMIT` into its base and page shape.
 *
 * Only the limit at parenthesis depth zero counts, so `FROM (SELECT … LIMIT 5)` is
 * left alone. Returns undefined when the statement has no paginable limit, which is
 * what the result bar uses to hide the pager for statements that are not paged.
 *
 * @returns `{ base, size, offset }`: the SQL without its LIMIT, the page capacity,
 *   and the offset the statement asked for (`LIMIT 100`, `LIMIT 20, 100`, `LIMIT 100 OFFSET 20`)
 */
export function dwSqlPage(text) {
  const source = String(text ?? '')
  const tokens = dwSqlLex(source).filter((token) => token.type !== 'space' && token.type !== 'comment')
  let end = tokens.length
  while (end > 0 && tokens[end - 1].value === ';') end -= 1
  let depth = 0
  let limitIndex = -1
  for (let index = 0; index < end; index += 1) {
    const value = tokens[index].value.toLowerCase()
    if (value === '(') depth += 1
    else if (value === ')') depth = Math.max(0, depth - 1)
    else if (depth === 0 && value === 'limit') limitIndex = index
  }
  if (limitIndex < 0) return undefined
  const tail = tokens.slice(limitIndex + 1, end)
  const integer = (token) => (token !== undefined && token.type === 'number' && /^\d+$/.test(token.value) ? Number(token.value) : undefined)
  const first = integer(tail[0])
  if (first === undefined) return undefined
  let size = first
  let offset = 0
  if (tail.length === 3 && tail[1].value === ',') {
    const second = integer(tail[2])
    if (second === undefined) return undefined
    // LIMIT offset, size — the first number is the offset.
    offset = first
    size = second
  } else if (tail.length === 3 && tail[1].value.toLowerCase() === 'offset') {
    const second = integer(tail[2])
    if (second === undefined) return undefined
    offset = second
  } else if (tail.length !== 1) {
    return undefined
  }
  if (size <= 0 || offset < 0) return undefined
  return { base: source.slice(0, tokens[limitIndex].start).trimEnd(), size, offset }
}

/**
 * The single table a plain `SELECT` reads, for UPDATE/INSERT generation.
 *
 * A join is deliberately not resolved: which table a result row belongs to is then
 * ambiguous, and inventing one would produce an INSERT that writes to the wrong
 * place. The caller surfaces that refusal to the user instead.
 */
export function dwSqlTargetTable(text) {
  const source = String(text ?? '')
  const tokens = dwSqlLex(source).filter((token) => token.type !== 'space' && token.type !== 'comment')
  let end = tokens.length
  while (end > 0 && tokens[end - 1].value === ';') end -= 1
  if (end === 0 || tokens[0].value.toLowerCase() !== 'select') return undefined
  let depth = 0
  let fromIndex = -1
  for (let index = 0; index < end; index += 1) {
    const value = tokens[index].value.toLowerCase()
    if (value === '(') depth += 1
    else if (value === ')') depth = Math.max(0, depth - 1)
    else if (depth === 0 && fromIndex < 0 && value === 'from') fromIndex = index
  }
  // The select list must be plain columns (`*`, `id`, `t.*`, `t.id`): an expression
  // or an alias would make the result's column names unusable in an INSERT.
  let listDepth = 0
  let item = []
  const items = []
  for (let cursor = 1; cursor < fromIndex; cursor += 1) {
    const token = tokens[cursor]
    if (token.value === '(') listDepth += 1
    else if (token.value === ')') listDepth = Math.max(0, listDepth - 1)
    if (listDepth === 0 && token.value === ',') {
      items.push(item)
      item = []
      continue
    }
    item.push(token)
  }
  items.push(item)
  if (['distinct', 'all'].includes(items[0]?.[0]?.value.toLowerCase())) items[0] = items[0].slice(1)
  for (const entry of items) {
    const head = entry[0]
    if (entry.length === 1 && (head.value === '*' || head.type === 'identifier')) continue
    if (entry.length === 3 && head.type === 'identifier' && entry[1].value === '.' && (entry[2].value === '*' || entry[2].type === 'identifier')) continue
    return undefined
  }

  if (fromIndex < 0) return undefined
  let index = fromIndex + 1
  const readName = () => {
    const token = tokens[index]
    if (token === undefined) return undefined
    if (token.type !== 'identifier' && token.type !== 'string') return undefined
    index += 1
    return token.value.replace(/^`|`$/g, '')
  }
  const first = readName()
  if (first === undefined) return undefined
  let database = ''
  let table = first
  if (tokens[index]?.value === '.') {
    index += 1
    const second = readName()
    if (second === undefined) return undefined
    database = first
    table = second
  }
  // A join or a second table makes "this row" ambiguous: refuse to generate SQL.
  let joined = 0
  for (let cursor = index; cursor < end; cursor += 1) {
    const value = tokens[cursor].value.toLowerCase()
    if (value === '(') joined += 1
    else if (value === ')') joined = Math.max(0, joined - 1)
    else if (joined === 0 && (value === ',' || value === 'join')) return undefined
  }
  return { database, table }
}

/** One SQL literal: numbers stay bare, everything else is quoted with '' doubling. */
export function dwSqlLiteral(value, numeric) {
  if (value === null || value === undefined) return 'NULL'
  const text = String(value)
  if (numeric === true && /^-?\d+(\.\d+)?$/.test(text.trim())) return text.trim()
  return `'${text.replace(/'/g, "''")}'`
}

/** Build the UPDATE a result row editor copies; it is never executed here. */
export function dwSqlUpdate(target, assignments, conditions) {
  const quote = (name) => `\`${String(name).replace(/`/g, '``')}\``
  const from = target.database === '' ? quote(target.table) : `${quote(target.database)}.${quote(target.table)}`
  const set = assignments.map((entry) => `${quote(entry.column)} = ${dwSqlLiteral(entry.value, entry.numeric)}`).join(', ')
  const where = conditions.map((entry) => `${quote(entry.column)} = ${dwSqlLiteral(entry.value, entry.numeric)}`).join(' AND ')
  // No LIMIT: the WHERE is the row's primary key, so it is already unique, and
  // `UPDATE … LIMIT` is MySQL-only syntax that would break when pasted elsewhere.
  return `UPDATE ${from}\nSET ${set}\nWHERE ${where};`
}

/** MySQL's PRI_KEY_FLAG marks the columns of the primary key. */
export function dwIsPrimaryKey(column) {
  return (Number(column?.flags ?? 0) & 2) === 2
}

/** Tokens that carry meaning for completion and formatting. */
function dwSqlSignificant(tokens) {
  return tokens.filter((token) => token.type !== 'space')
}

/** Strip the backticks/quoting one identifier carries. */
function dwSqlUnquote(value) {
  const text = String(value ?? '').trim()
  if (text.length > 1 && (text[0] === '`' || text[0] === '"') && text[text.length - 1] === text[0]) {
    return text.slice(1, -1)
  }
  return text
}

/**
 * `db.table` → `table`, aware of per-part backticks.
 *
 * MySQL statements in this console usually quote both parts (`db`.`table`), so
 * splitting on the raw string leaves a leading backtick on the table name and the
 * schema lookup misses.
 */
function dwSqlTableName(value) {
  const text = String(value ?? '').trim()
  let quoted = false
  let lastDot = -1
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (char === '`') quoted = !quoted
    else if (char === '.' && !quoted) lastDot = index
  }
  return dwSqlUnquote(text.slice(lastDot + 1).trim())
}

/**
 * Tables and aliases the statement mentions.
 *
 * Only `FROM` and `JOIN` are scanned; a comma-separated FROM list is rare in this
 * console's queries and a miss only means fewer column suggestions.
 */
export function dwSqlTableRefs(text) {
  const refs = []
  const seen = new Set()
  const pattern = /\b(from|join)\s+((?:`[^`]+`|[A-Za-z0-9_$]+)(?:\.(?:`[^`]+`|[A-Za-z0-9_$]+))?)(?:\s+(?:as\s+)?(`[^`]+`|[A-Za-z_][A-Za-z0-9_$]*))?/gi
  let match
  while ((match = pattern.exec(String(text ?? ''))) !== null) {
    const table = dwSqlTableName(match[2])
    if (table === '') continue
    let alias = match[3] === undefined ? table : dwSqlUnquote(match[3])
    if (DW_SQL_KEYWORDS.has(alias.toLowerCase()) || alias === '') alias = table
    const key = alias.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    refs.push({ table, alias })
  }
  return refs
}

/** The word being typed and the context around it. */
function dwSqlCompletionPrefix(source, caret) {
  let start = caret
  while (start > 0 && /[A-Za-z0-9_$`]/.test(source[start - 1])) start -= 1
  const prefix = source.slice(start, caret).replace(/`/g, '')
  let qualifier = ''
  let before = source.slice(0, start).replace(/\s+$/, '')
  if (before.endsWith('.')) {
    const match = /([A-Za-z0-9_$`]+)\.$/.exec(before)
    qualifier = match === null ? '' : dwSqlUnquote(match[1])
    before = before.slice(0, -1 - qualifier.length).replace(/\s+$/, '')
  }
  const previous = /([A-Za-z_][A-Za-z0-9_$]*)$/.exec(before)
  return {
    prefix,
    qualifier,
    startedAfterDot: qualifier !== '',
    previousWord: previous === null ? '' : previous[1].toLowerCase(),
    from: start,
    to: caret,
  }
}

/** Which family of suggestions a clause asks for. */
function dwSqlSuggestionKind(context) {
  if (context.qualifier !== '') return 'column'
  const word = context.previousWord
  if (['from', 'join', 'into', 'update', 'table'].includes(word)) return 'table'
  if (['select', 'where', 'on', 'and', 'or', 'having', 'by', 'set', 'using', 'distinct', 'case', 'when', 'then', 'else', 'order', 'group', 'value'].includes(word)) return 'column'
  return 'any'
}

/**
 * Build the suggestion list for the caret.
 *
 * `schema` is the Host's map of the current database (`{ tables: [{ name,
 * columns: [{ name, type }] }] }`); without it the list degrades to keywords.
 */
export function dwSqlCompletion(text, caret, schema) {
  const source = String(text ?? '')
  const position = Math.max(0, Math.min(Number(caret) || 0, source.length))
  const context = dwSqlCompletionPrefix(source, position)
  const kind = dwSqlSuggestionKind(context)
  const prefix = context.prefix.toLowerCase()
  const tables = Array.isArray(schema?.tables) ? schema.tables : []
  const refs = dwSqlTableRefs(source)
  const items = []
  const seen = new Set()

  const add = (label, type, detail) => {
    const key = `${type}\u0000${label.toLowerCase()}`
    if (seen.has(key)) return
    if (prefix !== '' && !label.toLowerCase().startsWith(prefix)) return
    if (label.toLowerCase() === prefix) return
    seen.add(key)
    items.push({ label, kind: type, detail })
  }

  const tableWith = (name) => tables.find((table) => table.name.toLowerCase() === name.toLowerCase())

  if (context.qualifier !== '') {
    const ref = refs.find((entry) => entry.alias.toLowerCase() === context.qualifier.toLowerCase())
      ?? refs.find((entry) => entry.table.toLowerCase() === context.qualifier.toLowerCase())
    const table = tableWith(ref?.table ?? context.qualifier)
    for (const column of Array.isArray(table?.columns) ? table.columns : []) {
      add(column.name, 'column', `${table.name}.${column.type ?? ''}`)
    }
  } else if (kind === 'table') {
    for (const table of tables) add(table.name, 'table', `${table.columns?.length ?? 0} 列`)
    for (const ref of refs) add(ref.table, 'table', '已引用')
  } else {
    if (kind === 'column' || kind === 'any') {
      for (const ref of refs) {
        const table = tableWith(ref.table)
        for (const column of Array.isArray(table?.columns) ? table.columns : []) {
          add(column.name, 'column', `${ref.alias === ref.table ? ref.table : `${ref.alias} → ${ref.table}`}.${column.type ?? ''}`)
        }
      }
      if (refs.length === 0) {
        for (const table of tables) {
          for (const column of Array.isArray(table.columns) ? table.columns : []) {
            add(column.name, 'column', `${table.name}.${column.type ?? ''}`)
          }
        }
      }
    }
    if (kind !== 'column') {
      for (const keyword of DW_SQL_KEYWORDS) add(keyword.toUpperCase(), 'keyword', '关键字')
    }
  }

  items.sort((left, right) => {
    const weight = (item) => (item.kind === 'column' ? 0 : item.kind === 'table' ? 1 : 2)
    if (weight(left) !== weight(right)) return weight(left) - weight(right)
    return left.label.length - right.label.length || (left.label < right.label ? -1 : 1)
  })

  return {
    items: items.slice(0, 50),
    from: context.from,
    to: context.to,
    prefix: context.prefix,
    kind,
  }
}

const DW_SQL_JOIN_PREFIXES = new Set(['left', 'right', 'inner', 'outer', 'full', 'cross', 'natural'])

/** Whether the select list starting at `index` carries a top-level comma. */
function dwSqlSelectListHasComma(tokens, index) {
  let depth = 0
  for (let cursor = index; cursor < tokens.length; cursor += 1) {
    const value = tokens[cursor].value
    if (value === '(') {
      depth += 1
      continue
    }
    if (value === ')') {
      if (depth === 0) return false
      depth -= 1
      continue
    }
    const lower = value.toLowerCase()
    if (depth === 0 && ['from', 'where', 'group', 'order', 'having', 'limit', 'union'].includes(lower)) return false
    if (depth === 0 && value === ',') return true
  }
  return false
}

/** Collapse the run of spaces/tabs one line may start with. */
function dwSqlIndent(level) {
  return ' '.repeat(Math.max(0, level))
}

/**
 * Reindent a statement: clause keywords on their own line, one select item per
 * line, joins and boolean operators indented one level. Keyword case and inline
 * spacing are preserved; only line breaks and indentation move.
 */
export function dwFormatSql(text) {
  const tokens = dwSqlSignificant(dwSqlLex(text))
  if (tokens.length === 0) return ''

  const lines = []
  let line = ''
  let depth = 0
  let clause = ''
  let selectDepth = -1
  const parens = []

  const push = (value) => {
    line += value
  }
  const pushWord = (value) => {
    const last = line[line.length - 1]
    if (line !== '' && last !== ' ' && last !== '.' && last !== '(' && value !== '.' && value !== ')' && value !== ',' && value !== '(') {
      line += ' '
    }
    line += value
  }
  const newlineAt = (level) => {
    lines.push(line.trimEnd())
    line = dwSqlIndent(level)
  }
  const atIndex = (index) => (tokens[index] === undefined ? '' : tokens[index].value.toLowerCase())
  const isWord = (index) => tokens[index] !== undefined && tokens[index].type === 'identifier'

  let index = 0
  while (index < tokens.length) {
    const token = tokens[index]
    const lower = token.value.toLowerCase()
    const next = atIndex(index + 1)

    if (token.type === 'comment') {
      if (line.trim() !== '') newlineAt(depth * 2)
      push(token.value)
      newlineAt(depth * 2)
      index += 1
      continue
    }

    // Multi-word clause keywords: GROUP BY / ORDER BY / UNION ALL / JOIN prefixes.
    if (lower === 'group' && next === 'by') {
      newlineAt(depth * 2)
      push(`${token.value} ${tokens[index + 1].value}`)
      clause = 'group'
      index += 2
      continue
    }
    if (lower === 'order' && next === 'by') {
      newlineAt(depth * 2)
      push(`${token.value} ${tokens[index + 1].value}`)
      clause = 'order'
      index += 2
      continue
    }
    if (lower === 'union') {
      newlineAt(depth * 2)
      push(token.value)
      if (next === 'all' || next === 'distinct') {
        push(` ${tokens[index + 1].value}`)
        index += 2
      } else {
        index += 1
      }
      clause = 'union'
      continue
    }
    if (
      lower === 'join'
      || (DW_SQL_JOIN_PREFIXES.has(lower) && ['join', 'outer'].includes(next))
      || (DW_SQL_JOIN_PREFIXES.has(lower) && next === 'outer' && atIndex(index + 2) === 'join')
    ) {
      newlineAt(depth * 2 + 2)
      let consumed = 1
      if (lower !== 'join') consumed = 2
      if (next === 'outer' && atIndex(index + 2) === 'join') consumed = 3
      push(tokens.slice(index, index + consumed).map((entry) => entry.value).join(' '))
      clause = 'join'
      index += consumed
      continue
    }

    if (token.type === 'keyword') {
      if (lower === 'select') {
        newlineAt(depth * 2)
        push(token.value)
        clause = 'select'
        selectDepth = depth
        if (dwSqlSelectListHasComma(tokens, index + 1)) newlineAt(depth * 2 + 2)
        index += 1
        continue
      }
      if (['from', 'where', 'having', 'limit', 'offset'].includes(lower)) {
        newlineAt(depth * 2)
        push(token.value)
        clause = lower
        if (lower === 'from') selectDepth = -1
        index += 1
        continue
      }
      if (lower === 'on') {
        pushWord(token.value)
        clause = 'on'
        index += 1
        continue
      }
      if ((lower === 'and' || lower === 'or') && ['where', 'having', 'on'].includes(clause)) {
        newlineAt(depth * 2 + 2)
        push(token.value)
        index += 1
        continue
      }
    }

    if (token.value === '(') {
      push('(')
      depth += 1
      const subquery = atIndex(index + 1) === 'select'
      parens.push({ subquery })
      if (subquery) {
        newlineAt(depth * 2)
        push(tokens[index + 1].value)
        clause = 'select'
        selectDepth = depth
        index += 2
        continue
      }
      index += 1
      continue
    }
    if (token.value === ')') {
      depth = Math.max(0, depth - 1)
      const scope = parens.pop()
      if (scope !== undefined && scope.subquery === true) {
        newlineAt(depth * 2)
      }
      push(')')
      index += 1
      continue
    }
    if (token.value === ',') {
      push(',')
      if (clause === 'select' && selectDepth === depth) newlineAt(depth * 2 + 2)
      else pushWord('')
      index += 1
      continue
    }
    if (token.value === ';') {
      push(';')
      newlineAt(0)
      index += 1
      continue
    }

    pushWord(token.value)
    if (token.value === '.') line = line.replace(/ $/, '')
    index += 1
  }

  lines.push(line.trimEnd())
  return lines
    .map((entry) => entry.replace(/\s+$/, ''))
    .filter((entry, position, all) => entry !== '' || (position > 0 && position < all.length - 1))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export { DW_SQL_KEYWORDS, DW_SQL_TYPES, DW_SQL_FUNCTIONS }
