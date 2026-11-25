/**
 * Discovery cache.
 *
 * Requirement: opening a workspace resolves the environment hosts once, and
 * switching back to it must not re-read the same YAML trees. Each workspace keeps
 * its own file: the resolved payload (no password) plus the connection targets
 * (password included, mode `0600`) and a fingerprint of every file it was built
 * from, so a changed data-id or a refreshed Nacos snapshot is noticed instead of
 * served stale.
 *
 * One file per workspace is deliberate. A single document shared by every project
 * would put all of their credentials in one place, let one corrupt file take the
 * others down with it, and make "forget this project" impossible without touching
 * the rest.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

/** Bump when the payload shape changes so old entries are discarded. */
const CACHE_VERSION = 7

/** One workspace file before its entry is dropped rather than grown. */
const MAX_ENTRY_BYTES = 4 * 1024 * 1024

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
   * @param directory the plugin's storage directory; each workspace gets a file
   *   under its `workspaces/` child
   * @param pluginVersion the installed package version; a new plugin generation
   *   invalidates every entry, because an id minted by the previous generation may
   *   no longer mean what the new one thinks it means
   */
  constructor(directory, pluginVersion = '') {
    this.version = pluginVersion === '' ? String(CACHE_VERSION) : `${CACHE_VERSION}:${pluginVersion}`
    this.directory = join(directory, 'workspaces')
    this.legacyFile = join(directory, 'discovery.json')
    this.dropLegacy()
  }

  /**
   * The previous layout kept every workspace, credentials included, in one
   * `discovery.json`. It is a cache, so removing it costs one re-discovery.
   */
  dropLegacy() {
    try {
      rmSync(this.legacyFile, { force: true })
    } catch (error) {
      void error
    }
  }

  /** `<hash>-<directory name>.json`: stable per root, readable, never shared. */
  fileFor(root) {
    const hash = createHash('sha1').update(root).digest('hex').slice(0, 16)
    const name = basename(root).replace(/[^\w.-]+/g, '_').slice(0, 48)
    return join(this.directory, `${hash}-${name === '' ? 'workspace' : name}.json`)
  }

  get(root) {
    if (typeof root !== 'string' || root === '') return undefined
    try {
      const document = JSON.parse(readFileSync(this.fileFor(root), 'utf8'))
      if (document?.version !== this.version) return undefined
      if (document?.root !== root) return undefined
      if (typeof document?.fingerprint !== 'string') return undefined
      return document
    } catch (error) {
      void error
      return undefined
    }
  }

  /**
   * Every valid cache document this plugin wrote.
   *
   * The shared tree is the union of what each workspace found, so a workspace switch
   * no longer has to forget the other projects' instances.
   */
  list() {
    const documents = []
    let names = []
    try {
      names = readdirSync(this.directory)
    } catch (error) {
      void error
      return documents
    }
    for (const name of names) {
      if (!name.endsWith('.json') || name.endsWith('.consoles.json')) continue
      try {
        const document = JSON.parse(readFileSync(join(this.directory, name), 'utf8'))
        if (document?.version !== this.version) continue
        if (typeof document?.root !== 'string' || document.root === '') continue
        if (document?.payload === undefined || !Array.isArray(document.payload?.environments)) continue
        documents.push(document)
      } catch (error) {
        void error
      }
    }
    return documents
  }

  put(root, entry) {
    if (typeof root !== 'string' || root === '') return
    try {
      mkdirSync(this.directory, { recursive: true, mode: 0o700 })
      const file = this.fileFor(root)
      const text = JSON.stringify({ version: this.version, root, at: Date.now(), ...entry })
      if (text.length > MAX_ENTRY_BYTES) {
        rmSync(file, { force: true })
        return
      }
      // Write-then-rename: a crash mid-write must not leave a truncated cache that
      // the next start has to swallow.
      const temporary = `${file}.tmp`
      writeFileSync(temporary, text, { encoding: 'utf8', mode: 0o600 })
      renameSync(temporary, file)
    } catch (error) {
      void error
    }
  }

  delete(root) {
    try {
      rmSync(this.fileFor(root), { force: true })
    } catch (error) {
      void error
    }
  }

  clear() {
    try {
      for (const entry of readdirSync(this.directory)) {
        if (!entry.endsWith('.json')) continue
        rmSync(join(this.directory, entry), { force: true })
      }
    } catch (error) {
      void error
    }
  }
}
