/**
 * Saved SQL: the favorites tab's rows, the dialog that names one, and the `@`
 * index the workbench inserts from.
 *
 * One statement is saved with its name, its schema and its table. The favorites
 * tab groups by schema then table, which is the shape the user recognised the
 * statement in; the workbench only needs the name, because the caret is already in
 * a console. Both views read the same list, so a save from one is visible in the
 * other without a reload.
 */

/** A console's table, from its id (`sql:<dbId>:tbl:<table>`). */
function dwTabTableName(tab) {
  const id = String(tab?.id ?? '')
  const index = id.indexOf(':tbl:')
  return index < 0 ? '' : id.slice(index + 5)
}

/** Every schema name the tree knows, for the favorite dialog's datalist. */
function dwDatabaseNames(environments) {
  const names = new Set()
  for (const environment of Array.isArray(environments) ? environments : []) {
    for (const instance of Array.isArray(environment?.instances) ? environment.instances : []) {
      for (const database of Array.isArray(instance?.databases) ? instance.databases : []) {
        const name = String(database?.name ?? '')
        if (name !== '') names.add(name)
      }
    }
  }
  return [...names].sort((left, right) => left.localeCompare(right))
}

/**
 * The tree node a favorite's schema name points at.
 *
 * A favorite stores a name, not a database id, because the tree is shared and the
 * same schema may be reachable through another workspace later. The environment
 * the statement was saved under breaks ties when two environments hold a schema of
 * the same name.
 */
function dwFindDatabaseTarget(environments, database, env) {
  const name = String(database ?? '').trim().toLowerCase()
  if (name === '') return undefined
  const preferred = String(env ?? '').trim().toLowerCase()
  let fallback
  for (const environment of Array.isArray(environments) ? environments : []) {
    for (const instance of Array.isArray(environment?.instances) ? environment.instances : []) {
      for (const entry of Array.isArray(instance?.databases) ? instance.databases : []) {
        if (String(entry?.name ?? '').toLowerCase() !== name) continue
        if (typeof entry?.id !== 'string' || entry.id === '') continue
        const target = {
          env: environment.env,
          node: {
            key: dwNodeKey('db', entry.id),
            kind: 'database',
            label: entry.name,
            detail: '',
            dbId: entry.id,
            database: entry.name,
            env: environment.env,
            instanceLabel: instance.label ?? '',
            configured: entry.discovered !== true,
          },
        }
        if (preferred !== '' && String(environment.env ?? '').toLowerCase() === preferred) return target
        if (fallback === undefined) fallback = target
      }
    }
  }
  return fallback
}

/** One favorite as a tree leaf. */
function dwFavoriteLeaf(favorite) {
  const reference = [favorite.database, favorite.table].filter((part) => typeof part === 'string' && part !== '').join('.')
  return {
    node: {
      key: dwNodeKey('favorite', favorite.id),
      kind: 'favorite',
      label: favorite.name,
      detail: '',
      title: `${favorite.name}  ·  ${reference}\n\n${favorite.sql}`,
      favorite,
    },
    children: [],
  }
}

/**
 * The favorites tab's rows: schema → table → statement.
 *
 * A statement saved without a table name still gets a table group, so the tab
 * keeps one shape instead of mixing leaves and groups under a schema.
 */
function dwBuildFavoriteRows(favorites, tr) {
  const list = (Array.isArray(favorites) ? favorites : []).filter((favorite) => favorite !== null
    && typeof favorite === 'object'
    && typeof favorite.id === 'string'
    && favorite.id !== '')
  if (list.length === 0) return []
  const byDatabase = new Map()
  for (const favorite of list) {
    const database = String(favorite.database ?? '').trim() || tr('favoriteNoDatabase')
    const table = String(favorite.table ?? '').trim()
    const tableKey = table === '' ? '' : table.toLowerCase()
    if (!byDatabase.has(database)) byDatabase.set(database, new Map())
    const tables = byDatabase.get(database)
    if (!tables.has(tableKey)) tables.set(tableKey, { table, favorites: [] })
    tables.get(tableKey).favorites.push(favorite)
  }

  const rows = []
  const databaseNames = [...byDatabase.keys()].sort((left, right) => left.localeCompare(right))
  for (const databaseName of databaseNames) {
    const tables = byDatabase.get(databaseName)
    const tableKeys = [...tables.keys()].sort((left, right) => {
      if (left === '') return 1
      if (right === '') return -1
      return left.localeCompare(right)
    })
    const tableRows = []
    let statementCount = 0
    for (const tableKey of tableKeys) {
      const group = tables.get(tableKey)
      const leaves = group.favorites
        .slice()
        .sort((left, right) => String(left.name ?? '').localeCompare(String(right.name ?? '')))
        .map(dwFavoriteLeaf)
      statementCount += leaves.length
      tableRows.push({
        node: {
          key: dwNodeKey('favoriteTable', databaseName, tableKey),
          kind: 'favoriteTable',
          label: tableKey === '' ? tr('favoriteNoTable') : group.table,
          detail: `${leaves.length} ${tr('favoritesCount')}`,
          title: `${databaseName}${tableKey === '' ? '' : `.${group.table}`}`,
          database: databaseName,
          table: group.table,
        },
        children: leaves,
      })
    }
    rows.push({
      node: {
        key: dwNodeKey('favoriteDatabase', databaseName),
        kind: 'favoriteDatabase',
        label: databaseName,
        detail: `${statementCount} ${tr('favoritesCount')}`,
        title: `${tr('favoritesTitle')} · ${databaseName}`,
        database: databaseName,
      },
      children: tableRows,
    })
  }
  return rows
}

/** Whether an `@` typed at `index` starts a favorite mention rather than `@var`. */
function dwFavoriteMentionStart(text, index) {
  if (index <= 0) return true
  const before = text[index - 1]
  return /\s/.test(before) || '(),;=<>+-*/'.includes(before)
}

/** The saved statements matching what was typed after `@`, name first. */
function dwFavoriteMatches(favorites, query) {
  const needle = String(query ?? '').trim().toLowerCase()
  const list = (Array.isArray(favorites) ? favorites : []).filter((favorite) => favorite !== null
    && typeof favorite === 'object'
    && typeof favorite.name === 'string')
  const matched = needle === ''
    ? list
    : list.filter((favorite) => [favorite.name, favorite.database, favorite.table]
      .some((value) => String(value ?? '').toLowerCase().includes(needle)))
  return matched
    .slice()
    .sort((left, right) => left.name.localeCompare(right.name))
    .slice(0, 50)
}

/**
 * Name one statement and keep it.
 *
 * The SQL is a read-only preview: what is collected is exactly the selection (or
 * the whole editor) the user right-clicked, and a rename or a re-collection is the
 * way to change it. The schema and table are editable because the console only
 * knows its own database — a statement that joins another schema is the user's
 * call, and it is what the tree groups by.
 */
function DwFavoriteDialog({ store, tr, draft, onClose, onSaved }) {
  const editing = String(draft?.id ?? '') !== ''
  const [name, setName] = useState(String(draft?.name ?? ''))
  const [database, setDatabase] = useState(String(draft?.database ?? ''))
  const [table, setTable] = useState(String(draft?.table ?? ''))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const sql = String(draft?.sql ?? '')
  // A Chinese/Japanese name is typed through the IME: its Enter belongs to the
  // candidate list, not to the dialog. Chromium already flags the composition
  // keystroke, and the short grace period covers a browser that ends the
  // composition just before delivering that Enter.
  const composingRef = useRef(false)
  const compositionEndedAtRef = useRef(0)
  const imeBusy = (event) => dwImeComposing(event)
    || composingRef.current === true
    || Date.now() - compositionEndedAtRef.current < 100
  const databaseNames = dwDatabaseNames(store.getState?.()?.environments)

  const submit = async () => {
    if (saving === true) return
    const nextName = name.trim()
    const nextDatabase = database.trim()
    if (nextName === '') {
      setError(tr('favoriteNameRequired'))
      return
    }
    if (nextDatabase === '') {
      setError(tr('favoriteDatabaseRequired'))
      return
    }
    // The Host owns the real check; this one only saves a round trip on the
    // failure the user is most likely to hit while typing a name.
    const taken = (store.getState?.()?.favorites ?? []).find((favorite) => String(favorite?.name ?? '').trim().toLowerCase() === nextName.toLowerCase()
      && favorite?.id !== draft?.id)
    if (taken !== undefined) {
      setError(tr('error.duplicateFavorite'))
      return
    }
    setSaving(true)
    setError('')
    try {
      const value = await store.saveFavorite({
        id: draft?.id,
        name: nextName,
        database: nextDatabase,
        table: table.trim(),
        env: draft?.env ?? '',
        sql,
      })
      if (typeof onSaved === 'function') onSaved(value?.favorite)
      onClose()
    } catch (failure) {
      setError(dwExplainFailure(tr, failure))
      setSaving(false)
    }
  }

  const field = (key, label, value, onChange, hint, options) => h('label', { key, className: 'dw-form-row' }, [
    h('span', { key: 'l', className: 'dw-form-label' }, label),
    h('input', {
      key: 'i',
      className: 'dw-form-input',
      value,
      spellCheck: false,
      autoComplete: 'off',
      autoFocus: options?.focus === true,
      list: options?.list,
      maxLength: options?.maxLength,
      onChange: (event) => onChange(event.target.value),
      onCompositionStart: () => {
        composingRef.current = true
      },
      onCompositionEnd: () => {
        composingRef.current = false
        compositionEndedAtRef.current = Date.now()
      },
      onKeyDown: (event) => {
        if (event.key !== 'Enter') return
        if (imeBusy(event)) return
        void submit()
      },
    }),
    hint === undefined ? null : h('span', { key: 'h', className: 'dw-form-hint' }, hint),
  ])

  return h(DwModal, {
    onClose,
    busy: saving === true,
    className: 'dw-favorite-dialog',
    label: tr(editing ? 'favoriteEditTitle' : 'favoriteSaveTitle'),
  }, [
    h('div', { key: 'title', className: 'dw-modal-title' }, [
      h(DwIcon, { key: 'i', name: 'star', size: 15 }),
      h('span', { key: 't' }, tr(editing ? 'favoriteEditTitle' : 'favoriteSaveTitle')),
    ]),
    h('div', { key: 'body', className: 'dw-modal-body' }, h('div', { key: 'form', className: 'dw-form' }, [
      field('name', tr('favoriteName'), name, setName, tr('favoriteNameHint'), { focus: true, maxLength: 80 }),
      h('div', { key: 'split', className: 'dw-fav-split' }, [
        field('database', tr('favoriteDatabase'), database, setDatabase, tr('favoriteDatabaseHint'), { list: 'dw-favorite-databases', maxLength: 64 }),
        field('table', tr('favoriteTable'), table, setTable, tr('favoriteTableHint'), { maxLength: 64 }),
      ]),
      h('datalist', { key: 'names', id: 'dw-favorite-databases' }, databaseNames.map((value) => h('option', { key: value, value }))),
      h('div', { key: 'sql-label', className: 'dw-form-label' }, tr('favoriteSql')),
      h('pre', { key: 'sql', className: 'dw-fav-sql' }, sql),
      h('div', { key: 'hint', className: 'dw-ai-note' }, tr('favoriteDialogHint')),
      error === ''
        ? null
        : h('div', { key: 'err', className: 'dw-ai-note dw-ai-warn' }, error),
    ])),
    h('div', { key: 'foot', className: 'dw-modal-foot' }, [
      h('button', { key: 'cancel', type: 'button', className: 'dw-btn', disabled: saving === true, onClick: onClose }, tr('cancel')),
      h('button', {
        key: 'save',
        type: 'button',
        className: 'dw-btn dw-btn-accent',
        disabled: saving === true,
        onClick: () => void submit(),
      }, saving === true ? tr('schemaApplying') : tr(editing ? 'favoriteUpdateAction' : 'favoriteSaveAction')),
    ]),
  ])
}

export { dwTabTableName, dwDatabaseNames, dwFindDatabaseTarget, dwBuildFavoriteRows, dwFavoriteMentionStart, dwFavoriteMatches, DwFavoriteDialog }
