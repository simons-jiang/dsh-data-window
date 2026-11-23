/**
 * Workbench tabs, the SQL editor and the DDL document.
 *
 * One tab per database is what requirement 4 asks for, so the tab id is the
 * database target id: asking for the same database twice focuses the console that
 * already exists instead of opening a second one. A tab that needs a second
 * statement gets its own id from the store, never a rewrite of the first.
 */

function DwTabs({ store, state, tr }) {
  if ((state.tabs ?? []).length === 0) return null
  return h('div', { className: 'dw-tabs', role: 'tablist' }, state.tabs.map((tab) => {
    const active = tab.id === state.activeTab
    return h('div', {
      key: tab.id,
      role: 'tab',
      'aria-selected': active,
      className: `dw-tab${active ? ' dw-tab-active' : ''}`,
      title: tab.subtitle ?? tab.title,
      onClick: () => store.setActiveTab(tab.id),
      onAuxClick: (event) => {
        if (event.button === 1) {
          event.preventDefault()
          store.closeTab(tab.id)
        }
      },
    }, [
      h(DwIcon, { key: 'ic', name: tab.kind === 'ddl' ? 'ddl' : 'database', size: 12 }),
      h('span', { key: 'lb', className: 'dw-tab-label' }, tab.title),
      // Several environments can hold a schema of the same name, so the tab says
      // which one it is; the full text stays in the tooltip.
      tab.env !== '' ? h('span', { key: 'env', className: 'dw-badge', style: { marginLeft: 2 } }, tab.env) : null,
      h('button', {
        key: 'cl',
        type: 'button',
        className: 'dw-tab-close',
        title: tr('closeTab'),
        'aria-label': tr('closeTab'),
        onClick: (event) => {
          event.stopPropagation()
          store.closeTab(tab.id)
        },
      }, h(DwIcon, { name: 'close', size: 10 })),
    ])
  }))
}

/** A draggable horizontal divider that resizes the editor. */
function DwDragHandle({ value, onChange, min, max }) {
  return h('div', {
    className: 'dw-drag',
    role: 'separator',
    'aria-orientation': 'horizontal',
    title: '↕',
    onPointerDown: (event) => {
      event.preventDefault()
      const startY = event.clientY
      const startValue = value
      const onMove = (moveEvent) => {
        const next = Math.min(max, Math.max(min, startValue + (moveEvent.clientY - startY)))
        onChange(next)
      }
      const onUp = () => {
        globalThis.removeEventListener('pointermove', onMove)
        globalThis.removeEventListener('pointerup', onUp)
      }
      globalThis.addEventListener('pointermove', onMove)
      globalThis.addEventListener('pointerup', onUp)
    },
  })
}

/** The SQL textarea with a line-number gutter that follows its scroll. */
function DwEditor({ store, tab, tr, onRun, height }) {
  const value = tab.sql ?? ''
  const lines = useMemo(() => value.split('\n').length, [value])
  const gutterRef = useRef(null)
  const areaRef = useRef(null)

  useEffect(() => {
    const area = areaRef.current
    if (area === null) return
    // Focusing on tab activation is the behaviour of every SQL console: the caret
    // lands where the user is about to type.
    area.focus()
    area.setSelectionRange(area.value.length, area.value.length)
  }, [tab.id])

  const gutter = []
  for (let index = 1; index <= Math.max(lines, 1); index += 1) gutter.push(`${index}\n`)

  return h('div', { className: 'dw-editor-wrap', style: { height } }, [
    h('div', { key: 'bar', className: 'dw-editor-bar' }, [
      h('span', { key: 'db', style: { color: 'var(--dsw-alias-label-primary)', fontWeight: 600 } }, tab.database),
      h('span', { key: 'env' }, tab.subtitle ?? ''),
      h('span', { key: 'sp', className: 'dw-spacer' }),
      h('span', { key: 'hint', style: { fontSize: 11 } }, tr('runHint')),
      h('button', {
        key: 'run',
        type: 'button',
        className: 'dw-btn dw-btn-accent',
        disabled: tab.running === true,
        title: tr('runHint'),
        onClick: onRun,
      }, [
        h(DwIcon, { key: 'i', name: tab.running === true ? 'spinner' : 'play', size: 11 }),
        h('span', { key: 't' }, tab.running === true ? tr('running') : tr('run')),
      ]),
    ]),
    h('div', { key: 'editor', className: 'dw-editor' }, [
      h('div', {
        key: 'gutter',
        className: 'dw-gutter',
        ref: gutterRef,
        'aria-hidden': true,
      }, gutter.join('')),
      h('textarea', {
        key: 'area',
        ref: areaRef,
        className: 'dw-code',
        value,
        spellCheck: false,
        placeholder: tr('sqlPlaceholder'),
        onChange: (event) => store.setTabSql(tab.id, event.target.value),
        onScroll: (event) => {
          const gutterNode = gutterRef.current
          if (gutterNode !== null) {
            gutterNode.scrollTop = event.target.scrollTop
            gutterNode.scrollLeft = event.target.scrollLeft
          }
        },
        onKeyDown: (event) => {
          const modifier = event.metaKey || event.ctrlKey
          if (modifier && event.key === 'Enter') {
            event.preventDefault()
            onRun()
            return
          }
          if (event.key === 'Tab' && !event.shiftKey && !modifier) {
            event.preventDefault()
            const area = event.target
            const start = area.selectionStart
            const end = area.selectionEnd
            const next = `${value.slice(0, start)}  ${value.slice(end)}`
            store.setTabSql(tab.id, next)
            requestAnimationFrame(() => {
              area.setSelectionRange(start + 2, start + 2)
            })
          }
        },
      }),
    ]),
  ])
}

/** The DDL document: the create statement plus the column summary above it. */
function DwDdlView({ tab, tr, store }) {
  const bar = h('div', { key: 'bar', className: 'dw-result-bar' }, [
    h('span', { key: 'n' }, [tab.env, tab.database, tab.table].filter((part) => typeof part === 'string' && part !== '').join(' / ')),
    h('span', { key: 'c' }, `${tab.columns.length} ${tr('columns')}`),
    h('span', { key: 'sp', className: 'dw-spacer' }),
    h('button', {
      key: 'data',
      type: 'button',
      className: 'dw-btn',
      onClick: () => {
        store.seedStatement(
          { dbId: tab.dbId, database: tab.database, table: tab.table, env: tab.env, instanceLabel: tab.instanceLabel },
          `SELECT *\nFROM \`${tab.database}\`.\`${tab.table}\`\nLIMIT 100`,
        )
        void store.runActiveTab()
      },
    }, [h(DwIcon, { key: 'i', name: 'table', size: 11 }), h('span', { key: 't' }, tr('openData'))]),
    h('button', {
      key: 'copy',
      type: 'button',
      className: 'dw-btn',
      onClick: () => {
        globalThis.navigator?.clipboard?.writeText?.(tab.ddl).catch(() => undefined)
        store.pushLog('info', tr('log.copiedDdl', { table: tab.table }))
      },
    }, [h(DwIcon, { key: 'i', name: 'copy', size: 11 }), h('span', { key: 't' }, tr('copyDdl'))]),
    h('button', {
      key: 'refresh',
      type: 'button',
      className: 'dw-btn dw-btn-icon',
      title: tr('refreshDdl'),
      disabled: tab.loading === true,
      onClick: () => void store.refreshDdl(tab.id),
    }, h(DwIcon, { name: tab.loading === true ? 'spinner' : 'refresh', size: 12 })),
  ])

  if (tab.loading === true) {
    return h('div', { className: 'dw-ddl' }, [bar, h('div', { key: 'body', className: 'dw-empty' }, [
      h(DwIcon, { key: 'i', name: 'spinner', size: 18 }),
      h('div', { key: 't', className: 'dw-empty-hint' }, tr('ddlLoading')),
    ])])
  }
  if (tab.error !== '') {
    return h('div', { className: 'dw-ddl' }, [bar, h('div', { key: 'body', className: 'dw-empty' }, [
      h('div', { key: 't', className: 'dw-empty-title', style: { color: 'var(--dsw-alias-state-error-primary)' } }, tr('ddlFailed')),
      h('div', { key: 'm', className: 'dw-error-text' }, tab.error),
    ])])
  }
  return h('div', { className: 'dw-ddl' }, [
    bar,
    h('pre', { key: 'body', className: 'dw-ddl-body' }, h('code', null, tab.ddl === '' ? tr('ddlEmpty') : tab.ddl)),
  ])
}

export { DwTabs, DwEditor, DwDdlView, DwDragHandle }
