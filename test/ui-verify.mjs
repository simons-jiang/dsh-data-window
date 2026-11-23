/**
 * UI verification of the plugin through real mouse/keyboard input.
 *
 * Unlike a scripted `dispatchEvent`, this drives CDP `Input.*`, so what is exercised
 * is the same event path a user produces: hover, press, release, keydown.
 *
 * Usage: node ui-verify.mjs <tokenUrl> <workspacePath> <outDir>
 *
 * `DW_VERIFY_TABLE` selects the table the run step queries; it defaults to
 * `information_schema.tables`, which exists on every server.
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { spawn } from 'node:child_process'

const [tokenUrl, workspacePath, outDir] = process.argv.slice(2)
const PORT = 9334
const ORIGIN = new URL(tokenUrl).origin
mkdirSync(outDir, { recursive: true })

const child = spawn('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', [
  '--headless=new', `--remote-debugging-port=${PORT}`, '--user-data-dir=/tmp/dw-edge-2',
  '--no-first-run', '--no-default-browser-check', '--disable-gpu',
  '--window-size=1680,1050', '--hide-scrollbars', tokenUrl,
], { stdio: 'ignore' })
process.on('exit', () => { try { child.kill('SIGKILL') } catch { /* ignore */ } })

let nextId = 0
const pending = new Map()
let socket

function send(method, params = {}) {
  const id = (nextId += 1)
  socket.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    setTimeout(() => { if (pending.delete(id)) reject(new Error(`${method} timed out`)) }, 30000)
  })
}

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails !== undefined) throw new Error(`eval: ${result.exceptionDetails.text}`)
  return result.result?.value
}

async function shot(name) {
  const { data } = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(`${outDir}/${name}.png`, Buffer.from(data, 'base64'))
  console.log(`  shot ${name}.png`)
}

async function waitFor(expression, label, timeoutMs = 25000) {
  const started = Date.now()
  for (;;) {
    if ((await evaluate(expression).catch(() => false)) === true) return true
    if (Date.now() - started > timeoutMs) throw new Error(`timeout: ${label}`)
    await sleep(200)
  }
}

/** Real click at the centre of one element. */
async function click(selector, index = 0) {
  const box = await evaluate(`(() => {
    const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})]
    const node = nodes[${index}]
    if (node === undefined) return null
    const rect = node.getBoundingClientRect()
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }
  })()`)
  if (box === null) return false
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 })
  }
  return true
}

async function type(text) {
  await send('Input.insertText', { text })
}

async function key(keyName, code, modifiers = 0, windowsVirtualKeyCode = 0) {
  for (const type of ['keyDown', 'keyUp']) {
    await send('Input.dispatchKeyEvent', { type, key: keyName, code, modifiers, windowsVirtualKeyCode, nativeVirtualKeyCode: windowsVirtualKeyCode })
  }
}

async function text() {
  return await evaluate('document.body.innerText')
}

const targets = await (async () => {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const list = await response.json()
      const page = list.find((target) => target.type === 'page' && target.webSocketDebuggerUrl)
      if (page !== undefined) return page
    } catch { /* not up */ }
    await sleep(250)
  }
  throw new Error('devtools never came up')
})()

socket = new WebSocket(targets.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve)
  socket.addEventListener('error', reject)
})
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  if (message.id === undefined) return
  const entry = pending.get(message.id)
  if (entry === undefined) return
  pending.delete(message.id)
  if (message.error !== undefined) entry.reject(new Error(message.error.message))
  else entry.resolve(message.result)
})

await send('Page.enable')
await send('Runtime.enable')
await send('Log.enable')
const consoleErrors = []
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') {
    consoleErrors.push(message.params.entry.text.slice(0, 200))
  }
  if (message.method === 'Runtime.exceptionThrown') {
    consoleErrors.push(String(message.params.exceptionDetails.text).slice(0, 200))
  }
})

await send('Page.navigate', { url: `${ORIGIN}/` })
await waitFor('document.querySelector("[data-shell-overlay]") !== null', 'shell')
await sleep(2500)
await evaluate(`localStorage.setItem('dsh-data-window:root', ${JSON.stringify(workspacePath)})`)
await send('Page.navigate', { url: `${ORIGIN}/` })
await waitFor('document.querySelector("[data-shell-overlay]") !== null', 'shell 2')
await sleep(3000)

console.log('open panel:', await click('[aria-label="打开数据窗口"]'))
await sleep(2500)
await shot('01-panel')

// The default environment is expanded on load; only click it when it is not.
const instanceCount = await evaluate('document.querySelectorAll(".dw-node-instance").length')
if (instanceCount === 0) {
  console.log('expand env:', await click('.dw-node-env'))
  await sleep(1200)
}
writeFileSync(`${outDir}/02-text.txt`, await text(), 'utf8')
await shot('02-env')

// Expand the first instance to reveal its databases.
if ((await evaluate('document.querySelectorAll(".dw-node-database").length')) === 0) {
  console.log('expand instance:', await click('.dw-node-instance'))
  await sleep(1500)
}
console.log('databases visible:', await evaluate('document.querySelectorAll(".dw-node-database").length'))
await shot('03-instance')

console.log('open database:', await click('.dw-node-database'))
await sleep(2500)
console.log('tables visible:', await evaluate('document.querySelectorAll(".dw-node-table").length'))
await shot('04-workbench')
writeFileSync(`${outDir}/04-text.txt`, await text(), 'utf8')

// Type a statement and run it with the real keyboard shortcut.
// `DW_VERIFY_TABLE` overrides the probe table; the default exists on every server.
const probeTable = process.env.DW_VERIFY_TABLE ?? 'information_schema.tables'
await click('.dw-code')
await sleep(300)
await type(`SELECT * FROM ${probeTable} LIMIT 5`)
await sleep(500)
await key('Enter', 'Enter', 4, 13)
await sleep(3500)
await shot('05-result')
writeFileSync(`${outDir}/05-text.txt`, await text(), 'utf8')
console.log('result cells present:', await evaluate('document.querySelectorAll(".dw-grid td").length'))

// F4 on a selected table.
await click('.dw-node-table')
await sleep(800)
await key('F4', 'F4', 0, 115)
await sleep(3000)
await shot('06-ddl')
writeFileSync(`${outDir}/06-text.txt`, await text(), 'utf8')
console.log('ddl visible:', await evaluate('document.body.innerText.includes("CREATE TABLE")'))

console.log('console errors:', consoleErrors.length === 0 ? 'none' : consoleErrors)
try { child.kill('SIGKILL') } catch { /* ignore */ }
process.exit(0)
