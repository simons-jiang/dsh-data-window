/**
 * The result grid.
 *
 * Rows arrive as arrays of already-normalized cells, so the grid only decides how a
 * value looks: `NULL` is the one value a SQL client must render differently from the
 * text `null`, and a cell wider than the column is clipped with the full value in
 * its tooltip.
 *
 * The grid itself is a memo component keyed on the result rows: typing in the
 * editor patches the store on every keystroke, and rebuilding a few thousand cells
 * for a keystroke that cannot change them is the difference between a usable
 * console and a laggy one.
 */

/** MySQL protocol type codes that carry a number, for right alignment. */
const DW_NUMERIC_TYPES = new Set([0, 1, 2, 3, 4, 5, 8, 9, 13, 246])

/** MySQL column-type codes the driver reports as numbers. */
const DW_COLUMN_TYPES = {
  0: 'DECIMAL', 1: 'TINYINT', 2: 'SMALLINT', 3: 'INT', 4: 'FLOAT', 5: 'DOUBLE', 6: 'NULL', 7: 'TIMESTAMP',
  8: 'BIGINT', 9: 'MEDIUMINT', 10: 'DATE', 11: 'TIME', 12: 'DATETIME', 13: 'YEAR', 15: 'VARCHAR',
  16: 'BIT', 245: 'JSON', 246: 'DECIMAL', 247: 'ENUM', 248: 'SET', 249: 'TINYBLOB', 250: 'MEDIUMBLOB',
  251: 'LONGBLOB', 252: 'BLOB', 253: 'VAR_STRING', 254: 'CHAR', 255: 'GEOMETRY',
}

function dwColumnTypeName(type, charset) {
  const code = Number(type)
  if (!Number.isFinite(code)) return String(type)
  // 249-252 covers TINY/MEDIUM/LONG/BLOB; a non-binary character set means TEXT.
  if (code >= 249 && code <= 252 && Number(charset) !== 63) {
    return { 249: 'TINYTEXT', 250: 'MEDIUMTEXT', 251: 'LONGTEXT', 252: 'TEXT' }[code]
  }
  return DW_COLUMN_TYPES[code] ?? String(type)
}

function dwIsNumericColumn(column) {
  const code = Number(column?.type)
  return Number.isFinite(code) && DW_NUMERIC_TYPES.has(code)
}

/** Render one cell. */
function dwCell(value) {
  if (value === null || value === undefined) {
    return h('span', { className: 'dw-cell-null' }, 'NULL')
  }
  if (typeof value === 'string') {
    if (value === '') return h('span', { style: { opacity: .45 } }, "''")
    return value
  }
  if (typeof value === 'boolean') return value ? '1' : '0'
  if (Array.isArray(value)) return value.map((item) => (item === null ? 'NULL' : String(item))).join(', ')
  return String(value)
}

/** One clipboard cell: tabs and newlines would break the TSV grid. */
function dwTsvCell(value) {
  if (value === null || value === undefined) return 'NULL'
  return String(value).replace(/[\t\r\n]+/g, ' ')
}

/** The grid, memoized on the rows it is given. */
const DwGrid = React.memo(function DwGrid({ columns, rows, tr }) {
  const head = h('thead', { key: 'head' }, h('tr', { key: 'row' }, [
    h('th', { key: '#', className: 'dw-rownum' }, '#'),
    ...columns.map((column, index) => h('th', { key: `${column.name}-${index}`, title: `${column.name}${column.type !== '' ? ` · ${dwColumnTypeName(column.type, column.charset)}` : ''}` }, [
      h('span', { key: 'n' }, column.name),
      column.type !== '' ? h('span', { key: 't', className: 'dw-th-type' }, dwColumnTypeName(column.type, column.charset)) : null,
    ])),
  ]))
  const body = h('tbody', { key: 'body' }, rows.map((row, rowIndex) => h('tr', { key: rowIndex }, [
    h('td', { key: '#', className: 'dw-rownum' }, String(rowIndex + 1)),
    ...row.map((cell, cellIndex) => h('td', {
      key: cellIndex,
      style: dwIsNumericColumn(columns[cellIndex]) ? { textAlign: 'right', fontVariantNumeric: 'tabular-nums' } : undefined,
      title: cell === null ? 'NULL' : String(cell).slice(0, 400),
    }, dwCell(cell))),
  ])))
  void tr
  return h('div', { className: 'dw-result-body' }, h('table', { className: 'dw-grid' }, [head, body]))
})

function DwResults({ store, state, tab, tr }) {
  const result = tab.result
  const running = tab.running === true

  const bar = h('div', { key: 'bar', className: 'dw-result-bar' }, [
    result === undefined
      ? h('span', { key: 'idle' }, tr('resultIdle'))
      : h('span', { key: 'meta' }, [
        h('b', { key: 'r', style: { color: 'var(--dsw-alias-state-success-primary)' } }, `${result.rowCount} ${tr('rows')}`),
        h('span', { key: 'd' }, `  ·  ${dwDuration(result.elapsedMs)}`),
        result.truncated === true ? h('span', { key: 't', className: 'dw-log-warn' }, `  ·  ${tr('truncated')} ${result.limit}`) : null,
      ]),
    h('span', { key: 'sp', className: 'dw-spacer' }),
    result !== undefined && (result.rows ?? []).length > 0
      ? h('button', {
        key: 'copy',
        type: 'button',
        className: 'dw-btn',
        title: tr('copyResult'),
        onClick: () => {
          const header = result.columns.map((column) => column.name).join('\t')
          const bodyText = result.rows.map((row) => row.map(dwTsvCell).join('\t')).join('\n')
          const write = globalThis.navigator?.clipboard?.writeText?.(`${header}\n${bodyText}`)
          if (write !== undefined) {
            write.then(() => store.pushLog('info', tr('log.copiedRows', { rows: result.rowCount }))).catch(() => undefined)
          }
        },
      }, [h(DwIcon, { key: 'i', name: 'copy', size: 11 }), h('span', { key: 't' }, tr('copy'))])
      : null,
    h('label', { key: 'limit', style: { display: 'flex', alignItems: 'center', gap: 4 } }, [
      h('span', { key: 'l' }, tr('limit')),
      h('select', {
        key: 's',
        className: 'dw-select',
        value: String(state.limit),
        onChange: (event) => store.setLimit(Number(event.target.value)),
        style: { height: 22, fontSize: 11 },
      }, [50, 100, 200, 500, 1000, 2000].map((option) => h('option', { key: option, value: String(option) }, String(option)))),
    ]),
  ])

  let body = null
  if (tab.error !== '' && tab.error !== undefined) {
    body = h('div', { key: 'body', className: 'dw-result-body', style: { padding: '10px 12px' } }, [
      h('div', { key: 't', className: 'dw-empty-title', style: { color: 'var(--dsw-alias-state-error-primary)', fontSize: 12 } }, tr('queryFailed')),
      h('div', { key: 'm', className: 'dw-error-text' }, tab.error),
    ])
  } else if (running === true) {
    body = h('div', { key: 'body', className: 'dw-empty' }, [
      h(DwIcon, { key: 'i', name: 'spinner', size: 18 }),
      h('div', { key: 't', className: 'dw-empty-hint' }, tr('running')),
    ])
  } else if (result === undefined) {
    body = h('div', { key: 'body', className: 'dw-empty' }, [
      h('div', { key: 't', className: 'dw-empty-hint' }, tr('resultHint')),
    ])
  } else if ((result.rows ?? []).length === 0) {
    body = h('div', { key: 'body', className: 'dw-empty' }, [
      h('div', { key: 't', className: 'dw-empty-hint' }, tr('noRows')),
      h('div', { key: 'q', className: 'dw-code-block' }, result.sql ?? ''),
    ])
  } else {
    body = h(DwGrid, { key: 'grid', columns: result.columns, rows: result.rows, tr })
  }

  return h('div', { className: 'dw-result' }, [bar, body])
}

export { DwResults, DwGrid, dwCell, dwColumnTypeName, dwIsNumericColumn, dwTsvCell }
