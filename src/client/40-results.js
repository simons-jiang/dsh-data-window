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


/** The grid, memoized on the rows it is given. */
const DwGrid = React.memo(function DwGrid({
  columns, rows, tr, edits, editing, selected, skipBlur, onSelect, onCellDoubleClick, onEditCommit, onEditCancel, onCellMenu,
}) {
  const head = h('thead', { key: 'head' }, h('tr', { key: 'row' }, [
    h('th', { key: '#', className: 'dw-rownum' }, '#'),
    ...columns.map((column, index) => h('th', { key: `${column.name}-${index}`, title: `${column.name}${column.type !== '' ? ` · ${dwColumnTypeName(column.type, column.charset)}` : ''}` }, [
      h('span', { key: 'n' }, column.name),
      column.type !== '' ? h('span', { key: 't', className: 'dw-th-type' }, dwColumnTypeName(column.type, column.charset)) : null,
    ])),
  ]))
  const body = h('tbody', { key: 'body' }, rows.map((row, rowIndex) => h('tr', { key: rowIndex }, [
    h('td', { key: '#', className: 'dw-rownum' }, String(rowIndex + 1)),
    ...row.map((cell, cellIndex) => {
      const column = columns[cellIndex] ?? { name: String(cellIndex) }
      const rowEdits = edits === undefined ? undefined : edits[rowIndex]
      const edited = rowEdits !== undefined && Object.prototype.hasOwnProperty.call(rowEdits, column.name)
      const value = edited ? rowEdits[column.name] : cell
      const isEditing = editing !== null && editing.row === rowIndex && editing.index === cellIndex
      const isSelected = selected !== null && selected.row === rowIndex && selected.index === cellIndex
      const props = {
        key: cellIndex,
        className: [edited ? 'dw-cell-edited' : '', isSelected ? 'dw-cell-selected' : ''].filter(Boolean).join(' ') || undefined,
        style: dwIsNumericColumn(column) ? { textAlign: 'right', fontVariantNumeric: 'tabular-nums' } : undefined,
        onClick: () => onSelect(rowIndex, cellIndex),
        onDoubleClick: () => onCellDoubleClick(rowIndex, cellIndex),
        onContextMenu: (event) => {
          event.preventDefault()
          onCellMenu(event, rowIndex, cellIndex)
        },
      }
      if (isEditing) {
        props.contentEditable = true
        props.suppressContentEditableWarning = true
        props['data-dw-edit'] = '1'
        props.title = tr('editingCellHint')
        props.onBlur = (event) => onEditCommit(rowIndex, cellIndex, column.name, event.currentTarget.textContent)
        props.onKeyDown = (event) => {
          // Committing an IME candidate with Enter must not blur the editor: the
          // cell is still being typed, and blur would write the pre-commit value.
          if (dwImeComposing(event)) return
          if (event.key === 'Enter') {
            event.preventDefault()
            event.currentTarget.blur()
            return
          }
          if (event.key !== 'Escape') return
          event.preventDefault()
          skipBlur.current = true
          event.currentTarget.blur()
        }
        return h('td', props, value === null || value === undefined ? 'NULL' : String(value))
      }
      props.title = value === null || value === undefined ? 'NULL' : String(value).slice(0, 400)
      return h('td', props, h('span', { key: 'v', className: 'dw-cell-text' }, dwCell(value)))
    }),
  ])))
  void tr
  return h('div', { className: 'dw-result-body' }, h('table', { className: 'dw-grid' }, [head, body]))
})

function DwResults({ store, state, tab, tr }) {
  const result = tab.result
  const running = tab.running === true
  const [editing, setEditing] = useState(null)
  const [cellMenu, setCellMenu] = useState(null)
  const [exportMenu, setExportMenu] = useState(null)
  const [selected, setSelected] = useState(null)
  const [detail, setDetail] = useState(null)
  const [notice, setNotice] = useState(null)
  const skipBlur = useRef(false)
  const edits = tab.edits ?? {}
  const editCount = Object.values(edits).reduce((total, row) => total + Object.keys(row).length, 0)
  // Export what is on screen, edits included — it is the view the user is acting on.
  const exportRows = (result?.rows ?? []).map((row, rowIndex) => {
    const rowEdits = edits[rowIndex]
    if (rowEdits === undefined) return row
    return row.map((cell, cellIndex) => {
      const name = (result.columns[cellIndex] ?? {}).name
      return Object.prototype.hasOwnProperty.call(rowEdits, name) ? rowEdits[name] : cell
    })
  })
  const exportNumeric = (result?.columns ?? []).map((column) => dwIsNumericColumn(column))

  // A new result (or a new page) invalidates both the edit cursor and the menu.
  useEffect(() => {
    setEditing(null)
    setCellMenu(null)
    setSelected(null)
    setDetail(null)
    setNotice(null)
  }, [tab.id, result, tab.page?.offset])

  // Focus the cell that just entered edit mode and select its text, so typing
  // replaces the value instead of appending to it.
  useEffect(() => {
    if (editing === null) return
    const doc = globalThis.document
    if (doc === undefined || typeof doc.querySelector !== 'function') return
    const node = doc.querySelector('[data-dw-edit="1"]')
    if (node === null || node === undefined) return
    node.focus()
    const selection = typeof globalThis.getSelection === 'function' ? globalThis.getSelection() : null
    if (selection === null || selection === undefined) return
    const range = doc.createRange()
    range.selectNodeContents(node)
    selection.removeAllRanges()
    selection.addRange(range)
  }, [editing])

  const columnIndexOf = (name) => (result?.columns ?? []).findIndex((column) => column.name === name)

  // Full value of one cell, edits included: what the detail dialog shows.
  const openDetail = (rowIndex, cellIndex) => {
    const column = (result?.columns ?? [])[cellIndex] ?? {}
    const rowEdits = edits[rowIndex] ?? {}
    const raw = Object.prototype.hasOwnProperty.call(rowEdits, column.name)
      ? rowEdits[column.name]
      : (result?.rows ?? [])[rowIndex]?.[cellIndex]
    setDetail({
      row: rowIndex,
      index: cellIndex,
      name: column.name ?? '',
      text: raw === null || raw === undefined ? 'NULL' : String(raw),
    })
  }

  // One UPDATE for one edited row: edited columns in SET, the original primary
  // key in WHERE. `reason` is what the UI shows when no statement can be built.
  const rowUpdate = (rowIndex) => {
    if (result === undefined) return { reason: tr('updateNeedsEdits') }
    const target = dwSqlTargetTable(tab.lastStatement ?? tab.sql ?? '')
    if (target === undefined) return { reason: tr('updateNeedsSingleTable') }
    const primaryKeys = (result.columns ?? []).filter((column) => dwIsPrimaryKey(column))
    if (primaryKeys.length === 0) return { reason: tr('updateNeedsPrimaryKey') }
    const rowEdits = edits[rowIndex] ?? {}
    const assignments = Object.keys(rowEdits).map((name) => ({
      column: name,
      value: rowEdits[name],
      numeric: dwIsNumericColumn((result.columns ?? [])[columnIndexOf(name)]),
    }))
    if (assignments.length === 0) return { reason: tr('updateNeedsEdits') }
    const source = (result.rows ?? [])[rowIndex] ?? []
    const conditions = primaryKeys.map((column) => ({
      column: column.name,
      value: source[columnIndexOf(column.name)],
      numeric: dwIsNumericColumn(column),
    }))
    return { sql: dwSqlUpdate(target, assignments, conditions), table: target.table, reason: '' }
  }

  const copyText = (text, onDone, onFail) => {
    const write = globalThis.navigator?.clipboard?.writeText?.(text)
    if (write === undefined) {
      store.pushLog('warn', tr('copyUpdateFailed'))
      return
    }
    write.then(onDone).catch(() => store.pushLog('warn', tr('copyUpdateFailed')))
  }

  const copyUpdate = () => {
    if (cellMenu === null) return
    const built = rowUpdate(cellMenu.row)
    if (built.reason !== '') {
      store.pushLog('warn', built.reason)
      setCellMenu(null)
      return
    }
    copyText(built.sql, () => store.pushLog('info', tr('log.copiedUpdate', { table: built.table })))
    setCellMenu(null)
  }

  // Every edited row at once: one statement per row, in result order.
  const copyAllUpdates = () => {
    const rows = Object.keys(edits).map(Number).sort((left, right) => left - right)
    if (rows.length === 0) return
    const statements = []
    for (const row of rows) {
      const built = rowUpdate(row)
      if (built.reason !== '') {
        store.pushLog('warn', built.reason)
        return
      }
      statements.push(built.sql)
    }
    copyText(statements.join('\n\n'), () => store.pushLog('info', tr('log.copiedUpdates', { count: statements.length })))
  }

  // Export the displayed rows: CSV, XLSX or an INSERT script. The save step asks
  // for a path through the File System Access API when the host supports it.
  const exportResult = (kind) => {
    setExportMenu(null)
    if (result === undefined) return
    const columns = result.columns ?? []
    const target = dwSqlTargetTable(tab.lastStatement ?? tab.sql ?? '')
    const now = new Date()
    const pad = (value) => String(value).padStart(2, '0')
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
    const base = `${target?.table ?? tab.database ?? 'result'}-${stamp}`
    let payload
    let name
    let mime
    let extension
    let description
    if (kind === 'sql') {
      if (target === undefined) {
        // Not a silent log line: the user asked for a file, so say why there is none.
        store.pushLog('warn', tr('insertNeedsTable'))
        setNotice({ title: tr('insertNeedsTitle'), message: tr('insertNeedsTable') })
        return
      }
      payload = dwInsertText(target, columns, exportRows, exportNumeric)
      name = `${base}.sql`
      mime = 'text/plain'
      extension = '.sql'
      description = tr('exportInsert')
    } else if (kind === 'csv') {
      payload = dwCsvText(columns, exportRows)
      name = `${base}.csv`
      mime = 'text/csv'
      extension = '.csv'
      description = tr('exportCsv')
    } else {
      payload = dwXlsxBytes(columns, exportRows, exportNumeric)
      name = `${base}.xlsx`
      mime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      extension = '.xlsx'
      description = tr('exportXlsx')
    }
    dwSaveFile({ name, data: payload, mime, extension, description })
      .then((outcome) => {
        if (outcome.cancelled === true) {
          store.pushLog('info', tr('log.exportCancelled'))
          return
        }
        store.pushLog('info', tr('log.exported', { name: outcome.name, rows: exportRows.length }))
        if (outcome.via === 'download') store.pushLog('warn', tr('log.exportDownloaded', { name: outcome.name }))
      })
      .catch((error) => store.pushLog('warn', tr('exportFailed', { message: error?.message ?? String(error) })))
  }

  const bar = h('div', { key: 'bar', className: 'dw-result-bar' }, [
    result === undefined
      ? h('span', { key: 'idle' }, tr('resultIdle'))
      : h('span', { key: 'meta' }, [
        h('b', { key: 'r', style: { color: 'var(--dsw-alias-state-success-primary)' } }, `${result.rowCount} ${tr('rows')}`),
        h('span', { key: 'd' }, `  ·  ${dwDuration(result.elapsedMs)}`),
        result.truncated === true ? h('span', { key: 't', className: 'dw-log-warn' }, `  ·  ${tr('truncated')} ${result.limit}`) : null,
      ]),
    editCount > 0
      ? h('span', { key: 'edits', className: 'dw-edit-badge' }, [
        h('span', { key: 'n' }, tr('editsCount', { count: editCount })),
        h('button', {
          key: 'copy',
          type: 'button',
          className: 'dw-edit-clear',
          title: tr('copyEditsHint'),
          onClick: copyAllUpdates,
        }, tr('copyEdits')),
        h('button', {
          key: 'c',
          type: 'button',
          className: 'dw-edit-clear',
          onClick: () => store.clearCellEdits(tab.id),
        }, tr('clearEdits')),
      ])
      : null,
    tab.page === undefined
      ? null
      : h('span', { key: 'pager', className: 'dw-pager' }, [
        h('button', {
          key: 'prev',
          type: 'button',
          className: 'dw-pager-btn',
          disabled: running || tab.page.offset <= 0,
          title: tr('pagePrev'),
          onClick: () => void store.prevPage(),
        }, `‹ ${tr('pagePrev')}`),
        h('span', { key: 'label', className: 'dw-pager-label' }, tr('pageLabel', {
          page: Math.floor(tab.page.offset / tab.page.size) + 1,
          size: tab.page.size,
        })),
        h('button', {
          key: 'next',
          type: 'button',
          className: 'dw-pager-btn',
          disabled: running || tab.page.hasMore !== true,
          title: tr('pageNext'),
          onClick: () => void store.nextPage(),
        }, `${tr('pageNext')} ›`),
      ]),
    result === undefined
      ? null
      : h('span', { key: 'count', className: 'dw-count' }, [
        h('button', {
          key: 'r',
          type: 'button',
          className: 'dw-count-btn',
          title: tab.countError !== undefined && tab.countError !== '' ? tab.countError : tr('countRowsHint'),
          'aria-label': tr('countRows'),
          disabled: tab.counting === true
            || tab.lastStatement === undefined
            || !/^(select|with)\b/i.test(String(tab.lastStatement ?? '').trim()),
          onClick: () => void store.refreshTotal(tab.id),
        }, h(DwIcon, { key: 'i', name: tab.counting === true ? 'spinner' : 'refresh', size: 11 })),
        h('span', {
          key: 'v',
          className: 'dw-count-value',
          style: tab.countError !== undefined && tab.countError !== '' ? { color: 'var(--dsw-alias-state-error-primary)' } : undefined,
        }, tab.counting === true
          ? tr('countRowsRunning')
          : tab.countError !== undefined && tab.countError !== ''
            ? tr('countRowsFailed')
            : tab.totalCount === undefined
              ? tr('countRowsUnknown')
              : tr('countRowsValue', { rows: Number(tab.totalCount).toLocaleString() })),
      ]),
    h('span', { key: 'sp', className: 'dw-spacer' }),
    result !== undefined && (result.rows ?? []).length > 0
      ? h('button', {
        key: 'export',
        type: 'button',
        className: 'dw-btn',
        title: tr('exportHint', { rows: exportRows.length }),
        onClick: (event) => {
          const rect = event.currentTarget.getBoundingClientRect()
          setExportMenu({ x: Math.max(8, rect.right - 200), y: rect.bottom + 4 })
        },
      }, [h(DwIcon, { key: 'i', name: 'download', size: 11 }), h('span', { key: 't' }, tr('export'))])
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
    body = h(DwGrid, {
      key: 'grid',
      columns: result.columns,
      rows: result.rows,
      tr,
      edits: tab.edits,
      editing,
      selected,
      skipBlur,
      onSelect: (row, index) => setSelected({ row, index }),
      onCellDoubleClick: (row, index) => openDetail(row, index),
      onEditCommit: (row, index, name, text) => {
        if (skipBlur.current) {
          skipBlur.current = false
          setEditing(null)
          return
        }
        store.setCellEdit(tab.id, row, index, name, text === 'NULL' ? null : text)
        setEditing(null)
      },
      onEditCancel: () => setEditing(null),
      onCellMenu: (event, row, index) => setCellMenu({ x: event.clientX, y: event.clientY, row, index }),
    })
  }

  const cellMenuLayer = cellMenu === null ? null : h(React.Fragment, null, [
    h('div', {
      key: 'backdrop',
      className: 'dw-backdrop',
      onClick: () => setCellMenu(null),
      onContextMenu: (event) => {
        event.preventDefault()
        setCellMenu(null)
      },
    }),
    h('div', { key: 'menu', className: 'dw-menu', style: { left: cellMenu.x, top: cellMenu.y } }, [
      h('button', {
        key: 'edit',
        type: 'button',
        className: 'dw-menu-item',
        onClick: () => {
          setSelected({ row: cellMenu.row, index: cellMenu.index })
          setEditing({ row: cellMenu.row, index: cellMenu.index })
          setCellMenu(null)
        },
      }, tr('editCell')),
      h('button', {
        key: 'update',
        type: 'button',
        className: 'dw-menu-item',
        disabled: rowUpdate(cellMenu.row).reason !== '',
        title: rowUpdate(cellMenu.row).reason === '' ? tr('menuCopyUpdateHint') : rowUpdate(cellMenu.row).reason,
        onClick: copyUpdate,
      }, tr('menuCopyUpdate')),
      h('button', {
        key: 'value',
        type: 'button',
        className: 'dw-menu-item',
        onClick: () => {
          const row = (result?.rows ?? [])[cellMenu.row] ?? []
          const edited = edits[cellMenu.row] ?? {}
          const name = (result?.columns ?? [])[cellMenu.index]?.name ?? ''
          const value = Object.prototype.hasOwnProperty.call(edited, name) ? edited[name] : row[cellMenu.index]
          const write = globalThis.navigator?.clipboard?.writeText?.(value === null || value === undefined ? 'NULL' : String(value))
          if (write !== undefined) write.then(() => store.pushLog('info', tr('log.copiedCell'))).catch(() => undefined)
          setCellMenu(null)
        },
      }, tr('menuCopyCell')),
    ]),
  ])

  const exportLayer = exportMenu === null ? null : h(React.Fragment, null, [
    h('div', {
      key: 'backdrop',
      className: 'dw-backdrop',
      onClick: () => setExportMenu(null),
      onContextMenu: (event) => {
        event.preventDefault()
        setExportMenu(null)
      },
    }),
    h('div', { key: 'menu', className: 'dw-menu', style: { left: exportMenu.x, top: exportMenu.y } }, [
      h('div', { key: 'note', className: 'dw-menu-note' }, tr('exportHint', { rows: exportRows.length })),
      h('button', { key: 'xlsx', type: 'button', className: 'dw-menu-item', onClick: () => exportResult('xlsx') }, tr('exportXlsx')),
      h('button', { key: 'csv', type: 'button', className: 'dw-menu-item', onClick: () => exportResult('csv') }, tr('exportCsv')),
      h('button', { key: 'sql', type: 'button', className: 'dw-menu-item', onClick: () => exportResult('sql') }, tr('exportInsert')),
    ]),
  ])

  const detailLayer = detail === null ? null : h('div', {
    key: 'detail',
    className: 'dw-modal',
    onClick: () => setDetail(null),
  }, h('div', {
    key: 'card',
    className: 'dw-modal-card dw-cell-dialog',
    onClick: (event) => event.stopPropagation(),
  }, [
    h('div', { key: 'title', className: 'dw-modal-title' }, tr('cellDetailTitle', { column: detail.name, row: detail.row + 1 })),
    h('div', { key: 'body', className: 'dw-modal-body' }, h('pre', { key: 'v', className: 'dw-cell-view' }, detail.text)),
    h('div', { key: 'foot', className: 'dw-modal-foot' }, [
      h('button', {
        key: 'copy',
        type: 'button',
        className: 'dw-btn',
        onClick: () => copyText(detail.text, () => store.pushLog('info', tr('log.copiedCell'))),
      }, tr('menuCopyCell')),
      h('button', {
        key: 'edit',
        type: 'button',
        className: 'dw-btn',
        onClick: () => {
          setSelected({ row: detail.row, index: detail.index })
          setEditing({ row: detail.row, index: detail.index })
          setDetail(null)
        },
      }, tr('editCell')),
      h('button', { key: 'close', type: 'button', className: 'dw-btn dw-btn-accent', onClick: () => setDetail(null) }, tr('close')),
    ]),
  ]))

  const noticeLayer = notice === null ? null : h('div', {
    key: 'notice',
    className: 'dw-modal',
    onClick: () => setNotice(null),
  }, h('div', {
    key: 'card',
    className: 'dw-modal-card',
    onClick: (event) => event.stopPropagation(),
  }, [
    h('div', { key: 'title', className: 'dw-modal-title' }, notice.title),
    h('div', { key: 'body', className: 'dw-modal-body' }, h('div', { key: 'm', className: 'dw-error-text' }, notice.message)),
    h('div', { key: 'foot', className: 'dw-modal-foot' }, [
      h('button', { key: 'close', type: 'button', className: 'dw-btn dw-btn-accent', onClick: () => setNotice(null) }, tr('close')),
    ]),
  ]))

  return h('div', { className: 'dw-result' }, [bar, body, cellMenuLayer, exportLayer, detailLayer, noticeLayer])
}

export { DwResults, DwGrid, dwCell, dwColumnTypeName, dwIsNumericColumn }
