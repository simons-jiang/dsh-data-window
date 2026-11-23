/**
 * The database tree.
 *
 * Rows are derived from the store on every render: expansion state, lazily loaded
 * children, retry markers and the filter all live in one place, so a node can be
 * revealed by a shortcut without the tree caching its own copy of the list.
 *
 * The filter keeps a node when the node itself or any loaded descendant matches,
 * which is what makes searching for a table name actually find it.
 */

/** One nested tree of what the store currently knows, before filtering. */
function dwBuildTree(state, tr) {
  const loadStateOf = (key) => state.loadState.get(key)
  const childrenOf = (node, depth) => {
    const rows = []
    for (const child of state.children.get(node.key) ?? []) {
      rows.push({ node: child, children: childrenOf(child, depth + 1) })
    }
    if (rows.length === 0 && loadStateOf(node.key) === 'error') {
      rows.push({
        node: { key: `${node.key}:retry`, kind: 'retry', label: 'retry', retryOf: node },
        children: [],
      })
    }
    return rows
  }

  const environments = []
  for (const environment of state.environments ?? []) {
    const envKey = dwNodeKey('env', environment.env)
    const instanceRows = []
    for (const instance of environment.instances) {
      const instanceKey = dwNodeKey('inst', instance.id)
      const extra = state.children.get(instanceKey) ?? []
      const databases = [...instance.databases]
      const known = new Set(databases.map((database) => database.name))
      for (const discovered of extra) {
        if (known.has(discovered.label)) continue
        databases.push({ name: discovered.label, id: discovered.dbId, discovered: true })
      }
      const databaseRows = databases.map((database) => {
        const databaseNode = {
          key: dwNodeKey('db', database.id),
          kind: 'database',
          label: database.name,
          detail: '',
          dbId: database.id,
          database: database.name,
          env: environment.env,
          instanceLabel: instance.label,
          configured: database.discovered !== true,
        }
        return { node: databaseNode, children: childrenOf(databaseNode, 3) }
      })
      instanceRows.push({
        node: {
          key: instanceKey,
          kind: 'instance',
          // The alias is the name the project's own configuration uses
          // (`mysql-main`), so it is the one a user recognises; the hostname is
          // kept as the detail because it is what actually identifies the machine.
          label: instance.aliases?.[0] ?? instance.host,
          detail: `${instance.databases.length} ${tr('envDatabases')}`,
          title: [
            instance.host + ':' + instance.port,
            instance.user,
            ...(instance.aliases ?? []),
          ].join('  ·  '),
          id: instance.id,
          env: environment.env,
          user: instance.user,
          databases: instance.databases,
          aliases: instance.aliases ?? [],
          allLoaded: extra.length > 0,
        },
        children: databaseRows,
      })
    }
    environments.push({
      node: {
        key: envKey,
        kind: 'env',
        label: environment.label,
        detail: `${environment.instances.length} ${tr('envInstances')} · ${environment.databaseCount} ${tr('envDatabases')}`,
        env: environment.env,
        instanceCount: environment.instances.length,
        databaseCount: environment.databaseCount,
      },
      children: instanceRows,
    })
  }
  return environments
}

/** Prune a tree to the nodes that match, keeping their ancestors. */
function dwPruneTree(tree, filter) {
  if (filter === '') return tree
  const keep = (row) => {
    const label = String(row.node.label ?? '').toLowerCase()
    const matched = label.includes(filter)
    const children = dwPruneTree(row.children, filter)
    if (!matched && children.length === 0) return undefined
    return { node: row.node, children, matched }
  }
  const result = []
  for (const row of tree) {
    const kept = keep(row)
    if (kept !== undefined) result.push(kept)
  }
  return result
}

/** Flatten a pruned tree into the visible rows, with depth and open state. */
function dwFlattenTree(tree, state, filter, depth = 0, into = []) {
  for (const row of tree) {
    const node = row.node
    const expandable = node.kind !== 'column' && node.kind !== 'retry'
    const open = state.expanded.has(node.key) || (filter !== '' && row.children.length > 0)
    into.push({
      node,
      depth,
      expandable,
      open,
      loading: state.loadState.get(node.key) === 'loading',
      loadingError: state.loadState.get(node.key) === 'error',
    })
    if (row.children.length > 0 && open) dwFlattenTree(row.children, state, filter, depth + 1, into)
  }
  return into
}

/** One row per visible node, in display order. */
function dwVisibleRows(state, tr) {
  const filter = String(state.filter ?? '').trim().toLowerCase()
  const tree = dwPruneTree(dwBuildTree(state, tr), filter)
  return dwFlattenTree(tree, state, filter)
}

/** The icon of one node. */
function dwNodeIconName(node) {
  switch (node.kind) {
    case 'env': return 'env'
    case 'instance': return 'instance'
    case 'database': return 'database'
    case 'view': return 'view'
    case 'table': return 'table'
    case 'column': return node.column?.key === 'PRI' ? 'key' : 'column'
    case 'retry': return 'refresh'
    case 'error': return 'close'
    default: return 'panel'
  }
}

function DwTree({ store, state, tr, onContextMenu }) {
  const rows = useMemo(
    () => dwVisibleRows(state, tr),
    [state.environments, state.expanded, state.children, state.loadState, state.filter],
  )

  const activate = (row) => {
    const node = row.node
    if (node.kind === 'retry') {
      store.retryNode(node.retryOf)
      return
    }
    store.select(node)
    if (node.kind === 'database') {
      store.openDatabase(node)
      // Opening the workbench also reveals its tables: that is the list the user
      // came for, and one click is better than two.
      if (row.open !== true) void store.toggleNode(node)
      return
    }
    if (row.expandable === true) void store.toggleNode(node)
  }

  const openTableData = (row) => {
    const node = row.node
    if (node.kind !== 'table' && node.kind !== 'view') return
    const statement = `SELECT *\nFROM \`${node.database}\`.\`${node.table}\`\nLIMIT 100`
    store.seedStatement(node, statement)
    // Run only the statement just appended: the tab may already hold earlier
    // statements, and sending the whole buffer would be a multi-statement error.
    void store.runActiveTab(statement)
  }

  if (rows.length === 0) {
    const empty = state.phase === 'loading'
      ? tr('treeLoading')
      : String(state.filter ?? '') !== ''
        ? tr('treeNoMatch')
        : tr('treeEmpty')
    return h('div', { className: 'dw-tree' }, h('div', { className: 'dw-empty', style: { padding: 18 } }, [
      h('div', { key: 't', className: 'dw-empty-hint' }, empty),
      String(state.filter ?? '') !== ''
        ? h('button', {
          key: 'c',
          type: 'button',
          className: 'dw-btn',
          onClick: () => store.patch({ filter: '' }),
        }, tr('clearFilter'))
        : null,
    ]))
  }

  return h('div', { className: 'dw-tree' }, rows.map((row) => {
    const node = row.node
    const selected = state.selected === node.key
    const twisty = row.expandable === true
      ? h('span', {
        key: 'tw',
        className: 'dw-node-twisty',
        style: { transform: row.open === true ? 'rotate(90deg)' : 'none', transition: 'transform 110ms ease', cursor: 'pointer' },
        onClick: (event) => {
          // The twisty is the only control that collapses a node: clicking the row
          // of a database opens its workbench and never closes the list.
          event.stopPropagation()
          store.select(node)
          void store.toggleNode(node)
        },
      }, row.loading === true ? h(DwIcon, { name: 'spinner', size: 11 }) : h(DwIcon, { name: 'chevron', size: 11 }))
      : h('span', { key: 'tw', className: 'dw-node-twisty dw-node-twisty-empty' })

    const detail = node.kind === 'retry' ? '' : node.detail

    return h('div', {
      key: node.key,
      className: [
        'dw-node',
        `dw-node-${node.kind}`,
        selected ? 'dw-node-selected' : '',
        row.loadingError === true ? 'dw-node-error' : '',
      ].filter(Boolean).join(' '),
      style: { paddingLeft: 6 + row.depth * 13 },
      title: node.kind === 'column'
        ? [
          node.label,
          node.detail ?? '',
          node.column?.nullable === false ? 'NOT NULL' : 'NULL',
          node.column?.key === 'PRI' ? 'PRIMARY KEY' : '',
          node.column?.comment ?? '',
        ].filter((part) => part !== '').join('  ·  ')
        : `${node.title ?? `${node.label}${node.detail ? `  ${node.detail}` : ''}`}`,
      onClick: () => activate(row),
      onDoubleClick: () => (node.kind === 'table' || node.kind === 'view' ? openTableData(row) : undefined),
      onContextMenu: (event) => {
        event.preventDefault()
        store.select(node)
        onContextMenu(event, node)
      },
    }, [
      twisty,
      h('span', { key: 'ic', className: 'dw-node-icon' }, h(DwIcon, { name: dwNodeIconName(node), size: 13 })),
      h('span', { key: 'lb', className: 'dw-node-label' }, node.kind === 'retry'
        ? tr('retry')
        : node.label),
      node.detail !== '' && node.detail !== undefined && node.kind !== 'retry'
        ? h('span', { key: 'dt', className: 'dw-node-detail' }, detail)
        : null,
      node.kind === 'instance' && node.allLoaded !== true
        ? h('button', {
          key: 'all',
          type: 'button',
          className: 'dw-node-more',
          title: tr('browseAllDatabases'),
          onClick: (event) => {
            event.stopPropagation()
            store.select(node)
            void store.loadAllDatabases(node)
          },
        }, h(DwIcon, { name: 'grid', size: 12 }))
        : null,
    ])
  }))
}

export { DwTree, dwVisibleRows, dwNodeIconName, dwBuildTree, dwPruneTree }
