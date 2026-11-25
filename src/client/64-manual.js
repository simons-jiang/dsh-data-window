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
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const savingRef = useRef(false)
  savingRef.current = saving

  useEffect(() => {
    const onKey = (event) => {
      if (event.key !== 'Escape' || savingRef.current) return
      onClose()
    }
    globalThis.addEventListener('keydown', onKey)
    return () => globalThis.removeEventListener('keydown', onKey)
  }, [onClose])

  const update = (key) => (event) => {
    setForm({ ...form, [key]: event.target.value })
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

/** The tree's badge for a manually added connection. */
function dwManualBadge(tr) {
  return h('span', { key: 'badge', className: 'dw-node-tag' }, tr('manualBadge'))
}
