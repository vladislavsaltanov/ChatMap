import Graph from 'graphology'
import Sigma from 'sigma'
import { pathCurved, pathLine } from 'sigma/rendering'
import { downloadAsPNG } from '@sigma/export-image'
import { edgeColor, edgeWidth } from '../core/geometry'
import type { AuthorId, MapMsg } from '../core/types'
import { buildNodeDetails, getLabelOverrides, NodePanel } from './nodepanel'
import { MAP_SIGMA_SETTINGS, MAP_SIGMA_STYLES } from './mapStyles'
import { SubgraphAnimator } from './subgraphAnim'
import { SubgraphHighlight } from './subgraphHighlight'
import type { CustomEdgeState, CustomGraphState, CustomNodeState } from './mapStyles'

export class MapView {
  private container: HTMLElement
  private hoverLine: HTMLElement
  private progressEl: HTMLElement
  private graph: Graph
  private renderer: Sigma<any, any, any, CustomNodeState, CustomEdgeState, CustomGraphState> | null = null
  private pinnedId: number | null = null
  private highlight: SubgraphHighlight
  private pinCallbacks: Array<(id: number | null) => void> = []
  private authorColors = new Map<AuthorId, string>()
  private nodePanel: NodePanel
  private lastMsg: MapMsg | null = null
  private subgraphKey: string | null = null
  private lodTimer: number | null = null
  private animator = new SubgraphAnimator((v) => {
    this.renderer?.setGraphState({ dimAlpha: v.dim, focusAlpha: v.focus })
    this.renderer?.refresh({ skipIndexation: true })
  })

  private labelLine(id: number): string {
    const key = String(id)
    if (!this.graph.hasNode(key)) return 'слово · 0'
    const attrs = this.graph.getNodeAttributes(key)
    return `${attrs.label} · ${attrs.count}`
  }

  // Плавный выход в холостое состояние: подсветка деградает за 140–170 мс,
  // состояния подграфа снимаются в конце затухания, чтобы кольцо не исчезало рывком.
  private fadeToIdle(): void {
    this.subgraphKey = null
    this.animator.to('focus', 0, 130)
    this.animator.to('dim', 0, 170, () => {
      if (this.subgraphKey === null) {
        this.highlight.clear(this.renderer)
        this.renderer?.setGraphState({ hasActiveSubgraph: false })
        this.renderer?.refresh({ skipIndexation: true })
      }
    })
  }

  constructor(root: HTMLElement) {
    root.innerHTML = `
      <div class="canvas" role="img" aria-label="Карта слов"><div class="map-progress" hidden></div></div>
      <div class="map-controls">
        <button type="button" id="export-png" aria-label="Экспорт в PNG" class="num">PNG</button>
        <button type="button" id="zoom-in" aria-label="Приблизить">+</button>
        <button type="button" id="zoom-out" aria-label="Отдалить">−</button>
        <button type="button" id="zoom-reset" aria-label="В центр">⊙</button>
      </div>
      <p class="hover-line label">слово · 0</p>
    `

    this.container = root.querySelector<HTMLElement>('.canvas')!
    this.hoverLine = root.querySelector<HTMLElement>('.hover-line')!
    this.progressEl = this.container.querySelector<HTMLElement>('.map-progress')!
    this.container.addEventListener('webglcontextlost', (e) => {
      e.preventDefault()
      this.hoverLine.textContent = 'WebGL-контекст потерян — обнови страницу'
    }, true)
    this.graph = new Graph()
    this.highlight = new SubgraphHighlight(this.graph)
    this.nodePanel = new NodePanel(root)

    this.nodePanel.onSelect((id) => {
      this.pin(id === -1 ? null : id)
    })

    this.nodePanel.onOverride((id, label) => {
      const key = String(id)
      if (this.graph.hasNode(key)) {
        this.graph.setNodeAttribute(key, 'label', label)
        this.renderer?.refresh()
        const attrs = this.graph.getNodeAttributes(key)
        this.hoverLine.textContent = `${label} · ${attrs.count}`
      }
    })

    const exportPngBtn = root.querySelector<HTMLButtonElement>('#export-png')!
    const zoomInBtn = root.querySelector<HTMLButtonElement>('#zoom-in')!
    const zoomOutBtn = root.querySelector<HTMLButtonElement>('#zoom-out')!
    const zoomResetBtn = root.querySelector<HTMLButtonElement>('#zoom-reset')!

    exportPngBtn.addEventListener('click', async () => {
      if (!this.renderer || this.graph.order === 0) return
      const isoDate = new Date().toISOString().slice(0, 10)
      await downloadAsPNG(this.renderer as any, {
        fileName: `chatmap-${isoDate}`,
        backgroundColor: '#1d1c19',
        width: 2560,
        height: 1440,
      })
    })

    zoomInBtn.addEventListener('click', () => this.renderer?.getCamera().zoomIn({ duration: 260 }))
    zoomOutBtn.addEventListener('click', () => this.renderer?.getCamera().zoomOut({ duration: 260 }))
    zoomResetBtn.addEventListener('click', () => this.renderer?.getCamera().reset({ duration: 320 }))

    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.pinnedId !== null) {
        this.pin(null)
      }
    })
  }

  private focusSubgraph(key: string, topN: number): void {
    this.highlight.swap(this.renderer, key, topN)
    this.animator.to('focus', 1, 140)
    this.animator.to('dim', 1, 180)
  }

  private initRenderer(): void {
    if (this.renderer) return

    this.renderer = new Sigma(this.graph, this.container, {
      // Нити-дуги: line даже не нужен напрямую, но держим первым для дефолта
      primitives: {
        edges: { paths: [pathLine(), pathCurved()] },
      },
      settings: MAP_SIGMA_SETTINGS,
      customNodeState: { isActive: false },
      customEdgeState: { isActive: false },
      customGraphState: { hasActiveSubgraph: false, dimAlpha: 0, focusAlpha: 0, lodRatio: 1 },
      styles: MAP_SIGMA_STYLES,
    })

    // LOD (реф 1): ratio камеры > 1 гасит мелкие пузыри к точкам. Обновляем
    // graph-state после успокоения камеры — не на каждый кадр зума.
    this.renderer.getCamera().on('updated', () => {
      const ratio = this.renderer?.getCamera().getState().ratio ?? 1
      if (this.lodTimer !== null) window.clearTimeout(this.lodTimer)
      this.lodTimer = window.setTimeout(() => {
        this.lodTimer = null
        if (!this.renderer) return
        const applied = this.renderer.getGraphState().lodRatio ?? 1
        if (Math.abs(ratio - applied) / Math.max(ratio, applied) < 0.08) return
        this.renderer.setGraphState({ lodRatio: ratio })
        this.renderer.refresh({ skipIndexation: true })
      }, 140)
    })
    if (import.meta.env.DEV) {
      // SAFETY: window не типизирован под наш dev-хэндл; единственный каст —
      // присвоение глобальной ссылки Sigma-рендерера для отладки из консоли
      const devWindow = window as unknown as { __mapview?: MapView }
      devWindow.__mapview = this
    }

    this.renderer.on('enterNode', ({ node }) => {
      this.hoverLine.textContent = this.labelLine(Number(node))
      if (this.pinnedId === null && this.subgraphKey !== node) {
        this.subgraphKey = node
        this.focusSubgraph(node, 8)
      }
    })

    this.renderer.on('leaveNode', () => {
      if (this.pinnedId === null) {
        this.hoverLine.textContent = 'слово · 0'
        if (this.subgraphKey !== null) this.fadeToIdle()
      }
    })

    this.renderer.on('clickNode', ({ node }) => this.pin(this.pinnedId === Number(node) ? null : Number(node)))
    this.renderer.on('clickStage', () => {
      if (this.pinnedId !== null) this.pin(null)
    })
  }

  render(msg: MapMsg): void {
    this.lastMsg = msg
    this.graph.clear()
    this.highlight.reset()
    const overrides = getLabelOverrides()

    for (const node of msg.nodes) {
      const color = this.authorColors.get(node.authorLead) || '#b8b2a6'
      const label = overrides[node.canon] || node.label
      this.graph.addNode(String(node.id), {
        label,
        defaultLabel: node.label,
        canon: node.canon,
        x: node.x,
        y: node.y,
        size: node.size,
        color,
        count: node.count,
        authorLead: node.authorLead,
      })
    }

    for (const edge of msg.edges) {
      const a = String(edge.a)
      const b = String(edge.b)
      if (this.graph.hasNode(a) && this.graph.hasNode(b) && !this.graph.hasEdge(a, b)) {
        const w = edgeWidth(edge.weight, msg.maxWeight)
        const edgeSize = Math.max(0.3, 0.3 + w * 0.9)
        const lead = this.graph.getNodeAttribute(a, 'authorLead') as AuthorId | undefined
        const tint = (lead !== undefined && this.authorColors.get(lead)) || '#b8b2a6'
        const color = edgeColor(edge.weight, msg.maxWeight, tint)
        this.graph.addEdge(a, b, {
          size: edgeSize,
          color,
          weight: edge.weight,
          curvature: edgeCurvature(edge.a, edge.b),
        })
      }
    }

    if (!this.renderer) {
      this.initRenderer()
    } else {
      this.renderer.refresh()
    }

    if (this.pinnedId !== null) {
      this.pin(this.pinnedId)
    } else {
      this.renderer?.getCamera().reset()
    }
  }

  renderAuthors(colors: Map<AuthorId, string>): void {
    this.authorColors = colors
    for (const nodeKey of this.graph.nodes()) {
      const attrs = this.graph.getNodeAttributes(nodeKey)
      const authorLead = attrs.authorLead as AuthorId | undefined
      if (authorLead !== undefined && this.authorColors.has(authorLead)) {
        this.graph.setNodeAttribute(nodeKey, 'color', this.authorColors.get(authorLead)!)
      }
    }
    this.renderer?.refresh()
  }

  pin(id: number | null): void {
    this.pinnedId = id
    if (!this.renderer) return

    if (id !== null && this.graph.hasNode(String(id))) {
      const key = String(id)
      this.subgraphKey = key
      this.focusSubgraph(key, 12)
      this.hoverLine.textContent = this.labelLine(id)

      const details = buildNodeDetails(this.graph, id, this.lastMsg?.forms?.get(id) || [])
      if (details) {
        this.nodePanel.show(details)
      }
    } else {
      this.fadeToIdle()
      this.hoverLine.textContent = 'слово · 0'
      this.nodePanel.hide()
    }

    this.renderer.refresh({ skipIndexation: true })
    for (const cb of this.pinCallbacks) {
      cb(this.pinnedId)
    }
  }

  onPin(cb: (id: number | null) => void): void {
    this.pinCallbacks.push(cb)
  }

  public showProgress(done: number, total: number, stage?: string): void {
    const pct = Math.min(100, Math.max(0, Math.round((done / Math.max(1, total)) * 100)))
    this.container.setAttribute('aria-busy', 'true')
    this.progressEl.hidden = false
    this.progressEl.style.width = `${pct}%`
    this.hoverLine.textContent = stage
      ? `Обновление · ${stage.replace(/\.\.\.$/, '')} · ${pct}%`
      : `Обновление · ${pct}%`
  }

  public hideProgress(): void {
    this.progressEl.hidden = true
    this.progressEl.style.width = '0%'
    this.container.removeAttribute('aria-busy')
    if (this.pinnedId !== null && this.graph.hasNode(String(this.pinnedId))) {
      const attrs = this.graph.getNodeAttributes(String(this.pinnedId))
      this.hoverLine.textContent = `${attrs.label} · ${attrs.count}`
    } else {
      this.hoverLine.textContent = 'слово · 0'
    }
  }

  getRenderer(): Sigma<any, any, any, any, any, any> | null {
    return this.renderer
  }
}

// Детерминированный хэш (a, b) → знак и амплитуда дуги (рефы 1 и 4: все нити —
// плавные кривые). Параллельные рёбра расходятся спредом sigma.
function edgeCurvature(a: number, b: number): number {
  const h =
    (Math.imul(a, 0x9e3779b1) ^
      Math.imul(b, 0x85ebca6b) ^
      Math.imul(a ^ b, 0xc2b2ae35)) >>>
    0
  const mag = 0.08 + 0.16 * (((h >>> 8) % 32) / 32)
  return (h & 1) === 0 ? mag : -mag
}

let mapInstance: MapView | null = null

export function renderMap(root: HTMLElement): MapView {
  if (!mapInstance) {
    mapInstance = new MapView(root)
  }
  return mapInstance
}
