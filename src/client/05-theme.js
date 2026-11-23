/**
 * Follow the palette chosen in `dsh-ide-window`.
 *
 * The code workspace owns the theme choice; this plugin only reads the same
 * three strings `dsh-git-window` already follows:
 *
 * - `localStorage['dsh-theme']` — current id, absent/empty means "follow DSH";
 * - a `dsh-theme` window event with `{ id }` — same document, live updates;
 * - `<link id="dsh-theme-link">` to `/dsh-ide/theme?id=<id>` — the stylesheet
 *   scopes its alias tokens to `[data-dsh-theme="<id>"]`, so the panel only
 *   needs that attribute on its own root and the palette cascades in.
 *
 * Nothing here writes the key: the code workspace owns the choice. Without it the
 * stylesheet request 404s, the attribute matches nothing and the panel keeps the
 * host palette.
 */

const DW_THEME_KEY = 'dsh-theme'
const DW_THEME_EVENT = 'dsh-theme'
const DW_THEME_LINK_ID = 'dsh-theme-link'

/** Listeners for `useSyncExternalStore`; notified after every change. */
const dwThemeListeners = new Set()

function dwReadSharedTheme() {
  try {
    const value = globalThis.localStorage?.getItem(DW_THEME_KEY)
    return typeof value === 'string' && value !== '' ? value : ''
  } catch (error) {
    return ''
  }
}

let dwThemeId = dwReadSharedTheme()

/** The palette id this panel should wear; empty means "follow DSH". */
function dwSharedTheme() {
  return dwThemeId
}

function dwSubscribeTheme(listener) {
  dwThemeListeners.add(listener)
  return () => dwThemeListeners.delete(listener)
}

/** Point the stylesheet at `id`; a missing code workspace just 404s. */
function dwSyncThemeLink(id) {
  const doc = globalThis.document
  if (doc === undefined || typeof doc.createElement !== 'function') return
  const existing = typeof doc.getElementById === 'function' ? doc.getElementById(DW_THEME_LINK_ID) : null
  if (id === '') {
    if (typeof existing?.remove === 'function') existing.remove()
    return
  }
  const href = `/dsh-ide/theme?id=${encodeURIComponent(id)}`
  if (existing === null || existing === undefined) {
    if (doc.head === undefined || typeof doc.head.append !== 'function') return
    const link = doc.createElement('link')
    link.id = DW_THEME_LINK_ID
    link.rel = 'stylesheet'
    link.href = href
    if (typeof link.addEventListener === 'function') {
      link.addEventListener('error', () => link.remove(), { once: true })
    }
    doc.head.append(link)
    return
  }
  if (typeof existing.getAttribute === 'function' && existing.getAttribute('href') !== href) {
    existing.setAttribute('href', href)
  }
}

function dwApplyTheme(id) {
  const next = typeof id === 'string' ? id : ''
  if (next === dwThemeId) return
  dwThemeId = next
  dwSyncThemeLink(next)
  for (const listener of dwThemeListeners) {
    try {
      listener()
    } catch (error) {
      void error
    }
  }
}

let dwThemeWatched = false

/** Start following the code workspace's palette; safe to call on every mount. */
function dwWatchTheme() {
  if (dwThemeWatched === true) return
  const bus = globalThis.window ?? globalThis
  if (bus === undefined || typeof bus.addEventListener !== 'function') return
  dwThemeWatched = true
  dwSyncThemeLink(dwThemeId)
  bus.addEventListener(DW_THEME_EVENT, (event) => dwApplyTheme(event?.detail?.id))
  // Another window/tab switching the theme only shows up as a storage event.
  bus.addEventListener('storage', (event) => {
    if (event.key !== DW_THEME_KEY) return
    dwApplyTheme(typeof event.newValue === 'string' ? event.newValue : '')
  })
}

/** The attribute the palette stylesheet matches; `undefined` for "follow DSH". */
function dwThemeAttribute() {
  return dwThemeId === '' ? undefined : dwThemeId
}
