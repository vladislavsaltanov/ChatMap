// Одноразовый дебаг через CDP: снимает консоль + состояние страницы.
// Запуск: node tools/debug-headless.mjs
import { spawn } from 'node:child_process'

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const URL = 'http://127.0.0.1:5174/?fixture=1'
const PORT = 9333
const SETTLE_MS = 9000
const USER_DATA_DIR = process.env.TEMP + '\\chatmap-chrome-profile-' + Date.now()

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--use-angle=swiftshader-webgl',
    '--no-sandbox',
    `--remote-debugging-port=${PORT}`,
    '--remote-allow-origins=*',
    '--enable-logging=stderr',
    '--v=0',
    `--user-data-dir=${USER_DATA_DIR}`,
    '--no-first-run',
    URL,
  ],
  { stdio: ['ignore', 'pipe', 'pipe'] },
)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function getTarget() {
  for (let attempt = 0; attempt < 50; attempt++) {
    await sleep(200)
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const targets = await res.json()
      const page = targets.find((t) => t.type === 'page' && t.url.includes('127.0.0.1:'))
      if (page) return page
    } catch {
      /* chrome still starting */
    }
  }
  throw new Error('chrome did not expose targets')
}

try {
  const page = await getTarget()
  console.log('target:', page.url)

  const ws = new WebSocket(page.webSocketDebuggerUrl)
  let id = 0
  const pend = new Map()
  const messages = []
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const i = ++id
      pend.set(i, { resolve, reject })
      ws.send(JSON.stringify({ id: i, method, params }))
    })

  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data)
    if (msg.id && pend.has(msg.id)) {
      const p = pend.get(msg.id)
      pend.delete(msg.id)
      if (msg.error) p.reject(new Error(JSON.stringify(msg.error)))
      else p.resolve(msg.result)
      return
    }
    if (msg.method === 'Runtime.consoleAPICalled') {
      const text = (msg.params.args || [])
        .map((a) => a.value ?? a.description ?? JSON.stringify(a))
        .join(' ')
      messages.push({ type: `console.${msg.params.type}`, text })
    } else if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails
      messages.push({
        type: 'exception',
        text: `${d.text}: ${d.exception?.description ?? d.exception?.value ?? ''}`,
      })
    }
  })

  await new Promise((r) => ws.addEventListener('open', r, { once: true }))
  await send('Runtime.enable')
  await send('Page.enable')
  await sleep(SETTLE_MS)

  const evalJs = async (expression) =>
    (await send('Runtime.evaluate', { expression, returnByValue: true })).result.value

  const state = await evalJs(`(() => {
    const sq = (s) => document.querySelector(s)
    const out = {
      screens: {},
      hoverLine: sq('.hover-line')?.textContent ?? null,
      progressHidden: sq('.map-progress')?.hidden ?? null,
      canvases: document.querySelectorAll('canvas').length,
      errorOpen: sq('#error')?.open ?? null,
      errorText: sq('#error-text')?.textContent ?? null,
      legends: [...document.querySelectorAll('#authors-colors .num')].map((e) => e.textContent),
      warnBanner: sq('#warn-banner')?.hidden === false ? sq('#warn-banner').textContent : null,
      mapview: !!window.__mapview,
    }
    for (const id of ['landing', 'progress', 'map']) out.screens[id] = sq('#' + id)?.hidden
    if (window.__mapview) {
      try { out.graphOrder = window.__mapview.graph?.order } catch (e) { out.graphOrder = 'ERR ' + e.message }
      try { out.renderer = !!window.__mapview.renderer } catch (e) { out.renderer = 'ERR ' + e.message }
    }
    return out
  })()`)

  console.log(JSON.stringify(state, null, 2))
  console.log('--- messages:', messages.length)
  for (const m of messages) console.log(`[${m.type}]`, m.text.slice(0, 300))

  ws.close()
} catch (err) {
  console.error('debug-headless failed:', err)
  process.exitCode = 1
} finally {
  chrome.kill()
}
