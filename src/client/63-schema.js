/**
 * The schema picker.
 *
 * An instance carries far more schemas than the project's configuration names, and
 * dropping all of them into the tree buries the few a user actually works with. This
 * dialog is the explicit choice: every schema the server reports on the left of a
 * checkbox, the configured ones locked on, and only the checked ones reach the tree.
 *
 * What the user picks is stored per workspace by the Host (`selectDatabases`), so
 * the choice survives a restart and a browser change.
 */

/**
 * The "choose databases" modal for one instance.
 *
 * @param props `{ store, tr, instance, onClose }`; `instance` is the tree node, which
 *   carries the configured databases and the id the server answers for
 */
function DwSchemaDialog({ store, tr, instance, onClose }) {
  const [phase, setPhase] = useState('loading')
  const [schemas, setSchemas] = useState([])
  const [checked, setChecked] = useState(() => new Set((instance?.databases ?? []).map((database) => database.name)))
  const [locked] = useState(() => new Set((instance?.databases ?? [])
    .filter((database) => database.remembered !== true)
    .map((database) => database.name)))
  const [query, setQuery] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let alive = true
    setPhase('loading')
    dwRpc('databases', { id: instance?.id }).then((value) => {
      if (!alive) return
      const names = (Array.isArray(value?.databases) ? value.databases : [])
        .map((entry) => String(entry?.name ?? ''))
        .filter((name) => name !== '')
      setSchemas(names)
      // A schema that is configured is always shown; anything the server still has
      // but the workspace no longer remembers comes back unchecked.
      setChecked((current) => {
        const next = new Set([...current].filter((name) => names.includes(name)))
        for (const name of current) {
          if (!names.includes(name)) continue
          next.add(name)
        }
        return next
      })
      setPhase('ready')
    }).catch((failure) => {
      if (!alive) return
      setError(dwExplainFailure(tr, failure))
      setPhase('error')
    })
    return () => {
      alive = false
    }
  }, [instance?.id])

  const toggle = (name) => {
    if (locked.has(name)) return
    const next = new Set(checked)
    if (next.has(name)) next.delete(name)
    else next.add(name)
    setChecked(next)
  }

  const apply = async () => {
    if (saving === true) return
    const root = String(store.getState?.()?.root ?? '')
    if (root === '') {
      setError(tr('manualNoWorkspace'))
      return
    }
    setSaving(true)
    setError('')
    try {
      // Configured schemas are always shown by discovery itself; storing them too
      // would make a schema that later leaves the configuration look hand-picked.
      const names = [...checked].filter((name) => !locked.has(name))
      await dwRpc('selectDatabases', { root, instanceId: instance.id, databases: names })
      await store.loadDiscovery({ quiet: true })
      onClose()
    } catch (failure) {
      setError(dwExplainFailure(tr, failure))
      setSaving(false)
    }
  }

  const filter = query.trim().toLowerCase()
  const visible = filter === '' ? schemas : schemas.filter((name) => name.toLowerCase().includes(filter))
  const chosenCount = [...checked].filter((name) => schemas.includes(name)).length

  const body = []
  if (phase === 'loading') {
    body.push(h('div', { key: 'loading', className: 'dw-ai-loading' }, [
      h(DwIcon, { key: 'i', name: 'spinner', size: 16 }),
      h('span', { key: 't' }, tr('schemaLoading')),
    ]))
  } else if (phase === 'error') {
    body.push(h('div', { key: 'error', className: 'dw-ai-error' }, [
      h('div', { key: 't' }, tr('schemaFailed')),
      h('div', { key: 'm', className: 'dw-ai-note' }, error),
    ]))
  } else {
    body.push(h('div', { key: 'head', className: 'dw-schema-head' }, [
      h('input', {
        key: 'search',
        className: 'dw-form-input',
        type: 'search',
        value: query,
        placeholder: tr('schemaSearch'),
        onChange: (event) => setQuery(event.target.value),
        style: { width: 240 },
      }),
      h('span', { key: 'count', className: 'dw-ai-note' }, tr('schemaCount', { chosen: chosenCount, total: schemas.length })),
    ]))
    body.push(h('div', { key: 'list', className: 'dw-schema-list' }, visible.length === 0
      ? [h('div', { key: 'empty', className: 'dw-ai-note' }, tr('schemaNoMatch'))]
      : visible.map((name) => h('label', {
        key: name,
        className: locked.has(name) ? 'dw-schema-row locked' : 'dw-schema-row',
      }, [
        h('input', {
          key: 'c',
          type: 'checkbox',
          className: 'dw-schema-box',
          checked: checked.has(name),
          disabled: locked.has(name),
          onChange: () => toggle(name),
        }),
        h('span', { key: 'n', className: 'dw-schema-name' }, name),
        locked.has(name) ? h('span', { key: 't', className: 'dw-node-tag' }, tr('schemaConfigured')) : null,
      ]))))
    body.push(h('div', { key: 'note', className: 'dw-ai-note' }, tr('schemaHint')))
  }

  return h(DwModal, {
    onClose,
    busy: saving === true,
    label: tr('schemaTitle'),
  }, [
    h('div', { key: 'title', className: 'dw-modal-title' }, [
      h(DwIcon, { key: 'i', name: 'database', size: 15 }),
      h('span', { key: 't' }, `${tr('schemaTitle')} · ${instance?.label ?? instance?.host ?? ''}`),
    ]),
    h('div', { key: 'body', className: 'dw-modal-body' }, body),
    error === '' || phase === 'error'
      ? null
      : h('div', { key: 'err', className: 'dw-ai-note dw-ai-warn', style: { padding: '0 16px 8px' } }, error),
    h('div', { key: 'foot', className: 'dw-modal-foot' }, [
      h('button', {
        key: 'cancel',
        type: 'button',
        className: 'dw-btn',
        disabled: saving === true,
        onClick: onClose,
      }, tr('cancel')),
      h('button', {
        key: 'apply',
        type: 'button',
        className: 'dw-btn dw-btn-accent',
        disabled: saving === true || phase !== 'ready',
        onClick: () => void apply(),
      }, saving === true ? tr('schemaApplying') : tr('schemaApply')),
    ]),
  ])
}
