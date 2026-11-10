import Graph from 'graphology'
import forceAtlas2 from 'graphology-layout-forceatlas2'

// World units reserved per px of node radius during collision relaxation.
const MAX_SCALE_FACTOR = 10

// Map keeps insertion order, so delete+set moves a key to the most-recent end.
export function getLruCache<K, V>(map: Map<K, V>, key: K): V | undefined {
  if (!map.has(key)) return undefined
  const value = map.get(key) as V
  map.delete(key)
  map.set(key, value)
  return value
}

export function setLruCache<K, V>(map: Map<K, V>, key: K, value: V, maxEntries = 2000): void {
  map.delete(key)
  map.set(key, value)
  while (map.size > Math.max(maxEntries, 0)) map.delete(map.keys().next().value as K)
}

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

// Multi-octave angular noise for organic fringe contours and void pockets.
export function shapeNoise(angle: number, phases: number[]): number {
  const oct = [1, 2, 3, 5, 8]
  const wts = [0.45, 0.25, 0.15, 0.1, 0.05]
  let n = 0
  for (let i = 0; i < oct.length; i++) {
    n += wts[i] * Math.sin(oct[i] * angle + (phases[i] ?? 0))
  }
  return n
}

// Fractal fBm over angle + radius with a domain-warp pass: higher octaves break
// the contour into irregular segments instead of smooth waves. Bounded ~[-1, 1].
export function fractalNoise(angle: number, radius: number, phases: number[]): number {
  const oct = [1, 2, 4, 8, 16, 32]
  const wts = [0.46, 0.26, 0.14, 0.075, 0.04, 0.025]
  const warp =
    0.55 * Math.sin(3 * angle + (phases[0] ?? 0)) +
    0.25 * Math.sin(7 * angle + (phases[1] ?? 0))
  const a = angle + warp
  let n = 0
  for (let i = 0; i < oct.length; i++) {
    n += wts[i] * Math.sin(oct[i] * a + (phases[i] ?? 0) + radius * (0.6 + 0.35 * i))
  }
  return n
}

// Integer lattice hash. All randomness in the layout stays deterministic from
// the seed: cached positions must be byte-identical between runs.
function hash2(ix: number, iy: number, seed: number): number {
  let h = Math.imul(ix, 0x1f123bb5) ^ Math.imul(iy, 0x5f356495) ^ Math.imul(seed, 0x27d4eb2d)
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)
  h ^= h >>> 16
  return (h >>> 0) / 2147483648 - 1
}

function valueNoise(x: number, y: number, seed: number): number {
  const ix = Math.floor(x)
  const iy = Math.floor(y)
  const fx = x - ix
  const fy = y - iy
  const sx = fx * fx * (3 - 2 * fx)
  const sy = fy * fy * (3 - 2 * fy)
  const a = hash2(ix, iy, seed)
  const b = hash2(ix + 1, iy, seed)
  const c = hash2(ix, iy + 1, seed)
  const d = hash2(ix + 1, iy + 1, seed)
  return (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy
}

// Two-dimensional domain-warped fBm over the plane. Unlike `fractalNoise`
// (which shapes the angular contour only), this field has real local maxima and
// minima, so it can drive density instead of just the silhouette. ~[-1, 1].
export function fractalDensity(x: number, y: number, phases: number[] = [], seed = 0): number {
  const p = (i: number): number => phases.length ? phases[i % phases.length] ?? 0 : 0
  const warpX = 0.62 * valueNoise(x * 1.13 + p(0), y * 1.13 + p(1), seed + 17)
  const warpY = 0.62 * valueNoise(x * 1.13 + p(2), y * 1.13 + p(3), seed + 29)
  const wx = x + warpX
  const wy = y + warpY
  let sum = 0
  let amp = 0.5
  let freq = 1
  let norm = 0
  for (let i = 0; i < 6; i++) {
    sum += amp * valueNoise(wx * freq + p(i), wy * freq + p(i + 2), seed + i * 131)
    norm += amp
    freq *= 2.07
    amp *= 0.54
  }
  return sum / norm
}

// Coarse basins first, then medium and fine sub-clusters: the same field is
// sampled at three wavelengths, which is what makes the result fractal.
const CLUSTER_SCALES: Array<[number, number]> = [
  [1.75, 0.050],
  [4.10, 0.028],
  [9.30, 0.014],
]

// Pulls nodes up the fractal density gradient so voids empty out and words
// gather into irregular clumps. `onPass` is repulsion between passes: without
// it a basin collapses into one point, and a single final relaxation would
// just spread everything back into the uniform lattice.
export function fractalClusterPlane(
  points: Array<{ x: number; y: number }>,
  phases: number[],
  seed: number,
  strength: number,
  iterations = 48,
  onPass?: () => void
): void {
  const count = points.length
  if (count < 3 || strength <= 0 || iterations <= 0) return

  let cx = 0
  let cy = 0
  for (const p of points) {
    cx += p.x
    cy += p.y
  }
  cx /= count
  cy /= count

  let maxR = 0
  for (const p of points) maxR = Math.max(maxR, Math.hypot(p.x - cx, p.y - cy))
  if (maxR <= 0) return

  const h = 0.045
  for (let iter = 0; iter < iterations; iter++) {
    const t = iter / iterations
    const [freq, step] = t < 0.46 ? CLUSTER_SCALES[0] : t < 0.79 ? CLUSTER_SCALES[1] : CLUSTER_SCALES[2]
    const decay = 1 - 0.55 * t
    for (const p of points) {
      const fx = ((p.x - cx) / maxR) * freq
      const fy = ((p.y - cy) / maxR) * freq
      const d = fractalDensity(fx, fy, phases, seed)
      const gx = fractalDensity(fx + h, fy, phases, seed) - fractalDensity(fx - h, fy, phases, seed)
      const gy = fractalDensity(fx, fy + h, phases, seed) - fractalDensity(fx, fy - h, phases, seed)
      const gl = Math.hypot(gx, gy)
      if (gl < 1e-7) continue
      // Low-density nodes migrate fast; nodes already inside a basin settle.
      const urgency = Math.max(0, Math.min(1, 0.58 - 1.35 * d))
      const shift = step * strength * decay * urgency * maxR / gl
      p.x += gx * shift
      p.y += gy * shift
    }
    onPass?.()
  }
}

// Widescreen anisotropy: the monitor is horizontal, so stretch X and squeeze Y.
const PLANE_STRETCH_X = 1.55
const PLANE_STRETCH_Y = 0.88

// Deforms the plane into an uneven silhouette: angular pockets pull some sectors
// toward the centre and push others out, fractal noise and discrete faults break
// the contour, and a curl bends the outer arms. All randomness comes from `phases`.
export function warpPlane(
  points: Array<{ x: number; y: number }>,
  phases: number[]
): void {
  const count = points.length
  if (count < 3) return

  let cx = 0
  let cy = 0
  for (const p of points) {
    cx += p.x
    cy += p.y
  }
  cx /= count
  cy /= count

  let maxR = 0
  for (const p of points) maxR = Math.max(maxR, Math.hypot(p.x - cx, p.y - cy))
  if (maxR <= 0) return

  const pocket = phases.slice(0, 5)
  const wavePhase = phases[5] ?? 0
  const curlPhase = phases[6] ?? 0
  const curlPhase2 = phases[7] ?? 0
  const wavePhase2 = phases[8] ?? 0
  const lobes = 3 + Math.floor(Math.abs(Math.sin(phases[9] ?? 0)) * 3)
  const lobePhase = phases[3] ?? 0
  const fractal = phases.slice(10, 16)
  const faultSeed = Math.floor((phases[13] ?? 0) * 100000)
  const FAULTS = 11

  for (const p of points) {
    const dx = p.x - cx
    const dy = p.y - cy
    const r = Math.hypot(dx, dy)
    const u = Math.min(1, r / maxR)
    const a = Math.atan2(dy, dx)

    // A few deterministic arms stick far out, leaving voids between them;
    // sector pockets and waves add finer density contrast near the centre.
    const arm = Math.pow(Math.max(0, Math.cos(lobes * (a - lobePhase))), 1.4)
    const pocketOut = 0.5 + 0.5 * shapeNoise(a, pocket)
    const wave = 0.10 * Math.sin(3 * a + wavePhase) + 0.05 * Math.sin(5 * a + wavePhase2)

    // Fractal detail + sharp per-sector offsets: a "fractured" contour.
    const jag = fractalNoise(a, u, fractal)
    const sector = Math.floor(((a + Math.PI) / (2 * Math.PI)) * FAULTS)
    const faultHash = Math.imul(sector + 1, 2654435761) ^ faultSeed
    const fault = ((((faultHash >>> 8) % 100) / 100) - 0.5) * 0.16 * u

    const u2 = Math.min(1.35, Math.pow(u, 1.06) *
      (0.80 + 0.30 * pocketOut + 0.45 * arm * u + wave + 0.20 * jag + fault))

    // Spiral shear plus a second fractal sample for local tangential breaks.
    const jag2 = fractalNoise(a + 1.7, u, fractal.slice(2))
    const curl =
      0.38 * Math.pow(u, 1.25) +
      0.22 * Math.pow(u, 1.5) * Math.sin(2 * a + curlPhase) +
      0.16 * u * shapeNoise(2 * a + u, [curlPhase2, ...pocket]) +
      0.18 * u * jag2
    const a2 = a + curl
    const r2 = u2 * maxR

    p.x = cx + Math.cos(a2) * r2 * PLANE_STRETCH_X
    p.y = cy + Math.sin(a2) * r2 * PLANE_STRETCH_Y
  }
}

// Shortcut: 30 passes above 400 nodes may leave overlaps; upgrade if large graphs look packed
export function collisionIterationsForCount(nodeCount: number): number {
  return nodeCount <= 400 ? 80 : 30
}

export function resolveCollisions(
  nodes: Array<{ id: number; x: number; y: number; size?: number }>,
  padding: number = 8,
  maxIterations: number = 80,
  scaleFactor: number = 1,
  // padScale: density distribution. null = uniform padding (default, tests).
  padScale: ((size: number) => number) | null = null
): void {
  const count = nodes.length
  if (count <= 1) return
  const scale = Math.min(scaleFactor, MAX_SCALE_FACTOR)
  const padFor = (size: number | undefined): number => {
    const s = size || 20
    return padScale ? padScale(s) : padding
  }

  // Radii depend on sizes only, so they are stable across passes and iterations;
  // recomputing them per pair was pure overhead.
  const radii = new Float64Array(count)
  for (let i = 0; i < count; i++) {
    const n = nodes[i]
    radii[i] = (n.size || 20) * scale + padFor(n.size) * 0.5
  }
  // Production clearances (84-200 world units) make a uniform-grid broadphase
  // slower than this scan: its neighbourhood radius spans several cells, so it
  // costs ~24 us per node against ~11 ns per pair. Measured 7-17x slower in the
  // 271-600 node range that topN allows; a grid only pays off near ~4500 nodes.
  // Keep the O(N^2) scan unless maps get an order of magnitude bigger.
  // ponytail: quadratic in node count, fine up to ~1000 nodes (topN cap).
  for (let iter = 0; iter < maxIterations; iter++) {
    let hasCollision = false
    let maxShift = 0

    for (let i = 0; i < count; i++) {
      const a = nodes[i]
      const ra = radii[i]

      for (let j = i + 1; j < count; j++) {
        const b = nodes[j]
        const minDist = ra + radii[j]

        let dx = b.x - a.x
        let dy = b.y - a.y
        const distSq = dx * dx + dy * dy

        // Cheap reject first: the squared test avoids a sqrt on most pairs.
        if (distSq >= minDist * minDist) continue

        hasCollision = true
        let dist = Math.sqrt(distSq)
        // Identical centres: a deterministic nudge keeps the normals finite.
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
  const spread = Math.max(600, Math.sqrt(nodes.length) * 180)
  // Phases for harmonic noise before consuming rng on node positions
  const shapePhases = Array.from({ length: 16 }, () => rng() * Math.PI * 2)

  // Radial degree-aware start: hubs start in the core, rare nodes at fringe.
  const degree = new Map<string, number>()
  for (const edge of edges) {
    const a = String(edge.a)
    const b = String(edge.b)
    degree.set(a, (degree.get(a) ?? 0) + 1)
    degree.set(b, (degree.get(b) ?? 0) + 1)
  }
  let maxDegree = 0
  for (const d of degree.values()) if (d > maxDegree) maxDegree = d
  const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5))

  for (const [index, node] of nodes.entries()) {
    let x: number
    let y: number
    if (!opts.fullRun && node.prevXY) {
      x = node.prevXY.x
      y = node.prevXY.y
    } else {
      const deg = degree.get(String(node.id)) ?? 0
      const t = maxDegree > 0 ? deg / maxDegree : 0
      const angle = index * GOLDEN_ANGLE + (rng() - 0.5) * 0.6
      const radius =
        (spread / 2) *
        (1 - 0.85 * Math.pow(t, 0.7)) *
        (1 + 0.35 * shapeNoise(angle, shapePhases)) *
        (0.9 + 0.2 * rng())
      x = Math.cos(angle) * radius
      y = Math.sin(angle) * radius
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
    : opts.fullRun ? 1200 : 20

  if (iterations > 0 && graph.order > 1) {
    forceAtlas2.assign(graph, {
      iterations,
      settings: {
        // linLog separates communities into ganglia with bridges, but on tiny
        // graphs it breaks the "strong link closer" invariant — gate like warp.
        linLogMode: graph.order >= 12,
        adjustSizes: true,
        outboundAttractionDistribution: true,
        barnesHutOptimize: true,
        barnesHutTheta: 0.5,
        // High scaling ratio and light gravity produce an expansive, starry Obsidian-like dispersion
        scalingRatio: 16000,
        gravity: 0.0003,
        edgeWeightInfluence: 1.8,
        strongGravityMode: false,
        slowDown: 1,
      },
    })
  }

  // Harmonic contour shaping and lobe dissipation
  if (iterations > 0 && graph.order > 2) {
    const rank = [...graph.mapNodes((n) => n)]
      .map((n) => [n, graph.degree(n)] as const)
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .map(([n]) => n)
    const rankOf = new Map(rank.map((n, i) => [n, i]))
    let cx = 0
    let cy = 0
    graph.forEachNode((n) => {
      const a = graph.getNodeAttributes(n)
      cx += a.x
      cy += a.y
    })
    cx /= graph.order
    cy /= graph.order

    let maxR = 0
    graph.forEachNode((n) => {
      if (graph.degree(n) === 0) return
      const a = graph.getNodeAttributes(n)
      maxR = Math.max(maxR, Math.hypot(a.x - cx, a.y - cy))
    })
    maxR = Math.max(maxR, 1)

    // 1) Axis elongation
    const stretchAngle = rng() * Math.PI
    const k = 1.2
    const ux = Math.cos(stretchAngle)
    const uy = Math.sin(stretchAngle)
    graph.forEachNode((n) => {
      const a = graph.getNodeAttributes(n)
      let dx = a.x - cx
      let dy = a.y - cy
      const d0 = Math.hypot(dx, dy) || 1
      if (graph.degree(n) === 0) {
        dx = (dx / d0) * maxR * 1.02
        dy = (dy / d0) * maxR * 1.02
      }
      const a1 = dx * ux + dy * uy
      const a2 = -dx * uy + dy * ux
      const sx = a1 * k * ux + a2 * (1 / k) * -uy
      const sy = a1 * k * uy + a2 * (1 / k) * ux
      // 2) Angular noise protrusions
      const d1 = Math.hypot(sx, sy) || 1
      const t = (rankOf.get(n) ?? 0) / Math.max(1, graph.order - 1)
      const amp = (0.35 + 0.75 * t) * Math.min(1, graph.order / 20)
      const r2 = d1 * (1 + amp * shapeNoise(Math.atan2(sy, sx), shapePhases))
      graph.setNodeAttribute(n, 'x', cx + (sx / d1) * r2)
      graph.setNodeAttribute(n, 'y', cy + (sy / d1) * r2)
    })

    // 3) Hub lobe pushing for large graphs
    if (graph.order >= 40) {
      let ncx = 0
      let ncy = 0
      graph.forEachNode((n) => {
        const a = graph.getNodeAttributes(n)
        ncx += a.x
        ncy += a.y
      })
      ncx /= graph.order
      ncy /= graph.order
      let maxR2 = 0
      graph.forEachNode((n) => {
        if (graph.degree(n) === 0) return
        const a = graph.getNodeAttributes(n)
        maxR2 = Math.max(maxR2, Math.hypot(a.x - ncx, a.y - ncy))
      })
      const shifts = new Map<string, { dx: number; dy: number; m: number }>()
      const addShift = (key: string, ux: number, uy: number, push: number, w: number) => {
        const s = shifts.get(key) ?? { dx: 0, dy: 0, m: 0 }
        s.dx += ux * push * w
        s.dy += uy * push * w
        s.m = Math.max(s.m, push * w)
        shifts.set(key, s)
      }
      rank.slice(0, 12).forEach((n, i) => {
        const a = graph.getNodeAttributes(n)
        const dx = a.x - ncx
        const dy = a.y - ncy
        const d = Math.hypot(dx, dy) || 1
        const target = maxR2 * (0.62 - i * 0.012)
        if (d >= target) return
        const ux = dx / d
        const uy = dy / d
        const push = target - d
        addShift(n, ux, uy, push, 1)
        for (const nb of graph.neighbors(n)) addShift(nb, ux, uy, push, 0.6)
        for (const nb of graph.neighbors(n)) {
          for (const n2 of graph.neighbors(nb)) {
            if (n2 !== n) addShift(n2, ux, uy, push, 0.25)
          }
        }
      })
      for (const [n, s] of shifts) {
        const a = graph.getNodeAttributes(n)
        const len = Math.hypot(s.dx, s.dy) || 1
        const k = Math.min(1, s.m / len)
        graph.setNodeAttribute(n, 'x', a.x + s.dx * k)
        graph.setNodeAttribute(n, 'y', a.y + s.dy * k)
      }
    }
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
    // 1) First normalize & scale to target world frame so subsequent dispersion operates
    // directly on final coordinate scale, avoiding post-layout squashing.
    const xs = positionedNodes.map((p) => p.x).sort((a, b) => a - b)
    const ys = positionedNodes.map((p) => p.y).sort((a, b) => a - b)
    const qOr = (arr: number[], t: number) => arr[Math.max(0, Math.min(arr.length - 1, Math.floor(arr.length * t)))]
    const minX = qOr(xs, 0.05)
    const maxX = qOr(xs, 0.95)
    const minY = qOr(ys, 0.05)
    const maxY = qOr(ys, 0.95)
    const bw = Math.max(maxX - minX, 1)
    const bh = Math.max(maxY - minY, 1)
    // Scale target world span generously with node count
    const targetSpan = Math.max(6000, Math.min(10000, Math.sqrt(positionedNodes.length) * 320))
    const s = targetSpan / Math.max(bw, bh)
    const cx = (minX + maxX) / 2
    const cy = (minY + maxY) / 2
    for (const p of positionedNodes) {
      p.x = (p.x - cx) * s
      p.y = (p.y - cy) * s
    }

    // 2) Warp the normalised plane into a non-uniform, bent silhouette.
    // Skipped for tiny graphs (warping 2-3 nodes is meaningless and breaks
    // the "strongly connected nodes stay closer" invariant on small fixtures).
    // Cached positions from a full run are already warped; warping them again on
    // every filter update would compound the stretch and drift the silhouette.
    if (graph.order >= 8 && opts.fullRun) warpPlane(positionedNodes, shapePhases)

    // World units reserved per px of node radius, plus a perimeter clearance.
    // The clearance is deliberately WIDER than before: density contrast must
    // come from emptied regions, not from packing bodies cheek by jowl.
    // Pushing it much past ~84 is self-defeating — autoRescale fits the grown
    // extent back to the viewport, so screen gaps shrink again.
    const scaleFactor = MAX_SCALE_FACTOR
    const padScale = (size: number): number => {
      const sz = size || 20
      return Math.max(84, sz * 1.95 + 28)
    }

    // 3) Strong 2D fractal density. A single warp would be undone by collision
    // relaxation, so attraction and repulsion are interleaved: basins fill up
    // to the guaranteed clearance, voids stay empty, and the last relaxation
    // pass only fixes what is left. Cached/filter runs keep the full-run map.
    if (graph.order >= 12 && opts.fullRun) {
      const strength = Math.min(1, Math.max(0, (positionedNodes.length - 12) / 80))
      fractalClusterPlane(
        positionedNodes,
        shapePhases,
        (Math.imul(opts.seed, 7919) | 0),
        strength,
        48,
        () => resolveCollisions(positionedNodes, 10, 1, scaleFactor, padScale)
      )
    }

    // 4) Disperse overlaps directly in the final coordinate system.
    // Node sizes and hub clearings directly correspond to rendered world units.
    // Filter updates reuse cached full-run positions, so a light touch-up is
    // enough there; the full relaxation budget pays off only on fresh layouts.
    opts.onStage?.(92, 'Разведение пересечений...')
    // Large maps cost O(N^2) per pass: above 400 nodes reuse the helper's own
    // small budget (x2 for the final frame) instead of the 140/180 floor meant
    // for small maps. The 600-node test covers the large-map branch.
    let fullPasses = Math.max(collisionIterationsForCount(positionedNodes.length), positionedNodes.length > 300 ? 180 : 140)
    if (positionedNodes.length > 400) {
      fullPasses = collisionIterationsForCount(positionedNodes.length) * 2
    }
    const passes = opts.fullRun ? fullPasses : 25
    resolveCollisions(positionedNodes, 10, passes, scaleFactor, padScale)
  }

  const positions = new Map<number, { x: number; y: number }>()
  for (const p of positionedNodes) {
    positions.set(p.id, { x: p.x, y: p.y })
  }

  return { positions, iterationsDone: iterations }
}
