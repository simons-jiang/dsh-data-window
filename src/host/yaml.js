/**
 * A YAML subset parser for Spring/Nacos configuration files.
 *
 * A database viewer must read the project's own configuration, and those files
 * are plain Spring YAML: nested maps, block lists, multi-document files, `#`
 * comments and quoted scalars. That is a small, well-defined slice of YAML, so
 * the plugin carries this reader instead of depending on a full parser (which
 * would drag a YAML engine into the Host for four features).
 *
 * Explicitly unsupported, because a datasource block never uses them: anchors and
 * aliases, merge keys, flow collections (`{a: 1}`, `[a, b]`), tags, and folded
 * block scalars. `|` and `>` blocks are skipped rather than mis-parsed.
 */

/** Split a raw line at a `#` comment that is outside quotes. */
function stripComment(line) {
  let single = false
  let double = false
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]
    if (character === "'" && !double) single = !single
    else if (character === '"' && !single) double = !double
    else if (character === '#' && !single && !double && (index === 0 || /\s/.test(line[index - 1]))) {
      return line.slice(0, index)
    }
  }
  return line
}

/** Turn one raw scalar into a value; unknown shapes stay strings. */
function scalar(raw) {
  const value = raw.trim()
  if (value === '' || value === '~' || value === 'null') return null
  if (value.length >= 2) {
    const first = value[0]
    const last = value[value.length - 1]
    if (first === last && (first === '"' || first === "'")) return value.slice(1, -1)
  }
  if (value === 'true') return true
  if (value === 'false') return false
  // Numbers stay strings on purpose: a port, a pool size and a password all read
  // back as text and only the consumer decides what is numeric.
  return value
}

/**
 * Find the `key:` separator of a mapping line.
 *
 * The first colon followed by whitespace (or ending the line) wins, which is what
 * keeps `url: jdbc:mysql://host/db` splitting after `url` instead of after
 * `jdbc`.
 */
function keySeparator(text) {
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== ':') continue
    const next = text[index + 1]
    if (next === undefined || next === ' ' || next === '\t') {
      return { colon: index, rest: text.slice(index + 1).trim() }
    }
  }
  return null
}

/** A block scalar body (`|`, `>`) belongs to the line before it; drop it. */
function isBlockScalarHeader(text) {
  const separator = keySeparator(text)
  if (separator === null) return false
  return /^[|>][-+]?[0-9]?$/.test(separator.rest)
}

/** Parse a mapping starting at `start` whose keys sit at `indent`. */
function parseMapping(lines, start, indent) {
  const node = {}
  let index = start
  while (index < lines.length) {
    const line = lines[index]
    if (line.indent < indent) break
    if (line.indent > indent) {
      index += 1
      continue
    }
    if (line.text === '-' || line.text.startsWith('- ')) break
    const separator = keySeparator(line.text)
    if (separator === null) {
      index += 1
      continue
    }
    const key = line.text.slice(0, separator.colon).trim()
    if (key === '') {
      index += 1
      continue
    }
    if (separator.rest === '' || isBlockScalarHeader(line.text)) {
      const next = lines[index + 1]
      if (next !== undefined && next.indent > indent) {
        const parsed = parseBlock(lines, index + 1, next.indent)
        node[key] = parsed.node
        index = parsed.next
      } else if (next !== undefined && next.indent === indent && (next.text === '-' || next.text.startsWith('- '))) {
        const parsed = parseSequence(lines, index + 1, indent)
        node[key] = parsed.node
        index = parsed.next
      } else {
        node[key] = null
        index += 1
      }
      continue
    }
    node[key] = scalar(separator.rest)
    index += 1
  }
  return { node, next: index }
}

/** Parse a block sequence starting at `start` whose dashes sit at `indent`. */
function parseSequence(lines, start, indent) {
  const node = []
  let index = start
  while (index < lines.length) {
    const line = lines[index]
    if (line.indent !== indent) break
    if (line.text !== '-' && !line.text.startsWith('- ')) break
    const rest = line.text === '-' ? '' : line.text.slice(1).trim()
    if (rest === '') {
      const next = lines[index + 1]
      if (next !== undefined && next.indent > indent) {
        const parsed = parseBlock(lines, index + 1, next.indent)
        node.push(parsed.node)
        index = parsed.next
      } else {
        node.push(null)
        index += 1
      }
      continue
    }
    const separator = keySeparator(rest)
    if (separator === null) {
      node.push(scalar(rest))
      index += 1
      continue
    }
    // `- key: value` opens a mapping whose remaining keys sit deeper than the dash.
    const item = {}
    const firstKey = rest.slice(0, separator.colon).trim()
    item[firstKey] = separator.rest === '' ? null : scalar(separator.rest)
    index += 1
    const next = lines[index]
    if (next !== undefined && next.indent > indent) {
      const parsed = parseMapping(lines, index, next.indent)
      Object.assign(item, parsed.node)
      index = parsed.next
    }
    node.push(item)
  }
  return { node, next: index }
}

function parseBlock(lines, start, indent) {
  if (lines[start] !== undefined && (lines[start].text === '-' || lines[start].text.startsWith('- '))) {
    return parseSequence(lines, start, indent)
  }
  return parseMapping(lines, start, indent)
}

/** Rewrite continuation lines of a block scalar so they are not read as keys. */
function neutralizeBlockScalars(rawLines) {
  const result = []
  let skipIndent = -1
  for (const raw of rawLines) {
    const line = stripComment(raw)
    const trimmed = line.trim()
    if (skipIndent >= 0) {
      if (trimmed === '' || line.length - line.trimStart().length > skipIndent) {
        result.push({ indent: 0, text: '~', blank: true })
        continue
      }
      skipIndent = -1
    }
    if (trimmed === '') {
      result.push({ indent: 0, text: '', blank: true })
      continue
    }
    result.push({ indent: line.length - line.trimStart().length, text: trimmed, blank: false })
    if (isBlockScalarHeader(trimmed)) skipIndent = line.length - line.trimStart().length
  }
  return result
}

/**
 * Parse a YAML document into plain objects.
 *
 * @returns every non-empty document, in file order.
 */
export function parseYaml(text) {
  const documents = []
  let buffer = []
  const flush = () => {
    if (buffer.some((line) => stripComment(line).trim() !== '')) {
      const lines = neutralizeBlockScalars(buffer).filter((line) => line.blank === false)
      if (lines.length > 0) documents.push(parseBlock(lines, 0, lines[0].indent).node)
    }
    buffer = []
  }
  for (const raw of String(text).replace(/\r\n?/g, '\n').split('\n')) {
    if (/^---\s*$/.test(raw) || /^\.\.\.\s*$/.test(raw)) {
      flush()
      continue
    }
    buffer.push(raw)
  }
  flush()
  return documents
}

/** Flatten a parsed document into `dotted.path → scalar` entries. */
export function flattenYaml(node, prefix = '', into = new Map()) {
  if (node === null || typeof node !== 'object') {
    if (prefix !== '') into.set(prefix, node)
    return into
  }
  if (Array.isArray(node)) {
    node.forEach((item, index) => flattenYaml(item, prefix === '' ? String(index) : `${prefix}.${index}`, into))
    return into
  }
  for (const [key, value] of Object.entries(node)) {
    flattenYaml(value, prefix === '' ? key : `${prefix}.${key}`, into)
  }
  return into
}

/** Parse every document of one file and return one merged, flattened map. */
export function readVariables(text) {
  const variables = new Map()
  for (const document of parseYaml(text)) {
    for (const [key, value] of flattenYaml(document)) variables.set(key, value)
  }
  return variables
}

const PLACEHOLDER = /\$\{([^}]+)\}/g

/**
 * Resolve `${a.b}` and `${a.b:fallback}` against a variable map.
 *
 * Resolution recurses because one config value can name another placeholder, and
 * an unresolvable placeholder becomes its fallback (or an empty string), which is
 * exactly what Spring does.
 */
export function resolveTemplate(text, variables, depth = 0) {
  if (typeof text !== 'string' || text === '') return text
  if (depth > 12) return text
  return text.replace(PLACEHOLDER, (_, expression) => {
    const separator = expression.indexOf(':')
    const name = separator >= 0 ? expression.slice(0, separator) : expression
    const fallback = separator >= 0 ? expression.slice(separator + 1) : ''
    const found = variables.get(name.trim())
    if (found === undefined || found === null) return resolveTemplate(fallback, variables, depth + 1)
    return resolveTemplate(String(found), variables, depth + 1)
  })
}

/** Collect every `${...}` name a value mentions. */
export function placeholdersOf(text) {
  const names = []
  if (typeof text !== 'string') return names
  for (const match of text.matchAll(PLACEHOLDER)) names.push(match[1].split(':')[0].trim())
  return names
}
