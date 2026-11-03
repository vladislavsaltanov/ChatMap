import Graph from 'graphology'
import Sigma from 'sigma'
import { downloadAsPNG } from '@sigma/export-image'
import { edgeColor, edgeWidth } from '../core/geometry'
import type { AuthorId, MapMsg } from '../core/types'
import { buildNodeDetails, getLabelOverrides, NodePanel } from './nodepanel'
import { MAP_SIGMA_SETTINGS, MAP_SIGMA_STYLES } from './mapStyles'
import type { CustomEdgeState, CustomGraphState, CustomNodeState } from './mapStyles'

export class MapView {
  private container: HTMLElement
  private hoverLine: HTMLElement
  private progressEl: HTMLElement
  private graph: Graph
  private renderer: Sigma<any, any, any, CustomNodeState, CustomEdgeState, CustomGraphState> | null = null
  private pinnedId: number | null = null
  private activeNodes: string[] = []
  private activeEdges: string[] = []
  private pinCallbacks: Array<(id: number | null) => void> = []
  private authorColors = new Map<AuthorId, string>()
  private nodePanel: NodePanel
  private lastMsg: MapMsg | null = null

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
        backgroundColor: '#161619',
        width: 2560,
        height: 1440,
      })
    })

    zoomInBtn.addEventListener('click', () => this.renderer?.getCamera().zoomIn())
    zoomOutBtn.addEventListener('click', () => this.renderer?.getCamera().zoomOut())
    zoomResetBtn.addEventListener('click', () => this.renderer?.getCamera().reset())

    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.pinnedId !== null) {
        this.pin(null)
      }
    })
  }

  private clearActiveSubgraph(): void {
    for (const n of this.activeNodes) {
      if (this.graph.hasNode(n)) {
        this.renderer?.setNodeState(n, { isActive: false, isHighlighted: false })
      }
    }
    for (const e of this.activeEdges) {
      if (this.graph.hasEdge(e)) {
        this.renderer?.setEdgeState(e, { isActive: false })
      }
    }
    this.activeNodes = []
    this.activeEdges = []
  }

  // Highlights `key` plus its `topN` strongest neighbours (by edge weight) and their edges
  private activateSubgraph(key: string, topN: number): void {
    this.renderer?.setNodeState(key, { isActive: true, isHighlighted: true })
    this.activeNodes.push(key)
    const neighborsWithWeights: Array<{ neighbor: string; edge: string; weight: number }> = []
    for (const neighbor of this.graph.neighbors(key)) {
      const edge = this.graph.edge(key, neighbor)
      if (edge) {
        const weight = (this.graph.getEdgeAttribute(edge, 'weight') as number) || 1
        neighborsWithWeights.push({ neighbor, edge, weight })
      }
    }
    neighborsWithWeights.sort((a, b) => b.weight - a.weight)
    for (const conn of neighborsWithWeights.slice(0, topN)) {
      this.renderer?.setNodeState(conn.neighbor, { isActive: true })
      this.renderer?.setEdgeState(conn.edge, { isActive: true })
      this.activeNodes.push(conn.neighbor)
      this.activeEdges.push(conn.edge)
    }
    this.renderer?.setGraphState({ hasActiveSubgraph: true })
  }

  private initRenderer(): void {
    if (this.renderer) return

    this.renderer = new Sigma(this.graph, this.container, {
      settings: MAP_SIGMA_SETTINGS,
      customNodeState: { isActive: false },
      customEdgeState: { isActive: false },
      customGraphState: { hasActiveSubgraph: false },
      styles: MAP_SIGMA_STYLES,
    })

    this.renderer.on('enterNode', ({ node }) => {
      const attrs = this.graph.getNodeAttributes(node)
      this.hoverLine.textContent = `${attrs.label} · ${attrs.count}`

      if (this.pinnedId === null) {
        this.clearActiveSubgraph()
        this.activateSubgraph(node, 8)
        this.renderer?.refresh({ skipIndexation: true })
      }
    })

    this.renderer.on('leaveNode', () => {
      if (this.pinnedId === null) {
        this.hoverLine.textContent = 'слово · 0'
        this.clearActiveSubgraph()
        this.renderer?.setGraphState({ hasActiveSubgraph: false })
        this.renderer?.refresh({ skipIndexation: true })
      } else {
        const key = String(this.pinnedId)
        if (this.graph.hasNode(key)) {
          const attrs = this.graph.getNodeAttributes(key)
          this.hoverLine.textContent = `${attrs.label} · ${attrs.count}`
        }
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
    this.activeNodes = []
    this.activeEdges = []
    const overrides = getLabelOverrides()

    for (const node of msg.nodes) {
      const color = this.authorColors.get(node.authorLead) || '#7890cd'
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
        const edgeSize = Math.max(0.6, 0.6 + w * 4.5)
        const color = edgeColor(edge.weight, msg.maxWeight)
        this.graph.addEdge(a, b, {
          size: edgeSize,
          color,
          weight: edge.weight,
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

    this.clearActiveSubgraph()

    if (id !== null && this.graph.hasNode(String(id))) {
      const key = String(id)
      this.activateSubgraph(key, 12)
      const attrs = this.graph.getNodeAttributes(key)
      this.hoverLine.textContent = `${attrs.label} · ${attrs.count}`

      const details = buildNodeDetails(this.graph, id, this.lastMsg?.forms?.get(id) || [])
      if (details) {
        this.nodePanel.show(details)
      }
    } else {
      this.renderer.setGraphState({ hasActiveSubgraph: false })
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

let mapInstance: MapView | null = null

export function renderMap(root: HTMLElement): MapView {
  if (!mapInstance) {
    mapInstance = new MapView(root)
  }
  return mapInstance
}
