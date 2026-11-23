/**
 * dsh-data-window — Host half.
 *
 * The browser needs three things the page cannot do itself: read the workspace's
 * own configuration, open a socket to MySQL, and keep the password out of the
 * page. All three live here behind one route, `POST /dsh-data/rpc`, with one
 * action per request:
 *
 *   discover   workspace path → environments → instances → databases (+ ids)
 *   ping       one instance's identity and version
 *   databases  every schema on an instance
 *   tables     tables and views of a schema
 *   columns    one table's columns
 *   ddl        `SHOW CREATE TABLE` for one table
 *   query      one read-only statement, rows as arrays
 *
 * Every statement goes through the read-only gate in `src/host/mysql.js`, which
 * both refuses non-read verbs and opens each connection with
 * `SET SESSION TRANSACTION READ ONLY`, so the database rejects a write even if the
 * static check is ever wrong.
 */
import { mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DataController, MAX_BODY_BYTES, RouteFailure, toRouteError } from './src/host/rpc.js'

export const name = 'dsh-data-window'

/** This package's version, used to invalidate a cache an older build wrote. */
const PLUGIN_VERSION = (() => {
  try {
    const manifest = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'package.json'), 'utf8'))
    return typeof manifest.version === 'string' ? manifest.version : ''
  } catch (error) {
    void error
    return ''
  }
})()

/** The Web carrier is the only hard dependency; MySQL is loaded by the runtime. */
export const inject = ['webServer']

/** The one route this plugin serves. */
const ROUTE = '/dsh-data/rpc'

/** Where reports and the discovery cache live (`DSH_HOME` wins for test instances). */
function dshHomeDir() {
  const configured = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  return configured === '' ? join(homedir(), '.dsh') : configured
}

function writeJson(response, status, payload) {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  response.end(body)
}

/** Read one JSON body up to `limit`, refusing anything larger. */
function readJsonBody(request, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new RouteFailure(413, 'body-too-large', 'request body too large'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (text === '') {
        resolve({})
        return
      }
      try {
        const parsed = JSON.parse(text)
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          reject(new RouteFailure(400, 'invalid-body', 'body must be a JSON object'))
          return
        }
        resolve(parsed)
      } catch (error) {
        reject(new RouteFailure(400, 'invalid-json', error.message))
      }
    })
    request.on('error', (error) => reject(error))
  })
}

export function apply(ctx, config) {
  const settings = config ?? {}
  const cacheDirectory = join(dshHomeDir(), 'storages', 'dsh-data-window')
  try {
    mkdirSync(cacheDirectory, { recursive: true })
  } catch (error) {
    void error
  }

  const controller = new DataController({ config: settings, cacheDirectory, pluginVersion: PLUGIN_VERSION })

  const handler = async (request, response) => {
    try {
      // Fence the route the way the shipped browser surfaces are fenced: the
      // connection service decides whether this peer may be served at all.
      const connection = ctx.get('connection')
      if (connection !== undefined && connection.requestRejection(request) !== undefined) {
        writeJson(response, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
        return
      }
      if (request.method !== 'POST') {
        writeJson(response, 405, { ok: false, error: { code: 'method-error', message: 'method not allowed' } })
        return
      }
      const pathname = new URL(request.url ?? '/', 'http://dsh-data.internal').pathname
      if (pathname !== ROUTE && !pathname.startsWith(`${ROUTE}/`)) {
        writeJson(response, 404, { ok: false, error: { code: 'not-found', message: 'unknown route' } })
        return
      }
      const payload = await readJsonBody(request)
      const action = payload.action ?? (pathname === ROUTE ? undefined : pathname.slice(ROUTE.length + 1))
      const value = await controller.handle(action, payload)
      writeJson(response, 200, { ok: true, value })
    } catch (error) {
      const failure = toRouteError(error)
      writeJson(response, failure.status, { ok: false, error: { code: failure.code, message: failure.message } })
    }
  }

  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: ROUTE, handler }), 'dsh-data-window: rpc route')

  ctx.effect(() => () => {
    controller.close().catch(() => undefined)
  }, 'dsh-data-window: close pools')
}
