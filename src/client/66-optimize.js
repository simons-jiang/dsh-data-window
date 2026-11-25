/**
 * The "AI optimize" dialog for the SQL editor.
 *
 * The model is the one chosen in settings (`aiModel`); the Host calls it, and the
 * answer is shown as a suggestion. Nothing is executed or written back to the
 * editor automatically — copying is the only way out, which keeps the "never
 * overwrite user SQL" rule intact.
 */

function dwOptimizeModelName(model) {
  return String(model?.name ?? model?.model ?? '')
}

function DwSqlOptimizeDialog({ store, tr, sql, database, onClose }) {
  const [phase, setPhase] = useState('running')
  const [result, setResult] = useState(null)
  const [error, setError] = useState('')
  const model = dwAiModel()

  useEffect(() => {
    if (model === null) {
      setPhase('error')
      setError(tr('optimizeNoModel'))
      return undefined
    }
    let alive = true
    const run = async () => {
      try {
        const value = await dwAiWithTimeout(dwRpc('optimizeSql', {
          provider: model.provider,
          model: model.model,
          sql,
          database,
          // The explanation should read like the rest of the window.
          locale: String(globalThis.document?.documentElement?.lang ?? globalThis.navigator?.language ?? ''),
        }), 130000)
        if (!alive) return
        setResult(value)
        setPhase('done')
      } catch (failure) {
        if (!alive) return
        setError(dwExplainFailure(tr, failure))
        setPhase('error')
      }
    }
    void run()
    return () => { alive = false }
  }, [])

  const body = phase === 'running'
    ? h('div', { key: 'running', className: 'dw-empty', style: { minHeight: 120 } }, [
      h(DwIcon, { key: 'i', name: 'spinner', size: 18 }),
      h('div', { key: 't', className: 'dw-empty-hint' }, tr('optimizeRunning')),
    ])
    : phase === 'error'
      ? h('div', { key: 'error', className: 'dw-error-text' }, error)
      : h('div', { key: 'done' }, [
        h('div', { key: 'm', className: 'dw-optimize-model' }, tr('optimizeModelLabel', {
          model: dwOptimizeModelName(result?.model) === '' ? tr('aiModelUnknown') : dwOptimizeModelName(result?.model),
        })),
        h('pre', { key: 'sql', className: 'dw-cell-view' }, result?.sql ?? ''),
        result?.notes === undefined || result.notes === ''
          ? null
          : h('div', { key: 'notes' }, [
            h('div', { key: 't', className: 'dw-ai-label', style: { paddingTop: 10 } }, tr('optimizeNotes')),
            h('div', { key: 'v', className: 'dw-optimize-notes' }, result.notes),
          ]),
      ])

  return h('div', {
    className: 'dw-modal',
    onClick: onClose,
  }, h('div', {
    key: 'card',
    className: 'dw-modal-card dw-optimize-dialog',
    onClick: (event) => event.stopPropagation(),
  }, [
    h('div', { key: 'title', className: 'dw-modal-title' }, [
      h(DwIcon, { key: 'i', name: 'ai', size: 13 }),
      h('span', { key: 't' }, tr('optimizeTitle')),
    ]),
    h('div', { key: 'body', className: 'dw-modal-body' }, body),
    h('div', { key: 'foot', className: 'dw-modal-foot' }, [
      phase === 'done'
        ? h('button', {
          key: 'copy',
          type: 'button',
          className: 'dw-btn',
          onClick: () => {
            const write = globalThis.navigator?.clipboard?.writeText?.(result?.sql ?? '')
            if (write !== undefined) write.then(() => store.pushLog('info', tr('log.optimizeCopied'))).catch(() => undefined)
          },
        }, tr('optimizeCopy'))
        : null,
      h('button', { key: 'close', type: 'button', className: 'dw-btn dw-btn-accent', onClick: onClose }, tr('close')),
    ]),
  ]))
}
