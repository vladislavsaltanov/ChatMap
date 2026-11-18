import './styles/fonts.css'
import './styles/tokens.css'
import './styles/base.css'
import './styles/map.css'
import { renderLanding } from './ui/landing'
import { renderProgress, updateProgress } from './ui/progress'
import { renderMap } from './ui/mapview'
import { renderControls } from './ui/controls'
import { renderTimeline } from './ui/timeline'
import type { WorkerIn, WorkerOut } from './core/types'

import Worker from './core/worker.ts?worker'

type Screen = 'landing' | 'progress' | 'map'

const screens: Record<Screen, HTMLElement> = {
  landing: document.querySelector<HTMLElement>('#landing')!,
  progress: document.querySelector<HTMLElement>('#progress')!,
  map: document.querySelector<HTMLElement>('#map')!,
}

const errorDialog = document.querySelector<HTMLDialogElement>('#error')!
const errorText = document.querySelector<HTMLElement>('#error-text')!

function showError(message: string): void {
  errorText.textContent = message
  errorDialog.showModal()
  show('landing')
}

export function show(screen: Screen): void {
  for (const id of Object.keys(screens) as Screen[]) {
    screens[id].hidden = id !== screen
  }
}

const warnBanner = document.createElement('div')
warnBanner.id = 'warn-banner'
warnBanner.className = 'warn-banner'
warnBanner.setAttribute('role', 'status')
warnBanner.hidden = true
document.querySelector('main')!.prepend(warnBanner)

let warnings: string[] = []

function clearWarnings(): void {
  warnings = []
  warnBanner.hidden = true
}

function addWarning(msg: string): void {
  if (!warnings.includes(msg)) warnings.push(msg)
  warnBanner.textContent = warnings.join(' · ')
  warnBanner.hidden = false
}

const worker = new Worker()

// Pinned layout seed from ?seed= (stand calibration, reproducible maps).
// Absent or non-numeric = the worker rolls its own per open.
const openSeed = ((): number | undefined => {
  const raw = new URLSearchParams(location.search).get('seed')
  if (raw === null || raw.trim() === '') return undefined
  const parsed = Number.parseInt(raw, 10)
  return Number.isInteger(parsed) ? parsed : undefined
})()

// Sigma v4 rasterises label glyphs into an SDF atlas with canvas 2D exactly
// once and caches them forever. If Obel Mono is not loaded before the renderer
// is created, the atlas permanently bakes a system fallback instead. Weight 400
// is loaded for the DOM interface, where Obel Mono is lighter than the captions.
const nodeFontsReady = Promise.all([
  document.fonts.load('400 16px "Obel Mono"'),
  document.fonts.load('700 32px "Obel Mono"'),
  document.fonts.load('900 32px "Obel Mono"'),
]).catch(() => undefined)

const mapView = renderMap(screens.map)
const controls = renderControls(screens.map)
// Mounted after the map and the drawer: as the LAST flex child of #map the strip
// sits under the canvas, so the canvas shrinks by its height instead of being
// covered by it.
const timeline = renderTimeline(screens.map)

// Latest-wins slice pump. The strip emits at most one bucket per 150ms, but a frame
// costs more than that, so requests are coalesced HERE instead of inside the worker:
// one request in flight, the newest cursor replaces the queued one, and the queue is
// drained when the answer lands. `pendingBucket === null` means nothing is owed.
let sliceInFlight = false
let pendingBucket: number | null = null
// Last toggle state. A meta answer can arrive after the user switched the strip off
// again (the request was already in flight): the reply must not resurrect it.
let timelineWanted = false

function pumpSlice(): void {
  if (sliceInFlight || pendingBucket === null) return
  const bucket = pendingBucket
  pendingBucket = null
  sliceInFlight = true
  worker.postMessage({ type: 'slice', bucket } satisfies WorkerIn)
}

function requestSlice(bucket: number): void {
  pendingBucket = bucket
  pumpSlice()
}

// [Command] Drop the strip and every owed slice. Used when the chat the strip
// describes is replaced or lost: the meta would otherwise outlive its file, and an
// un-answered request would leave the pump marked busy forever.
function resetTimeline(): void {
  timeline.hide()
  controls.setTimelineChecked(false)
  timelineWanted = false
  sliceInFlight = false
  pendingBucket = null
}

controls.onChange((cfg) => {
  if (!screens.map.hidden) mapView.showProgress(75, 100, 'Выборка узлов и рёбер...')
  worker.postMessage({ type: 'update', cfg } satisfies WorkerIn)
})

controls.onColorChange((colors) => {
  mapView.renderAuthors(colors)
})

controls.onLegendChange((visible) => {
  mapView.setLegendVisible(visible)
})

controls.onTimelineChange((enabled) => {
  timelineWanted = enabled
  if (enabled) {
    // The strip appears on the meta answer and starts at the last bucket, which is
    // the frame already on screen (whole history): enabling slices nothing.
    worker.postMessage({ type: 'timelineOn' } satisfies WorkerIn)
    return
  }
  // Off restores the whole-history view: pin the LAST bucket (not the cursor — the
  // cursor may sit mid-history), drop whatever was queued and hide at once.
  const ready = timeline.metaReady()
  const last = timeline.lastBucket()
  timeline.hide()
  // Guard: a toggle that never got an eligible meta (a too-short chat) has no
  // history to restore, and bucket 0 would paint a frame nobody asked for.
  if (!ready) return
  pendingBucket = null
  requestSlice(last)
})

timeline.onBucket((bucket) => requestSlice(bucket))

worker.onmessage = async (e: MessageEvent<WorkerOut>) => {
  const msg = e.data
  if (msg.type === 'progress') {
    updateProgress(msg.done, msg.total, msg.stage)
    if (!screens.map.hidden && msg.done < msg.total) mapView.showProgress(msg.done, msg.total, msg.stage)
  } else if (msg.type === 'ready') {
    controls.setAuthors(msg.authors)
  } else if (msg.type === 'map') {
    await nodeFontsReady
    show('map')
    requestAnimationFrame(() => {
      mapView.render(msg)
      mapView.hideProgress()
      // A filter rebuild redraws the whole history. If the strip is up and its cursor
      // sits in the past, ask for that bucket again so the readout and the map keep
      // telling one story; a cursor already at the last bucket IS this map, so it
      // costs nothing. The pump coalesces this with any scrub already in flight.
      if (timeline.metaReady() && timeline.currentBucket() !== timeline.lastBucket()) {
        requestSlice(timeline.currentBucket())
      }
    })
  } else if (msg.type === 'timelineMeta') {
    // Guard: the toggle may have been switched off while this answer was in flight.
    if (!timelineWanted) return
    if (!msg.eligible) {
      // A chat with too few buckets (or an unusable date range) refuses the toggle:
      // the checkbox unchecks itself, so the refusal is visible instead of a strip
      // that would only be decoration.
      timelineWanted = false
      controls.setTimelineChecked(false)
      return
    }
    timeline.show(msg)
  } else if (msg.type === 'slice') {
    mapView.applySlice(msg)
    sliceInFlight = false
    // Latest-wins: the cursor may have moved while this frame computed. A request
    // for the bucket just applied is dropped; anything newer goes out now.
    if (pendingBucket === msg.bucket) pendingBucket = null
    pumpSlice()
  } else if (msg.type === 'warn') {
    addWarning(msg.message)
  } else if (msg.type === 'error') {
    // Only an open can fail with the progress screen up, and the worker has
    // already dropped its chat at that point. Drop the view with it, otherwise
    // the next filter change lands in a worker that silently ignores it.
    if (!screens.progress.hidden) {
      mapView.clear()
      controls.setAuthors([])
    }
    // The strip outlives no error: its meta describes the chat that just failed,
    // and a slice that never got its answer would keep the pump "in flight"
    // forever. Reset both here, on every error, not only when the map was dropped.
    resetTimeline()
    showError(msg.message)
  }
}

function sendFile(file: File) {
  clearWarnings()
  // A new chat invalidates the strip's meta: drop it before the open so a stale
  // spectrum can never outlive the file it described.
  resetTimeline()
  if (file.size > 500 * 1024 * 1024) {
    showError('Файл больше 500 МБ. Экспортируй один чат без медиа.')
    return
  }
  if (file.size > 200 * 1024 * 1024) {
    addWarning('Файл больше 200 МБ. Обработка может занять продолжительное время.')
  }
  show('progress')
  updateProgress(1, 100, 'Чтение файла с диска...')
  const reader = new FileReader()
  reader.onprogress = (e) => {
    if (e.lengthComputable && e.total > 0) {
      const pct = Math.max(1, Math.round((e.loaded / e.total) * 5))
      updateProgress(pct, 100, 'Чтение файла с диска...')
    }
  }
  reader.onload = () => {
    // Transfer, not copy: the buffer moves to the worker, so a 200 MB file
    // lives in memory once instead of twice (string + structured-clone).
    const buf = reader.result as ArrayBuffer
    worker.postMessage({ type: 'open', buf, seed: openSeed } satisfies WorkerIn, [buf])
  }
  reader.onerror = () => {
    showError('Не удалось прочитать файл.')
  }
  reader.readAsArrayBuffer(file)
}

renderLanding(screens.landing, sendFile, addWarning)
renderProgress(screens.progress)

show('landing')

// Dev mode: ?fixture=1 loads synthetic test fixture
if (import.meta.env.DEV && location.search.includes('fixture=1')) {
  import('../tests/fixtures/sample-export.json').then((module) => {
    show('progress')
    const bytes = new TextEncoder().encode(JSON.stringify(module.default))
    worker.postMessage({
      type: 'open',
      buf: bytes.buffer as ArrayBuffer,
      seed: openSeed,
    } satisfies WorkerIn, [bytes.buffer as ArrayBuffer])
  })
}
