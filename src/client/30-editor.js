/**
 * Workbench tabs, the SQL editor and the DDL document.
 *
 * One tab per database is what requirement 4 asks for, so the tab id is the
 * database target id: asking for the same database twice focuses the console that
 * already exists instead of opening a second one. A tab that needs a second
 * statement gets its own id from the store, never a rewrite of the first.
 */

/** The reference a tab copies: `schema.table`, or the schema alone. */
function dwTabReference(tab) {
  const database = String(tab?.database ?? '').trim()
  // Table consoles keep the table in their id (`sql:<dbId>:tbl:<table>`).
  const id = String(tab?.id ?? '')
  const table = String(tab?.table ?? '').trim()
    || (id.includes(':tbl:') ? id.split(':tbl:').slice(1).join(':tbl:') : '')
  if (database !== '' && table !== '') return `${database}.${table}`
  if (database !== '') return database
  return String(tab?.title ?? '')
}

/** Insert text into the chat composer when it is open; false when it is not. */
function dwInsertComposerText(text) {
  const doc = globalThis.document
  if (doc === undefined || typeof doc.querySelector !== 'function') return false
  const seat = doc.querySelector('[data-composer-seat]')
  if (seat === null) return false
  const editor = seat.querySelector('[contenteditable="true"], textarea')
  if (editor === null) return false
  try {
    editor.focus()
    if (editor.tagName === 'TEXTAREA') {
      const setter = Object.getOwnPropertyDescriptor(globalThis.HTMLTextAreaElement.prototype, 'value')?.set
      const start = editor.selectionStart ?? editor.value.length
      const end = editor.selectionEnd ?? start
      if (typeof setter === 'function') setter.call(editor, `${editor.value.slice(0, start)}${text}${editor.value.slice(end)}`)
      editor.setSelectionRange(start + text.length, start + text.length)
      editor.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    }
    const before = editor.textContent
    const selection = typeof globalThis.getSelection === 'function' ? globalThis.getSelection() : null
    if (selection === null || selection === undefined) return false
    const range = doc.createRange()
    range.selectNodeContents(editor)
    range.collapse(false)
    selection.removeAllRanges()
    selection.addRange(range)
    doc.execCommand('insertText', false, text)
    return editor.textContent !== before
  } catch (error) {
    void error
    return false
  }
}

function DwTabs({ store, state, tr }) {
  const [menu, setMenu] = useState(null)
  if ((state.tabs ?? []).length === 0) return null

  const copyReference = (tab) => {
    const reference = dwTabReference(tab)
    const write = globalThis.navigator?.clipboard?.writeText?.(reference)
    if (write === undefined) {
      store.pushLog('warn', tr('copyUpdateFailed'))
      return
    }
    write
      .then(() => store.pushLog('info', tr('log.copiedReference', { reference })))
      .catch(() => store.pushLog('warn', tr('copyUpdateFailed')))
  }

  const copyReferenceToChat = (tab) => {
    const reference = dwTabReference(tab)
    const inserted = dwInsertComposerText(`${reference} `)
    const write = globalThis.navigator?.clipboard?.writeText?.(reference)
    if (write !== undefined) write.catch(() => undefined)
    store.pushLog('info', tr(inserted ? 'log.copiedReferenceToChat' : 'log.copiedReferenceOnly', { reference }))
  }

  const menuItem = (key, icon, label, disabled, run) => h('button', {
    key,
    type: 'button',
    role: 'menuitem',
    className: 'dw-tabmenu-item',
    disabled,
    onClick: () => {
      setMenu(null)
      run()
    },
  }, [
    h('span', { key: 'ic', className: 'dw-tabmenu-icon' }, h(DwIcon, { name: icon, size: 13 })),
    h('span', { key: 'lb', className: 'dw-tabmenu-label' }, label),
  ])

  const index = menu === null ? -1 : (state.tabs ?? []).findIndex((tab) => tab.id === menu.tab.id)
  const menuLayer = menu === null ? null : h('div', {
    key: 'backdrop',
    className: 'dw-tabmenu-backdrop',
    onPointerDown: () => setMenu(null),
    onContextMenu: (event) => {
      event.preventDefault()
      setMenu(null)
    },
  }, h('div', {
    key: 'menu',
    className: 'dw-tabmenu',
    role: 'menu',
    'aria-label': tr('tabMenuLabel'),
    style: { left: menu.x, top: menu.y },
    onPointerDown: (event) => event.stopPropagation(),
  }, [
    menuItem('close', 'close', tr('tabClose'), false, () => store.closeTab(menu.tab.id)),
    menuItem('close-others', 'layers', tr('tabCloseOthers'), (state.tabs ?? []).length <= 1, () => store.closeOtherTabs(menu.tab.id)),
    menuItem('close-all', 'stack', tr('tabCloseAll'), false, () => store.closeAllTabs()),
    menuItem('close-left', 'arrow-left', tr('tabCloseLeft'), index <= 0, () => store.closeTabsToLeft(menu.tab.id)),
    menuItem('close-right', 'arrow-right', tr('tabCloseRight'), index < 0 || index >= (state.tabs ?? []).length - 1, () => store.closeTabsToRight(menu.tab.id)),
    h('div', { key: 'sep', className: 'dw-tabmenu-sep' }),
    menuItem('copy-reference', 'copy', tr('copyReference'), false, () => copyReference(menu.tab)),
    menuItem('copy-reference-chat', 'at', tr('copyReferenceToChat'), false, () => copyReferenceToChat(menu.tab)),
  ]))

  return h(React.Fragment, null, [
    h('div', { key: 'tabs', className: 'dw-tabs', role: 'tablist' }, state.tabs.map((tab) => {
      const active = tab.id === state.activeTab
      return h('div', {
        key: tab.id,
        role: 'tab',
        'aria-selected': active,
        className: `dw-tab${active ? ' dw-tab-active' : ''}`,
        title: tab.subtitle ?? tab.title,
        onClick: () => store.setActiveTab(tab.id),
        onContextMenu: (event) => {
          event.preventDefault()
          // Keep the menu inside the panel, like the code workspace's menu does.
          const rect = typeof document === 'undefined' ? null : document.querySelector('.dw-root')?.getBoundingClientRect()
          const left = rect === null || rect === undefined ? 8 : Math.max(8, rect.left + 8)
          const top = rect === null || rect === undefined ? 8 : Math.max(8, rect.top + 8)
          const right = (rect === null || rect === undefined ? (globalThis.innerWidth ?? 1200) : rect.right) - 248
          const bottom = (rect === null || rect === undefined ? (globalThis.innerHeight ?? 800) : rect.bottom) - 238
          setMenu({
            x: Math.max(left, Math.min(event.clientX, Math.max(left, right))),
            y: Math.max(top, Math.min(event.clientY, Math.max(top, bottom))),
            tab,
          })
        },
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
    })),
    menuLayer,
  ])
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

/** Caret position inside the textarea, measured with an in-place mirror. */
function dwCaretPoint(area, text, caret) {
  const wrap = area?.parentElement
  if (area === null || area === undefined || wrap === null || wrap === undefined) return { left: 0, top: 0 }
  const style = globalThis.getComputedStyle(area)
  const mirror = document.createElement('div')
  mirror.style.position = 'absolute'
  mirror.style.visibility = 'hidden'
  mirror.style.pointerEvents = 'none'
  mirror.style.top = '0'
  mirror.style.left = '0'
  mirror.style.width = `${area.offsetWidth}px`
  mirror.style.padding = style.padding
  mirror.style.border = style.border
  mirror.style.fontFamily = style.fontFamily
  mirror.style.fontSize = style.fontSize
  mirror.style.fontWeight = style.fontWeight
  mirror.style.letterSpacing = style.letterSpacing
  mirror.style.lineHeight = style.lineHeight
  mirror.style.tabSize = style.tabSize
  mirror.style.whiteSpace = 'pre'
  mirror.style.overflow = 'hidden'
  mirror.textContent = text.slice(0, caret)
  const marker = document.createElement('span')
  marker.textContent = '|'
  mirror.append(marker)
  wrap.append(mirror)
  const left = marker.offsetLeft - area.scrollLeft
  const top = marker.offsetTop - area.scrollTop
  mirror.remove()
  return { left, top }
}

/** The SQL editor: highlighted text, completion and one-keystroke formatting. */
function DwEditor({ store, tab, tr, onRun, height, schema }) {
  const value = tab.sql ?? ''
  const tokens = useMemo(() => dwSqlLex(value), [value])
  const lines = useMemo(() => value.split('\n').length, [value])
  const gutterRef = useRef(null)
  const areaRef = useRef(null)
  const highlightRef = useRef(null)
  const completionRef = useRef(null)
  const [completion, setCompletion] = useState(null)
  const [editorMenu, setEditorMenu] = useState(null)
  const [optimize, setOptimize] = useState(null)

  useEffect(() => {
    const area = areaRef.current
    if (area === null) return
    // Focusing on tab activation is the behaviour of every SQL console: the caret
    // lands where the user is about to type.
    area.focus()
    area.setSelectionRange(area.value.length, area.value.length)
  }, [tab.id])

  // The completion list needs the schema of this database; one round trip, cached
  // by the store. A failure only degrades the list to keywords.
  useEffect(() => {
    void store.loadSchema(tab.dbId)
  }, [tab.dbId, store])

  const syncScroll = (area) => {
    const gutter = gutterRef.current
    if (gutter !== null) {
      gutter.scrollTop = area.scrollTop
      gutter.scrollLeft = area.scrollLeft
    }
    const highlight = highlightRef.current
    if (highlight !== null) {
      highlight.scrollTop = area.scrollTop
      highlight.scrollLeft = area.scrollLeft
    }
  }

  const refreshCompletion = (text, caret) => {
    const area = areaRef.current
    if (area === null) return
    const result = dwSqlCompletion(text, caret, schema)
    const afterDot = /[A-Za-z0-9_$`]\.$/.test(text.slice(0, caret))
    if (result.items.length === 0 || (result.prefix === '' && !afterDot)) {
      setCompletion(null)
      return
    }
    const point = dwCaretPoint(area, text, caret)
    setCompletion({ ...result, index: 0, left: point.left, top: point.top + 20 })
  }

  // The schema map starts loading when the tab opens; a fast typist can type a whole
  // word before it lands, which used to leave the list closed until the next key.
  // Re-evaluate the caret once the map arrives so the popup appears on its own.
  useEffect(() => {
    if (schema === undefined) return
    const area = areaRef.current
    if (area === null || document.activeElement !== area) return
    refreshCompletion(value, area.selectionStart)
  }, [schema])

  // Arrow keys move the highlight through a list that can be taller than its box;
  // scroll just the popup so the selected row never disappears below the fold.
  useEffect(() => {
    const popup = completionRef.current
    if (popup === null || completion === null) return
    const active = popup.querySelector('.dw-complete-row.active')
    if (active === null) return
    const top = active.offsetTop
    const bottom = top + active.offsetHeight
    if (top < popup.scrollTop) popup.scrollTop = top
    else if (bottom > popup.scrollTop + popup.clientHeight) popup.scrollTop = bottom - popup.clientHeight
  }, [completion])

  const applyCompletion = (item) => {
    const current = completion
    if (current === null || item === undefined) return
    const next = `${value.slice(0, current.from)}${item.label}${value.slice(current.to)}`
    const position = current.from + item.label.length
    store.setTabSql(tab.id, next)
    setCompletion(null)
    requestAnimationFrame(() => {
      const area = areaRef.current
      if (area === null) return
      area.focus()
      area.setSelectionRange(position, position)
    })
  }

  const runStatement = () => {
    const area = areaRef.current
    const selected = area !== null && area.selectionEnd > area.selectionStart
      ? value.slice(area.selectionStart, area.selectionEnd)
      : ''
    onRun(selected.trim() === '' ? undefined : selected)
  }

  // The right-click menu replaces the browser's own so it can offer the same
  // editing commands plus the model. Clipboard writes/reads go through the async
  // API; undo/redo keep using the textarea's native history.
  const editorMenuAction = (run) => () => {
    setEditorMenu(null)
    run()
  }

  const editorCommand = (command) => {
    const area = areaRef.current
    if (area === null) return
    area.focus()
    try {
      document.execCommand(command)
    } catch (error) {
      void error
    }
  }

  const editorCopy = () => {
    const area = areaRef.current
    if (area === null) return
    const selected = area.selectionEnd > area.selectionStart ? value.slice(area.selectionStart, area.selectionEnd) : value
    const write = globalThis.navigator?.clipboard?.writeText?.(selected)
    if (write !== undefined) write.catch(() => undefined)
  }

  const editorCut = () => {
    const area = areaRef.current
    if (area === null) return
    const start = area.selectionStart
    const end = area.selectionEnd
    if (end <= start) return
    editorCopy()
    store.setTabSql(tab.id, `${value.slice(0, start)}${value.slice(end)}`)
    requestAnimationFrame(() => {
      const next = areaRef.current
      if (next === null) return
      next.focus()
      next.setSelectionRange(start, start)
    })
  }

  const editorPaste = async () => {
    const area = areaRef.current
    if (area === null) return
    const read = globalThis.navigator?.clipboard?.readText
    if (typeof read !== 'function') {
      store.pushLog('warn', tr('editorPasteBlocked'))
      return
    }
    try {
      const text = await read.call(globalThis.navigator.clipboard)
      if (typeof text !== 'string' || text === '') return
      const start = area.selectionStart
      const end = area.selectionEnd
      store.setTabSql(tab.id, `${value.slice(0, start)}${text}${value.slice(end)}`)
      requestAnimationFrame(() => {
        const next = areaRef.current
        if (next === null) return
        next.focus()
        next.setSelectionRange(start + text.length, start + text.length)
      })
    } catch (error) {
      void error
      store.pushLog('warn', tr('editorPasteBlocked'))
    }
  }

  const editorSelectAll = () => {
    const area = areaRef.current
    if (area === null) return
    area.focus()
    area.select()
  }

  const openOptimize = () => {
    const area = areaRef.current
    const selected = area !== null && area.selectionEnd > area.selectionStart
      ? value.slice(area.selectionStart, area.selectionEnd)
      : ''
    const text = selected.trim() === '' ? value.trim() : selected.trim()
    if (text === '') {
      store.pushLog('warn', tr('log.noStatement'))
      return
    }
    setOptimize({ sql: text, database: tab.database })
  }

  const menuItem = (key, label, shortcut, run) => h('button', {
    key,
    type: 'button',
    className: 'dw-menu-item',
    onClick: editorMenuAction(run),
  }, [
    h('span', { key: 'l' }, label),
    shortcut === '' ? null : h('span', { key: 's', className: 'dw-menu-shortcut' }, shortcut),
  ])

  const format = () => {
    const formatted = dwFormatSql(value)
    if (formatted === value) return
    store.setTabSql(tab.id, formatted)
    requestAnimationFrame(() => areaRef.current?.focus())
  }

  const gutter = []
  for (let index = 1; index <= Math.max(lines, 1); index += 1) gutter.push(`${index}\n`)

  const bar = h('div', { key: 'bar', className: 'dw-editor-bar' }, [
    h('span', { key: 'db', style: { color: 'var(--dsw-alias-label-primary)', fontWeight: 600 } }, tab.database),
    h('span', { key: 'env' }, tab.subtitle ?? ''),
    h('span', { key: 'sp', className: 'dw-spacer' }),
    h('button', {
      key: 'format',
      type: 'button',
      className: 'dw-btn',
      title: tr('formatSqlHint'),
      onClick: format,
    }, [h(DwIcon, { key: 'i', name: 'format', size: 11 }), h('span', { key: 't' }, tr('formatSql'))]),
    h('span', { key: 'hint', style: { fontSize: 11 } }, tr('runHint')),
    h('button', {
      key: 'run',
      type: 'button',
      className: 'dw-btn dw-btn-accent',
      disabled: tab.running === true,
      title: tr('runHint'),
      onClick: runStatement,
    }, [
      h(DwIcon, { key: 'i', name: tab.running === true ? 'spinner' : 'play', size: 11 }),
      h('span', { key: 't' }, tab.running === true ? tr('running') : tr('run')),
    ]),
  ])

  const editorMenuLayer = editorMenu === null ? null : h(React.Fragment, null, [
    h('div', {
      key: 'backdrop',
      className: 'dw-backdrop',
      onClick: () => setEditorMenu(null),
      onContextMenu: (event) => {
        event.preventDefault()
        setEditorMenu(null)
      },
    }),
    h('div', { key: 'menu', className: 'dw-menu', style: { left: editorMenu.x, top: editorMenu.y } }, [
      menuItem('undo', tr('editorUndo'), '⌘Z', () => editorCommand('undo')),
      menuItem('redo', tr('editorRedo'), '⇧⌘Z', () => editorCommand('redo')),
      h('div', { key: 'sep1', className: 'dw-project-sep' }),
      menuItem('cut', tr('editorCut'), '⌘X', editorCut),
      menuItem('copy', tr('editorCopy'), '⌘C', editorCopy),
      menuItem('paste', tr('editorPaste'), '⌘V', () => void editorPaste()),
      menuItem('select-all', tr('editorSelectAll'), '⌘A', editorSelectAll),
      h('div', { key: 'sep2', className: 'dw-project-sep' }),
      menuItem('optimize', tr('sqlOptimize'), '', openOptimize),
    ]),
  ])

  return h('div', { className: 'dw-editor-wrap', style: { height } }, [
    bar,
    h('div', { key: 'editor', className: 'dw-editor' }, [
      h('div', {
        key: 'gutter',
        className: 'dw-gutter',
        ref: gutterRef,
        'aria-hidden': true,
      }, gutter.join('')),
      h('div', { key: 'wrap', className: 'dw-code-wrap' }, [
        h('pre', { key: 'hl', className: 'dw-code-highlight', ref: highlightRef, 'aria-hidden': true },
          tokens.map((token, index) => (token.type === 'space'
            ? token.value
            : h('span', { key: index, className: `dw-tok-${token.type}` }, token.value)))),
        h('textarea', {
          key: 'area',
          ref: areaRef,
          className: 'dw-code',
          value,
          spellCheck: false,
          placeholder: tr('sqlPlaceholder'),
          onChange: (event) => {
            const text = event.target.value
            const caret = event.target.selectionStart
            store.setTabSql(tab.id, text)
            refreshCompletion(text, caret)
          },
          onClick: (event) => refreshCompletion(event.target.value, event.target.selectionStart),
          onContextMenu: (event) => {
            event.preventDefault()
            const width = 210
            const height = 268
            const maxX = (globalThis.innerWidth ?? 1200) - width
            const maxY = (globalThis.innerHeight ?? 800) - height
            setEditorMenu({
              x: Math.max(8, Math.min(event.clientX, maxX)),
              y: Math.max(8, Math.min(event.clientY, maxY)),
            })
          },
          onBlur: () => setCompletion(null),
          onScroll: (event) => syncScroll(event.target),
          onKeyDown: (event) => {
            const modifier = event.metaKey || event.ctrlKey
            if (completion !== null) {
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault()
                const size = completion.items.length
                const delta = event.key === 'ArrowDown' ? 1 : -1
                setCompletion({ ...completion, index: (completion.index + delta + size) % size })
                return
              }
              if ((event.key === 'Enter' && !modifier) || event.key === 'Tab') {
                event.preventDefault()
                applyCompletion(completion.items[completion.index])
                return
              }
              if (event.key === 'Escape') {
                event.preventDefault()
                setCompletion(null)
                return
              }
            }
            if (modifier && event.key === 'Enter') {
              event.preventDefault()
              runStatement()
              return
            }
            if (modifier && event.key === ' ') {
              event.preventDefault()
              refreshCompletion(value, event.target.selectionStart)
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
        completion === null
          ? null
          : h('div', {
            key: 'ac',
            ref: completionRef,
            className: 'dw-complete',
            style: { left: completion.left, top: completion.top },
            role: 'listbox',
          }, completion.items.map((item, index) => h('div', {
            key: `${item.kind}:${item.label}`,
            role: 'option',
            'aria-selected': index === completion.index,
            className: index === completion.index ? 'dw-complete-row active' : 'dw-complete-row',
            onMouseDown: (event) => event.preventDefault(),
            onClick: () => applyCompletion(item),
          }, [
            h('span', { key: 'l', className: 'dw-complete-label' }, item.label),
            h('span', { key: 'd', className: 'dw-complete-detail' }, item.detail ?? ''),
            h('span', { key: 'k', className: 'dw-complete-kind' }, item.kind === 'column' ? tr('suggestColumn') : item.kind === 'table' ? tr('suggestTable') : tr('suggestKeyword')),
          ]))),
      ]),
    ]),
    editorMenuLayer,
    optimize === null ? null : h(DwSqlOptimizeDialog, {
      key: 'optimize',
      store,
      tr,
      sql: optimize.sql,
      database: optimize.database,
      onClose: () => setOptimize(null),
    }),
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
