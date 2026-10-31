import './styles/tokens.css'
import './styles/base.css'
import './styles/map.css'
import { renderLanding } from './ui/landing'
import { renderProgress } from './ui/progress'
import { renderMap } from './ui/mapview'
import { renderControls } from './ui/controls'

type Screen = 'landing' | 'progress' | 'map'

const screens: Record<Screen, HTMLElement> = {
  landing: document.querySelector<HTMLElement>('#landing')!,
  progress: document.querySelector<HTMLElement>('#progress')!,
  map: document.querySelector<HTMLElement>('#map')!,
}

function show(screen: Screen): void {
  for (const id of Object.keys(screens) as Screen[]) {
    screens[id].hidden = id !== screen
  }
}

renderLanding(screens.landing)
renderProgress(screens.progress)
renderMap(screens.map)
renderControls(screens.map)

const hash = location.hash.slice(1)
show(hash === 'progress' || hash === 'map' ? hash : 'landing')
