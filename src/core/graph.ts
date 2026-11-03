import Graph from 'graphology'
import forceAtlas2 from 'graphology-layout-forceatlas2'

// shortcut: spans >6800 get capped spacing and may overlap; upgrade if wide graphs look packed
const MAX_SCALE_FACTOR = 8

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
  onStage?: (done: number, stage: string) => void
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

// shortcut: 30 passes above 400 nodes may leave overlaps; upgrade if large graphs look packed
export function collisionIterationsForCount(nodeCount: number): number {
  return nodeCount <= 400 ? 80 : 30
}

export function resolveCollisions(
  nodes: Array<{ id: number; x: number; y: number; size?: number }>,
  padding: number = 8,
  maxIterations: number = 80,
  scaleFactor: number = 1
): void {
  const count = nodes.length
  if (count <= 1) return
  const scale = Math.min(scaleFactor, MAX_SCALE_FACTOR)

  for (let iter = 0; iter < maxIterations; iter++) {
    let hasCollision = false
    let maxShift = 0

    for (let i = 0; i < count; i++) {
      const a = nodes[i]
      const ra = (a.size || 20) * scale + padding * 0.5

      for (let j = i + 1; j < count; j++) {
        const b = nodes[j]
        const rb = (b.size || 20) * scale + padding * 0.5
        const minDist = ra + rb

        let dx = b.x - a.x
        let dy = b.y - a.y
        let distSq = dx * dx + dy * dy

        if (distSq < minDist * minDist) {
          hasCollision = true
          let dist = Math.sqrt(distSq)
          if (dist < 0.001) {
            dx = ((i * 17 + j * 31) % 10 - 5) || 1
            dy = ((i * 23 + j * 13) % 10 - 5) || 1
            dist = Math.sqrt(dx * dx + dy * dy)
          }

          const overlap = minDist - dist
          if (overlap > maxShift) {
            maxShift = overlap
          }

          const nx = dx / dist
          const ny = dy / dist
          const shift = overlap * 0.5

          a.x -= nx * shift
          a.y -= ny * shift
          b.x += nx * shift
          b.y += ny * shift
        }
      }
    }

    if (!hasCollision || maxShift < 0.2) {
      break
    }
  }
}

export function layout(
  nodes: LayoutNodeInput[],
  edges: LayoutEdgeInput[],
  opts: LayoutOpts
): LayoutResult {
  const graph = new Graph()
  const rng = createRng(opts.seed)
  const spread = Math.max(500, Math.sqrt(nodes.length) * 150)

  for (const node of nodes) {
    let x: number
    let y: number
    if (!opts.fullRun && node.prevXY) {
      x = node.prevXY.x
      y = node.prevXY.y
    } else {
      x = (rng() - 0.5) * spread
      y = (rng() - 0.5) * spread
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
    : opts.fullRun ? 300 : 20

  if (iterations > 0 && graph.order > 1) {
    forceAtlas2.assign(graph, {
      iterations,
      settings: {
        linLogMode: false,
        adjustSizes: true,
        outboundAttractionDistribution: false,
        barnesHutOptimize: true,
        barnesHutTheta: 0.5,
        scalingRatio: 2800,
        gravity: 0.0004,
        edgeWeightInfluence: 1.4,
        strongGravityMode: false,
        slowDown: 1,
      },
    })
  }

  const positionedNodes: Array<{ id: number; x: number; y: number; size?: number }> = []
  for (const node of nodes) {
    const attrs = graph.getNodeAttributes(String(node.id))
    positionedNodes.push({
      id: node.id,
      x: attrs.x,
      y: attrs.y,
      size: node.size,
    })
  }

  if (iterations > 0) {
    opts.onStage?.(92, 'Разведение пересечений...')
    let minX = Infinity
    let maxX = -Infinity
    let minY = Infinity
    let maxY = -Infinity
    for (const n of positionedNodes) {
      if (n.x < minX) minX = n.x
      if (n.x > maxX) maxX = n.x
      if (n.y < minY) minY = n.y
      if (n.y > maxY) maxY = n.y
    }
    const span = Math.max(maxX - minX, maxY - minY, 1000)
    const scaleFactor = Math.min(MAX_SCALE_FACTOR, Math.max(1, span / 850))
    resolveCollisions(positionedNodes, 10, collisionIterationsForCount(positionedNodes.length), scaleFactor)
  }

  const positions = new Map<number, { x: number; y: number }>()
  for (const p of positionedNodes) {
    positions.set(p.id, { x: p.x, y: p.y })
  }

  return { positions, iterationsDone: iterations }
}
