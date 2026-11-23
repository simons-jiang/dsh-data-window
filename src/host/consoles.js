/**
 * Saved SQL consoles.
 *
 * Requirement: the statement a user typed is their work, so leaving a workspace or
 * reopening DSH must not throw it away. The browser's local storage cannot do this
 * job: DSH serves the UI on a random localhost port, so each restart is a new
 * origin and every snapshot disappears with the old one. Keeping one file per
 * workspace next to the discovery cache makes the text survive restarts, browser
 * changes and profile resets, and gives it a path the user can inspect.
 *
 * The document holds statements only, never query results, and is written 0600
 * through a temporary file + rename so a crash cannot leave a torn snapshot.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { basename, isAbsolute, join } from 'node:path'

/** Bump when the document shape changes so old files are ignored. */
const CONSOLE_VERSION = 1

/** One workspace snapshot before it is refused rather than written. */
const MAX_BYTES = 2 * 1024 * 1024

/** More consoles than this in one workspace is a runaway client, not work. */
const MAX_TABS = 50

/** One file per workspace, named so a human can tell them apart. */
function consoleFile(directory, root) {
  const hash = createHash('sha256').update(root).digest('hex').slice(0, 16)
  const name = basename(root).replace(/[^\w.-]+/g, '_').slice(0, 40) || 'workspace'
  return join(directory, `${hash}-${name}.consoles.json`)
}

/** Keep only the fields the editor needs to rebuild a tab. */
function normalizeTabs(value) {
  const tabs = Array.isArray(value?.tabs) ? value.tabs : []
  return tabs
    .filter((tab) => tab !== null && typeof tab === 'object' && typeof tab.id === 'string' && typeof tab.dbId === 'string')
    .slice(0, MAX_TABS)
    .map((tab) => ({
      id: tab.id,
      title: String(tab.title ?? ''),
      env: String(tab.env ?? ''),
      subtitle: String(tab.subtitle ?? ''),
      dbId: tab.dbId,
      database: String(tab.database ?? ''),
      instanceLabel: String(tab.instanceLabel ?? ''),
      sql: String(tab.sql ?? ''),
    }))
}

/** Saved SQL consoles, one small JSON file per workspace. */
export class ConsoleStore {
  constructor(directory) {
    this.directory = directory
    if (this.directory !== '') {
      mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    }
  }

  /** The file one workspace's consoles live in. */
  fileFor(root) {
    return consoleFile(this.directory, root)
  }

  /** Read a snapshot; a missing or unreadable file means "no consoles yet". */
  load(root) {
    if (typeof root !== 'string' || root === '' || !isAbsolute(root)) return { tabs: [], activeTab: '' }
    try {
      const parsed = JSON.parse(readFileSync(this.fileFor(root), 'utf8'))
      if (parsed?.version !== CONSOLE_VERSION) return { tabs: [], activeTab: '' }
      const tabs = normalizeTabs(parsed)
      const activeTab = tabs.some((tab) => tab.id === parsed.activeTab) ? parsed.activeTab : (tabs[0]?.id ?? '')
      return { tabs, activeTab }
    } catch (error) {
      return { tabs: [], activeTab: '' }
    }
  }

  /** Replace a workspace's snapshot atomically. */
  save(root, value) {
    if (typeof root !== 'string' || root === '' || !isAbsolute(root)) {
      const error = new Error('workspace root must be an absolute path')
      error.code = 'invalid-root'
      throw error
    }
    const tabs = normalizeTabs(value)
    const activeTab = tabs.some((tab) => tab.id === value?.activeTab) ? value.activeTab : (tabs[0]?.id ?? '')
    const document = JSON.stringify({
      version: CONSOLE_VERSION,
      root,
      savedAt: Date.now(),
      activeTab,
      tabs,
    })
    if (Buffer.byteLength(document) > MAX_BYTES) {
      const error = new Error('console snapshot is too large')
      error.code = 'console-too-large'
      throw error
    }
    const file = this.fileFor(root)
    const temporary = `${file}.${process.pid}.tmp`
    writeFileSync(temporary, document, { mode: 0o600 })
    renameSync(temporary, file)
    return { saved: true, tabs: tabs.length }
  }

  /** Whether a workspace has a snapshot, without reading the body. */
  exists(root) {
    try {
      return statSync(this.fileFor(root)).isFile()
    } catch (error) {
      return false
    }
  }
}
