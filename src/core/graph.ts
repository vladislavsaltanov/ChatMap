import Graph from 'graphology'
import forceAtlas2 from 'graphology-layout-forceatlas2'

export type LayoutNodeInput = {
  id: number
  size?: number
  prevXY?: { x: number; y: number }
}

export type LayoutEdgeInput = {
  a: number
  b: number
  weight: number
}

export type LayoutOpts = {
  seed: number
  fullRun: boolean
  iterations?: number
}

export type LayoutResult = {
  positions: Map<number, { x: number; y: number }>
  iterationsDone: number
}

function createRng(seed: number) {
  let s = seed >>> 0
  return function () {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

export function layout(
  nodes: LayoutNodeInput[],
  edges: LayoutEdgeInput[],
  opts: LayoutOpts
): LayoutResult {
  const graph = new Graph()
  const rng = createRng(opts.seed)

  for (const node of nodes) {
    let x: number
    let y: number
    if (!opts.fullRun && node.prevXY) {
      x = node.prevXY.x
      y = node.prevXY.y
    } else {
      x = (rng() - 0.5) * 100
      y = (rng() - 0.5) * 100
    }
    graph.addNode(String(node.id), { x, y, size: node.size || 20 })
  }

  const existingNodes = new Set(nodes.map((n) => String(n.id)))
  for (const edge of edges) {
    const a = String(edge.a)
    const b = String(edge.b)
    if (existingNodes.has(a) && existingNodes.has(b) && a !== b) {
      if (!graph.hasEdge(a, b)) {
        graph.addEdge(a, b, { weight: edge.weight })
      }
    }
  }

  const iterations = opts.iterations !== undefined
    ? opts.iterations
    : opts.fullRun ? 100 : 15

  if (iterations > 0 && graph.order > 1) {
    forceAtlas2.assign(graph, {
      iterations,
      settings: {
        adjustSizes: true,
        scalingRatio: 20,
        gravity: 0.8,
        strongGravityMode: false,
        slowDown: 1,
      },
    })
  }

  const positions = new Map<number, { x: number; y: number }>()
  for (const node of nodes) {
    const attrs = graph.getNodeAttributes(String(node.id))
    positions.set(node.id, { x: attrs.x, y: attrs.y })
  }

  return { positions, iterationsDone: iterations }
}
