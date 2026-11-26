/**
 * The "AI optimize" dialog for the SQL editor.
 *
 * The model is the one chosen in settings (`aiModel`); the Host calls it, and the
 * answer is shown as a suggestion. Nothing is executed or written back to the
 * editor automatically — copying is the only way out, which keeps the "never
 * overwrite user SQL" rule intact.
 */

/** SQL tokens keep whitespace, so the diff can highlight words without reformatting. */
const DW_DIFF_TOKEN = /(\s+|[A-Za-z0-9_$]+|[^\sA-Za-z0-9_$]+)/g

function dwDiffTokenize(text) {
  const tokens = []
  DW_DIFF_TOKEN.lastIndex = 0
  let match
  const source = String(text ?? '')
  while ((match = DW_DIFF_TOKEN.exec(source)) !== null) tokens.push({ value: match[1], space: /^\s+$/.test(match[1]) })
  return tokens
}

/**
 * Token-level LCS between the two statements.
 *
 * Line-based diffs are useless here: a model often returns the same query as one
 * long line, so every line would look changed. Common prefixes and suffixes are
 * trimmed first; the matrix is capped so a pathological statement cannot hang the
 * dialog (the middle is then reported as changed as a whole).
 */
function dwDiffMarks(leftTokens, rightTokens) {
  const a = leftTokens.filter((token) => !token.space)
  const b = rightTokens.filter((token) => !token.space)
  const removed = new Array(a.length).fill(false)
  const added = new Array(b.length).fill(false)
  let start = 0
  while (start < a.length && start < b.length && a[start].value === b[start].value) start += 1
  let endA = a.length - 1
  let endB = b.length - 1
  while (endA >= start && endB >= start && a[endA].value === b[endB].value) {
    endA -= 1
    endB -= 1
  }
  const n = endA - start + 1
  const m = endB - start + 1
  if (n > 0 && m > 0 && n * m <= 2000000) {
    const width = m + 1
    const dp = new Uint32Array((n + 1) * width)
    for (let i = n - 1; i >= 0; i -= 1) {
      for (let j = m - 1; j >= 0; j -= 1) {
        dp[i * width + j] = a[start + i].value === b[start + j].value
          ? dp[(i + 1) * width + j + 1] + 1
          : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1])
      }
    }
    let i = 0
    let j = 0
    while (i < n && j < m) {
      if (a[start + i].value === b[start + j].value) {
        i += 1
        j += 1
      } else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) {
        removed[start + i] = true
        i += 1
      } else {
        added[start + j] = true
        j += 1
      }
    }
    while (i < n) {
      removed[start + i] = true
      i += 1
    }
    while (j < m) {
      added[start + j] = true
      j += 1
    }
  } else {
    for (let i = start; i <= endA; i += 1) removed[i] = true
    for (let j = start; j <= endB; j += 1) added[j] = true
  }
  return { removed, added }
}

/** Render one side: changed significant tokens wrapped, whitespace left alone. */
function dwDiffNodes(tokens, marks, className) {
  const nodes = []
  let significant = 0
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token.space) {
      nodes.push(token.value)
      continue
    }
    const changed = marks[significant] === true
    significant += 1
    nodes.push(changed ? h('span', { key: index, className }, token.value) : token.value)
  }
  return nodes
}

function dwOptimizeModelName(model) {
  return String(model?.name ?? model?.model ?? '')
}

function DwSqlOptimizeDialog({ store, tr, sql, database, onClose }) {
  const [phase, setPhase] = useState('running')
  const [result, setResult] = useState(null)
  const [error, setError] = useState('')
  const model = dwAiModel()
  const leftRef = useRef(null)
  const rightRef = useRef(null)
  const originalTokens = useMemo(() => dwDiffTokenize(sql), [sql])
  const optimizedTokens = useMemo(() => dwDiffTokenize(result?.sql ?? ''), [result?.sql])
  const diffMarks = useMemo(() => dwDiffMarks(originalTokens, optimizedTokens), [originalTokens, optimizedTokens])
  const syncScroll = (from, to) => (event) => {
    const target = to.current
    if (target !== null) target.scrollTop = event.currentTarget.scrollTop
  }

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
        h('div', { key: 'diff', className: 'dw-diff' }, [
          h('div', { key: 'left', className: 'dw-diff-col' }, [
            h('div', { key: 'h', className: 'dw-diff-head' }, tr('optimizeOriginal')),
            h('pre', {
              key: 'p',
              className: 'dw-diff-pane',
              ref: leftRef,
              onScroll: syncScroll(leftRef, rightRef),
            }, dwDiffNodes(originalTokens, diffMarks.removed, 'dw-diff-del')),
          ]),
          h('div', { key: 'right', className: 'dw-diff-col' }, [
            h('div', { key: 'h', className: 'dw-diff-head' }, tr('optimizeOptimized')),
            h('pre', {
              key: 'p',
              className: 'dw-diff-pane',
              ref: rightRef,
              onScroll: syncScroll(rightRef, leftRef),
            }, dwDiffNodes(optimizedTokens, diffMarks.added, 'dw-diff-add')),
          ]),
        ]),
        result?.notes === undefined || result.notes === ''
          ? null
          : h('div', { key: 'notes' }, [
            h('div', { key: 't', className: 'dw-ai-label', style: { paddingTop: 10 } }, tr('optimizeNotes')),
            h('div', { key: 'v', className: 'dw-optimize-notes' }, result.notes),
          ]),
      ])

  return h(DwModal, {
    onClose,
    className: 'dw-optimize-dialog',
    label: tr('optimizeTitle'),
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
  ])
}
