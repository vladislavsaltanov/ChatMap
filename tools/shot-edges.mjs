// Визуальная верификация рёбер: скриншоты на нескольких уровнях зума + замеры.
// Запуск: node tools/shot-edges.mjs <tag> [dense|real|check]
//   dense — синтетический плотный чат (генерируется локально, в репозиторий не пишется)
//   real  — локальный экспорт пользователя (данные не покидают машину)
//   check / checkreal / checkdense — подписи, рёбра, эго-сеть, снимок узла
//   focus / focusreal — дамп labelVisibility/shown у активных и остальных нод
//   photocam / photocamreal — снимок при двух разных состояниях камеры
import { spawn } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import path from 'node:path'

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const BASE = 'http://127.0.0.1:5173'
const OUT_DIR = path.resolve('tests', 'betterwright')
const PORT = 9344
const TAG = process.argv[2] ?? 'edges'
const MODE = process.argv[3] ?? ''
const DENSE = MODE === 'dense' || MODE === 'checkdense'
const REAL = MODE === 'real' || MODE === 'checkreal' || MODE === 'focusreal' || MODE === 'photocamreal' || MODE === 'autobtnreal'
const CHECK = MODE === 'check' || MODE === 'checkreal' || MODE === 'checkdense'
const FOCUS = MODE === 'focus' || MODE === 'focusreal'
const PHOTOCAM = MODE === 'photocam' || MODE === 'photocamreal'
const AUTOBTN = MODE === 'autobtn' || MODE === 'autobtnreal'
// Real exports are user data: never hardcode a home path, take it from env.
const REAL_JSON = process.env.CHATMAP_REAL_JSON ?? ''

// Fail before spawning Chrome: a real-mode run without a path would only
// spin up a headless browser for nothing.
if (REAL && !REAL_JSON) {
  console.error('CHATMAP_REAL_JSON не задан')
  process.exit(1)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--use-angle=swiftshader-webgl',
    '--no-sandbox',
    `--remote-debugging-port=${PORT}`,
    '--remote-allow-origins=*',
    `--user-data-dir=${path.join(process.env.TEMP ?? '.', `chatmap-edges-${Date.now()}`)}`,
    '--no-first-run',
    '--window-size=1400,900',
    `${BASE}/${DENSE || REAL ? '' : '?fixture=1'}`,
  ],
  { stdio: 'ignore' },
)

function denseJson(filePath) {
  let seed = 20261107
  const rnd = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return seed / 4294967296
  }
  const syl = ['ма', 'ре', 'ки', 'то', 'лу', 'на', 'ве', 'зи', 'дор', 'ша', 'кор', 'ти', 'му', 'ба', 'сен', 'лар', 'по', 'чер', 'вы', 'гра']
  const words = new Set()
  while (words.size < 270) {
    words.add(syl[Math.floor(rnd() * syl.length)] + syl[Math.floor(rnd() * syl.length)] + syl[Math.floor(rnd() * syl.length)])
  }
  const vocab = [...words]
  const hubs = ['главное', 'каждый', 'день', 'просто', 'очень']
  const perTopic = 30
  const topics = 9
  const messages = []
  for (let m = 0; m < 2400; m++) {
    const t = Math.floor(rnd() * topics)
    const pool = vocab.slice(t * perTopic, (t + 1) * perTopic)
    const chosen = new Set()
    const n = 3 + Math.floor(rnd() * 4)
    for (let k = 0; k < n; k++) chosen.add(pool[Math.floor(Math.pow(rnd(), 1.8) * pool.length)])
    if (rnd() < 0.35) chosen.add(hubs[Math.floor(rnd() * hubs.length)])
    if (rnd() < 0.12) chosen.add(vocab[Math.floor(rnd() * vocab.length)])
    const who = m % 3
    messages.push({
      id: 1000 + m,
      type: 'message',
      date: 1761900000 + m * 60,
      from: ['Аня', 'Борис', 'Гость'][who],
      from_id: [111, 222, 333][who],
      text: [...chosen].join(' '),
    })
  }
  writeFileSync(filePath, JSON.stringify({ name: 'Синтетика плотная', type: 'personal_chat', id: 900002, messages }))
}

async function getPage() {
  for (let i = 0; i < 80; i++) {
    await sleep(250)
    try {
      const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const page = targets.find((t) => t.type === 'page' && t.url.includes('127.0.0.1:5173'))
      if (page) return page
    } catch {}
  }
  throw new Error('chrome did not expose targets')
}

function connect(page) {
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  let id = 0
  const pend = new Map()
  const errors = []
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const i = ++id
      pend.set(i, { resolve, reject })
      ws.send(JSON.stringify({ id: i, method, params }))
    })
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pend.has(m.id)) {
      const p = pend.get(m.id)
      pend.delete(m.id)
      if (m.error) p.reject(new Error(JSON.stringify(m.error)))
      else p.resolve(m.result)
      return
    }
    if (m.method === 'Runtime.exceptionThrown') {
      errors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text)
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      errors.push(m.params.args.map((a) => a.value ?? a.description).join(' '))
    }
  })
  return new Promise((resolve) =>
    ws.addEventListener('open', () => resolve({ send, errors, close: () => ws.close() }), { once: true }),
  )
}

const evalJs = (cdp, expression) =>
  cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }).then((r) => r.result.value)

async function shot(cdp, name) {
  const s = await cdp.send('Page.captureScreenshot', { format: 'png' })
  await writeFile(path.join(OUT_DIR, `${TAG}-${name}.png`), Buffer.from(s.data, 'base64'))
}

const measure = `(() => {
  const mv = window.__mapview, r = mv?.renderer, g = mv?.graph
  if (!r || !g) return 'no renderer'
  const edges = g.edges().map((k) => {
    const d = r.getEdgeDisplayData(k), at = g.getEdgeAttributes(k)
    return { w: at.weight, s: +at.strength?.toFixed(3), size: +at.size?.toFixed(2),
             o: +d?.opacity?.toFixed(3), bundle: +at.bundle?.toFixed(2),
             ds: +(d?.strength ?? -1), db: +(d?.bundle ?? -1) }
  })
  const q = (a, t) => a.length ? +a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * t))].toFixed(3) : 0
  const nodeSizes = g.nodes().map(k => +(r.getNodeDisplayData(k)?.size ?? 0).toFixed(2))
  return { ratio: +r.getCamera().getState().ratio.toFixed(2), order: g.order, size: g.size,
           visibleEdges: edges.filter(e => e.o > 0.05).length,
           nodeSize: [q(nodeSizes, 0), q(nodeSizes, 0.5), q(nodeSizes, 1)],
           strength: [q(edges.map(e => e.s), 0), q(edges.map(e => e.s), 0.5), q(edges.map(e => e.s), 1)],
           opacity: [q(edges.map(e => e.o), 0), q(edges.map(e => e.o), 0.5), q(edges.map(e => e.o), 1)],
           bundle: [q(edges.map(e => e.bundle), 0), q(edges.map(e => e.bundle), 0.5), q(edges.map(e => e.bundle), 1)],
           bundled: edges.filter(e => e.bundle > 0).length,
           bend: [0.1, 0.5, 0.9, 1].map(t => q(g.edges().map(k => { const t = g.getEdgeAttributes(k).tract; return t ? Math.abs(t[1]) + Math.abs(t[3]) : 0 }), t)),
           resolved: edges.slice(0, 3).map(e => ({ ds: e.ds, db: e.db })),
           topOpacity: edges.filter(e => e.s > 0.9).map(e => e.o).slice(0, 3) }
})()`

// П.1/2/3/5: замеры подписей, рёбер, эго-сети и снимка выделенной ноды.
const legibilityMeasure = `(() => {
  const mv = window.__mapview, r = mv?.renderer, g = mv?.graph
  if (!r || !g) return null
  const ratio = r.getCamera().getState().ratio
  const zlf = r.getPrimitives()?.nodes?.label?.zoomToLabelSizeRatioFunction ?? (() => 1)
  const shown = r.getNodeDisplayedLabels ? [...r.getNodeDisplayedLabels()] : []
  const fonts = shown.map(k => (r.getNodeDisplayData(k)?.labelSize ?? 0) / zlf(ratio))
  const q = (a, t) => a.length ? +a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * t))].toFixed(3) : 0
  const edges = g.edges().map(k => r.getEdgeDisplayData(k)?.opacity ?? 0)
  const bundles = g.edges().map(k => g.getEdgeAttributes(k).bundle ?? 0)
  // Expected shader filament half-width in px (layer_axon base law, before the
  // taper/breath/meniscus multipliers).
  const filaments = g.edges().map(k => { const s = g.getEdgeAttributes(k).strength ?? 0; return 0.08 + 1.55 * Math.pow(s, 1.5) + 0.50 * (1 - 0.42 * s) })
  // Caption alpha by the ACTUAL visibility of the node body (forced labels excluded).
  const alphas = { dust: [], mid: [], hub: [] }
  for (const k of g.nodes()) {
    const d = r.getNodeDisplayData(k)
    if (!d || d.labelVisibility === 'visible') continue
    const m = String(d.labelColor ?? '').match(/,\\s*([\\d.]+)\\)$/)
    const a = m ? parseFloat(m[1]) : 0
    const vis = d.opacity ?? 0
    alphas[vis < 0.05 ? 'dust' : vis < 0.30 ? 'mid' : 'hub'].push(a)
  }
  return {
    ratio: +ratio.toFixed(2), order: g.order, size: g.size,
    shown: shown.length,
    forced: g.nodes().filter(k => r.getNodeDisplayData(k)?.labelVisibility === 'visible').length,
    active: g.nodes().filter(k => r.getNodeState(k)?.isActive).length,
    fontPx: [q(fonts, 0), q(fonts, 0.5), q(fonts, 1)],
    labelAlpha: { dust: q(alphas.dust, 0.5), mid: q(alphas.mid, 0.5), hub: q(alphas.hub, 0.5) },
    labelAlphaN: { dust: alphas.dust.length, mid: alphas.mid.length, hub: alphas.hub.length },
    edgeOpacity: [q(edges, 0), q(edges, 0.5), q(edges, 1)],
    visibleEdges: edges.filter(o => o > 0.05).length,
    faintEdges: edges.filter(o => o > 0.01).length,
    brightEdges: edges.filter(o => o > 0.85).length,
    filamentPx: [q(filaments, 0), q(filaments, 0.5), q(filaments, 1)],
    bundled: bundles.filter(b => b > 0).length,
    bundleP50: q(bundles, 0.5),
  }
})()`

async function pickHub(cdp) {
  const target = await evalJs(cdp, `(() => {
    const mv = window.__mapview, r = mv.renderer, g = mv.graph
    const keys = g.nodes().filter(k => g.degree(k) > 2).sort((a, b) => g.degree(b) - g.degree(a))
    const key = keys[0] || g.nodes()[0]
    const a = g.getNodeAttributes(key)
    const p = r.graphToViewport({ x: a.x, y: a.y })
    const rect = document.querySelector('.canvas').getBoundingClientRect()
    return JSON.stringify({ key, x: rect.left + p.x, y: rect.top + p.y })
  })()`)
  return target ? JSON.parse(target) : null
}

async function runLegibilityCheck(cdp) {
  for (const [tag, ratio] of [['r1', 1], ['r2', 2], ['r34', 3.4], ['rin', 0.32]]) {
    await evalJs(cdp, `window.__mapview.renderer.getCamera().setState({ ratio: ${ratio} }); window.__mapview.renderer.refresh(); 1`)
    await sleep(900)
    console.log(tag + ':', JSON.stringify(await evalJs(cdp, legibilityMeasure)))
    await shot(cdp, `leg-${tag}`)
  }

  // Liquid flow must actually animate: two frames of a still camera differ.
  const frameA = await cdp.send('Page.captureScreenshot', { format: 'png' })
  await sleep(900)
  const frameB = await cdp.send('Page.captureScreenshot', { format: 'png' })
  console.log('liquidMotion:', JSON.stringify({ changed: frameA.data !== frameB.data }))

  await evalJs(cdp, `window.__mapview.renderer.getCamera().setState({ ratio: 1 }); window.__mapview.renderer.refresh(); 1`)
  await sleep(600)
  const hub = await pickHub(cdp)
  if (!hub) return
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hub.x, y: hub.y })
  await sleep(500)
  console.log('hover:', JSON.stringify(await evalJs(cdp, legibilityMeasure)))
  await shot(cdp, 'leg-hover')

  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: hub.x, y: hub.y, button: 'left', clickCount: 1 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: hub.x, y: hub.y, button: 'left', clickCount: 1 })
  await sleep(650)
  console.log('pin:', JSON.stringify(await evalJs(cdp, legibilityMeasure)))
  await shot(cdp, 'leg-pin')
  console.log('panel:', await evalJs(cdp, `JSON.stringify({ open: !document.querySelector('.nodepanel')?.hidden,
    photoBtn: !!document.querySelector('#photo-btn') })`))

  const url = await evalJs(cdp, `window.__mapview.nodePhotoDataUrl()`)
  if (typeof url === 'string' && url.startsWith('data:image/png;base64,')) {
    const buf = Buffer.from(url.slice('data:image/png;base64,'.length), 'base64')
    await writeFile(path.join(OUT_DIR, `${TAG}-photo.png`), buf)
    console.log('photo:', JSON.stringify({ bytes: buf.length, width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }))
  } else {
    console.log('photo: FAILED', String(url).slice(0, 120))
  }
  console.log('liveStateAfterPhoto:', await evalJs(cdp, `JSON.stringify({
    photoMode: window.__mapview.renderer.getGraphState().photoMode ?? false,
    pinActive: window.__mapview.renderer.getGraphState().pinActive
  })`))
  // The real UI button must be wired to the same export path.
  await evalJs(cdp, `document.querySelector('#photo-btn')?.click(); 1`)
  await sleep(400)

  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' })
  await sleep(450)
  console.log('escape:', JSON.stringify(await evalJs(cdp, legibilityMeasure)))
  console.log('errors:', JSON.stringify(cdp.errors.slice(0, 8)))
}

// Диагностика фокуса: какие подписи реально видны у активных и у остальных нод.
const focusDump = `(() => {
  const mv = window.__mapview, r = mv?.renderer, g = mv?.graph
  if (!r || !g) return null
  const shown = r.getNodeDisplayedLabels ? [...r.getNodeDisplayedLabels()] : []
  const shownSet = new Set(shown)
  const row = (k) => {
    const d = r.getNodeDisplayData(k) || {}
    return { label: g.getNodeAttribute(k, 'label'), lv: d.labelVisibility,
             vis: d.visibility, color: d.labelColor, nodeColor: d.color,
             op: +(d.opacity ?? 0).toFixed(2), size: +(d.labelSize ?? 0).toFixed(1),
             shown: shownSet.has(k), active: !!r.getNodeState(k)?.isActive,
             hi: !!r.getNodeState(k)?.isHighlighted }
  }
  const act = g.nodes().filter(k => r.getNodeState(k)?.isActive)
  const rest = g.nodes().filter(k => !r.getNodeState(k)?.isActive)
  const s = r.getGraphState()
  return JSON.stringify({
    ratio: +r.getCamera().getState().ratio.toFixed(2),
    state: { hasActiveSubgraph: s.hasActiveSubgraph, dim: +(s.dimAlpha ?? 0).toFixed(2),
             focus: +(s.focusAlpha ?? 0).toFixed(2), pin: s.pinActive, photo: s.photoMode },
    displayed: shown.length, activeCount: act.length,
    active: act.slice(0, 8).map(row),
    restShown: rest.filter(k => shownSet.has(k)).length,
    restSample: rest.slice(0, 4).map(row),
  })
})()`

async function runFocusCheck(cdp) {
  for (const ratio of [1, 0.6]) {
    await evalJs(cdp, `window.__mapview.renderer.getCamera().setState({ ratio: ${ratio} }); window.__mapview.renderer.refresh(); 1`)
    await sleep(800)
    console.log(`before@${ratio}:`, await evalJs(cdp, focusDump))
    const hub = await pickHub(cdp)
    if (!hub) return
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hub.x, y: hub.y })
    await sleep(600)
    console.log(`hover@${ratio}:`, await evalJs(cdp, focusDump))
    await shot(cdp, `focus-hover-${ratio}`)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: hub.x, y: hub.y, button: 'left', clickCount: 1 })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: hub.x, y: hub.y, button: 'left', clickCount: 1 })
    await sleep(650)
    console.log(`pin@${ratio}:`, await evalJs(cdp, focusDump))
    await shot(cdp, `focus-pin-${ratio}`)
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' })
    await sleep(450)
  }
  console.log('errors:', JSON.stringify(cdp.errors.slice(0, 8)))
}

// Снимок должен соответствовать ТЕКУЩЕЙ камере: два разных зума дают разные
// кадры, а не одно «общее фото».
async function runPhotoCamCheck(cdp) {
  const hub = await pickHub(cdp)
  if (!hub) return
  await evalJs(cdp, `window.__mapview.pin(${Number(hub.key)}); 1`)
  await sleep(600)

  for (const [tag, ratio] of [['overview', 1], ['closeup', 0.4]]) {
    await evalJs(cdp, `(() => {
      const mv = window.__mapview, r = mv.renderer, g = mv.graph
      const a = g.getNodeAttributes(${JSON.stringify(hub.key)})
      const c = ${ratio} === 1 ? { x: 0.5, y: 0.5 } : r.graphToFramedGraph({ x: a.x, y: a.y })
      r.getCamera().setState({ x: c.x, y: c.y, ratio: ${ratio}, angle: 0 })
      r.refresh()
      return 1
    })()`)
    await sleep(900)
    const info = await evalJs(cdp, `JSON.stringify({
      cam: window.__mapview.renderer.getCamera().getState(),
      dims: window.__mapview.renderer.getDimensions()
    })`)
    await shot(cdp, `photocam-${tag}-live`)
    const url = await evalJs(cdp, `window.__mapview.nodePhotoDataUrl()`)
    if (typeof url === 'string' && url.startsWith('data:image/png;base64,')) {
      const buf = Buffer.from(url.slice('data:image/png;base64,'.length), 'base64')
      await writeFile(path.join(OUT_DIR, `${TAG}-photo-${tag}.png`), buf)
      console.log(`photo@${tag}:`, JSON.stringify({ info: JSON.parse(info), bytes: buf.length,
        width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }))
    } else {
      console.log(`photo@${tag}: FAILED`, String(url).slice(0, 120))
    }
  }
  console.log('cameraAfter:', await evalJs(cdp, `JSON.stringify(window.__mapview.renderer.getCamera().getState())`))
  console.log('errors:', JSON.stringify(cdp.errors.slice(0, 8)))
}

// Диагностика кнопки «Авто»: сброс оверрайда лейбла.
const panelDump = `(() => {
  const mv = window.__mapview, g = mv.graph, key = String(mv.pinnedId)
  return JSON.stringify({
    pinned: mv.pinnedId,
    title: document.querySelector('#node-title')?.textContent,
    label: g.hasNode(key) ? g.getNodeAttribute(key, 'label') : null,
    displayLabel: window.__mapview.renderer?.getNodeDisplayData(key)?.label,
    hoverLine: document.querySelector('.hover-line')?.textContent,
    defaultLabel: g.hasNode(key) ? g.getNodeAttribute(key, 'defaultLabel') : null,
    forms: [...document.querySelectorAll('.form-btn')].map(b => b.textContent.trim()),
    activeForm: [...document.querySelectorAll('.form-btn.active')].map(b => b.textContent.trim()),
    storage: localStorage.getItem('chatmap.labels'),
    autoBtn: (() => { const b = document.querySelector('#auto-btn'); return b ? {
      cls: b.className, pressed: b.getAttribute('aria-pressed'), title: b.title } : null })(),
    errors: 0
  })
})()`

async function runAutoBtnCheck(cdp) {
  // Prefer a node with several word forms so a label change is observable.
  const multi = await evalJs(cdp, `(() => {
    const f = window.__mapview?.lastMsg?.forms
    if (!f) return null
    const entries = f instanceof Map ? [...f.entries()] : Object.entries(f)
    const hit = entries.find(([, list]) => Array.isArray(list) && list.length > 1)
    return hit ? String(hit[0]) : null
  })()`)
  if (multi) {
    await evalJs(cdp, `window.__mapview.pin(${Number(multi)}); 1`)
    await sleep(700)
  } else {
    const hub = await pickHub(cdp)
    if (!hub) return
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: hub.x, y: hub.y, button: 'left', clickCount: 1 })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: hub.x, y: hub.y, button: 'left', clickCount: 1 })
    await sleep(700)
  }
  console.log('pinned:', await evalJs(cdp, panelDump))
  await shot(cdp, 'auto-pinned')

  await evalJs(cdp, `(() => {
    const bs = [...document.querySelectorAll('.form-btn')]
    const b = bs.find(x => !x.classList.contains('active')) || bs[0]
    if (b) b.click()
    return 1
  })()`)
  await sleep(500)
  console.log('afterForm:', await evalJs(cdp, panelDump))
  await shot(cdp, 'auto-afterForm')

  await evalJs(cdp, `document.querySelector('#auto-btn').click(); 1`)
  await sleep(500)
  console.log('afterAuto:', await evalJs(cdp, panelDump))
  await shot(cdp, 'auto-afterAuto')
  console.log('errors:', JSON.stringify(cdp.errors.slice(0, 8)))
}

async function main() {
  const page = await getPage()
  const cdp = await connect(page)
  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')
  await cdp.send('DOM.enable')

  if (DENSE || REAL) {
    const file = REAL
      ? REAL_JSON
      : path.join(process.env.TEMP ?? '.', `chatmap-dense-${Date.now()}.json`)
    if (DENSE) await denseJson(file)
    await sleep(1200)
    const doc = await cdp.send('DOM.getDocument')
    const qs = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: 'input#file-input' })
    await cdp.send('DOM.setFileInputFiles', { files: [file], nodeId: qs.nodeId })
  }

  for (let i = 0; i < (REAL ? 600 : 240); i++) {
    if (await evalJs(cdp, 'window.__mapview && window.__mapview.graph?.order > 0')) break
    await sleep(500)
  }
  await sleep(2200)
  if (CHECK) {
    await runLegibilityCheck(cdp)
    cdp.close()
    return
  }
  if (FOCUS) {
    await runFocusCheck(cdp)
    cdp.close()
    return
  }
  if (PHOTOCAM) {
    await runPhotoCamCheck(cdp)
    cdp.close()
    return
  }
  if (AUTOBTN) {
    await runAutoBtnCheck(cdp)
    cdp.close()
    return
  }
  console.log('ratio 1:', JSON.stringify(await evalJs(cdp, measure)))
  await shot(cdp, 'ratio1')
  await evalJs(cdp, `window.__mapview.renderer.getCamera().setState({ ratio: 0.55 }); window.__mapview.renderer.refresh(); 1`)
  await sleep(900)
  console.log('ratio 0.55:', JSON.stringify(await evalJs(cdp, measure)))
  await shot(cdp, 'zoomin')
  await evalJs(cdp, `window.__mapview.renderer.getCamera().setState({ ratio: 0.32 }); window.__mapview.renderer.refresh(); 1`)
  await sleep(900)
  console.log('ratio 0.32:', JSON.stringify(await evalJs(cdp, measure)))
  await shot(cdp, 'detail')
  await evalJs(cdp, `window.__mapview.renderer.getCamera().setState({ ratio: 2.2 }); window.__mapview.renderer.refresh(); 1`)
  await sleep(900)
  console.log('ratio 2.2:', JSON.stringify(await evalJs(cdp, measure)))
  await shot(cdp, 'ratio2')
  await evalJs(cdp, `window.__mapview.renderer.getCamera().setState({ ratio: 3.4 }); window.__mapview.renderer.refresh(); 1`)
  await sleep(900)
  console.log('ratio 3.4:', JSON.stringify(await evalJs(cdp, measure)))
  await shot(cdp, 'ratio3')

  // Hover regression: the ego-subgraph must still brighten active edges.
  await evalJs(cdp, `window.__mapview.renderer.getCamera().setState({ ratio: 1 }); window.__mapview.renderer.refresh(); 1`)
  await sleep(500)
  const target = await evalJs(cdp, `(() => {
    const mv = window.__mapview, r = mv.renderer, g = mv.graph
    const key = g.nodes().find(k => g.degree(k) > 2) || g.nodes()[0]
    const a = g.getNodeAttributes(key)
    const p = r.graphToViewport({ x: a.x, y: a.y })
    const rect = document.querySelector('.canvas').getBoundingClientRect()
    return JSON.stringify({ x: rect.left + p.x, y: rect.top + p.y })
  })()`)
  if (target) {
    const { x, y } = JSON.parse(target)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    await sleep(450)
    console.log('hover:', await evalJs(cdp, `(() => {
      const s = window.__mapview.renderer.getGraphState()
      return JSON.stringify({ dim: s.dimAlpha, focus: s.focusAlpha, active: s.hasActiveSubgraph })
    })()`))
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
    await sleep(600)
    console.log('pin:', await evalJs(cdp, `(() => {
      const mv = window.__mapview, r = mv.renderer, g = mv.graph
      const s = r.getGraphState()
      const keys = g.nodes()
      const forced = keys.filter(k => r.getNodeDisplayData(k)?.labelVisibility === 'visible').length
      const brightEdges = g.edges().filter(k => (r.getEdgeDisplayData(k)?.opacity ?? 0) > 0.85).length
      return JSON.stringify({ pin: s.pinActive, forced, brightEdges, panel: !document.querySelector('.nodepanel')?.hidden })
    })()`))
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' })
    await sleep(400)
    console.log('escape:', await evalJs(cdp, `JSON.stringify({ pin: window.__mapview.renderer.getGraphState().pinActive })`))
  }
  console.log('errors:', JSON.stringify(cdp.errors.slice(0, 8)))
  cdp.close()
}

main()
  .catch((e) => {
    console.error('shot-edges failed:', e)
    process.exitCode = 1
  })
  .finally(() => chrome.kill())
