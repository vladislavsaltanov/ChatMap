import type Graph from 'graphology'
import type Sigma from 'sigma'
import type { CustomEdgeState, CustomGraphState, CustomNodeState } from './mapStyles'

type MapRenderer = Sigma<any, any, any, CustomNodeState, CustomEdgeState, CustomGraphState>

// Трекинг активного эго-подграфа (hover/pin). Смена цели — диф-обменом:
// снимаются только ушедшие узлы/рёбра, иначе на кадр виден всплеск всех цветов.
// Ушедшие узлы не сбрасываются мгновенно: они получают флаг released, а буст
// размера плавно сдаёт через graph-state releaseAlpha (mapview запускает твин).
export class SubgraphHighlight {
  private nodes: string[] = []
  private edges: string[] = []
  private released: string[] = []
  // Бывший центр подсветки: только он носил +10% буст размера и потому
  // нуждается в плавном затухании; соседи размер не меняли — уходят мгновенно.
  private center: string | null = null

  constructor(private readonly graph: Graph) {}

  hasActive(): boolean {
    return this.nodes.length > 0
  }

  reset(): void {
    this.nodes = []
    this.edges = []
    this.released = []
    this.center = null
  }

  // Снять флаг released после затухания releaseAlpha (состояние уходит в базу)
  flushReleased(renderer: MapRenderer | null): void {
    for (const n of this.released) {
      if (this.graph.hasNode(n)) renderer?.setNodeState(n, { isActive: false, isHighlighted: false, released: false })
    }
    this.released = []
  }

  clear(renderer: MapRenderer | null): void {
    for (const n of this.nodes) {
      if (this.graph.hasNode(n)) renderer?.setNodeState(n, { isActive: false, isHighlighted: false })
    }
    for (const e of this.edges) {
      if (this.graph.hasEdge(e)) renderer?.setEdgeState(e, { isActive: false })
    }
    this.reset()
  }

  swap(renderer: MapRenderer | null, key: string, topN: number): void {
    if (!renderer) return
    const neighborsWithWeights: Array<{ neighbor: string; edge: string; weight: number }> = []
    for (const neighbor of this.graph.neighbors(key)) {
      // graph.edge(a, b) is direction-sensitive even for undirected graphs;
      // edges(a, b) finds the edge regardless of insertion order.
      const edge = this.graph.edges(key, neighbor)[0]
      if (edge) {
        const weight = (this.graph.getEdgeAttribute(edge, 'weight') as number) || 1
        neighborsWithWeights.push({ neighbor, edge, weight })
      }
    }
    neighborsWithWeights.sort((a, b) => b.weight - a.weight)
    const nextNodes = new Set<string>([key])
    const nextEdges = new Set<string>()
    for (const conn of neighborsWithWeights.slice(0, topN)) {
      nextNodes.add(conn.neighbor)
      nextEdges.add(conn.edge)
    }
    // Ушедшие из подсветки: бывший центр сдаёт буст размера плавно (released),
    // соседи уходят мгновенно — их размер не менялся, буст им не начисляется
    for (const n of this.nodes) {
      if (!nextNodes.has(n)) {
        if (n === this.center) {
          renderer.setNodeState(n, { isActive: false, isHighlighted: false, released: true, releasedAt: performance.now() })
          this.released.push(n)
        } else {
          renderer.setNodeState(n, { isActive: false, isHighlighted: false, released: false })
        }
      }
    }
    for (const e of this.edges) {
      if (!nextEdges.has(e)) renderer.setEdgeState(e, { isActive: false })
    }
    renderer.setNodeState(key, { isActive: true, isHighlighted: true, released: false })
    for (const conn of this.weightedTop(neighborsWithWeights, topN)) {
      renderer.setNodeState(conn.neighbor, { isActive: true, isHighlighted: false })
      renderer.setEdgeState(conn.edge, { isActive: true })
    }
    this.nodes = [...nextNodes]
    this.edges = [...nextEdges]
    this.center = key
    renderer.setGraphState({ hasActiveSubgraph: true })
  }

  private weightedTop(list: Array<{ neighbor: string; edge: string; weight: number }>, topN: number) {
    return [...list].sort((a, b) => b.weight - a.weight).slice(0, topN)
  }
}
