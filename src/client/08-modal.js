/**
 * The one dialog shell.
 *
 * Every dialog in this window — the DDL viewer, the AI optimizer, a cell's full
 * value, the manual-connection forms — is built on `DwModal`, because two things a
 * dialog cannot do on its own must not be re-decided per dialog:
 *
 *  1. **Out-paint the docks.** The workbench is a containing block and a stacking
 *     context of its own, so `position: fixed` inside it still stops at the panel
 *     edge and is buried by any window another plugin docks below the editor. The
 *     card is therefore portalled to `document.body`, where it paints in the page's
 *     own stacking context and its footer buttons stay reachable. Leaving the panel
 *     also leaves the palette the panel carries (`[data-dsh-theme]` from the code
 *     workspace), so the sheet re-applies that attribute on itself — otherwise a
 *     theming plugin's dialog is the one white card in a coloured window.
 *  2. **Close on Escape.** One window-level listener, in the capture phase, closes
 *     only the dialog on top of the stack, so a dialog opened from another one
 *     unwinds one level at a time; an IME candidate window keeps its own Escape,
 *     and a dialog that is mid-save refuses to close at all.
 */

/** Dialog ids in opening order; only the last one answers Escape. */
const dwModalStack = []

/**
 * Render a node in the page body instead of inside the panel.
 *
 * Falls back to in-place rendering when the page offers no portal (an embedded
 * host, or a probe running the fragments outside a browser).
 */
function dwPortal(node) {
  try {
    const reactDom = require('react-dom')
    if (typeof reactDom?.createPortal !== 'function') return node
    if (typeof document === 'undefined' || document.body === null) return node
    return reactDom.createPortal(node, document.body)
  } catch (error) {
    void error
    return node
  }
}

/**
 * A dialog card over a dimmed page.
 *
 * @param {object} props
 * @param {() => void} props.onClose called by Escape, the backdrop, or a footer button.
 * @param {boolean} [props.busy] while true, Escape and the backdrop do nothing.
 * @param {string} [props.className] extra class on the card, such as `dw-ddl-dialog`.
 * @param {string} [props.label] accessible name of the dialog.
 */
function DwModal({ onClose, busy = false, className = undefined, label = undefined, children }) {
  // The palette comes from the code workspace (05-theme.js); the sheet lives
  // outside the panel, so it has to carry the same attribute itself.
  const themeId = useSyncExternalStore(dwSubscribeTheme, dwSharedTheme, dwSharedTheme)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const busyRef = useRef(busy)
  busyRef.current = busy

  useEffect(() => {
    const token = {}
    dwModalStack.push(token)
    const onKey = (event) => {
      if (event.key !== 'Escape') return
      // A dialog that opened another one must not close together with it.
      if (dwModalStack[dwModalStack.length - 1] !== token) return
      if (busyRef.current === true) return
      // The Escape that dismisses an IME candidate list belongs to the IME.
      if (dwImeComposing(event)) return
      event.preventDefault()
      event.stopPropagation()
      if (typeof closeRef.current === 'function') closeRef.current()
    }
    globalThis.addEventListener('keydown', onKey, true)
    return () => {
      globalThis.removeEventListener('keydown', onKey, true)
      const index = dwModalStack.indexOf(token)
      if (index >= 0) dwModalStack.splice(index, 1)
    }
  }, [])

  const cardClass = className === undefined ? 'dw-modal-card' : `dw-modal-card ${className}`
  const card = h('div', {
    key: 'card',
    className: cardClass,
    role: 'dialog',
    'aria-modal': 'true',
    ...(label === undefined ? {} : { 'aria-label': label }),
    onClick: (event) => event.stopPropagation(),
  }, children)

  const sheet = h('div', {
    className: 'dw-modal',
    'data-dsh-theme': themeId === '' ? undefined : themeId,
    onClick: (event) => {
      // Only the backdrop closes: a click that bubbled out of the card is stopped
      // above, and a save in flight owns the dialog until it settles.
      if (event.target !== event.currentTarget) return
      if (busy === true) return
      if (typeof onClose === 'function') onClose()
    },
  }, card)

  return dwPortal(sheet)
}

export { DwModal, dwPortal }
