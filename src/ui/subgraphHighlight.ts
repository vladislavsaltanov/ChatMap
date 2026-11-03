import type Graph from 'graphology'
import type Sigma from 'sigma'
import type { CustomEdgeState, CustomGraphState, CustomNodeState } from './mapStyles'

type MapRenderer = Sigma<any, any, any, CustomNodeState, CustomEdgeState, CustomGraphState>

// Трекинг активного эго-подграфа (hover/pin). Смена цели — диф-обменом:
// снимаются только ушедшие узлы/рёбра, иначе на кадр виден всплеск всех цветов.
export class SubgraphHighlight {
  private nodes: string[] = []
  private edges: string[] = []

  constructor(private readonly graph: Graph) {}

  hasActive(): boolean {
    return this.nodes.length > 0
  }

  reset(): void {
    this.nodes = []
    this.edges = []
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
      const edge = this.graph.edge(key, neighbor)
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
    for (const n of this.nodes) {
      if (!nextNodes.has(n)) renderer.setNodeState(n, { isActive: false, isHighlighted: false })
    }
    for (const e of this.edges) {
      if (!nextEdges.has(e)) renderer.setEdgeState(e, { isActive: false })
    }
    renderer.setNodeState(key, { isActive: true, isHighlighted: true })
    for (const conn of this.weightedTop(neighborsWithWeights, topN)) {
      renderer.setNodeState(conn.neighbor, { isActive: true, isHighlighted: false })
      renderer.setEdgeState(conn.edge, { isActive: true })
    }
    this.nodes = [...nextNodes]
    this.edges = [...nextEdges]
    renderer.setGraphState({ hasActiveSubgraph: true })
  }

  private weightedTop(list: Array<{ neighbor: string; edge: string; weight: number }>, topN: number) {
    return [...list].sort((a, b) => b.weight - a.weight).slice(0, topN)
  }
}
