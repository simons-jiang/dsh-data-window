/**
 * The AI fallback dialog.
 *
 * The configuration scan only knows the shapes this team already writes. When it
 * finds nothing, the user may hand the workspace to a model — but the model only
 * proposes file paths and keys; the Host reads the value and proves the address
 * with a real connection. This dialog is where the model is chosen (DSH's own
 * configured providers), and where the result is reported.
 *
 * The choice is a display preference, so it lives with the other preferences in
 * localStorage: another machine is expected to have another model configured.
 */

/** The saved model choice, or null when the user never picked one. */
function dwAiModel() {
  return dwReadPrefs().aiModel ?? null
}

/** Persist one model choice and return the normalized record. */
function dwAiSaveModel(selection) {
  const provider = String(selection?.provider ?? '').trim()
  const model = String(selection?.model ?? '').trim()
  const name = String(selection?.name ?? '').trim()
  if (provider === '' || model === '') return null
  const saved = { provider, model, name: name === '' ? model : name }
  dwWritePrefs({ aiModel: saved })
  return saved
}

/** Bound one request so a stuck provider cannot leave the dialog spinning forever. */
function dwAiWithTimeout(promise, milliseconds) {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${milliseconds} ms`)), milliseconds)
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer)
        resolvePromise(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

/** The first selectable model of a catalog, for a first-time default. */
function dwAiFirstModel(groups) {
  for (const group of Array.isArray(groups) ? groups : []) {
    const model = (Array.isArray(group?.models) ? group.models : [])[0]
    if (model !== undefined) return { provider: group.id, model: model.id, name: model.name ?? model.id }
  }
  return null
}

/** The preset DSH is configured with, when the catalog still offers it. */
function dwAiPreset(value, groups) {
  const provider = String(value?.default?.provider ?? '')
  const model = String(value?.default?.model ?? '')
  const group = (Array.isArray(groups) ? groups : []).find((entry) => entry.id === provider)
  const found = group === undefined ? undefined : group.models.find((entry) => entry.id === model)
  if (found === undefined) return null
  return { provider, model, name: found.name ?? found.id }
}

/** "DeepSeek Chat · deepseek" for a chip; empty when nothing was chosen. */
function dwAiModelLabel(selection) {
  if (selection === null || selection === undefined) return ''
  return `${selection.name ?? selection.model} · ${selection.provider}`
}

/**
 * Modal used by both the empty state and the settings page.
 *
 * @param props `{ store, tr, onClose }`; `store.runAiDiscovery` performs the scan
 */
function DwAiDialog({ store, tr, onClose, onManual }) {
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState)
  const [mode, setMode] = useState('models-loading')
  const [groups, setGroups] = useState([])
  const [error, setError] = useState('')
  const [report, setReport] = useState(null)
  const [selection, setSelection] = useState(() => dwAiModel())
  const [preset, setPreset] = useState(null)
  const [attempt, setAttempt] = useState(0)
  const modeRef = useRef(mode)
  modeRef.current = mode

  const close = () => {
    if (modeRef.current === 'running') return
    onClose()
  }

  useEffect(() => {
    const onKey = (event) => {
      if (event.key !== 'Escape') return
      if (modeRef.current === 'running') return
      onClose()
    }
    globalThis.addEventListener('keydown', onKey)
    return () => globalThis.removeEventListener('keydown', onKey)
  }, [onClose])

  // The catalog is DSH's, not this plugin's: ask the Host once per attempt and let
  // the user retry a provider whose discovery failed.
  useEffect(() => {
    let alive = true
    setMode('models-loading')
    setError('')
    dwAiWithTimeout(dwRpc('models'), 20000).then((value) => {
      if (!alive) return
      if (value?.available !== true) {
        setError(tr('aiNoLlm'))
        setMode('models-error')
        return
      }
      const list = (Array.isArray(value.groups) ? value.groups : [])
        .map((group) => ({
          id: String(group?.id ?? ''),
          name: String(group?.name ?? group?.id ?? ''),
          error: String(group?.error ?? ''),
          models: (Array.isArray(group?.models) ? group.models : []).filter((model) => typeof model?.id === 'string'),
        }))
        .filter((group) => group.id !== '' && (group.models.length > 0 || group.error !== ''))
      setGroups(list)
      // A saved choice can point at a model the user has since removed from DSH;
      // otherwise pre-select the model DSH itself is set to use.
      const suggested = dwAiPreset(value, list) ?? dwAiFirstModel(list)
      setPreset(suggested)
      setSelection((current) => {
        const exists = current !== null && list.some((group) => group.id === current.provider
          && group.models.some((model) => model.id === current.model))
        return exists ? current : suggested
      })
      setMode('choose')
    }).catch((failure) => {
      if (!alive) return
      setError(dwExplainFailure(tr, failure))
      setMode('models-error')
    })
    return () => {
      alive = false
    }
  }, [attempt])

  const start = async () => {
    if (selection === null) return
    const saved = dwAiSaveModel(selection)
    if (saved === null) return
    setSelection(saved)
    setError('')
    setReport(null)
    setMode('running')
    const outcome = await store.runAiDiscovery(saved)
    if (outcome?.ok === true) {
      setReport(outcome.value ?? null)
      setMode('done')
      return
    }
    setError(outcome?.error ?? tr('aiFailed'))
    setMode('run-error')
  }

  const models = groups.filter((group) => group.models.length > 0)
  const body = []
  if (mode === 'models-loading') {
    body.push(h('div', { key: 'loading', className: 'dw-ai-loading' }, [
      h(DwIcon, { key: 'i', name: 'spinner', size: 16 }),
      h('span', { key: 't' }, tr('aiLoadingModels')),
    ]))
  }
  if (mode === 'choose') {
    body.push(h('div', { key: 'pick', className: 'dw-ai-pick' }, [
      h('div', { key: 'label', className: 'dw-ai-label' }, tr('aiPickModel')),
      models.length === 0
        ? h('div', { key: 'none', className: 'dw-ai-note' }, tr('aiNoModels'))
        : h('div', { key: 'list', className: 'dw-ai-list', role: 'radiogroup', 'aria-label': tr('aiPickModel') },
          models.map((group) => h('div', { key: group.id, className: 'dw-ai-group' }, [
            h('div', { key: 'head', className: 'dw-ai-group-title' }, group.name === '' ? group.id : group.name),
            ...group.models.map((model) => {
              const chosen = selection !== null && selection.provider === group.id && selection.model === model.id
              return h('button', {
                key: `${group.id}:${model.id}`,
                type: 'button',
                role: 'radio',
                'aria-checked': chosen,
                className: chosen ? 'dw-ai-model on' : 'dw-ai-model',
                onClick: () => setSelection({ provider: group.id, model: model.id, name: model.name ?? model.id }),
              }, [
                h('span', { key: 'name', className: 'dw-ai-model-name' }, [
                  h('span', { key: 'label' }, model.name ?? model.id),
                  preset !== null && preset.provider === group.id && preset.model === model.id
                    ? h('span', { key: 'tag', className: 'dw-ai-model-tag' }, tr('aiDefaultTag'))
                    : null,
                ]),
                model.description === undefined || model.description === ''
                  ? null
                  : h('span', { key: 'desc', className: 'dw-ai-model-desc' }, model.description),
              ])
            }),
            group.error === ''
              ? null
              : h('div', { key: 'err', className: 'dw-ai-note dw-ai-warn' }, tr('aiProviderFailed', { message: group.error })),
          ]))),
      h('div', { key: 'note', className: 'dw-ai-note' }, tr('aiPrivacy')),
      typeof onManual === 'function'
        ? h('button', {
          key: 'manual',
          type: 'button',
          className: 'dw-ai-link',
          onClick: () => {
            onManual()
            onClose()
          },
        }, tr('aiManualInstead'))
        : null,
    ]))
  }
  if (mode === 'running') {
    body.push(h('div', { key: 'running', className: 'dw-ai-loading' }, [
      h(DwIcon, { key: 'i', name: 'spinner', size: 16 }),
      h('div', { key: 'box' }, [
        h('div', { key: 't' }, tr('aiRunning', { model: dwAiModelLabel(selection) })),
        h('div', { key: 'h', className: 'dw-ai-note' }, tr('aiRunningHint')),
      ]),
    ]))
  }
  if (mode === 'models-error' || mode === 'run-error') {
    body.push(h('div', { key: 'error', className: 'dw-ai-error' }, [
      h('div', { key: 't' }, tr('aiFailedTitle')),
      h('div', { key: 'm', className: 'dw-ai-note' }, error === '' ? tr('aiFailed') : error),
    ]))
  }
  if (mode === 'done') {
    const warnings = Array.isArray(report?.warnings) ? report.warnings : []
    const accepted = Number(report?.accepted ?? 0)
    body.push(h('div', { key: 'done', className: 'dw-ai-done' }, [
      h('div', { key: 'title', className: accepted > 0 ? 'dw-ai-ok' : 'dw-ai-warn' }, accepted > 0
        ? tr('aiDone', { accepted, candidates: Number(report?.candidates ?? 0) })
        : tr('aiDoneEmpty')),
      h('div', { key: 'hint', className: 'dw-ai-note' }, tr('aiDoneHint')),
      warnings.length === 0
        ? null
        : h('div', { key: 'warn', className: 'dw-code-block' }, warnings.map((warning) => dwWarningText(warning, tr)).join('\n')),
      typeof report?.notes === 'string' && report.notes !== ''
        ? h('div', { key: 'notes', className: 'dw-ai-note' }, report.notes)
        : null,
    ]))
  }

  const footer = []
  if (mode === 'choose') {
    footer.push(h('button', { key: 'cancel', type: 'button', className: 'dw-btn', onClick: close }, tr('cancel')))
    footer.push(h('button', {
      key: 'start',
      type: 'button',
      className: 'dw-btn dw-btn-accent',
      disabled: selection === null || models.length === 0 || state.aiRunning === true,
      onClick: () => void start(),
    }, tr('aiStart')))
  } else if (mode === 'running') {
    footer.push(h('button', { key: 'cancel', type: 'button', className: 'dw-btn', disabled: true }, tr('cancel')))
  } else if (mode === 'done') {
    footer.push(h('button', {
      key: 'again',
      type: 'button',
      className: 'dw-btn',
      onClick: () => {
        setReport(null)
        setError('')
        setMode('choose')
      },
    }, tr('aiAgain')))
    footer.push(h('button', { key: 'close', type: 'button', className: 'dw-btn dw-btn-accent', onClick: close }, tr('close')))
  } else {
    footer.push(h('button', { key: 'retry', type: 'button', className: 'dw-btn', onClick: () => setAttempt(attempt + 1) }, tr('aiRetry')))
    footer.push(h('button', { key: 'close', type: 'button', className: 'dw-btn', onClick: close }, tr('close')))
  }

  return h('div', {
    className: 'dw-modal',
    onClick: (event) => {
      if (event.target === event.currentTarget) close()
    },
  }, h('div', {
    key: 'card',
    className: 'dw-modal-card',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': tr('aiTitle'),
  }, [
    h('div', { key: 'title', className: 'dw-modal-title' }, [
      h(DwIcon, { key: 'i', name: 'ai', size: 15 }),
      h('span', { key: 't' }, tr('aiTitle')),
    ]),
    h('div', { key: 'body', className: 'dw-modal-body' }, body),
    h('div', { key: 'foot', className: 'dw-modal-foot' }, footer),
  ]))
}

/** The settings row that shows (and changes) the chosen model. */
function DwAiSettingsRow({ tr, prefs, onOpen }) {
  const label = prefs.aiModel === null ? tr('settingsAiModelNone') : dwAiModelLabel(prefs.aiModel)
  return h('div', { className: 'dw-settings-row' }, [
    h('div', { key: 'head', className: 'dw-settings-head' }, [
      h('span', { key: 'label', className: 'dw-settings-label' }, tr('settingsAiModel')),
      h('div', { key: 'right', className: 'dw-settings-shortcut-actions' }, [
        h('span', { key: 'value', className: 'dw-settings-value' }, label),
        h('button', {
          key: 'change',
          type: 'button',
          className: 'dw-btn',
          onClick: onOpen,
        }, prefs.aiModel === null ? tr('settingsAiChoose') : tr('settingsAiChange')),
      ]),
    ]),
    h('div', { key: 'desc', className: 'dw-settings-desc' }, tr('settingsAiModelHint')),
    h('div', { key: 'note', className: 'dw-settings-desc dw-ai-warn' }, tr('aiPrivacy')),
  ])
}
