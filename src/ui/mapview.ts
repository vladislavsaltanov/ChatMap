import Graph from 'graphology'
import Sigma from 'sigma'
import { downloadAsPNG } from '@sigma/export-image'
import { edgeWidth } from '../core/geometry'
import type { AuthorId, MapMsg } from '../core/types'
import { getLabelOverrides, NodePanel, type NodeDetails } from './nodepanel'

const DIM = '#2e2e34'

type CustomNodeState = { isActive: boolean }
type CustomEdgeState = { isActive: boolean }
type CustomGraphState = { hasActiveSubgraph: boolean }

export class MapView {
  private container: HTMLElement
  private hoverLine: HTMLElement
  private graph: Graph
  private renderer: Sigma<any, any, any, CustomNodeState, CustomEdgeState, CustomGraphState> | null = null
  private pinnedId: number | null = null
  private pinCallbacks: Array<(id: number | null) => void> = []
  private authorColors = new Map<AuthorId, string>()
  private nodePanel: NodePanel
  private lastMsg: MapMsg | null = null

  constructor(root: HTMLElement) {
    root.innerHTML = `
      <div class="canvas" role="img" aria-label="Карта слов"></div>
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
        cameraState: { x: 0.5, y: 0.5, ratio: 1, angle: 0 },
      })
    })

    zoomInBtn.addEventListener('click', () => {
      this.renderer?.getCamera().zoomIn()
    })
    zoomOutBtn.addEventListener('click', () => {
      this.renderer?.getCamera().zoomOut()
    })
    zoomResetBtn.addEventListener('click', () => {
      this.renderer?.getCamera().reset()
    })

    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.pinnedId !== null) {
        this.pin(null)
      }
    })
  }

  private initRenderer(): void {
    if (this.renderer) return

    this.renderer = new Sigma(this.graph, this.container, {
      settings: { allowInvalidContainer: true },
      customNodeState: { isActive: false },
      customEdgeState: { isActive: false },
      customGraphState: { hasActiveSubgraph: false },
      styles: {
        nodes: [
          {
            color: { attribute: 'color' },
            size: { attribute: 'size' },
            label: { attribute: 'label' },
          },
          {
            when: (_a, s, g) =>
              Boolean((g as unknown as { hasActiveSubgraph?: boolean }).hasActiveSubgraph &&
                !(s as unknown as { isActive?: boolean }).isActive),
            then: { color: DIM, label: '' },
          },
          { whenState: 'isHighlighted', then: { depth: 'topNodes', labelVisibility: 'visible' } },
          { whenState: 'isActive', then: { depth: 'topNodes', labelVisibility: 'visible' } },
          { whenState: 'isHovered', then: { depth: 'topNodes', labelVisibility: 'visible' } },
        ],
        edges: [
          { color: { attribute: 'color' }, size: { attribute: 'size' } },
          {
            when: (_a, s, g) =>
              Boolean((g as unknown as { hasActiveSubgraph?: boolean }).hasActiveSubgraph &&
                !(s as unknown as { isActive?: boolean }).isActive),
            then: { color: DIM },
          },
          { whenState: 'isActive', then: { depth: 'topEdges' } },
        ],
      },
    })

    this.renderer.on('enterNode', ({ node }) => {
      const attrs = this.graph.getNodeAttributes(node)
      this.hoverLine.textContent = `${attrs.label} · ${attrs.count}`

      if (this.pinnedId === null) {
        this.renderer?.setNodeState(node, { isActive: true })
        for (const neighbor of this.graph.neighbors(node)) {
          this.renderer?.setNodeState(neighbor, { isActive: true })
          const edge = this.graph.edge(node, neighbor)
          if (edge) this.renderer?.setEdgeState(edge, { isActive: true })
        }
        this.renderer?.setGraphState({ hasActiveSubgraph: true })
        this.renderer?.refresh({ skipIndexation: true })
      }
    })

    this.renderer.on('leaveNode', () => {
      if (this.pinnedId === null) {
        this.hoverLine.textContent = 'слово · 0'
        for (const n of this.graph.nodes()) {
          this.renderer?.setNodeState(n, { isActive: false })
        }
        for (const e of this.graph.edges()) {
          this.renderer?.setEdgeState(e, { isActive: false })
        }
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

    this.renderer.on('clickNode', ({ node }) => {
      const id = Number(node)
      if (this.pinnedId === id) {
        this.pin(null)
      } else {
        this.pin(id)
      }
    })

    this.renderer.on('clickStage', () => {
      if (this.pinnedId !== null) {
        this.pin(null)
      }
    })
  }

  render(msg: MapMsg): void {
    this.lastMsg = msg
    this.graph.clear()
    const overrides = getLabelOverrides()

    for (const node of msg.nodes) {
      const color = this.authorColors.get(node.authorLead) || '#7890cd'
      const label = overrides[node.label] || node.label
      this.graph.addNode(String(node.id), {
        label,
        defaultLabel: node.label,
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
        this.graph.addEdge(a, b, {
          size: Math.max(0.5, w * 3),
          color: '#3a3a46',
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

  private getNodeDetails(id: number): NodeDetails | null {
    const key = String(id)
    if (!this.graph.hasNode(key)) return null

    const attrs = this.graph.getNodeAttributes(key)
    const label = attrs.label as string
    const defaultLabel = (attrs.defaultLabel as string) || label
    const count = (attrs.count as number) || 0

    const neighborsList: Array<{ id: number; label: string; weight: number }> = []
    for (const nb of this.graph.neighbors(key)) {
      const edge = this.graph.edge(key, nb)
      const weight = edge ? (this.graph.getEdgeAttribute(edge, 'weight') as number) : 0
      const nbAttrs = this.graph.getNodeAttributes(nb)
      neighborsList.push({
        id: Number(nb),
        label: nbAttrs.label as string,
        weight,
      })
    }
    neighborsList.sort((a, b) => b.weight - a.weight)
    const topNeighbors = neighborsList.slice(0, 3)

    const forms = this.lastMsg?.forms?.get(id) || []

    return {
      id,
      label,
      defaultLabel,
      count,
      neighbors: topNeighbors,
      forms,
    }
  }

  pin(id: number | null): void {
    this.pinnedId = id
    if (!this.renderer) return

    for (const nodeKey of this.graph.nodes()) {
      this.renderer.setNodeState(nodeKey, { isActive: false, isHighlighted: false })
    }
    for (const edgeKey of this.graph.edges()) {
      this.renderer.setEdgeState(edgeKey, { isActive: false })
    }

    if (id !== null && this.graph.hasNode(String(id))) {
      const key = String(id)
      this.renderer.setNodeState(key, { isActive: true, isHighlighted: true })
      for (const neighbor of this.graph.neighbors(key)) {
        this.renderer.setNodeState(neighbor, { isActive: true })
        const edge = this.graph.edge(key, neighbor)
        if (edge) this.renderer.setEdgeState(edge, { isActive: true })
      }
      this.renderer.setGraphState({ hasActiveSubgraph: true })
      const attrs = this.graph.getNodeAttributes(key)
      this.hoverLine.textContent = `${attrs.label} · ${attrs.count}`

      const details = this.getNodeDetails(id)
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
