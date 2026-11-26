/**
 * Manually added connections.
 *
 * The rule scan and the AI fallback both try to derive a connection from the
 * workspace. When the database a user needs is described nowhere — a local
 * container, a shared test instance, a customer's replica — this form is the third
 * path. The window keeps these entries per workspace, and the Host proves the
 * connection once before saving it, so a typo fails here instead of producing a
 * tree row that never opens.
 */

/** Empty form state; the port defaults to MySQL's. */
const DW_MANUAL_FORM = { label: '', host: '127.0.0.1', port: '3306', user: '', password: '', database: '' }

/**
 * The "add a connection" modal.
 *
 * @param props `{ store, tr, onClose, onSaved }`; `onSaved` refreshes the tree
 */
function DwManualDialog({ store, tr, onClose, onSaved }) {
  const [form, setForm] = useState(() => ({ ...DW_MANUAL_FORM }))
  const [connections, setConnections] = useState([])
  const [sourceId, setSourceId] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const savingRef = useRef(false)
  savingRef.current = saving

  useEffect(() => {
    const onKey = (event) => {
      if (event.key !== 'Escape' || savingRef.current) return
      if (dwImeComposing(event)) return
      onClose()
    }
    globalThis.addEventListener('keydown', onKey)
    return () => globalThis.removeEventListener('keydown', onKey)
  }, [onClose])

  // Other workspaces usually point at the same hosts and accounts, so the form
  // offers what this machine already resolved instead of asking for it again.
  useEffect(() => {
    let alive = true
    dwAiWithTimeout(dwRpc('savedConnections'), 10000).then((value) => {
      if (!alive) return
      setConnections(Array.isArray(value?.connections) ? value.connections : [])
    }).catch(() => {
      // Without the list the form still works; it is a convenience, not a dependency.
    })
    return () => {
      alive = false
    }
  }, [])

  const update = (key) => (event) => {
    setForm({ ...form, [key]: event.target.value })
    // Editing the identity of the connection detaches it from the imported one, so
    // its stored password is not silently reused for a different host or account.
    if (key === 'host' || key === 'port' || key === 'user' || key === 'password') setSourceId('')
  }

  const chooseSource = (event) => {
    const id = event.target.value
    const entry = connections.find((item) => item.id === id)
    setSourceId(entry === undefined ? '' : id)
    if (entry === undefined) return
    // An imported connection carries the environment it was saved under ("prod"),
    // which is what the user expects to see in the tree — but only when they have
    // not named the new environment themselves.
    const importedLabel = entry.labels.length > 0
      ? String(entry.labels[0]).split(' · ').pop().trim()
      : ''
    setForm({
      ...form,
      label: form.label.trim() === '' ? importedLabel : form.label,
      host: entry.host,
      port: String(entry.port),
      user: entry.user,
      password: '',
      database: entry.databases.length === 1 ? entry.databases[0] : form.database,
    })
  }

  const save = async () => {
    if (saving === true) return
    const root = String(store.getState?.()?.root ?? '')
    if (root === '') {
      setError(tr('manualNoWorkspace'))
      return
    }
    setSaving(true)
    setError('')
    try {
      await dwRpc('manualSave', {
        root,
        entry: {
          label: form.label,
          host: form.host,
          port: Number(form.port),
          user: form.user,
          password: form.password,
          database: form.database,
        },
        sourceId,
      })
      if (typeof onSaved === 'function') onSaved()
      onClose()
    } catch (failure) {
      setError(dwExplainFailure(tr, failure))
      setSaving(false)
    }
  }

  const field = (key, label, props, hint) => h('label', { key, className: 'dw-form-row' }, [
    h('span', { key: 'l', className: 'dw-form-label' }, label),
    h('input', {
      key: 'i',
      className: 'dw-form-input',
      value: form[key],
      spellCheck: false,
      autoComplete: 'off',
      onChange: update(key),
      ...props,
    }),
    hint === undefined ? null : h('span', { key: 'h', className: 'dw-form-hint' }, hint),
  ])

  return h('div', {
    className: 'dw-modal',
    onClick: (event) => {
      if (event.target === event.currentTarget && saving !== true) onClose()
    },
  }, h('div', {
    key: 'card',
    className: 'dw-modal-card',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': tr('manualTitle'),
  }, [
    h('div', { key: 'title', className: 'dw-modal-title' }, [
      h(DwIcon, { key: 'i', name: 'link', size: 15 }),
      h('span', { key: 't' }, tr('manualTitle')),
    ]),
    h('div', { key: 'body', className: 'dw-modal-body' }, [
      h('div', { key: 'hint', className: 'dw-ai-note' }, tr('manualHint')),
      h('div', { key: 'form', className: 'dw-form' }, [
        connections.length === 0
          ? null
          : h('label', { key: 'source', className: 'dw-form-row' }, [
            h('span', { key: 'l', className: 'dw-form-label' }, tr('manualFromSaved')),
            h('select', {
              key: 's',
              className: 'dw-form-input',
              value: sourceId,
              onChange: chooseSource,
            }, [
              h('option', { key: 'none', value: '' }, tr('manualFromSavedNone')),
              ...connections.map((entry) => h('option', {
                key: entry.id,
                value: entry.id,
              }, `${entry.host}:${entry.port} · ${entry.user}${entry.labels.length > 0 ? ` · ${entry.labels[0]}` : ''}`)),
            ]),
            h('span', { key: 'h', className: 'dw-form-hint' }, sourceId === '' ? tr('manualFromSavedHint') : tr('manualSourceHint')),
          ]),
        field('label', tr('manualLabel'), { placeholder: tr('manualLabelPlaceholder') }, tr('manualLabelHint')),
        h('div', { key: 'addr', className: 'dw-form-split' }, [
          field('host', tr('manualHost'), { placeholder: 'mysql.internal' }),
          field('port', tr('manualPort'), { inputMode: 'numeric', placeholder: '3306' }),
        ]),
        field('user', tr('manualUser'), { placeholder: 'app_user' }),
        field('password', tr('manualPassword'), { type: 'password' }),
        field('database', tr('manualDatabase'), { placeholder: 'demo_order' }, tr('manualDatabaseHint')),
      ]),
      error === ''
        ? null
        : h('div', { key: 'err', className: 'dw-ai-error' }, h('div', { key: 'm', className: 'dw-ai-note' }, error)),
      h('div', { key: 'privacy', className: 'dw-ai-note' }, tr('manualPrivacy')),
    ]),
    h('div', { key: 'foot', className: 'dw-modal-foot' }, [
      h('button', {
        key: 'cancel',
        type: 'button',
        className: 'dw-btn',
        disabled: saving === true,
        onClick: onClose,
      }, tr('cancel')),
      h('button', {
        key: 'save',
        type: 'button',
        className: 'dw-btn dw-btn-accent',
        disabled: saving === true,
        onClick: () => void save(),
      }, saving === true ? tr('manualSaving') : tr('manualSave')),
    ]),
  ]))
}

/**
 * Rename one manual environment.
 *
 * The environment name is what the tree groups by, and it also feeds the derived
 * instance ids — the Host moves the user's remembered databases along with the new
 * name, so renaming never costs the schema selection.
 */
function DwRenameEnvDialog({ store, tr, label, onClose, onRenamed }) {
  const [value, setValue] = useState(label)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const savingRef = useRef(false)
  savingRef.current = saving

  useEffect(() => {
    const onKey = (event) => {
      if (event.key !== 'Escape' || savingRef.current) return
      if (dwImeComposing(event)) return
      onClose()
    }
    globalThis.addEventListener('keydown', onKey)
    return () => globalThis.removeEventListener('keydown', onKey)
  }, [onClose])

  const save = async () => {
    if (saving === true) return
    const root = String(store.getState?.()?.root ?? '')
    const next = String(value ?? '').trim().slice(0, 40)
    if (root === '' || next === '' || next === label) {
      onClose()
      return
    }
    setSaving(true)
    setError('')
    try {
      await dwRpc('renameManualEnvironment', { root, from: label, to: next })
      if (typeof onRenamed === 'function') onRenamed()
      onClose()
    } catch (failure) {
      setError(dwExplainFailure(tr, failure))
      setSaving(false)
    }
  }

  return h('div', {
    className: 'dw-modal',
    onClick: (event) => {
      if (event.target === event.currentTarget && saving !== true) onClose()
    },
  }, h('div', {
    key: 'card',
    className: 'dw-modal-card',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': tr('renameTitle'),
  }, [
    h('div', { key: 'title', className: 'dw-modal-title' }, [
      h(DwIcon, { key: 'i', name: 'link', size: 15 }),
      h('span', { key: 't' }, tr('renameTitle')),
    ]),
    h('div', { key: 'body', className: 'dw-modal-body' }, [
      h('label', { key: 'field', className: 'dw-form-row' }, [
        h('span', { key: 'l', className: 'dw-form-label' }, tr('renameLabel')),
        h('input', {
          key: 'i',
          className: 'dw-form-input',
          value,
          spellCheck: false,
          autoComplete: 'off',
          onChange: (event) => setValue(event.target.value),
          onKeyDown: (event) => {
            if (event.key !== 'Enter') return
            if (dwImeComposing(event)) return
            void save()
          },
        }),
      ]),
      h('div', { key: 'hint', className: 'dw-ai-note' }, tr('renameHint')),
      error === ''
        ? null
        : h('div', { key: 'err', className: 'dw-ai-note dw-ai-warn' }, error),
    ]),
    h('div', { key: 'foot', className: 'dw-modal-foot' }, [
      h('button', { key: 'cancel', type: 'button', className: 'dw-btn', disabled: saving === true, onClick: onClose }, tr('cancel')),
      h('button', {
        key: 'save',
        type: 'button',
        className: 'dw-btn dw-btn-accent',
        disabled: saving === true,
        onClick: () => void save(),
      }, saving === true ? tr('schemaApplying') : tr('renameApply')),
    ]),
  ]))
}

/**
 * A small confirmation for one destructive tree action.
 *
 * Removing an environment also removes the databases picked inside it, so the action
 * asks once instead of acting on a stray right-click.
 */
function DwConfirmDialog({ tr, title, message, confirmLabel, onConfirm, onClose }) {
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  busyRef.current = busy

  useEffect(() => {
    const onKey = (event) => {
      if (event.key !== 'Escape' || busyRef.current) return
      if (dwImeComposing(event)) return
      onClose()
    }
    globalThis.addEventListener('keydown', onKey)
    return () => globalThis.removeEventListener('keydown', onKey)
  }, [onClose])

  const confirm = async () => {
    if (busy === true) return
    setBusy(true)
    try {
      await onConfirm()
    } finally {
      setBusy(false)
    }
  }

  return h('div', {
    className: 'dw-modal',
    onClick: (event) => {
      if (event.target === event.currentTarget && busy !== true) onClose()
    },
  }, h('div', {
    key: 'card',
    className: 'dw-modal-card',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': title,
  }, [
    h('div', { key: 'title', className: 'dw-modal-title' }, title),
    h('div', { key: 'body', className: 'dw-modal-body' }, [
      h('div', { key: 'm', className: 'dw-ai-note' }, message),
    ]),
    h('div', { key: 'foot', className: 'dw-modal-foot' }, [
      h('button', { key: 'cancel', type: 'button', className: 'dw-btn', disabled: busy === true, onClick: onClose }, tr('cancel')),
      h('button', {
        key: 'confirm',
        type: 'button',
        className: 'dw-btn dw-btn-accent',
        disabled: busy === true,
        onClick: () => void confirm(),
      }, confirmLabel),
    ]),
  ]))
}

/** The tree's badge for a manually added connection. */
function dwManualBadge(tr) {
  return h('span', { key: 'badge', className: 'dw-node-tag' }, tr('manualBadge'))
}
