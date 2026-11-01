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

const worker = new Worker()

const mapView = renderMap(screens.map)
const controls = renderControls(screens.map)

controls.onChange((cfg) => {
  worker.postMessage({ type: 'update', cfg } satisfies WorkerIn)
})

controls.onColorChange((colors) => {
  mapView.renderAuthors(colors)
})

worker.onmessage = (e: MessageEvent<WorkerOut>) => {
  const msg = e.data
  if (msg.type === 'progress') {
    updateProgress(msg.done, msg.total, msg.stage)
  } else if (msg.type === 'ready') {
    controls.setAuthors(msg.authors)
  } else if (msg.type === 'map') {
    show('map')
    requestAnimationFrame(() => {
      mapView.render(msg)
    })
  } else if (msg.type === 'error') {
    showError(msg.message)
  }
}

function sendFile(file: File) {
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
    const text = reader.result as string
    worker.postMessage({ type: 'open', json: text } satisfies WorkerIn)
  }
  reader.onerror = () => {
    showError('Не удалось прочитать файл.')
  }
  reader.readAsText(file)
}

renderLanding(screens.landing, sendFile, () => {})
renderProgress(screens.progress)

show('landing')

// Dev mode: ?fixture=1 loads synthetic test fixture
if (location.search.includes('fixture=1')) {
  import('../tests/fixtures/sample-export.json').then((module) => {
    show('progress')
    worker.postMessage({
      type: 'open',
      json: JSON.stringify(module.default),
    } satisfies WorkerIn)
  })
}
