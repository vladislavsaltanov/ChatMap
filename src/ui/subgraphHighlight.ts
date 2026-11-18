import type Graph from 'graphology'
import type Sigma from 'sigma'
import type { CustomEdgeState, CustomGraphState, CustomNodeState } from './mapStyles'

type MapRenderer = Sigma<any, any, any, CustomNodeState, CustomEdgeState, CustomGraphState>

// Query: neighbours of `key` with their edge and weight, in-frame ones first.
// A missing predicate means "everything is on screen" (overview behaviour).
function rankedNeighbours(
  graph: Graph,
  key: string,
  isOnScreen?: (nodeKey: string) => boolean,
): Array<{ neighbor: string; edge: string; weight: number }> {
  const out: Array<{ neighbor: string; edge: string; weight: number; visible: number }> = []
  for (const neighbor of graph.neighbors(key)) {
    // graph.edge(a, b) is direction-sensitive even for undirected graphs;
    // edges(a, b) finds the edge regardless of insertion order.
    const edge = graph.edges(key, neighbor)[0]
    if (!edge) continue
    const weight = (graph.getEdgeAttribute(edge, 'weight') as number) || 1
    const visible = isOnScreen && !isOnScreen(neighbor) ? 0 : 1
    out.push({ neighbor, edge, weight, visible })
  }
  // On-screen first, then by weight: at a close-up the strongest links point off
  // the canvas and read as "no connections at all".
  out.sort((a, b) => b.visible - a.visible || b.weight - a.weight)
  return out
}

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

  // Query: the word whose ego-network is lit right now (null = idle). Callers
  // compare it with the new target to tell a retarget from a re-pin.
  centerKey(): string | null {
    return this.center
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
      if (this.graph.hasNode(n)) {
        renderer?.setNodeState(n, { isActive: false, isHighlighted: false, isEgo: false, released: false })
      }
    }
    this.released = []
  }

  clear(renderer: MapRenderer | null): void {
    for (const n of this.nodes) {
      if (this.graph.hasNode(n)) renderer?.setNodeState(n, { isActive: false, isHighlighted: false, isEgo: false })
    }
    for (const e of this.edges) {
      if (this.graph.hasEdge(e)) renderer?.setEdgeState(e, { isActive: false, egoTier: 0 })
    }
    this.reset()
  }

  // Command: move the ego-network to `key`. The whole fan of incident links is
  // lit, tiered by weight relative to the strongest link of this word: a word
  // with 40 connections keeps all 40 visible (weak ones dim, heaviest glowing).
  // `topN` now bounds only the neighbours whose LABELS are forced — typography
  // stays a budget even when the links are all on show.
  // `isOnScreen` ranks in-frame neighbours first for that label budget.
  swap(
    renderer: MapRenderer | null,
    key: string,
    topN: number,
    isOnScreen?: (nodeKey: string) => boolean,
  ): void {
    if (!renderer) return
    const ranked = rankedNeighbours(this.graph, key, isOnScreen)

    // Fan tiers come from the RANK by weight, not from weight/maxWeight: a word
    // whose links span 1..500 would put all 164 weak links into one indistinguishable
    // bucket, while the rank spreads the gradient over the whole fan (strongest
    // link = 1, weakest = ~0) — that is what "rare dim, frequent glowing" means.
    const byWeight = [...ranked].sort((a, b) => b.weight - a.weight)
    const fan = new Set<string>()
    byWeight.forEach((conn, index) => {
      fan.add(conn.edge)
      const tier = byWeight.length > 1 ? 1 - index / byWeight.length : 1
      renderer.setEdgeState(conn.edge, { isActive: true, egoTier: Math.round(tier * 100) / 100 })
    })
    const labelled = new Set(ranked.slice(0, topN).map((conn) => conn.neighbor))
    const nextNodes = new Set<string>([key, ...ranked.map((conn) => conn.neighbor)])
    // Ушедшие из подсветки: бывший центр сдаёт буст размера плавно (released),
    // соседи уходят мгновенно — их размер не менялся, буст им не начисляется
    for (const n of this.nodes) {
      if (!nextNodes.has(n)) {
        if (n === this.center) {
          renderer.setNodeState(n, { isActive: false, isHighlighted: false, isEgo: false, released: true, releasedAt: performance.now() })
          this.released.push(n)
        } else {
          renderer.setNodeState(n, { isActive: false, isHighlighted: false, isEgo: false, released: false })
        }
      }
    }
    for (const e of this.edges) {
      if (!fan.has(e)) renderer.setEdgeState(e, { isActive: false, egoTier: 0 })
    }
    renderer.setNodeState(key, { isActive: true, isHighlighted: true, isEgo: true, released: false })
    for (const conn of ranked) {
      renderer.setNodeState(conn.neighbor, {
        // Labels and the size boost stay reserved for the strongest few; every
        // other neighbour is `isEgo`: full brightness, no forced caption.
        isActive: labelled.has(conn.neighbor),
        isHighlighted: false,
        isEgo: true,
      })
    }
    this.nodes = [...nextNodes]
    this.edges = [...fan]
    this.center = key
    renderer.setGraphState({ hasActiveSubgraph: true })
  }
}
