import './styles/fonts.css'
import './styles/tokens.css'
import './styles/base.css'
import './styles/map.css'
import { renderLanding } from './ui/landing'
import { renderProgress, updateProgress } from './ui/progress'
import { renderMap } from './ui/mapview'
import { renderControls } from './ui/controls'
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
    })
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
    showError(msg.message)
  }
}

function sendFile(file: File) {
  clearWarnings()
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
