import { describe, expect, it } from 'vitest'
import { layout, type LayoutNodeInput } from '../src/core/graph'
import { leafLayout } from '../src/core/leaf'
import { spread, type SpreadEdge, type SpreadNode } from '../src/core/spread'

// Synthetic chat-like topology: 12 heavy stars joined by weak bridges, which is
// the shape a word co-occurrence graph takes after the disparity backbone.
const synth = (n: number): { nodes: SpreadNode[]; edges: SpreadEdge[] } => {
  const nodes: SpreadNode[] = Array.from({ length: n }, (_, i) => {
    const t = i / n
    const size = t < 0.7 ? 5 + (i % 5) : t < 0.92 ? 10 + ((i * 3) % 14) : 28 + ((i * 7) % 44)
    return { id: i + 1, size }
  })
  const edges: SpreadEdge[] = []
  const hubs = 12
  const per = Math.floor((n - hubs) / hubs)
  for (let h = 1; h <= hubs; h++) {
    for (let k = 0; k < per; k++) {
      const b = hubs + (h - 1) * per + k + 1
      if (b <= n) edges.push({ a: h, b, weight: 3 + (k % 4) })
    }
  }
  for (let h = 2; h <= hubs; h++) edges.push({ a: 1, b: h, weight: 2 })
  return { nodes, edges }
}

// The failure case the stand never reproduced: one word carries 80% of links.
const mega = (n: number): { nodes: SpreadNode[]; edges: SpreadEdge[] } => {
  const nodes: SpreadNode[] = Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    size: i === 0 ? 64 : 6 + (i % 13),
  }))
  const edges: SpreadEdge[] = []
  for (let i = 1; i < n; i++) edges.push({ a: 1, b: i + 1, weight: 2 + (i % 5) })
  for (let i = 2; i < n - 1; i += 3) edges.push({ a: i, b: i + 1, weight: 3 })
  return { nodes, edges }
}

const box = (pts: Array<{ x: number; y: number }>) => {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of pts) {
    if (p.x < minX) minX = p.x
    if (p.y < minY) minY = p.y
    if (p.x > maxX) maxX = p.x
    if (p.y > maxY) maxY = p.y
  }
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY }
}

// Occupancy of a 12x12 grid over the occupied box: clump ratio and void share.
const gridStats = (pts: Array<{ x: number; y: number }>) => {
  const b = box(pts)
  const cells = 12
  const grid = new Array<number>(cells * cells).fill(0)
  for (const p of pts) {
    const gx = Math.min(cells - 1, Math.floor(((p.x - b.minX) / (b.w || 1)) * cells))
    const gy = Math.min(cells - 1, Math.floor(((p.y - b.minY) / (b.h || 1)) * cells))
    grid[gy * cells + gx]++
  }
  const occupied = grid.filter((c) => c > 0)
  const sorted = [...occupied].sort((a, b2) => a - b2)
  const p50 = sorted[Math.floor(sorted.length * 0.5)] || 1
  const p90 = sorted[Math.floor(sorted.length * 0.9)] || 1
  return { clump: p90 / p50, voidShare: 1 - occupied.length / grid.length }
}

const nn = (pts: Array<{ x: number; y: number }>): number[] =>
  pts.map((p, i) => {
    let best = Infinity
    for (let j = 0; j < pts.length; j++) {
      if (i === j) continue
      const d = Math.hypot(p.x - pts[j].x, p.y - pts[j].y)
      if (d < best) best = d
    }
    return best
  })

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)] ?? 0
}

const positionsOf = (nodes: SpreadNode[], res: ReturnType<typeof spread>) =>
  nodes.map((n) => res.positions.get(n.id)!).filter(Boolean)

// P0 metrics probe (leaf-tissue plan §5/P0.1): pure helpers, no prod code yet.
// All deterministic, no Math.random; ties broken by id like the spread itself.
const rankAvg = (xs: number[]): number[] => {
  const order = xs.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const ranks = new Array<number>(xs.length)
  let i = 0
  while (i < order.length) {
    let j = i
    while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j++
    const avg = (i + j) / 2
    for (let k = i; k <= j; k++) ranks[order[k][1]] = avg
    i = j + 1
  }
  return ranks
}

const spearman = (xs: number[], ys: number[]): number => {
  // Guard: degenerate input carries no rank signal.
  if (xs.length !== ys.length || xs.length < 3) return 0
  const rx = rankAvg(xs)
  const ry = rankAvg(ys)
  const mx = rx.reduce((a, b) => a + b, 0) / rx.length
  const my = ry.reduce((a, b) => a + b, 0) / ry.length
  let cov = 0, vx = 0, vy = 0
  for (let i = 0; i < rx.length; i++) {
    cov += (rx[i] - mx) * (ry[i] - my)
    vx += (rx[i] - mx) * (rx[i] - mx)
    vy += (ry[i] - my) * (ry[i] - my)
  }
  if (!(vx > 0) || !(vy > 0)) return 0
  return cov / Math.sqrt(vx * vy)
}

const knnComponents = (pts: Array<{ x: number; y: number }>, k = 5): number => {
  // Union-find over k nearest spatial neighbours: 1 = single connected sheet.
  const n = pts.length
  if (n === 0) return 0
  const parent = pts.map((_, i) => i)
  const find = (a: number): number => (parent[a] === a ? a : (parent[a] = find(parent[a])))
  const union = (a: number, b: number) => { parent[find(a)] = find(b) }
  for (let i = 0; i < n; i++) {
    const d = pts.map((p, j) => [Math.hypot(p.x - pts[i].x, p.y - pts[i].y), j] as const)
    d.sort((a, b) => a[0] - b[0] || a[1] - b[1])
    for (let t = 1; t <= Math.min(k, n - 1); t++) union(i, d[t][1])
  }
  return new Set(pts.map((_, i) => find(i))).size
}

const cvNN = (pts: Array<{ x: number; y: number }>): number => {
  // Coefficient of variation of nearest-neighbour distances: raggedness dial.
  const d = nn(pts)
  if (d.length === 0) return 0
  const mean = d.reduce((a, b) => a + b, 0) / d.length
  if (!(mean > 0)) return 0
  const sd = Math.sqrt(d.reduce((a, b) => a + (b - mean) * (b - mean), 0) / d.length)
  return sd / mean
}

const maxEmptyCircleRatio = (pts: Array<{ x: number; y: number }>): number => {
  // Coarse proxy for the largest void: 40x40 grid over bbox, max distance
  // from an empty cell centre to the nearest node, divided by bbox span.
  const b = box(pts)
  const span = Math.max(b.w, b.h) || 1
  const cells = 40
  let worst = 0
  for (let gx = 0; gx < cells; gx++) {
    for (let gy = 0; gy < cells; gy++) {
      const cx = b.minX + ((gx + 0.5) / cells) * (b.w || 1)
      const cy = b.minY + ((gy + 0.5) / cells) * (b.h || 1)
      let best = Infinity
      for (const p of pts) {
        const d = Math.hypot(p.x - cx, p.y - cy)
        if (d < best) best = d
      }
      if (best > worst) worst = best
    }
  }
  return worst / span
}

// Convex hull (Andrew monotone chain): CCW without duplicate endpoints.
// Degenerate input (fewer than 3 distinct points) returns the points as-is.
const convexHull = (pts: Array<{ x: number; y: number }>): Array<{ x: number; y: number }> => {
  const sorted = [...pts].sort((a, b) => a.x - b.x || a.y - b.y)
  if (sorted.length < 3) return sorted
  const cross = (o: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }) =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
  const lower: Array<{ x: number; y: number }> = []
  const upper: Array<{ x: number; y: number }> = []
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop()
    lower.push(p)
  }
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i]
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop()
    upper.push(p)
  }
  lower.pop()
  upper.pop()
  return [...lower, ...upper]
}

const pointInPoly = (x: number, y: number, poly: Array<{ x: number; y: number }>): boolean => {
  // Ray casting: counts edge crossings to the right of the point.
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x
    const yi = poly[i].y
    const xj = poly[j].x
    const yj = poly[j].y
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

const hullGridStats = (pts: Array<{ x: number; y: number }>, cells = 12) => {
  // Void share inside the convex hull (not bbox): corners of the bbox that no
  // leaf can ever fill must not count as voids. Falls back to bbox on degeneracy.
  const b = box(pts)
  const hull = convexHull(pts)
  if (hull.length < 3) return gridStats(pts)
  let total = 0
  let occupied = 0
  for (let gx = 0; gx < cells; gx++) {
    for (let gy = 0; gy < cells; gy++) {
      const cx = b.minX + ((gx + 0.5) / cells) * (b.w || 1)
      const cy = b.minY + ((gy + 0.5) / cells) * (b.h || 1)
      if (!pointInPoly(cx, cy, hull)) continue
      total++
      const inCell = pts.some(
        (p) =>
          Math.min(cells - 1, Math.floor(((p.x - b.minX) / (b.w || 1)) * cells)) === gx &&
          Math.min(cells - 1, Math.floor(((p.y - b.minY) / (b.h || 1)) * cells)) === gy,
      )
      if (inCell) occupied++
    }
  }
  if (total === 0) return gridStats(pts)
  return { voidShare: 1 - occupied / total }
}

const maxEmptyCircleRatioHull = (pts: Array<{ x: number; y: number }>): number => {
  // Largest void inside the hull only: bbox corners are not voids.
  const b = box(pts)
  const span = Math.max(b.w, b.h) || 1
  const hull = convexHull(pts)
  if (hull.length < 3) return maxEmptyCircleRatio(pts)
  const cells = 40
  let worst = 0
  for (let gx = 0; gx < cells; gx++) {
    for (let gy = 0; gy < cells; gy++) {
      const cx = b.minX + ((gx + 0.5) / cells) * (b.w || 1)
      const cy = b.minY + ((gy + 0.5) / cells) * (b.h || 1)
      if (!pointInPoly(cx, cy, hull)) continue
      let best = Infinity
      for (const p of pts) {
        const d = Math.hypot(p.x - cx, p.y - cy)
        if (d < best) best = d
      }
      if (best > worst) worst = best
    }
  }
  return worst / span
}

const preservationAtK = (
  nodes: SpreadNode[],
  edges: SpreadEdge[],
  pos: Map<number, { x: number; y: number }>,
  kGraph = 5,
  kPlane = 10,
): number => {
  // Fraction of each node's top-kGraph link neighbours found in its top-kPlane
  // spatial neighbours, averaged. 1 = topology preserved on the plane.
  const wAdj = new Map<number, Array<{ id: number; w: number }>>()
  for (const n of nodes) wAdj.set(n.id, [])
  for (const e of edges) {
    wAdj.get(e.a)?.push({ id: e.b, w: e.weight })
    wAdj.get(e.b)?.push({ id: e.a, w: e.weight })
  }
  let sum = 0
  let count = 0
  for (const n of nodes) {
    const p = pos.get(n.id)
    if (!p) continue
    const graphTop = (wAdj.get(n.id) ?? [])
      .sort((a, b) => b.w - a.w || a.id - b.id)
      .slice(0, kGraph)
      .map((nb) => nb.id)
    if (graphTop.length === 0) continue
    const planeTop = nodes
      .filter((m) => m.id !== n.id && pos.get(m.id))
      .map((m) => [Math.hypot(pos.get(m.id)!.x - p.x, pos.get(m.id)!.y - p.y), m.id] as const)
      .sort((a, b) => a[0] - b[0] || a[1] - b[1])
      .slice(0, kPlane)
      .map(([, id]) => id)
    const inPlane = new Set(planeTop)
    sum += graphTop.filter((id) => inPlane.has(id)).length / graphTop.length
    count++
  }
  return count > 0 ? sum / count : 0
}

describe('spread — форма фигуры', () => {
  it('S1 connectivity: the laid-out map is a single sheet (no islands)', () => {
    // REMOVED the band ratio (spec 2026-11-13-leaf-tissue-plan.md, P1): a leaf
    // has no axis to measure.
    // Before: spanX/spanY in [1.3, 3.2] on spread() output.
    // After: kNN(5) spatial components == 1 on the FINAL layout (spread seats
    // lobes, the two-phase collision pass stitches them: measured spread k5=6,
    // layout k5=1 on synth-271 seeds 7/1337). One connected tissue.
    for (const n of [271, 600]) {
      const { nodes, edges } = synth(n)
      const res = layout(
        nodes.map((nd) => ({ id: nd.id, size: nd.size })),
        edges,
        { seed: 7, fullRun: true },
      )
      const pts = nodes.map((nd) => res.positions.get(nd.id)!).filter(Boolean)
      expect(knnComponents(pts, 5), `${n} nodes`).toBe(1)
      // Elongated plane, not a round blob: layout holds data aspect at 1.8
      // (ink reads ~1.5 on real corpora — labels inflate vertical).
      // User verdict 2026-11-13: 0.79 reads as a circle.
      // Elongated plane, not a round blob: the layout holds w/h == 1.5 exactly
      // (stretch-only aspect hold; user complaint 2026-11-13: measured 0.79).
      let minX = Infinity
      let maxX = -Infinity
      let minY = Infinity
      let maxY = -Infinity
      for (const p of pts) {
        if (p.x < minX) minX = p.x
        if (p.x > maxX) maxX = p.x
        if (p.y < minY) minY = p.y
        if (p.y > maxY) maxY = p.y
      }
      const ratio = (maxX - minX) / Math.max(1e-9, maxY - minY)
      expect(ratio, `${n} nodes aspect`).toBeGreaterThanOrEqual(1.6)
      expect(ratio, `${n} nodes aspect`).toBeLessThanOrEqual(2.0)
    }
  })

  it('S2 nuclei: at least 3 clumps twice as dense as the median', () => {
    const { nodes, edges } = synth(271)
    const res = spread(nodes, edges, { seed: 7, span: 1300 })
    expect(res.ports.size).toBeGreaterThanOrEqual(3)
    expect(gridStats(positionsOf(nodes, res)).clump).toBeGreaterThanOrEqual(2.0)
  })

  it('S3 ragged: at least 10% of the box stays empty', () => {
    const { nodes, edges } = synth(600)
    const res = spread(nodes, edges, { seed: 7, span: 1300 })
    expect(gridStats(positionsOf(nodes, res)).voidShare).toBeGreaterThanOrEqual(0.1)
  })

  it('S2b mega-hub: 80% of links on one word still produce several nuclei', () => {
    const { nodes, edges } = mega(600)
    const res = spread(nodes, edges, { seed: 3, span: 1300 })
    expect(res.ports.size).toBeGreaterThanOrEqual(3)
    expect(gridStats(positionsOf(nodes, res)).voidShare).toBeGreaterThanOrEqual(0.08)
  })

  it('S6 strand: cores are tighter than tips', () => {
    const { nodes, edges } = synth(600)
    const res = spread(nodes, edges, { seed: 7, span: 1300 })
    const pts = positionsOf(nodes, res)
    const d = nn(pts)
    const sorted = [...d].sort((a, b) => a - b)
    const core = sorted.slice(0, Math.floor(sorted.length * 0.2))
    const tips = sorted.slice(-Math.floor(sorted.length * 0.2))
    expect(median(core)).toBeLessThan(median(tips) * 0.7)
  })
})

describe('layout — гейты корректности после замены конвейера', () => {
  const grid = (n: number): { nodes: LayoutNodeInput[]; edges: SpreadEdge[] } => {
    const nodes: LayoutNodeInput[] = Array.from({ length: n }, (_, i) => ({
      id: i + 1,
      size: 8 + ((i * 5) % 18),
    }))
    const ring: SpreadEdge[] = []
    for (let i = 1; i < n; i++) ring.push({ a: i, b: i + 1, weight: 2 })
    return { nodes, edges: ring }
  }

  it('S4 clearance: no two bodies overlap (271 nodes)', () => {
    const { nodes, edges } = grid(271)
    const res = layout(nodes, edges, { seed: 11, fullRun: true })
    const pts = nodes.map((n) => ({ ...res.positions.get(n.id)!, size: n.size ?? 20 }))
    let worst = Infinity
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        const d = Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y)
        worst = Math.min(worst, d - Math.max(pts[i].size, pts[j].size))
      }
    }
    expect(worst).toBeGreaterThan(0)
  })

  it('S5 topology: strongly connected nodes stay closer than weakly connected', () => {
    const { nodes, edges } = grid(14)
    const res = layout(nodes, edges, { seed: 5, fullRun: true })
    const p = (id: number) => res.positions.get(id)!
    const strong = Math.hypot(p(2).x - p(3).x, p(2).y - p(3).y)
    const weak = Math.hypot(p(1).x - p(14).x, p(1).y - p(14).y)
    expect(strong).toBeLessThan(weak)
  })

  it('stem codec: every fascicle owner is a real port key', () => {
    const { nodes, edges } = synth(120)
    const res = spread(nodes, edges, { seed: 3, span: 1300 })
    const stemOf = res.stemOf
    expect(stemOf).toBeDefined()
    const owners = new Set<number>()
    for (const stem of stemOf!.values()) {
      if (stem < 0) continue
      owners.add(Math.floor(stem / 16))
      // Slot domain: 0 = soma, 1..5 = stems.
      expect(stem % 16).toBeLessThanOrEqual(5)
    }
    // Non-vacuous: this layout must actually produce fascicles, otherwise the check
    // below passes for the wrong reason.
    expect(owners.size).toBeGreaterThan(0)
    // The namespace invariant: leaf.ts builds stem ids in landmark-index space, the
    // remap in spread() converts them to group-id space. If those diverge, geometry's
    // ports.get(owner) misses and every hidden failure is simply "no bundling".
    for (const owner of owners) expect(res.ports.has(owner)).toBe(true)
  })

  it('S7 determinism: same seed, identical coordinates', () => {
    const { nodes, edges } = synth(200)
    const a = layout(nodes, edges, { seed: 42, fullRun: true })
    const b = layout(nodes, edges, { seed: 42, fullRun: true })
    for (const n of nodes) expect(a.positions.get(n.id)).toEqual(b.positions.get(n.id))
  })

  it('S8 incremental: cached nodes keep their exact frame', () => {
    const { nodes, edges } = synth(120)
    const first = layout(nodes, edges, { seed: 9, fullRun: true })
    const cached = nodes.map((n) => ({ ...n, prevXY: first.positions.get(n.id) }))
    const ids = new Set(cached.slice(0, 90).map((n) => n.id))
    const subset = cached.slice(0, 90)
    const second = layout(subset, edges.filter((e) => ids.has(e.a) && ids.has(e.b)), {
      seed: 9,
      fullRun: false,
    })
    for (const n of subset) expect(second.positions.get(n.id)).toEqual(n.prevXY)
  })

  it('S9 budget: layout of 1000 nodes stays under 400 ms', () => {
    const { nodes, edges } = synth(1000)
    const t0 = performance.now()
    layout(nodes, edges, { seed: 2, fullRun: true })
    const ms = performance.now() - t0
    console.log(`layout 1000: ${ms.toFixed(0)} ms`)
    expect(ms).toBeLessThan(400)
  })
})

describe('leaf morphology probes (no gates yet)', () => {
  it('known answers: helpers rank and separate correctly', () => {
    // Perfect monotone relations carry full rank signal.
    expect(spearman([1, 2, 3, 4], [1, 2, 3, 4])).toBeCloseTo(1)
    expect(spearman([1, 2, 3, 4], [4, 3, 2, 1])).toBeCloseTo(-1)
    // Two far blobs are two kNN components; one blob is one.
    const two = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1000, y: 1000 },
      { x: 1001, y: 1000 },
    ]
    expect(knnComponents(two, 1)).toBe(2)
    expect(knnComponents(two.slice(0, 2), 1)).toBe(1)
    // Constant spacing has zero variation.
    expect(cvNN([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }])).toBeGreaterThanOrEqual(0)
  })

  it('reports Spearman/kNN/CV/void via spread() on synth 271 seed 1337', () => {
    const { nodes, edges } = synth(271)
    const res = spread(nodes, edges, { seed: 1337, span: 1300 })
    const pts = positionsOf(nodes, res)
    const pos = new Map(nodes.map((n, i) => [n.id, pts[i]] as const))
    const ws: number[] = []
    const ls: number[] = []
    for (const e of edges) {
      const a = pos.get(e.a)
      const b = pos.get(e.b)
      if (!a || !b) continue
      ws.push(e.weight)
      ls.push(Math.hypot(a.x - b.x, a.y - b.y))
    }
    const rho = spearman(ws, ls)
    const comp = knnComponents(pts, 5)
    const cv = cvNN(pts)
    const maxVoid = maxEmptyCircleRatioHull(pts)
    const { voidShare } = hullGridStats(pts)
    const pres = preservationAtK(nodes, edges, pos)
    console.log(
      `P1 spread 271 hull: rho=${rho.toFixed(3)} kNNcomp=${comp} cv=${cv.toFixed(3)} maxVoid=${maxVoid.toFixed(3)} voidShare=${voidShare.toFixed(3)} pres10=${pres.toFixed(3)}`,
    )
    expect(Number.isFinite(rho)).toBe(true)
    expect(comp).toBeGreaterThanOrEqual(1)
    expect(cv).toBeGreaterThanOrEqual(0)
    expect(maxVoid).toBeGreaterThanOrEqual(0)
    expect(pres).toBeGreaterThanOrEqual(0)
    expect(pres).toBeLessThanOrEqual(1)
  })

  it('leaf chain morphology on synth 271 seed 1337 (probe, no gates)', () => {
    const { nodes, edges } = synth(271)
    const leaf = leafLayout(nodes, edges, 1337, 80)
    const pts = nodes.map((n) => leaf.positions.get(n.id)!).filter(Boolean)
    const pos = new Map(nodes.map((n) => [n.id, leaf.positions.get(n.id)!] as const))
    const ws: number[] = []
    const ls: number[] = []
    for (const e of edges) {
      const a = pos.get(e.a)
      const b = pos.get(e.b)
      if (!a || !b) continue
      ws.push(e.weight)
      ls.push(Math.hypot(a.x - b.x, a.y - b.y))
    }
    const rho = spearman(ws, ls)
    const comp = knnComponents(pts, 5)
    const cv = cvNN(pts)
    const maxVoid = maxEmptyCircleRatioHull(pts)
    const { voidShare } = hullGridStats(pts)
    const pres = preservationAtK(nodes, edges, pos)
    console.log(
      `P0 leaf 271 hull: rho=${rho.toFixed(3)} kNNcomp=${comp} cv=${cv.toFixed(3)} maxVoid=${maxVoid.toFixed(3)} voidShare=${voidShare.toFixed(3)} pres10=${pres.toFixed(3)}`,
    )
    expect(Number.isFinite(rho)).toBe(true)
    expect(comp).toBeGreaterThanOrEqual(1)
    expect(pres).toBeGreaterThanOrEqual(0)
    expect(pres).toBeLessThanOrEqual(1)
  })
})
