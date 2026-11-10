// Одноразовый e2e: (a) скриншот fixture-карты, (b) реальный экспорт через file-input.
// Локально, ничего по сети. Запуск: node tools/e2e-headless.mjs [skip|fixture|real]
import { spawn } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
// Путь к реальному экспорту только через env: абсолютные пути к Downloads
// не должны попадать даже в локальные файлы (а тем более в коммиты).
// Без env кейс (b) пропускается, fixture-кейс работает как раньше.
const REAL_JSON = process.env.CHATMAP_REAL_JSON ?? ''
const ROOT = path.resolve('.')
const OUT_DIR = path.join(ROOT, 'tests', 'betterwright')
const PORT = 9333
const BASE = 'http://127.0.0.1:5174'
const mode = process.argv[2] ?? 'both'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function launchChrome() {
  const profile = path.join(process.env.TEMP ?? '.', `chatmap-e2e-${Date.now()}`)
  const proc = spawn(
    CHROME,
    [
      '--headless=new',
      '--disable-gpu',
      '--use-angle=swiftshader-webgl',
      '--no-sandbox',
      `--remote-debugging-port=${PORT}`,
      '--remote-allow-origins=*',
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--window-size=1400,900',
      `${BASE}/?fixture=1`,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  return proc
}

async function getPage(chromeProc, waitMs = 20000) {
  const deadline = Date.now() + waitMs
  for (;;) {
    if (Date.now() > deadline) throw new Error('chrome did not expose targets')
    await sleep(250)
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const targets = await res.json()
      const page = targets.find((t) => t.type === 'page' && t.url.includes('127.0.0.1:5174'))
      if (page) return page
    } catch {}
  }
}

async function withCdp(page) {
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  let id = 0
  const pending = new Map()
  const messages = []
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const i = ++id
      pending.set(i, { resolve, reject })
      ws.send(JSON.stringify({ id: i, method, params }))
    }).catch((err) => {
      console.log('CDP FAIL', method, JSON.stringify(params).slice(0, 200), '→', err.message.slice(0, 200))
      throw err
    })
  await new Promise((r) => ws.addEventListener('open', r, { once: true }))
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data)
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id)
      pending.delete(msg.id)
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
  return { send, messages, close: () => ws.close() }
}

const evalJs = (cdp, expression) =>
  cdp.send('Runtime.evaluate', { expression, returnByValue: true }).then((r) => r.result.value)

async function waitFor(cdp, predicate, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await evalJs(cdp, predicate).catch(() => false)
    if (value) return true
    if (Date.now() > deadline) return false
    await sleep(500)
  }
}

async function screenshot(cdp, name) {
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
  await writeFile(path.join(OUT_DIR, name), Buffer.from(shot.data, 'base64'))
}

async function stateOf(cdp) {
  return evalJs(
    cdp,
    `(() => {
      const sq = (s) => document.querySelector(s)
      const out = {
        screens: {},
        hoverLine: sq('.hover-line')?.textContent ?? null,
        canvases: document.querySelectorAll('canvas').length,
        errorOpen: sq('#error')?.open ?? null,
        errorText: sq('#error-text')?.textContent ?? null,
        legends: [...document.querySelectorAll('#authors-colors .num')].map((e) => e.textContent),
        mapview: !!window.__mapview,
        graphOrder: window.__mapview ? window.__mapview.graph?.order : null,
        renderer: window.__mapview ? !!window.__mapview.renderer : null,
      }
      for (const id of ['landing', 'progress', 'map']) out.screens[id] = sq('#' + id)?.hidden
      return out
    })()`,
  )
}

async function main() {
  const chromeProc = launchChrome()
  try {
    const page = await getPage(chromeProc)
    console.log('page:', page.url)
    const cdp = await withCdp(page)
    await cdp.send('Runtime.enable')
    await cdp.send('Page.enable')
    await cdp.send('DOM.enable')

    // (a) fixture screenshot
    await waitFor(cdp, 'window.__mapview && window.__mapview.graph?.order > 0', 30000)
    const fixtureState = await stateOf(cdp)
    console.log('fixture state:', JSON.stringify(fixtureState))
    await sleep(1500)
    await screenshot(cdp, 'fixture-map.png')

    if (mode !== 'fixture' && !REAL_JSON) {
      console.log('real-кейс пропущен: CHATMAP_REAL_JSON не задан')
    }

    if (mode !== 'fixture' && REAL_JSON) {
      // (b) реальный экспорт: reload, setFileInputFiles, ждём карты
      await cdp.send('Page.navigate', { url: `${BASE}/` })
      await waitFor(cdp, `document.querySelector('#file-input') !== null`, 15000)
      const doc = await cdp.send('DOM.getDocument')
      console.log('getDocument:', JSON.stringify(doc).slice(0, 400))
      const qs = await cdp.send('DOM.querySelector', { nodeId: doc?.root?.nodeId ?? 1, selector: 'input#file-input' })
      console.log('querySelector:', JSON.stringify(qs).slice(0, 200))
      await cdp.send('DOM.setFileInputFiles', { files: [REAL_JSON], nodeId: qs?.nodeId ?? 0 })
      const ready = await waitFor(cdp, 'window.__mapview && window.__mapview.graph?.order > 0', 180000)
      console.log('real file ready:', ready)
      if (ready) {
        const geom = await evalJs(
          cdp,
          `(() => {
            const g = window.__mapview.graph
            const pts = g.nodes().map((k) => g.getNodeAttributes(k))
            let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
            for (const p of pts) { if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x; if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y }
            const cam = window.__mapview.renderer?.getCamera?.().getState?.()
            const sampler = pts.slice(0, 3).map((p) => ({ x: +p.x.toFixed(1), y: +p.y.toFixed(1), size: p.size }))
            const q = (arr, t) => { const s = [...arr].sort((a, b) => a - b); return +s[Math.min(s.length - 1, Math.floor(s.length * t))].toFixed(1) }
            const qs = {
              x: [0.01, 0.05, 0.5, 0.95, 0.99].map((t) => q(pts.map((p) => p.x), t)),
              y: [0.01, 0.05, 0.5, 0.95, 0.99].map((t) => q(pts.map((p) => p.y), t)),
            }
            let iso = 0
            for (const k of g.nodes()) if (g.degree(k) === 0) iso++
            let cx = 0, cy = 0
            for (const p of pts) { cx += p.x; cy += p.y }
            cx /= pts.length; cy /= pts.length
            const rs = pts.map((p) => Math.hypot(p.x - cx, p.y - cy)).sort((a, b) => a - b)
            const rq = (t) => +rs[Math.min(rs.length - 1, Math.floor(rs.length * t))].toFixed(1)
            const rqts = [0.5, 0.9, 0.95, 0.99].map((t) => rq(t))
            const far = pts.map((p, i) => ({ r: +Math.hypot(p.x - cx, p.y - cy).toFixed(0), d: g.degree(g.nodes()[i]) })).sort((a, b) => b.r - a.r).slice(0, 6)
            return JSON.stringify({ bbox: [minX.toFixed(1), maxX.toFixed(1), minY.toFixed(1), maxY.toFixed(1)], qs, rqts, far, iso, cam, first: sampler })
          })()`,
        )
        console.log('geom:', geom)
      }
      const realState = await stateOf(cdp)
      console.log('real state:', JSON.stringify(realState))
      await sleep(1500)
      if (ready) await screenshot(cdp, 'after-import.png')
    }

    console.log('--- console messages:', cdp.messages.length)
    for (const m of cdp.messages) console.log(`[${m.type}]`, m.text.slice(0, 300))
    cdp.close()
  } finally {
    chromeProc.kill()
  }
}

main().catch((err) => {
  console.error('e2e failed:', err)
  process.exitCode = 1
})
