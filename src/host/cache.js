/**
 * Discovery cache.
 *
 * Requirement: opening a workspace resolves the environment hosts once, and
 * switching back to it must not re-read the same YAML trees. The cache keeps the
 * resolved payload together with the connection targets (the payload the browser
 * receives never includes a password) and a fingerprint of every file it was
 * built from, so a changed `yunwei-db.yml` or a refreshed Nacos snapshot is
 * noticed instead of served stale.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Bump when the payload shape changes so old entries are discarded. */
const CACHE_VERSION = 3

/** One file before the entry is dropped rather than grown. */
const MAX_CACHE_BYTES = 4 * 1024 * 1024

/** Signature of the files one discovery read. */
export function fingerprint(paths) {
  const parts = []
  for (const path of paths) {
    try {
      const stat = statSync(path)
      parts.push(`${path}:${stat.mtimeMs}:${stat.size}`)
    } catch (error) {
      void error
      parts.push(`${path}:-`)
    }
  }
  return parts.join('|')
}

export class DiscoveryCache {
  /**
   * @param directory where `discovery.json` lives
   * @param pluginVersion the installed package version; a new plugin generation
   *   invalidates every entry, because an id minted by the previous generation may
   *   no longer mean what the new one thinks it means
   */
  constructor(directory, pluginVersion = '') {
    this.version = pluginVersion === '' ? String(CACHE_VERSION) : `${CACHE_VERSION}:${pluginVersion}`
    this.directory = directory
    this.file = join(directory, 'discovery.json')
    this.memory = new Map()
    this.loaded = false
  }

  load() {
    if (this.loaded) return
    this.loaded = true
    try {
      const document = JSON.parse(readFileSync(this.file, 'utf8'))
      if (document?.version !== this.version) return
      for (const [root, entry] of Object.entries(document.entries ?? {})) {
        if (typeof entry?.fingerprint !== 'string') continue
        this.memory.set(root, entry)
      }
    } catch (error) {
      void error
    }
  }

  get(root) {
    this.load()
    return this.memory.get(root)
  }

  put(root, entry) {
    this.memory.set(root, { ...entry, version: this.version, at: Date.now() })
    this.flush()
  }

  delete(root) {
    this.load()
    this.memory.delete(root)
    this.flush()
  }

  clear() {
    this.memory.clear()
    this.flush()
  }

  flush() {
    try {
      mkdirSync(this.directory, { recursive: true })
      const entries = {}
      for (const [root, entry] of this.memory) entries[root] = entry
      const text = JSON.stringify({ version: this.version, entries })
      if (text.length > MAX_CACHE_BYTES) {
        this.memory.clear()
        rmSync(this.file, { force: true })
        return
      }
      // Write-then-rename: a crash mid-write must not leave a truncated cache that
      // every later start has to swallow.
      const temporary = `${this.file}.tmp`
      writeFileSync(temporary, text, { encoding: 'utf8', mode: 0o600 })
      renameSync(temporary, this.file)
    } catch (error) {
      void error
    }
  }
}
