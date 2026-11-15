// Local visual/shape harness: builds a synthetic chat, loads it through the real
// file input, drives the topN slider and captures screenshots + layout metrics.
// Nothing leaves the machine; the export is generated in memory.
// Run: node tools/shot-shape.mjs <tag> [vocab] [messages] [topN]
//      node tools/shot-shape.mjs mega [vocab] [messages] [topN]
// `mega` swaps the export for the one-word mega-hub generator in
// tests/fixtures/megahub-chat.mjs (CHATMAP_HUB_SHARE overrides its p).
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { buildMegaHubChat } from '../tests/fixtures/megahub-chat.mjs'

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const BASE = process.env.CHATMAP_BASE ?? 'http://127.0.0.1:5173'
const PORT = Number(process.env.CHATMAP_CDP_PORT ?? 9355)
const OUT_DIR = path.join(path.resolve('.'), 'tests', 'betterwright', 'shape')
const TAG = process.argv[2] ?? 'shape'
const MEGA = TAG === 'mega'
const VOCAB = Number(process.argv[3] ?? 1400)
const MESSAGES = Number(process.argv[4] ?? 6000)
// The UI slider caps topN at 1000; the mega stand asks for the densest view.
const TOP_N = Number(process.argv[5] ?? (MEGA ? 1000 : 600))
const HUB_SHARE = Number(process.env.CHATMAP_HUB_SHARE ?? 0.85)
const SETTLE_MS = Number(process.env.CHATMAP_SETTLE_MS ?? 2500)

mkdirSync(OUT_DIR, { recursive: true })

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
    `--user-data-dir=${path.join(process.env.TEMP ?? '.', `chatmap-shape-${Date.now()}`)}`,
    '--no-first-run',
    '--window-size=1400,900',
    // Real desktops run at fractional scale factors (125%, 150%). The SDF label
    // atlas can degrade there, so the harness can reproduce it.
    ...(process.env.CHATMAP_DPR ? [`--force-device-scale-factor=${process.env.CHATMAP_DPR}`] : []),
    `${BASE}/`,
  ],
  { stdio: 'ignore' },
)

async function getPage() {
  for (let i = 0; i < 80; i++) {
    await sleep(250)
    try {
      const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const page = targets.find((t) => t.type === 'page' && t.url.includes('127.0.0.1'))
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
    // A malformed frame must not kill the harness: skip it and keep listening.
    let m
    try {
      m = JSON.parse(e.data)
    } catch {
      return
    }
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
  cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }).then((r) => {
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval failed')
    return r.result.value
  })

async function shot(cdp, name) {
  const s = await cdp.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(path.join(OUT_DIR, `${TAG}-${name}.png`), Buffer.from(s.data, 'base64'))
}

// Deterministic synthetic chat: syllabic vocabulary, rank-biased drawing so a
// handful of words dominate the frequency range like in a real conversation.
function buildExportScript(vocabSize, messageCount) {
  return `(() => {
  let seed = 20261107
  const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296 }
  const syl = ['ма','ре','ки','то','лу','на','ве','зи','дор','ша','кор','ти','му','ба','сен','лар','по','чер','вы','гра']
  const words = new Set()
  while (words.size < ${vocabSize}) {
    words.add(syl[Math.floor(rnd()*syl.length)] + syl[Math.floor(rnd()*syl.length)] + syl[Math.floor(rnd()*syl.length)] + syl[Math.floor(rnd()*syl.length)])
  }
  const vocab = [...words]
  const pick = (pool) => pool[Math.min(pool.length - 1, Math.floor(Math.pow(rnd(), 2.1) * pool.length))]
  // Topical structure like a real chat: a message draws mostly from ONE topic
  // slice, with the occasional cross-topic word. A single flat pool produces a
  // community-free blob, which no layout can sculpt into a figure.
  const TOPICS = 9
  const perTopic = Math.floor(vocab.length / TOPICS)
  const messages = []
  for (let m = 0; m < ${messageCount}; m++) {
    const topic = Math.floor(rnd() * TOPICS)
    const pool = vocab.slice(topic * perTopic, (topic + 1) * perTopic)
    const chosen = new Set()
    const n = 3 + Math.floor(rnd() * 4)
    for (let k = 0; k < n; k++) chosen.add(pick(pool))
    if (rnd() < 0.35) chosen.add(pick(vocab.slice(0, 12)))
    if (rnd() < 0.12) chosen.add(pick(vocab))
    const who = m % 3
    messages.push({ id: 1000 + m, type: 'message', date: 1761900000 + m * 60,
      from: ['Аня','Борис','Гость'][who], from_id: [111,222,333][who], text: [...chosen].join(' ') })
  }
  const payload = JSON.stringify({ name: 'Синтетика', type: 'personal_chat', id: 1, messages })
  const file = new File([payload], 'result.json', { type: 'application/json' })
  const dt = new DataTransfer()
  dt.items.add(file)
  const input = document.getElementById('file-input')
  input.files = dt.files
  input.dispatchEvent(new Event('change', { bubbles: true }))
  return payload.length
})()`
}

// Shape metrics from the ACTUAL rendered positions (graphology attributes).
const shapeMetrics = `(() => {
  const mv = window.__mapview
  const g = mv?.graph
  const r = mv?.renderer
  if (!g || !r || g.order === 0) return null
  const pts = g.nodes().map((k) => g.getNodeAttributes(k))
  const n = pts.length
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y)
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys)
  const area = Math.max(1, (maxX - minX) * (maxY - minY))
  let sum = 0, sumSq = 0
  for (let i = 0; i < n; i++) {
    let best = Infinity
    for (let j = 0; j < n; j++) {
      if (i === j) continue
      const d = Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y)
      if (d < best) best = d
    }
    sum += best; sumSq += best * best
  }
  const mean = sum / n
  const cv = Math.sqrt(Math.max(0, sumSq / n - mean * mean)) / Math.max(1e-9, mean)
  const clarkEvans = mean / (1 / (2 * Math.sqrt(n / area)))
  const cells = 12
  const grid = new Array(cells * cells).fill(0)
  for (const p of pts) {
    const gx = Math.min(cells - 1, Math.floor(((p.x - minX) / (maxX - minX || 1)) * cells))
    const gy = Math.min(cells - 1, Math.floor(((p.y - minY) / (maxY - minY || 1)) * cells))
    grid[gy * cells + gx]++
  }
  const sorted = [...grid].sort((a, b) => a - b)
  const q = (a, t) => a[Math.min(a.length - 1, Math.floor(a.length * t))]
  const sizes = g.nodes().map((k) => +(r.getNodeDisplayData(k)?.size ?? 0)).sort((a, b) => a - b)
  const cores = pts.map((p) => p.size).sort((a, b) => a - b)
  const hidden = g.nodes().filter((k) => r.getNodeDisplayData(k)?.visibility === 'hidden').length
  const labels = g.nodes().filter((k) => r.getNodeDisplayData(k)?.labelVisibility !== 'hidden').length
  return {
    order: g.order, edges: g.size,
    ratio: +r.getCamera().getState().ratio.toFixed(2),
    clarkEvans: +clarkEvans.toFixed(2),
    nnCv: +cv.toFixed(2),
    clumpRatio: +(q(sorted, 0.9) / Math.max(1, q(sorted, 0.5))).toFixed(1),
    fill: +(grid.filter((c) => c > 0).length / grid.length).toFixed(2),
    layoutSize: [q(cores, 0), q(cores, 0.5), q(cores, 0.9), q(cores, 1)],
    screenSize: [q(sizes, 0), q(sizes, 0.5), q(sizes, 0.9), q(sizes, 1)].map((v) => +v.toFixed(1)),
    hidden, labels,
  }
})()`

// Injects an export generated in Node (the mega-hub fixture) through the page's
// real file input. Same code path as buildExportScript, only the payload source
// differs: one generator shared with the tests instead of a second in-page copy.
const injectExportScript = (payload) => `(() => {
  const payload = ${JSON.stringify(payload)}
  const file = new File([payload], 'result.json', { type: 'application/json' })
  const dt = new DataTransfer()
  dt.items.add(file)
  const input = document.getElementById('file-input')
  input.files = dt.files
  input.dispatchEvent(new Event('change', { bubbles: true }))
  return payload.length
})()`

// CDP payloads are JSON strings; a malformed one must surface as data, not as a crash.
const asJson = (raw) => {
  try {
    return JSON.parse(raw)
  } catch (err) {
    return { parseError: String(err), raw }
  }
}

const main = async () => {
  const page = await getPage()
  const cdp = await connect(page)
  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')
  await evalJs(cdp, 'document.readyState')
  await sleep(400)

  const payload = MEGA
    ? JSON.stringify(
        buildMegaHubChat({ vocab: VOCAB, messages: MESSAGES, hubShare: HUB_SHARE }),
      )
    : null
  const bytes = await evalJs(
    cdp,
    MEGA ? injectExportScript(payload) : buildExportScript(VOCAB, MESSAGES),
  )
  // Worker pipeline + layout: poll for the map instead of guessing a duration.
  for (let i = 0; i < 240; i++) {
    await sleep(500)
    const order = await evalJs(cdp, 'window.__mapview?.graph?.order ?? 0')
    if (order > 0) break
  }
  await sleep(SETTLE_MS)

  if (TOP_N > 0) {
    await evalJs(
      cdp,
      `(() => {
        const s = document.getElementById('slider-top-n')
        s.value = String(${TOP_N})
        s.dispatchEvent(new Event('input', { bubbles: true }))
        s.dispatchEvent(new Event('change', { bubbles: true }))
        return s.value
      })()`,
    )
    let last = 0
    for (let i = 0; i < 240; i++) {
      await sleep(500)
      const order = await evalJs(cdp, 'window.__mapview?.graph?.order ?? 0')
      const busy = await evalJs(cdp, 'document.querySelector(".canvas")?.getAttribute("aria-busy") === "true"')
      if (!busy && order === last && order > 0) break
      last = order
    }
  }
  await sleep(SETTLE_MS)

  await shot(cdp, 'overview')
  const metrics = await evalJs(cdp, shapeMetrics)

  // Hub centrality: the user complaint is big words always landing on the rim.
  // Top-10 by body size with radius as a share of the max radius (1 = rim).
  const hubsReport = await evalJs(
    cdp,
    `(() => {
      const mv = window.__mapview, g = mv.graph
      const pts = g.nodes().map((k) => ({ k, ...g.getNodeAttributes(k) }))
      const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length
      const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length
      const withR = pts.map((p) => ({ ...p, r: Math.hypot(p.x - cx, p.y - cy) }))
      const maxR = Math.max(1e-9, ...withR.map((p) => p.r))
      const med = [...withR].map((p) => p.r).sort((a, b) => a - b)[Math.floor(withR.length / 2)]
      const top = [...withR].sort((a, b) => (b.size ?? 0) - (a.size ?? 0)).slice(0, 10)
      return JSON.stringify({
        medRel: +(med / maxR).toFixed(2),
        top: top.map((p) => ({
          label: p.label,
          size: +((p.size ?? 0).toFixed(1)),
          rel: +((p.r / maxR).toFixed(2)),
        })),
      })
    })()`,
  )

  // Mega-hub stand: the same hub contract the tests assert (reach >= 80%, degree
  // >= 300), read from the RENDERED graph so the screenshot and the numbers come
  // from one layout. `reach` = share of map words linked to the top-1 word.
  const megaReport = MEGA
    ? await evalJs(
        cdp,
        `(() => {
          const mv = window.__mapview, g = mv.graph
          const degree = new Map()
          for (const e of g.edges()) {
            const [a, b] = g.extremities(e)
            degree.set(a, (degree.get(a) ?? 0) + 1)
            degree.set(b, (degree.get(b) ?? 0) + 1)
          }
          const [hub, hubDegree] = [...degree.entries()].sort((a, b) => b[1] - a[1])[0] ?? ['', 0]
          return JSON.stringify({
            order: g.order,
            edges: g.size,
            hub,
            hubLabel: g.getNodeAttribute(hub, 'label'),
            hubDegree,
            hubReach: +(hubDegree / Math.max(1, g.order - 1)).toFixed(3),
            hubEdgeShare: +(hubDegree / Math.max(1, g.size)).toFixed(3),
          })
        })()`,
      )
    : null

  // Pin check: the selected word must own the last depth bucket for BOTH its
  // body and its caption, and no other node may join it there.
  const pin = await evalJs(
    cdp,
    `(async () => {
      const mv = window.__mapview, g = mv.graph, r = mv.renderer
      const key = g.nodes().sort((a, b) => g.degree(b) - g.degree(a))[0]
      mv.pin(Number(key))
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      const d = r.getNodeDisplayData(key)
      const others = g.nodes().filter((k) => k !== key)
      return JSON.stringify({
        key,
        depth: d?.depth,
        labelDepth: d?.labelDepth,
        labelVisibility: d?.labelVisibility,
        promotedOthers: others.filter((k) => r.getNodeDisplayData(k)?.depth === 'topNodes').length,
        promote: r.getGraphState().promote,
      })
    })()`,
  )
  await sleep(500)
  await shot(cdp, 'pinned')

  // Entrance check: at half of the assembly clock the per-node offsets must
  // still split the map, i.e. a wide spread of opacities instead of one value.
  const enter = await evalJs(
    cdp,
    `(async () => {
      const mv = window.__mapview, g = mv.graph, r = mv.renderer
      mv.pin(null)
      mv.animator.jump('enter', 0.5)
      r.refresh({ skipIndexation: true })
      await new Promise((resolve) => requestAnimationFrame(resolve))
      const ops = g.nodes().map((k) => r.getNodeDisplayData(k)?.opacity ?? 0).sort((a, b) => a - b)
      const mid = ops.length ? ops[Math.floor(ops.length * 0.5)] : 0
      return JSON.stringify({
        order: ops.length,
        hiddenEarly: ops.filter((o) => o < 0.1).length,
        settledEarly: ops.filter((o) => o > 0.5).length,
        median: +mid.toFixed(2),
      })
    })()`,
  )

  process.stdout.write(
    `${JSON.stringify({ tag: TAG, mega: MEGA ? asJson(megaReport) : undefined, hubShare: MEGA ? HUB_SHARE : undefined, bytes, vocab: VOCAB, messages: MESSAGES, topN: TOP_N, metrics, hubs: asJson(hubsReport), pin: asJson(pin), enter: asJson(enter), errors: cdp.errors }, null, 1)}\n`,
  )

  // Filter round-trip: one author, then back to everybody. The silhouette metrics
  // must stay comparable instead of collapsing into a fresh uniform scatter.
  const pickMode = async (selector, label) => {
    await evalJs(
      cdp,
      `(() => {
        const input = document.querySelector('${selector}')
        if (!input) return 'missing'
        input.checked = true
        input.dispatchEvent(new Event('change', { bubbles: true }))
        return 'ok'
      })()`,
    )
    let last = -1
    for (let i = 0; i < 120; i++) {
      await sleep(400)
      const order = await evalJs(cdp, 'window.__mapview?.graph?.order ?? 0')
      const busy = await evalJs(cdp, 'document.querySelector(".canvas")?.getAttribute("aria-busy") === "true"')
      if (!busy && order > 0 && order === last) break
      last = order
    }
    await sleep(400)
    await shot(cdp, label)
    return evalJs(cdp, shapeMetrics)
  }
  const authorMode = await pickMode('input[name="view-mode"][value^="author-"]', 'filter-author')
  const backToAll = await pickMode('input[name="view-mode"][value="together"]', 'filter-all')
  process.stdout.write(`${JSON.stringify({ filter: { author: authorMode, all: backToAll } }, null, 1)}\n`)

  // Zoomed-in focus probe: transit culling hides edges whose endpoints are off
  // the viewport, and it only re-runs on camera moves. Hovering a word at a deep
  // zoom must still show that word's own edges immediately.
  const focusTarget = await evalJs(
    cdp,
    `(async () => {
      const mv = window.__mapview, g = mv.graph, r = mv.renderer
      r.getCamera().setState({ ratio: 0.3, x: 0.5, y: 0.5, angle: 0 })
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      // A word whose neighbours are mostly outside the viewport at this zoom.
      const key = g.nodes().sort((a, b) => g.degree(b) - g.degree(a))[0]
      const attrs = g.getNodeAttributes(key)
      const p = r.graphToViewport({ x: attrs.x, y: attrs.y })
      const rect = document.querySelector('.canvas').getBoundingClientRect()
      return JSON.stringify({ key, x: rect.left + p.x, y: rect.top + p.y, ratio: r.getCamera().getState().ratio })
    })()`,
  )
  // Ratio sweep: how many of the hovered word's links actually paint, and how
  // many of its neighbours are inside the frame at each zoom level.
  const sweep = await evalJs(
    cdp,
    `(async () => {
      const mv = window.__mapview, g = mv.graph, r = mv.renderer
      const raf = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      const dims = r.getDimensions()
      const key = g.nodes().sort((a, b) => g.degree(b) - g.degree(a))[0]
      const inside = (k) => {
        const a = g.getNodeAttributes(k)
        const p = r.graphToViewport({ x: a.x, y: a.y })
        return p.x >= 0 && p.y >= 0 && p.x <= dims.width && p.y <= dims.height
      }
      const neighbours = g.neighbors(key)
      const out = []
      for (const ratio of [0.25, 0.4, 0.6, 0.8, 1, 1.4]) {
        r.getCamera().setState({ ratio, x: 0.5, y: 0.5, angle: 0 })
        await raf()
        r.emit('enterNode', { node: key })
        await raf()
        const edges = g.edges(key)
        const activeEdges = edges.filter((e) => r.getEdgeState(e)?.isActive)
        out.push({
          ratio,
          active: activeEdges.length,
          // The point of the fix: highlighted links must END inside the frame.
          activeInFrame: activeEdges.filter((e) => {
            const other = g.opposite(key, e)
            return inside(other)
          }).length,
          painted: edges.filter((e) => (r.getEdgeDisplayData(e)?.opacity ?? 0) > 0.05).length,
          hidden: edges.filter((e) => r.getEdgeDisplayData(e)?.visibility === 'hidden').length,
          // What the OLD global weight ranking would have highlighted (query only).
          legacyInFrame: neighbours
            .map((n) => ({ n, w: g.getEdgeAttributes(g.edges(key, n)[0])?.weight ?? 0 }))
            .sort((a, b) => b.w - a.w)
            .slice(0, 8)
            .filter((x) => inside(x.n)).length,
          nbInside: neighbours.filter(inside).length,
          nbTotal: neighbours.length,
        })
      }
      r.emit('leaveNode', { node: key })
      return JSON.stringify(out)
    })()`,
  )
  process.stdout.write(`${JSON.stringify({ sweep: asJson(sweep) }, null, 1)}
`)
  const focus = asJson(focusTarget)
  // Ego fan: every link of the hovered word must be lit, tiered by weight, with
  // forced labels only for the strongest few. Measured at two zoom levels.
  const fanReport = async (ratio, label) => {
    await evalJs(
      cdp,
      `(async () => {
        const mv = window.__mapview, r = mv.renderer
        r.getCamera().setState({ ratio: ${ratio}, x: 0.5, y: 0.5, angle: 0 })
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
        r.emit('enterNode', { node: '${focus.key}' })
        return 'ok'
      })()`,
    )
    await sleep(400)
    const report = await evalJs(
      cdp,
      `(async () => {
        const mv = window.__mapview, g = mv.graph, r = mv.renderer
        const key = '${focus.key}'
        const edges = g.edges(key)
        const opacities = edges.map((e) => r.getEdgeDisplayData(e)?.opacity ?? 0)
        const states = edges.map((e) => r.getEdgeState(e) ?? {})
        const neighbours = g.neighbors(key)
        return JSON.stringify({
          ratio: +r.getCamera().getState().ratio.toFixed(2),
          degree: edges.length,
          active: states.filter((s) => s.isActive).length,
          hidden: edges.filter((e) => r.getEdgeDisplayData(e)?.visibility === 'hidden').length,
          weak: opacities.filter((o) => o > 0.05 && o < 0.25).length,
          mid: opacities.filter((o) => o >= 0.25 && o < 0.6).length,
          strong: opacities.filter((o) => o >= 0.6).length,
          pulsing: edges.filter((e) => (r.getEdgeDisplayData(e)?.pulse ?? 0) > 0.5).length,
          labelled: neighbours.filter((n) => r.getNodeState(n)?.isActive).length,
          egoNodes: neighbours.filter((n) => r.getNodeState(n)?.isEgo).length,
          maxOpacity: +Math.max(0, ...opacities).toFixed(2),
        })
      })()`,
    )
    await shot(cdp, label)
    return asJson(report)
  }
  const fanClose = await fanReport(0.6, 'ego-fan-close')
  const fanWide = await fanReport(1, 'ego-fan-wide')
  await evalJs(cdp, `window.__mapview.renderer.emit('leaveNode', { node: '${focus.key}' }), 'ok'`)
  // Leaving must clear the fan: a stale isEgo/egoTier keeps the map lit forever.
  await sleep(400)
  const cleared = await evalJs(
    cdp,
    `(() => {
      const mv = window.__mapview, g = mv.graph, r = mv.renderer
      return JSON.stringify({
        egoNodes: g.nodes().filter((n) => r.getNodeState(n)?.isEgo).length,
        activeEdges: g.edges().filter((e) => r.getEdgeState(e)?.isActive).length,
      })
    })()`,
  )
  await shot(cdp, 'ego-cleared')

  // Label census while pinned: how many captions are actually drawable, how many
  // the resolver blocks, and what the alpha looks like. Reproduces "only a frame,
  // no text" reports.
  const census = await evalJs(
    cdp,
    `(async () => {
      const mv = window.__mapview, g = mv.graph, r = mv.renderer
      const raf = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      const key = g.nodes().sort((a, b) => g.degree(b) - g.degree(a))[0]
      mv.pin(Number(key))
      await raf()
      const read = () => {
        const st = r.getGraphState()
        // What Sigma actually puts on screen, versus what the style allows.
        const displayed = r.getNodeDisplayedLabels ? [...r.getNodeDisplayedLabels()] : []
        const displayedAlphas = displayed.map((k) => {
          const text = String(r.getNodeDisplayData(k)?.labelColor ?? '')
          const cut = text.lastIndexOf(',')
          return cut < 0 ? 1 : parseFloat(text.slice(cut + 1))
        })
        let visible = 0, forced = 0, lowAlpha = 0, zeroAlpha = 0, plateMismatch = 0
        const alphas = []
        for (const k of g.nodes()) {
          const d = r.getNodeDisplayData(k)
          if (!d) continue
          const text = String(d.labelColor ?? '')
          const cut = text.lastIndexOf(',')
          const a = cut < 0 ? 1 : parseFloat(text.slice(cut + 1))
          alphas.push(a)
          if (d.labelVisibility === 'visible') forced++
          else if (d.labelVisibility !== 'hidden') visible++
          if (a <= 0.02) zeroAlpha++
          else if (a < 0.3) lowAlpha++
          // A plate must never be much more opaque than the word on top of it.
          const plate = String(d.labelBackgroundColor ?? '')
          const plateCut = plate.lastIndexOf(',')
          const plateAlpha = plateCut < 0 ? 0 : parseFloat(plate.slice(plateCut + 1))
          if (Number.isFinite(plateAlpha) && plateAlpha > a + 0.2) plateMismatch++
        }
        alphas.sort((x, y) => x - y)
        // Are the drawn captions actually inside the frame, and at what size?
        const dims = r.getDimensions()
        const inFrame = displayed.filter((k) => {
          const a = g.getNodeAttributes(k)
          const p = r.graphToViewport({ x: a.x, y: a.y })
          return p.x >= 0 && p.y >= 0 && p.x <= dims.width && p.y <= dims.height
        }).length
        const fontSizes = displayed.map((k) => r.getNodeDisplayData(k)?.labelSize ?? 0).sort((x, y) => x - y)
        return {
          order: g.order,
          displayed: displayed.length,
          displayedInFrame: inFrame,
          labelSizeP50: +(fontSizes[Math.floor(fontSizes.length * 0.5)] ?? 0).toFixed(1),
          canvas: [dims.width, dims.height],
          displayedAlphaP50: +(displayedAlphas.sort((x, y) => x - y)[Math.floor(displayedAlphas.length * 0.5)] ?? 0).toFixed(2),
          labelDensity: r.getSettings?.().labelDensity,
          visible,
          forced,
          blocked: (st.labelBlocked ?? new Set()).size,
          alphaP50: +(alphas[Math.floor(alphas.length * 0.5)] ?? 0).toFixed(2),
          alphaP90: +(alphas[Math.floor(alphas.length * 0.9)] ?? 0).toFixed(2),
          zeroAlpha,
          lowAlpha,
          plateMismatch,
          ratio: +st.cameraRatio.toFixed(2),
        }
      }
      const pinned = read()
      // Zoom walk: captions can vanish at a close-up even though bodies are drawn.
      const byRatio = []
      for (const ratio of [1, 0.7, 0.5, 0.35, 0.25]) {
        r.getCamera().setState({ ratio, x: 0.5, y: 0.5, angle: 0 })
        await raf()
        byRatio.push(read())
      }
      // Simulate mouse movement across the fan: every enterNode retargets the ego.
      const fan = g.neighbors(key).slice(0, 12)
      for (const n of fan) {
        r.emit('enterNode', { node: n })
        await raf()
      }
      const afterMove = read()
      mv.pin(null)
      return JSON.stringify({ pinned, byRatio, afterMove })
    })()`,
  )
  process.stdout.write(`${JSON.stringify({ census: asJson(census) }, null, 1)}
`)

  // Flicker probe: with a node pinned, walk the camera outwards in small steps and
  // count labels whose visibility (or alpha) flips more than once. A smooth zoom
  // may cross a threshold once per label; two or more transitions is flicker.
  const flicker = await evalJs(
    cdp,
    `(async () => {
      const mv = window.__mapview, g = mv.graph, r = mv.renderer
      const raf = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      const key = g.nodes().sort((a, b) => g.degree(b) - g.degree(a))[0]
      mv.pin(Number(key))
      await raf()
      const steps = 40
      const vis = new Map()
      const alpha = new Map()
      // Alpha parsed from the rgba() string without a regex: the probe is injected
      // as a template literal, and escaping classes there is error-prone.
      const parseAlpha = (color) => {
        const text = String(color ?? '')
        const cut = text.lastIndexOf(',')
        if (cut < 0) return 1
        const value = parseFloat(text.slice(cut + 1))
        return Number.isFinite(value) ? value : 1
      }
      for (let i = 0; i <= steps; i++) {
        const ratio = 0.7 + (0.9 * i) / steps
        r.getCamera().setState({ ratio, x: 0.5, y: 0.5, angle: 0 })
        await raf()
        for (const k of g.nodes()) {
          const d = r.getNodeDisplayData(k)
          if (!vis.has(k)) { vis.set(k, []); alpha.set(k, []) }
          vis.get(k).push(d?.labelVisibility === 'hidden' ? 0 : 1)
          alpha.get(k).push(parseAlpha(d?.labelColor))
        }
      }
      const flips = (arr) => {
        let n = 0
        for (let i = 1; i < arr.length; i++) if (arr[i] !== arr[i - 1]) n++
        return n
      }
      const flickerVis = []
      const flickerAlpha = []
      for (const [k, arr] of vis) {
        if (flips(arr) >= 2) flickerVis.push({ k, pattern: arr.join(''), flips: flips(arr) })
      }
      for (const [k, arr] of alpha) {
        // Alpha jitter: a label whose alpha goes up AND down again by >0.05.
        let reversals = 0
        for (let i = 2; i < arr.length; i++) {
          const d1 = arr[i - 1] - arr[i - 2]
          const d2 = arr[i] - arr[i - 1]
          if (d1 * d2 < -0.0002 && Math.abs(d1) > 0.05) reversals++
        }
        if (reversals >= 2) flickerAlpha.push({ k, reversals })
      }
      // Second pass: for the first flickering labels, record WHICH gate flips —
      // collision blocking (labelBlocked) or the LOD alpha ramp.
      const trace = []
      for (const entry of flickerVis.slice(0, 3)) {
        const key = entry.k
        const rows = []
        for (let i = 0; i <= steps; i++) {
          const ratio = 0.7 + (0.9 * i) / steps
          r.getCamera().setState({ ratio, x: 0.5, y: 0.5, angle: 0 })
          await raf()
          const d = r.getNodeDisplayData(key)
          const blocked = (r.getGraphState().labelBlocked ?? new Set()).has(key)
          rows.push((d?.labelVisibility === 'hidden' ? 'H' : 'v') + (blocked ? 'B' : '.') + ':' + parseAlpha(d?.labelColor).toFixed(2))
        }
        trace.push({ key, rows: rows.join(' ') })
      }
      mv.pin(null)
      return JSON.stringify({
        order: g.order,
        flickerVis: flickerVis.length,
        flickerAlpha: flickerAlpha.length,
        samplesVis: flickerVis.slice(0, 3),
        samplesAlpha: flickerAlpha.slice(0, 3),
        trace,
      })
    })()`,
  )
  process.stdout.write(`${JSON.stringify({ flicker: asJson(flicker) }, null, 1)}
`)
  // LOD dissolve probe: walk the camera OUTWARDS and report, per zoom step, how
  // many bodies are gone, how many linger as specks, and whether links keep
  // pointing at bodies that are no longer drawn.
  const lodLadder = await evalJs(
    cdp,
    `(async () => {
      const mv = window.__mapview, g = mv.graph, r = mv.renderer
      const raf = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      const med = (a) => (a.length ? a[Math.floor(a.length * 0.5)] : 0)
      const out = []
      for (const ratio of [0.6, 1, 1.3, 1.6, 2, 2.5, 3]) {
        r.getCamera().setState({ ratio, x: 0.5, y: 0.5, angle: 0 })
        await raf()
        const nodes = g.nodes().map((k) => ({ k, d: r.getNodeDisplayData(k) }))
        const gone = new Set(nodes.filter((n) => (n.d?.opacity ?? 0) < 0.05).map((n) => n.k))
        const opas = nodes.map((n) => n.d?.opacity ?? 0).sort((a, b) => a - b)
        const smalls = nodes.filter((n) => (n.d?.size ?? 0) < 6).map((n) => n.d?.opacity ?? 0)
        let painted = 0
        let ghost = 0
        const edgeOpas = []
        for (const e of g.edges()) {
          const o = r.getEdgeDisplayData(e)?.opacity ?? 0
          if (o <= 0.02) continue
          painted++
          edgeOpas.push(o)
          const [a, b] = g.extremities(e)
          if (gone.has(String(a)) || gone.has(String(b))) ghost++
        }
        out.push({
          ratio,
          hidden: nodes.filter((n) => n.d?.visibility === 'hidden').length,
          gone: gone.size,
          speckMedian: +med(opas.filter((o) => o < 0.35)).toFixed(3),
          smallMedian: +med(smalls).toFixed(3),
          painted,
          ghost,
          edgeMedian: +med(edgeOpas).toFixed(3),
        })
      }
      return JSON.stringify(out)
    })()`,
  )
  process.stdout.write(`${JSON.stringify({ lod: asJson(lodLadder) }, null, 1)}\n`)
  for (const ratio of [1.5, 2]) {
    await evalJs(
      cdp,
      `(async () => {
        const r = window.__mapview.renderer
        r.getCamera().setState({ ratio: ${ratio}, x: 0.5, y: 0.5, angle: 0 })
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
        return 'ok'
      })()`,
    )
    await sleep(400)
    await shot(cdp, `zoom-${String(ratio).replace('.', '_')}`)
  }
  // Growth probe: the focused body used to jump to its boosted size in ONE frame
  // (`1.12` literal in the isHighlighted style). It must ramp instead: the drawn
  // quad size is sampled per frame on hover, on leave, and at staged ramp values.
  const growProbe = await evalJs(
    cdp,
    `(async () => {
      const mv = window.__mapview, g = mv.graph, r = mv.renderer
      const raf = () => new Promise((resolve) => requestAnimationFrame(resolve))
      const size = () => +(r.getNodeDisplayData(key)?.size ?? 0).toFixed(2)
      const frames = async (n) => { const out = []; for (let i = 0; i < n; i++) { await raf(); out.push(size()) } return out }
      const stats = (series) => ({
        first: series[0],
        last: series[series.length - 1],
        peak: Math.max(...series),
        steps: new Set(series).size,
        monotone: series.every((v, i) => i === 0 || v >= series[i - 1] - 0.02),
      })
      if (mv.pinnedId !== null) mv.pin(null)
      r.getCamera().setState({ ratio: 1, x: 0.5, y: 0.5, angle: 0 })
      const key = g.nodes().sort((a, b) => g.degree(b) - g.degree(a))[0]
      await frames(2)
      // Frame interval of THIS run: the shipped ramp is wall-clock 110ms, so the
      // report must say how many frames of animation that is here.
      const t0 = performance.now()
      await raf()
      const frameMs = +(performance.now() - t0).toFixed(1)
      // Start from idle: a warm subgraph would mask the entry animation.
      r.emit('leaveNode', { node: key })
      await new Promise((resolve) => setTimeout(resolve, 340))
      const base = size()
      // Sigma offsets a caption by half the node's QUAD (display size) + margin, so
      // any size change on the focused fan slides every connected word sideways.
      const nbList = g.neighbors(key)
      const snap = () => {
        const out = {}
        for (const n of nbList) {
          const d = r.getNodeDisplayData(n) || {}
          out[n] = [+(d.size ?? 0).toFixed(2), +(d.core ?? 0).toFixed(4)]
        }
        return out
      }
      const nbRest = snap()
      // Cost of the ONE call the animator makes per tween frame. If this is a
      // large share of the ramp duration, the ramp physically fits 1-2 frames and
      // the duration has to answer to the refresh, not to taste.
      const tRefresh = performance.now()
      r.refresh({ skipIndexation: true })
      const refreshMs = +(performance.now() - tRefresh).toFixed(1)
      // The hover path also runs scheduleLayout -> applyView: label collision
      // resolution plus another refresh. Time it: any stall here eats the ramp.
      const tView = performance.now()
      mv.applyView(r.getCamera().getState())
      const applyViewMs = +(performance.now() - tView).toFixed(1)
      const tStart = performance.now()
      r.emit('enterNode', { node: key })
      // The tween value and the drawn size side by side: a size that stays flat
      // while the value ramps means the STYLE is cached, not the tween.
      const tw0 = mv.animator.tweens && mv.animator.tweens.grow
        ? { dur: mv.animator.tweens.grow.dur, from: mv.animator.tweens.grow.from, to: mv.animator.tweens.grow.to }
        : null
      const pairs = []
      for (let i = 0; i < 14; i++) {
        await raf()
        pairs.push([mv.animator.value('grow'), size(), +(performance.now() - tStart).toFixed(0)])
      }
      const rise = pairs.map((pair) => pair[1])
      const tween = tw0
      // Style mapping, clock-independent: the ramp can be read at ANY point, so
      // the body is not limited to "rest" or "boosted".
      const mapped = []
      for (const v of [0, 0.25, 0.5, 0.75, 1]) { mv.animator.jump('grow', v); mapped.push(size()) }
      // Same field over 800ms: removes the frame-rate degeneracy of a 110ms tween
      // and shows the per-frame series a 60Hz display would produce.
      mv.animator.jump('grow', 0)
      mv.animator.to('grow', 1, 800)
      const slow = await frames(26)
      const nbFan = snap()
      r.emit('leaveNode', { node: key })
      const fall = await frames(26)
      return JSON.stringify({
        key,
        base,
        frameMs,
        refreshMs,
        applyViewMs,
        rise: { ...stats(rise), ratio: +(Math.max(...rise) / base).toFixed(3), frames: rise, pairs, tween },
        mapped,
        fan: (() => {
          const shifts = nbList.map((n) => ({
            n,
            shift: +(((nbFan[n][0] ?? 0) - (nbRest[n][0] ?? 0)) / 2).toFixed(2),
            restCore: nbRest[n][1],
            fanCore: nbFan[n][1],
          }))
          const moved = shifts.filter((x) => Math.abs(x.shift) > 0.5)
          const worst = [...shifts].sort((a, b) => Math.abs(b.shift) - Math.abs(a.shift))[0]
          const cores = shifts.map((x) => +((x.fanCore ?? 0) - (x.restCore ?? 0)).toFixed(3))
          return {
            count: shifts.length,
            shiftedOverHalfPx: moved.length,
            maxAbsShiftPx: worst ? Math.abs(worst.shift) : 0,
            worst,
            coreRamp: { min: Math.min(...cores), max: Math.max(...cores) },
          }
        })(),
        slow: stats(slow),
        fall: { ...stats(fall), frames: fall },
      })
    })()`,
  )
  process.stdout.write(`${JSON.stringify({ grow: asJson(growProbe) }, null, 1)}
`)
  // Focus probe: the selected word must take the top layer and the bodies touching
  // its disc must yield their opacity (so it is never crossed), both animated.
  const focusProbe = await evalJs(
    cdp,
    `(async () => {
      const mv = window.__mapview, g = mv.graph, r = mv.renderer
      const raf = () => new Promise((resolve) => requestAnimationFrame(resolve))
      const frames = async (n, read) => { const out = []; for (let i = 0; i < n; i++) { await raf(); out.push(read()) } return out }
      if (mv.pinnedId !== null) mv.pin(null)
      r.getCamera().setState({ ratio: 1, x: 0.5, y: 0.5, angle: 0 })
      const p0 = r.graphToViewport({ x: 0, y: 0 })
      const p1 = r.graphToViewport({ x: 1, y: 0 })
      const ppu = Math.hypot(p1.x - p0.x, p1.y - p0.y)
      // Same contact test the styles run: distance in px vs the two disc radii.
      const corePx = (k) => {
        const s = g.getNodeAttributes(k).size ?? 0
        return s <= 9 ? s : 9 + (s - 9) * 0.72
      }
      const neighboursOf = (k, ax, ay) => g.nodes()
        .filter((n) => n !== k)
        .map((n) => {
          const b = g.getNodeAttributes(n)
          return { n, d: Math.hypot(b.x - ax, b.y - ay) * ppu, own: corePx(n) }
        })
        .filter((x) => x.d <= corePx(k) * 1.15 + x.own)
        .sort((x, y) => x.d - y.d)
      // The most crowded word on the map: the one whose disc is touched by the most
      // bodies — that is the situation the report is about.
      const ranked = g.nodes().map((k) => {
        const at = g.getNodeAttributes(k)
        return { k, crowd: neighboursOf(k, at.x, at.y).length }
      }).sort((x, y) => y.crowd - x.crowd)
      const key = ranked[0].k
      const a = g.getNodeAttributes(key)
      const touching = () => neighboursOf(key, a.x, a.y)
      r.emit('leaveNode', { node: key })
      await new Promise((resolve) => setTimeout(resolve, 340))
      const near = touching()
      // Closest body = the one the yield should hit hardest.
      const witness = near.length ? near[0].n : null
      const readW = () => +(r.getNodeDisplayData(witness)?.opacity ?? 0).toFixed(3)
      const crowdLabel = ranked.slice(0, 3).map((x) => [x.k, x.crowd])
      const restOpacity = readW()
      r.emit('enterNode', { node: key })
      const rise = await frames(18, readW)
      await new Promise((resolve) => setTimeout(resolve, 250))
      const settled = {
        depth: r.getNodeDisplayData(key)?.depth,
        witness: readW(),
        touching: near.length,
        closestDistPx: near.length ? +near[0].d.toFixed(1) : null,
        opacities: near.map((x) => +(r.getNodeDisplayData(x.n)?.opacity ?? 0).toFixed(2)).sort((x, y) => x - y),
      }
      r.emit('leaveNode', { node: key })
      const fall = await frames(22, readW)
      await new Promise((resolve) => setTimeout(resolve, 250))
      return JSON.stringify({
        key,
        witness,
        touching: near.length,
        crowdLabel,
        restOpacity,
        rise,
        settled: { ...settled, opacities: settled.opacities.slice(0, 12) },
        fall,
        after: { opacity: readW(), depth: r.getNodeDisplayData(key)?.depth },
      })
    })()`,
  )
  process.stdout.write(`${JSON.stringify({ focus: asJson(focusProbe) }, null, 1)}
`)
  // Gap probe: the real paper between drawn bodies. Node radii are screen px, so
  // the only honest measure is the same one the eye uses: distance on screen
  // minus the two visible auras. Negative = rings overlap.
  const gaps = await evalJs(
    cdp,
    `(async () => {
      const mv = window.__mapview, g = mv.graph, r = mv.renderer
      const raf = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      const q = (a, t) => (a.length ? a[Math.min(a.length - 1, Math.floor(a.length * t))] : 0)
      const run = async (ratio) => {
        r.getCamera().setState({ ratio, x: 0.5, y: 0.5, angle: 0 })
        await raf()
        const keys = g.nodes()
        const pts = keys.map((k) => {
          const a = g.getNodeAttributes(k)
          const p = r.graphToViewport({ x: a.x, y: a.y })
          const d = r.getNodeDisplayData(k)
          return { k, x: p.x, y: p.y, quad: (d?.size ?? 0) / 2 }
        })
        const dists = []
        const gapsArr = []
        const ratios = []
        let overlap = 0
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
        for (let i = 0; i < pts.length; i++) {
          const a = pts[i]
          minX = Math.min(minX, a.x); maxX = Math.max(maxX, a.x)
          minY = Math.min(minY, a.y); maxY = Math.max(maxY, a.y)
          let best = Infinity, bj = -1
          for (let j = 0; j < pts.length; j++) {
            if (i === j) continue
            const d = Math.hypot(pts[j].x - a.x, pts[j].y - a.y)
            if (d < best) { best = d; bj = j }
          }
          if (bj < 0) continue
          const b = pts[bj]
          const free = best - a.quad - b.quad
          dists.push(best)
          gapsArr.push(free)
          ratios.push(best / Math.max(0.001, a.quad + b.quad))
          if (free < 0) overlap++
        }
        const bySize = (t) => q(dists.filter((d, i) => pts[i].quad < 12).sort((x, y) => x - y), t)
        return {
          ratio,
          order: pts.length,
          aspect: +((maxX - minX) / Math.max(1, maxY - minY)).toFixed(2),
          nnPx: [q(dists, 0.1), q(dists, 0.5), q(dists, 0.9)].map((v) => +v.toFixed(1)),
          smallNnPx: [+bySize(0.1).toFixed(1), +bySize(0.5).toFixed(1)],
          gapPx: [q(gapsArr, 0.1), q(gapsArr, 0.5), q(gapsArr, 0.9)].map((v) => +v.toFixed(1)),
          minGap: +Math.min(...gapsArr).toFixed(1),
          laneRatio: [+q(ratios, 0.1).toFixed(2), +q(ratios, 0.5).toFixed(2)],
          overlapShare: +(overlap / Math.max(1, gapsArr.length)).toFixed(2),
        }
      }
      return JSON.stringify({ at1: await run(1), at06: await run(0.6), at15: await run(1.5) })
    })()`,
  )
  process.stdout.write(`${JSON.stringify({ gaps: asJson(gaps) }, null, 1)}\n`)
  process.stdout.write(`${JSON.stringify({ fan: { close: fanClose, wide: fanWide }, cleared: asJson(cleared) }, null, 1)}
`)
  cdp.close()
  chrome.kill()
  process.exit(0)
}

main().catch((err) => {
  console.error('FAIL', err.message)
  chrome.kill()
  process.exit(1)
})
